import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { fakeDeps, tempHome } from "../test/fake_deps.ts";
import { fixtureDesk, type Desk } from "./desk/desk.ts";
import type { HubLocation } from "./desk/hubs.ts";
import { registryPath } from "./paths.ts";
import { power } from "./power.ts";
import { buildState, resolveRef } from "./state.ts";

describe("power", () => {
  test("off waits for the board to leave the bus; on brings it back", async () => {
    const { desk, view, log } = await setup("FC6");
    await power(desk, view, "off", { settleMs: 0 });
    expect(desk.usbDevices().some((device) => device.serial === "02:00:00:00:00:01")).toBe(false);
    const back = await power(desk, view, "on", { settleMs: 0 });
    expect(back.port).toBe("/dev/cu.usbmodem112401");
    expect(log()).toBe("1-1.2 4 off\n1-2.2 4 off\n1-1.2 4 on\n1-2.2 4 on\n");
  });

  test("a bridge with no serial number leaves and comes back by its kind", async () => {
    const { desk, view } = await setup("FV3");
    const result = await power(desk, view, "cycle", { offSeconds: 0, settleMs: 0 });
    expect(result.port).toBe("/dev/cu.wchusbserial112330");
  });

  test("off is confirmed by the hub: both twins' ports read no power, and the board has left", async () => {
    const { desk, view } = await setup("FC6");
    await power(desk, view, "off", { settleMs: 0 });
    expect(await portState(desk, "1-1.2", 4)).toEqual({ powered: false, connected: false });
    expect(await portState(desk, "1-2.2", 4)).toEqual({ powered: false, connected: false });
  });

  test("a hub uhubctl marks ganged fails before anything is switched, naming the board, the hub and why", async () => {
    const { desk, view, log } = await setup("FC6", {
      uhubctl: (text) => text.replace("[2109:2817 VIA Labs, Inc. USB2.0 Hub, USB 2.10, 4 ports, ppps]\n  Port 1: 0100 power\n  Port 2: 0100 power\n  Port 3: 0503", "[2109:2817 VIA Labs, Inc. USB2.0 Hub, USB 2.10, 4 ports, ganged]\n  Port 1: 0100 power\n  Port 2: 0100 power\n  Port 3: 0503"),
    });
    for (const action of ["cycle", "off", "on"] as const) {
      await expect(power(desk, view, action, { offSeconds: 0, settleMs: 0 })).rejects.toThrow(
        "FC6 fixture-c6: cannot switch power on hub 1-1.2 port 4: the hub (2109:2817 VIA Labs, Inc. USB2.0 Hub, USB 2.10, 4 ports, ganged) " +
          "does not support per-port power switching: uhubctl marks it ganged",
      );
    }
    expect(log()).toBe("");
    expect(await portState(desk, "1-1.2", 4)).toEqual({ powered: true, connected: true });
  });

  test("a board on a hub uhubctl will not list (ganged) fails by name, through its last-seen location", async () => {
    // CHK sits on 1-1.3, the ganged CH hub uhubctl lists only as a device on 1-1 port 3.
    const { desk, view, log } = await setup("CHK", { memory: { "02:00:00:00:00:03": { hub: "1-1.3", port: 2 } } });
    await expect(power(desk, view, "cycle", { offSeconds: 0, settleMs: 0 })).rejects.toThrow(
      "CHK art-choker: cannot switch power on hub 1-1.3 port 2: the hub (1a86:8095 USB Hub, USB 2.00, 4 ports, ganged) " +
        "does not support per-port power switching: uhubctl marks it ganged",
    );
    expect(log()).toBe("");
  });

  test("a stale last-seen port is not switched: the board is not there, so someone else's port would be", async () => {
    const { desk, view, log } = await setup("CHK", { memory: { "02:00:00:00:00:03": { hub: "1-1.2", port: 1, twin: "1-2.2" } } });
    await expect(power(desk, view, "off", { settleMs: 0 })).rejects.toThrow(
      "CHK art-choker is not on hub 1-1.2 port 1, where it was last seen: that port has power and has nothing attached",
    );
    expect(log()).toBe("");
  });

  test("a hub that takes the request and keeps the power on fails loudly, and the port is left as it was", async () => {
    const { desk, view, log } = await setup("FC6", { ignores: ["1-1.2", "1-2.2"] });
    await expect(power(desk, view, "cycle", { offSeconds: 0, leaveSeconds: 0.3, settleMs: 0 })).rejects.toThrow(
      "FC6 fixture-c6: power-cycle failed on hub 1-1.2 port 4 and 1-2.2 port 4: power did not drop: hub 1-1.2 port 4 and hub 1-2.2 port 4 " +
        "still report power after uhubctl switched them off; the hub does not really switch this port's power; power was switched back on",
    );
    expect(log()).toBe("1-1.2 4 off ignored\n1-2.2 4 off ignored\n1-1.2 4 on ignored\n1-2.2 4 on ignored\n");
    expect(await portState(desk, "1-1.2", 4)).toEqual({ powered: true, connected: true });
    await expect(power(desk, view, "off", { leaveSeconds: 0.3, settleMs: 0 })).rejects.toThrow("power did not drop");
  });

  test("a twin that does not switch is a failure, and the half that did is switched back on", async () => {
    const { desk, view, log } = await setup("FC6", { ignores: ["1-2.2"] });
    await expect(power(desk, view, "off", { leaveSeconds: 0.3, settleMs: 0 })).rejects.toThrow(
      "power did not drop: hub 1-2.2 port 4 still reports power after uhubctl switched it off (one twin switched and one not, so VBUS stays up)",
    );
    expect(log()).toBe("1-1.2 4 off\n1-2.2 4 off ignored\n1-1.2 4 on\n1-2.2 4 on ignored\n");
    expect(await portState(desk, "1-1.2", 4)).toEqual({ powered: true, connected: true });
  });

  test("a twin uhubctl no longer lists is not skipped: nothing is switched", async () => {
    const { desk, view, log } = await setup("FC6", {
      uhubctl: (text) => text.replace(/Current status for hub 1-2\.2 \[[^\n]*\n(  Port[^\n]*\n)*/, ""),
      memory: { "02:00:00:00:00:01": { hub: "1-1.2", port: 4, twin: "1-2.2" } },
    });
    await expect(power(desk, view, "cycle", { offSeconds: 0, settleMs: 0 })).rejects.toThrow(
      "FC6 fixture-c6: cannot switch power on its twin hub 1-2.2 port 4: uhubctl does not list that hub (it is unplugged, or it cannot switch per-port power) " +
        "(switching only the other half leaves VBUS up)",
    );
    expect(log()).toBe("");
  });

  test("on fails when the hub does not bring the port's power back", async () => {
    const { desk, fixture, view } = await setup("FC6");
    await power(desk, view, "off", { settleMs: 0 });
    writeFileSync(join(fixture, "ignores-power.txt"), "1-1.2\n1-2.2\n");
    await expect(power(desk, view, "on", { leaveSeconds: 0.3, settleMs: 0 })).rejects.toThrow(
      "FC6 fixture-c6: power-on failed on hub 1-1.2 port 4 and 1-2.2 port 4: hub 1-1.2 port 4 and hub 1-2.2 port 4 still read no power",
    );
  });

  test("power that never drops is an error, and a cycle restores power before saying so", async () => {
    const { desk, view } = await setup("FC6");
    // Switches are recorded, but the board never leaves the bus.
    const switches: string[] = [];
    const stuck: Desk = { ...desk, setPower: async (hub, port, on) => void switches.push(`${hub} ${port} ${on ? "on" : "off"}`) };
    await expect(power(stuck, view, "cycle", { leaveSeconds: 0.3, settleMs: 0 })).rejects.toThrow("power did not drop");
    expect(switches).toEqual(["1-1.2 4 off", "1-2.2 4 off", "1-1.2 4 on", "1-2.2 4 on"]);
  });
});

interface SetupOptions {
  /** Rewrites the fixture's uhubctl listing. */
  uhubctl?: (text: string) => string;
  /** hub-ports.json: where boards were last seen. */
  memory?: Record<string, HubLocation>;
  /** Hubs that take a power request and change nothing. */
  ignores?: string[];
}

async function setup(mark: string, options: SetupOptions = {}) {
  const home = tempHome();
  const fixture = tempHome();
  cpSync(join(import.meta.dir, "..", "test", "fixtures", "desk"), fixture, { recursive: true });
  const listing = join(fixture, "uhubctl.txt");
  if (options.uhubctl) {
    const before = readFileSync(listing, "utf8");
    const after = options.uhubctl(before);
    if (after === before) throw new Error("the uhubctl rewrite changed nothing");
    writeFileSync(listing, after);
  }
  if (options.memory) writeFileSync(join(home, "hub-ports.json"), JSON.stringify(options.memory));
  if (options.ignores) writeFileSync(join(fixture, "ignores-power.txt"), `${options.ignores.join("\n")}\n`);
  writeFileSync(
    registryPath(home),
    [
      "[[board]]",
      'slug = "fixture-c6"',
      'mark = "FC6"',
      'mac = "02:00:00:00:00:01"',
      "[[board]]",
      'slug = "fixture-v3"',
      'mark = "FV3"',
      'mac = "02:00:00:00:00:04"',
      'usb = "1a86:7522"',
      "[[board]]",
      'slug = "art-choker"',
      'mark = "CHK"',
      'mac = "02:00:00:00:00:03"',
    ].join("\n"),
  );
  const desk = fixtureDesk(fixture);
  const view = resolveRef(await buildState(home, desk, fakeDeps()), mark)!;
  const logPath = join(fixture, "power.log");
  return { desk, fixture, view, log: () => (existsSync(logPath) ? readFileSync(logPath, "utf8") : "") };
}

/** The port as the hub reports it now. */
async function portState(desk: Desk, hub: string, port: number) {
  const found = (await desk.hubs())?.find((candidate) => candidate.path === hub)?.ports.find((candidate) => candidate.number === port);
  return found ? { powered: found.powered, connected: found.connected } : undefined;
}
