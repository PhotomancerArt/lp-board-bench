/**
 * Switchable hubs, read from `uhubctl` with no arguments. Pure parsing, plus
 * the twin rule: a VIA-style hub is a USB 2 hub and a USB 3 hub on one chip,
 * and VBUS drops only when BOTH have the port off.
 */
import { isMac, normalizeMac } from "../mac.ts";

export interface HubPort {
  number: number;
  /** The hub says the port has power (`power`, and not `off`). */
  powered: boolean;
  /** The hub sees a device on the port (`connect`). */
  connected: boolean;
  /** The attached device's vid:pid, when something is attached. */
  vidPid?: string;
  description?: string;
  /** A MAC-shaped serial at the end of the description (Espressif native USB). */
  mac?: string;
}

/**
 * How a hub switches port power, as uhubctl marks it at the end of the hub's
 * line: `ppps` per port, `ganged` all ports at once, `nops` not at all. Only a
 * `ppps` hub can cut one board's power.
 */
export type PowerSwitching = "ppps" | "ganged" | "nops";

export interface Hub {
  /** uhubctl's location, `1-1.2.3`. */
  path: string;
  vidPid: string;
  description: string;
  /** Undefined when uhubctl's line did not say. */
  switching?: PowerSwitching;
  ports: HubPort[];
}

export interface HubLocation {
  hub: string;
  port: number;
  /** The USB 3 (or USB 2) twin of `hub`, switched together with it. */
  twin?: string;
}

export function parseUhubctl(text: string): Hub[] {
  const hubs: Hub[] = [];
  for (const line of text.split("\n")) {
    const head = /^Current status for hub (\S+) \[([0-9a-f]{4}:[0-9a-f]{4}) ?([^\]]*)\]/.exec(line);
    if (head) {
      const description = head[3]!.trim();
      const switching = powerSwitching(description);
      hubs.push({ path: head[1]!, vidPid: head[2]!, description, ...(switching ? { switching } : {}), ports: [] });
      continue;
    }
    const port = /^\s+Port (\d+): \S+(.*?)(?:\[([0-9a-f]{4}:[0-9a-f]{4}) ?([^\]]*)\])?\s*$/.exec(line);
    if (port && hubs.length > 0) {
      const status = port[2]!;
      const description = port[4]?.trim();
      const lastWord = description?.split(/\s+/).pop();
      hubs.at(-1)!.ports.push({
        number: Number(port[1]),
        powered: /\bpower\b/.test(status) && !/\boff\b/.test(status),
        connected: /\bconnect\b/.test(status),
        ...(port[3] ? { vidPid: port[3] } : {}),
        ...(description ? { description } : {}),
        ...(lastWord && isMac(lastWord) ? { mac: normalizeMac(lastWord)! } : {}),
      });
    }
  }
  return hubs;
}

/**
 * The switching mode at the end of a hub's description
 * (`VIA Labs, Inc. USB2.0 Hub, USB 2.10, 4 ports, ppps`). A hub plugged into
 * another hub's port carries the same description there, which is how a hub
 * uhubctl will not list (it lists only `ppps` hubs) still says what it is.
 */
export function powerSwitching(description: string): PowerSwitching | undefined {
  const mode = /,\s*(ppps|ganged|nops)\s*$/.exec(description)?.[1];
  return mode as PowerSwitching | undefined;
}

/** `1-1.2.3` → `{ hub: "1-1.2", port: 3 }`; a root hub (`1-1`) has no parent uhubctl lists. */
export function parentOf(path: string): { hub: string; port: number } | undefined {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return undefined;
  return { hub: path.slice(0, dot), port: Number(path.slice(dot + 1)) };
}

/**
 * Twins named by hand in the desk's `hub-twins.toml`, for a tree no rule
 * fits: a hub's path → its twin's path, or `none` for a hub that has no twin.
 * Naming one side names the other.
 */
export type TwinOverrides = Record<string, string>;

