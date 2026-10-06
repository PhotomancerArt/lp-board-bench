#!/usr/bin/env bun
/**
 * `board` — the desk's boards, who holds them, and who is waiting.
 * Run `board help` for the commands.
 */
import { parseArgs } from "node:util";

import { checkBoard, chipWarnings, EXIT } from "./check.ts";
import { realDeps, type Deps } from "./deps.ts";
import { deskFromEnv, type Desk } from "./desk/desk.ts";
import { describeLease, drop, LeaseError, parseFor, renew, take, timeLeft } from "./lease.ts";
import { normalizeMac } from "./mac.ts";
import { boardHome } from "./paths.ts";
import { power, type PowerAction } from "./power.ts";
import { boardFromInput, editRegistry, handle, RegistryError, type Board } from "./registry.ts";
import { buildState, resolveRef, viewName, type BoardView, type DeskState } from "./state.ts";
import { stateJson, viewJson } from "./view_json.ts";
import { joinLine, leaveLine } from "./waiting.ts";

const HELP = `board — the desk's boards, who holds them, and who is waiting

  board list [--json]                       every board: mark, slug, role, port, hub, holder, line
  board show <board> [--json]               one board in full
  board take <board> --for "<who>: <why>"   lease it (30 min); prints its port
        [--minutes N] [--pid N] [--wait [--timeout MIN]]
  board renew <board> [--minutes N] [--as <who>]
  board drop <board> [--as <who>] [--force]
  board check <board|/dev/port> [--as <who>] [--chip <probed>]
                                            0 free or yours, 3 held, 4 art not held by you, 5 unknown
  board set <board> key=value…              edit the registry (tags=a,b; key= clears it)
  board add --slug <s> --mark <M> (--port <p> | --mac <MAC>) [--role r] [--board "…"]
        [--name "…"] [--lp-board <id>]      register a board (--port probes it with espflash)
  board verify <board> [--as <who>]         espflash vs the registry
  board power-cycle|power-off|power-on <board> [--as <who>] [--off-secs N]
  board serve [--port 4380]                 the desk page on 127.0.0.1

<board> is a slug (fixture-c6), a mark (FC6), a MAC, or a /dev path.
Who you are: --as <who>, else $BOARD_HOLDER. Files: $BOARD_HOME (~/.photomancer/desk).`;

class UsageError extends Error {}

/** A refusal with its exit code: printed as is, no stack. */
class Refusal extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
  }
}

export async function main(argv: string[], env = process.env, deps: Deps = realDeps): Promise<number> {
  const [command, ...rest] = argv;
  const home = boardHome(env);
  const desk = deskFromEnv(env);
  try {
    switch (command) {
      case undefined:
      case "help":
      case "--help":
      case "-h":
        console.log(HELP);
        return EXIT.ok;
      case "list":
        return list(home, desk, deps, rest);
      case "show":
        return show(home, desk, deps, rest);
      case "take":
        return await takeCommand(home, desk, deps, env, rest);
      case "renew":
        return renewCommand(home, desk, deps, env, rest);
      case "drop":
        return dropCommand(home, desk, deps, env, rest);
      case "check":
        return checkCommand(home, desk, deps, env, rest);
      case "set":
        return setCommand(home, desk, deps, rest);
      case "add":
        return addCommand(home, desk, deps, env, rest);
      case "verify":
        return verifyCommand(home, desk, deps, env, rest);
      case "power-cycle":
      case "power-off":
      case "power-on":
        return await powerCommand(home, desk, deps, env, command.slice("power-".length) as PowerAction, rest);
      case "serve": {
        const { serve } = await import("./serve.ts");
        return await serve(home, desk, deps, rest);
      }
      default:
        throw new UsageError(`unknown command "${command}"`);
    }
  } catch (err) {
    if (err instanceof Refusal) {
      console.error(err.message);
      return err.code;
    }
    if (err instanceof UsageError) {
      console.error(`${err.message}\n\n${HELP}`);
      return EXIT.error;
    }
    if (err instanceof LeaseError || err instanceof RegistryError || err instanceof Error) {
      console.error(`board: ${err.message}`);
      return EXIT.error;
    }
    throw err;
  }
}

