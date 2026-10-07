import { describe, expect, test } from "bun:test";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { fakeDeps, tempHome } from "../test/fake_deps.ts";
import { fixtureDesk, type Desk } from "./desk/desk.ts";
import { registryPath } from "./paths.ts";
import { power } from "./power.ts";
import { buildState, resolveRef } from "./state.ts";

describe("power", () => {
  test("off waits for the board to leave the bus; on brings it back", async () => {
    const { desk, view, log } = await setup("FC6");
    await power(desk, view, "off", { settleMs: 0 });
    expect((await desk.usbDevices()).some((device) => device.serial === "02:00:00:00:00:01")).toBe(false);
    const back = await power(desk, view, "on", { settleMs: 0 });
    expect(back.port).toBe("/dev/cu.usbmodem112401");
    expect(log()).toBe("1-1.2 4 off\n1-2.2 4 off\n1-1.2 4 on\n1-2.2 4 on\n");
  });

  test("a bridge with no serial number leaves and comes back by its kind", async () => {
    const { desk, view } = await setup("FV3");
    const result = await power(desk, view, "cycle", { offSeconds: 0, settleMs: 0 });
    expect(result.port).toBe("/dev/cu.wchusbserial112330");
  });

  test("power that never drops is an error, and a cycle restores power before saying so", async () => {
    const { desk, view } = await setup("FC6");
    // Switches are recorded, but the board never leaves the bus.
    const switches: string[] = [];
    const stuck: Desk = {
      ...desk,
      setPower: async (hub, port, on) => {
        switches.push(`${hub} ${port} ${on ? "on" : "off"}`);
      },
    };
    await expect(power(stuck, view, "cycle", { leaveSeconds: 0.3, settleMs: 0 })).rejects.toThrow("power did not drop");
    expect(switches).toEqual(["1-1.2 4 off", "1-2.2 4 off", "1-1.2 4 on", "1-2.2 4 on"]);
  });
});

async function setup(mark: string) {
  const home = tempHome();
  const fixture = tempHome();
  cpSync(join(import.meta.dir, "..", "test", "fixtures", "desk"), fixture, { recursive: true });
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
    ].join("\n"),
  );
  const desk = fixtureDesk(fixture);
  const view = resolveRef(await buildState(home, desk, fakeDeps()), mark)!;
  const logPath = join(fixture, "power.log");
  return { desk, view, log: () => readFileSync(logPath, "utf8") };
}
