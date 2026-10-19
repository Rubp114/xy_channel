import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const helper = 'src/kit/xiaoyi-provider-bridge.mjs';
const declaration = 'src/kit/xiaoyi-provider-bridge.d.mts';
const csplConfig = 'src/cspl/configs.json';

test('standard build includes unchanged bridge runtime, declaration and CSPL config', async () => {
  for (const relative of [helper, declaration, csplConfig]) {
    assert.deepEqual(await readFile(new URL(`dist/${relative}`, root)), await readFile(new URL(relative, root)), relative);
  }
  const provider = await readFile(new URL('dist/src/provider.js', root), 'utf8');
  assert.match(provider, /import\s*\{\s*createKitXiaoyiProvider\s*\}\s*from\s*["']\.\/kit\/xiaoyi-provider-bridge\.mjs["']/);
  assert.match(provider, /export const xiaoyiProvider\s*=\s*createKitXiaoyiProvider\(/);
  // Import only the dependency-free helper. Importing the complete provider or
  // plugin here could initialize services, user state or external connections.
  const { createKitXiaoyiProvider } = await import(new URL(`dist/${helper}`, root));
  const original = () => 'host';
  const composed = createKitXiaoyiProvider({ id: 'xiaoyiprovider', createStreamFn: () => original });
  assert.equal(composed.createStreamFn({ provider: 'xiaoyiprovider', config: {} }), original);
});

test('npm package includes the built bridge pair and its provider import target', async () => {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const cache = await mkdtemp(path.join(os.tmpdir(), 'xiaoyi-package-test-'));
  try {
    const output = execFileSync(npm, ['pack', '--dry-run', '--ignore-scripts', '--json', '--cache', cache], {
      cwd: fileURLToPath(root), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    const packs = JSON.parse(output);
    assert.equal(packs.length, 1);
    const files = new Set(packs[0].files.map(file => file.path));
    for (const relative of [`dist/${helper}`, `dist/${declaration}`, `dist/${csplConfig}`, 'dist/src/provider.js', 'dist/index.js', 'openclaw.plugin.json']) {
      assert.ok(files.has(relative), `npm pack is missing ${relative}`);
    }
  } finally {
    await rm(cache, { recursive: true, force: true });
  }
});
