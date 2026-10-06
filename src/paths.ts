import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where the desk's files live: `$BOARD_HOME`, else `~/.photomancer/desk`.
 * The repo never holds any of them.
 */
export function boardHome(env: Record<string, string | undefined> = process.env): string {
  const fromEnv = env.BOARD_HOME;
  return fromEnv && fromEnv.length > 0 ? fromEnv : join(homedir(), ".photomancer", "desk");
}

export const registryPath = (home: string) => join(home, "boards.toml");
export const leasesDir = (home: string) => join(home, "leases");
export const leasePath = (home: string, mac: string) => join(leasesDir(home), `${mac}.json`);
export const lineDir = (home: string, mac: string) => join(home, "waiting", mac);
export const imagesDir = (home: string) => join(home, "images");
export const lockDir = (home: string) => join(home, ".lock");
