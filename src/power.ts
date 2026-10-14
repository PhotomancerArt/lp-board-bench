/**
 * Switching a board's hub port: both twins, or VBUS stays up. Callers check
 * the lease first (`board power-*` does).
 *
 * Every switch is confirmed by the hub, or the command fails: a hub that
 * cannot switch per-port power (uhubctl marks it `ganged` or `nops`), a twin
 * that is not there to switch, a port that still reads power after the
 * request, or a board that stays on the bus are all errors that name the
 * board, the hub and why. A failed `off` or `cycle` switches back on what it
 * switched off, so a failure leaves the port as it found it.
 */
import type { Desk } from "./desk/desk.ts";
import { parentOf, powerSwitching, twinOf, type Hub, type HubLocation, type HubPort } from "./desk/hubs.ts";
import { vidPid } from "./desk/presence.ts";
import { normalizeMac } from "./mac.ts";
import { viewName, type BoardView } from "./state.ts";

export type PowerAction = "off" | "on" | "cycle";

/**
 * How long the host gets to re-enumerate once the hub sees the board again.
 * `$BOARD_SETTLE_MS` overrides it (the CLI tests run with 0).
 */
const settleMs = () => Number(process.env.BOARD_SETTLE_MS ?? 2000);

/**
 * How long the hub gets to report a switched port, and the board to leave it.
 * `$BOARD_LEAVE_MS` overrides it (the CLI tests run short).
 */
const leaveSeconds = () => Number(process.env.BOARD_LEAVE_MS ?? 5000) / 1000;

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
  const name = viewName(view);
  const location = view.hub;
  if (!location) {
    throw new PowerError(`${name} is not on a switchable hub (uhubctl has never seen it on one)`);
  }
  const live = await desk.hubs();
  // A remembered location is no use when uhubctl sees no hub at all.
  if (!live || live.length === 0) {
    throw new PowerError(`${name} is not on a switchable hub (no switchable hub is attached to this machine)`);
  }
  const hubs = hubsToSwitch(live, location, name);
  checkBoardOnPort(live, location, view, name);

  const switched = hubs.map((hub) => `${hub} port ${location.port}`);
  const failed = (why: string) => new PowerError(`${name}: power-${action} failed on hub ${switched.join(" and ")}: ${why}`);
  const leave = options.leaveSeconds ?? leaveSeconds();

  const switchAll = async (on: boolean) => {
    for (const hub of hubs) {
      try {
        await desk.setPower(hub, location.port, on);
      } catch (err) {
        throw new Error(`uhubctl could not switch hub ${hub} port ${location.port} ${on ? "on" : "off"} (${message(err)})`);
      }
    }
  };
  /** Back on, after a failed off; says how that went, for the error. */
  const restore = async (): Promise<string> => {
    try {
      await switchAll(true);
      return "power was switched back on";
    } catch (err) {
      return `and switching power back on failed too: ${message(err)}`;
    }
  };

  if (action === "off" || action === "cycle") {
    try {
      await switchAll(false);
    } catch (err) {
      throw failed(`${message(err)}; ${await restore()}`);
    }
    // The hub is the witness, not the host: macOS keeps the device node (and
    // system_profiler keeps listing it) for as long as the port stays off,
    // and only notices on power-up. Measured on the desk, 2026-10-06.
    const why = await waitForOff(desk, hubs, location, leave);
    if (why) throw failed(`${why}; ${await restore()}`);
  }
  if (action === "off") return { switched };
  if (action === "cycle") await Bun.sleep((options.offSeconds ?? 2) * 1000);
  try {
    await switchAll(true);
  } catch (err) {
    throw failed(message(err));
  }
  const why = await waitForOn(desk, hubs, location, leave);
  if (why) throw failed(why);
  const port = await waitForReturn(desk, view, location, options.returnSeconds ?? 15, options.settleMs ?? settleMs());
  return { switched, ...(port ? { port } : {}) };
}

/**
 * The hub and its twin, each checked against what uhubctl lists now: present,
 * switching per port, and with the board's port. The twin comes from the live
 * listing when it shows one, so a remembered location never skips it.
 */
function hubsToSwitch(live: Hub[], location: HubLocation, name: string): string[] {
  const twin = twinOf(live, location.hub) ?? location.twin;
  const hubs = twin ? [location.hub, twin] : [location.hub];
  for (const path of hubs) {
    const isTwin = path !== location.hub;
    const cannot = (why: string) =>
      new PowerError(
        `${name}: cannot switch power on ${isTwin ? "its twin hub" : "hub"} ${path} port ${location.port}: ${why}` +
          (isTwin ? " (switching only the other half leaves VBUS up)" : ""),
      );
    const hub = live.find((candidate) => candidate.path === path);
    if (!hub) throw cannot(unlistedReason(live, path));
    if (hub.switching && hub.switching !== "ppps") {
      throw cannot(`the hub (${hub.vidPid} ${hub.description}) does not support per-port power switching: uhubctl marks it ${hub.switching}`);
    }
    if (!hub.ports.some((port) => port.number === location.port)) throw cannot(`the hub has no port ${location.port}`);
  }
  return hubs;
}

