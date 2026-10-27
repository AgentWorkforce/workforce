import type { WorkforceHandler, WorkforceHandlerExport } from './types.js';

/**
 * Brand a user-supplied event handler so the runtime can recognize it
 * after dynamic import. Identity at runtime — `handler(fn) === fn` with
 * an added non-enumerable marker. The wrapper exists so we can grow the
 * handler-side API later (e.g. lifecycle hooks, declared capabilities)
 * without breaking older bundles.
 *
 * Usage:
 * ```ts
 * import { handler, writeJsonFile, resolveMountRoot } from '@agentworkforce/runtime';
 *
 * export default handler(async (ctx, event) => {
 *   if (event.source === 'github' && event.type === 'pull_request.opened') {
 *     await writeJsonFile(
 *       { relayfileMountRoot: resolveMountRoot({}) },
 *       'github',
 *       'comment',
 *       `/github/repos/${owner}/${repo}/issues/${number}/comments/${draftFile('comment')}`,
 *       { body: '…' }
 *     );
 *   }
 * });
 * ```
 */
export function handler(fn: WorkforceHandler): WorkforceHandlerExport {
  if (typeof fn !== 'function') {
    throw new TypeError('handler() expects a function');
  }
  Object.defineProperty(fn, '__workforceHandler', {
    value: true,
    writable: false,
    enumerable: false,
    configurable: false
  });
  return fn as WorkforceHandlerExport;
}

/**
 * Detect whether a value looks like a branded workforce handler. Used by
 * the runner to validate the bundle's default export before invoking it.
 */
export function isWorkforceHandler(value: unknown): value is WorkforceHandlerExport {
  return (
    typeof value === 'function' &&
    (value as { __workforceHandler?: unknown }).__workforceHandler === true
  );
}
