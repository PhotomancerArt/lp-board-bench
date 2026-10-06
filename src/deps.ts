/**
 * The effects the core needs from the outside world, injected so tests can
 * drive time and process liveness without sleeping or forking.
 */
export interface Deps {
  now(): Date;
  /** Whether a process with this pid is still running on this machine. */
  alive(pid: number): boolean;
}

export const realDeps: Deps = {
  now: () => new Date(),
  alive: pidAlive,
};

/** `kill(pid, 0)`: ESRCH means gone; EPERM means alive but not ours. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
