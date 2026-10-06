# AGENTS.md — lp-board-bench

`board` keeps a desk's board registry, short leases, the line for each board,
hub power, and a local page. Read `README.md` first; this file is the rules.

## Using the desk (any repo, any agent)

- **Lease before you flash, probe, reset or power-cycle a board**:
  `board take <slug> --for "<who>: <why>"` (or `board run <slug> --for … -- <cmd>`
  for a long run). Drop it when done. A refusal names
  the holder: wait (`--wait`), or ask them; never work around it.
- **Say `MARK slug`** (`FC6 fixture-c6`) when you talk about a board, and
  identify boards by MAC + chip, never by hub port or `/dev` name — both move.
- Power goes through `board power-*` only. Never hand-run `uhubctl` against a
  board you do not hold.

## Working on this repo

- **No desk data in the repo.** It is public. Real MACs, art-piece names and
  desk notes live in `$BOARD_HOME`. Fixtures use made-up, locally administered
  MACs (`02:00:00:00:00:0N`); scrub any new capture the same way.
- **Zero runtime dependencies.** Bun gives the server, the TOML parser and the
  single-binary build. Dev dependencies (typescript, bun types) only.
- **The core takes its effects injected**: clock and pid liveness (`Deps`), the
  desk (`Desk`: presence, hubs, espflash, power). Tests never sleep for an
  expiry and never touch real hardware; `BOARD_FAKE_DESK=<dir>` runs the CLI
  over fixtures.
- **The page has no logic the CLI lacks.** Its endpoints call the same
  functions; add a feature to the core first.
- **`board list --json` is read by other tools** (LightPlayer's lp-cli). Only
  ever add fields. `board check`'s exit codes are a contract too.
- **Hardware truths are measured, then written down** (README "How power
  cycling knows"): the hub is the witness for power, not the host.
- One concept per file, named for it (`lease.ts`, `desk/hubs.ts`). Tests sit
  beside the code as `*.test.ts`: test cases first, helpers at the bottom.
- Bun is pinned to the desk's version in CI (1.1.18). Its TOML parser reads
  `\t` back as a form feed, so the writer emits tabs as `\u0009`; check such
  quirks against the pinned version before upgrading.
- `just check` before pushing. Small commits that tell the story.

## Planning

Plans live in the shared planning workspace (`agent-context.toml`:
`~/.photomancer/planning/lp-board-bench/`), not in this repo.
