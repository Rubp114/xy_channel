import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createKitXiaoyiProvider } from '../src/kit/xiaoyi-provider-bridge.mjs';

const CREATE = Symbol.for('deepdiver.pangu-transport.createStreamFn');
const NORMALIZE = Symbol.for('deepdiver.pangu-transport.normalizeToolSchemas');
const PLUGIN = 'deepdiver-pangu-transport';
const config = overrides => ({ plugins: { entries: { 'deepdiver-pangu-transport': {
  enabled: true, config: { transportEnabled: true, integrationMode: 'bridge', providerId: 'xiaoyiprovider', ...overrides },
} } } });
const context = overrides => ({ provider: 'xiaoyiprovider', config: config(), tools: [], ...overrides });
function publish({ create = () => () => 'kit', normalize = ctx => ctx.tools, wrap = fn => fn, validate = () => {}, owner = {} } = {}) {
  const annotate = fn => Object.defineProperties(fn, {
    bridgeVersion: { value: 1 }, bridgeOwner: { value: owner }, providerId: { value: 'xiaoyiprovider' },
  });
  globalThis[CREATE] = annotate(create);
  Object.defineProperty(create, 'wrapStreamFn', { value: wrap });
  Object.defineProperty(create, 'validateConfig', { value: validate });
  globalThis[NORMALIZE] = annotate(normalize);
  return { create, normalize };
}
afterEach(() => { delete globalThis[CREATE]; delete globalThis[NORMALIZE]; });

test('disabled, standalone and non-target hooks retain original values and this', () => {
  const stream = () => 'original', tools = [];
  const provider = { id: 'xiaoyiprovider', auth: [],
    createStreamFn(ctx) { assert.equal(this, provider); assert.ok(ctx); return stream; },
    normalizeToolSchemas() { assert.equal(this, provider); return tools; },
  };
  const merged = createKitXiaoyiProvider(provider);
  for (const ctx of [context({ config: {} }), context({ config: config({ integrationMode: 'standalone' }) }),
    context({ config: config({ transportEnabled: false }) }), context({ provider: 'another-provider' })]) {
    assert.equal(merged.createStreamFn(ctx), stream);
    assert.equal(merged.normalizeToolSchemas(ctx), tools);
  }
  const disabledEntry = config(); disabledEntry.plugins.entries['deepdiver-pangu-transport'].enabled = false;
  assert.equal(merged.createStreamFn(context({ config: disabledEntry })), stream);
  const disabledPlugins = config(); disabledPlugins.plugins.enabled = false;
  assert.equal(merged.createStreamFn(context({ config: disabledPlugins })), stream);
  assert.equal(merged.auth, provider.auth);
  const other = { id: 'other', createStreamFn: stream };
  assert.equal(createKitXiaoyiProvider(other), other);
});

