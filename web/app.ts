// The desk page. Plain DOM: it polls /api/state every two seconds and redraws.
// Every button posts to an endpoint that runs the same code as the CLI.
import type { ViewJson } from "../src/view_json.ts";

interface State {
  hubsAvailable: boolean;
  boards: ViewJson[];
  now: string;
  you: string;
}

const POLL_MS = 2000;
let state: State | undefined;
let clockSkew = 0; // server now − local now, so "min left" agrees with the CLI
let lastOk = 0;
let editing: ViewJson | undefined;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

async function refresh(): Promise<void> {
  try {
    const response = await fetch("/api/state", { cache: "no-store" });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? response.statusText);
    state = body as State;
    clockSkew = Date.parse(state.now) - Date.now();
    lastOk = Date.now();
    $("problem").replaceChildren();
    render();
  } catch (err) {
    const banner = el("div", "error-banner", `The bench could not read the desk: ${(err as Error).message}`);
    $("problem").replaceChildren(banner);
  }
  renderUpdated();
}

function render(): void {
  if (!state) return;
  const boards = state.boards;
  const inUse = boards.filter((b) => b.registered && b.lease);
  const free = boards.filter((b) => b.registered && !b.lease && b.present);
  const absent = boards.filter((b) => b.registered && !b.lease && !b.present);
  const unregistered = boards.filter((b) => !b.registered);
  const waiting = boards.reduce((n, b) => n + b.line.length, 0);

  const summary: HTMLElement[] = [pill("", `${boards.filter((b) => b.registered).length} boards`)];
  summary.push(pill("used", `${inUse.length} in use`));
  if (waiting > 0) summary.push(pill("wait", `${waiting} waiting`));
  summary.push(pill("free", `${free.length} free`));
  if (absent.length > 0) summary.push(pill("absent", `${absent.length} not plugged in`));
  $("summary").replaceChildren(...summary);

  const groups = $("groups");
  groups.replaceChildren(
    group("In use", inUse, "Nobody is holding a board."),
    group("Free", free, "No free boards right now."),
    ...(absent.length > 0 ? [group("Not plugged in", absent, "")] : []),
    ...(unregistered.length > 0 ? [group("On the bus, not registered", unregistered, "")] : []),
  );
}

function renderUpdated(): void {
  const updated = $("updated");
  if (!lastOk) return;
  const seconds = Math.round((Date.now() - lastOk) / 1000);
  updated.textContent = seconds < 3 ? "live" : `last read ${seconds} s ago`;
  updated.classList.toggle("stale", seconds > 10);
}

function group(title: string, boards: ViewJson[], empty: string): HTMLElement {
  const section = el("section", "group");
  section.append(el("h2", "", title));
  if (boards.length === 0) {
    section.append(el("div", "empty", empty));
    return section;
  }
  const grid = el("div", "grid");
  grid.append(...boards.map(card));
  section.append(grid);
  return section;
}

