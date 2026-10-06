// One contender in the race test: take MAC_A as `contender-<n>`, exit 0 on a
// win and 3 on a loss. BOARD_HOME points at the shared temp desk.
import { realDeps } from "../src/deps.ts";
import { take } from "../src/lease.ts";
import { boardHome } from "../src/paths.ts";
import { MAC_A } from "./fake_deps.ts";

const result = take(boardHome(), { mac: MAC_A, holder: `contender-${process.argv[2]}`, purpose: "race" }, realDeps);
process.exit(result.ok ? 0 : 3);
