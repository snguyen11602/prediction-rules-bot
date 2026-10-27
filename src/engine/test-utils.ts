/** Test helpers (not shipped behaviour). */
import { copyFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * The example rules with every arbitrage path switched on (auto-matched pairs
 * trade, YES baskets allowed), written to a temp folder with its pairs file.
 */
export async function rulesWithAllArbPaths(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "prb-rules-"));
  const data = parse(await readFile(path.join(ROOT, "rules/example.yaml"), "utf8"));
  data.arbitrage.cross_platform.auto_trade = true;
  data.arbitrage.same_platform.yes_basket = true;
  const file = path.join(dir, "rules.yaml");
  await writeFile(file, stringify(data));
  await copyFile(path.join(ROOT, "rules/arb-pairs.yaml"), path.join(dir, "arb-pairs.yaml"));
  return file;
}