test('all hooks respect deny/allow policy with cold or cached capabilities and either config source', () => {
  const cases = [
    ['absent lists', {}, true],
    ['empty allow', { allow: [] }, true],
    ['blank and non-string allow entries', { allow: [' ', '', null, 7] }, true],
    ['non-array allow', { allow: PLUGIN }, true],
    ['trimmed allow', { allow: [` ${PLUGIN}\n`] }, true],
    ['other allow', { allow: ['xiaoyi-channel'] }, false],
    ['literal wildcard', { allow: ['*'] }, false],
    ['unknown ids retain case', { allow: [PLUGIN.toUpperCase()] }, false],
    ['trimmed deny', { deny: [` ${PLUGIN}\t`] }, false],
    ['deny wins over allow', { allow: [PLUGIN], deny: [` ${PLUGIN} `] }, false],
    ['blank and non-string deny entries', { deny: ['', ' ', null, 7] }, true],
    ['trimmed entry key', { entries: { [` ${PLUGIN} `]: config().plugins.entries[PLUGIN] } }, true],
    ['merged entry disable', { entries: { ...config().plugins.entries, [` ${PLUGIN} `]: { enabled: false } } }, false],
  ];
  for (const [name, policy, enabled] of cases) {
    const cfg = config(); Object.assign(cfg.plugins, policy);
    for (const cached of [false, true]) for (const fallback of [false, true]) {
      const label = `${name}, cached=${cached}, getConfig=${fallback}`;
      delete globalThis[CREATE]; delete globalThis[NORMALIZE];
      const calls = [], original = () => 'host', hostWrapped = () => 'wrapped', tools = [];
      if (cached) publish({ create: () => () => 'kit', normalize: () => ['kit'], wrap: fn => () => `scoped:${fn()}` });
      const provider = { id: 'xiaoyiprovider',
        createStreamFn() { calls.push('create'); return original; },
        normalizeToolSchemas() { calls.push('normalize'); return tools; },
        wrapStreamFn() { calls.push('wrap'); return hostWrapped; },
      };
      const merged = createKitXiaoyiProvider(provider, fallback ? { getConfig: () => cfg } : {});
      const ctx = context({ config: fallback ? undefined : cfg, streamFn: original });
      if (!enabled) {
        assert.equal(merged.createStreamFn(ctx), original, label);
        assert.equal(merged.normalizeToolSchemas(ctx), tools, label);
        assert.equal(merged.wrapStreamFn(ctx), hostWrapped, label);
        assert.deepEqual(calls, ['create', 'normalize', 'wrap'], label);
      } else if (cached) {
        assert.equal(merged.createStreamFn(ctx)(), 'kit', label);
        assert.deepEqual(merged.normalizeToolSchemas(ctx), ['kit'], label);
        assert.equal(merged.wrapStreamFn(ctx)({ provider: 'xiaoyiprovider' }), 'scoped:wrapped', label);
        assert.deepEqual(calls, ['normalize', 'wrap'], label);
      } else {
        for (const hook of ['createStreamFn', 'normalizeToolSchemas', 'wrapStreamFn']) {
          assert.throws(() => merged[hook](ctx), /capabilities are missing/, `${label}, ${hook}`);
        }
        assert.deepEqual(calls, [], label);
      }
    }
  }
});

test('each captured-wrapper invocation rechecks policy without interrupting existing streams', () => {
  for (const fallback of [false, true]) {
    let currentConfig = config(), scopes = 0, hostCalls = 0;
    const original = () => 'original', capturedKit = () => 'existing-kit';
    const merged = createKitXiaoyiProvider({ id: 'xiaoyiprovider', createStreamFn: () => original,
      wrapStreamFn: ({ streamFn }) => (...args) => { hostCalls++; return streamFn(...args); } },
    fallback ? { getConfig: () => currentConfig } : {});
    publish({ create: () => capturedKit, wrap: fn => { scopes++; return fn; } });
    const ctx = context({ config: fallback ? undefined : currentConfig });
    const active = merged.createStreamFn(ctx);
    const wrapped = merged.wrapStreamFn({ ...ctx, streamFn: active });
    assert.equal(wrapped({ provider: 'xiaoyiprovider' }), 'existing-kit');
    assert.equal(scopes, 1);
    for (const policy of [{ deny: [` ${PLUGIN} `] }, { allow: ['xiaoyi-channel'] }]) {
      if (fallback) { currentConfig = config(); Object.assign(currentConfig.plugins, policy); }
      else { delete currentConfig.plugins.deny; delete currentConfig.plugins.allow; Object.assign(currentConfig.plugins, policy); }
      delete globalThis[CREATE]; delete globalThis[NORMALIZE];
      assert.equal(merged.createStreamFn(ctx), original, 'new hook must use the original transport');
      assert.equal(wrapped({ provider: 'xiaoyiprovider' }), 'existing-kit', 'the active captured stream is not torn down');
      assert.equal(scopes, 1, 'disabled invocations do not resolve missing capabilities or acquire a new scope');
    }
    delete currentConfig.plugins.deny; currentConfig.plugins.allow = [` ${PLUGIN} `];
    assert.throws(() => wrapped({ provider: 'xiaoyiprovider' }), /capabilities are missing/);
    publish({ wrap: fn => { scopes++; return fn; } });
    assert.equal(wrapped({ provider: 'xiaoyiprovider' }), 'existing-kit');
    assert.equal(scopes, 2); assert.equal(hostCalls, 4);
  }
});

test('ctx.config policy takes precedence over a conflicting fallback reader for all hooks', () => {
  let reads = 0;
  const original = () => 'original', tools = [];
  const merged = createKitXiaoyiProvider({ id: 'xiaoyiprovider', createStreamFn: () => original,
    normalizeToolSchemas: () => tools, wrapStreamFn: () => original },
  { getConfig: () => { reads++; return config(); } });
  publish();
  const denied = config(); denied.plugins.deny = [PLUGIN];
  const ctx = context({ config: denied, streamFn: original });
  assert.equal(merged.createStreamFn(ctx), original);
  assert.equal(merged.normalizeToolSchemas(ctx), tools);
  assert.equal(merged.wrapStreamFn(ctx), original);
  assert.equal(reads, 0);
});

