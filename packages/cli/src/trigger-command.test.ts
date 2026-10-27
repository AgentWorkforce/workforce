import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildTriggerUrl,
  formatTriggerAuthHint,
  formatTriggerResult,
  parseTriggerArgs,
  TRIGGER_USAGE,
  buildTriggerRequest,
  resolvePayload,
  parseTriggerResponse
} from './trigger-command.js';

test('parseTriggerArgs accepts selector and cloud flags', () => {
  assert.deepEqual(
    parseTriggerArgs([
      'hn-monitor',
      '--workspace',
      'rw_123',
      '--cloud-url=https://cloud.example.test',
      '--json',
      '--no-prompt'
    ]),
    {
      selector: 'hn-monitor',
      workspace: 'rw_123',
      cloudUrl: 'https://cloud.example.test',
      json: true,
      noPrompt: true
    }
  );
});

test('parseTriggerArgs supports help sentinel', () => {
  assert.deepEqual(parseTriggerArgs(['--help']), { help: true });
});

test('parseTriggerArgs rejects missing selector and extra positionals', () => {
  assert.throws(() => parseTriggerArgs([]), /missing agent selector/);
  assert.throws(() => parseTriggerArgs(['a', 'b']), /unexpected positional argument "b"/);
});

test('parseTriggerArgs rejects unknown single-dash flags as flags, not selectors', () => {
  assert.throws(() => parseTriggerArgs(['-x']), /unknown flag "-x"/);
});

test('parseTriggerArgs does not swallow single-dash flags as option values', () => {
  assert.throws(() => parseTriggerArgs(['hn-monitor', '--workspace', '-x']), /--workspace expects a value/);
  assert.throws(() => parseTriggerArgs(['hn-monitor', '--cloud-url', '-x']), /--cloud-url expects a value/);
});

test('parseTriggerResponse validates cloud trigger response shape', () => {
  assert.deepEqual(
    parseTriggerResponse(
      {
        agentId: 'agent-1',
        workspaceId: 'rw_123',
        deploymentId: 'deployment-1',
        status: 'starting'
      },
      'hn-monitor'
    ),
    {
      agentId: 'agent-1',
      workspaceId: 'rw_123',
      deploymentId: 'deployment-1',
      status: 'starting'
    }
  );

  assert.throws(
    () => parseTriggerResponse({ agentId: 'agent-1' }, 'hn-monitor'),
    /incomplete response/
  );
});

test('formatTriggerResult prints a concise human summary', () => {
  assert.equal(
    formatTriggerResult({
      agentId: 'agent-1',
      workspaceId: 'rw_123',
      deploymentId: 'deployment-1',
      status: 'starting'
    }),
    'triggered: agent-1\ndeployment: deployment-1\nworkspace: rw_123\nstatus: starting\n'
  );
});

test('formatTriggerAuthHint identifies env-token 403s', () => {
  assert.match(
    formatTriggerAuthHint({ authSource: 'env', workspace: 'rw_123' }),
    /WORKFORCE_WORKSPACE_TOKEN.*rw_123/
  );
  assert.match(
    formatTriggerAuthHint({ authSource: 'env', workspace: 'rw_123' }),
    /unset WORKFORCE_WORKSPACE_TOKEN/
  );
});

test('formatTriggerAuthHint identifies cloud-session 403s', () => {
  assert.match(
    formatTriggerAuthHint({ authSource: 'cloud-session', workspace: 'rw_123' }),
    /Agent Relay cloud session.*rw_123/
  );
  assert.match(
    formatTriggerAuthHint({ authSource: 'cloud-session', workspace: 'rw_123' }),
    /agentworkforce login/
  );
});

test('buildTriggerUrl preserves cloud base paths', () => {
  assert.equal(
    buildTriggerUrl({
      cloudUrl: 'https://agentrelay.com/cloud',
      workspace: 'rw_123',
      agentId: 'agent-1'
    }).toString(),
    'https://agentrelay.com/cloud/api/v1/workspaces/rw_123/deployments/agent-1/trigger'
  );
});

// ── payload ───────────────────────────────────────────────────────────────────

const quietIO = { stdout: () => {}, stderr: () => {} };

test('parseTriggerArgs takes a payload from a flag or a trailing JSON positional', () => {
  const viaFlag = parseTriggerArgs(['app-signal', '--payload', '{"accountId":"acme"}']);
  const viaPositional = parseTriggerArgs(['app-signal', '{"accountId":"acme"}']);
  for (const parsed of [viaFlag, viaPositional]) {
    assert.ok(!('help' in parsed));
    assert.equal(parsed.selector, 'app-signal');
    assert.deepEqual(parsed.payloadSource, { kind: 'inline', value: '{"accountId":"acme"}' });
  }
});

