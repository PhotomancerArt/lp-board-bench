/**
 * Switching a board's hub port: both twins, or VBUS stays up. Callers check
 * the lease first (`board power-*` does).
 */
import type { Desk } from "./desk/desk.ts";
import type { HubLocation } from "./desk/hubs.ts";
import { vidPid } from "./desk/presence.ts";
import { normalizeMac } from "./mac.ts";
import type { BoardView } from "./state.ts";

export type PowerAction = "off" | "on" | "cycle";

/**
 * How long the host gets to re-enumerate once the hub sees the board again.
 * `$BOARD_SETTLE_MS` overrides it (the CLI tests run with 0).
 */
const settleMs = () => Number(process.env.BOARD_SETTLE_MS ?? 2000);

export class PowerError extends Error {}

export interface PowerResult {
  /** The board's port after the action, when it is back on the bus. */
  port?: string;
  switched: string[];
}

export async function power(
  desk: Desk,
  view: BoardView,
  action: PowerAction,
  options: { offSeconds?: number; returnSeconds?: number; leaveSeconds?: number; settleMs?: number } = {},
): Promise<PowerResult> {
  const location = view.hub;
  if (!location) {
    throw new PowerError("not on a switchable hub (uhubctl has never seen it on one)");
  }
  const hubs = hubsOf(location);
  const switched = hubs.map((hub) => `${hub} port ${location.port}`);
  const on = () => {
    for (const hub of hubs) desk.setPower(hub, location.port, true);
  };
  if (action === "off" || action === "cycle") {
    for (const hub of hubs) desk.setPower(hub, location.port, false);
    // The hub is the witness, not the host: macOS keeps the device node (and
    // system_profiler keeps listing it) for as long as the port stays off,
    // and only notices on power-up. Measured on the desk, 2026-10-06.
    if (await stillConnected(desk, location, options.leaveSeconds ?? 5)) {
      if (action === "cycle") on();
      throw new PowerError(
        `the board stayed on the bus after ${switched.join(" and ")} went off: power did not drop ` +
          "(a hub twin not switched, or the board is powered another way)",
      );
    }
  }
  if (action === "off") return { switched };
  if (action === "cycle") await Bun.sleep((options.offSeconds ?? 2) * 1000);
  on();
  const port = await waitForReturn(desk, view, location, options.returnSeconds ?? 15, options.settleMs ?? settleMs());
  return { switched, ...(port ? { port } : {}) };
}

/** True when the hub still sees a device on the port after `seconds`. */
async function stillConnected(desk: Desk, location: HubLocation, seconds: number): Promise<boolean> {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    if (!hubPort(desk, location)?.connected) return false;
    if (Date.now() >= deadline) return true;
    await Bun.sleep(250);
  }
}

function hubPort(desk: Desk, location: HubLocation) {
  return desk
    .hubs()
    ?.find((hub) => hub.path === location.hub)
    ?.ports.find((port) => port.number === location.port);
}

function hubsOf(location: HubLocation): string[] {
  return location.twin ? [location.hub, location.twin] : [location.hub];
}

/**
 * Back means the hub sees the board on the port again AND the host has a
 * node for it — after the host has caught up: macOS drops the stale node
 * only once power returns, so a node read in the first moments may be the
 * old one.
 */
async function waitForReturn(
  desk: Desk,
  view: BoardView,
  location: HubLocation,
  seconds: number,
  settle: number,
): Promise<string | undefined> {
  const deadline = Date.now() + seconds * 1000;
  let seenOnHubAt: number | undefined;
  while (Date.now() < deadline) {
    const port = hubPort(desk, location);
    const onHub = port?.connected === true && (view.mac === undefined || port.mac === undefined || port.mac === view.mac);
    if (onHub) seenOnHubAt ??= Date.now();
    const device = findDevice(desk, view);
    if (onHub && device?.port && Date.now() - seenOnHubAt! >= settle) return device.port;
    await Bun.sleep(250);
  }
  return undefined;
}

/** The board on the bus: by MAC, or a bridge with no serial number by its kind. */
function findDevice(desk: Desk, view: BoardView) {
  const wantedVidPid = view.device ? vidPid(view.device) : view.board?.usb;
  return desk.usbDevices().find((candidate) =>
    view.mac && candidate.serial
      ? normalizeMac(candidate.serial) === view.mac
      : wantedVidPid !== undefined && vidPid(candidate) === wantedVidPid,
  );
}
