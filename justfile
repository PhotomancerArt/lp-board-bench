# lp-board-bench — `just` with no arguments lists the recipes.

default:
    @just --list

# Tests and the typecheck — what CI runs.
check:
    bun test
    bunx tsc --noEmit

test *args:
    bun test {{args}}

# Build `lp-bench` as one binary into ~/.local/bin (on the desk's PATH), with
# `board` (its old name) linked to it while callers move over, and re-render
# and restart the desk page if it runs as a service, so it serves the new binary.
install:
    bun build --compile src/cli.ts --outfile ~/.local/bin/lp-bench
    ln -sf lp-bench ~/.local/bin/board
    @if launchctl print "gui/$(id -u)/com.photomancer.board-bench" >/dev/null 2>&1; then service/service.sh install; fi

# The desk page as a launchd service: start at login, restart if it dies.
service-install:
    service/service.sh install

service-uninstall:
    service/service.sh uninstall

# status | restart | logs
service *args:
    service/service.sh {{ args }}
