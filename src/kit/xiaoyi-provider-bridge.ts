// Dependency-free bridge to the optional Kit transport plugin.
// The host remains the sole registrar of xiaoyiprovider.
const PROVIDER = 'xiaoyiprovider';
const PLUGIN = 'deepdiver-pangu-transport';
const CREATE = Symbol.for('deepdiver.pangu-transport.createStreamFn');
const NORMALIZE = Symbol.for('deepdiver.pangu-transport.normalizeToolSchemas');
const compositions = new WeakMap();
const composedSources = new WeakMap();

function fail(message) {
  throw Error(`Kit Xiaoyi provider bridge: ${message}`);
}

// Match the SDK's array-backed, trimmed plugin-id lists. This third-party id
// has no bundled alias; unknown ids retain their case and '*' is not special.
function pluginIds(value) {
  return Array.isArray(value) ? value.filter(id => typeof id === 'string').map(id => id.trim()).filter(Boolean) : [];
}

function bridgeEntry(entries) {
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return undefined;
  let entry;
  // The SDK also trims entry keys and merges duplicate normalized keys in order.
  for (const [id, value] of Object.entries(entries)) {
    if (id.trim() !== PLUGIN) continue;
    if (!value || typeof value !== 'object' || Array.isArray(value)) { entry = {}; continue; }
    const fields = value as Record<string, unknown>;
    entry = {
      enabled: typeof fields.enabled === 'boolean' ? fields.enabled : entry?.enabled,
      config: 'config' in fields ? fields.config : entry?.config,
    };
  }
  return entry;
}

function bridgeFor(ctx, getConfig) {
  if (ctx?.provider !== PROVIDER) return undefined;
  const config = ctx.config !== undefined ? ctx.config : getConfig?.();
  const plugins = config?.plugins;
  const allow = pluginIds(plugins?.allow);
  if (plugins?.enabled === false || pluginIds(plugins?.deny).includes(PLUGIN)
    || (allow.length > 0 && !allow.includes(PLUGIN))) return undefined;
  const entry = bridgeEntry(plugins?.entries);
  const settings = entry?.config;
  if (entry?.enabled === false || settings?.transportEnabled !== true
    || settings?.integrationMode !== 'bridge') return undefined;
  if (settings.providerId !== PROVIDER || settings.modelIds !== undefined) {
    fail('bridge mode requires providerId="xiaoyiprovider" and no modelIds.');
  }
  // Resolve both capabilities together on every hook/invocation. A partially
  // loaded or replaced pair must not silently fall back to the host transport.
  const create = globalThis[CREATE], normalize = globalThis[NORMALIZE];
  if (typeof create !== 'function' || typeof normalize !== 'function'
    || create.bridgeVersion !== 1 || normalize.bridgeVersion !== 1
    || create.providerId !== PROVIDER || normalize.providerId !== PROVIDER
    || !create.bridgeOwner || typeof create.bridgeOwner !== 'object'
    || create.bridgeOwner !== normalize.bridgeOwner
    || typeof create.wrapStreamFn !== 'function'
    || typeof create.validateConfig !== 'function') {
    fail('enabled bridge capabilities are missing, incompatible or from different loads; load a compatible Kit plugin with both hooks.');
  }
  // Cached SDK registries may be reactivated without running register() again.
  // The process-local implementation must agree with this invocation's config.
  create.validateConfig(settings);
  return { create, normalize };
}

export interface KitXiaoyiProviderBridgeOptions {
  /** Fallback only when the hook context has no config. Return the current host config. */
  getConfig?: () => unknown;
}

/** Compose the host provider without registering it or changing its config.
 * ctx.config takes precedence over the optional registration-time fallback.
 * Hooks are synchronous, as required by the OpenClaw provider API. */
export function createKitXiaoyiProvider<T extends { id: string }>(
  provider: T,
  { getConfig }: KitXiaoyiProviderBridgeOptions = {},
): T {
  if (!provider || typeof provider !== 'object') fail('a provider object is required.');
  if (getConfig !== undefined && typeof getConfig !== 'function') fail('getConfig must be a function.');
  if (provider.id !== PROVIDER) return provider;
  // Full registrations can reuse the provider object with distinct api.config
  // readers. Keep those compositions separate without wrapping a wrapper.
  const source = composedSources.get(provider);
  if (source && getConfig === undefined) return provider;
  provider = source ?? provider;
  const variants = compositions.get(provider);
  const prior = getConfig === undefined ? variants?.default : variants?.readers.get(getConfig);
  if (prior) return prior;
  for (const name of ['createStreamFn', 'normalizeToolSchemas', 'wrapStreamFn']) {
    if (provider[name] !== undefined && typeof provider[name] !== 'function') fail(`${name} must be a function when supplied.`);
  }
  const callOriginal = (name, ctx) => provider[name] === undefined ? undefined : Reflect.apply(provider[name], provider, [ctx]);
  const composed = {
    ...provider,
    createStreamFn(ctx) {
      const bridge = bridgeFor(ctx, getConfig);
      if (!bridge) return callOriginal('createStreamFn', ctx);
      const streamFn = bridge.create(ctx);
      if (typeof streamFn !== 'function') fail('createStreamFn did not return a synchronous stream function.');
      return streamFn;
    },
    normalizeToolSchemas(ctx) {
      const bridge = bridgeFor(ctx, getConfig);
      if (!bridge) return callOriginal('normalizeToolSchemas', ctx);
      const tools = callOriginal('normalizeToolSchemas', ctx) ?? ctx.tools;
      if (!Array.isArray(tools)) fail('the original normalizer must return a tool array, null or undefined.');
      const normalized = bridge.normalize({ ...ctx, tools });
      if (!Array.isArray(normalized)) fail('normalizeToolSchemas did not return a synchronous tool array.');
      return normalized;
    },
    wrapStreamFn(ctx) {
      const bridge = bridgeFor(ctx, getConfig);
      const original = callOriginal('wrapStreamFn', ctx);
      // The SDK uses wrapper identity/undefined to select its compatibility
      // wrappers. Disabled and foreign-provider hooks must preserve that value.
      if (!bridge) return original;
      const wrapped = original ?? ctx.streamFn;
      if (typeof wrapped !== 'function') {
        fail('wrapStreamFn requires the host-wrapped stream function or ctx.streamFn.');
      }
      // Keep the original wrapper and its lazy retry generator intact. Scope
      // each invocation separately; never cache a budget by session or options.
      return function (...args) {
        const model = args[0];
        const current = bridgeFor(model?.provider ? { ...ctx, provider: model.provider } : ctx, getConfig);
        // Do not tear down an already-created stream when policy changes. New
        // hooks use the original provider; this captured wrapper just loses its
        // Kit retry scope while the current policy disables the bridge.
        if (!current) return Reflect.apply(wrapped, this, args);
        const scoped = current.create.wrapStreamFn(wrapped);
        if (typeof scoped !== 'function') fail('the HTTP retry-scope adapter did not return a synchronous stream function.');
        return Reflect.apply(scoped, this, args);
      };
    },
  };
  // A module-level provider can outlive many registries. Do not retain each
  // registration's api.config closure after its reader and composition retire.
  const updatedVariants = variants ?? { readers: new WeakMap() };
  if (getConfig === undefined) updatedVariants.default = composed;
  else updatedVariants.readers.set(getConfig, composed);
  compositions.set(provider, updatedVariants);
  composedSources.set(composed, provider);
  return composed;
}
