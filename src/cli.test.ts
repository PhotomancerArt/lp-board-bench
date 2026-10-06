import { describe, expect, test } from "bun:test";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { tempHome } from "../test/fake_deps.ts";
import { registryPath } from "./paths.ts";

// The fixture desk: 02:…:01 a C6 on hub 1-1.2 port 4, 02:…:02 an S3 on 1-1.2.3
// port 2, a CH340 (1a86:7522, no serial) on 1-1.2.3 port 3, 02:…:03 a C6 on a
// hub uhubctl cannot switch.
const REGISTRY = `
[[board]]
slug = "fixture-c6"
mark = "FC6"
mac = "02:00:00:00:00:01"
role = "fixture"
chip = "esp32c6"
flash = "4MB"

[[board]]
slug = "fixture-s3"
mark = "FS3"
mac = "02:00:00:00:00:02"
role = "fixture"
chip = "esp32s3"

[[board]]
slug = "fixture-v3"
mark = "FV3"
mac = "02:00:00:00:00:04"
role = "fixture"
usb = "1a86:7522"

[[board]]
slug = "art-choker"
mark = "CHK"
mac = "02:00:00:00:00:03"
role = "art"

[[board]]
slug = "c6-oak"
mark = "OAK"
mac = "02:00:00:00:00:05"
`;

