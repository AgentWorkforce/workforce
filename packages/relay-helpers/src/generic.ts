import {
  draftFile,
  encodeSegment,
  listJsonFiles,
  readJsonFile,
  writeJsonFile,
  type IntegrationClientOptions,
  type WritebackResult
} from '@agentworkforce/runtime/clients';
import {
  WRITEBACK_PATH_CATALOG,
  writebackPath,
  type WritebackProvider,
  type WritebackResource
} from '@relayfile/adapter-core/writeback-paths';

export type RelayParams = Record<string, string | number>;

/**
 * A catalog-backed client for one provider. Every path comes from
 * `@relayfile/adapter-core/writeback-paths` (the adapter-owned source of
 * truth), so handlers never hardcode `/linear/issues/...` strings that drift
 * from the adapter. Works for any provider in the catalog; the
 * `linearClient` / `githubClient` / `slackClient` factories wrap this with
 * named, ergonomic methods.
 */
export interface RelayClient<P extends WritebackProvider> {
  readonly provider: P;
  /** Resolve a resource's canonical mount path (no IO). */
  path(resource: WritebackResource<P> & string, params?: RelayParams): string;
  /**
   * Write `body`. For a collection resource (e.g. `/linear/issues/{id}/comments`)
   * this drops a uniquely-named draft the Relayfile writeback worker turns into
   * the create call. For an item resource (a path ending in `.json`, e.g.
   * `…/pulls/{n}/merge.json`) this writes the body to that exact path.
   */
  write(resource: WritebackResource<P> & string, params: RelayParams, body: unknown): Promise<WritebackResult>;
  /** Read a single item resource (a `.json` path). */
  read<T>(resource: WritebackResource<P> & string, params?: RelayParams): Promise<T>;
  /** List the records of a collection resource. */
  list<T>(resource: WritebackResource<P> & string, params?: RelayParams): Promise<T[]>;
}

function isItemPath(path: string): boolean {
  return path.endsWith('.json');
}

/**
 * Build a {@link RelayClient} for `provider`. `opts` (mount root, writeback
 * timeout, …) is bound once and reused by every method; it defaults to the
 * ambient `RELAYFILE_MOUNT_ROOT` env, so `relayClient('linear')` is enough
 * inside a sandbox handler.
 */
export function relayClient<P extends WritebackProvider>(
  provider: P,
  opts: IntegrationClientOptions = {}
): RelayClient<P> {
  const knownResources = (): string => Object.keys(WRITEBACK_PATH_CATALOG[provider] ?? {}).join(', ');
  return {
    provider,
    path(resource, params = {}) {
      return writebackPath(provider, resource, params);
    },
    async write(resource, params, body) {
      const base = writebackPath(provider, resource, params);
      const target = isItemPath(base) ? base : `${base}/${draftFile(String(resource))}`;
      return writeJsonFile(opts, provider, `write.${String(resource)}`, target, body);
    },
    read<T>(resource: WritebackResource<P> & string, params: RelayParams = {}): Promise<T> {
      const path = writebackPath(provider, resource, params);
      if (!isItemPath(path)) {
        throw new Error(
          `read("${String(resource)}") resolves to collection "${path}"; read a specific item path or use list(). Known resources for ${provider}: ${knownResources()}`
        );
      }
      return readJsonFile<T>(opts, provider, `read.${String(resource)}`, path);
    },
    async list<T>(resource: WritebackResource<P> & string, params: RelayParams = {}): Promise<T[]> {
      const path = writebackPath(provider, resource, params);
      if (isItemPath(path)) {
        throw new Error(
          `list("${String(resource)}") resolves to item "${path}"; use read() instead. Known resources for ${provider}: ${knownResources()}`
        );
      }
      const files = await listJsonFiles<T>(opts, provider, `list.${String(resource)}`, path);
      return files.map((file) => file.value);
    }
  };
}

/** Re-exported so callers can build item-read paths (`${collection}/${id}.json`). */
export { encodeSegment, type IntegrationClientOptions, type WritebackResult };