test('parseTriggerArgs still rejects a non-JSON extra positional', () => {
  // The trailing-JSON form must not turn every stray argument into a payload —
  // only something starting with a brace, which no selector can.
  assert.throws(() => parseTriggerArgs(['app-signal', 'oops']), /unexpected positional argument "oops"/);
});

test('parseTriggerArgs accepts "-" as a payload file without reading it', () => {
  // Parsing stays side-effect free: "-" means stdin, resolved later. The usual
  // "flag expects a value" guard would otherwise reject the lone dash.
  const parsed = parseTriggerArgs(['app-signal', '--payload-file', '-']);
  assert.ok(!('help' in parsed));
  assert.deepEqual(parsed.payloadSource, { kind: 'file', value: '-' });
  assert.deepEqual(
    (parseTriggerArgs(['app-signal', '--payload-file=-']) as { payloadSource?: unknown }).payloadSource,
    { kind: 'file', value: '-' }
  );
  // Both spellings guard alike — the equals form previously skipped the path
  // check and would have gone looking for a file called "--json".
  assert.throws(() => parseTriggerArgs(['app-signal', '--payload-file', '--json']), /--payload-file expects a value/);
  assert.throws(() => parseTriggerArgs(['app-signal', '--payload-file=--json']), /--payload-file expects a value/);
});

test('parseTriggerArgs carries an idempotency key', () => {
  const parsed = parseTriggerArgs(['app-signal', '--idempotency-key', 'evt-8412']);
  assert.ok(!('help' in parsed));
  assert.equal(parsed.idempotencyKey, 'evt-8412');
});

test('resolvePayload reads inline JSON and a file', async () => {
  assert.deepEqual(
    await resolvePayload({ kind: 'inline', value: '{"accountId":"acme"}' }, quietIO),
    { accountId: 'acme' }
  );
  const dir = await mkdtemp(join(tmpdir(), 'trigger-payload-'));
  const file = join(dir, 'signal.json');
  await writeFile(file, '{"accountId":"acme","reason":"usage_spike"}', 'utf8');
  assert.deepEqual(await resolvePayload({ kind: 'file', value: file }, quietIO), {
    accountId: 'acme',
    reason: 'usage_spike'
  });
});

test('resolvePayload rejects anything a handler could not read', async () => {
  // Cloud wraps the body as `{source:"app.trigger", payload:<body>}` and
  // handlers read named fields off it, so an array or scalar would be accepted
  // with a 202 and then do nothing. Fail before the request instead.
  await assert.rejects(() => resolvePayload({ kind: 'inline', value: '[1,2]' }, quietIO), /must be a JSON object/);
  await assert.rejects(() => resolvePayload({ kind: 'inline', value: '"hi"' }, quietIO), /must be a JSON object/);
  await assert.rejects(() => resolvePayload({ kind: 'inline', value: '{oops}' }, quietIO), /not valid JSON/);
  await assert.rejects(() => resolvePayload({ kind: 'inline', value: '   ' }, quietIO), /omit it entirely/i);
  await assert.rejects(
    () => resolvePayload({ kind: 'file', value: '/nope/missing.json' }, quietIO),
    /could not read payload file/
  );
});

test('resolvePayload returns undefined for a contentless fire', async () => {
  assert.equal(await resolvePayload(undefined, quietIO), undefined);
});

test('buildTriggerRequest sends a body only when there is a payload', () => {
  // The distinction that matters: no body is a contentless fire, which is what
  // a schedule looks like. `{}` is an app trigger carrying an empty object.
  const bare = buildTriggerRequest({}, 'tok');
  assert.equal(bare.body, undefined);
  assert.equal((bare.headers as Record<string, string>)['content-type'], undefined);
  assert.equal((bare.headers as Record<string, string>)['idempotency-key'], undefined);

  const withPayload = buildTriggerRequest(
    { payload: { accountId: 'acme' }, idempotencyKey: 'evt-8412' },
    'tok'
  );
  assert.equal(withPayload.body, '{"accountId":"acme"}');
  const headers = withPayload.headers as Record<string, string>;
  assert.equal(headers['content-type'], 'application/json');
  assert.equal(headers['idempotency-key'], 'evt-8412');
  assert.equal(headers.authorization, 'Bearer tok');

  // An explicitly empty object is still a payload, not a contentless fire.
  assert.equal(buildTriggerRequest({ payload: {} }, 'tok').body, '{}');
});

test('usage documents the payload flags', () => {
  // The gap this closes: a bare trigger is a contentless fire, so an agent
  // whose real work is payload-driven could not be exercised from the CLI at
  // all. Anyone reading --help should see that.
  for (const flag of ['--payload <json>', '--payload-file <path>', '--idempotency-key <key>']) {
    assert.ok(TRIGGER_USAGE.includes(flag), `usage should document ${flag}`);
  }
  assert.match(TRIGGER_USAGE, /contentless fire/);
});
