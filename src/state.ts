/**
 * The whole desk at one moment: every registered board joined with what is on
 * the bus, who holds it, who waits for it, which hub port it sits on and which
 * picture to show. The CLI's `list` and the page both render this.
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { atomicWrite } from "./atomic_write.ts";
import type { Deps } from "./deps.ts";
import type { Desk } from "./desk/desk.ts";
import { locate, type Hub, type HubLocation } from "./desk/hubs.ts";
import { vidPid, type UsbDevice } from "./desk/presence.ts";
import { liveLease, type Lease } from "./lease.ts";
import { isMac, normalizeMac } from "./mac.ts";
import { imagesDir } from "./paths.ts";
import { handle, loadRegistry, type Board } from "./registry.ts";
import { lineFor, type Waiter } from "./waiting.ts";

export interface BoardView {
  /** The registry entry; absent for a device nobody registered yet. */
  board?: Board;
  /** The device on the bus; absent when the board is not plugged in. */
  device?: UsbDevice;
  /** What leases key on: the registry's MAC, else a MAC-shaped USB serial. */
  mac?: string;
  lease?: Lease;
  line: Waiter[];
  hub?: HubLocation;
  /** True when `hub` is where the board was last seen, not where it is now. */
  hubRemembered?: boolean;
  /** A picture file to show, when one exists. */
  image?: string;
}

export interface DeskState {
  views: BoardView[];
  /** False when this machine has no uhubctl: power actions are off. */
  hubsAvailable: boolean;
}

export async function buildState(home: string, desk: Desk, deps: Deps): Promise<DeskState> {
  const boards = loadRegistry(home);
  const [devices, hubs] = await Promise.all([desk.usbDevices(), desk.hubs()]);
  const memory = readHubMemory(home);
  const claimed = new Set<UsbDevice>();

  const views: BoardView[] = boards.map((board) => {
    const device = matchDevice(board, boards, devices);
    if (device) claimed.add(device);
    return { board, mac: board.mac, line: [], ...(device ? { device } : {}) };
  });
  for (const device of devices) {
    if (claimed.has(device)) continue;
    const mac = device.serial && isMac(device.serial) ? normalizeMac(device.serial) : undefined;
    views.push({ device, line: [], ...(mac ? { mac } : {}) });
  }

  let memoryChanged = false;
  for (const view of views) {
    if (view.mac) {
      const lease = liveLease(home, view.mac, deps);
      if (lease) view.lease = lease;
      view.line = lineFor(home, view.mac, deps);
    }
    const found = hubs && view.device ? locateView(hubs, view) : undefined;
    if (found) {
      view.hub = found;
      if (view.mac && JSON.stringify(memory[view.mac]) !== JSON.stringify(found)) {
        memory[view.mac] = found;
        memoryChanged = true;
      }
    } else if (view.mac && memory[view.mac]) {
      view.hub = memory[view.mac];
      view.hubRemembered = true;
    }
    const image = pictureFor(home, view);
    if (image) view.image = image;
  }
  if (memoryChanged) atomicWrite(join(home, "hub-ports.json"), `${JSON.stringify(memory, null, 2)}\n`);

  return { views, hubsAvailable: hubs !== undefined };
}

export class RefError extends Error {}

/**
 * Find a board by slug, mark, MAC or `/dev` path. A path matches the device
 * on that node, registered or not.
 */
export function resolveRef(state: DeskState, ref: string): BoardView | undefined {
  const text = ref.trim();
  if (text.startsWith("/dev/")) {
    const port = text.replace("/dev/tty.", "/dev/cu.");
    return state.views.find((view) => view.device?.port === port);
  }
  const lower = text.toLowerCase();
  const mac = normalizeMac(text);
  return state.views.find(
    (view) =>
      view.board?.slug === lower ||
      view.board?.mark.toLowerCase() === lower ||
      (mac !== undefined && view.mac === mac),
  );
}

/** `FC6 fixture-c6`, or for an unregistered device what the bus says. */
export function viewName(view: BoardView): string {
  if (view.board) return handle(view.board);
  const what = view.device ? `${view.device.name} ${vidPid(view.device)}` : "unknown device";
  return `unregistered ${what}${view.mac ? ` ${view.mac}` : ""}`;
}

/** Matching rules, in order: MAC, then usb_serial, then a vid:pid unique on both sides. */
function matchDevice(board: Board, boards: Board[], devices: UsbDevice[]): UsbDevice | undefined {
  const byMac = devices.find((device) => device.serial && normalizeMac(device.serial) === board.mac);
  if (byMac) return byMac;
  if (board.usb_serial) {
    const bySerial = devices.find((device) => device.serial === board.usb_serial);
    if (bySerial) return bySerial;
  }
  if (board.usb) {
    const sameKindBoards = boards.filter((other) => other.usb === board.usb);
    const sameKindDevices = devices.filter((device) => vidPid(device) === board.usb && !(device.serial && isMac(device.serial)));
    if (sameKindBoards.length === 1 && sameKindDevices.length === 1) return sameKindDevices[0];
  }
  return undefined;
}

function locateView(hubs: Hub[], view: BoardView): HubLocation | undefined {
  const device = view.device!;
  const serialIsMac = device.serial !== undefined && isMac(device.serial);
  return serialIsMac ? locate(hubs, { mac: view.mac! }) : locate(hubs, { vidPid: vidPid(device) });
}

function pictureFor(home: string, view: BoardView): string | undefined {
  const candidates: string[] = [];
  const explicit = view.board?.image;
  if (explicit) candidates.push(isAbsolute(explicit) ? explicit : join(imagesDir(home), explicit));
  if (view.mac) {
    const art = join(imagesDir(home), `${view.mac}.art.svg`);
    const drawing = join(imagesDir(home), `${view.mac}.board.svg`);
    candidates.push(...(view.board?.role === "art" ? [art, drawing] : [drawing, art]));
  }
  return candidates.find((path) => existsSync(path));
}

function readHubMemory(home: string): Record<string, HubLocation> {
  try {
    return JSON.parse(readFileSync(join(home, "hub-ports.json"), "utf8")) as Record<string, HubLocation>;
  } catch {
    return {};
  }
}
