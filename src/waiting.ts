/**
 * The line for a board: `waiting/<MAC>/<id>.json`, one file per waiter. The
 * waiter's pid is the waiting process itself, which stays alive while it
 * waits — so a waiter that crashed or was killed leaves the line on its own.
 *
 * Only the head of the line (the oldest live waiter) may take a freed board.
 */
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { atomicWrite } from "./atomic_write.ts";
import type { Deps } from "./deps.ts";
import { withLock } from "./lock.ts";
import { lineDir } from "./paths.ts";

export interface Waiter {
  id: string;
  mac: string;
  holder: string;
  purpose: string;
  since: string;
  pid: number;
}

export function joinLine(
  home: string,
  entry: Omit<Waiter, "id" | "since">,
  deps: Deps,
): Waiter {
  return withLock(home, deps, () => {
    const now = deps.now();
    const id = `${now.getTime().toString(36)}-${entry.pid}-${Math.random().toString(36).slice(2, 8)}`;
    const waiter: Waiter = { ...entry, id, since: now.toISOString() };
    atomicWrite(join(lineDir(home, entry.mac), `${id}.json`), `${JSON.stringify(waiter, null, 2)}\n`);
    return waiter;
  });
}

export function leaveLine(home: string, mac: string, id: string, deps: Deps): void {
  withLock(home, deps, () => leaveLineLocked(home, mac, id));
}

/** The live waiters for a board, oldest first. Needs no lock. */
export function lineFor(home: string, mac: string, deps: Deps): Waiter[] {
  return readLine(home, mac).filter((waiter) => deps.alive(waiter.pid));
}

/** Call with the desk lock held. */
export function leaveLineLocked(home: string, mac: string, id: string): void {
  rmSync(join(lineDir(home, mac), `${id}.json`), { force: true });
}

/** Remove waiters whose process is gone. Call with the desk lock held. */
export function pruneLineLocked(home: string, mac: string, deps: Deps): void {
  for (const waiter of readLine(home, mac)) {
    if (!deps.alive(waiter.pid)) leaveLineLocked(home, mac, waiter.id);
  }
}

function readLine(home: string, mac: string): Waiter[] {
  const dir = lineDir(home, mac);
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const waiters: Waiter[] = [];
  for (const name of names) {
    try {
      waiters.push(JSON.parse(readFileSync(join(dir, name), "utf8")) as Waiter);
    } catch {
      // a rename landing mid-read, or junk: not a waiter
    }
  }
  return waiters.sort((a, b) => a.since.localeCompare(b.since) || a.id.localeCompare(b.id));
}

