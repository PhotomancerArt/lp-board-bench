import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseBoardInfo } from "./espflash.ts";
import { uhubctlSwitch } from "./desk.ts";
import { findTwin, locate, parentOf, parseUhubctl, powerSwitching, twinOf } from "./hubs.ts";
import { parseSystemProfiler, portForLocation } from "./presence.ts";

const FIXTURES = join(import.meta.dir, "..", "..", "test", "fixtures", "desk");
const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");
const devNodes = () => fixture("dev.txt").split("\n").filter(Boolean);

describe("presence (system_profiler)", () => {
  test("finds the boards and their ports, and ignores hubs and billboards", () => {
    const devices = parseSystemProfiler(JSON.parse(fixture("system_profiler.json")), devNodes());
    expect(devices.map((device) => [device.vid, device.pid, device.serial ?? null, device.port])).toEqual([
      ["303a", "1001", "02:00:00:00:00:02", "/dev/cu.usbmodem1123201"],
      ["1a86", "7522", null, "/dev/cu.wchusbserial112330"],
      ["303a", "1001", "02:00:00:00:00:01", "/dev/cu.usbmodem112401"],
      ["303a", "1001", "02:00:00:00:00:03", "/dev/cu.usbmodem2101"],
    ]);
  });

  test("a location maps to a node only when exactly one fits", () => {
    expect(portForLocation(0x01123200, ["/dev/cu.usbmodem1123201"])).toBe("/dev/cu.usbmodem1123201");
    expect(portForLocation(0x01123300, ["/dev/cu.wchusbserial112330"])).toBe("/dev/cu.wchusbserial112330");
    expect(portForLocation(0x01123200, ["/dev/cu.usbmodem1123201", "/dev/cu.usbserial-1123201"])).toBeUndefined();
    expect(portForLocation(0x01123200, ["/dev/cu.usbmodem11232012345"])).toBeUndefined();
  });
});

describe("hubs (uhubctl)", () => {
  const hubs = parseUhubctl(fixture("uhubctl.txt"));

  test("reads hubs, ports and the MACs of attached boards", () => {
    const hub = hubs.find((candidate) => candidate.path === "1-1.2.3")!;
    expect(hub.vidPid).toBe("2109:2817");
    expect(hub.ports.map((port) => [port.number, port.vidPid ?? null, port.mac ?? null])).toEqual([
      [1, null, null],
      [2, "303a:1001", "02:00:00:00:00:02"],
      [3, "1a86:7522", null],
      [4, null, null],
    ]);
  });

  test("reads whether each port has power and a device, as the hub reports it", () => {
    const [hub] = parseUhubctl(
      [
        "Current status for hub 1-1.2 [2109:2817 VIA Labs, Inc. USB2.0 Hub, USB 2.10, 4 ports, ppps]",
        "  Port 1: 0100 power",
        "  Port 2: 0000 off",
        "  Port 4: 0103 power enable connect [303a:1001 Espressif USB JTAG/serial debug unit 02:00:00:00:00:01]",
      ].join("\n"),
    );
    expect(hub!.ports.map((port) => [port.number, port.powered, port.connected])).toEqual([
      [1, true, false],
      [2, false, false],
      [4, true, true],
    ]);
  });

  test("reads how each hub switches power, and a hub uhubctl will not list from its parent's port", () => {
    expect(hubs.find((hub) => hub.path === "1-1.2")!.switching).toBe("ppps");
    // uhubctl lists only ppps hubs; the ganged CH hub shows up only as a device on 1-1 port 3.
    expect(hubs.some((hub) => hub.path === "1-1.3")).toBe(false);
    const parent = parentOf("1-1.3")!;
    expect(parent).toEqual({ hub: "1-1", port: 3 });
    const seat = hubs.find((hub) => hub.path === parent.hub)!.ports.find((port) => port.number === parent.port)!;
    expect(powerSwitching(seat.description!)).toBe("ganged");
    expect(powerSwitching("Some Hub, USB 2.00, 4 ports, nops")).toBe("nops");
    expect(powerSwitching("Espressif USB JTAG/serial debug unit 02:00:00:00:00:01")).toBeUndefined();
    expect(parentOf("1-1")).toBeUndefined();
  });

  test("a VIA USB 2 hub's twin is the USB 3 hub at the same path under the other root port", () => {
    expect(twinOf(hubs, "1-1.2.3")).toBe("1-2.2.3");
    expect(twinOf(hubs, "1-2.2.3")).toBe("1-1.2.3");
    expect(twinOf(hubs, "1-1.2")).toBe("1-2.2");
    expect(twinOf(hubs, "1-1.4")).toBe("1-2.4");
  });

  test("locates a board by MAC, a serial-less bridge by its unique vid:pid, and nothing off-hub", () => {
    expect(locate(hubs, { mac: "02:00:00:00:00:01" })).toEqual({ hub: "1-1.2", port: 4, twin: "1-2.2" });
    expect(locate(hubs, { vidPid: "1a86:7522" })).toEqual({ hub: "1-1.2.3", port: 3, twin: "1-2.2.3" });
    expect(locate(hubs, { mac: "02:00:00:00:00:03" })).toBeUndefined();
  });
});

