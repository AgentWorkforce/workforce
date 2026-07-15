import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  parseFixtureEnvelopes,
  parseInvokeArgs,
  renderHumanSummary,
  runInvoke,
  scaffoldFixture,
  type RunInvokeIO
} from './invoke-command.js';
import type { RunRecordV2 } from '@agentworkforce/runtime';

function collectingIO(): RunInvokeIO & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: (text: string) => out.push(text),
    stderr: (text: string) => err.push(text)
  };
}

test('parseInvokeArgs: schedule source with policy flags', () => {
  const parsed = parseInvokeArgs([
    './agent.ts',
    '--schedule',
    'scan',
    '--reads',
    'live',
    '--model=stub',
    '--input',
    'SLACK_CHANNEL=C123',
    '--seed',
    '/tmp/state.json=./state.json',
    '--watch'
  ]);
  assert.ok(!('help' in parsed) && !('scaffold' in parsed));
  if ('help' in parsed || 'scaffold' in parsed) return;
  assert.equal(parsed.source.kind, 'schedule');
  assert.equal(parsed.source.name, 'scan');
  assert.equal(parsed.reads, 'live');
  assert.equal(parsed.model, 'stub');
  assert.equal(parsed.watch, true);
  assert.deepEqual(parsed.inputs, { SLACK_CHANNEL: 'C123' });
});

test('parseInvokeArgs: case and fixture are mutually exclusive', () => {
  assert.throws(
    () => parseInvokeArgs(['./agent.ts', '--case', './case.yaml', '--fixture', './event.json']),
    /mutually exclusive/
  );
});

test('parseFixtureEnvelopes: object, array, and NDJSON stay supported', () => {
  const object = parseFixtureEnvelopes('{"id":"evt_1"}', 'event.json');
  const array = parseFixtureEnvelopes('[{"id":"evt_1"},{"id":"evt_2"}]', 'events.json');
  const ndjson = parseFixtureEnvelopes('{"id":"evt_1"}\n{"id":"evt_2"}\n', 'events.ndjson');
  assert.equal(object.length, 1);
  assert.equal(array.length, 2);
  assert.equal(ndjson.length, 2);
});