function card(board: ViewJson): HTMLElement {
  const used = board.lease !== null;
  const node = el("article", "card");
  node.classList.toggle("is-used", used);
  node.classList.toggle("is-art", board.role === "art");
  node.classList.toggle("is-absent", !board.present);

  // Picture: LightPlayer's drawing or the piece; else the mark, big.
  const picture = el("div", "picture");
  if (board.picture && board.mac) {
    const img = document.createElement("img");
    img.src = `/picture/${board.mac}?v=${encodeURIComponent(board.picture)}`;
    img.alt = `${board.mark ?? ""} ${board.slug ?? ""}`.trim() || "board";
    img.loading = "lazy";
    picture.append(img);
  } else {
    picture.append(el("div", "placeholder", board.mark ?? "?"));
  }
  if (board.role) {
    const role = roleChip(board.role);
    role.classList.add("role");
    picture.append(role);
  }
  if (board.mark && board.picture) picture.append(el("div", "mark-tape", board.mark));
  node.append(picture);

  const body = el("div", "body");
  const title = el("div", "title");
  if (board.registered) {
    title.append(el("span", "mark", board.mark ?? ""), el("span", "slug", board.slug ?? ""));
  } else {
    title.append(el("span", "mark", "—"), el("span", "slug", board.usbDevice?.name ?? "unknown device"));
  }
  body.append(title);
  if (board.name) body.append(el("div", "name", board.name));

  body.append(statusBlock(board));
  if (board.line.length > 0) body.append(queueBlock(board));

  const facts = document.createElement("dl");
  facts.className = "facts";
  const fact = (label: string, value: string | null | undefined) => {
    if (!value) return;
    facts.append(el("dt", "", label), el("dd", "", value));
  };
  fact("chip", [board.chip, board.flash].filter(Boolean).join(" · ") || (board.usbDevice?.vidPid ?? null));
  fact("hardware", board.board);
  fact("port", board.port);
  fact("hub", board.hub ? `${board.hub.hub} port ${board.hub.port}${board.hub.twin ? ` (+ ${board.hub.twin})` : ""}${board.hub.remembered ? " · last seen" : ""}` : null);
  fact("MAC", board.mac);
  fact("tags", board.tags.length > 0 ? board.tags.join(", ") : null);
  body.append(facts);
  if (board.notes) body.append(el("div", "notes", board.notes));

  body.append(actions(board));
  node.append(body);
  return node;
}

function statusBlock(board: ViewJson): HTMLElement {
  const lease = board.lease;
  if (lease) {
    const block = el("div", "status used");
    const line1 = el("div", "line1");
    line1.append(el("span", "dot"), el("span", "", `In use by ${lease.holder}`), el("span", "left", timeLeft(lease.expires)));
    block.append(line1);
    if (lease.purpose) block.append(el("div", "why", lease.purpose));
    return block;
  }
  if (!board.present) {
    const block = el("div", "status absent");
    const line1 = el("div", "line1");
    line1.append(el("span", "dot"), el("span", "", "Not plugged in"));
    block.append(line1);
    return block;
  }
  const block = el("div", "status free");
  const line1 = el("div", "line1");
  line1.append(el("span", "dot"), el("span", "", board.registered ? "Free" : "Free · not registered"));
  block.append(line1);
  return block;
}

function queueBlock(board: ViewJson): HTMLElement {
  const block = el("div", "queue");
  block.append(el("div", "label", `Waiting (${board.line.length})`));
  const list = document.createElement("ol");
  for (const waiter of board.line) {
    const item = document.createElement("li");
    item.append(el("b", "", waiter.holder));
    item.append(document.createTextNode(`${waiter.purpose ? ` — ${waiter.purpose}` : ""} · ${ago(waiter.since)}`));
    list.append(item);
  }
  block.append(list);
  return block;
}

function actions(board: ViewJson): HTMLElement {
  const row = el("div", "actions");
  const you = state?.you ?? "";
  if (board.registered && board.mac) {
    if (!board.lease) {
      row.append(button("Take", "primary", () => act(board, "take"), !board.present ? "not plugged in" : undefined));
    } else if (board.lease.holder === you) {
      row.append(button("Release", "", () => act(board, "drop")));
    } else {
      row.append(button("Take back", "danger", () => act(board, "drop", `Take ${board.mark} ${board.slug} back from ${board.lease!.holder}?`)));
    }
    const powerBlocked = !state?.hubsAvailable
      ? "no uhubctl on this machine"
      : !board.hub
        ? "not on a switchable hub"
        : board.lease && board.lease.holder !== you
          ? `held by ${board.lease.holder}`
          : board.role === "art" && !board.lease
            ? "an art piece: take it first"
            : undefined;
    row.append(button("Power-cycle", "", () => act(board, "power-cycle"), powerBlocked));
    row.append(button("Edit", "", () => openEditor(board)));
  } else {
    row.append(button("Register", "primary", () => openEditor(board), board.mac ? undefined : "no MAC to key it by"));
  }
  return row;
}