test('normal registration order is safe; enabled incomplete capabilities fail', () => {
  let originals = 0;
  const merged = createKitXiaoyiProvider({ id: 'xiaoyiprovider', createStreamFn() { originals++; } });
  assert.throws(() => merged.createStreamFn(context()), /missing, incompatible/);
  publish();
  assert.equal(merged.createStreamFn(context())(), 'kit');
  delete globalThis[NORMALIZE];
  assert.throws(() => merged.createStreamFn(context()), /missing, incompatible/);
  assert.equal(originals, 0);
});

test('both capability generations, versions, provider and scope wrapper are checked', () => {
  const merged = createKitXiaoyiProvider({ id: 'xiaoyiprovider' });
  const first = publish();
  publish(); globalThis[NORMALIZE] = first.normalize;
  assert.throws(() => merged.normalizeToolSchemas(context()), /different loads/);
  for (const patch of [{ bridgeVersion: 2 }, { providerId: 'pangu' }, { wrapStreamFn: undefined },
    { validateConfig: undefined }, { bridgeOwner: 'token' }]) {
    publish();
    const fake = () => () => 'bad';
    Object.assign(fake, { bridgeVersion: 1, bridgeOwner: globalThis[NORMALIZE].bridgeOwner,
      providerId: 'xiaoyiprovider', wrapStreamFn: fn => fn, validateConfig: () => {} }, patch);
    globalThis[CREATE] = fake;
    assert.throws(() => merged.createStreamFn(context()), /missing, incompatible/);
  }
});

test('bridge config is validated and ctx.config wins over registration fallback', () => {
  let reads = 0;
  const original = () => 'original';
  const merged = createKitXiaoyiProvider({ id: 'xiaoyiprovider', createStreamFn: () => original },
    { getConfig: () => { reads++; return config(); } });
  publish();
  assert.equal(merged.createStreamFn(context({ config: undefined }))(), 'kit');
  assert.equal(reads, 1);
  assert.equal(merged.createStreamFn(context({ config: {} })), original);
  assert.equal(reads, 1);
  for (const settings of [{ providerId: 'pangu' }, { modelIds: [] }, { modelIds: null }]) {
    assert.throws(() => merged.createStreamFn(context({ config: config(settings) })), /requires providerId/);
  }
});

test('cached capabilities validate effective settings at every hook and wrapped invocation', () => {
  const seen = [], settings = config();
  const merged = createKitXiaoyiProvider({ id: 'xiaoyiprovider' }, { getConfig: () => settings });
  publish({ validate: value => {
    seen.push(value);
    if (value.maxHttpRetries === 4) throw Error('fully restart the process');
  } });
  const ctx = context({ config: undefined, streamFn: () => 'base' });
  assert.equal(merged.createStreamFn(ctx)(), 'kit');
  assert.deepEqual(merged.normalizeToolSchemas(ctx), []);
  const wrapped = merged.wrapStreamFn(ctx);
  assert.equal(wrapped({ provider: 'xiaoyiprovider' }), 'base');
  assert.equal(seen.length, 4);
  assert.ok(seen.every(value => value === settings.plugins.entries['deepdiver-pangu-transport'].config));
  settings.plugins.entries['deepdiver-pangu-transport'].config.maxHttpRetries = 4;
  for (const invoke of [() => merged.createStreamFn(ctx), () => merged.normalizeToolSchemas(ctx),
    () => merged.wrapStreamFn(ctx), () => wrapped({ provider: 'xiaoyiprovider' })]) {
    assert.throws(invoke, /fully restart/);
  }
});

test('normalizers compose once in order without changing input context or other tools', () => {
  const events = [], other = { name: 'other' }, sender = { name: 'send_file_to_user' };
  const transformed = [other, { ...sender, hostNormalized: true }];
  const provider = { id: 'xiaoyiprovider', normalizeToolSchemas(ctx) {
    assert.equal(this, provider); assert.equal(ctx, input); events.push('host'); return transformed;
  } };
  const merged = createKitXiaoyiProvider(provider);
  publish({ normalize(ctx) { events.push('kit'); assert.equal(ctx.tools, transformed); return [ctx.tools[0], { ...ctx.tools[1], kit: true }]; } });
  const input = context({ tools: [other, sender] });
  const output = merged.normalizeToolSchemas(input);
  assert.deepEqual(events, ['host', 'kit']);
  assert.equal(input.tools[1], sender); assert.equal(output[0], other); assert.equal(output[1].kit, true);
  assert.equal(createKitXiaoyiProvider(merged), merged);
  assert.equal(createKitXiaoyiProvider(provider), merged);
});

