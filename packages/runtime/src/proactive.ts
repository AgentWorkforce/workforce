/**
 * Bridge between workforce's `WorkforceCtx` and the
 * `@agent-assistant/proactive` runtime-interop primitives.
 *
 * The agent-assistant proactive package exposes two pieces workforce can
 * compose with:
 *
 *   - `fromContext({ workspaceId, agentId })` → a stable
 *     `RuntimeInteropSession` descriptor agent-assistant's session/memory/
 *     scheduling primitives consume. This is how workforce handlers
 *     can call into agent-assistant tooling without re-rolling the
 *     session-key convention.
 *   - `ContextSchedulerBinding` (re-exported as `RuntimeSchedulerBinding`)
 *     — a `SchedulerBinding` implementation that delegates to a
 *     `scheduleWakeUp`/`cancelWakeUp` pair supplied on a runtime ctx.
 *     The workforce runtime's `ctx.schedule.at` / `ctx.schedule.cancel`
 *     methods have the same shape, so this binding lets the proactive
 *     engine drive wake-ups through workforce's schedule context.
 *
 * Today the bridge is opt-in: handlers import `toProactiveSession(ctx)`
 * or `schedulerBindingFromCtx(ctx)` when they need agent-assistant
 * primitives. The runtime itself does not auto-wire either. When the
 * workforce side adopts agent-assistant sessions for stateful turn
 * tracking, the wiring lifts up into `buildCtx`.
 */

import {
  ContextSchedulerBinding,
  fromContext as proactiveFromContext,
  type RuntimeInteropSession,
  type RuntimeScheduleContext
} from '@agent-assistant/proactive';
import type { WorkforceCtx } from './types.js';

/**
 * Map a workforce ctx into the `RuntimeInteropSession` shape
 * agent-assistant's session-scoped primitives expect.
 *
 * `agentId` defaults to `ctx.agentName` (which itself defaults to
 * `ctx.persona.id`). Callers who need a different agent identity (e.g.
 * one workforce ctx that fans out to multiple agent-assistant sessions)
 * pass `agentId` explicitly.
 */
export function toProactiveSession(
  ctx: WorkforceCtx,
  options: { agentId?: string } = {}
): RuntimeInteropSession {
  return proactiveFromContext({
    workspaceId: ctx.workspaceId,
    agentId: options.agentId ?? ctx.agentName
  });
}

/**
 * Construct a `SchedulerBinding` that routes wake-up requests through a
 * workforce ctx. Pass the binding into `createProactiveEngine` to let
 * agent-assistant's proactive engine schedule its own follow-ups using
 * workforce's `ctx.schedule.at` / `ctx.schedule.cancel`.
 *
 * The returned binding stores the supplied adapter; it does not capture
 * `ctx` directly. This keeps the binding usable across event invocations
 * — the handler builds the adapter once and reuses it.
 */
export function schedulerBindingFromCtx(ctx: WorkforceCtx): ContextSchedulerBinding {
  const adapter: RuntimeScheduleContext = {
    scheduleWakeUp: async (at, context) => {
      await ctx.schedule.at(at, context);
      // The proactive package wants a binding id back. We use the wake-up
      // ISO timestamp + agent name as a deterministic key so cancel calls
      // can find the same slot. Workforce's `ctx.schedule.cancel` takes a
      // schedule name; the persona's schedules list is the authoritative
      // source so callers pre-register a slot for proactive wake-ups
      // (e.g. "proactive-followups") and we return that name as the id.
      return { bindingId: bindingIdFor(at, ctx.agentName) };
    },
    cancelWakeUp: async (bindingId) => {
      await ctx.schedule.cancel(bindingId);
    }
  };
  return new ContextSchedulerBinding(adapter);
}

function bindingIdFor(at: Date, agentName: string): string {
  return `proactive-${agentName}-${at.toISOString()}`;
}

// Re-export the underlying types so callers can build their own adapters
// without a second import from `@agent-assistant/proactive`.
export type {
  RuntimeInteropSession,
  RuntimeScheduleContext
} from '@agent-assistant/proactive';
export { ContextSchedulerBinding, RuntimeSchedulerBinding } from '@agent-assistant/proactive';
