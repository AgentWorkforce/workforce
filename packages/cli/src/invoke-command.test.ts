import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  extractBundleHandler,
  parseFixtureEnvelopes,
  parseInvokeArgs,
  renderHumanSummary,
  runInvoke,
  scaffoldFixture,
  type RunInvokeIO
} from './invoke-command.js';
import type { SimulationResult } from '@agentworkforce/runtime';

// ---------------------------------------------------------------------------
// parseInvokeArgs

test('parseInvokeArgs: persona + fixture + repeatable flags', () => {
  const parsed = parseInvokeArgs([
    './persona.json',
    '--fixture',
    './event.json',
    '--input',
    'SLACK_CHANNEL=#general',
    '--input=REGION=eu',
    '--seed',
    '/slack/channels/_index.json=./channels.json',
    '--workspace',
    'ws-123',
    '--output',
    './run.json'
  ]);
  assert.ok(!('help' in parsed) && !('scaffold' in parsed));
  if ('help' in parsed || 'scaffold' in parsed) return;
  assert.equal(path.basename(parsed.personaPath), 'persona.json');
  assert.equal(path.basename(parsed.fixturePath), 'event.json');
  assert.equal(path.basename(parsed.outputPath ?? ''), 'run.json');
  assert.deepEqual(parsed.inputs, { SLACK_CHANNEL: '#general', REGION: 'eu' });
  assert.deepEqual(parsed.seeds, { '/slack/channels/_index.json': './channels.json' });
  assert.equal(parsed.workspaceId, 'ws-123');
});

test('parseInvokeArgs: -h returns help sentinel', () => {
  assert.deepEqual(parseInvokeArgs(['-h']), { help: true });
});

test('parseInvokeArgs: missing persona path throws', () => {
  assert.throws(() => parseInvokeArgs(['--fixture', 'x.json']), /missing persona path/);
});

test('parseInvokeArgs: missing --fixture throws', () => {
  assert.throws(() => parseInvokeArgs(['./persona.json']), /missing --fixture/);
});

test('parseInvokeArgs: unknown flag throws', () => {
  assert.throws(
    () => parseInvokeArgs(['./persona.json', '--fixture', 'x.json', '--bogus']),
    /unknown flag "--bogus"/
  );
});

// ---------------------------------------------------------------------------
// parseFixtureEnvelopes

const ENVELOPE = {
  id: 'e1',
  workspace: 'ws-test',
  type: 'cron.tick',
  occurredAt: '2026-05-12T09:00:00Z',
  name: 'weekly',
  cron: '0 9 * * 6'
};

test('parseFixtureEnvelopes: single JSON object (incl. pretty-printed)', () => {
  const parsed = parseFixtureEnvelopes(JSON.stringify(ENVELOPE, null, 2), 'event.json');
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].id, 'e1');
});

test('parseFixtureEnvelopes: JSON array', () => {
  const parsed = parseFixtureEnvelopes(JSON.stringify([ENVELOPE, { ...ENVELOPE, id: 'e2' }]), 'events.json');
  assert.deepEqual(parsed.map((e) => e.id), ['e1', 'e2']);
});

test('parseFixtureEnvelopes: NDJSON lines', () => {
  const ndjson = `${JSON.stringify(ENVELOPE)}\n${JSON.stringify({ ...ENVELOPE, id: 'e2' })}\n`;
  const parsed = parseFixtureEnvelopes(ndjson, 'events.ndjson');
  assert.deepEqual(parsed.map((e) => e.id), ['e1', 'e2']);
});

test('parseFixtureEnvelopes: empty / malformed inputs throw with the label', () => {
  assert.throws(() => parseFixtureEnvelopes('   ', 'empty.json'), /empty\.json is empty/);
  assert.throws(() => parseFixtureEnvelopes('not json', 'bad.json'), /must be a JSON envelope object/);
  assert.throws(() => parseFixtureEnvelopes('[{"id":"x"}, 42]', 'mixed.json'), /mixed\.json\[1\] must be a JSON object/);
  assert.throws(
    () => parseFixtureEnvelopes(`${JSON.stringify(ENVELOPE)}\nnot-json\n`, 'lines.ndjson'),
    /lines\.ndjson:2 is not valid JSON/
  );
});