/** What the twin rule found for one hub. */
export interface TwinFinding {
  twin?: string;
  /** `hub-twins.toml` says this hub has no twin. */
  none?: true;
  /** The hub should have a twin and the rule cannot name exactly one: why. Nothing should be switched. */
  problem?: string;
}

/**
 * Where a board sits: by MAC, else by a vid:pid that exactly one port carries
 * (a USB bridge with no serial number).
 */
export function locate(
  hubs: Hub[],
  want: { mac?: string; vidPid?: string },
  overrides: TwinOverrides = {},
): HubLocation | undefined {
  const found: HubLocation[] = [];
  for (const hub of hubs) {
    for (const port of hub.ports) {
      const byMac = want.mac !== undefined && port.mac === want.mac;
      if (byMac) return withTwin(hubs, { hub: hub.path, port: port.number }, overrides);
      if (want.mac === undefined && want.vidPid !== undefined && port.vidPid === want.vidPid) {
        found.push({ hub: hub.path, port: port.number });
      }
    }
  }
  return found.length === 1 ? withTwin(hubs, found[0]!, overrides) : undefined;
}

/** The twin's path, when the rule (or `hub-twins.toml`) names exactly one. */
export function twinOf(hubs: Hub[], path: string, overrides: TwinOverrides = {}): string | undefined {
  return findTwin(hubs, path, overrides).twin;
}

/**
 * The twin is found by where it sits in the tree, not by its path string: a
 * USB 2 hub that only the USB 2 side has (a ganged CH hub between two VIA
 * hubs, measured on the desk 2026-10-23) adds a level to the USB 2 path and
 * none to the USB 3 one, so `1-1.3.1`'s twin is `1-2.3`.
 *
 * Two hubs are twins when they are the same vendor, one USB 2 and one USB 3,
 * on the same bus, with the same ports (the USB 2 half of a VIA hub may have
 * one more, its billboard), and hang off twin parents at the same port. A
 * parent here is the nearest hub up the path of the same vendor that uhubctl
 * lists: hubs of another vendor (USB 2 only) are stepped over. A hub with no
 * such parent pairs with the one other top hub of its vendor on the bus.
 *
 * Each side must name the other. When more than one hub fits, or none does
 * where one should (the vendor's other half is on this bus, so VBUS would
 * stay up through it), it names no twin and says why, rather than guess.
 */
export function findTwin(hubs: Hub[], path: string, overrides: TwinOverrides = {}): TwinFinding {
  const named = overrideFor(overrides, path);
  if (named === NONE) return { none: true };
  if (named !== undefined) return { twin: named };
  const me = hubs.find((hub) => hub.path === path);
  if (!me) return {};
  const fits = candidates(hubs, me, overrides);
  if (typeof fits === "string") return { problem: fits };
  const mutual = fits.list.filter((other) => {
    const back = candidates(hubs, other, overrides);
    return typeof back !== "string" && back.list.length === 1 && back.list[0] === me;
  });
  if (fits.list.length === 1 && mutual.length === 1) return { twin: mutual[0]!.path };
  const write = (twin: string) => `name it in the desk's hub-twins.toml ("${path}" = "${twin}")`;
  const other = generation(me) === 2 ? 3 : 2;
  if (fits.list.length > 0) {
    const all = fits.list.map((hub) => hub.path);
    const why = all.length > 1 ? `any of ${all.join(", ")} could be it` : `${all[0]} fits, but it fits another hub as well`;
    return { problem: `cannot tell which hub is its USB ${other} twin: ${why}; board does not guess: ${write(all[0]!)}` };
  }
  if (!fits.expected) return {};
  return {
    problem:
      `no USB ${other} hub pairs with it, though its USB ${other} half should be on this bus (switching one half leaves VBUS up); ` +
      `${write("<twin path>")}, or "none" if it really has no twin`,
  };
}

const NONE = "none";

/** The override for `path`, from either side of the pair. */
function overrideFor(overrides: TwinOverrides, path: string): string | undefined {
  if (overrides[path] !== undefined) return overrides[path];
  return Object.keys(overrides).find((hub) => overrides[hub] === path);
}

