// These files are loaded at runtime but are not emitted by TypeScript.
import { copyFile, mkdir } from 'node:fs/promises';

const source = new URL('../src/', import.meta.url);
const output = new URL('../dist/src/', import.meta.url);
for (const relative of [
  'kit/xiaoyi-provider-bridge.mjs',
  'kit/xiaoyi-provider-bridge.d.mts',
  'cspl/configs.json',
]) {
  const target = new URL(relative, output);
  await mkdir(new URL('./', target), { recursive: true });
  await copyFile(new URL(relative, source), target);
}
