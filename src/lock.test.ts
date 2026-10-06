import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { fakeDeps, tempHome } from "../test/fake_deps.ts";
import { withLock } from "./lock.ts";
import { lockDir } from "./paths.ts";

describe("the desk lock", () => {
  test("is released after the body, even when it throws", () => {
    const home = tempHome();
    const deps = fakeDeps();
    expect(withLock(home, deps, () => 7)).toBe(7);
    expect(() => withLock(home, deps, () => {
      throw new Error("boom");
    })).toThrow("boom");
    expect(existsSync(lockDir(home))).toBe(false);
  });

  test("a lock left by a dead process is broken", () => {
    const home = tempHome();
    const deps = fakeDeps();
    plantLock(home, 999_999, deps.now().toISOString());
    expect(withLock(home, deps, () => "got it")).toBe("got it");
  });

  test("a lock older than ten seconds is broken even if its owner lives", () => {
    const home = tempHome();
    const deps = fakeDeps();
    plantLock(home, process.pid, new Date(deps.now().getTime() - 11_000).toISOString());
    expect(withLock(home, deps, () => "got it")).toBe("got it");
  });

  test("a fresh lock held by a live process is waited on, then times out", () => {
    const home = tempHome();
    const deps = fakeDeps();
    plantLock(home, process.pid, deps.now().toISOString());
    expect(() => withLock(home, deps, () => "never")).toThrow("held for over 5 s");
  });
});

function plantLock(home: string, pid: number, at: string): void {
  mkdirSync(lockDir(home), { recursive: true });
  writeFileSync(join(lockDir(home), "owner.json"), JSON.stringify({ pid, at }));
}
