/**
 * Running a desk tool that may never return. uhubctl can deadlock on its way
 * out (inside `libusb_exit`, in libusb's macOS hotplug thread: one
 * `uhubctl -a on` sat there 47 minutes, after the port had switched), so a
 * run gets a deadline, and a child past it is killed: SIGTERM, then SIGKILL,
 * and the run returns only once the child has exited.
 *
 * This is not `Bun.spawnSync`'s `timeout` option, because Bun 1.1.18 (the
 * desk's) ignores it: `spawnSync(["sleep", "30"], { timeout: 1000 })` returns
 * after 30 s. `Bun.spawn` and `node:child_process` ignore theirs too.
 */
import { DeskError } from "./desk_error.ts";

/** How long a uhubctl run gets. `$BOARD_UHUBCTL_TIMEOUT_MS` overrides it. */
export const uhubctlTimeoutMs = () => Number(process.env.BOARD_UHUBCTL_TIMEOUT_MS ?? 20_000);

/** How long a child gets to exit on SIGTERM before SIGKILL. */
const KILL_GRACE_MS = 2_000;

/** How long a child gets to exit on SIGKILL before the run gives up on it. */
const REAP_MS = 5_000;

/**
 * A child that ran past its deadline. It was killed, so its exit says
 * nothing about whether it did its job; `stillRunning` holds its pid when
 * not even SIGKILL ended it.
 */
export class HungError extends DeskError {
  constructor(
    readonly command: string,
    readonly seconds: number,
    readonly stillRunning?: number,
  ) {
    super(`${command} hung for ${seconds} s and ${HungError.describe(stillRunning)}`);
  }

  /** "was killed", or that it could not be. */
  get outcome(): string {
    return HungError.describe(this.stillRunning);
  }

  private static describe(stillRunning: number | undefined): string {
    return stillRunning === undefined ? "was killed" : `could not be killed (pid ${stillRunning} is still running)`;
  }
}

export interface TimedRunOptions {
  timeoutMs: number;
  /** SIGTERM to SIGKILL. */
  graceMs?: number;
  /** Shown in errors in place of the command line (the fixture desk's stand-in names the uhubctl it plays). */
  label?: string;
}

/** The child's stdout. Throws a `HungError` past the deadline, a `DeskError` on a non-zero exit. */
export async function timedRun(cmd: string[], options: TimedRunOptions): Promise<string> {
  const label = options.label ?? cmd.join(" ");
  const child = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();

  const exited = await within(child.exited, options.timeoutMs);
  if (exited === undefined) {
    child.kill("SIGTERM");
    if ((await within(child.exited, options.graceMs ?? KILL_GRACE_MS)) === undefined) {
      child.kill("SIGKILL");
      if ((await within(child.exited, REAP_MS)) === undefined) {
        throw new HungError(label, seconds(options.timeoutMs), child.pid);
      }
    }
    throw new HungError(label, seconds(options.timeoutMs));
  }
  const out = await stdout;
  if (exited !== 0) {
    throw new DeskError(`${label} exited ${exited}: ${((await stderr) || out).trim().slice(-400)}`);
  }
  return out;
}

/** The promise's value, or undefined if it has not settled within `ms`. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}

function seconds(ms: number): number {
  return Math.round(ms / 100) / 10;
}
