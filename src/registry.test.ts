import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";

import { MAC_A, MAC_B, tempHome } from "../test/fake_deps.ts";
import { boardFromInput, handle, loadRegistry, RegistryError, saveRegistry, type Board } from "./registry.ts";
import { registryPath } from "./paths.ts";

describe("registry", () => {
  test("a missing file is an empty desk", () => {
    expect(loadRegistry(tempHome())).toEqual([]);
  });

  test("save then load round-trips every field, unknown keys and awkward strings", () => {
    const home = tempHome();
    const boards: Board[] = [
      {
        slug: "fixture-c6",
        mark: "FC6",
        mac: MAC_A,
        name: 'C6 on the "big" panel',
        role: "fixture",
        tags: ["led", "panel\\left"],
        chip: "esp32c6",
        flash: "4MB",
        board: "XIAO ESP32-C6",
        lp_board: "seeed/xiao-esp32-c6",
        notes: "line one\nline two\ttabbed\u0001",
        extra: { rack: "top", shelf: 2, wired: true, colours: ["red", "blue"] },
      },
      { slug: "loose-c6", mark: "LC6", mac: MAC_B, role: "test", tags: [], usb: "1a86:7522", extra: {} },
    ];
    saveRegistry(home, boards);
    expect(loadRegistry(home)).toEqual(boards);
    expect(readFileSync(registryPath(home), "utf8")).toStartWith("# The desk's boards");
  });

  test("hand-written TOML with lowercase MACs and marks loads normalised", () => {
    const home = tempHome();
    writeFileSync(
      registryPath(home),
      `# my desk\n[[board]]\nslug = "c6-oak"\nmark = "oak"\nmac = "02-00-00-00-00-01"\n`,
    );
    const [board] = loadRegistry(home);
    expect(board).toMatchObject({ slug: "c6-oak", mark: "OAK", mac: MAC_A, role: "test", tags: [] });
  });

  test("every problem is named, with the entry it belongs to", () => {
    const home = tempHome();
    writeFileSync(
      registryPath(home),
      [
        "[[board]]",
        'slug = "Fixture C6"',
        'mark = "FIXTURE"',
        'mac = "nope"',
        'role = "precious"',
        'usb = "1A86:7522"',
        "[[board]]",
        'slug = "a"',
        'mark = "AA"',
        `mac = "${MAC_B}"`,
        "[[board]]",
        'slug = "a"',
        'mark = "AA"',
        `mac = "${MAC_B}"`,
      ].join("\n"),
    );
    let message = "";
    try {
      loadRegistry(home);
    } catch (err) {
      expect(err).toBeInstanceOf(RegistryError);
      message = (err as Error).message;
    }
    expect(message).toContain("board #1 (Fixture C6): slug must be kebab-case");
    expect(message).toContain("mark must be 2–4 letters or digits");
    expect(message).toContain('mac must be six hex pairs, got "nope"');
    expect(message).toContain("role must be one of test, fixture, dev, art");
    expect(message).toContain("usb must be vid:pid in lowercase hex");
    expect(message).toContain(`mac "${MAC_B}" is used by both a and a`);
    expect(message).toContain('slug "a" is used by both a and a');
    expect(message).toContain('mark "AA" is used by both a and a');
  });

  test("bad TOML says so", () => {
    const home = tempHome();
    writeFileSync(registryPath(home), "[[board]\nslug =");
    expect(() => loadRegistry(home)).toThrow("not valid TOML");
  });

  test("input from a form becomes a board or a list of problems", () => {
    expect(boardFromInput({ slug: "c6-fig", mark: "fig", mac: "020000000001" }).board).toMatchObject({
      slug: "c6-fig",
      mark: "FIG",
      mac: MAC_A,
    });
    expect(boardFromInput({ slug: "", mark: "F", mac: "x" }).problems).toHaveLength(3);
  });

  test("a board's handle is its mark and slug", () => {
    expect(handle({ mark: "FC6", slug: "fixture-c6" })).toBe("FC6 fixture-c6");
  });
});