function list(home: string, desk: Desk, deps: Deps, args: string[]): number {
  const { values } = parse(args, { json: { type: "boolean" } });
  const state = buildState(home, desk, deps);
  if (values.json) {
    console.log(JSON.stringify(stateJson(state), null, 2));
    return EXIT.ok;
  }
  const rows = state.views.map((view) => [
    view.board?.mark ?? "—",
    view.board?.slug ?? "(unregistered)",
    view.board?.role ?? "",
    view.board ? (view.board.chip ?? "") : view.device ? `${view.device.vid}:${view.device.pid}` : "",
    view.mac ?? "",
    view.device?.port ?? "(not plugged in)",
    hubText(view),
    holderText(view, deps),
  ]);
  printTable(["MARK", "SLUG", "ROLE", "CHIP", "MAC", "PORT", "HUB", "HOLDER"], rows);
  if (!state.hubsAvailable) console.error("(no uhubctl here: hub ports unknown, power commands off)");
  return EXIT.ok;
}

function show(home: string, desk: Desk, deps: Deps, args: string[]): number {
  const { values, positionals } = parse(args, { json: { type: "boolean" } });
  const view = mustResolve(buildState(home, desk, deps), positionals[0]);
  if (values.json) {
    console.log(JSON.stringify(viewJson(view), null, 2));
    return EXIT.ok;
  }
  const board = view.board;
  const lines: Array<[string, string | undefined]> = [
    ["board", viewName(view)],
    ["name", board?.name],
    ["role", board?.role],
    ["tags", board?.tags.join(", ") || undefined],
    ["chip", [board?.chip, board?.flash].filter(Boolean).join(", ") || undefined],
    ["hardware", board?.board],
    ["mac", view.mac],
    ["port", view.device?.port ?? "not plugged in"],
    ["hub", hubText(view) || undefined],
    ["holder", holderText(view, deps)],
    ["picture", view.image],
    ["lightplayer", [board?.lp_board, board?.lp_project].filter(Boolean).join(", ") || undefined],
    ["notes", board?.notes],
  ];
  for (const [key, value] of lines) if (value) console.log(`${key.padEnd(12)}${value}`);
  return EXIT.ok;
}

async function takeCommand(home: string, desk: Desk, deps: Deps, env: NodeJS.ProcessEnv, args: string[]): Promise<number> {
  const { values, positionals } = parse(args, {
    for: { type: "string" },
    minutes: { type: "string" },
    pid: { type: "string" },
    wait: { type: "boolean" },
    timeout: { type: "string" },
  });
  if (!values.for) throw new UsageError('take needs --for "<who>: <why>"');
  const { holder, purpose } = parseFor(values.for);
  const state = buildState(home, desk, deps);
  const ref = need(positionals[0], "take <board>");
  const view = resolveRef(state, ref);
  const mac = view?.mac ?? normalizeMac(ref);
  if (!mac) {
    throw new Refusal(
      view ? `${viewName(view)} has no MAC to lease it by; register it (board add)` : `no board matches "${ref}"`,
      EXIT.unknown,
    );
  }
  const name = view ? viewName(view) : mac;
  const request = {
    mac,
    holder,
    purpose,
    ...(values.minutes ? { minutes: number(values.minutes, "--minutes") } : {}),
    ...(values.pid ? { pid: number(values.pid, "--pid") } : {}),
  };

  let result = take(home, request, deps);
  if (!result.ok && values.wait) {
    result = await waitInLine(home, deps, request, name, values.timeout ? number(values.timeout, "--timeout") : undefined);
  }
  if (!result.ok) {
    if (result.reason === "held") {
      throw new Refusal(`${name} is ${describeLease(result.lease, deps)} — add --wait to join the line`, EXIT.held);
    }
    const ahead = result.line.map((waiter) => `${waiter.holder}${waiter.purpose ? ` (${waiter.purpose})` : ""}`);
    throw new Refusal(`${name} is free, but ${ahead.join(", ")} ${ahead.length === 1 ? "is" : "are"} waiting for it — add --wait to join the line`, EXIT.held);
  }
  const verb = result.renewed ? "renewed" : "taken";
  console.error(`${name}: ${verb} by ${holder} (${timeLeft(result.lease, deps)})`);
  if (view?.board?.role === "art") console.error(`⚠️ ${name} is an art piece. Treat what is on it with care.`);
  for (const warning of view ? chipWarnings(view, undefined) : []) console.error(warning);
  if (view?.device?.port) console.log(view.device.port);
  else console.error(`${name} is not plugged in right now`);
  return EXIT.ok;
}

