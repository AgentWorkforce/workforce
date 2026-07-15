import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  matchesExpectedProviderAction,
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

function extractLoggedMessagePayloads(record: RunRecordV2): string[] {
  const logs = ((record.extensions as Record<string, unknown>).logs ?? []) as string[];
  return logs.map((line) => {
    try {
      const parsed = JSON.parse(line) as { message?: unknown };
      return typeof parsed.message === 'string' ? parsed.message : '';
    } catch {
      return line;
    }
  });
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

test('runInvoke: schedule invocation carries persona httpRead capability rules', async () => {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? '/');
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}/schedule-allowed`;

  try {
    await withAgent({
      'agent.ts': `
        import { defineAgent } from '@agentworkforce/runtime';
        export default defineAgent({
          id: 'schedule-http-read',
          intent: 'documentation',
          description: 'schedule http read test',
          skills: [],
          harnessSettings: { reasoning: 'medium', timeoutSeconds: 300 },
          schedules: [{ name: 'scan', cron: '0 9 * * *' }],
          capabilities: {
            httpRead: {
              allow: [{ method: 'GET', urlGlob: '${url}' }]
            }
          },
          handler: async (ctx) => {
            const response = await fetch('${url}');
            ctx.log('info', await response.text());
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
      assert.equal(exitCode, 0);
      assert.equal(result.status, 'succeeded');
      assert.deepEqual(hits, ['/schedule-allowed']);
    });
  } finally {
    server.close();
  }
});

test('runInvoke: fixture invocation carries persona httpRead capability rules', async () => {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? '/');
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}/fixture-allowed`;

  try {
    await withAgent({
      'agent.ts': `
        import { defineAgent } from '@agentworkforce/runtime';
        export default defineAgent({
          id: 'fixture-http-read',
          intent: 'documentation',
          description: 'fixture http read test',
          skills: [],
          harnessSettings: { reasoning: 'medium', timeoutSeconds: 300 },
          capabilities: {
            httpRead: {
              allow: [{ method: 'GET', urlGlob: '${url}' }]
            }
          },
          handler: async (ctx) => {
            const response = await fetch('${url}');
            ctx.log('info', await response.text());
          }
        });
      `,
      'event.json': JSON.stringify({
        id: 'evt_fixture_http_read',
        workspace: 'ws-local',
        type: 'cron.tick',
        occurredAt: '2026-07-15T09:00:00.000Z',
        name: 'scan',
        cron: '0 9 * * *'
      })
    }, async (dir, agentPath) => {
      const io = collectingIO();
      const previousExitCode = process.exitCode;
      const result = await runInvoke(
        [agentPath, '--fixture', path.join(dir, 'event.json'), '--reads', 'live'],
        io
      );
      const exitCode = process.exitCode;
      process.exitCode = previousExitCode;

      assert.ok(result && !Array.isArray(result));
      assert.equal(exitCode, 0);
      assert.equal(result.status, 'succeeded');
      assert.deepEqual(hits, ['/fixture-allowed']);
    });
  } finally {
    server.close();
  }
});

test('runInvoke: case invocation unions persona httpRead capability rules with case-derived rules', async () => {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? '/');
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const liveUrl = `http://127.0.0.1:${address.port}/case-allowed`;

  try {
    await withAgent({
      'agent.ts': `
        import { defineAgent } from '@agentworkforce/runtime';
        export default defineAgent({
          id: 'case-http-read',
          intent: 'documentation',
          description: 'case http read test',
          skills: [],
          harnessSettings: { reasoning: 'medium', timeoutSeconds: 300 },
          schedules: [{ name: 'scan', cron: '0 9 * * *' }],
          capabilities: {
            httpRead: {
              allow: [{ method: 'GET', urlGlob: '${liveUrl}' }]
            }
          },
          handler: async (ctx) => {
            const response = await fetch('${liveUrl}');
            ctx.log('info', await response.text());
          }
        });
      `,
      'case.yaml': `
schemaVersion: 1
id: test.case.http-read-union
kind: scheduled
event:
  schedule: scan
policy:
  reads: live
http:
  - method: GET
    match: ignored-fixture
    file: ./fixture.json
expect:
  status: succeeded
  eventSource: cron
`,
      'fixture.json': '{"unused":true}\n'
    }, async (dir, agentPath) => {
      const io = collectingIO();
      const previousExitCode = process.exitCode;
      const result = await runInvoke([agentPath, '--case', path.join(dir, 'case.yaml')], io);
      const exitCode = process.exitCode;
      process.exitCode = previousExitCode;

      assert.ok(result && !Array.isArray(result));
      assert.equal(exitCode, 0);
      assert.equal(result.status, 'succeeded');
      assert.deepEqual(hits, ['/case-allowed']);
    });
  } finally {
    server.close();
  }
});

