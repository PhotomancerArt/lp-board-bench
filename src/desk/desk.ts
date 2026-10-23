/**
 * The desk's hardware, behind one interface so everything above it runs on
 * fixtures in tests. The real desk is macOS: system_profiler, /dev, uhubctl,
 * espflash. `BOARD_FAKE_DESK=<dir>` swaps in a fixture directory (see
 * test/fixtures/desk/README.md) — the seam the CLI tests use.
 */
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { DeskError } from "./desk_error.ts";
import { parseBoardInfo, type BoardInfo } from "./espflash.ts";
import { parseUhubctl, type Hub } from "./hubs.ts";
import { parseSystemProfiler, type UsbDevice } from "./presence.ts";
import { timedRun, uhubctlTimeoutMs } from "./timed_run.ts";

export interface Desk {
  usbDevices(): UsbDevice[];
  /** Undefined when this machine has no uhubctl. Every uhubctl run is timed (see `timed_run.ts`). */
  hubs(): Promise<Hub[] | undefined>;
  /** Resets the board. */
  boardInfo(port: string): BoardInfo;
  setPower(hub: string, port: number, on: boolean): Promise<void>;
}

export { DeskError };

export function deskFromEnv(env: Record<string, string | undefined> = process.env): Desk {
  const fake = env.BOARD_FAKE_DESK;
  return fake ? fixtureDesk(fake) : macDesk();
}

export function macDesk(): Desk {
  return {
    usbDevices() {
      if (process.platform !== "darwin") return [];
      const json = run(["system_profiler", "SPUSBHostDataType", "-json"], 15_000);
      const nodes = readdirSync("/dev")
        .filter((name) => name.startsWith("cu."))
        .map((name) => `/dev/${name}`);
      return parseSystemProfiler(JSON.parse(json), nodes);
    },
    async hubs() {
      if (!Bun.which("uhubctl")) return undefined;
      try {
        return parseUhubctl(await timedRun(["uhubctl"], { timeoutMs: uhubctlTimeoutMs() }));
      } catch (err) {
        // uhubctl installed but no switchable hub attached: no hubs, not a failure.
        if (isNoHubsError(err)) return [];
        throw err;
      }
    },
    boardInfo(port) {
      if (!Bun.which("espflash")) throw new DeskError("espflash is not installed");
      return parseBoardInfo(run(["espflash", "board-info", "--port", port], 30_000, true));
    },
    async setPower(hub, port, on) {
      await timedRun(uhubctlSwitch(hub, port, on), { timeoutMs: uhubctlTimeoutMs() });
    },
  };
}

/**
 * A desk read from files. Power switches are appended to `power.log` in the
 * same directory, and a switched-off port reads as uhubctl prints one (off,
 * nothing attached), so a test can watch a power cycle happen. The host side
 * keeps listing the device the way macOS does: its node stays until power
 * returns (measured on the desk, 2026-10-06). A hub named in
 * `ignores-power.txt` (one path per line) takes the request and changes
 * nothing, as a hub that only claims per-port switching does: the request
 * is logged with `ignored` after it.
 *
 * `hangs-power.txt` makes a request hang as a deadlocked uhubctl does: one
 * `<hub> <on|off> [unswitched] [ignores-term]` per line. The switch takes
 * effect (or, with `unswitched`, does not, logged with `hung` after it),
 * then a stand-in child sleeps through the uhubctl deadline and is killed
 * by the same timed run the real desk uses (`ignores-term`: it ignores
 * SIGTERM, so SIGKILL is needed). Each stand-in appends its pid to
 * `hung.pids`, so a test can check it is gone.
 */
