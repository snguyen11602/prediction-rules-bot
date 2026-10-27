import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { RulesFileSchema, type RulesFile, type Rule } from "./schema.js";

export async function loadRulesFile(filePath: string): Promise<RulesFile> {
  const abs = path.resolve(filePath);
  const raw = await readFile(abs, "utf8");
  const data = abs.endsWith(".json") ? JSON.parse(raw) : parseYaml(raw);
  return RulesFileSchema.parse(data);
}

export function enabledRules(file: RulesFile): Rule[] {
  return file.rules.filter((r) => r.enabled);
}