// ---------------------------------------------------------------------------
// extractBundleHandler — mirrors the generated runner.mjs extraction

test('extractBundleHandler: defineAgent default export', () => {
  const handler = async () => {};
  const extracted = extractBundleHandler(
    { default: { __workforceAgent: true, handler, schedules: [] } },
    'p1'
  );
  assert.equal(extracted, handler);
});

test('extractBundleHandler: plain { handler } object', () => {
  const handler = async () => {};
  assert.equal(extractBundleHandler({ default: { handler } }, 'p2'), handler);
});

test('extractBundleHandler: bare function fallback', () => {
  const handler = async () => {};
  assert.equal(extractBundleHandler({ default: handler }, 'p3'), handler);
});

test('extractBundleHandler: non-function throws the defineAgent hint', () => {
  assert.throws(() => extractBundleHandler({ default: { nope: true } }, 'p4'), /defineAgent/);
});

// ---------------------------------------------------------------------------
// End-to-end: real preflight → real esbuild bundle → simulateInvocation.
//
// The temp persona lives INSIDE packages/cli (not os.tmpdir) on purpose: the
// staged bundle leaves `@agentworkforce/runtime` external, so Node must be
// able to walk up from the bundle to a node_modules that provides it — same
// constraint deploy's `.workforce/build/` placement satisfies.

const E2E_PERSONA = {
  id: 'invoke-e2e',
  intent: 'documentation',
  tags: ['documentation'],
  description: 'invoke e2e persona',
  harness: 'claude',
  model: 'anthropic/claude-3-5-sonnet',
  systemPrompt: 'be helpful',
  harnessSettings: { reasoning: 'medium', timeoutSeconds: 300 },
  cloud: true,
  onEvent: './agent.ts'
};

const E2E_AGENT_SRC = `import { defineAgent, isCronTickEvent } from '@agentworkforce/runtime';
export default defineAgent({
  schedules: [{ name: 'weekly', cron: '0 9 * * 6' }],
  handler: async (ctx, event) => {
    ctx.log('info', 'e2e handler ran', { id: event.id });
    await ctx.memory.save('e2e note');
    if (isCronTickEvent(event) && event.schedule === 'explode') {
      throw new Error('fixture asked for failure');
    }
    return 'weekly digest sent';
  }
});
`;

function collectingIO(): RunInvokeIO & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: (text: string) => {
      out.push(text);
    },
    stderr: (text: string) => {
      err.push(text);
    }
  };
}

