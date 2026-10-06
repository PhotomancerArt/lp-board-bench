import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { fakeDeps, MAC_A, tempHome } from "../test/fake_deps.ts";
import { take } from "./lease.ts";
import { lineDir } from "./paths.ts";
import { joinLine, leaveLine, lineFor } from "./waiting.ts";

describe("the line", () => {
  test("waiters queue oldest first", () => {
    const home = tempHome();
    const deps = fakeDeps();
    deps.alivePids.add(1).add(2);
    joinLine(home, { mac: MAC_A, holder: "first", purpose: "a", pid: 1 }, deps);
    deps.advanceMinutes(1);
    joinLine(home, { mac: MAC_A, holder: "second", purpose: "b", pid: 2 }, deps);
    expect(lineFor(home, MAC_A, deps).map((waiter) => waiter.holder)).toEqual(["first", "second"]);
  });

  test("a dead waiter drops out of the line, and its file is pruned on the next take", () => {
    const home = tempHome();
    const deps = fakeDeps();
    deps.alivePids.add(1).add(2);
    const dead = joinLine(home, { mac: MAC_A, holder: "crashed", purpose: "", pid: 1 }, deps);
    deps.advanceMinutes(1);
    const live = joinLine(home, { mac: MAC_A, holder: "next", purpose: "", pid: 2 }, deps);
    deps.kill(1);
    expect(lineFor(home, MAC_A, deps).map((waiter) => waiter.id)).toEqual([live.id]);
    expect(take(home, { mac: MAC_A, holder: "next", purpose: "", waiterId: live.id }, deps).ok).toBe(true);
    expect(existsSync(join(lineDir(home, MAC_A), `${dead.id}.json`))).toBe(false);
    expect(existsSync(join(lineDir(home, MAC_A), `${live.id}.json`))).toBe(false);
  });

  test("leaving removes the waiter's file", () => {
    const home = tempHome();
    const deps = fakeDeps();
    const waiter = joinLine(home, { mac: MAC_A, holder: "me", purpose: "", pid: process.pid }, deps);
    leaveLine(home, MAC_A, waiter.id, deps);
    expect(lineFor(home, MAC_A, deps)).toEqual([]);
  });
});
