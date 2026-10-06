/**
 * Bun parses TOML but cannot write it. This emits exactly the registry's
 * shape: an array of `[[board]]` tables whose values are strings, booleans,
 * numbers or arrays of strings. Comments in a hand-edited file do not survive
 * a rewrite; the header says so.
 */

export const HEADER = [
  "# The desk's boards — read by `board` (github.com/PhotomancerArt/lp-board-bench).",
  "# Hand edits are fine; `board` and its page rewrite this file and drop comments.",
  "",
].join("\n");

export type TomlValue = string | boolean | number | string[];

export function emitBoardTables(tables: Array<Array<[string, TomlValue]>>): string {
  const blocks = tables.map((entries) =>
    ["[[board]]", ...entries.map(([key, value]) => `${emitKey(key)} = ${emitValue(value)}`)].join("\n"),
  );
  return `${HEADER}\n${blocks.join("\n\n")}\n`;
}

function emitKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : emitString(key);
}

function emitValue(value: TomlValue): string {
  if (typeof value === "string") return emitString(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`cannot write ${value} to TOML`);
    return String(value);
  }
  return `[${value.map(emitString).join(", ")}]`;
}

function emitString(text: string): string {
  let out = '"';
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    // Tab goes out as \u0009, never \t: Bun 1.1.18's parser reads \t back as a form feed.
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return `${out}"`;
}
