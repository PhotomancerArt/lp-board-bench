/**
 * `board check`: what a flasher or a power switch asks before touching a
 * board. Exit codes are the contract other tools (lp-cli) read:
 *
 *   0  free, or yours            3  held by someone else
 *   4  an art board you don't hold   5  no such board / not on the bus
 */
import type { Deps } from "./deps.ts";
import { describeLease } from "./lease.ts";
import { resolveRef, viewName, type BoardView, type DeskState } from "./state.ts";

export const EXIT = { ok: 0, error: 1, held: 3, art: 4, unknown: 5 } as const;

export interface Verdict {
  code: (typeof EXIT)[keyof typeof EXIT];
  /** One line saying why, for stderr. */
  message: string;
  /** Loud lines that do not change the code (a chip mismatch). */
  warnings: string[];
  view?: BoardView;
}

export function checkBoard(
  state: DeskState,
  ref: string,
  who: string | undefined,
  probedChip: string | undefined,
  deps: Deps,
): Verdict {
  const view = resolveRef(state, ref);
  if (!view) return { code: EXIT.unknown, message: `no board matches "${ref}" (board list shows them)`, warnings: [] };
  const warnings = chipWarnings(view, probedChip);
  const name = viewName(view);
  const lease = view.lease;
  if (lease && lease.holder !== who) {
    return { code: EXIT.held, message: `${name} is ${describeLease(lease, deps)}`, warnings, view };
  }
  if (view.board?.role === "art" && !lease) {
    return {
      code: EXIT.art,
      message: `${name} is an art piece; take it on purpose first (board take ${view.board.slug} --for "<who>: <why>")`,
      warnings,
      view,
    };
  }
  if (lease) return { code: EXIT.ok, message: `${name} is yours (${describeLease(lease, deps)})`, warnings, view };
  const waiting = view.line.length > 0 ? `; ${view.line.length} waiting for it` : "";
  const note = view.mac ? `free (not leased — board take ${view.board?.slug ?? view.mac} to hold it)` : "free";
  return { code: EXIT.ok, message: `${name} is ${note}${waiting}`, warnings, view };
}

/** A registry chip that disagrees with what was probed is worth shouting about. */
export function chipWarnings(view: BoardView, probedChip: string | undefined): string[] {
  const listed = view.board?.chip;
  if (!probedChip || !listed) return [];
  if (sameChip(listed, probedChip)) return [];
  return [
    `⚠️ MISMATCH: ${viewName(view)} is registered as ${listed}, but the board answering says ${probedChip}. ` +
      `Stop and find out which board this really is.`,
  ];
}

function sameChip(a: string, b: string): boolean {
  const norm = (chip: string) => chip.toLowerCase().replace(/[^a-z0-9]/g, "");
  return norm(a) === norm(b);
}
