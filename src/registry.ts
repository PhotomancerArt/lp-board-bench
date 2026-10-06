/**
 * The registry: every board on the desk (and the art pieces that come and
 * go), in `$BOARD_HOME/boards.toml`. Hand-editable; `board` and the page
 * rewrite it under the desk lock.
 */
import { existsSync, readFileSync } from "node:fs";

import { atomicWrite } from "./atomic_write.ts";
import type { Deps } from "./deps.ts";
import { withLock } from "./lock.ts";
import { normalizeMac } from "./mac.ts";
import { registryPath } from "./paths.ts";
import { emitBoardTables, type TomlValue } from "./toml_write.ts";

export const ROLES = ["test", "fixture", "dev", "art"] as const;
export type Role = (typeof ROLES)[number];

export interface Board {
  /** kebab-case, unique: the name everyone says (`fixture-c6`). */
  slug: string;
  /** 2–4 of A-Z0-9, unique: written on the chip in sharpie (`FC6`). */
  mark: string;
  /** Uppercase, colon-separated. Leases key on it. */
  mac: string;
  role: Role;
  tags: string[];
  name?: string;
  chip?: string;
  flash?: string;
  board?: string;
  /** A LightPlayer board id; LightPlayer draws `images/<MAC>.board.svg` from it. */
  lp_board?: string;
  /** A LightPlayer project; LightPlayer draws `images/<MAC>.art.svg` from it. */
  lp_project?: string;
  /** An explicit picture (a photo of the piece): absolute, or relative to `images/`. */
  image?: string;
  /** vid:pid, for a USB bridge that reports no serial number. */
  usb?: string;
  usb_serial?: string;
  notes?: string;
  /** Keys this version does not know, kept so a rewrite never loses them. */
  extra: Record<string, TomlValue>;
}

const STRING_FIELDS = [
  "name",
  "chip",
  "flash",
  "board",
  "lp_board",
  "lp_project",
  "image",
  "usb",
  "usb_serial",
  "notes",
] as const;

/** The order fields are written in. */
const KEY_ORDER = ["slug", "mark", "mac", "name", "role", "tags", ...STRING_FIELDS.slice(1)] as const;

export class RegistryError extends Error {}

export function loadRegistry(home: string): Board[] {
  const path = registryPath(home);
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new RegistryError(`${path}: not valid TOML: ${(err as Error).message}`);
  }
  const tables = (parsed as { board?: unknown }).board ?? [];
  if (!Array.isArray(tables)) throw new RegistryError(`${path}: expected [[board]] tables`);
  const problems: string[] = [];
  const boards = tables.map((table, index) => fromTable(table, index, problems));
  problems.push(...duplicates(boards));
  if (problems.length > 0) throw new RegistryError(`${path}:\n  ${problems.join("\n  ")}`);
  return boards;
}

export function saveRegistry(home: string, boards: Board[]): void {
  const problems = boards.flatMap((board, index) => validate(board, index));
  problems.push(...duplicates(boards));
  if (problems.length > 0) throw new RegistryError(problems.join("\n"));
  atomicWrite(registryPath(home), emitBoardTables(boards.map(toEntries)));
}

/** Read, change and write the registry under the desk lock. */
export function editRegistry<T>(home: string, deps: Deps, edit: (boards: Board[]) => T): T {
  return withLock(home, deps, () => {
    const boards = loadRegistry(home);
    const result = edit(boards);
    saveRegistry(home, boards);
    return result;
  });
}

/**
 * Turn loosely-typed input (a form, a CLI's flags) into a board, or the list
 * of what is wrong with it.
 */
export function boardFromInput(input: Record<string, unknown>): { board?: Board; problems: string[] } {
  const problems: string[] = [];
  const board = fromTable(input, 0, problems);
  return problems.length > 0 ? { problems } : { board, problems };
}

/** A board's human handle: the mark and the slug together, `FC6 fixture-c6`. */
export function handle(board: Pick<Board, "mark" | "slug">): string {
  return `${board.mark} ${board.slug}`;
}

function fromTable(table: unknown, index: number, problems: string[]): Board {
  const raw = (typeof table === "object" && table !== null ? table : {}) as Record<string, unknown>;
  const where = `board #${index + 1}${typeof raw.slug === "string" ? ` (${raw.slug})` : ""}`;
  const str = (key: string): string | undefined => {
    const value = raw[key];
    if (value === undefined || value === "") return undefined;
    if (typeof value !== "string") {
      problems.push(`${where}: ${key} must be a string`);
      return undefined;
    }
    return value;
  };
  const tags = raw.tags ?? [];
  if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string")) {
    problems.push(`${where}: tags must be a list of strings`);
  }
  const macText = str("mac");
  const board: Board = {
    slug: str("slug") ?? "",
    mark: (str("mark") ?? "").toUpperCase(),
    mac: (macText && normalizeMac(macText)) ?? macText ?? "",
    role: (str("role") ?? "test") as Role,
    tags: Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === "string") : [],
    extra: {},
  };
  for (const key of STRING_FIELDS) {
    const value = str(key);
    if (value !== undefined) board[key] = value;
  }
  const known = new Set<string>(KEY_ORDER);
  for (const [key, value] of Object.entries(raw)) {
    if (known.has(key)) continue;
    if (isTomlValue(value)) board.extra[key] = value;
    else problems.push(`${where}: ${key} has a shape this registry cannot keep`);
  }
  problems.push(...validate(board, index));
  return board;
}

function validate(board: Board, index: number): string[] {
  const where = `board #${index + 1}${board.slug ? ` (${board.slug})` : ""}`;
  const problems: string[] = [];
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(board.slug)) {
    problems.push(`${where}: slug must be kebab-case (like fixture-c6), got "${board.slug}"`);
  }
  if (!/^[A-Z0-9]{2,4}$/.test(board.mark)) {
    problems.push(`${where}: mark must be 2–4 letters or digits (like FC6), got "${board.mark}"`);
  }
  if (!normalizeMac(board.mac)) problems.push(`${where}: mac must be six hex pairs, got "${board.mac}"`);
  if (!ROLES.includes(board.role)) problems.push(`${where}: role must be one of ${ROLES.join(", ")}, got "${board.role}"`);
  if (board.usb !== undefined && !/^[0-9a-f]{4}:[0-9a-f]{4}$/.test(board.usb)) {
    problems.push(`${where}: usb must be vid:pid in lowercase hex (like 1a86:7522), got "${board.usb}"`);
  }
  return problems;
}

function duplicates(boards: Board[]): string[] {
  const problems: string[] = [];
  const check = (what: string, key: (board: Board) => string) => {
    const seen = new Map<string, string>();
    for (const board of boards) {
      const value = key(board);
      if (!value) continue;
      const first = seen.get(value);
      if (first !== undefined) problems.push(`${what} "${value}" is used by both ${first} and ${board.slug}`);
      else seen.set(value, board.slug);
    }
  };
  check("mac", (board) => board.mac);
  check("slug", (board) => board.slug);
  check("mark", (board) => board.mark);
  return problems;
}

function toEntries(board: Board): Array<[string, TomlValue]> {
  const entries: Array<[string, TomlValue]> = [];
  for (const key of KEY_ORDER) {
    const value = board[key];
    if (value === undefined) continue;
    if (key === "tags" && board.tags.length === 0) continue;
    entries.push([key, value as TomlValue]);
  }
  for (const key of Object.keys(board.extra).sort()) entries.push([key, board.extra[key]!]);
  return entries;
}

function isTomlValue(value: unknown): value is TomlValue {
  return (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    (Array.isArray(value) && value.every((item) => typeof item === "string"))
  );
}
