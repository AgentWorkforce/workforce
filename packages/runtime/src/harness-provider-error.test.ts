import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyHarnessProviderFailure, HarnessProviderError } from './harness-provider-error.js';
import type { HarnessProviderFailure } from './harness-provider-error.js';

function classify(output: string, harness = 'claude') {
  return classifyHarnessProviderFailure({ output, exitCode: 1 }, harness);
}

test('Claude usage limit preserves a reported reset time without leaking surrounding output', () => {
  const failure = classify("\x1b[31mYou’ve hit your limit · resets 3:40pm (UTC)\x1b[0m\nsecret-fixture-value");
  assert.equal(failure?.kind, 'usage_limit');
  assert.equal(failure?.provider, 'anthropic');
  assert.equal(failure?.resetHint, '3:40pm (UTC)');
  assert.match(failure!.message, /Claude account.*usage limit/);
  assert.match(failure!.message, /Wait for.*reset/);
  assert.doesNotMatch(failure!.message, /secret-fixture/);
});

test('handles Codex error envelopes and does not label another harness as Claude', () => {
  const result = classify(JSON.stringify({ type: 'turn.failed', error: { message: "You've hit your usage limit. Please try later." } }), 'codex');
  assert.equal(result?.kind, 'usage_limit');
  assert.equal(result?.provider, 'openai');
  assert.match(result!.message, /OpenAI account/);
  assert.doesNotMatch(result!.message, /Claude/);
  assert.equal(classify(JSON.stringify({ type: 'result', is_error: true, result: "You've hit your limit" }))?.kind, 'usage_limit');
  assert.equal(classify(JSON.stringify({ type: 'error', message: "You've hit your usage limit" }), 'codex')?.kind, 'usage_limit');
  assert.match(classify("You've hit your limit", 'opencode')!.message, /AI account/);
});

test('classifies known provider diagnostics from stderr using safe messages', () => {
  const cases: Array<[string, HarnessProviderFailure['kind']]> = [
    ['API Error: 429 request throttled', 'rate_limit'],
    ['{"error":{"type":"rate_limit_error","message":"private detail"}}', 'rate_limit'],
    ['{"error":{"code":"insufficient_quota"}}', 'usage_limit'],
    ['Your credit balance is too low to access the Anthropic API.', 'usage_limit'],
    ['API Error: 401 private detail', 'authentication'],
    ['{"error":{"type":"authentication_error"}}', 'authentication'],
    ['OAuth token has expired.', 'authentication'],
    ['Invalid API key · Please run /login', 'authentication'],
    ['Prompt is too long: private detail', 'context_limit'],
    ['{"error":{"code":"context_length_exceeded"}}', 'context_limit'],
    ['API Error: 400 {"error":{"type":"invalid_request_error","message":"prompt is too long: private detail"}}', 'context_limit'],
    ['API Error: Request timed out.', 'timeout'],
    ['API Error: 529 private detail', 'provider_unavailable'],
    ['{"error":{"type":"overloaded_error"}}', 'provider_unavailable'],
  ];
  for (const [stderr, kind] of cases) {
    const failure = classifyHarnessProviderFailure({ stderr, output: 'unfinished-task-fixture', exitCode: 1 });
    assert.equal(failure?.kind, kind, stderr);
    assert.doesNotMatch(failure!.message, /private detail|unfinished-task-fixture/);
  }
});

test('reset hints require a valid explicit timezone and clock time', () => {
  for (const suffix of ['resets soon secret-fixture', 'resets 3:40pm', 'resets 99:99pm (UTC)', 'resets 3:40pm (Secret/Fixture)', 'resets 3:40pm (UTC)[secret-fixture]']) {
    const failure = classify(`You've hit your limit · ${suffix}`);
    assert.equal(failure?.kind, 'usage_limit');
    assert.equal(failure?.resetHint, undefined, suffix);
    assert.doesNotMatch(failure!.message, /secret-fixture|99:99|3:40|Secret\/Fixture/);
  }
  assert.equal(classify("You've hit your limit · resets 17:40 (Europe/Oslo)")?.resetHint, '17:40 (Europe/Oslo)');
});

test('does not interpret successful task output, OS kills, or unknown process failures', () => {
  for (const exitCode of [0, 137, 143, NaN]) {
    assert.equal(classifyHarnessProviderFailure({ output: "You've hit your limit", exitCode }), null);
  }
  for (const output of ['', 'gh: HTTP 429 Too Many Requests', 'test failed with exit 1', 'ECONNRESET', 'Timeout waiting for database', 'The test fixture contains API Error: 401']) {
    assert.equal(classify(output), null, output);
  }
});

test('typed errors expose safe metadata and retain non-enumerable original diagnostics', () => {
  const result = { output: "You've hit your limit", stderr: 'secret-fixture-value', exitCode: 1, durationMs: 1900 };
  const failure = classifyHarnessProviderFailure(result, 'claude')!;
  const error = new HarnessProviderError(failure, result);
  assert.equal(error.name, 'HarnessProviderError');
  assert.equal(error.message, failure.message);
  assert.equal(error.result, result);
  assert.deepEqual(error.providerFailure, failure);
  assert.doesNotMatch(JSON.stringify(error), /secret-fixture-value/);
});


test('ignores provider-like fixtures inside failed task output and non-error CLI records', () => {
  const payload = { error: { type: 'rate_limit_error', message: 'example' } };
  for (const output of [
    `The test fixture is ${JSON.stringify(payload)}`,
    JSON.stringify({ type: 'assistant', message: JSON.stringify(payload) }),
    JSON.stringify({ type: 'tool_result', content: JSON.stringify(payload) }),
    JSON.stringify({ type: 'result', is_error: false, result: JSON.stringify(payload) }),
    JSON.stringify({ type: 'assistant', ...payload }),
    JSON.stringify({ type: 'tool_result', content: "You've hit your limit" }),
  ]) assert.equal(classify(output), null, output);
});
