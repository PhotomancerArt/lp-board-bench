import { describe, expect, test } from "bun:test";

import { benchEnv, bothNames } from "./env.ts";

describe("settings from the environment", () => {
  test("LP_BENCH_ wins over the old BOARD_ name", () => {
    expect(benchEnv("HOLDER", { LP_BENCH_HOLDER: "direct: ota", BOARD_HOLDER: "direct: wifi" })).toBe("direct: ota");
  });

  test("the old BOARD_ name still works alone", () => {
    expect(benchEnv("HOME", { BOARD_HOME: "/desk" })).toBe("/desk");
  });

  test("empty counts as unset, under either name", () => {
    expect(benchEnv("HOLDER", { LP_BENCH_HOLDER: "", BOARD_HOLDER: "ota" })).toBe("ota");
    expect(benchEnv("HOLDER", { LP_BENCH_HOLDER: "", BOARD_HOLDER: "" })).toBeUndefined();
    expect(benchEnv("HOLDER", {})).toBeUndefined();
  });

  test("a child gets a value under both names", () => {
    expect(bothNames("DEV", "/dev/cu.usbmodem1")).toEqual({ LP_BENCH_DEV: "/dev/cu.usbmodem1", BOARD_DEV: "/dev/cu.usbmodem1" });
  });
});
