import type { McpServerSpec } from '@agentworkforce/workload-router';
import { type DroppedRef, makeLenientResolver, resolveStringMapLenient } from './env-refs.js';

export interface DroppedMcpServer {
  name: string;
  /** Env var names that couldn't be resolved on the server's structural fields. */
  refs: string[];
}

export interface McpResolution {
  /** Servers that resolved cleanly (or with only droppable-field losses). */
  servers: Record<string, McpServerSpec> | undefined;
  /** Non-fatal drops — specific headers / env / args entries whose ref was unset. */
  dropped: DroppedRef[];
  /** Whole servers dropped because a structural field (url, command, any arg) had an unset ref. */
  droppedServers: DroppedMcpServer[];
}

/**
 * Resolve env-var references inside an `mcpServers` block, policy: lenient.
 *
 * - Headers / env / args entries with an unresolved ref are **dropped** from
 *   the result; they surface in `dropped`.
 * - A server whose `url`, `command`, or any `arg` references an unresolved
 *   ref is dropped **entirely**; it surfaces in `droppedServers`. Structural
 *   fields can't be silently skipped — the server wouldn't launch without
 *   them.
 *
 * Literal strings pass through untouched.
 */
export function resolveMcpServersLenient(
  servers: Record<string, McpServerSpec> | undefined,
  processEnv: NodeJS.ProcessEnv
): McpResolution {
  if (!servers) return { servers: undefined, dropped: [], droppedServers: [] };
  const resolve = makeLenientResolver(processEnv);
  const out: Record<string, McpServerSpec> = {};
  const dropped: DroppedRef[] = [];
  const droppedServers: DroppedMcpServer[] = [];

  for (const [name, spec] of Object.entries(servers)) {
    const field = `mcpServers.${name}`;
    const fatalRefs: string[] = [];

    const resolveFatal = (value: string, subfield: string): string | undefined => {
      const r = resolve(value, subfield);
      if (r.ok) return r.value;
      fatalRefs.push(r.ref);
      return undefined;
    };

    if (spec.type === 'stdio') {
      const command = resolveFatal(spec.command, `${field}.command`);
      const args = spec.args?.map((a, i) => resolveFatal(a, `${field}.args[${i}]`));
      if (!command || (args && args.some((a) => a === undefined))) {
        droppedServers.push({ name, refs: fatalRefs });
        continue;
      }
      const envResolution = resolveStringMapLenient(spec.env, processEnv, `${field}.env`);
      dropped.push(...envResolution.dropped);
      out[name] = {
        type: 'stdio',
        command,
        ...(args ? { args: args as string[] } : {}),
        ...(envResolution.value ? { env: envResolution.value } : {})
      };
    } else {
      const url = resolveFatal(spec.url, `${field}.url`);
      if (!url) {
        droppedServers.push({ name, refs: fatalRefs });
        continue;
      }
      const headersResolution = resolveStringMapLenient(
        spec.headers,
        processEnv,
        `${field}.headers`
      );
      dropped.push(...headersResolution.dropped);
      out[name] = {
        type: spec.type,
        url,
        ...(headersResolution.value ? { headers: headersResolution.value } : {})
      };
    }
  }

  return {
    servers: Object.keys(out).length > 0 ? out : undefined,
    dropped,
    droppedServers
  };
}

/**
 * Format the dropped-ref tracking from env + MCP resolution into flat,
 * human-readable lines. Callers print them wherever they want — stderr,
 * a logger, a UI toast — the helper itself has no I/O.
 */
export function formatDropWarnings(
  envDrops: DroppedRef[],
  mcpDrops: DroppedRef[],
  mcpServerDrops: DroppedMcpServer[]
): string[] {
  const lines: string[] = [];
  for (const d of envDrops) {
    lines.push(`${d.field} dropped (env var ${d.ref} is not set).`);
  }
  for (const d of mcpDrops) {
    lines.push(`${d.field} dropped (env var ${d.ref} is not set).`);
  }
  for (const d of mcpServerDrops) {
    lines.push(
      `mcpServers.${d.name} dropped entirely (required fields referenced unset env vars: ${d.refs.join(', ')}).`
    );
  }
  return lines;
}
