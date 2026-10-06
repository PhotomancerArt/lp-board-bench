import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseBoardInfo } from "./espflash.ts";
import { locate, parseUhubctl, twinOf } from "./hubs.ts";
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
