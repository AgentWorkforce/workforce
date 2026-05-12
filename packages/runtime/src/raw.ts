/**
 * Lower-level escape hatch for power users who want the cloud
 * proactive-runtime SDK directly without workforce's `handler()` /
 * `WorkforceCtx` ergonomics. When `@agent-relay/agent` is published, this
 * file should switch to:
 *
 *   export { agent } from '@agent-relay/agent';
 *
 * Until that package is available on npm, this module exposes the same
 * shapes as documented in `cloud-proactive-runtime-spec/docs/proactive-
 * runtime/spec.md` so users can write code against the contract today
 * and swap the import once the SDK ships.
 */

export { shimEnvelope, type RawGatewayEnvelope } from './shim.js';
export type { CtxBuildOptions } from './ctx.js';
export { buildCtx } from './ctx.js';
export { startRunner, type StartRunnerOptions } from './runner.js';