describe("board (CLI over the fixture desk)", () => {
  test("list joins the registry with the bus: by MAC, and the bridge by its vid:pid", () => {
    const desk = setup();
    const out = desk.run("list").stdout;
    expect(out).toMatch(/FC6\s+fixture-c6\s+fixture\s+esp32c6\s+02:00:00:00:00:01\s+\/dev\/cu\.usbmodem112401\s+1-1\.2 p4 \(\+twin\)\s+free/);
    expect(out).toMatch(/FV3\s+fixture-v3\s+fixture\s+02:00:00:00:00:04\s+\/dev\/cu\.wchusbserial112330\s+1-1\.2\.3 p3/);
    expect(out).toMatch(/OAK\s+c6-oak\s+test\s+02:00:00:00:00:05\s+\(not plugged in\)/);
  });

  test("list --json carries what lp-cli and the page read", () => {
    const desk = setup();
    const state = JSON.parse(desk.run("list", "--json").stdout);
    expect(state.hubsAvailable).toBe(true);
    const fc6 = state.boards.find((board: { slug: string }) => board.slug === "fixture-c6");
    expect(fc6).toMatchObject({
      mark: "FC6",
      present: true,
      port: "/dev/cu.usbmodem112401",
      hub: { hub: "1-1.2", port: 4, twin: "1-2.2", remembered: false },
      lease: null,
      line: [],
    });
  });

  test("take prints the port; a second taker is refused with exit 3 naming the holder", () => {
    const desk = setup();
    const first = desk.run("take", "fc6", "--for", "ota: power-cut soak");
    expect(first).toMatchObject({ code: 0, stdout: "/dev/cu.usbmodem112401\n" });
    const second = desk.run("take", "fixture-c6", "--for", "wifi: scan");
    expect(second.code).toBe(3);
    expect(second.stderr).toMatch(/FC6 fixture-c6 is held by ota until \d\d:\d\d \(30 min left\): power-cut soak/);
  });

  test("check: 0 free or yours, 3 held, 4 art not held, 5 unknown; a chip mismatch is loud", () => {
    const desk = setup();
    expect(desk.run("check", "/dev/cu.usbmodem112401").code).toBe(0);
    desk.run("take", "FS3", "--for", "ota: soak");
    expect(desk.run("check", "fs3").code).toBe(3);
    expect(desk.run("check", "fs3", "--as", "ota").code).toBe(0);
    expect(desk.run("check", "fs3", { BOARD_HOLDER: "ota" }).code).toBe(0);
    expect(desk.run("check", "chk").code).toBe(4);
    expect(desk.run("check", "nope").code).toBe(5);
    const mismatch = desk.run("check", "/dev/cu.usbmodem1123201", "--as", "ota", "--chip", "esp32c6");
    expect(mismatch.code).toBe(0);
    expect(mismatch.stderr).toContain("⚠️ MISMATCH: FS3 fixture-s3 is registered as esp32s3, but the board answering says esp32c6");
  });

  test("an art board can be taken on purpose, and then checks clear for its holder", () => {
    const desk = setup();
    const taken = desk.run("take", "chk", "--for", "yona: update the piece");
    expect(taken.code).toBe(0);
    expect(taken.stderr).toContain("is an art piece");
    expect(desk.run("check", "chk", "--as", "yona").code).toBe(0);
  });

  test("run holds the board while the command runs, then keeps it for the grace", () => {
    const desk = setup();
    const board = `${process.execPath} ${join(import.meta.dir, "cli.ts")}`;
    const result = desk.run(
      "run",
      "fc6",
      "--for",
      "soak: power cuts",
      "--grace",
      "5",
      "--",
      "sh",
      "-c",
      `echo "holder=$BOARD_HOLDER dev=$BOARD_DEV"; ${board} take fc6 --for "other: x" 2>/dev/null; echo "other=$?"; exit 7`,
    );
    expect(result.code).toBe(7);
    expect(result.stdout).toContain("holder=soak dev=/dev/cu.usbmodem112401");
    expect(result.stdout).toContain("other=3");
    expect(result.stderr).toMatch(/the run ended \(exit 7\); still yours \(\d+ min left\)/);
    const lease = JSON.parse(readFileSync(join(desk.home, "leases", "02:00:00:00:00:01.json"), "utf8"));
    expect(lease.holder).toBe("soak");
    expect(lease.pid).toBeUndefined();
    expect(desk.run("check", "fc6", "--as", "other").code).toBe(3);
  });

  test("drop is the holder's; --force takes it back", () => {
    const desk = setup();
    desk.run("take", "fc6", "--for", "ota: soak");
    expect(desk.run("drop", "fc6", "--as", "wifi").code).toBe(1);
    expect(desk.run("drop", "fc6", "--as", "wifi", "--force").code).toBe(0);
    expect(desk.run("check", "fc6").code).toBe(0);
  });

  test("set edits the registry; add --port probes with espflash and registers", () => {
    const desk = setup();
    expect(desk.run("set", "oak", "role=dev", "tags=spare, loose", "notes=in the drawer").code).toBe(0);
    expect(readFileSync(registryPath(desk.home), "utf8")).toContain('role = "dev"\ntags = ["spare", "loose"]');
    expect(desk.run("set", "oak", "mark=TOOLONG").stderr).toContain("mark must be 2–4");

    writeFileSync(registryPath(desk.home), "");
    const added = desk.run("add", "--port", "/dev/cu.usbmodem112401", "--slug", "fixture-c6", "--mark", "FC6");
    expect(added.code).toBe(0);
    expect(added.stderr).toContain("FC6 fixture-c6: registered (02:00:00:00:00:01, esp32c6 4MB)");
  });

  test("power-cycle switches both twins off then on, and reports the port it came back on", () => {
    const desk = setup();
    const result = desk.run("power-cycle", "fc6", "--off-secs", "0");
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("/dev/cu.usbmodem112401\n");
    expect(readFileSync(join(desk.fixture, "power.log"), "utf8")).toBe(
      "1-1.2 4 off\n1-2.2 4 off\n1-1.2 4 on\n1-2.2 4 on\n",
    );
  });

  test("power is refused on a board someone holds, and impossible off a switchable hub", () => {
    const desk = setup();
    desk.run("take", "fs3", "--for", "ota: soak");
    const held = desk.run("power-off", "fs3", "--as", "wifi");
    expect(held.code).toBe(3);
    desk.run("set", "chk", "role=test");
    const offHub = desk.run("power-off", "chk");
    expect(offHub.code).toBe(1);
    expect(offHub.stderr).toContain("not on a switchable hub");
  });
});

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function setup() {
  const home = tempHome();
  const fixture = tempHome();
  cpSync(join(import.meta.dir, "..", "test", "fixtures", "desk"), fixture, { recursive: true });
  writeFileSync(registryPath(home), REGISTRY);
  const cli = join(import.meta.dir, "cli.ts");
  return {
    home,
    fixture,
    run(...args: Array<string | Record<string, string>>): Run {
      const env = args.find((arg): arg is Record<string, string> => typeof arg === "object") ?? {};
      const argv = args.filter((arg): arg is string => typeof arg === "string");
      const result = Bun.spawnSync([process.execPath, cli, ...argv], {
        env: { PATH: process.env.PATH ?? "", HOME: home, BOARD_HOME: home, BOARD_FAKE_DESK: fixture, BOARD_SETTLE_MS: "0", ...env },
      });
      return { code: result.exitCode ?? -1, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
    },
  };
}