export function fixtureDesk(dir: string, options: { uhubctlTimeoutMs?: number; killGraceMs?: number } = {}): Desk {
  const timeoutMs = options.uhubctlTimeoutMs ?? uhubctlTimeoutMs();
  const read = (name: string) => readFileSync(join(dir, name), "utf8");
  const off = () => {
    const log = existsSync(join(dir, "power.log")) ? read("power.log") : "";
    const state = new Map<string, boolean>();
    for (const line of log.split("\n")) {
      const [hub, port, action, ignored] = line.split(" ");
      if (hub && port && action && !ignored) state.set(`${hub} ${port}`, action === "off");
    }
    return state;
  };
  return {
    usbDevices() {
      const nodes = read("dev.txt").split("\n").filter(Boolean);
      return parseSystemProfiler(JSON.parse(read("system_profiler.json")), nodes);
    },
    async hubs() {
      if (!existsSync(join(dir, "uhubctl.txt"))) return undefined;
      // A switched-off port reads as uhubctl prints one: off, nothing attached.
      const switchedOff = off();
      return parseUhubctl(read("uhubctl.txt")).map((hub) => ({
        ...hub,
        ports: hub.ports.map((port) =>
          switchedOff.get(`${hub.path} ${port.number}`) ? { number: port.number, powered: false, connected: false } : port,
        ),
      }));
    },
    boardInfo(port) {
      const name = readdirSync(dir).find(
        (file) => file.startsWith("espflash-board-info") && read(file).includes(`'${port}'`),
      );
      if (!name) throw new DeskError(`espflash could not connect to ${port}`);
      return parseBoardInfo(read(name));
    },
    async setPower(hub, port, on) {
      const action = on ? "on" : "off";
      const ignores = existsSync(join(dir, "ignores-power.txt")) && read("ignores-power.txt").split("\n").includes(hub);
      const hang = existsSync(join(dir, "hangs-power.txt"))
        ? read("hangs-power.txt")
            .split("\n")
            .map((line) => line.trim().split(/\s+/))
            .find(([path, which]) => path === hub && which === action)
        : undefined;
      const unswitched = hang?.includes("unswitched") === true;
      const note = ignores ? " ignored" : unswitched ? " hung" : "";
      appendFileSync(join(dir, "power.log"), `${hub} ${port} ${action}${note}\n`);
      if (!hang) return;
      const trap = hang.includes("ignores-term") ? "trap '' TERM; " : "";
      await timedRun(["sh", "-c", `echo $$ >> "$1"; ${trap}exec sleep 3600`, "sh", join(dir, "hung.pids")], {
        timeoutMs,
        ...(options.killGraceMs !== undefined ? { graceMs: options.killGraceMs } : {}),
        label: uhubctlSwitch(hub, port, on).join(" "),
      });
    },
  };
}

/**
 * The uhubctl run that switches one port of one hub, and only that: `-e`
 * (exact) stops uhubctl switching the port on what it takes for the hub's
 * USB 3 companion too. Its pairing goes by path, and on a tree where a
 * USB 2-only hub sits between twins it picks the wrong hub: without `-e`,
 * switching 1-2.3 port 2 also cut 1-1.3.1.3 port 2, another board (desk,
 * 2026-10-23). `board` switches both twins itself, as `findTwin` pairs them.
 */
export function uhubctlSwitch(hub: string, port: number, on: boolean): string[] {
  return ["uhubctl", "-l", hub, "-p", String(port), "-a", on ? "on" : "off", "-e"];
}

/**
 * `uhubctl` with no arguments exits 1 with "No compatible devices detected!"
 * when no switchable hub is attached. That is an empty hub list; any other
 * failure (a timeout, a different exit code or message) is still an error.
 */
export function isNoHubsError(err: unknown): boolean {
  return err instanceof DeskError && /^uhubctl exited 1: .*No compatible devices detected!/s.test(err.message);
}

/**
 * system_profiler and espflash, run synchronously. Bun 1.1.18 ignores the
 * `timeout` here (see `timed_run.ts`), so these runs are not actually
 * bounded yet; uhubctl, which has hung, goes through `timedRun` instead.
 */
function run(cmd: string[], timeoutMs: number, withStderr = false): string {
  const result = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
  const out = result.stdout.toString();
  if (!result.success) {
    const why = result.exitCode === null ? `timed out after ${timeoutMs / 1000} s` : `exited ${result.exitCode}`;
    throw new DeskError(`${cmd.join(" ")} ${why}: ${(result.stderr.toString() || out).trim().slice(-400)}`);
  }
  // espflash prints its banner and its log on different streams; it wants both.
  return withStderr ? `${out}\n${result.stderr.toString()}` : out;
}
