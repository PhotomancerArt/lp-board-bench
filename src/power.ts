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
  options: { offSeconds?: number; returnSeconds?: number } = {},
): Promise<PowerResult> {
  const location = view.hub;
  if (!location) {
    throw new PowerError("not on a switchable hub (uhubctl has never seen it on one)");
  }
  const hubs = hubsOf(location);
  const switched = hubs.map((hub) => `${hub} port ${location.port}`);
  if (action === "off" || action === "cycle") for (const hub of hubs) desk.setPower(hub, location.port, false);
  if (action === "off") return { switched };
  if (action === "cycle") await Bun.sleep((options.offSeconds ?? 2) * 1000);
  for (const hub of hubs) desk.setPower(hub, location.port, true);
  const port = await waitForReturn(desk, view, options.returnSeconds ?? 15);
  return { switched, ...(port ? { port } : {}) };
}

function hubsOf(location: HubLocation): string[] {
  return location.twin ? [location.hub, location.twin] : [location.hub];
}

async function waitForReturn(desk: Desk, view: BoardView, seconds: number): Promise<string | undefined> {
  const deadline = Date.now() + seconds * 1000;
  // A bridge with no serial number is found again by its kind.
  const wantedVidPid = view.device ? vidPid(view.device) : view.board?.usb;
  while (Date.now() < deadline) {
    const device = desk.usbDevices().find((candidate) =>
      view.mac && candidate.serial
        ? normalizeMac(candidate.serial) === view.mac
        : wantedVidPid !== undefined && vidPid(candidate) === wantedVidPid,
    );
    if (device?.port) return device.port;
    await Bun.sleep(500);
  }
  return undefined;
}