async function act(board: ViewJson, action: "take" | "drop" | "power-cycle", confirmText?: string): Promise<void> {
  if (confirmText && !armed(board, action)) {
    toast(`${confirmText} Press again to confirm.`);
    return;
  }
  if (action === "power-cycle") toast(`Power-cycling ${board.mark} ${board.slug}…`);
  const response = await fetch(`/api/boards/${board.mac}/${action}`, { method: "POST" });
  const body = await response.json();
  toast(body.message ?? body.error ?? response.statusText, !response.ok);
  await refresh();
}

// A second press within four seconds confirms (taking a board back from someone).
let armedKey = "";
let armedAt = 0;
function armed(board: ViewJson, action: string): boolean {
  const key = `${board.mac}/${action}`;
  if (armedKey === key && Date.now() - armedAt < 4000) {
    armedKey = "";
    return true;
  }
  armedKey = key;
  armedAt = Date.now();
  return false;
}

// ---- the editor ------------------------------------------------------------

const FIELDS: Array<{ key: keyof ViewJson; label: string; hint?: string; kind?: "role" | "area"; half?: boolean }> = [
  { key: "slug", label: "Slug", hint: "kebab-case, the name everyone says (fixture-c6)", half: true },
  { key: "mark", label: "Mark", hint: "2–4 letters, written on the chip (FC6)", half: true },
  { key: "role", label: "Role", kind: "role", half: true },
  { key: "tags", label: "Tags", hint: "comma-separated", half: true },
  { key: "name", label: "Name", hint: "a longer description" },
  { key: "mac", label: "MAC" },
  { key: "chip", label: "Chip", hint: "as espflash says it (esp32c6)", half: true },
  { key: "flash", label: "Flash", hint: "4MB", half: true },
  { key: "board", label: "Hardware", hint: "XIAO ESP32-C6" },
  { key: "lp_board", label: "LightPlayer board", hint: "draws its picture: seeed/xiao-esp32-c6" },
  { key: "lp_project", label: "LightPlayer project", hint: "an art piece's picture: catalog/projects/…" },
  { key: "image", label: "Picture file", hint: "a photo: absolute, or relative to the desk's images/" },
  { key: "usb", label: "USB vid:pid", hint: "only for a bridge with no serial number (1a86:7522)" },
  { key: "notes", label: "Notes", kind: "area" },
];

function openEditor(board: ViewJson): void {
  editing = board;
  $("drawer-title").textContent = board.registered ? `Edit ${board.mark} ${board.slug}` : "Register this board";
  const form = $<HTMLFormElement>("editor");
  form.replaceChildren();
  let pair: HTMLElement | undefined;
  for (const field of FIELDS) {
    const wrap = el("div", "field");
    const id = `f-${field.key}`;
    const label = el("label", "", field.label);
    label.setAttribute("for", id);
    wrap.append(label);
    let input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
    if (field.kind === "role") {
      input = document.createElement("select");
      for (const role of ["test", "fixture", "dev", "art"]) input.append(new Option(role, role));
      input.value = board.role ?? "test";
    } else if (field.kind === "area") {
      input = document.createElement("textarea");
      input.value = (board[field.key as keyof ViewJson] as string | null) ?? "";
    } else {
      input = document.createElement("input");
      const value = board[field.key as keyof ViewJson];
      input.value = Array.isArray(value) ? value.join(", ") : ((value as string | null) ?? "");
      if (field.key === "usb" && !board.registered && board.usbDevice && !board.mac) input.value = board.usbDevice.vidPid;
    }
    input.id = id;
    input.name = field.key;
    wrap.append(input);
    if (field.hint) wrap.append(el("div", "hint", field.hint));
    if (field.half) {
      if (!pair) {
        pair = el("div", "row2");
        form.append(pair);
        pair.append(wrap);
      } else {
        pair.append(wrap);
        pair = undefined;
      }
    } else {
      pair = undefined;
      form.append(wrap);
    }
  }
  const error = el("div", "form-error");
  error.id = "form-error";
  const buttons = el("div", "actions");
  const save = button("Save", "primary", () => {});
  save.type = "submit";
  buttons.append(save, button("Cancel", "", closeEditor));
  form.append(error, buttons);
  form.onsubmit = (event) => {
    event.preventDefault();
    void saveEditor(form);
  };
  $("drawer").classList.add("open");
  $("drawer").setAttribute("aria-hidden", "false");
  $("backdrop").classList.add("open");
  (form.querySelector("input") as HTMLInputElement | null)?.focus();
}

