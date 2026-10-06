# lp-board-bench

`board`: who has which dev board, and what each board is for, on a desk where
several people and AI agents share USB boards on switchable hubs.

- **A registry** of every board: a slug everyone says (`fixture-c6`), a short
  mark written on the chip in sharpie (`FC6`), its MAC, chip, role (`test`,
  `fixture`, `dev`, `art`), notes, and a picture.
- **Short leases.** An agent takes a board for 30 minutes before flashing or
  power-cycling it. Anyone else is refused, told who has it, why, and for how
  long. They can wait in line instead.
- **Power cycling** through switchable hubs (`uhubctl`), both halves of a
  USB 2 + USB 3 "twin" hub at once, refused on a board someone else holds.
- **A local page** (`board serve`) showing all of it, with buttons.

It is a courtesy lock between cooperating tools, not security. Built for
[LightPlayer](https://github.com/PhotomancerArt/lightplayer)'s desk, which
calls it before every flash, but it knows nothing about LightPlayer.

## Install

Needs [Bun](https://bun.sh) (1.1.18 or later). On macOS, `uhubctl` for power
and `espflash` for `add` / `verify`.

```bash
bun install
just install        # builds one binary: ~/.local/bin/board
```

## Using it

```bash
board list                                       # every board: mark, slug, role, port, hub, holder, the line
board take fixture-c6 --for "ota-director: power-cut soak"   # 30 min; prints the port
board take fixture-c6 --for "wifi: scan" --wait  # join the line instead of being refused
board renew fixture-c6 --as ota-director --minutes 60
board drop fixture-c6 --as ota-director
board check /dev/cu.usbmodem112401 --as me       # what a flasher asks first (exit codes below)
board power-cycle fixture-c6 --as ota-director
board add --port /dev/cu.usbmodem2101 --slug c6-oak --mark OAK   # probes with espflash, registers
board set c6-oak role=art lp_project=catalog/projects/playful-choker
board serve                                      # http://127.0.0.1:4380/
```

A board can be named by slug, mark, MAC, or `/dev` path. Who you are comes
from `--as`, else `$BOARD_HOLDER`; `take` uses the `<who>` of
`--for "<who>: <why>"`.

`board check` exit codes, which other tools read: `0` free or yours, `3` held
by someone else, `4` an art board you have not taken, `5` no such board.
A registered chip that disagrees with a probe (`--chip`) prints
`⚠️ MISMATCH` — the warning that would have caught "the C6 on port 1" being an S3.

A lease ends when it expires, when it is dropped, or — if it was taken with
`--pid N` — when that process dies. Long-running scripts pass their own pid.

## The page

`board serve` serves one page on `127.0.0.1:4380`: every board as a card with
its picture, mark and slug, role, who holds it and why and for how long, and
who is waiting. Take, release, take back, power-cycle and edit. It follows the
system's light or dark theme (`?theme=light|dark` pins one) and works at phone
width. It acts as `yona (page)`.

## The files

Everything lives in `$BOARD_HOME` (default `~/.photomancer/desk`), never in
this repo:

| Path | What |
|---|---|
| `boards.toml` | the registry. Hand-edit it freely; `board set`, `add` and the page rewrite it **and drop comments** |
| `leases/<MAC>.json` | one live lease per board |
| `waiting/<MAC>/<id>.json` | the line for a board |
| `images/<MAC>.board.svg`, `<MAC>.art.svg` | pictures, written by whoever can draw them (LightPlayer's `lp-cli hardware desk-images`); an entry's `image` names a photo instead |
| `hub-ports.json` | where each board was last seen on a hub, so `power-on` finds a board that is off |
| `.lock/` | the mutex every read-modify-write takes |

Writes are a temp file plus a rename, under the lock, so a reader never sees
half a file and two agents racing for one board cannot both win.

## How power cycling knows

A USB 2 + USB 3 hub (the VIA VL817 here) is two hubs on one chip, and VBUS
drops only when both have the port off: `board` finds the twin (same path under
the other root port, same vendor) and switches both.

macOS does not notice a port being switched off: it keeps listing the device,
and its `/dev` node, until power comes back. So `board` trusts the hub, not the
host: off is confirmed by the hub reporting the port empty, and back by the hub
seeing the board again plus a short settle for the host to re-enumerate.

## Development

```bash
just check          # bun test + tsc
```

Tests run against `test/fixtures/desk/` (real desk output, MACs replaced by
made-up ones) through `BOARD_FAKE_DESK=<dir>`. **No real desk data in this
repo**: it is public, and the desk's facts belong to the desk.

## License

MIT — see [LICENSE](LICENSE).
