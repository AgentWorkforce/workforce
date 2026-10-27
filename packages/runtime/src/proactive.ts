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
 * IMPORTANT: the adapter closes over the supplied `ctx`, so the binding
 * must be rebuilt per event invocation. Reusing a binding constructed
 * with a previous invocation's ctx would route wake-ups through stale
 * schedule / sandbox / workspace handles. Treat the binding as request-
 * scoped, the same way `ctx` itself is.
 *
 * Wake-ups use a stable `proactive-${agentName}` dynamic-schedule name, so
 * Agent Assistant's returned binding id can be passed directly to
 * `cancelWakeUp` without a predeclared cron slot.
 */
export function schedulerBindingFromCtx(ctx: WorkforceCtx): ContextSchedulerBinding {
  const slotName = bindingSlotFor(ctx.agentName);
  const adapter: RuntimeScheduleContext = {
    scheduleWakeUp: async (at, context) => {
      const receipt = await ctx.schedule.at(at, context, { name: slotName });
      // A stable per-agent name gives Agent Assistant a cancellation identity
      // without coupling it to Cloud's internal schedule id.
      return { bindingId: receipt?.name ?? slotName };
    },
    cancelWakeUp: async (bindingId) => {
      await ctx.schedule.cancel(bindingId);
    }
  };
  return new ContextSchedulerBinding(adapter);
}

function bindingSlotFor(agentName: string): string {
  return `proactive-${agentName}`;
}

// Re-export the underlying types so callers can build their own adapters
// without a second import from `@agent-assistant/proactive`.
export type {
  RuntimeInteropSession,
  RuntimeScheduleContext
} from '@agent-assistant/proactive';
export { ContextSchedulerBinding, RuntimeSchedulerBinding } from '@agent-assistant/proactive';