describe("hub twins, paired by where they sit in the tree", () => {
  // The desk on 2026-10-23: a ganged CH hub (1a86:8095) on 1-1 port 3 carries
  // the VIA hub 1-1.3.1, whose USB 3 half is 1-2.3, one level shallower.
  const text = fixture("uhubctl-ch-hub-between-twins.txt");
  const hubs = parseUhubctl(text);
  /** The listing with these hubs' blocks taken out, as if uhubctl did not list them. */
  const without = (...paths: string[]) => parseUhubctl(paths.reduce((listing, path) => removeHub(listing, path), text));
  /** The listing with the VIA hub 1-1.3.1 copied to 1-1.3.2: a second hub on the CH hub. */
  const withSecondViaOnChHub = () => parseUhubctl(`${text}\n${hubBlock(text, "1-1.3.1").replace("hub 1-1.3.1 ", "hub 1-1.3.2 ")}`);

  test("a USB 2-only hub between twins is stepped over: 1-1.3.1's twin is 1-2.3, not 1-2.3.3", () => {
    expect(twinOf(hubs, "1-1.3.1")).toBe("1-2.3");
    expect(twinOf(hubs, "1-2.3")).toBe("1-1.3.1");
    expect(twinOf(hubs, "1-1.3.1.3")).toBe("1-2.3.3");
    expect(twinOf(hubs, "1-2.3.3")).toBe("1-1.3.1.3");
  });

  test("the top hubs pair, and a USB 2 half with one more port (its billboard) still pairs", () => {
    expect(twinOf(hubs, "1-1")).toBe("1-2");
    expect(twinOf(hubs, "1-1.4")).toBe("1-2.4");
    expect(twinOf(hubs, "1-2.4")).toBe("1-1.4");
  });

  test("a board's location names its twin", () => {
    expect(locate(hubs, { mac: "02:00:00:00:00:02" })).toEqual({ hub: "1-1.3.1", port: 2, twin: "1-2.3" });
    expect(locate(hubs, { mac: "02:00:00:00:00:01" })).toEqual({ hub: "1-1.3.1.3", port: 1, twin: "1-2.3.3" });
    expect(locate(hubs, { vidPid: "1a86:7522" })).toEqual({ hub: "1-1.3.1.3", port: 2, twin: "1-2.3.3" });
  });

  test("two hubs that fit one twin is a refusal, not a guess, and so is every hub below them", () => {
    const tree = withSecondViaOnChHub();
    expect(findTwin(tree, "1-2.3")).toEqual({
      problem:
        "cannot tell which hub is its USB 2 twin: any of 1-1.3.1, 1-1.3.2 could be it; " +
        'board does not guess: name it in the desk\'s hub-twins.toml ("1-2.3" = "1-1.3.1")',
    });
    expect(findTwin(tree, "1-1.3.1").problem).toStartWith("cannot tell which hub is its USB 3 twin: 1-2.3 fits, but it fits another hub as well");
    expect(findTwin(tree, "1-1.3.1.3").problem).toStartWith("its parent hub 1-1.3.1 cannot be paired: cannot tell");
    expect(locate(tree, { mac: "02:00:00:00:00:02" })).toEqual({ hub: "1-1.3.1", port: 2 });
  });

  test("hub-twins.toml settles a tree the rule cannot, from either side, and can say a hub has none", () => {
    const tree = withSecondViaOnChHub();
    expect(findTwin(tree, "1-1.3.1", { "1-1.3.1": "1-2.3" })).toEqual({ twin: "1-2.3" });
    expect(findTwin(tree, "1-2.3", { "1-1.3.1": "1-2.3" })).toEqual({ twin: "1-1.3.1" });
    expect(findTwin(tree, "1-1.3.1.3", { "1-1.3.1": "1-2.3" })).toEqual({ twin: "1-2.3.3" });
    expect(findTwin(tree, "1-1.3.2", { "1-1.3.2": "none" })).toEqual({ none: true });
  });

  test("a USB 2 hub whose USB 3 half should be there and is not is a refusal: switching one half leaves VBUS up", () => {
    const tree = without("1-2.3", "1-2.3.3");
    expect(findTwin(tree, "1-1.3.1").problem).toStartWith(
      "no USB 3 hub pairs with it, though its USB 3 half should be on this bus (switching one half leaves VBUS up)",
    );
  });

  test("a hub of the same vendor that uhubctl does not list is not stepped over", () => {
    // Stepping over a missing 1-2.3 would pair 1-1.3.1 with 1-2.3.3.
    const tree = without("1-2.3");
    expect(findTwin(tree, "1-2.3.3").problem).toBe("its parent hub 1-2.3 (2109:0817) is not listed by uhubctl");
    expect(twinOf(tree, "1-1.3.1")).toBeUndefined();
  });

  test("a hub with no other half of its vendor on the bus simply has no twin", () => {
    const alone = parseUhubctl(hubBlock(text, "1-1.3.1").replace("hub 1-1.3.1 ", "hub 1-3 "));
    expect(findTwin(alone, "1-3")).toEqual({});
  });
});

