import { describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";

import { fakeDeps, MAC_A, tempHome } from "../test/fake_deps.ts";
import { describeLease, drop, liveLease, readLease, renew, settle, take } from "./lease.ts";
import { leasePath } from "./paths.ts";
import { joinLine } from "./waiting.ts";

describe("leases", () => {
  test("a free board is taken for 30 minutes by default", () => {
    const home = tempHome();
    const deps = fakeDeps();
    const result = take(home, { mac: MAC_A, holder: "ota", purpose: "soak" }, deps);
    expect(result).toMatchObject({ ok: true, renewed: false });
    expect(readLease(home, MAC_A)).toMatchObject({
      holder: "ota",
      purpose: "soak",
      acquired: "2026-10-05T19:30:00.000Z",
      expires: "2026-10-05T20:00:00.000Z",
    });
  });

  test("someone else's live lease is refused, naming holder and expiry", () => {
    const home = tempHome();
    const deps = fakeDeps();
    take(home, { mac: MAC_A, holder: "ota", purpose: "power-cut soak" }, deps);
    deps.advanceMinutes(7);
    const result = take(home, { mac: MAC_A, holder: "wifi", purpose: "scan" }, deps);
    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== "held") throw new Error("expected held");
    expect(describeLease(result.lease, deps)).toMatch(/^held by ota until \d\d:\d\d \(23 min left\): power-cut soak$/);
  });

  test("the same holder taking again renews, keeping when it was first acquired", () => {
    const home = tempHome();
    const deps = fakeDeps();
    take(home, { mac: MAC_A, holder: "ota", purpose: "soak" }, deps);
    deps.advanceMinutes(20);
    const result = take(home, { mac: MAC_A, holder: "ota", purpose: "", minutes: 60 }, deps);
    expect(result).toMatchObject({ ok: true, renewed: true });
    expect(readLease(home, MAC_A)).toMatchObject({
      purpose: "soak",
      acquired: "2026-10-05T19:30:00.000Z",
      expires: "2026-10-05T20:50:00.000Z",
    });
  });

  test("an expired lease is free", () => {
    const home = tempHome();
    const deps = fakeDeps();
    take(home, { mac: MAC_A, holder: "ota", purpose: "", minutes: 5 }, deps);
    deps.advanceMinutes(5);
    expect(liveLease(home, MAC_A, deps)).toBeUndefined();
    expect(take(home, { mac: MAC_A, holder: "wifi", purpose: "" }, deps)).toMatchObject({ ok: true, renewed: false });
  });

  test("a lease whose process died is free", () => {
    const home = tempHome();
    const deps = fakeDeps();
    deps.alivePids.add(4242);
    take(home, { mac: MAC_A, holder: "soak-script", purpose: "", pid: 4242 }, deps);
    expect(liveLease(home, MAC_A, deps)).toBeDefined();
    deps.kill(4242);
    expect(liveLease(home, MAC_A, deps)).toBeUndefined();
    expect(take(home, { mac: MAC_A, holder: "wifi", purpose: "" }, deps).ok).toBe(true);
  });

  test("minutes are capped at four hours and must be positive", () => {
    const home = tempHome();
    const deps = fakeDeps();
    take(home, { mac: MAC_A, holder: "ota", purpose: "", minutes: 10_000 }, deps);
    expect(readLease(home, MAC_A)?.expires).toBe("2026-10-05T23:30:00.000Z");
    expect(() => take(home, { mac: MAC_A, holder: "ota", purpose: "", minutes: 0 }, deps)).toThrow("positive");
  });

  test("only the holder renews", () => {
    const home = tempHome();
    const deps = fakeDeps();
    take(home, { mac: MAC_A, holder: "ota", purpose: "" }, deps);
    expect(() => renew(home, MAC_A, "wifi", 30, deps)).toThrow("renew as its holder (--as ota)");
    deps.advanceMinutes(25);
    expect(renew(home, MAC_A, "ota", 30, deps).expires).toBe("2026-10-05T20:25:00.000Z");
  });

  test("only the holder drops, unless forced; an expired lease anyone may clear", () => {
    const home = tempHome();
    const deps = fakeDeps();
    take(home, { mac: MAC_A, holder: "ota", purpose: "" }, deps);
    expect(() => drop(home, MAC_A, "wifi", false, deps)).toThrow("only its holder may drop it");
    expect(drop(home, MAC_A, "yona (page)", true, deps)?.holder).toBe("ota");
    expect(existsSync(leasePath(home, MAC_A))).toBe(false);

    take(home, { mac: MAC_A, holder: "ota", purpose: "", minutes: 1 }, deps);
    deps.advanceMinutes(2);
    expect(drop(home, MAC_A, undefined, false, deps)?.holder).toBe("ota");
  });

  test("a junk lease file counts as no lease", () => {
    const home = tempHome();
    const deps = fakeDeps();
    take(home, { mac: MAC_A, holder: "ota", purpose: "" }, deps);
    writeFileSync(leasePath(home, MAC_A), "{ half a fi");
    expect(liveLease(home, MAC_A, deps)).toBeUndefined();
  });

  test("a free board with people in line goes to the head of the line only", () => {
    const home = tempHome();
    const deps = fakeDeps();
    deps.alivePids.add(101).add(102);
    const first = joinLine(home, { mac: MAC_A, holder: "wifi", purpose: "", pid: 101 }, deps);
    deps.advanceMinutes(1);
    const second = joinLine(home, { mac: MAC_A, holder: "ota", purpose: "", pid: 102 }, deps);

    expect(take(home, { mac: MAC_A, holder: "drive-by", purpose: "" }, deps)).toMatchObject({ ok: false, reason: "line" });
    expect(take(home, { mac: MAC_A, holder: "ota", purpose: "", waiterId: second.id }, deps)).toMatchObject({
      ok: false,
      reason: "line",
    });
    expect(take(home, { mac: MAC_A, holder: "wifi", purpose: "", waiterId: first.id }, deps).ok).toBe(true);
  });

  test("settling a run keeps the board for the grace, without the run's pid", () => {
    const home = tempHome();
    const deps = fakeDeps();
    deps.alivePids.add(77);
    take(home, { mac: MAC_A, holder: "soak", purpose: "power cuts", pid: 77 }, deps);
    deps.advanceMinutes(25);
    expect(settle(home, MAC_A, "soak", 10, deps)?.expires).toBe("2026-10-05T20:05:00.000Z");
    deps.kill(77);
    expect(liveLease(home, MAC_A, deps)?.holder).toBe("soak");
    expect(readLease(home, MAC_A)?.pid).toBeUndefined();
    deps.advanceMinutes(10);
    expect(liveLease(home, MAC_A, deps)).toBeUndefined();
  });

  test("settling with no grace drops the lease; settling someone else's does nothing", () => {
    const home = tempHome();
    const deps = fakeDeps();
    take(home, { mac: MAC_A, holder: "soak", purpose: "" }, deps);
    expect(settle(home, MAC_A, "other", 10, deps)).toBeUndefined();
    expect(liveLease(home, MAC_A, deps)?.holder).toBe("soak");
    settle(home, MAC_A, "soak", 0, deps);
    expect(readLease(home, MAC_A)).toBeUndefined();
  });
});
