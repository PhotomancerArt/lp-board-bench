/**
 * One mutex for every read-modify-write of the desk's files: a directory,
 * because `mkdir` either creates it or fails with EEXIST, atomically, on every
 * filesystem this runs on.
 *
 * The holder writes `owner.json` ({pid, at}) inside it. A lock whose owner is
 * dead, or that is older than STALE_MS, is broken: renamed aside and removed.
 * Holders keep it for microseconds, so a stale one means a crash.
 *
 * This is a courtesy lock between cooperating tools, not security.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Deps } from "./deps.ts";
import { lockDir } from "./paths.ts";

export const STALE_MS = 10_000;
const WAIT_MS = 5_000;

export class LockTimeout extends Error {}

export function withLock<T>(home: string, deps: Deps, body: () => T): T {
  const dir = lockDir(home);
  mkdirSync(home, { recursive: true });
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    if (tryAcquire(dir, deps)) break;
    if (isStale(dir, deps)) {
      breakLock(dir);
      continue;
    }
    if (Date.now() > deadline) {
      throw new LockTimeout(`the desk lock ${dir} has been held for over ${WAIT_MS / 1000} s`);
    }
    Bun.sleepSync(5 + Math.random() * 20);
  }
  try {
    return body();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface Owner {
  pid: number;
  at: string;
}

function tryAcquire(dir: string, deps: Deps): boolean {
  try {
    mkdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
  const owner: Owner = { pid: process.pid, at: deps.now().toISOString() };
  writeFileSync(join(dir, "owner.json"), JSON.stringify(owner));
  return true;
}

function isStale(dir: string, deps: Deps): boolean {
  const owner = readOwner(dir);
  if (owner) {
    if (!deps.alive(owner.pid)) return true;
    return deps.now().getTime() - Date.parse(owner.at) > STALE_MS;
  }
  // Created but owner.json not written yet (or the lock just went away):
  // judge by the directory's own age.
  try {
    return Date.now() - statSync(dir).mtimeMs > STALE_MS;
  } catch {
    return false;
  }
}

function readOwner(dir: string): Owner | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, "owner.json"), "utf8")) as Owner;
  } catch {
    return undefined;
  }
}

function breakLock(dir: string): void {
  const aside = `${dir}.stale-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    renameSync(dir, aside);
  } catch {
    return; // someone else broke it first
  }
  rmSync(aside, { recursive: true, force: true });
}
