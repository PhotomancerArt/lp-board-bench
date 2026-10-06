/**
 * `board serve`: the desk page, on 127.0.0.1 only. The page reads the same
 * state `board list --json` prints, and its buttons call the same functions
 * the CLI does — there is no logic here the CLI lacks.
 *
 * The page and its script are embedded as text, so the compiled `board`
 * binary serves them with no files beside it.
 */
import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import { parseArgs } from "node:util";

import indexHtml from "../web/index.html" with { type: "text" };

import { checkBoard, EXIT } from "./check.ts";
import type { Deps } from "./deps.ts";
import type { Desk } from "./desk/desk.ts";
import { drop, take, timeLeft } from "./lease.ts";
import { normalizeMac } from "./mac.ts";
import { power } from "./power.ts";
import { boardFromInput, editRegistry, RegistryError } from "./registry.ts";
import { buildState, resolveRef, viewName } from "./state.ts";
import { stateJson } from "./view_json.ts";

export const DEFAULT_PORT = 4380;
/** Who the page acts as: Yona, at the desk. */
export const PAGE_HOLDER = "yona (page)";

const PICTURE_TYPES: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

export async function serve(home: string, desk: Desk, deps: Deps, args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { port: { type: "string" } }, strict: true });
  const port = values.port ? Number(values.port) : DEFAULT_PORT;
  const handler = deskHandler(home, desk, deps);
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({ hostname: "127.0.0.1", port, fetch: handler });
  } catch (err) {
    console.error(`board serve: port ${port} is taken (${(err as Error).message}); is the page already running?`);
    return EXIT.error;
  }
  console.log(`the desk page: http://127.0.0.1:${server.port}/`);
  await new Promise(() => {});
  return EXIT.ok;
}

/** The page's routes, as a plain fetch handler (tests call it directly). */
export function deskHandler(home: string, desk: Desk, deps: Deps): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (request.method === "GET" && path === "/") {
        return new Response(indexHtml, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
      }
      if (request.method === "GET" && path === "/app.js") {
        return new Response(await appScript(), {
          headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" },
        });
      }
      if (request.method === "GET" && path === "/api/state") {
        const state = buildState(home, desk, deps);
        return json({ ...stateJson(state), now: deps.now().toISOString(), you: PAGE_HOLDER });
      }
      const picture = /^\/picture\/([0-9A-Fa-f:]+)$/.exec(path);
      if (request.method === "GET" && picture) return pictureResponse(home, desk, deps, picture[1]!);
      if (request.method === "POST" && path === "/api/boards") return await upsert(home, deps, request);
      const action = /^\/api\/boards\/([0-9A-Fa-f:]+)\/(take|drop|power-cycle)$/.exec(path);
      if (request.method === "POST" && action) {
        return await boardAction(home, desk, deps, normalizeMac(action[1]!) ?? "", action[2]!);
      }
      return json({ error: "not found" }, 404);
    } catch (err) {
      const status = err instanceof RegistryError ? 400 : 500;
      return json({ error: (err as Error).message }, status);
    }
  };
}

let appJs: Promise<string> | undefined;

/**
 * The page's script, as JavaScript. It is typechecked as a module of its own,
 * so its text arrives through a dynamic import and a cast; the path is
 * static, so the compiled binary embeds it. Loaded on first request: a
 * top-level await here does not survive `bun build --compile`.
 */
function appScript(): Promise<string> {
  appJs ??= import("../web/app.ts", { with: { type: "text" } }).then((module) =>
    new Bun.Transpiler({ loader: "ts" }).transformSync((module as unknown as { default: string }).default),
  );
  return appJs;
}

function pictureResponse(home: string, desk: Desk, deps: Deps, macText: string): Response {
  const mac = normalizeMac(macText);
  const view = mac ? buildState(home, desk, deps).views.find((candidate) => candidate.mac === mac) : undefined;
  const file = view?.image;
  if (!file || !existsSync(file)) return json({ error: "no picture" }, 404);
  const type = PICTURE_TYPES[extname(file).toLowerCase()];
  if (!type) return json({ error: "not a picture type the page shows" }, 415);
  return new Response(readFileSync(file), { headers: { "content-type": type, "cache-control": "no-cache" } });
}

/**
 * Create or replace a board. The body is the board's fields; `was` names the
 * MAC of the entry being edited, when the edit changes the MAC itself.
 */
async function upsert(home: string, deps: Deps, request: Request): Promise<Response> {
  const body = (await request.json()) as Record<string, unknown>;
  const was = typeof body.was === "string" ? normalizeMac(body.was) : undefined;
  delete body.was;
  for (const [key, value] of Object.entries(body)) if (value === null || value === "") delete body[key];
  if (typeof body.tags === "string") {
    body.tags = body.tags
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean);
  }
  const { board, problems } = boardFromInput(body);
  if (!board) return json({ error: problems.join("\n") }, 400);
  editRegistry(home, deps, (boards) => {
    const index = boards.findIndex((existing) => existing.mac === (was ?? board.mac));
    if (index >= 0) boards[index] = { ...board, extra: { ...boards[index]!.extra, ...board.extra } };
    else boards.push(board);
  });
  return json({ ok: true, board: board.slug });
}

async function boardAction(home: string, desk: Desk, deps: Deps, mac: string, action: string): Promise<Response> {
  const state = buildState(home, desk, deps);
  const view = resolveRef(state, mac);
  if (!view?.mac) return json({ error: `no board ${mac}` }, 404);
  const name = viewName(view);
  if (action === "take") {
    const result = take(home, { mac: view.mac, holder: PAGE_HOLDER, purpose: "at the desk" }, deps);
    if (!result.ok) {
      const why = result.reason === "held" ? `held by ${result.lease.holder}` : "others are waiting for it";
      return json({ error: `${name} is ${why}` }, 409);
    }
    return json({ ok: true, message: `${name}: yours (${timeLeft(result.lease, deps)})` });
  }
  if (action === "drop") {
    const dropped = drop(home, view.mac, PAGE_HOLDER, true, deps);
    return json({ ok: true, message: dropped ? `${name}: released ${dropped.holder}'s lease` : `${name} was free` });
  }
  const verdict = checkBoard(state, view.mac, PAGE_HOLDER, undefined, deps);
  if (verdict.code !== EXIT.ok) return json({ error: verdict.message }, 409);
  const result = await power(desk, view, "cycle");
  return json({
    ok: true,
    message: result.port ? `${name}: power-cycled, back on ${result.port}` : `${name}: power-cycled, not back yet`,
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
