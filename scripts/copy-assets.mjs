import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeAssets = ["src/cspl/configs.json"];

for (const relativePath of runtimeAssets) {
  const source = resolve(rootDir, relativePath);
  const target = resolve(rootDir, "dist", relativePath);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
}

console.log(`Copied ${runtimeAssets.length} runtime asset(s) into dist.`);
