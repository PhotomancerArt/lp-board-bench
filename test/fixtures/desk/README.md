# Desk fixtures

Captured on the maintainer's desk on 2026-10-05 (macOS 26, uhubctl 2.6, espflash
3.3.0) and scrubbed: every board MAC is replaced by a made-up, locally
administered one (02:00:00:00:00:0N), other serial numbers by `SN-FIXTURE`,
and personal device names by placeholders.

| File | Source |
|---|---|
| `system_profiler.json` | `system_profiler SPUSBHostDataType -json`, pruned to the hubs, boards and billboards |
| `uhubctl.txt` | `uhubctl` with no arguments |
| `uhubctl-ch-hub-between-twins.txt` | the same, 2026-10-23, after the boards moved behind a ganged CH hub (1a86:8095) on 1-1 port 3: its VIA hub 1-1.3.1 has USB 3 twin 1-2.3. A keyboard's name and serial are replaced |
| `dev.txt` | `ls /dev/cu.*` |
| `espflash-board-info-c6.txt` | an `espflash` 3.3.0 banner from a real ESP32-C6 sitting (2026-09-08) |
| `espflash-board-info-v3.txt` | the same banner's format for a classic ESP32 v3.1, written from that sitting's recorded fields |

Boards in them: 02:…:01 a C6 on hub 1-1.2 port 4, 02:…:02 an S3 on hub
1-1.2.3 port 2, a CH340 bridge (1a86:7522, no serial) on 1-1.2.3 port 3, and
02:…:03 a C6 on a non-switchable hub. In `uhubctl-ch-hub-between-twins.txt`:
02:…:05, 02:…:02 (the S3) and 02:…:06 on 1-1.3.1 ports 1, 2 and 4; 02:…:01 and
the CH340 on 1-1.3.1.3 ports 1 and 2.

Not captured: `ignores-power.txt`, which a test writes to make the fixture
desk's hubs at those paths take a power request and change nothing, and
`hangs-power.txt`, which makes a request hang the way a deadlocked uhubctl
does, so the timed run has a child to kill (see `fixtureDesk` in
`src/desk/desk.ts`).
