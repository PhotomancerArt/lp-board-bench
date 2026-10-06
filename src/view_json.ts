/**
 * One board as JSON: what `board list --json` prints and what the page
 * reads. Other tools (lp-cli) parse it, so fields are only ever added.
 */
import { vidPid } from "./desk/presence.ts";
import type { BoardView, DeskState } from "./state.ts";

export function stateJson(state: DeskState) {
  return { hubsAvailable: state.hubsAvailable, boards: state.views.map(viewJson) };
}

export function viewJson(view: BoardView) {
  const board = view.board;
  return {
    registered: board !== undefined,
    slug: board?.slug ?? null,
    mark: board?.mark ?? null,
    mac: view.mac ?? null,
    name: board?.name ?? null,
    role: board?.role ?? null,
    tags: board?.tags ?? [],
    chip: board?.chip ?? null,
    flash: board?.flash ?? null,
    board: board?.board ?? null,
    lp_board: board?.lp_board ?? null,
    lp_project: board?.lp_project ?? null,
    image: board?.image ?? null,
    usb: board?.usb ?? null,
    notes: board?.notes ?? null,
    present: view.device !== undefined,
    port: view.device?.port ?? null,
    usbDevice: view.device ? { name: view.device.name, vidPid: vidPid(view.device), serial: view.device.serial ?? null } : null,
    hub: view.hub ? { ...view.hub, remembered: view.hubRemembered === true } : null,
    lease: view.lease ?? null,
    line: view.line,
    picture: view.image ?? null,
  };
}

export type ViewJson = ReturnType<typeof viewJson>;