/**
 * Why uhubctl does not list a hub. It lists only hubs that switch per port,
 * so a hub that is plugged in but `ganged` or `nops` shows up only as a
 * device on its parent's port, with its mode at the end of the description.
 */
function unlistedReason(live: Hub[], path: string): string {
  const parent = parentOf(path);
  const seat = parent ? portOf(live, parent) : undefined;
  const mode = seat?.description ? powerSwitching(seat.description) : undefined;
  if (seat?.connected && mode && mode !== "ppps") {
    return `the hub (${seat.vidPid ?? "?"} ${seat.description}) does not support per-port power switching: uhubctl marks it ${mode}`;
  }
  return "uhubctl does not list that hub (it is unplugged, or it cannot switch per-port power)";
}

/**
 * The board must be on the port before it is switched. A remembered location
 * can be stale: a board moved to a hub uhubctl cannot switch is still on the
 * bus but on no listed port, and switching where it used to be would cut
 * whatever is there now and report success. A port that is already off is
 * where a board powered off by `board` sits, so that passes.
 */
function checkBoardOnPort(live: Hub[], location: HubLocation, view: BoardView, name: string) {
  const port = portOf(live, location);
  if (!port?.powered || holdsBoard(port, view)) return;
  const there = port.connected ? `holds ${`${port.vidPid ?? "another device"} ${port.description ?? ""}`.trim()}` : "has nothing attached";
  throw new PowerError(
    `${name} is not on hub ${location.hub} port ${location.port}, where it was last seen: that port has power and ${there}. ` +
      "If it is on the bus, it sits on a hub uhubctl cannot switch (uhubctl lists only hubs with per-port power switching)",
  );
}

/**
 * Undefined once every switched port reads off and the board has left the
 * hub; otherwise, after `seconds`, why not.
 */
async function waitForOff(desk: Desk, hubs: string[], location: HubLocation, seconds: number): Promise<string | undefined> {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const live = (await desk.hubs()) ?? [];
    const powered = hubs.filter((hub) => portOf(live, { hub, port: location.port })?.powered !== false);
    const stillThere = portOf(live, location)?.connected === true;
    if (powered.length === 0 && !stillThere) return undefined;
    if (Date.now() >= deadline) {
      if (powered.length > 0) {
        const ports = powered.map((hub) => `hub ${hub} port ${location.port}`).join(" and ");
        const one = powered.length === 1;
        const halfOnly = powered.length < hubs.length ? " (one twin switched and one not, so VBUS stays up)" : "";
        return (
          `power did not drop: ${ports} still ${one ? "reports" : "report"} power after uhubctl switched ` +
          `${one ? "it" : "them"} off${halfOnly}; the hub does not really switch this port's power`
        );
      }
      return "power did not drop: the board stayed on the bus after the port went off (a hub twin not switched, or the board is powered another way)";
    }
    await Bun.sleep(250);
  }
}

/** Undefined once every switched port reads power again; otherwise, after `seconds`, why not. */
async function waitForOn(desk: Desk, hubs: string[], location: HubLocation, seconds: number): Promise<string | undefined> {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const live = (await desk.hubs()) ?? [];
    const off = hubs.filter((hub) => portOf(live, { hub, port: location.port })?.powered !== true);
    if (off.length === 0) return undefined;
    if (Date.now() >= deadline) {
      const ports = off.map((hub) => `hub ${hub} port ${location.port}`).join(" and ");
      const one = off.length === 1;
      return `${ports} still ${one ? "reads" : "read"} no power after uhubctl switched ${one ? "it" : "them"} on; the hub did not switch the port`;
    }
    await Bun.sleep(250);
  }
}

function portOf(live: Hub[], location: { hub: string; port: number }): HubPort | undefined {
  return live.find((hub) => hub.path === location.hub)?.ports.find((port) => port.number === location.port);
}

/** The hub sees this board on the port: by MAC when both sides have one, else by its kind. */
function holdsBoard(port: HubPort | undefined, view: BoardView): boolean {
  if (!port?.connected) return false;
  if (port.mac && view.mac) return port.mac === view.mac;
  const wanted = view.device ? vidPid(view.device) : view.board?.usb;
  return wanted === undefined || port.vidPid === undefined || port.vidPid === wanted;
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
    const onHub = holdsBoard(portOf((await desk.hubs()) ?? [], location), view);
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

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