/**
 * The hubs that fit as `me`'s twin, and whether one is expected; or why the
 * tree above it cannot be paired.
 */
function candidates(hubs: Hub[], me: Hub, overrides: TwinOverrides): { list: Hub[]; expected: boolean } | string {
  const gen = generation(me);
  if (gen === undefined) return { list: [], expected: false };
  const up = familyParent(hubs, me);
  if (typeof up === "string") return up;
  let parentTwin: string | undefined;
  if (up) {
    const parent = findTwin(hubs, up.hub.path, overrides);
    if (parent.problem) return `its parent hub ${up.hub.path} cannot be paired: ${parent.problem}`;
    if (!parent.twin) return { list: [], expected: false };
    parentTwin = parent.twin;
  }
  const otherGen = (other: Hub) =>
    other.path !== me.path && vendor(other) === vendor(me) && generation(other) === 5 - gen && bus(other.path) === bus(me.path);
  const list = hubs.filter((other) => {
    if (!otherGen(other) || !portsFit(me, other)) return false;
    const named = overrideFor(overrides, other.path);
    if (named !== undefined && named !== me.path) return false;
    const otherUp = familyParent(hubs, other);
    if (typeof otherUp === "string") return false;
    return up ? otherUp?.hub.path === parentTwin && otherUp?.port === up.port : otherUp === undefined;
  });
  return { list, expected: up !== undefined || hubs.some(otherGen) };
}

/**
 * The nearest hub up `me`'s path of the same vendor that uhubctl lists, and
 * the port of it the path leaves through; or why it cannot be told. A hub
 * between is stepped over only when it is known to be another vendor's: by
 * its own listing, or (a ganged hub uhubctl does not list) by its seat on its
 * parent's port. One of `me`'s vendor that uhubctl does not list may be a
 * twin's half gone missing, and stepping over it would pair the wrong hubs.
 */
function familyParent(hubs: Hub[], me: Hub): { hub: Hub; port: number } | undefined | string {
  for (let up = parentOf(me.path); up; up = parentOf(up.hub)) {
    const at = up.hub;
    const listed = hubs.find((candidate) => candidate.path === at);
    if (listed && vendor(listed) === vendor(me)) return { hub: listed, port: Number(me.path.slice(at.length + 1).split(".")[0]) };
    if (listed) continue;
    const above = parentOf(at);
    const seat = above && hubs.find((hub) => hub.path === above.hub)?.ports.find((port) => port.number === above.port);
    if (!seat?.vidPid) return `the hub at ${at}, above it, is not listed by uhubctl and what it is cannot be read`;
    if (seat.vidPid.slice(0, 4) === vendor(me)) return `its parent hub ${at} (${seat.vidPid}) is not listed by uhubctl`;
  }
  return undefined;
}

/** USB 2 or 3, from the hub's bcdUSB in uhubctl's description (`USB 3.10`). */
function generation(hub: Hub): 2 | 3 | undefined {
  const major = /\bUSB ([23])\.\d+/.exec(hub.description)?.[1];
  return major === "2" ? 2 : major === "3" ? 3 : undefined;
}

/** The USB 2 half of a VIA hub lists the same ports as its USB 3 half, or one more (its billboard). */
function portsFit(a: Hub, b: Hub): boolean {
  const [usb2, usb3] = generation(a) === 2 ? [a, b] : [b, a];
  const extra = portCount(usb2) - portCount(usb3);
  return extra === 0 || extra === 1;
}

function portCount(hub: Hub): number {
  const declared = /\b(\d+) ports\b/.exec(hub.description)?.[1];
  return declared ? Number(declared) : hub.ports.length;
}

function vendor(hub: Hub): string {
  return hub.vidPid.slice(0, 4);
}

function bus(path: string): string {
  return path.slice(0, path.indexOf("-"));
}

function withTwin(hubs: Hub[], location: HubLocation, overrides: TwinOverrides): HubLocation {
  const twin = twinOf(hubs, location.hub, overrides);
  return twin ? { ...location, twin } : location;
}
