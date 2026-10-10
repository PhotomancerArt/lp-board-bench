/**
 * The desk's hardware, behind one interface so everything above it runs on
 * fixtures in tests. The real desk is macOS: system_profiler, /dev, uhubctl,
 * espflash. `BOARD_FAKE_DESK=<dir>` swaps in a fixture directory (see
 * test/fixtures/desk/README.md) — the seam the CLI tests use.
 */
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parseBoardInfo, type BoardInfo } from "./espflash.ts";
import { parseUhubctl, type Hub } from "./hubs.ts";
import { parseSystemProfiler, type UsbDevice } from "./presence.ts";

export interface Desk {
  usbDevices(): UsbDevice[];
  /** Undefined when this machine has no uhubctl. */
  hubs(): Hub[] | undefined;
  /** Resets the board. */
  boardInfo(port: string): BoardInfo;
  setPower(hub: string, port: number, on: boolean): void;
}

export class DeskError extends Error {}

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
    hubs() {
      if (!Bun.which("uhubctl")) return undefined;
      try {
        return parseUhubctl(run(["uhubctl"], 15_000));
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
    setPower(hub, port, on) {
      run(["uhubctl", "-l", hub, "-p", String(port), "-a", on ? "on" : "off", "-e"], 15_000);
    },
  };
}

/**
 * A desk read from files. Power switches are appended to `power.log` in the
 * same directory, and a switched-off port drops its device from the listing,
 * so a test can watch a power cycle happen.
 */
export function fixtureDesk(dir: string): Desk {
  const read = (name: string) => readFileSync(join(dir, name), "utf8");
  const off = () => {
    const log = existsSync(join(dir, "power.log")) ? read("power.log") : "";
    const state = new Map<string, boolean>();
    for (const line of log.split("\n")) {
      const [hub, port, action] = line.split(" ");
      if (hub && port && action) state.set(`${hub} ${port}`, action === "off");
    }
    return state;
  };
  return {
    usbDevices() {
      const hubs = parseUhubctl(read("uhubctl.txt"));
      const switchedOff = off();
      const offPorts = hubs.flatMap((hub) => hub.ports.filter((port) => switchedOff.get(`${hub.path} ${port.number}`)));
      const offMacs = new Set(offPorts.flatMap((port) => (port.mac ? [port.mac] : [])));
      const offKinds = new Set(offPorts.flatMap((port) => (!port.mac && port.vidPid ? [port.vidPid] : [])));
      const nodes = read("dev.txt").split("\n").filter(Boolean);
      return parseSystemProfiler(JSON.parse(read("system_profiler.json")), nodes).filter((device) =>
        device.serial ? !offMacs.has(device.serial) : !offKinds.has(`${device.vid}:${device.pid}`),
      );
    },
    hubs() {
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
    setPower(hub, port, on) {
      appendFileSync(join(dir, "power.log"), `${hub} ${port} ${on ? "on" : "off"}\n`);
    },
  };
}

/**
 * `uhubctl` with no arguments exits 1 with "No compatible devices detected!"
 * when no switchable hub is attached. That is an empty hub list; any other
 * failure (a timeout, a different exit code or message) is still an error.
 */
export function isNoHubsError(err: unknown): boolean {
  return err instanceof DeskError && /^uhubctl exited 1: .*No compatible devices detected!/s.test(err.message);
}

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
