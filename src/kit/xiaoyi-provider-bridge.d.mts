export interface KitXiaoyiProviderBridgeOptions {
  /** Fallback only when the hook context has no config. Return the current host config. */
  getConfig?: () => unknown;
}

/** Preserve the provider's public type while composing its three transport hooks. */
export declare function createKitXiaoyiProvider<T extends { id: string }>(
  provider: T,
  options?: KitXiaoyiProviderBridgeOptions,
): T;
