# Desk fixtures

Captured on the maintainer's desk on 2026-10-05 (macOS 26, uhubctl 2.6, espflash
3.3.0) and scrubbed: every board MAC is replaced by a made-up, locally
administered one (02:00:00:00:00:0N), other serial numbers by `SN-FIXTURE`,
and personal device names by placeholders.

| File | Source |
|---|---|
| `system_profiler.json` | `system_profiler SPUSBHostDataType -json`, pruned to the hubs, boards and billboards |
| `uhubctl.txt` | `uhubctl` with no arguments |
| `dev.txt` | `ls /dev/cu.*` |
| `espflash-board-info-c6.txt` | an `espflash` 3.3.0 banner from a real ESP32-C6 sitting (2026-09-08) |
| `espflash-board-info-v3.txt` | the same banner's format for a classic ESP32 v3.1, written from that sitting's recorded fields |

Boards in them: 02:…:01 a C6 on hub 1-1.2 port 4, 02:…:02 an S3 on hub
1-1.2.3 port 2, a CH340 bridge (1a86:7522, no serial) on 1-1.2.3 port 3, and
02:…:03 a C6 on a non-switchable hub.