async function withE2EPersona<T>(
  fn: (dir: string, personaPath: string) => Promise<T>
): Promise<T> {
  const dir = await mkdtemp(path.join(process.cwd(), '.invoke-e2e-'));
  const personaPath = path.join(dir, 'persona.json');
  try {
    await writeFile(personaPath, JSON.stringify(E2E_PERSONA, null, 2), 'utf8');
    await writeFile(path.join(dir, 'agent.ts'), E2E_AGENT_SRC, 'utf8');
    return await fn(dir, personaPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('runInvoke e2e: bundles, simulates, emits Cloud-compatible record', async () => {
  await withE2EPersona(async (dir, personaPath) => {
    const fixturePath = path.join(dir, 'event.json');
    await writeFile(fixturePath, JSON.stringify(ENVELOPE), 'utf8');

    const io = collectingIO();
    const previousExitCode = process.exitCode;
    const result = await runInvoke([personaPath, '--fixture', fixturePath], io);
    const exitCode = process.exitCode;
    process.exitCode = previousExitCode;

    assert.ok(result, `expected a result; stderr: ${io.err.join('')}`);
    assert.equal(exitCode, 0);
    assert.equal(result.summary.total, 1);
    assert.equal(result.runs[0].status, 'succeeded');
    assert.equal(result.runs[0].origin, 'local_dry_run');
    assert.equal(result.runs[0].summary, 'weekly digest sent');
    assert.equal(result.runs[0].failureClass, 'success');
    // The memory.save the handler made was recorded, not executed.
    assert.ok(result.runs[0].simulation.sideEffects.some((e) => e.kind === 'memory.save'));
    // ctx.log landed in the record's stdout stream.
    assert.match(result.runs[0].logs.stdout, /e2e handler ran/);

    // stdout got the machine record; stderr got the human summary.
    const machine = JSON.parse(io.out.join('')) as SimulationResult;
    assert.equal(machine.runs[0].runId, result.runs[0].runId);
    assert.match(io.err.join(''), /1 run\(s\) — 1 ok, 0 failed/);

    // Build dir was cleaned up.
    const { readdir } = await import('node:fs/promises');
    const buildRoot = path.join(dir, '.workforce', 'invoke-build');
    const leftover = await readdir(buildRoot).catch(() => []);
    assert.deepEqual(leftover, []);
  });
});

test('runInvoke e2e: handler failure → exit 1, error in record', async () => {
  await withE2EPersona(async (dir, personaPath) => {
    const fixturePath = path.join(dir, 'events.ndjson');
    const failing = { ...ENVELOPE, id: 'e-fail', cron: 'explode' };
    await writeFile(
      fixturePath,
      `${JSON.stringify(failing)}\n${JSON.stringify(ENVELOPE)}\n`,
      'utf8'
    );

    const io = collectingIO();
    const previousExitCode = process.exitCode;
    const result = await runInvoke([personaPath, '--fixture', fixturePath], io);
    const exitCode = process.exitCode;
    process.exitCode = previousExitCode;

    assert.ok(result, `expected a result; stderr: ${io.err.join('')}`);
    assert.equal(exitCode, 1);
    assert.equal(result.summary.failed, 1);
    assert.equal(result.summary.succeeded, 1);
    assert.equal(result.runs[0].status, 'failed');
    assert.equal(result.runs[0].error, 'fixture asked for failure');
    assert.equal(result.runs[0].failureClass, 'runner_error');
    assert.equal(result.runs[1].status, 'succeeded');
  });
});

test('runInvoke e2e: --output writes the record to a file', async () => {
  await withE2EPersona(async (dir, personaPath) => {
    const fixturePath = path.join(dir, 'event.json');
    const outputPath = path.join(dir, 'run.json');
    await writeFile(fixturePath, JSON.stringify(ENVELOPE), 'utf8');

    const io = collectingIO();
    const previousExitCode = process.exitCode;
    const result = await runInvoke(
      [personaPath, '--fixture', fixturePath, '--output', outputPath],
      io
    );
    process.exitCode = previousExitCode;

    assert.ok(result);
    assert.equal(io.out.join(''), '');
    const { readFile } = await import('node:fs/promises');
    const written = JSON.parse(await readFile(outputPath, 'utf8')) as SimulationResult;
    assert.equal(written.origin, 'local_dry_run');
    assert.match(io.err.join(''), /run record written to/);
  });
});

test('runInvoke: usage error prints usage and sets exit 1, no throw', async () => {
  const io = collectingIO();
  const previousExitCode = process.exitCode;
  const result = await runInvoke(['--fixture', 'x.json'], io);
  const exitCode = process.exitCode;
  process.exitCode = previousExitCode;

  assert.equal(result, undefined);
  assert.equal(exitCode, 1);
  assert.match(io.err.join(''), /missing persona path/);
  assert.match(io.err.join(''), /usage: agentworkforce invoke/);
});

// ---------------------------------------------------------------------------
// renderHumanSummary

test('renderHumanSummary: lists runs with status, side-effect count, skips', () => {
  const summary = renderHumanSummary({
    origin: 'local_dry_run',
    mode: 'simulate',
    startedAt: 't0',
    endedAt: 't1',
    durationMs: 5,
    runs: [
      {
        runId: 'sim_run_1',
        deploymentId: 'd',
        agentId: 'a',
        status: 'failed',
        exitCode: 1,
        summary: null,
        error: 'kaboom',
        startedAt: 't0',
        endedAt: 't1',
        durationMs: 5,
        trigger: { kind: 'clock', eventSource: 'cron' },
        sandbox: { id: null, name: 'local-simulation' },
        failureClass: 'runner_error',
        origin: 'local_dry_run',
        logs: { stdout: '', stderr: '', mountLogTail: '', stdoutTruncated: false, stderrTruncated: false },
        simulation: { mode: 'simulate', sideEffects: [], capturedLogs: [] }
      }
    ],
    unsupported: [{ id: 'e9', type: 'mystery.event' }],
    summary: { total: 1, succeeded: 0, failed: 1, unsupported: 1 },
    exitCode: 1
  });
  assert.match(summary, /1 run\(s\) — 0 ok, 1 failed, 1 unsupported/);
  assert.match(summary, /\[FAIL\] cron\/clock sim_run_1/);
  assert.match(summary, /error: kaboom/);
  assert.match(summary, /\[skip\] unsupported envelope e9 \(mystery\.event\)/);
});

// ---------------------------------------------------------------------------
// --scaffold (workforce#189)

test('parseInvokeArgs: --scaffold needs no persona or fixture', () => {
  const parsed = parseInvokeArgs(['--scaffold', 'cron.tick', '--output', './event.json']);
  assert.ok('scaffold' in parsed);
  if (!('scaffold' in parsed)) return;
  assert.equal(parsed.scaffold, 'cron.tick');
  assert.equal(path.basename(parsed.outputPath ?? ''), 'event.json');
});

test('parseInvokeArgs: --scaffold rejects invoke-only args instead of ignoring them', () => {
  assert.throws(
    () => parseInvokeArgs(['./persona.json', '--scaffold', 'cron.tick']),
    /only accepts --output.*<persona-path>/
  );
  assert.throws(
    () => parseInvokeArgs(['--scaffold', 'cron.tick', '--fixture', './event.json']),
    /only accepts --output.*--fixture/
  );
  assert.throws(
    () => parseInvokeArgs(['--scaffold', 'cron.tick', '--input', 'FOO=bar', '--seed', '/x=./x.json']),
    /only accepts --output.*--input, --seed/
  );
});

test('scaffoldFixture: cron.tick emits a complete frame with name/cron and no warnings', () => {
  const { fixture, warnings } = scaffoldFixture('cron.tick');
  assert.deepEqual(warnings, []);
  assert.equal(fixture.type, 'cron.tick');
  assert.ok(typeof fixture.occurredAt === 'string');
  assert.ok(String(fixture.name).includes('TODO'));
  assert.ok(typeof fixture.cron === 'string');
  assert.ok(!('resource' in fixture));

  const named = scaffoldFixture('cron.daily-report');
  assert.equal(named.fixture.type, 'cron.daily-report');
});

test('scaffoldFixture: known provider event emits frame + explicit resource TODO hole', () => {
  const { fixture, warnings } = scaffoldFixture('github.pull_request.opened');
  assert.deepEqual(warnings, []);
  assert.equal(fixture.type, 'github.pull_request.opened');
  const resource = fixture.resource as Record<string, unknown>;
  assert.ok(String(resource.TODO).includes('runs export'));
});

test('scaffoldFixture: unknown provider/event warns but never blocks (lintTriggers stance)', () => {
  const unknownProvider = scaffoldFixture('notaprovider.something');
  assert.equal(unknownProvider.warnings.length, 1);
  assert.match(unknownProvider.warnings[0], /not in KNOWN_TRIGGER_CATALOG/);
  assert.equal(unknownProvider.fixture.type, 'notaprovider.something');

  const unknownEvent = scaffoldFixture('github.not_a_real_event');
  assert.equal(unknownEvent.warnings.length, 1);
  assert.match(unknownEvent.warnings[0], /not a known github trigger/);
});

test('runInvoke --scaffold writes the skeleton and exits clean', async () => {
  const io = collectingIO();
  const previousExitCode = process.exitCode;
  const result = await runInvoke(['--scaffold', 'cron.tick'], io);
  const exitCode = process.exitCode;
  process.exitCode = previousExitCode;

  assert.equal(result, undefined);
  assert.notEqual(exitCode, 1);
  const skeleton = JSON.parse(io.out.join(''));
  assert.equal(skeleton.type, 'cron.tick');
});

test('scaffoldFixture: non-tick cron types are PRESERVED with a warning, never rewritten', () => {
  const { fixture, warnings } = scaffoldFixture('cron.daily');
  assert.equal(fixture.type, 'cron.daily');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /preserving requested type "cron.daily"/);
});
