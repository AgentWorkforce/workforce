/**
 * Lower-level escape hatch for power users who want to drive the cloud
 * proactive-runtime contract directly, without workforce's `handler()` /
 * `WorkforceCtx` ergonomics.
 *
 * Note: this is deliberately NOT a re-export of `@agent-relay/agent`'s
 * `agent()`. That package is published, but it exposes a hosted-runtime
 * surface (`AgentDefinition`/`AgentHandle`/`deployAgent`) keyed off the
 * broker's *decoded* event types. Workforce instead owns its own decode
 * path (`shimEnvelope` + `buildCtx` + `startRunner`) because the wire
 * format it consumes is cloud's gateway envelope contract
 * (`envelope-fields.cloud.ts`, cloud#1841), not an SDK type. Keeping this
 * layer workforce-owned is what lets the runtime stay decoupled from the
 * relay agent SDK's versioning.
 *
 * The shapes here match `cloud-proactive-runtime-spec/docs/proactive-
 * runtime/spec.md`. Power users who specifically want the broker's hosted
 * `agent()` should import `@agent-relay/agent` themselves.
 */

export { type RawGatewayEnvelope } from './shim.js';
export { envelopeToAgentEvent } from './to-agent-event.js';
export type { CtxBuildOptions } from './ctx.js';
export { buildCtx } from './ctx.js';
export { startRunner, type StartRunnerOptions } from './runner.js';
