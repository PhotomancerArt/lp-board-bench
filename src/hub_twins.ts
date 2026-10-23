/**
 * `$BOARD_HOME/hub-twins.toml`: twins named by hand, for a hub tree the twin
 * rule (`findTwin` in `desk/hubs.ts`) cannot pair. Hand-written only; `board`
 * never rewrites it.
 *
 *     "1-1.3.1" = "1-2.3"     # this USB 2 hub's USB 3 twin
 *     "1-1.5" = "none"        # a hub that really has no twin
 */
import { existsSync, readFileSync } from "node:fs";

import type { TwinOverrides } from "./desk/hubs.ts";
import { hubTwinsPath } from "./paths.ts";

export class HubTwinsError extends Error {}

export function loadTwinOverrides(home: string): TwinOverrides {
  const path = hubTwinsPath(home);
  if (!existsSync(path)) return {};
  let parsed: Record<string, unknown>;
  try {
    parsed = Bun.TOML.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (err) {
    // Bun 1.1.18 cannot read an unquoted key like 1-1.4 at all.
    throw new HubTwinsError(`${path}: not valid TOML (quote each hub location: "1-1.3.1" = "1-2.3"): ${(err as Error).message}`);
  }
  const overrides: TwinOverrides = {};
  const problems: string[] = [];
  for (const [hub, twin] of Object.entries(parsed)) {
    if (!HUB_PATH.test(hub)) problems.push(`"${hub}" is not a uhubctl hub location (like "1-1.3.1")`);
    else if (typeof twin !== "string" || !(twin === "none" || HUB_PATH.test(twin))) {
      problems.push(`"${hub}" = ${JSON.stringify(twin)}: the twin must be a hub location or "none"`);
    } else overrides[hub] = twin;
  }
  if (problems.length > 0) throw new HubTwinsError(`${path}:\n  ${problems.join("\n  ")}`);
  return overrides;
}

const HUB_PATH = /^\d+-\d+(\.\d+)*$/;