async function waitInLine(
  home: string,
  deps: Deps,
  request: Parameters<typeof take>[1],
  name: string,
  timeoutMinutes: number | undefined,
): Promise<ReturnType<typeof take>> {
  const waiter = joinLine(home, { mac: request.mac, holder: request.holder, purpose: request.purpose, pid: process.pid }, deps);
  const leave = () => leaveLine(home, request.mac, waiter.id, deps);
  const onSignal = () => {
    leave();
    process.exit(130);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  console.error(`${name}: waiting in line as ${request.holder}…`);
  const deadline = timeoutMinutes === undefined ? Infinity : Date.now() + timeoutMinutes * 60_000;
  try {
    for (;;) {
      const result = take(home, { ...request, waiterId: waiter.id }, deps);
      if (result.ok || Date.now() > deadline) return result;
      await Bun.sleep(1000);
    }
  } finally {
    leave();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

function renewCommand(home: string, desk: Desk, deps: Deps, env: NodeJS.ProcessEnv, args: string[]): number {
  const { values, positionals } = parse(args, { minutes: { type: "string" }, as: { type: "string" } });
  const view = mustResolve(buildState(home, desk, deps), positionals[0]);
  const lease = renew(
    home,
    leaseKey(view),
    who(values.as, env),
    values.minutes ? number(values.minutes, "--minutes") : undefined,
    deps,
  );
  console.error(`${viewName(view)}: renewed (${timeLeft(lease, deps)})`);
  return EXIT.ok;
}

function dropCommand(home: string, desk: Desk, deps: Deps, env: NodeJS.ProcessEnv, args: string[]): number {
  const { values, positionals } = parse(args, { as: { type: "string" }, force: { type: "boolean" } });
  const view = mustResolve(buildState(home, desk, deps), positionals[0]);
  const dropped = drop(home, leaseKey(view), who(values.as, env), values.force === true, deps);
  console.error(dropped ? `${viewName(view)}: dropped ${dropped.holder}'s lease` : `${viewName(view)}: was not leased`);
  return EXIT.ok;
}

function checkCommand(home: string, desk: Desk, deps: Deps, env: NodeJS.ProcessEnv, args: string[]): number {
  const { values, positionals } = parse(args, { as: { type: "string" }, chip: { type: "string" } });
  const state = buildState(home, desk, deps);
  const verdict = checkBoard(state, need(positionals[0], "check <board>"), who(values.as, env), values.chip, deps);
  for (const warning of verdict.warnings) console.error(warning);
  console.error(verdict.message);
  return verdict.code;
}

function setCommand(home: string, desk: Desk, deps: Deps, args: string[]): number {
  const { positionals } = parse(args, {});
  const ref = need(positionals[0], "set <board> key=value…");
  const assignments = positionals.slice(1);
  if (assignments.length === 0) throw new UsageError("set needs at least one key=value");
  const updated = editRegistry(home, deps, (boards) => {
    const index = findBoardIndex(boards, ref);
    const raw: Record<string, unknown> = { ...boards[index], ...boards[index]!.extra };
    delete raw.extra;
    for (const assignment of assignments) {
      const eq = assignment.indexOf("=");
      if (eq <= 0) throw new UsageError(`"${assignment}" is not key=value`);
      const key = assignment.slice(0, eq).replace(/-/g, "_");
      const value = assignment.slice(eq + 1);
      if (key === "tags") raw.tags = value ? value.split(",").map((tag) => tag.trim()).filter(Boolean) : [];
      else if (value === "") delete raw[key];
      else raw[key] = value;
    }
    const { board, problems } = boardFromInput(raw);
    if (!board) throw new RegistryError(problems.join("\n"));
    boards[index] = board;
    return board;
  });
  console.error(`${handle(updated)}: updated`);
  return EXIT.ok;
}

function addCommand(home: string, desk: Desk, deps: Deps, env: NodeJS.ProcessEnv, args: string[]): number {
  const { values } = parse(args, {
    slug: { type: "string" },
    mark: { type: "string" },
    port: { type: "string" },
    mac: { type: "string" },
    role: { type: "string" },
    board: { type: "string" },
    name: { type: "string" },
    "lp-board": { type: "string" },
    usb: { type: "string" },
    as: { type: "string" },
  });
  const input: Record<string, unknown> = {
    slug: values.slug,
    mark: values.mark,
    mac: values.mac,
    role: values.role,
    board: values.board,
    name: values.name,
    lp_board: values["lp-board"],
    usb: values.usb,
  };
  if (!values.mac) {
    if (!values.port) throw new UsageError("add needs --port (to probe) or --mac");
    const verdict = checkBoard(buildState(home, desk, deps), values.port, who(values.as, env), undefined, deps);
    if (verdict.code !== EXIT.ok) throw new Refusal(verdict.message, verdict.code);
    console.error(`probing ${values.port} with espflash (this resets the board)…`);
    const info = desk.boardInfo(values.port);
    if (!info.mac) throw new Refusal(`espflash did not report a MAC for ${values.port}`, EXIT.error);
    Object.assign(input, { mac: info.mac, chip: info.chip, flash: info.flash });
    if (!values.usb && verdict.view?.device && !verdict.view.device.serial) {
      input.usb = `${verdict.view.device.vid}:${verdict.view.device.pid}`;
    }
  }
  const { board, problems } = boardFromInput(input);
  if (!board) throw new RegistryError(problems.join("\n"));
  editRegistry(home, deps, (boards) => {
    boards.push(board);
  });
  console.error(`${handle(board)}: registered (${board.mac}${board.chip ? `, ${board.chip}` : ""}${board.flash ? ` ${board.flash}` : ""})`);
  return EXIT.ok;
}

function verifyCommand(home: string, desk: Desk, deps: Deps, env: NodeJS.ProcessEnv, args: string[]): number {
  const { values, positionals } = parse(args, { as: { type: "string" } });
  const state = buildState(home, desk, deps);
  const ref = need(positionals[0], "verify <board>");
  const verdict = checkBoard(state, ref, who(values.as, env), undefined, deps);
  if (verdict.code !== EXIT.ok) throw new Refusal(verdict.message, verdict.code);
  const view = verdict.view!;
  const port = view.device?.port;
  if (!port) throw new Refusal(`${viewName(view)} is not plugged in`, EXIT.unknown);
  console.error(`probing ${port} with espflash (this resets the board)…`);
  const info = desk.boardInfo(port);
  const mismatches: string[] = [...chipWarnings(view, info.chip)];
  if (view.board?.flash && info.flash && view.board.flash !== info.flash) {
    mismatches.push(`⚠️ MISMATCH: ${viewName(view)} is registered with ${view.board.flash} flash, espflash says ${info.flash}`);
  }
  if (view.mac && info.mac && normalizeMac(info.mac) !== view.mac) {
    mismatches.push(`⚠️ MISMATCH: ${viewName(view)} is registered as ${view.mac}, the board on ${port} says ${info.mac}`);
  }
  for (const line of mismatches) console.error(line);
  console.error(`${viewName(view)}: espflash says ${info.chip ?? "?"}${info.revision ? ` rev ${info.revision}` : ""}, ${info.flash ?? "?"}, ${info.mac ?? "?"}`);
  return mismatches.length > 0 ? EXIT.error : EXIT.ok;
}

async function powerCommand(
  home: string,
  desk: Desk,
  deps: Deps,
  env: NodeJS.ProcessEnv,
  action: PowerAction,
  args: string[],
): Promise<number> {
  const { values, positionals } = parse(args, { as: { type: "string" }, "off-secs": { type: "string" } });
  const state = buildState(home, desk, deps);
  if (!state.hubsAvailable) throw new Refusal("uhubctl is not installed on this machine", EXIT.error);
  const verdict = checkBoard(state, need(positionals[0], `power-${action} <board>`), who(values.as, env), undefined, deps);
  if (verdict.code !== EXIT.ok) throw new Refusal(verdict.message, verdict.code);
  const view = verdict.view!;
  const result = await power(desk, view, action, {
    ...(values["off-secs"] ? { offSeconds: number(values["off-secs"], "--off-secs") } : {}),
  });
  console.error(`${viewName(view)}: power ${action} on ${result.switched.join(" and ")}`);
  if (action !== "off") {
    if (result.port) console.log(result.port);
    else console.error(`${viewName(view)} did not come back on the bus within 15 s`);
  }
  return action !== "off" && !result.port ? EXIT.error : EXIT.ok;
}

// ---- helpers ---------------------------------------------------------------

type Options = NonNullable<Parameters<typeof parseArgs>[0]>["options"];

function parse<T extends Options>(args: string[], options: T) {
  try {
    return parseArgs({ args, options: options as NonNullable<T>, allowPositionals: true, strict: true });
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
}

function need(value: string | undefined, usage: string): string {
  if (!value) throw new UsageError(`usage: board ${usage}`);
  return value;
}

function number(text: string, flag: string): number {
  const value = Number(text);
  if (!Number.isFinite(value)) throw new UsageError(`${flag} must be a number, got "${text}"`);
  return value;
}

function who(as: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  return as ?? (env.BOARD_HOLDER || undefined);
}

function mustResolve(state: DeskState, ref: string | undefined): BoardView {
  const text = need(ref, "<command> <board>");
  const view = resolveRef(state, text);
  if (!view) throw new Refusal(`no board matches "${text}" (board list shows them)`, EXIT.unknown);
  return view;
}

function leaseKey(view: BoardView): string {
  if (!view.mac) throw new Refusal(`${viewName(view)} has no MAC to lease it by`, EXIT.unknown);
  return view.mac;
}

function findBoardIndex(boards: Board[], ref: string): number {
  const lower = ref.toLowerCase();
  const mac = normalizeMac(ref);
  const index = boards.findIndex(
    (board) => board.slug === lower || board.mark.toLowerCase() === lower || (mac !== undefined && board.mac === mac),
  );
  if (index < 0) throw new Refusal(`no registered board matches "${ref}"`, EXIT.unknown);
  return index;
}

function hubText(view: BoardView): string {
  if (!view.hub) return "";
  const text = `${view.hub.hub} p${view.hub.port}${view.hub.twin ? " (+twin)" : ""}`;
  return view.hubRemembered ? `${text}, last seen` : text;
}

function holderText(view: BoardView, deps: Deps): string {
  const parts: string[] = [];
  if (view.lease) {
    const purpose = view.lease.purpose ? `: ${view.lease.purpose}` : "";
    parts.push(`${view.lease.holder} (${timeLeft(view.lease, deps)})${purpose}`);
  } else if (view.mac) {
    parts.push("free");
  }
  if (view.line.length > 0) parts.push(`${view.line.length} waiting: ${view.line.map((waiter) => waiter.holder).join(", ")}`);
  return parts.join(" · ");
}

function printTable(header: string[], rows: string[][]): void {
  const widths = header.map((title, column) => Math.max(title.length, ...rows.map((row) => row[column]!.length)));
  const line = (cells: string[]) =>
    cells
      .map((cell, column) => (column === cells.length - 1 ? cell : cell.padEnd(widths[column]!)))
      .join("  ")
      .trimEnd();
  console.log(line(header));
  for (const row of rows) console.log(line(row));
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
