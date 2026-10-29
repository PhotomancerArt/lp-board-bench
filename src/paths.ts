import { homedir } from "node:os";
import { join } from "node:path";

import { benchEnv, type Env } from "./env.ts";

/**
 * Where the desk's files live: `$LP_BENCH_HOME` (or `$BOARD_HOME`), else
 * `~/.photomancer/desk`. The repo never holds any of them.
 */
export function benchHome(env: Env = process.env): string {
  return benchEnv("HOME", env) ?? join(homedir(), ".photomancer", "desk");
}

export const registryPath = (home: string) => join(home, "boards.toml");
export const leasesDir = (home: string) => join(home, "leases");
export const leasePath = (home: string, mac: string) => join(leasesDir(home), `${mac}.json`);
export const lineDir = (home: string, mac: string) => join(home, "waiting", mac);
export const imagesDir = (home: string) => join(home, "images");
export const hubTwinsPath = (home: string) => join(home, "hub-twins.toml");
export const lockDir = (home: string) => join(home, ".lock");
