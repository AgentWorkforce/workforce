import type { IntegrationClientOptions, WritebackResult } from '@agentworkforce/runtime/clients';
import {
  WRITEBACK_PATH_CATALOG,
  type WritebackProvider,
  type WritebackResource
} from '@relayfile/adapter-core/writeback-paths';
import { relayClient, type RelayParams } from './generic.js';

/**
 * One resource of a provider, bound to a client. Every path is resolved from
 * the writeback-path catalog.
 */
export interface ResourceClient {
  /** Resolve this resource's canonical mount path (no IO). */
  path(params?: RelayParams): string;
  /**
   * Write `body`: a uniquely-named draft for a collection resource, or a direct
   * write for an item (`.json`) resource. The writeback worker materializes the
   * draft into the real provider call.
   */
  write(params: RelayParams, body: unknown): Promise<WritebackResult>;
  /** Read a single item resource (a `.json` path). */
  read<T = unknown>(params?: RelayParams): Promise<T>;
  /** List the records of a collection resource. */
  list<T = unknown>(params?: RelayParams): Promise<T[]>;
}

/** A provider client: one {@link ResourceClient} per catalog resource. */
export type ProviderClient<P extends WritebackProvider> = {
  readonly [R in WritebackResource<P> & string]: ResourceClient;
};

/**
 * Build a resource-keyed client for any provider in the catalog. The mount
 * root / writeback options are bound once and shared by every resource.
 *
 * @example
 *   const notion = providerClient('notion');
 *   await notion.pages.write({ databaseId }, { ... });
 *   await notion.comments.path({ databaseId, pageId });
 */
export function providerClient<P extends WritebackProvider>(
  provider: P,
  opts: IntegrationClientOptions = {}
): ProviderClient<P> {
  const relay = relayClient(provider, opts);
  const out: Record<string, ResourceClient> = {};
  for (const resource of Object.keys(WRITEBACK_PATH_CATALOG[provider])) {
    const r = resource as WritebackResource<P> & string;
    out[resource] = {
      path: (params) => relay.path(r, params),
      write: (params, body) => relay.write(r, params, body),
      read: <T>(params?: RelayParams) => relay.read<T>(r, params),
      list: <T>(params?: RelayParams) => relay.list<T>(r, params)
    };
  }
  return out as ProviderClient<P>;
}
