import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCronTickEvent } from '@agent-relay/events';
import { createTrajectoryRecorder } from './trajectory.js';
import type { CompactedTrajectoryContract, WorkforceEvent } from './types.js';

const cronEvent: WorkforceEvent = createCronTickEvent({
  workspace: 'ws-1',
  schedule: '0 9 * * 6',
  scheduleId: 'weekly',
  id: 'evt-1',
  attempt: 1,
  occurredAt: '2026-01-01T00:00:00.000Z'
});

const silentLog = () => {};

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wf-traj-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function readOnlyContract(root: string, personaId: string): Promise<CompactedTrajectoryContract> {
  const dir = path.join(root, personaId, 'compacted');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, 1, `expected exactly one contract file, got ${files.join(', ')}`);
  return JSON.parse(await readFile(path.join(dir, files[0]), 'utf8')) as CompactedTrajectoryContract;
}

test('records a run and emits a contract-shaped artifact', async () => {
  await withRoot(async (root) => {
    const recorder = createTrajectoryRecorder({
      personaId: 'demo',
      agentName: 'demo',
      workspaceId: 'ws-1',
      trajectoryRoot: root,
      log: silentLog,
      autoCompact: false
    });

    await recorder.begin(cronEvent);
    await recorder.context.note('looked at the issue');
    await recorder.context.decide('lib A vs B', 'A', 'better types', [
      { option: 'B', reason: 'older' }
    ]);
    await recorder.context.done('did the thing', 0.9);

    const contract = await readOnlyContract(root, 'demo');

    // Shape matches the locked A↔B contract.
    assert.match(contract.id, /^traj_/);
    assert.equal(contract.version, 1);
    assert.equal(contract.personaId, 'demo');
    assert.equal(contract.projectId, 'ws-1'); // workspaceId fallback
    assert.equal(contract.task.title, 'cron:0 9 * * 6');
    assert.equal(contract.status, 'completed');
    assert.equal(typeof contract.startedAt, 'string');
    assert.equal(typeof contract.completedAt, 'string');

    // Decisions flattened to {question,chosen,reasoning,alternatives[]}.
    const decision = contract.decisions.find((d) => d.question === 'lib A vs B');
    assert.ok(decision, 'decision should be present');
    assert.equal(decision?.chosen, 'A');
    assert.equal(decision?.reasoning, 'better types');
    assert.deepEqual(decision?.alternatives, [{ option: 'B', reason: 'older' }]);

    // Retrospective projected to the contract subset.
    assert.equal(contract.retrospective?.summary, 'did the thing');
    assert.equal(contract.retrospective?.confidence, 0.9);
    assert.ok(Array.isArray(contract.retrospective?.learnings));

    // NOT a `trail compact` aggregate — ai-hist's filter must keep it.
    const raw = contract as unknown as Record<string, unknown>;
    assert.equal(raw.type, undefined);
    assert.equal(raw.sourceTrajectories, undefined);
  });
});

test('auto-finalizes on complete() when the handler did not call done()', async () => {
  await withRoot(async (root) => {
    const recorder = createTrajectoryRecorder({
      personaId: 'demo',
      agentName: 'demo',
      workspaceId: 'ws-1',
      trajectoryRoot: root,
      log: silentLog,
      autoCompact: false
    });

    await recorder.begin(cronEvent);
    await recorder.context.note('worked without a self-assessed retrospective');
    await recorder.complete();

    const contract = await readOnlyContract(root, 'demo');
    assert.equal(contract.status, 'completed');
    assert.ok(contract.retrospective, 'auto-finalize still emits a retrospective');
    assert.equal(contract.retrospective?.summary, 'Completed cron:0 9 * * 6');
  });
});

test('handler error abandons the run and emits an abandoned contract', async () => {
  await withRoot(async (root) => {
    const recorder = createTrajectoryRecorder({
      personaId: 'demo',
      agentName: 'demo',
      workspaceId: 'ws-1',
      trajectoryRoot: root,
      log: silentLog,
      autoCompact: false
    });

    await recorder.begin(cronEvent);
    await recorder.context.note('started');
    await recorder.fail(new Error('boom'));

    const contract = await readOnlyContract(root, 'demo');
    assert.equal(contract.status, 'abandoned');
    assert.equal(contract.completedAt !== null, true);
    assert.equal(contract.retrospective, null);
  });
});

test('done() is idempotent — a later complete() does not double-emit', async () => {
  await withRoot(async (root) => {
    const recorder = createTrajectoryRecorder({
      personaId: 'demo',
      agentName: 'demo',
      workspaceId: 'ws-1',
      trajectoryRoot: root,
      log: silentLog,
      autoCompact: false
    });

    await recorder.begin(cronEvent);
    await recorder.context.done('handler self-finalized', 0.7);
    await recorder.complete(); // should no-op

    const contract = await readOnlyContract(root, 'demo'); // asserts exactly one file
    assert.equal(contract.retrospective?.summary, 'handler self-finalized');
    assert.equal(contract.retrospective?.confidence, 0.7);
  });
});

test('recordTrajectories:false disables recording (no files, safe no-ops)', async () => {
  await withRoot(async (root) => {
    const recorder = createTrajectoryRecorder({
      personaId: 'demo',
      agentName: 'demo',
      workspaceId: 'ws-1',
      trajectoryRoot: root,
      recordTrajectories: false,
      log: silentLog
    });

    await recorder.begin(cronEvent);
    await recorder.context.note('x');
    await recorder.context.decide('q', 'c', 'r');
    await recorder.context.done('y', 1);

    await assert.rejects(readdir(path.join(root, 'demo', 'compacted')), /ENOENT/);
  });
});

test('no resolvable trajectory root → recorder is a no-op', async () => {
  await withRoot(async (root) => {
    const recorder = createTrajectoryRecorder({
      personaId: 'demo',
      agentName: 'demo',
      workspaceId: 'ws-1',
      env: {}, // no TRAJECTORY_ROOT, no explicit trajectoryRoot
      log: silentLog
    });

    await recorder.begin(cronEvent);
    await recorder.context.note('x');
    await recorder.context.done('y', 1);

    await assert.rejects(readdir(path.join(root, 'demo', 'compacted')), /ENOENT/);
  });
});
