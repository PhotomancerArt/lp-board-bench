import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Deps } from "../src/deps.ts";

/** A clock you move by hand and a set of pids that count as running. */
export interface FakeDeps extends Deps {
  advanceMinutes(minutes: number): void;
  kill(pid: number): void;
  alivePids: Set<number>;
}

export function fakeDeps(start = "2026-10-05T19:30:00Z"): FakeDeps {
  let now = Date.parse(start);
  const alivePids = new Set<number>([process.pid]);
  return {
    now: () => new Date(now),
    alive: (pid) => alivePids.has(pid),
    advanceMinutes(minutes) {
      now += minutes * 60_000;
    },
    kill(pid) {
      alivePids.delete(pid);
    },
    alivePids,
  };
}

export function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "board-test-"));
}

/** Made-up, locally administered MACs — never a real desk's. */
export const MAC_A = "02:00:00:00:00:01";
export const MAC_B = "02:00:00:00:00:02";
