import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DeskError } from "./desk_error.ts";
import { HungError, timedRun } from "./timed_run.ts";

describe("timedRun", () => {
  test("returns the child's stdout when it exits in time", async () => {
    expect(await timedRun(["sh", "-c", "echo hello"], { timeoutMs: 5_000 })).toBe("hello\n");
  });

  test("a non-zero exit is an error with the exit code and what the child said", async () => {
    const run = timedRun(["sh", "-c", "echo 'No compatible devices detected!' >&2; exit 1"], { timeoutMs: 5_000, label: "uhubctl" });
    await expect(run).rejects.toThrow(new DeskError("uhubctl exited 1: No compatible devices detected!"));
  });

  test("a child past its deadline is killed with SIGTERM, and the run returns once it has exited", async () => {
    const started = Date.now();
    const err = await timedRun(["sleep", "60"], { timeoutMs: 200, label: "uhubctl -a on" }).catch((e) => e);
    expect(err).toBeInstanceOf(HungError);
    expect(err.message).toBe("uhubctl -a on hung for 0.2 s and was killed");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("a child that ignores SIGTERM gets SIGKILL after the grace, and is gone when the run returns", async () => {
    const pidFile = join(tmpdir(), `timed-run-${process.pid}-${Date.now()}`);
    const err = await timedRun(["sh", "-c", `echo $$ > ${pidFile}; trap '' TERM; exec sleep 60`], {
      timeoutMs: 200,
      graceMs: 200,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(HungError);
    expect((err as HungError).stillRunning).toBeUndefined();
    const pid = Number(await Bun.file(pidFile).text());
    expect(alive(pid)).toBe(false);
  });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
