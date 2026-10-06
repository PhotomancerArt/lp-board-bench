# lp-board-bench — `just` with no arguments lists the recipes.

default:
    @just --list

# Tests and the typecheck — what CI runs.
check:
    bun test
    bunx tsc --noEmit

test *args:
    bun test {{args}}

# Build `board` as one binary into ~/.local/bin (on the desk's PATH).
install:
    bun build --compile src/cli.ts --outfile ~/.local/bin/board
