/**
 * Which USB serial devices are plugged in, read from macOS's
 * `system_profiler SPUSBHostDataType -json` (0.1 s; `SPUSBDataType` is empty
 * on macOS 26). Pure: give it the JSON and the `/dev/cu.*` names.
 */

export interface UsbDevice {
  name: string;
  /** Lowercase hex, `303a`. */
  vid: string;
  pid: string;
  /** The USB serial number; on Espressif native USB this is the MAC. */
  serial?: string;
  locationId: number;
  /** The `/dev/cu.*` node, when exactly one matches the location. */
  port?: string;
}

/** USB BillBoard devices (USB-C alt-mode notices) have serial ports but are never boards. */
const IGNORED_VENDORS = new Set(["3679", "2109"]);

export function parseSystemProfiler(json: unknown, devNodes: string[]): UsbDevice[] {
  const devices: UsbDevice[] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    const item = node as Record<string, unknown>;
    const vid = hex(item.USBDeviceKeyVendorID);
    const pid = hex(item.USBDeviceKeyProductID);
    const location = typeof item.USBKeyLocationID === "string" ? Number.parseInt(item.USBKeyLocationID, 16) : NaN;
    if (vid && pid && Number.isFinite(location) && !IGNORED_VENDORS.has(vid)) {
      const port = portForLocation(location, devNodes);
      if (port) {
        const serial = item.USBDeviceKeySerialNumber;
        devices.push({
          name: typeof item._name === "string" ? item._name : "",
          vid,
          pid,
          ...(typeof serial === "string" && serial !== "Not Provided" && serial !== "" ? { serial } : {}),
          locationId: location,
          port,
        });
      }
    }
    for (const value of Object.values(item)) if (typeof value === "object") walk(value);
  };
  walk(json);
  return devices.sort((a, b) => a.locationId - b.locationId);
}

/**
 * macOS names a USB serial node after the device's location: the location in
 * hex with its trailing zeros stripped, then a one- or two-digit interface
 * suffix — 0x01123200 → `usbmodem1123201`, 0x01123300 → `wchusbserial112330`.
 * Returns a node only when exactly one fits; a guess would be a flash onto
 * the wrong board.
 */
export function portForLocation(locationId: number, devNodes: string[]): string | undefined {
  const stem = locationId.toString(16).replace(/0+$/, "");
  if (!stem) return undefined;
  const matches = devNodes.filter((node) => {
    const tail = /^\/dev\/cu\.[A-Za-z_-]+?([0-9a-f]+)$/.exec(node)?.[1];
    return tail !== undefined && tail.startsWith(stem) && /^\d{1,2}$/.test(tail.slice(stem.length));
  });
  return matches.length === 1 ? matches[0] : undefined;
}

export function vidPid(device: Pick<UsbDevice, "vid" | "pid">): string {
  return `${device.vid}:${device.pid}`;
}

function hex(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^0x([0-9a-fA-F]{1,4})/.exec(value.trim());
  return match ? match[1]!.toLowerCase().padStart(4, "0") : undefined;
}