test('repeated registrations accept distinct config readers without nesting original hooks', () => {
  const events = [];
  const provider = { id: 'xiaoyiprovider',
    createStreamFn() { assert.equal(this, provider); events.push('host-create'); return () => 'host'; },
    normalizeToolSchemas(ctx) { assert.equal(this, provider); events.push('host-normalize'); return ctx.tools; },
    wrapStreamFn(ctx) { assert.equal(this, provider); events.push('host-wrap'); return ctx.streamFn; },
  };
  const firstReader = () => config();
  const secondReader = () => ({});
  const first = createKitXiaoyiProvider(provider, { getConfig: firstReader });
  const second = createKitXiaoyiProvider(first, { getConfig: secondReader });
  assert.notEqual(first, second);
  assert.equal(createKitXiaoyiProvider(provider, { getConfig: firstReader }), first);
  assert.equal(createKitXiaoyiProvider(provider, { getConfig: secondReader }), second);
  assert.equal(createKitXiaoyiProvider(first), first);
  assert.equal(createKitXiaoyiProvider(second), second);
  publish({ normalize: ctx => { events.push('kit-normalize'); return ctx.tools; } });
  const ctx = context({ config: undefined });
  assert.equal(first.createStreamFn(ctx)(), 'kit');
  assert.equal(second.createStreamFn(ctx)(), 'host');
  first.normalizeToolSchemas(ctx);
  second.normalizeToolSchemas(ctx);
  const base = () => 'base';
  assert.equal(first.wrapStreamFn({ ...ctx, streamFn: base })({ provider: 'xiaoyiprovider' }), 'base');
  assert.equal(second.wrapStreamFn({ ...ctx, streamFn: base })({ provider: 'xiaoyiprovider' }), 'base');
  assert.deepEqual(events, ['host-create', 'host-normalize', 'kit-normalize', 'host-normalize', 'host-wrap', 'host-wrap']);
});

test('undefined host normalizer uses ctx.tools and asynchronous capabilities are rejected', () => {
  const merged = createKitXiaoyiProvider({ id: 'xiaoyiprovider', normalizeToolSchemas: () => undefined });
  const tools = [{ name: 'tool' }];
  publish(); assert.equal(merged.normalizeToolSchemas(context({ tools })), tools);
  publish({ create: async () => () => 'invalid' });
  assert.throws(() => merged.createStreamFn(context()), /synchronous stream/);
  publish({ normalize: async ctx => ctx.tools });
  assert.throws(() => merged.normalizeToolSchemas(context()), /synchronous tool/);
  const asyncHost = createKitXiaoyiProvider({ id: 'xiaoyiprovider', normalizeToolSchemas: async ctx => ctx.tools });
  assert.throws(() => asyncHost.normalizeToolSchemas(context()), /original normalizer/);
});

test('original stream wrapper runs once, then each invocation gets the current scope adapter', () => {
  const events = [], receiver = {};
  const base = function (...args) { assert.equal(this, receiver); events.push('base'); return args; };
  const provider = { id: 'xiaoyiprovider', wrapStreamFn(ctx) {
    assert.equal(this, provider); events.push('host-wrap');
    return function (...args) { events.push('host-call'); return Reflect.apply(ctx.streamFn, this, args); };
  } };
  const merged = createKitXiaoyiProvider(provider);
  const scope = tag => fn => { events.push(`${tag}-wrap`); return function (...args) {
    events.push(`${tag}-call`); return Reflect.apply(fn, this, args);
  }; };
  publish({ wrap: scope('first') });
  const wrapped = merged.wrapStreamFn(context({ streamFn: base }));
  const args = [{ provider: 'xiaoyiprovider' }, {}, { fixture: true }];
  assert.deepEqual(wrapped.apply(receiver, args), args);
  publish({ wrap: scope('second') });
  assert.deepEqual(wrapped.apply(receiver, args), args);
  assert.deepEqual(events, ['host-wrap', 'first-wrap', 'first-call', 'host-call', 'base', 'second-wrap', 'second-call', 'host-call', 'base']);
});

