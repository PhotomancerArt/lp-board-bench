import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { tempHome } from "../test/fake_deps.ts";
import { leasesDir } from "./paths.ts";

describe("racing for one board", () => {
  test("eight real processes taking at once: exactly one wins, twenty times over", async () => {
    for (let round = 0; round < 20; round += 1) {
      const home = tempHome();
      const script = join(import.meta.dir, "..", "test", "race_take.ts");
      const contenders = Array.from({ length: 8 }, (_, n) =>
        Bun.spawn([process.execPath, script, String(n)], { env: { ...process.env, BOARD_HOME: home } }),
      );
      const codes = await Promise.all(contenders.map((child) => child.exited));
      expect(codes.filter((code) => code === 0)).toHaveLength(1);
      expect(codes.filter((code) => code === 3)).toHaveLength(7);
      const files = readdirSync(leasesDir(home)).filter((name) => !name.includes(".tmp-"));
      expect(files).toHaveLength(1);
      const lease = JSON.parse(readFileSync(join(leasesDir(home), files[0]!), "utf8"));
      expect(lease.holder).toStartWith("contender-");
    }
  }, 60_000);
});