async function withAgent<T>(
  files: Record<string, string>,
  fn: (dir: string, agentPath: string) => Promise<T>
): Promise<T> {
  const dir = await mkdtemp(path.join(process.cwd(), '.invoke-'));
  try {
    for (const [relativePath, contents] of Object.entries(files)) {
      const absPath = path.join(dir, relativePath);
      await writeFile(absPath, contents, 'utf8');
    }
    return await fn(dir, path.join(dir, 'agent.ts'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('runInvoke: bare Agent source runs by schedule and emits a RunRecordV2', async () => {
  await withAgent({
    'agent.ts': `
      import { defineAgent } from '@agentworkforce/runtime';
      export default defineAgent({
        schedules: [{ name: 'scan', cron: '0 9 * * *' }],
        handler: async (ctx) => {
          await ctx.memory.save(JSON.stringify({ ok: true }), { tags: ['probe'], scope: 'workspace' });
          ctx.log('info', 'agent.ran');
        }
      });
    `
  }, async (_dir, agentPath) => {
    const io = collectingIO();
    const previousExitCode = process.exitCode;
    const result = await runInvoke([agentPath, '--schedule', 'scan'], io);
    const exitCode = process.exitCode;
    process.exitCode = previousExitCode;

    assert.ok(result && !Array.isArray(result));
    assert.equal(exitCode, 0);
    assert.equal(result.status, 'succeeded');
    assert.equal(result.eventContract, 'cron.tick@1');
    assert.ok(result.actions.some((action) => action.kind === 'memory.save'));
    assert.match(io.err.join(''), /preview: 1 run\(s\) — 1 ok, 0 failed/);
  });
});

test('runInvoke: watch reruns the same source when authored files change', async () => {
  await withAgent({
    'agent.ts': `
      import { defineAgent } from '@agentworkforce/runtime';
      import { marker } from './marker.ts';
      export default defineAgent({
        schedules: [{ name: 'scan', cron: '0 9 * * *' }],
        handler: async (ctx) => {
          ctx.log('info', marker);
        }
      });
    `,
    'marker.ts': `export const marker = 'first-pass';\n`
  }, async (dir, agentPath) => {
    const io = collectingIO();
    let waits = 0;
    const previousExitCode = process.exitCode;
    const result = await runInvoke([agentPath, '--schedule', 'scan', '--watch'], io, {
      waitForWatchChange: async (files) => {
        waits += 1;
        if (waits === 1) {
          assert.ok(files.some((file) => file.endsWith(path.sep + 'marker.ts')));
          await writeFile(path.join(dir, 'marker.ts'), `export const marker = 'second-pass';\n`, 'utf8');
          return 'change';
        }
        return 'stop';
      }
    });
    const exitCode = process.exitCode;
    process.exitCode = previousExitCode;

    assert.ok(result && !Array.isArray(result));
    assert.equal(exitCode, 0);
    assert.match(io.err.join(''), /watch: change detected, rerunning preview/);
    const logs = ((result.extensions as Record<string, unknown>).logs ?? []) as string[];
    assert.ok(logs.some((line) => line.includes('second-pass')));
  });
});

test('runInvoke: case file executes with assertions and fixture-backed HTTP/model preview', async () => {
  await withAgent({
    'agent.ts': `
      import { defineAgent } from '@agentworkforce/runtime';
      export default defineAgent({
        schedules: [{ name: 'scan', cron: '0 9 * * *' }],
        handler: async (ctx) => {
          const response = await fetch('https://example.test/front-page');
          const story = await response.json();
          await ctx.memory.save(JSON.stringify(story), { tags: ['stories'], scope: 'workspace' });
          await ctx.llm.complete('Return ONLY compact JSON with this shape:\\n[{"id":1,"title":"Agent"}]');
          ctx.log('info', 'agent.case-ran');
        }
      });
    `,
    'case.yaml': `
schemaVersion: 1
id: test.case
kind: scheduled
event:
  schedule: scan
policy:
  reads: fixtures
  model: stub
http:
  - method: GET
    match: front-page
    file: ./fixture.json
expect:
  status: succeeded
  eventSource: cron
  logsContain:
    - agent.case-ran
  effectsContain:
    - memory.save
    - model.complete
`,
    'fixture.json': '{"id":1,"title":"Agent"}\n'
  }, async (dir, agentPath) => {
    const io = collectingIO();
    const previousExitCode = process.exitCode;
    const result = await runInvoke([agentPath, '--case', path.join(dir, 'case.yaml')], io);
    const exitCode = process.exitCode;
    process.exitCode = previousExitCode;

    assert.ok(result && !Array.isArray(result));
    assert.equal(exitCode, 0);
    assert.equal(result.status, 'succeeded');
    assert.ok(result.actions.some((action) => action.kind === 'http.read'));
    assert.ok(result.actions.some((action) => action.kind === 'model.complete'));
  });
});

test('runInvoke: preview transport binds before import and blocks ambient Slack writes', async () => {
  const previousRelayfileToken = process.env.RELAYFILE_TOKEN;
  const previousRelayfileUrl = process.env.RELAYFILE_URL;
  const previousRelayfileWorkspace = process.env.RELAYFILE_WORKSPACE_ID;
  process.env.RELAYFILE_TOKEN = 'xoxb-prod-shaped-token';
  process.env.RELAYFILE_URL = 'https://prod.example.com';
  process.env.RELAYFILE_WORKSPACE_ID = 'ws-prod';

  try {
    await withAgent({
      'agent.ts': `
        import { defineAgent } from '@agentworkforce/runtime';
        import { slackClient } from '@relayfile/relay-helpers';
        export default defineAgent({
          schedules: [{ name: 'scan', cron: '0 9 * * *' }],
          handler: async () => {
            await slackClient().post('C123', 'Preview only');
          }
        });
      `
    }, async (dir, agentPath) => {
      const relayfileDir = path.join(dir, 'node_modules', '@relayfile');
      await mkdir(relayfileDir, { recursive: true });
      await symlink(
        path.resolve(process.cwd(), '..', 'delivery', 'node_modules', '@relayfile', 'relay-helpers'),
        path.join(relayfileDir, 'relay-helpers')
      );
      const io = collectingIO();
      const result = await runInvoke([agentPath, '--schedule', 'scan'], io);
      assert.ok(result && !Array.isArray(result));
      const slackWrite = result.actions.find((action) => action.kind === 'provider.write' && action.provider === 'slack');
      assert.ok(slackWrite);
    });
  } finally {
    process.env.RELAYFILE_TOKEN = previousRelayfileToken;
    process.env.RELAYFILE_URL = previousRelayfileUrl;
    process.env.RELAYFILE_WORKSPACE_ID = previousRelayfileWorkspace;
  }
});

test('runInvoke: live GET is allowed while POST is denied and never reaches the sentinel', async () => {
  let getHits = 0;
  let postHits = 0;
  const server = createServer((req, res) => {
    if (req.method === 'GET') {
      getHits += 1;
      res.setHeader('content-type', 'application/json');
      res.end('{"ok":true}');
      return;
    }
    postHits += 1;
    res.statusCode = 204;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await withAgent({
      'agent.ts': `
        import { defineAgent } from '@agentworkforce/runtime';
        export default defineAgent({
          schedules: [{ name: 'scan', cron: '0 9 * * *' }],
          handler: async () => {
            await fetch('${baseUrl}/allowed');
            await fetch('${baseUrl}/blocked', { method: 'POST', body: 'nope' });
          }
        });
      `
    }, async (_dir, agentPath) => {
      const io = collectingIO();
      const previousExitCode = process.exitCode;
      const result = await runInvoke([agentPath, '--schedule', 'scan', '--reads', 'live'], io);
      const exitCode = process.exitCode;
      process.exitCode = previousExitCode;

      assert.ok(result && !Array.isArray(result));
      assert.equal(exitCode, 1);
      assert.equal(getHits, 1);
      assert.equal(postHits, 0);
      assert.ok(result.actions.some((action) => action.kind === 'http.read' && action.status === 'denied'));
    });
  } finally {
    server.close();
  }
});

test('runInvoke: raw node:https import fails closed before handler import', async () => {
  await withAgent({
    'agent.ts': `
      import https from 'node:https';
      import { defineAgent } from '@agentworkforce/runtime';
      export default defineAgent({
        schedules: [{ name: 'scan', cron: '0 9 * * *' }],
        handler: async () => {
          https.globalAgent.destroy();
        }
      });
    `
  }, async (_dir, agentPath) => {
    const io = collectingIO();
    const previousExitCode = process.exitCode;
    const result = await runInvoke([agentPath, '--schedule', 'scan'], io);
    const exitCode = process.exitCode;
    process.exitCode = previousExitCode;

    assert.equal(result, undefined);
    assert.equal(exitCode, 1);
    assert.match(io.err.join(''), /preview bundles may not import node:https/);
  });
});

test('runInvoke: replay bundle preserves provenance and unavailable state fidelity', async () => {
  await withAgent({
    'agent.ts': `
      import { defineAgent } from '@agentworkforce/runtime';
      export default defineAgent({
        schedules: [{ name: 'scan', cron: '0 9 * * *' }],
        handler: async (ctx) => {
          ctx.log('info', 'replay.ran');
        }
      });
    `,
    'replay.json': JSON.stringify({
      runId: 'run_hosted_123',
      event: {
        id: 'evt_hosted_123',
        workspace: 'ws-hosted',
        type: 'cron.tick',
        occurredAt: '2026-07-15T09:00:00.000Z',
        name: 'scan',
        cron: '0 9 * * *'
      },
      state: null
    }, null, 2)
  }, async (dir, agentPath) => {
    const io = collectingIO();
    const previousExitCode = process.exitCode;
    const result = await runInvoke([agentPath, '--fixture', path.join(dir, 'replay.json')], io);
    const exitCode = process.exitCode;
    process.exitCode = previousExitCode;

    assert.ok(result && !Array.isArray(result));
    assert.equal(exitCode, 0);
    assert.equal(result.mode, 'replay');
    assert.equal(result.eventId, 'evt_hosted_123');
    const extensions = result.extensions as Record<string, unknown>;
    const stateSource = extensions.stateSource as Record<string, unknown>;
    const provenance = extensions.provenance as Record<string, unknown>;
    assert.equal(stateSource.fidelity, 'unavailable');
    assert.equal(provenance.sourceRunId, 'run_hosted_123');
  });
});

test('renderHumanSummary: renders single or multi-record previews', () => {
  const record: RunRecordV2 = {
    runId: 'run_1',
    status: 'succeeded',
    origin: 'local_dry_run',
    mode: 'preview',
    policy: {
      reads: 'fixtures',
      writes: 'preview',
      model: 'stub',
      shell: 'simulate',
      compose: 'preview',
      allowedHttp: []
    },
    eventId: 'evt_1',
    eventContract: 'cron.tick@1',
    trace: [],
    actions: [],
    artifacts: { artifacts: [] },
    stateDiff: {}
  };
  assert.match(renderHumanSummary(record), /preview: 1 run\(s\) — 1 ok, 0 failed/);
  assert.match(renderHumanSummary([record, { ...record, runId: 'run_2', status: 'failed' }]), /preview: 2 run\(s\) — 1 ok, 1 failed/);
});

test('scaffoldFixture: cron and provider scaffolds remain available', () => {
  const cron = scaffoldFixture('cron.tick');
  const provider = scaffoldFixture('github.pull_request.opened');
  assert.equal(cron.fixture.type, 'cron.tick');
  assert.equal(provider.fixture.type, 'github.pull_request.opened');
});