test('async host wrapping preserves argument identity, receiver, headers and callback options', async () => {
  const model = { provider: 'xiaoyiprovider', id: 'fixture-model' }, messages = { messages: [] };
  const controller = new AbortController(), owner = {};
  const options = { signal: controller.signal, headers: { 'x-hag-trace-id': 'fixture-trace' },
    apiKey: 'not-a-real-key', onPayload() {}, onResponse() {} };
  const result = { result: async () => 'fixture-result' };
  let wraps = 0, calls = 0;
  const provider = { id: 'xiaoyiprovider', wrapStreamFn(ctx) {
    assert.equal(this, provider); wraps++;
    return async function (actualModel, actualContext, actualOptions) {
      assert.equal(this, owner); calls++;
      assert.equal(actualModel, model); assert.equal(actualContext, messages);
      assert.equal(actualOptions, options); assert.equal(actualOptions.signal, controller.signal);
      return Reflect.apply(ctx.streamFn, this, [actualModel, actualContext, actualOptions]);
    };
  } };
  publish({ create: () => function (m, c, o) {
    assert.equal(this, owner); assert.equal(m, model); assert.equal(c, messages); assert.equal(o, options);
    assert.equal(o.headers['x-hag-trace-id'], 'fixture-trace'); return result;
  } });
  const composed = createKitXiaoyiProvider(provider), ctx = context();
  const stream = composed.wrapStreamFn({ ...ctx, streamFn: composed.createStreamFn(ctx) });
  const pending = stream.call(owner, model, messages, options);
  assert.ok(pending instanceof Promise); assert.equal(await pending, result);
  assert.equal(wraps, 1); assert.equal(calls, 1);
});

test('invocation rechecks config and capabilities instead of retaining an enabled bridge', () => {
  let scopes = 0, calls = 0;
  const settings = config();
  const merged = createKitXiaoyiProvider({ id: 'xiaoyiprovider' });
  publish({ wrap: fn => { scopes++; return fn; } });
  const wrapped = merged.wrapStreamFn(context({ config: settings, streamFn: () => ++calls }));
  wrapped({ provider: 'xiaoyiprovider' }); assert.equal(scopes, 1);
  settings.plugins.entries['deepdiver-pangu-transport'].config.transportEnabled = false;
  delete globalThis[CREATE]; delete globalThis[NORMALIZE];
  wrapped({ provider: 'xiaoyiprovider' }); assert.equal(scopes, 1);
  settings.plugins.entries['deepdiver-pangu-transport'].config.transportEnabled = true;
  assert.throws(() => wrapped({ provider: 'xiaoyiprovider' }), /missing, incompatible/);
  assert.equal(calls, 2);
  // A foreign provider must not acquire the Kit retry scope even with bridge config.
  wrapped({ provider: 'another-provider' }); assert.equal(calls, 3);
});

test('inactive wrappers preserve exact identity so SDK compatibility decisions are unchanged', () => {
  const base = () => 'base';
  for (const result of [undefined, null, base]) {
    const merged = createKitXiaoyiProvider({ id: 'xiaoyiprovider', wrapStreamFn: () => result });
    for (const ctx of [context({ config: {} }), context({ config: config({ integrationMode: 'standalone' }) }),
      context({ config: config({ transportEnabled: false }) }), context({ provider: 'another-provider' })]) {
      assert.equal(merged.wrapStreamFn({ ...ctx, streamFn: base }), result);
    }
  }
  assert.equal(createKitXiaoyiProvider({ id: 'xiaoyiprovider' }).wrapStreamFn(context({ config: {}, streamFn: base })), undefined);
});

test('enabled wrapping rejects absent streams and invalid scope results', () => {
  const merged = createKitXiaoyiProvider({ id: 'xiaoyiprovider' });
  publish(); assert.throws(() => merged.wrapStreamFn(context()), /requires the host-wrapped/);
  publish({ wrap: () => undefined });
  const wrapped = merged.wrapStreamFn(context({ streamFn: () => 'base' }));
  assert.throws(() => wrapped({ provider: 'xiaoyiprovider' }), /HTTP retry-scope adapter/);
  assert.equal(merged.wrapStreamFn(context({ config: {} })), undefined);
});
