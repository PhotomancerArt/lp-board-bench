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

export interface Hub {
  /** uhubctl's location, `1-1.2.3`. */
  path: string;
  vidPid: string;
  description: string;
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
      hubs.push({ path: head[1]!, vidPid: head[2]!, description: head[3]!.trim(), ports: [] });
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
 * Where a board sits: by MAC, else by a vid:pid that exactly one port carries
 * (a USB bridge with no serial number).
 */
export function locate(hubs: Hub[], want: { mac?: string; vidPid?: string }): HubLocation | undefined {
  const found: HubLocation[] = [];
  for (const hub of hubs) {
    for (const port of hub.ports) {
      const byMac = want.mac !== undefined && port.mac === want.mac;
      if (byMac) return withTwin(hubs, { hub: hub.path, port: port.number });
      if (want.mac === undefined && want.vidPid !== undefined && port.vidPid === want.vidPid) {
        found.push({ hub: hub.path, port: port.number });
      }
    }
  }
  return found.length === 1 ? withTwin(hubs, found[0]!) : undefined;
}

/**
 * The twin of `1-1.2.3` is the hub at `1-2.2.3`: same bus, different root
 * port, same path below it, same vendor. Measured on a VIA VL817 dual hub.
 */
export function twinOf(hubs: Hub[], path: string): string | undefined {
  const me = hubs.find((hub) => hub.path === path);
  if (!me) return undefined;
  const [bus, rest] = splitPath(path);
  const vendor = me.vidPid.slice(0, 4);
  const twins = hubs.filter((hub) => {
    if (hub.path === path || hub.vidPid.slice(0, 4) !== vendor) return false;
    const [otherBus, otherRest] = splitPath(hub.path);
    return otherBus === bus && otherRest === rest;
  });
  return twins.length === 1 ? twins[0]!.path : undefined;
}

function withTwin(hubs: Hub[], location: HubLocation): HubLocation {
  const twin = twinOf(hubs, location.hub);
  return twin ? { ...location, twin } : location;
}

/** `1-1.2.3` → [`1`, `.2.3`]; `1-1` → [`1`, ``]. */
function splitPath(path: string): [string, string] {
  const dash = path.indexOf("-");
  const dot = path.indexOf(".", dash);
  return [path.slice(0, dash), dot < 0 ? "" : path.slice(dot)];
}
