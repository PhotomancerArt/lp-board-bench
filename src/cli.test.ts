import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { tempHome } from "../test/fake_deps.ts";
import { DeskError, isNoHubsError } from "./desk/desk.ts";
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
    const first = desk.run("take", "fc6", "--as", "ota", "--for", "power-cut soak");
    expect(first).toMatchObject({ code: 0, stdout: "/dev/cu.usbmodem112401\n" });
    const second = desk.run("take", "fixture-c6", "--as", "wifi", "--for", "scan");
    expect(second.code).toBe(3);
    expect(second.stderr).toMatch(/FC6 fixture-c6 is held by ota until \d\d:\d\d \(30 min left\): power-cut soak/);
  });

  test("sessions whose names share a prefix are different holders (direct: ota vs direct: wifi)", () => {
    const desk = setup();
    expect(desk.run("take", "fc6", "--as", "direct: ota", "--for", "usb-speedup: timing").code).toBe(0);
    const wifi = desk.run("take", "fc6", "--for", "PR B silicon re-check", { BOARD_HOLDER: "direct: wifi" });
    expect(wifi.code).toBe(3);
    expect(wifi.stderr).toContain("held by direct: ota until");
    const lease = JSON.parse(desk.run("show", "fc6", "--json").stdout).lease;
    expect(lease).toMatchObject({ holder: "direct: ota", purpose: "usb-speedup: timing" });
  });

  test("taking without saying who you are is refused, whatever --for says", () => {
    const desk = setup();
    const result = desk.run("take", "fc6", "--for", "direct: wifi: scan");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('take needs to know who you are: --as "<your session name>"');
    expect(desk.run("check", "fc6").code).toBe(0);
  });

  test("check: 0 free or yours, 3 held, 4 art not held, 5 unknown; a chip mismatch is loud", () => {
    const desk = setup();
    expect(desk.run("check", "/dev/cu.usbmodem112401").code).toBe(0);
    desk.run("take", "FS3", "--as", "ota", "--for", "soak");
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
    const taken = desk.run("take", "chk", "--as", "yona", "--for", "update the piece");
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
      "--as",
      "soak",
      "--for",
      "power cuts",
      "--grace",
      "5",
      "--",
      "sh",
      "-c",
      `echo "holder=$BOARD_HOLDER dev=$BOARD_DEV"; ${board} take fc6 --as other --for x 2>/dev/null; echo "other=$?"; exit 7`,
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
    desk.run("take", "fc6", "--as", "ota", "--for", "soak");
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

  test("a switched-off board lists as off, though macOS keeps its stale node, and power-off says so", () => {
    const desk = setup();
    const off = desk.run("power-off", "fc6");
    expect(off.code).toBe(0);
    expect(off.stderr).toContain(
      "FC6 fixture-c6 has no power, but macOS keeps listing it (/dev/cu.usbmodem112401, system_profiler, Web Serial) " +
        "until power returns; board list shows it switched off",
    );
    expect(desk.run("list").stdout).toMatch(
      /FC6\s+fixture-c6\s.*\(switched off; stale \/dev\/cu\.usbmodem112401\)\s+1-1\.2 p4 \(\+twin\), off\s+free/,
    );
    expect(desk.run("show", "fc6").stdout).toContain("port        (switched off; stale /dev/cu.usbmodem112401)");
    const fc6 = () =>
      JSON.parse(desk.run("list", "--json").stdout).boards.find((board: { slug: string }) => board.slug === "fixture-c6");
    expect(fc6()).toMatchObject({ switchedOff: true, present: true, port: "/dev/cu.usbmodem112401" });
    expect(desk.run("power-on", "fc6").code).toBe(0);
    expect(fc6().switchedOff).toBe(false);
    expect(desk.run("list").stdout).toMatch(/FC6\s+fixture-c6\s.*\/dev\/cu\.usbmodem112401\s+1-1\.2 p4 \(\+twin\)\s+free/);
  });

  test("power is refused on a board someone holds, and impossible off a switchable hub", () => {
    const desk = setup();
    desk.run("take", "fs3", "--as", "ota", "--for", "soak");
    const held = desk.run("power-off", "fs3", "--as", "wifi");
    expect(held.code).toBe(3);
    desk.run("set", "chk", "role=test");
    const offHub = desk.run("power-off", "chk");
    expect(offHub.code).toBe(1);
    expect(offHub.stderr).toContain("not on a switchable hub");
  });

  test("power-cycle on a hub that keeps the power on exits non-zero, says why, and leaves the port powered", () => {
    const desk = setup();
    writeFileSync(join(desk.fixture, "ignores-power.txt"), "1-1.2\n1-2.2\n");
    const cycle = desk.run("power-cycle", "fc6", "--off-secs", "0");
    expect(cycle.code).toBe(1);
    expect(cycle.stdout).toBe("");
    expect(cycle.stderr).toContain(
      "FC6 fixture-c6: power-cycle failed on hub 1-1.2 port 4 and 1-2.2 port 4: power did not drop: " +
        "hub 1-1.2 port 4 and hub 1-2.2 port 4 still report power after uhubctl switched them off",
    );
    expect(cycle.stderr).toContain("power was switched back on");
    expect(desk.run("list").stdout).toMatch(/FC6\s+fixture-c6\s.*1-1\.2 p4 \(\+twin\)\s+free/);
  });

  test("power-cycle where uhubctl hangs after switching: the child is killed, the hub decides, and it succeeds with a warning", () => {
    const desk = setup();
    writeFileSync(join(desk.fixture, "hangs-power.txt"), "1-1.2 on\n");
    const cycle = desk.run("power-cycle", "fc6", "--off-secs", "0", { BOARD_UHUBCTL_TIMEOUT_MS: "300" });
    expect(cycle.code).toBe(0);
    expect(cycle.stdout).toBe("/dev/cu.usbmodem112401\n");
    expect(cycle.stderr).toContain(
      "⚠️ FC6 fixture-c6: uhubctl hung for 0.3 s switching hub 1-1.2 port 4 on and was killed; the hub shows the port on, so the switch took effect\n",
    );
    expect(cycle.stderr).toContain("FC6 fixture-c6: power cycle on 1-1.2 port 4 and 1-2.2 port 4");
    expect(stillRunning(desk.fixture)).toEqual([]);
  });

  test("power-on where uhubctl hangs and the port stays off exits non-zero and says uhubctl hung", () => {
    const desk = setup();
    expect(desk.run("power-off", "fc6").code).toBe(0);
    writeFileSync(join(desk.fixture, "hangs-power.txt"), "1-1.2 on unswitched\n1-2.2 on unswitched\n");
    const on = desk.run("power-on", "fc6", { BOARD_UHUBCTL_TIMEOUT_MS: "300" });
    expect(on.code).toBe(1);
    expect(on.stdout).toBe("");
    expect(on.stderr).toContain(
      "FC6 fixture-c6: power-on failed on hub 1-1.2 port 4 and 1-2.2 port 4: uhubctl hung for 0.3 s switching hub 1-1.2 port 4 on and was killed;",
    );
    expect(on.stderr).toContain("still read no power");
    expect(stillRunning(desk.fixture)).toEqual([]);
  });

  test("power-cycle on a board behind a ganged hub exits non-zero, names the hub's mode, and switches nothing", () => {
    const desk = setup();
    desk.run("set", "chk", "role=test");
    // Last seen through a hub the CH ganged hub on 1-1 port 3 now stands for.
    writeFileSync(join(desk.home, "hub-ports.json"), JSON.stringify({ "02:00:00:00:00:03": { hub: "1-1.3", port: 2 } }));
    const cycle = desk.run("power-cycle", "chk", "--off-secs", "0");
    expect(cycle.code).toBe(1);
    expect(cycle.stderr).toContain(
      "CHK art-choker: cannot switch power on hub 1-1.3 port 2: the hub (1a86:8095 USB Hub, USB 2.00, 4 ports, ganged) " +
        "does not support per-port power switching: uhubctl marks it ganged",
    );
    expect(existsSync(join(desk.fixture, "power.log"))).toBe(false);
  });

  test("uhubctl installed but no hub attached: every board still lists with its port, power is refused by name", () => {
    const desk = setup();
    // The first call has learned where fc6 lives; then the hubs go away.
    expect(desk.run("list").code).toBe(0);
    writeFileSync(join(desk.fixture, "uhubctl.txt"), "");
    const listed = desk.run("list");
    expect(listed.code).toBe(0);
    expect(listed.stdout).toMatch(/FC6\s+fixture-c6\s+fixture\s+esp32c6\s+02:00:00:00:00:01\s+\/dev\/cu\.usbmodem112401/);
    expect(listed.stdout).toMatch(/FS3\s+fixture-s3\s+fixture\s+esp32s3\s+02:00:00:00:00:02\s+\/dev\/cu\.usbmodem1123201/);
    expect(desk.run("take", "fc6", "--as", "ota", "--for", "no hub").stdout).toBe("/dev/cu.usbmodem112401\n");
    const state = JSON.parse(desk.run("list", "--json").stdout);
    expect(state.hubsAvailable).toBe(true);
    const cycle = desk.run("power-cycle", "fc6", "--as", "ota", "--off-secs", "0");
    expect(cycle.code).toBe(1);
    expect(cycle.stderr).toContain("not on a switchable hub");
    expect(existsSync(join(desk.fixture, "power.log"))).toBe(false);
  });
});

