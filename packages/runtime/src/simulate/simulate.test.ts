import test from 'node:test';
import assert from 'node:assert/strict';
import type { PersonaSpec } from '@agentworkforce/persona-kit';
import { handler } from '../handler.js';
import type { RawGatewayEnvelope } from '../shim.js';
import { deriveSimulatedRunFailureClass } from './failure-class.js';
import { simulateInvocation } from './simulate.js';
import { createSimulationSubsystems } from './subsystems.js';
import type { SimulationSink } from './subsystems.js';

const persona: PersonaSpec = {
  id: 'sim-demo',
  intent: 'documentation',
  tags: ['documentation'],
  description: 'simulation test persona',
  skills: [],
  harness: 'claude',
  model: 'anthropic/claude-3-5-sonnet',
  systemPrompt: 'be helpful',
  harnessSettings: { reasoning: 'medium', timeoutSeconds: 300 },
  cloud: true
};

const cronEnvelope: RawGatewayEnvelope = {
  id: 'e1',
  workspace: 'ws-test',
  type: 'cron.tick',
  occurredAt: '2026-05-12T09:00:00Z',
  name: 'weekly',
  cron: '0 9 * * 6'
};

const githubEnvelope: RawGatewayEnvelope = {
  id: 'e2',
  workspace: 'ws-test',
  type: 'github.pull_request.opened',
  occurredAt: '2026-05-12T10:00:00Z',
  resource: { action: 'opened', pull_request: { number: 123 } },
  summary: { title: 'Fix bug' }
};

function deterministicIds(): () => string {
  let seq = 0;
  return () => `sim_run_${++seq}`;
}

function tickingClock(startMs = Date.parse('2026-06-03T12:00:00Z'), stepMs = 5): () => Date {
  let current = startMs;
  return () => new Date((current += stepMs));
}

