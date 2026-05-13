import test from 'node:test';
import assert from 'node:assert/strict';
import { schedulerBindingFromCtx, toProactiveSession } from './proactive.js';
import type { WorkforceCtx } from './types.js';

function fakeCtx(over: Partial<WorkforceCtx> = {}): WorkforceCtx {
  const scheduleAt: Array<{ at: Date; payload: unknown }> = [];
  const scheduleCancel: string[] = [];
  return {
    persona: {
      id: 'demo',
      intent: 'documentation',
      tags: ['documentation'],
      description: '',
      skills: [],
      harness: 'claude',
      model: 'anthropic/claude-3-5-sonnet',
      systemPrompt: 'be helpful',
      harnessSettings: { reasoning: 'medium', timeoutSeconds: 300 }
    },
    workspaceId: 'ws-acme',
    agentName: 'reviewer',
    llm: {
      async complete() {
        throw new Error('not configured');
      }
    },
    harness: {
      async run() {
        return { output: '', exitCode: 0, durationMs: 0 };
      }
    },
    sandbox: {
      cwd: '/tmp',
      async exec() {
        return { output: '', exitCode: 0 };
      },
      async readFile() {
        return '';
      },
      async writeFile() {
        /* no-op */
      }
    },
    memory: {
      async save() {
        /* no-op */
      },
      async recall() {
        return [];
      }
    },
    workflow: {
      async run() {
        throw new Error('not configured');
      },
      async status() {
        throw new Error('not configured');
      }
    },
    schedule: {
      async at(at, payload) {
        scheduleAt.push({ at, payload });
      },
      async cancel(name) {
        scheduleCancel.push(name);
      }
    },
    log: () => undefined,
    ...over
  } as WorkforceCtx & {
    schedule: WorkforceCtx['schedule'] & {
      _at: typeof scheduleAt;
      _cancel: typeof scheduleCancel;
    };
  };
}

test('toProactiveSession builds a stable session descriptor from ctx', () => {
  const ctx = fakeCtx();
  const session = toProactiveSession(ctx);
  // RuntimeInteropSession shape: stable id keyed by workspace + agent.
  assert.equal(session.id, 'ws-acme:reviewer');
  assert.equal(session.userId, 'agent:ws-acme:reviewer');
  assert.equal(session.workspaceId, 'ws-acme');
  assert.match(session.surfaceId, /^proactive-runtime:ws-acme:reviewer$/);
  assert.equal(session.metadata.source, 'proactive-runtime');
  assert.equal(session.metadata.agentId, 'reviewer');
});

test('toProactiveSession honors an explicit agentId override', () => {
  const session = toProactiveSession(fakeCtx(), { agentId: 'alt-agent' });
  assert.equal(session.id, 'ws-acme:alt-agent');
  assert.equal(session.metadata.agentId, 'alt-agent');
});

test('schedulerBindingFromCtx routes requestWakeUp through ctx.schedule.at', async () => {
  const calls: Array<{ at: Date; payload: unknown }> = [];
  const ctx = fakeCtx({
    schedule: {
      async at(at, payload) {
        calls.push({ at, payload });
      },
      async cancel() {
        /* unused here */
      }
    }
  });
  const binding = schedulerBindingFromCtx(ctx);
  const at = new Date('2026-05-13T09:00:00Z');
  const id = await binding.requestWakeUp(at, { reason: 'follow-up' } as never);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].at.toISOString(), at.toISOString());
  // The bindingId is a stable per-agent slot name so a pre-registered
  // persona schedule slot can be cancelled by `cancelWakeUp`. It is not
  // per-timestamp, since `ctx.schedule.at` does not accept caller names.
  assert.equal(id, 'proactive-reviewer');
});

test('schedulerBindingFromCtx routes cancelWakeUp through ctx.schedule.cancel', async () => {
  const cancelled: string[] = [];
  const ctx = fakeCtx({
    schedule: {
      async at() {
        /* unused here */
      },
      async cancel(name) {
        cancelled.push(name);
      }
    }
  });
  const binding = schedulerBindingFromCtx(ctx);
  await binding.cancelWakeUp('proactive-reviewer');
  assert.deepEqual(cancelled, ['proactive-reviewer']);
});