async function saveEditor(form: HTMLFormElement): Promise<void> {
  const data: Record<string, string> = {};
  for (const [key, value] of new FormData(form).entries()) data[key] = String(value).trim();
  if (editing?.registered && editing.mac) data.was = editing.mac;
  const response = await fetch("/api/boards", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
  });
  const body = await response.json();
  if (!response.ok) {
    $("form-error").textContent = body.error ?? response.statusText;
    return;
  }
  closeEditor();
  toast(`Saved ${data.mark ?? ""} ${data.slug ?? ""}`.trim());
  await refresh();
}

function closeEditor(): void {
  editing = undefined;
  $("drawer").classList.remove("open");
  $("drawer").setAttribute("aria-hidden", "true");
  $("backdrop").classList.remove("open");
}

// ---- small helpers -----------------------------------------------------------

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function pill(kind: string, text: string): HTMLElement {
  const node = el("span", `pill ${kind}`);
  if (kind) node.append(el("span", "dot"));
  node.append(document.createTextNode(text));
  return node;
}

const ROLE_ICONS: Record<string, string> = {
  test: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M6 2h4M7 2v4.5L3.2 12.6A1 1 0 0 0 4 14h8a1 1 0 0 0 .8-1.4L9 6.5V2"/></svg>',
  fixture: '<svg viewBox="0 0 16 16" fill="currentColor"><circle cx="4" cy="4" r="1.6"/><circle cx="8" cy="4" r="1.6"/><circle cx="12" cy="4" r="1.6"/><circle cx="4" cy="8" r="1.6"/><circle cx="8" cy="8" r="1.6"/><circle cx="12" cy="8" r="1.6"/><circle cx="4" cy="12" r="1.6"/><circle cx="8" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/></svg>',
  dev: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M5.5 4 2 8l3.5 4M10.5 4 14 8l-3.5 4"/></svg>',
  art: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1l1.8 4.6L14.5 6 11 9.2l1 4.8L8 11.6 4 14l1-4.8L1.5 6l4.7-.4z"/></svg>',
};
const ROLE_WORDS: Record<string, string> = { test: "test", fixture: "LED fixture", dev: "dev", art: "art piece" };

function roleChip(role: string): HTMLElement {
  const node = el("span", `role-chip role-${role}`);
  node.innerHTML = ROLE_ICONS[role] ?? "";
  node.append(document.createTextNode(ROLE_WORDS[role] ?? role));
  return node;
}

function button(text: string, kind: string, onClick: () => void, disabledReason?: string): HTMLButtonElement {
  const node = document.createElement("button");
  node.type = "button";
  node.className = `btn ${kind}`.trim();
  node.textContent = text;
  if (disabledReason) {
    node.disabled = true;
    node.title = disabledReason;
  }
  node.onclick = onClick;
  return node;
}

function timeLeft(expires: string): string {
  const minutes = Math.ceil((Date.parse(expires) - (Date.now() + clockSkew)) / 60_000);
  return minutes <= 1 ? "under a minute left" : `${minutes} min left`;
}

function ago(since: string): string {
  const minutes = Math.floor((Date.now() + clockSkew - Date.parse(since)) / 60_000);
  return minutes < 1 ? "just now" : `waiting ${minutes} min`;
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(text: string, bad = false): void {
  const node = $("toast");
  node.textContent = text;
  node.classList.toggle("bad", bad);
  node.classList.add("show");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove("show"), 3500);
}

$("drawer-close").onclick = closeEditor;
$("backdrop").onclick = closeEditor;
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && editing) closeEditor();
});

void refresh();
setInterval(() => {
  // Don't redraw under an open editor; the form would lose what is typed.
  if (!editing) void refresh();
  else renderUpdated();
}, POLL_MS);
setInterval(renderUpdated, 1000);
