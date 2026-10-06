/**
 * What `espflash board-info` says a board is. Running it resets the board, so
 * callers only run it on a board that is free or theirs.
 */

export interface BoardInfo {
  chip?: string;
  revision?: string;
  flash?: string;
  mac?: string;
}

export function parseBoardInfo(text: string): BoardInfo {
  const field = (label: string) => new RegExp(`^${label}:\\s+(.+?)\\s*$`, "m").exec(text)?.[1];
  const chipLine = field("Chip type");
  const chip = chipLine ? /^(\S+)(?: \(revision (\S+)\))?/.exec(chipLine) : null;
  const flash = field("Flash size");
  const mac = field("MAC address");
  return {
    ...(chip?.[1] ? { chip: chip[1] } : {}),
    ...(chip?.[2] ? { revision: chip[2] } : {}),
    ...(flash ? { flash } : {}),
    ...(mac ? { mac: mac.toUpperCase() } : {}),
  };
}
