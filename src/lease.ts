/**
 * Leases: short, expiring claims on one board, in `leases/<MAC>.json`.
 *
 * A lease is live until it expires, or until the process it names (`pid`, set
 * only by long-running callers) dies. Taking, renewing and dropping run under
 * the desk lock; reading does not need it, because every write is a rename.
 */
import { readFileSync, rmSync } from "node:fs";
import { hostname } from "node:os";

import { atomicWrite } from "./atomic_write.ts";
import type { Deps } from "./deps.ts";
import { lineFor, leaveLineLocked, pruneLineLocked, type Waiter } from "./waiting.ts";
import { withLock } from "./lock.ts";
import { leasePath } from "./paths.ts";

export const DEFAULT_MINUTES = 30;
export const MAX_MINUTES = 240;

export interface Lease {
  mac: string;
  holder: string;
  purpose: string;
  acquired: string;
  expires: string;
  pid?: number;
  host?: string;
}

export interface TakeRequest {
  mac: string;
  holder: string;
  purpose: string;
  minutes?: number;
  pid?: number;
  /** Set by a caller waiting in line: only the head of the line may take. */
  waiterId?: string;
}

export type TakeResult =
  | { ok: true; lease: Lease; renewed: boolean }
  | { ok: false; reason: "held"; lease: Lease }
  | { ok: false; reason: "line"; line: Waiter[] };

export class LeaseError extends Error {}

export function isLive(lease: Lease, deps: Deps): boolean {
  if (Date.parse(lease.expires) <= deps.now().getTime()) return false;
  if (lease.pid !== undefined && !deps.alive(lease.pid)) return false;
  return true;
}

/** The lease file as written, live or not. Unreadable counts as none. */
export function readLease(home: string, mac: string): Lease | undefined {
  try {
    return JSON.parse(readFileSync(leasePath(home, mac), "utf8")) as Lease;
  } catch {
    return undefined;
  }
}

export function liveLease(home: string, mac: string, deps: Deps): Lease | undefined {
  const lease = readLease(home, mac);
  return lease && isLive(lease, deps) ? lease : undefined;
}

export function take(home: string, request: TakeRequest, deps: Deps): TakeResult {
  if (!request.holder) throw new LeaseError('say who is taking it: --for "<who>: <why>"');
  return withLock(home, deps, () => {
    pruneLineLocked(home, request.mac, deps);
    const current = liveLease(home, request.mac, deps);
    if (current && current.holder !== request.holder) return { ok: false, reason: "held", lease: current };
    if (!current) {
      const line = lineFor(home, request.mac, deps);
      if (line.length > 0 && line[0]!.id !== request.waiterId) return { ok: false, reason: "line", line };
    }
    const now = deps.now();
    const pid = request.pid ?? current?.pid;
    const lease: Lease = {
      mac: request.mac,
      holder: request.holder,
      purpose: request.purpose || current?.purpose || "",
      acquired: current?.acquired ?? now.toISOString(),
      expires: expiry(now, request.minutes).toISOString(),
      ...(pid !== undefined ? { pid } : {}),
      host: hostname(),
    };
    atomicWrite(leasePath(home, request.mac), `${JSON.stringify(lease, null, 2)}\n`);
    if (request.waiterId) leaveLineLocked(home, request.mac, request.waiterId);
    return { ok: true, lease, renewed: current !== undefined };
  });
}

export function renew(
  home: string,
  mac: string,
  who: string | undefined,
  minutes: number | undefined,
  deps: Deps,
): Lease {
  return withLock(home, deps, () => {
    const current = liveLease(home, mac, deps);
    if (!current) throw new LeaseError("no live lease to renew — take it instead");
    if (current.holder !== who) {
      throw new LeaseError(`${describeLease(current, deps)}; renew as its holder (--as ${current.holder})`);
    }
    const lease = { ...current, expires: expiry(deps.now(), minutes).toISOString() };
    atomicWrite(leasePath(home, mac), `${JSON.stringify(lease, null, 2)}\n`);
    return lease;
  });
}

/**
 * End a run: the holder keeps the board for `graceMinutes` more, then it frees
 * itself. Drops the lease's pid, so the run's process ending does not end it.
 * A grace of 0 drops the lease. Only the holder may.
 */
export function settle(
  home: string,
  mac: string,
  who: string,
  graceMinutes: number,
  deps: Deps,
): Lease | undefined {
  return withLock(home, deps, () => {
    const current = readLease(home, mac);
    if (!current || current.holder !== who) return undefined;
    if (graceMinutes <= 0) {
      rmSync(leasePath(home, mac), { force: true });
      return undefined;
    }
    const { pid: _pid, ...rest } = current;
    const lease: Lease = { ...rest, expires: expiry(deps.now(), graceMinutes).toISOString() };
    atomicWrite(leasePath(home, mac), `${JSON.stringify(lease, null, 2)}\n`);
    return lease;
  });
}

/** Release a lease. Only its holder may, unless `force` (taking it back). */
export function drop(
  home: string,
  mac: string,
  who: string | undefined,
  force: boolean,
  deps: Deps,
): Lease | undefined {
  return withLock(home, deps, () => {
    const current = readLease(home, mac);
    if (!current) return undefined;
    if (isLive(current, deps) && current.holder !== who && !force) {
      throw new LeaseError(`${describeLease(current, deps)}; only its holder may drop it (or --force to take it back)`);
    }
    rmSync(leasePath(home, mac), { force: true });
    return current;
  });
}

/** `held by ota-director until 19:58 (in 23 min): power-cut soak` */
export function describeLease(lease: Lease, deps: Deps): string {
  const expires = new Date(lease.expires);
  const hh = String(expires.getHours()).padStart(2, "0");
  const mm = String(expires.getMinutes()).padStart(2, "0");
  const purpose = lease.purpose ? `: ${lease.purpose}` : "";
  return `held by ${lease.holder} until ${hh}:${mm} (${timeLeft(lease, deps)})${purpose}`;
}

export function timeLeft(lease: Lease, deps: Deps): string {
  const minutes = Math.ceil((Date.parse(lease.expires) - deps.now().getTime()) / 60_000);
  return minutes <= 1 ? "under a minute left" : `${minutes} min left`;
}

function expiry(now: Date, minutes: number | undefined): Date {
  const wanted = minutes ?? DEFAULT_MINUTES;
  if (!Number.isFinite(wanted) || wanted <= 0) throw new LeaseError(`--minutes must be positive, got ${wanted}`);
  return new Date(now.getTime() + Math.min(wanted, MAX_MINUTES) * 60_000);
}
