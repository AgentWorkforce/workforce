import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { interpretEnvelopeResponse, parseRunsArgs } from './runs-command.js';

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