test('simulateInvocation: successful run emits a Cloud-compatible record', async () => {
  const result = await simulateInvocation({
    persona,
    handler: handler(async (ctx, event) => {
      ctx.log('info', 'saw event', { id: event.id });
      return 'handled weekly tick' as unknown as void;
    }),
    envelopes: [cronEnvelope],
    runIdFactory: deterministicIds(),
    now: tickingClock()
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.origin, 'local_dry_run');
  assert.equal(result.summary.total, 1);
  assert.equal(result.summary.succeeded, 1);
  assert.equal(result.summary.failed, 0);

  const run = result.runs[0];
  // Core compact shape — field-for-field with Cloud's hosted compactBase
  // + detail logs (cloud#1788), origin swapped to local_dry_run.
  assert.equal(run.runId, 'sim_run_1');
  assert.equal(run.deploymentId, 'sim-deployment');
  assert.equal(run.agentId, 'sim-agent');
  assert.equal(run.status, 'succeeded');
  assert.equal(run.exitCode, 0);
  assert.equal(run.summary, 'handled weekly tick');
  assert.equal(run.error, null);
  assert.ok(run.startedAt.endsWith('Z'));
  assert.ok(run.endedAt.endsWith('Z'));
  assert.ok(run.durationMs >= 0);
  assert.deepEqual(run.trigger, { kind: 'clock', eventSource: 'cron' });
  assert.deepEqual(run.sandbox, { id: null, name: 'local-simulation' });
  assert.equal(run.failureClass, 'success');
  assert.equal(run.origin, 'local_dry_run');
  assert.equal(run.logs.mountLogTail, '');
  assert.equal(run.logs.stdoutTruncated, false);
  assert.equal(run.logs.stderrTruncated, false);
  assert.match(run.logs.stdout, /"message":"saw event"/);
  assert.equal(run.logs.stderr, '');
  assert.equal(run.simulation.mode, 'simulate');
});

test('simulateInvocation: handler throw → failed run, replay continues', async () => {
  const result = await simulateInvocation({
    persona,
    handler: handler(async (_ctx, event) => {
      if (event.source === 'cron') throw new Error('boom on cron');
    }),
    envelopes: [cronEnvelope, githubEnvelope],
    runIdFactory: deterministicIds(),
    now: tickingClock()
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.summary.total, 2);
  assert.equal(result.summary.succeeded, 1);
  assert.equal(result.summary.failed, 1);

  const [failed, succeeded] = result.runs;
  assert.equal(failed.status, 'failed');
  assert.equal(failed.exitCode, 1);
  assert.equal(failed.error, 'boom on cron');
  assert.equal(failed.summary, 'boom on cron'); // first error message fills summary
  assert.equal(failed.failureClass, 'runner_error');
  assert.equal(succeeded.status, 'succeeded');
  assert.deepEqual(succeeded.trigger, { kind: 'inbox', eventSource: 'github' });
});

test('simulateInvocation: every side-effect channel is recorded, not executed', async () => {
  const result = await simulateInvocation({
    persona,
    handler: handler(async (ctx) => {
      await ctx.harness.run({ prompt: 'do the thing' });
      await ctx.llm.complete('quick question');
      await ctx.sandbox.exec('rm -rf / --no-preserve-root');
      await ctx.sandbox.writeFile('/notes.txt', 'written in sim');
      await ctx.sandbox.readFile('/notes.txt');
      await ctx.files.write('/slack/outbox/msg.json', '{"text":"hi"}');
      await ctx.files.read('/slack/outbox/msg.json');
      await ctx.memory.save('remember this', { scope: 'workspace' });
      await ctx.memory.recall('anything?');
      const wf = await ctx.workflow.run('reindex', { full: true });
      await ctx.workflow.status(wf.runId);
      await ctx.schedule.at(new Date('2026-06-04T00:00:00Z'), { follow: 'up' });
      await ctx.schedule.cancel('weekly');
    }),
    envelopes: [cronEnvelope],
    runIdFactory: deterministicIds(),
    now: tickingClock()
  });

  assert.equal(result.exitCode, 0);
  const kinds = result.runs[0].simulation.sideEffects.map((effect) => effect.kind);
  assert.deepEqual(kinds, [
    'harness.run',
    'llm.complete',
    'sandbox.exec',
    'sandbox.writeFile',
    'sandbox.readFile',
    'files.write',
    'files.read',
    'memory.save',
    'memory.recall',
    'workflow.run',
    'workflow.status',
    'schedule.at',
    'schedule.cancel'
  ]);
  // The dangerous exec was recorded with an inert simulated result.
  const exec = result.runs[0].simulation.sideEffects.find((e) => e.kind === 'sandbox.exec');
  assert.equal((exec?.simulatedResult as { exitCode: number }).exitCode, 0);
  assert.match(String((exec?.simulatedResult as { note: string }).note), /not executed/);
});

test('simulateInvocation: reads of unseeded paths fail with a seeding hint', async () => {
  const result = await simulateInvocation({
    persona,
    handler: handler(async (ctx) => {
      await ctx.files.read('/slack/channels/_index.json');
    }),
    envelopes: [cronEnvelope],
    runIdFactory: deterministicIds(),
    now: tickingClock()
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.runs[0].error ?? '', /never seeded or written/);
  assert.match(result.runs[0].error ?? '', /`files` option/);
});

test('simulateInvocation: seeded files are readable; VFS persists across envelopes', async () => {
  const reads: string[] = [];
  const result = await simulateInvocation({
    persona,
    handler: handler(async (ctx, event) => {
      if (event.source === 'cron') {
        reads.push(await ctx.files.read('/seeded.json'));
        await ctx.files.write('/from-event-1.txt', 'carried over');
      } else {
        reads.push(await ctx.files.read('/from-event-1.txt'));
      }
    }),
    envelopes: [cronEnvelope, githubEnvelope],
    files: { '/seeded.json': '{"ok":true}' },
    runIdFactory: deterministicIds(),
    now: tickingClock()
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(reads, ['{"ok":true}', 'carried over']);
});

test('simulateInvocation: unsupported envelopes are reported, not dispatched', async () => {
  const unknownEnvelope: RawGatewayEnvelope = {
    id: 'e3',
    workspace: 'ws-test',
    type: 'unknownprovider.something',
    occurredAt: '2026-05-12T11:00:00Z'
  };
  let invocations = 0;
  const result = await simulateInvocation({
    persona,
    handler: handler(async () => {
      invocations += 1;
    }),
    envelopes: [unknownEnvelope, cronEnvelope],
    runIdFactory: deterministicIds(),
    now: tickingClock()
  });

  assert.equal(invocations, 1);
  assert.equal(result.summary.total, 1);
  assert.equal(result.summary.unsupported, 1);
  assert.deepEqual(result.unsupported, [{ id: 'e3', type: 'unknownprovider.something' }]);
  assert.equal(result.exitCode, 0); // unsupported is not a failure
});

test('simulateInvocation: workspaceId falls back to the first envelope workspace', async () => {
  let seen: string | null = null;
  await simulateInvocation({
    persona,
    handler: handler(async (ctx) => {
      seen = ctx.workspaceId;
    }),
    envelopes: [cronEnvelope],
    runIdFactory: deterministicIds(),
    now: tickingClock()
  });
  assert.equal(seen, 'ws-test');
});

test('simulateInvocation: explicit deployment triggerKind overrides derivation', async () => {
  const result = await simulateInvocation({
    persona,
    handler: handler(async () => {}),
    envelopes: [cronEnvelope],
    deployment: { triggerKind: 'radio' },
    runIdFactory: deterministicIds(),
    now: tickingClock()
  });
  assert.equal(result.runs[0].trigger.kind, 'radio');
});

test('simulateInvocation: raw (unbranded) handler is accepted', async () => {
  const result = await simulateInvocation({
    persona,
    handler: async () => {},
    envelopes: [cronEnvelope],
    runIdFactory: deterministicIds(),
    now: tickingClock()
  });
  assert.equal(result.exitCode, 0);
});

test('deriveSimulatedRunFailureClass: failed status can never read as success', () => {
  assert.equal(deriveSimulatedRunFailureClass({ status: 'succeeded', error: null }), 'success');
  assert.equal(deriveSimulatedRunFailureClass({ status: 'failed', error: 'x' }), 'runner_error');
  // The cloud#1788 invariant: error present → never success, even with a
  // success-ish status.
  assert.equal(deriveSimulatedRunFailureClass({ status: 'succeeded', error: 'late error' }), 'runner_error');
});

test('createSimulationSubsystems: sink swap attributes effects per run', async () => {
  const subsystems = createSimulationSubsystems({ now: tickingClock() });
  const first: SimulationSink = { sideEffects: [], logs: [] };
  const second: SimulationSink = { sideEffects: [], logs: [] };

  subsystems.useSink(first);
  await subsystems.memory.save('one');
  subsystems.useSink(second);
  await subsystems.memory.save('two');

  assert.equal(first.sideEffects.length, 1);
  assert.equal(second.sideEffects.length, 1);
  assert.equal(subsystems.vfsSnapshot()['/x'], undefined);
});
