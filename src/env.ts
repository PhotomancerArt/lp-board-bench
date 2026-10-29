/**
 * The tool's settings from the environment: `LP_BENCH_<NAME>`, else the
 * `BOARD_<NAME>` it read before it was renamed from `board`. The old names
 * stay honored for good: shells, `just` recipes and lp-cli still set them.
 * Empty counts as unset.
 */
export type Env = Record<string, string | undefined>;

export function benchEnv(name: string, env: Env = process.env): string | undefined {
  for (const key of [`LP_BENCH_${name}`, `BOARD_${name}`]) {
    const value = env[key];
    if (value !== undefined && value.length > 0) return value;
  }
  return undefined;
}

/** `name` set under both prefixes, for a child that may read either. */
export function bothNames(name: string, value: string): Env {
  return { [`LP_BENCH_${name}`]: value, [`BOARD_${name}`]: value };
}