test('matchesExpectedProviderAction: threaded Slack replies satisfy messages+threaded case expectations', () => {
  const action: RunRecordV2['actions'][number] = {
    kind: 'provider.write',
    status: 'previewed',
    provider: 'slack',
    resource: 'replies',
    id: 'preview-slack-replies-0001',
    data: {
      parameters: {
        channelId: 'C123',
        messageTs: '300_1'
      },
      path: '/slack/channels/C123/messages/300_1/replies/preview-slack-replies-0001.json',
      body: {
        text: 'Threaded reply',
        thread_ts: '300.1'
      }
    }
  };

  assert.equal(matchesExpectedProviderAction(action, {
    provider: 'slack',
    resource: 'messages',
    channel: 'C123',
    threaded: true,
    textContains: ['Threaded reply']
  }), true);
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
          id: 'live-get-post',
          intent: 'documentation',
          description: 'live GET allow and POST deny test',
          skills: [],
          harnessSettings: { reasoning: 'medium', timeoutSeconds: 300 },
          schedules: [{ name: 'scan', cron: '0 9 * * *' }],
          capabilities: {
            httpRead: {
              allow: [{ method: 'GET', urlGlob: '${baseUrl}/allowed' }]
            }
          },
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

test('runInvoke: raw node:https request fails closed with no network permission', async () => {
  await withAgent({
    'agent.ts': `
      import https from 'node:https';
      import { defineAgent } from '@agentworkforce/runtime';
      export default defineAgent({
        schedules: [{ name: 'scan', cron: '0 9 * * *' }],
        handler: async () => {
          const req = https.request('https://example.test/escape', { method: 'POST' });
          req.end('escape');
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
    assert.equal(exitCode, 1);
    assert.match(String(result.error ?? ''), /raw network node:https.request/);
  });
});

test('runInvoke: dynamic computed node:http import is denied with zero raw hits', async () => {
  let rawHits = 0;
  const server = createServer((_req, res) => {
    rawHits += 1;
    res.statusCode = 204;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}/escape`;

  try {
    await withAgent({
      'agent.ts': `
        import { defineAgent } from '@agentworkforce/runtime';
        export default defineAgent({
          schedules: [{ name: 'scan', cron: '0 9 * * *' }],
          handler: async () => {
            const mod = await import('node:' + 'http');
            const req = mod.request('${url}', { method: 'POST' });
            req.end('escape');
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
      assert.equal(rawHits, 0);
      assert.match(String(result.error ?? ''), /raw network node:http.request/);
    });
  } finally {
    server.close();
  }
});

test('runInvoke: bare http request is denied before any network write lands', async () => {
  await withAgent({
    'agent.ts': `
      import http from 'http';
      import { defineAgent } from '@agentworkforce/runtime';
      export default defineAgent({
        schedules: [{ name: 'scan', cron: '0 9 * * *' }],
        handler: async () => {
          const req = http.request('http://127.0.0.1:1/escape', { method: 'POST' });
          req.end('escape');
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
    assert.equal(exitCode, 1);
    assert.match(String(result.error ?? ''), /raw network node:http.request/);
  });
});

test('runInvoke: createRequire http escape is denied with zero raw hits', async () => {
  let rawHits = 0;
  const server = createServer((_req, res) => {
    rawHits += 1;
    res.statusCode = 204;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}/escape`;

  try {
    await withAgent({
      'agent.ts': `
        import { createRequire } from 'node:module';
        import { defineAgent } from '@agentworkforce/runtime';
        const require = createRequire(import.meta.url);
        export default defineAgent({
          schedules: [{ name: 'scan', cron: '0 9 * * *' }],
          handler: async () => {
            const http = require('http');
            const req = http.request('${url}', { method: 'POST' });
            req.end('escape');
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
      assert.equal(rawHits, 0);
      assert.match(String(result.error ?? ''), /raw network node:http.request/);
    });
  } finally {
    server.close();
  }
});

test('runInvoke: helper module importing raw network builtin fails closed on use', async () => {
  await withAgent({
    'agent.ts': `
      import { defineAgent } from '@agentworkforce/runtime';
      import { escape } from './helper.ts';
      export default defineAgent({
        schedules: [{ name: 'scan', cron: '0 9 * * *' }],
        handler: async () => {
          escape();
        }
      });
    `,
    'helper.ts': `
      import http from 'node:http';
      export function escape() {
        const req = http.request('http://127.0.0.1:1/escape', { method: 'POST' });
        req.end('escape');
      }
    `
  }, async (_dir, agentPath) => {
    const io = collectingIO();
    const previousExitCode = process.exitCode;
    const result = await runInvoke([agentPath, '--schedule', 'scan'], io);
    const exitCode = process.exitCode;
    process.exitCode = previousExitCode;

    assert.ok(result && !Array.isArray(result));
    assert.equal(exitCode, 1);
    assert.match(String(result.error ?? ''), /raw network node:http.request/);
  });
});

test('runInvoke: child_process execution is denied under the isolated worker boundary', async () => {
  await withAgent({
    'agent.ts': `
      import { execFile } from 'node:child_process';
      import { defineAgent } from '@agentworkforce/runtime';
      export default defineAgent({
        schedules: [{ name: 'scan', cron: '0 9 * * *' }],
        handler: async () => {
          execFile('echo', ['nope']);
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
    assert.equal(exitCode, 1);
    assert.match(String(result.error ?? ''), /child_process.execFile/);
  });
});

test('runInvoke: isolated worker strips ambient creds, redacts secret-shaped inputs, and keeps safe inputs', async () => {
  const previousRelayfileToken = process.env.RELAYFILE_TOKEN;
  process.env.RELAYFILE_TOKEN = 'xoxb-sensitive-token';

  try {
    await withAgent({
      'agent.ts': `
        import { defineAgent } from '@agentworkforce/runtime';
        export default defineAgent({
          schedules: [{ name: 'scan', cron: '0 9 * * *' }],
          handler: async (ctx) => {
            ctx.log('info', JSON.stringify({
              ambientToken: process.env.RELAYFILE_TOKEN ?? 'missing',
              secretEnv: process.env.SLACK_BOT_TOKEN ?? 'missing',
              safeEnv: process.env.SLACK_CHANNEL ?? 'missing',
              secretInput: ctx.persona.inputs.SLACK_BOT_TOKEN ?? 'missing',
              safeInput: ctx.persona.inputs.SLACK_CHANNEL ?? 'missing'
            }));
          }
        });
      `
    }, async (_dir, agentPath) => {
      const io = collectingIO();
      const previousExitCode = process.exitCode;
      const result = await runInvoke([
        agentPath,
        '--schedule',
        'scan',
        '--input',
        'SLACK_BOT_TOKEN=xoxb-secret-input',
        '--input',
        'SLACK_CHANNEL=C123'
      ], io);
      const exitCode = process.exitCode;
      process.exitCode = previousExitCode;

      assert.ok(result && !Array.isArray(result));
      assert.equal(exitCode, 0);
      const messages = extractLoggedMessagePayloads(result);
      assert.ok(messages.some((line) => line.includes('"ambientToken":"missing"')));
      assert.ok(messages.some((line) => line.includes('"secretEnv":"missing"')));
      assert.ok(messages.some((line) => line.includes('"safeEnv":"C123"')));
      assert.ok(messages.some((line) => line.includes('"secretInput":"missing"')));
      assert.ok(messages.some((line) => line.includes('"safeInput":"missing"')));
      assert.ok(messages.every((line) => !line.includes('xoxb-sensitive-token')));
      assert.ok(messages.every((line) => !line.includes('xoxb-secret-input')));
      assert.equal(process.env.RELAYFILE_TOKEN, 'xoxb-sensitive-token');
    });
  } finally {
    process.env.RELAYFILE_TOKEN = previousRelayfileToken;
  }
});

test('runInvoke: benign input keys with credential-shaped values are redacted from env, ctx, and logs', async () => {
  await withAgent({
    'agent.ts': `
      import { defineAgent } from '@agentworkforce/runtime';
      export default defineAgent({
        schedules: [{ name: 'scan', cron: '0 9 * * *' }],
        handler: async (ctx) => {
          ctx.log('info', JSON.stringify({
            benignEnv: process.env.PROBE ?? 'missing',
            benignCtx: ctx.persona.inputs.PROBE ?? 'missing'
          }));
        }
      });
    `
  }, async (_dir, agentPath) => {
    const io = collectingIO();
    const previousExitCode = process.exitCode;
    const result = await runInvoke([
      agentPath,
      '--schedule',
      'scan',
      '--input',
      'PROBE=xoxb-benign-looking-secret-token'
    ], io);
    const exitCode = process.exitCode;
    process.exitCode = previousExitCode;

    assert.ok(result && !Array.isArray(result));
    assert.equal(exitCode, 0);
    const messages = extractLoggedMessagePayloads(result);
    assert.ok(messages.some((line) => line.includes('"benignEnv":"missing"')));
    assert.ok(messages.every((line) => !line.includes('xoxb-benign-looking-secret-token')));
    assert.ok(!JSON.stringify(result).includes('xoxb-benign-looking-secret-token'));
  });
});

test('runInvoke: mixed fetch/raw-http probe keeps allowed GET, blocks denied POST, blocks raw http, and exposes no net permission', async () => {
  let allowedGetHits = 0;
  let deniedPostHits = 0;
  let rawHttpHits = 0;
  const server = createServer((req, res) => {
    if (req.url === '/allowed') {
      allowedGetHits += 1;
      res.setHeader('content-type', 'application/json');
      res.end('{"ok":true}');
      return;
    }
    if (req.url === '/blocked') {
      deniedPostHits += 1;
      res.statusCode = 204;
      res.end();
      return;
    }
    rawHttpHits += 1;
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
        import http from 'node:http';
        import { defineAgent } from '@agentworkforce/runtime';

        async function attempt(fn) {
          try {
            await fn();
            return 'ok';
          } catch (error) {
            return error instanceof Error ? error.message : String(error);
          }
        }

        export default defineAgent({
          id: 'mixed-fetch-raw-http',
          intent: 'documentation',
          description: 'mixed fetch and raw http probe',
          skills: [],
          harnessSettings: { reasoning: 'medium', timeoutSeconds: 300 },
          schedules: [{ name: 'scan', cron: '0 9 * * *' }],
          capabilities: {
            httpRead: {
              allow: [{ method: 'GET', urlGlob: '${baseUrl}/allowed' }]
            }
          },
          handler: async (ctx) => {
            const permissionNet = process.permission?.has?.('net');
            const allowed = await attempt(async () => {
              const response = await fetch('${baseUrl}/allowed');
              await response.text();
            });
            const deniedFetch = await attempt(async () => {
              await fetch('${baseUrl}/blocked', { method: 'POST', body: 'nope' });
            });
            const deniedRaw = await attempt(async () => {
              await new Promise((resolve, reject) => {
                const req = http.request('${baseUrl}/raw-http', { method: 'POST' }, () => resolve(undefined));
                req.on('error', reject);
                req.end('escape');
              });
            });
            ctx.log('info', JSON.stringify({ permissionNet, allowed, deniedFetch, deniedRaw }));
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
      assert.equal(exitCode, 0);
      assert.equal(allowedGetHits, 1);
      assert.equal(deniedPostHits, 0);
      assert.equal(rawHttpHits, 0);
      const messages = extractLoggedMessagePayloads(result);
      assert.ok(messages.some((line) => line.includes('"permissionNet":false')));
      assert.ok(messages.some((line) => line.includes('"allowed":"ok"')));
      assert.ok(messages.some((line) => line.includes('invoke policy denied POST')));
      assert.ok(messages.some((line) => line.includes('raw network node:http.request')));
    });
  } finally {
    server.close();
  }
});

test('runInvoke: parent fetch failures return deterministic errors without leaking transport details', async () => {
  await withAgent({
    'agent.ts': `
      import { defineAgent } from '@agentworkforce/runtime';

      async function attempt(fn) {
        try {
          await fn();
          return 'ok';
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      }

      export default defineAgent({
        id: 'parent-fetch-failure',
        intent: 'documentation',
        description: 'parent fetch failure test',
        skills: [],
        harnessSettings: { reasoning: 'medium', timeoutSeconds: 300 },
        schedules: [{ name: 'scan', cron: '0 9 * * *' }],
        capabilities: {
          httpRead: {
            allow: [{ method: 'GET', urlGlob: 'http://127.0.0.1:1/unreachable' }]
          }
        },
        handler: async (ctx) => {
          const failed = await attempt(async () => {
            await fetch('http://127.0.0.1:1/unreachable');
          });
          ctx.log('info', JSON.stringify({ failed }));
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
    assert.equal(exitCode, 0);
    const messages = extractLoggedMessagePayloads(result);
    assert.ok(messages.some((line) => line.includes('invoke parent fetch failed for GET http://127.0.0.1:1/unreachable: network error')));
    assert.ok(messages.every((line) => !line.includes('ECONNREFUSED')));
  });
});

test('runInvoke: process.getBuiltinModule http escape is denied with zero raw hits', async () => {
  let rawHits = 0;
  const server = createServer((_req, res) => {
    rawHits += 1;
    res.statusCode = 204;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}/escape`;

  try {
    await withAgent({
      'agent.ts': `
        import { defineAgent } from '@agentworkforce/runtime';
        export default defineAgent({
          schedules: [{ name: 'scan', cron: '0 9 * * *' }],
          handler: async () => {
            const http = process.getBuiltinModule('node:http');
            const req = http.request('${url}', { method: 'POST' });
            req.end('escape');
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
      assert.equal(rawHits, 0);
      assert.match(String(result.error ?? ''), /raw network node:http.request/);
    });
  } finally {
    server.close();
  }
});

test('runInvoke: failed malicious run cleans up so a later safe run still succeeds', async () => {
  const firstIO = collectingIO();
  const previousExitCode = process.exitCode;

  await withAgent({
    'agent.ts': `
      import http from 'http';
      import { defineAgent } from '@agentworkforce/runtime';
      export default defineAgent({
        schedules: [{ name: 'scan', cron: '0 9 * * *' }],
        handler: async () => {
          const req = http.request('http://127.0.0.1:1/escape', { method: 'POST' });
          req.end('escape');
        }
      });
    `
  }, async (_dir, agentPath) => {
    const first = await runInvoke([agentPath, '--schedule', 'scan'], firstIO);
    assert.ok(first && !Array.isArray(first));
    assert.equal(first.status, 'failed');
    assert.match(String(first.error ?? ''), /raw network node:http.request/);
    assert.equal(process.exitCode, 1);
  });

  const secondIO = collectingIO();
  await withAgent({
    'agent.ts': `
      import { defineAgent } from '@agentworkforce/runtime';
      export default defineAgent({
        schedules: [{ name: 'scan', cron: '0 9 * * *' }],
        handler: async (ctx) => {
          await ctx.memory.save('ok', { scope: 'workspace' });
        }
      });
    `
  }, async (_dir, agentPath) => {
    const second = await runInvoke([agentPath, '--schedule', 'scan'], secondIO);
    assert.ok(second && !Array.isArray(second));
    assert.equal(second.status, 'succeeded');
  });

  process.exitCode = previousExitCode;
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
      schemaVersion: 1,
      manifest: {
        schemaVersion: 1,
        runId: 'run_hosted_123',
        eventId: 'evt_hosted_123',
        exportedAt: '2026-07-15T09:00:00.000Z',
        redacted: true,
        files: {
          'event.json': { fidelity: 'historical' },
          'run.json': { fidelity: 'historical' },
          'state/manifest.json': { fidelity: 'unavailable' }
        }
      },
      files: {
        'manifest.json': {
          fidelity: 'historical',
          content: {
            schemaVersion: 1,
            runId: 'run_hosted_123',
            eventId: 'evt_hosted_123',
            exportedAt: '2026-07-15T09:00:00.000Z',
            redacted: true,
            files: {
              'event.json': { fidelity: 'historical' },
              'run.json': { fidelity: 'historical' },
              'state/manifest.json': { fidelity: 'unavailable' }
            }
          }
        },
        'event.json': {
          fidelity: 'historical',
          content: {
            schemaVersion: 1,
            id: 'evt_hosted_123',
            workspace: 'ws-hosted',
            type: 'cron.tick',
            contractVersion: 1,
            occurredAt: '2026-07-15T09:00:00.000Z',
            attempt: 1,
            resource: {
              path: '/cron/schedules/scan',
              kind: 'cron.schedule',
              id: 'scan',
              provider: 'cron'
            },
            summary: {},
            schedule: {
              name: 'scan',
              cron: '0 9 * * *'
            }
          }
        },
        'run.json': {
          fidelity: 'historical',
          content: { id: 'run_hosted_123' }
        },
        'state/manifest.json': {
          fidelity: 'unavailable',
          content: { available: false }
        }
      }
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
    assert.equal(provenance.sourceEventId, 'evt_hosted_123');
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
