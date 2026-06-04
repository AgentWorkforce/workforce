import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { interpretEnvelopeResponse, isProbeNotFound, parseRunsArgs } from './runs-command.js';

// ---------------------------------------------------------------------------
// parseRunsArgs

test('parseRunsArgs: export with full flags', () => {
  const parsed = parseRunsArgs([
    'export',
    'run-123',
    '--agent',
    'hn-monitor',
    '--fixture',
    './event.json',
    '--workspace',
    'ws-1',
    '--no-prompt'
  ]);
  assert.ok(!('help' in parsed));
  if ('help' in parsed) return;
  assert.equal(parsed.action, 'export');
  assert.equal(parsed.options.runId, 'run-123');
  assert.equal(parsed.options.agent, 'hn-monitor');
  assert.equal(path.basename(parsed.options.fixturePath ?? ''), 'event.json');
  assert.equal(parsed.options.workspace, 'ws-1');
  assert.equal(parsed.options.noPrompt, true);
});

test('parseRunsArgs: bare/help/unknown-action contracts', () => {
  assert.deepEqual(parseRunsArgs([]), { help: true });
  assert.deepEqual(parseRunsArgs(['-h']), { help: true });
  assert.deepEqual(parseRunsArgs(['export', '-h']), { help: true });
  assert.throws(() => parseRunsArgs(['import']), /unknown action "import"/);
  assert.throws(() => parseRunsArgs(['export']), /missing run id/);
  assert.throws(() => parseRunsArgs(['export', 'r1', '--bogus']), /unknown flag "--bogus"/);
  assert.throws(() => parseRunsArgs(['export', 'r1', 'r2']), /unexpected positional/);
});

// ---------------------------------------------------------------------------
// interpretEnvelopeResponse — the captured/omitted/not-captured contract

test('interpretEnvelopeResponse: captured envelope becomes a pretty fixture', () => {
  const result = interpretEnvelopeResponse(
    { captured: true, omitted: false, envelope: { id: 'evt_1', type: 'cron.tick' } },
    'run-1',
    'hn-monitor'
  );
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(JSON.parse(result.fixture).id, 'evt_1');
  assert.ok(result.fixture.endsWith('\n'));
});

test('interpretEnvelopeResponse: omitted (oversized) explains never-truncate and points at --scaffold', () => {
  const result = interpretEnvelopeResponse(
    { captured: false, omitted: true, envelope: null },
    'run-1',
    'hn-monitor'
  );
  assert.ok(!result.ok);
  if (result.ok) return;
  assert.match(result.error, /too large to capture/);
  assert.match(result.error, /never truncated/);
  assert.match(result.error, /--scaffold/);
});

test('interpretEnvelopeResponse: pre-capture runs explain why and how to proceed', () => {
  const result = interpretEnvelopeResponse(
    { captured: false, omitted: false, envelope: null },
    'run-1',
    'hn-monitor'
  );
  assert.ok(!result.ok);
  if (result.ok) return;
  assert.match(result.error, /no envelope was captured/);
  assert.match(result.error, /predate capture/);
});

test('interpretEnvelopeResponse: captured:true with null envelope is NOT treated as a fixture', () => {
  // Defensive: a contract-violating response must not fabricate an empty fixture.
  const result = interpretEnvelopeResponse(
    { captured: true, omitted: false, envelope: null },
    'run-1',
    'hn-monitor'
  );
  assert.ok(!result.ok);
});

// ---------------------------------------------------------------------------
// isProbeNotFound — only a probe 404 continues the scan; everything else
// (esp. 401 with its actionable login hint) must fail loud.

test('isProbeNotFound: 404 probe errors continue the scan', () => {
  assert.equal(isProbeNotFound(new Error('runs export failed: 404 {"error":"Deployment run not found"}')), true);
  assert.equal(isProbeNotFound(new Error('runs export failed: 404')), true);
});

test('isProbeNotFound: auth/transient errors are NOT swallowed', () => {
  assert.equal(isProbeNotFound(new Error('unauthorized. Run `agentworkforce login` and retry.')), false);
  assert.equal(isProbeNotFound(new Error('runs export failed: 403 forbidden')), false);
  assert.equal(isProbeNotFound(new Error('runs export failed: 500')), false);
  assert.equal(isProbeNotFound(new Error('fetch failed')), false);
  assert.equal(isProbeNotFound('not-an-error'), false);
});

test('parseRunsArgs: =-inline forms for workspace and cloud-url', () => {
  const parsed = parseRunsArgs(['export', 'r1', '--workspace=ws-9', '--cloud-url=https://example.com']);
  assert.ok(!('help' in parsed));
  if ('help' in parsed) return;
  assert.equal(parsed.options.workspace, 'ws-9');
  assert.equal(parsed.options.cloudUrl, 'https://example.com');
});

test('interpretEnvelopeResponse: non-object envelopes are refused (string/number/array)', () => {
  for (const envelope of ['"oops"', 42, ['not', 'an', 'envelope']]) {
    const result = interpretEnvelopeResponse(
      { captured: true, omitted: false, envelope },
      'run-1',
      'hn-monitor'
    );
    assert.ok(!result.ok, `expected refusal for ${JSON.stringify(envelope)}`);
    if (result.ok) continue;
    assert.match(result.error, /non-object envelope/);
  }
});