describe("uhubctl with no hub attached", () => {
  test("only exit 1 with its 'No compatible devices detected!' message reads as no hubs", () => {
    expect(isNoHubsError(new DeskError("uhubctl exited 1: No compatible devices detected!"))).toBe(true);
    expect(isNoHubsError(new DeskError("uhubctl exited 2: No compatible devices detected!"))).toBe(false);
    expect(isNoHubsError(new DeskError("uhubctl exited 1: permission denied"))).toBe(false);
    expect(isNoHubsError(new DeskError("uhubctl timed out after 15 s: No compatible devices detected!"))).toBe(false);
    expect(isNoHubsError(new Error("uhubctl exited 1: No compatible devices detected!"))).toBe(false);
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
        env: { PATH: process.env.PATH ?? "", HOME: home, BOARD_HOME: home, BOARD_FAKE_DESK: fixture, BOARD_SETTLE_MS: "0", BOARD_LEAVE_MS: "300", ...env },
      });
      return { code: result.exitCode ?? -1, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
    },
  };
}

/** The fixture's hung uhubctl stand-ins that are still running: there should be none. */
function stillRunning(fixture: string): number[] {
  const file = join(fixture, "hung.pids");
  const pids = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map(Number) : [];
  if (pids.length === 0) throw new Error("no uhubctl stand-in hung: the hang knob did not fire");
  return pids.filter((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });
}