describe("uhubctl switch", () => {
  test("switches only the port asked for: -e, so uhubctl never switches its own pick of a companion", () => {
    expect(uhubctlSwitch("1-2.3", 2, false)).toEqual(["uhubctl", "-l", "1-2.3", "-p", "2", "-a", "off", "-e"]);
  });
});

describe("espflash board-info", () => {
  test("reads chip, revision, flash and MAC", () => {
    expect(parseBoardInfo(fixture("espflash-board-info-c6.txt"))).toEqual({
      chip: "esp32c6",
      revision: "v0.2",
      flash: "4MB",
      mac: "02:00:00:00:00:01",
    });
    expect(parseBoardInfo(fixture("espflash-board-info-v3.txt"))).toMatchObject({ chip: "esp32", revision: "v3.1" });
    expect(parseBoardInfo("Error: could not connect")).toEqual({});
  });
});

/** One hub's block of a uhubctl listing: its status line and its ports. */
function hubBlock(listing: string, path: string): string {
  const escaped = path.replaceAll(".", "\\.");
  return new RegExp(`Current status for hub ${escaped} \\[[^\\n]*\\n(  Port[^\\n]*(\\n|$))*`).exec(listing)![0].trimEnd();
}

function removeHub(listing: string, path: string): string {
  return listing.replace(`${hubBlock(listing, path)}\n`, "");
}
