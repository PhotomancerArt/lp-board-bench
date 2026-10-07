import { describe, expect, test } from "bun:test";

import { DeskError, run } from "./desk.ts";

describe("desk commands", () => {
  test("run leaves the event loop free while the command runs", async () => {
    let ticked = false;
    setTimeout(() => (ticked = true), 10);
    expect(await run(["sh", "-c", "sleep 0.2; echo done"], 5_000)).toBe("done\n");
    expect(ticked).toBe(true);
  });

  test("a command that outlives its timeout is killed and named", async () => {
    const started = Date.now();
    await expect(run(["sleep", "5"], 100)).rejects.toThrow(new DeskError("sleep 5 timed out after 0.1 s: "));
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("a failing command says how it exited and what it printed", async () => {
    await expect(run(["sh", "-c", "echo nope >&2; exit 2"], 5_000)).rejects.toThrow("exited 2: nope");
  });
});
