import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { fakeDeps, tempHome } from "../test/fake_deps.ts";
import { fixtureDesk, type Desk } from "./desk/desk.ts";
import { take } from "./lease.ts";
import { imagesDir, registryPath } from "./paths.ts";
import { loadRegistry } from "./registry.ts";
import { deskHandler, PAGE_HOLDER } from "./serve.ts";

const FC6 = "02:00:00:00:00:01";

describe("the desk page's API", () => {
  test("serves the page, its script, and the state with the page's own identity", async () => {
    const page = setup();
    expect(await (await page.get("/")).text()).toContain("<title>Board bench</title>");
    const script = await page.get("/app.js");
    expect(script.headers.get("content-type")).toContain("javascript");
    expect(await script.text()).not.toContain("import type");
    const state = await (await page.get("/api/state")).json();
    expect(state.you).toBe(PAGE_HOLDER);
    expect(state.boards.find((board: { slug: string }) => board.slug === "fixture-c6").present).toBe(true);
  });

  test("a picture is served by MAC when one exists, and 404s otherwise", async () => {
    const page = setup();
    expect((await page.get(`/picture/${FC6}`)).status).toBe(404);
    mkdirSync(imagesDir(page.home), { recursive: true });
    writeFileSync(join(imagesDir(page.home), `${FC6}.board.svg`), "<svg/>");
    const picture = await page.get(`/picture/${FC6}`);
    expect(picture.headers.get("content-type")).toBe("image/svg+xml");
    expect(await picture.text()).toBe("<svg/>");
    expect((await page.get("/picture/..%2F..%2Fetc")).status).toBe(404);
  });

  test("saving edits a board in place, even when its MAC changes", async () => {
    const page = setup();
    const saved = await page.post("/api/boards", {
      was: FC6,
      slug: "fixture-c6",
      mark: "fc6",
      mac: "02:00:00:00:00:09",
      role: "art",
      tags: "panel, glued",
      notes: "",
    });
    expect(saved.status).toBe(200);
    const boards = loadRegistry(page.home);
    expect(boards).toHaveLength(2);
    expect(boards[0]).toMatchObject({ mac: "02:00:00:00:00:09", mark: "FC6", role: "art", tags: ["panel", "glued"] });
  });

  test("a bad edit is a 400 that says what is wrong, and changes nothing", async () => {
    const page = setup();
    const response = await page.post("/api/boards", { slug: "Bad Slug", mark: "FC6", mac: FC6 });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("slug must be kebab-case");
    expect(loadRegistry(page.home)[0]!.slug).toBe("fixture-c6");
  });

  test("take, take back, and power-cycle are lease-checked like the CLI", async () => {
    const page = setup();
    take(page.home, { mac: FC6, holder: "ota", purpose: "soak" }, page.deps);
    expect((await page.post(`/api/boards/${FC6}/take`)).status).toBe(409);
    const power = await page.post(`/api/boards/${FC6}/power-cycle`);
    expect(power.status).toBe(409);
    expect((await power.json()).error).toContain("held by ota");
    const back = await page.post(`/api/boards/${FC6}/drop`);
    expect((await back.json()).message).toContain("released ota's lease");
    expect((await page.post(`/api/boards/${FC6}/take`)).status).toBe(200);
  });

  test("a client that hangs up mid-read does not take the page down", async () => {
    // On the desk, Bun 1.1.18 segfaulted when a client hung up during a read
    // that blocked the event loop (spawnSync). In this one process a blocking
    // read fails sooner: the client's own timer cannot fire to hang up.
    const page = setup((desk) => ({
      ...desk,
      usbDevices: async () => {
        await Bun.sleep(200);
        return desk.usbDevices();
      },
    }));
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: page.handler });
    try {
      const url = `http://127.0.0.1:${server.port}/api/state`;
      await expect(fetch(url, { signal: AbortSignal.timeout(20) })).rejects.toThrow();
      await Bun.sleep(300);
      expect((await fetch(url)).status).toBe(200);
    } finally {
      server.stop(true);
    }
  });
});

function setup(slow: (desk: Desk) => Desk = (desk) => desk) {
  const home = tempHome();
  const fixture = tempHome();
  cpSync(join(import.meta.dir, "..", "test", "fixtures", "desk"), fixture, { recursive: true });
  writeFileSync(
    registryPath(home),
    [
      "[[board]]",
      'slug = "fixture-c6"',
      'mark = "FC6"',
      `mac = "${FC6}"`,
      'role = "fixture"',
      "[[board]]",
      'slug = "fixture-s3"',
      'mark = "FS3"',
      'mac = "02:00:00:00:00:02"',
    ].join("\n"),
  );
  const deps = fakeDeps();
  const handler = deskHandler(home, slow(fixtureDesk(fixture)), deps);
  const at = (path: string) => `http://127.0.0.1${path}`;
  return {
    home,
    deps,
    handler,
    get: (path: string) => handler(new Request(at(path))),
    post: (path: string, body?: unknown) =>
      handler(
        new Request(at(path), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: body === undefined ? null : JSON.stringify(body),
        }),
      ),
  };
}
