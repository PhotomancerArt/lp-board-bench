import type { Deps } from "./deps.ts";
import type { Desk } from "./desk/desk.ts";

export async function serve(_home: string, _desk: Desk, _deps: Deps, _args: string[]): Promise<number> {
  console.error("board serve: the desk page is not built yet");
  return 1;
}
