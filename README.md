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
board take fixture-c6 --as "direct: ota" --for "power-cut soak"   # 30 min; prints the port
board take fixture-c6 --as "direct: wifi" --for "scan" --wait   # join the line instead of being refused
board run fixture-c6 --as "direct: ota" --for "soak" -- ./soak.sh   # hold it for the whole run, + 10 min grace
board renew fixture-c6 --as "direct: ota" --minutes 60
board drop fixture-c6 --as "direct: ota"
board check /dev/cu.usbmodem112401 --as me       # what a flasher asks first (exit codes below)
board power-cycle fixture-c6 --as "direct: ota"   # prints the port it came back on; non-zero if the hub did not switch
board add --port /dev/cu.usbmodem2101 --slug c6-oak --mark OAK   # probes with espflash, registers
board set c6-oak role=art lp_project=catalog/projects/playful-choker
board serve                                      # http://127.0.0.1:4380/
```

A board can be named by slug, mark, MAC, or `/dev` path. **Who you are** comes
from `--as`, else `$BOARD_HOLDER`, and nowhere else: use your whole session
name, colons and all (`direct: wifi`). `take` and `run` refuse without one.
`--for` is only why, free text. (It once also carried the holder, split at the
first colon, which made `direct: ota` and `direct: wifi` the same holder
`direct`.)

`board check` exit codes, which other tools read: `0` free or yours, `3` held
by someone else, `4` an art board you have not taken, `5` no such board.
A registered chip that disagrees with a probe (`--chip`) prints
`⚠️ MISMATCH` — the warning that would have caught "the C6 on port 1" being an S3.

A lease ends when it expires (30 min by default, 4 h at most), when it is
dropped, or — if it was taken with `--pid N` — when that process dies,
whichever comes first. There is no grace after the process: the board is free
the moment it exits.

**For a long run, use `board run`** instead:

```bash
board run fixture-c6 --as "direct: ota" --for "power-cut soak" --grace 15 -- scripts/ota/hw-power-cut.py …
```

It holds the board for as long as the command runs (renewing every minute, so
a three-hour soak never expires mid-run), then keeps it yours for the grace
(default 10 min) so you can look at what the run left behind before anyone in
line gets it; `board drop` frees it sooner. The command gets `BOARD_HOLDER`
(so a `just` recipe inside passes its own lease check) and `BOARD_DEV` (the
board's port). The exit code is the command's. If `board run` itself is
killed hard, the lease frees at once.

## The page

`board serve` serves one page on `127.0.0.1:4380`: every board as a card with
its picture, mark and slug, role, who holds it and why and for how long, and
who is waiting. Take, release, take back, power-cycle and edit. It follows the
system's light or dark theme (`?theme=light|dark` pins one) and works at phone
width. It acts as `yona (page)`.

### Keeping it running

On the desk the page runs as a launchd user agent, so no session owns it:

```bash
just service-install     # start at login, restart if it dies; waits until the page answers
just service status      # loaded? pid? does the page answer?
just service logs        # follow $BOARD_HOME/log/serve.log
just service-uninstall
```

The agent runs the installed binary (`~/.local/bin/board`), never a checkout,
and `just install` restarts it, so it always serves the binary just built.
`service-install` refuses while a hand-run `board serve` holds the port.

## The files

Everything lives in `$BOARD_HOME` (default `~/.photomancer/desk`), never in
this repo:

| Path | What |
|---|---|
| `boards.toml` | the registry. Hand-edit it freely; `board set`, `add` and the page rewrite it **and drop comments** |
| `leases/<MAC>.json` | one live lease per board |
| `waiting/<MAC>/<id>.json` | the line for a board |
| `images/<MAC>.board.svg`, `<MAC>.art.svg` | pictures, written by whoever can draw them (LightPlayer's `lp-cli hardware desk-images`); an entry's `image` names a photo instead |
| `log/serve.log` | the page service's output |
| `hub-ports.json` | where each board was last seen on a hub, and the hub's twin, so `power-on` finds a board that is off. A twin once seen is kept: delete the board's entry if its hub really has no twin any more |
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

### When it cannot, it fails

`power-cycle`, `power-off` and `power-on` exit non-zero, with one line naming
the board, the hub and why, whenever the hub cannot be shown to have switched
the board's power. Nothing is reported as done that the hub did not confirm:

| What uhubctl shows | What `board` says |
|---|---|
| the hub's line ends `ganged` or `nops`, not `ppps` | the hub does not support per-port power switching; nothing is switched |
| the hub is not listed at all (uhubctl lists only `ppps` hubs; a `ganged` one shows up only as a device on its parent's port, which is where `board` reads its mode) | the same, or "uhubctl does not list that hub"; nothing is switched |
| the twin is not listed, though the board was once seen with one | the twin cannot be switched, and switching one half leaves VBUS up; nothing is switched |
| the port the board was last seen on has power and someone else (or nothing) on it | the board is not there; nothing is switched, so nobody else's port is cut |
| after off, a switched port (either twin) still reads `power` | power did not drop: the hub does not really switch this port |
| after off, the ports read off but the board is still on the hub | power did not drop: a twin not switched, or the board is powered another way |
| after on, a switched port still reads `off` | the hub did not switch the port back on |

A failed `power-off` or `power-cycle` switches back on what it switched off
before it reports, so a failure leaves the port as it found it.

### When uhubctl hangs

uhubctl can hang on its way out: during a desk sitting a `uhubctl -a on` sat 47
minutes deadlocked inside `libusb_exit` (libusb's macOS hotplug thread), after
the port had switched, and `board power-cycle` waited on it, silent. Now every
uhubctl run (the listing and each switch) gets **20 s**
(`$BOARD_UHUBCTL_TIMEOUT_MS` overrides it). Past that the child is killed,
SIGTERM then SIGKILL, and `board` waits for it to be gone: it never leaves one
running. (Not Bun's own `timeout` option: Bun 1.1.18 ignores it.)

A killed uhubctl's exit says nothing about whether it switched, so `board`
does not trust it and reads the port back from a fresh listing, itself timed,
as it does after every switch:

| What the hub shows after the hang | What `board` says |
|---|---|
| the port switched as asked | success, plus one warning line: `⚠️ <board>: uhubctl hung for 20 s switching hub <hub> port <n> on and was killed; the hub shows the port on, so the switch took effect` |
| the port did not switch | the usual failure (non-zero, names the board, hub and port), led by `uhubctl hung for 20 s switching …` |
| nothing: the listing hangs too | failure: `the hub's ports could not be read back: uhubctl hung for 20 s and was killed` |

What uhubctl cannot show: a hub that marks itself `ppps`, reports the port
off and empty, and keeps VBUS up anyway. That reads as a good cycle. The only
witness left is the board itself (did it reboot?), which `board` does not ask.

## Development

```bash
just check          # bun test + tsc
```

Tests run against `test/fixtures/desk/` (real desk output, MACs replaced by
made-up ones) through `BOARD_FAKE_DESK=<dir>`. A test makes uhubctl hang by
writing `hangs-power.txt` there (see `fixtureDesk`), and shortens the wait
with `$BOARD_UHUBCTL_TIMEOUT_MS`, as `$BOARD_SETTLE_MS` and `$BOARD_LEAVE_MS`
shorten the others. **No real desk data in this
repo**: it is public, and the desk's facts belong to the desk.

## License

MIT — see [LICENSE](LICENSE).
