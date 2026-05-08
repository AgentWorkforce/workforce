import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildUserPrompt,
  parsePickerOutput,
  pickPersona,
  type PickCandidate,
  type PickerSubprocessRequest,
  type PickerSubprocessResult
} from './persona-picker.js';

const SAMPLE_CANDIDATES: PickCandidate[] = [
  {
    id: 'code-reviewer',
    intent: 'review',
    tags: ['review'],
    description: 'Reviews PRs.'
  },
  {
    id: 'debugger',
    intent: 'debugging',
    tags: ['debugging'],
    description: 'Roots out bugs.'
  }
];

function fakeRunner(result: PickerSubprocessResult): {
  runner: (req: PickerSubprocessRequest) => PickerSubprocessResult;
  calls: PickerSubprocessRequest[];
} {
  const calls: PickerSubprocessRequest[] = [];
  return {
    calls,
    runner(req) {
      calls.push(req);
      return result;
    }
  };
}

test('buildUserPrompt: includes the task and a JSON candidate list', () => {
  const prompt = buildUserPrompt('fix the login bug', SAMPLE_CANDIDATES);
  assert.match(prompt, /Task:\nfix the login bug/);
  assert.match(prompt, /"id":"code-reviewer"/);
  assert.match(prompt, /"id":"debugger"/);
});

test('parsePickerOutput: parses a bare JSON response object', () => {
  const out = '{"persona":"code-reviewer","confidence":"high","reason":"PR review"}';
  assert.deepEqual(parsePickerOutput(out), {
    persona: 'code-reviewer',
    confidence: 'high',
    reason: 'PR review'
  });
});

test('parsePickerOutput: unwraps the Claude CLI {result: "<json>"} envelope', () => {
  const inner = JSON.stringify({
    persona: 'debugger',
    confidence: 'medium',
    reason: 'looks like a bug hunt'
  });
  const envelope = JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: inner
  });
  assert.deepEqual(parsePickerOutput(envelope), {
    persona: 'debugger',
    confidence: 'medium',
    reason: 'looks like a bug hunt'
  });
});

test('parsePickerOutput: returns undefined on non-JSON', () => {
  assert.equal(parsePickerOutput('not json'), undefined);
  assert.equal(parsePickerOutput(''), undefined);
  assert.equal(parsePickerOutput('   \n  '), undefined);
});

test('parsePickerOutput: returns undefined on shape mismatch', () => {
  assert.equal(parsePickerOutput('{"persona":42,"confidence":"high","reason":"x"}'), undefined);
  assert.equal(parsePickerOutput('{"persona":"x","confidence":"sky-high","reason":"x"}'), undefined);
  assert.equal(parsePickerOutput('{"persona":"x","confidence":"high"}'), undefined);
});

test('pickPersona: well-formed match propagates id, confidence, reason', () => {
  const { runner, calls } = fakeRunner({
    status: 'ok',
    stdout: '{"persona":"code-reviewer","confidence":"high","reason":"PR review fits"}',
    stderr: ''
  });
  const result = pickPersona('review my PR', SAMPLE_CANDIDATES, { runner });
  assert.equal(result.kind, 'match');
  if (result.kind === 'match') {
    assert.equal(result.personaId, 'code-reviewer');
    assert.equal(result.confidence, 'high');
    assert.equal(result.reason, 'PR review fits');
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bin, 'claude');
  assert.ok(calls[0].args.includes('-p'));
  assert.ok(calls[0].args.includes('--output-format'));
});

test('pickPersona: persona=null collapses to no-match', () => {
  const { runner } = fakeRunner({
    status: 'ok',
    stdout: '{"persona":null,"confidence":"low","reason":"none fit"}',
    stderr: ''
  });
  const result = pickPersona('xyzzy', SAMPLE_CANDIDATES, { runner });
  assert.equal(result.kind, 'no-match');
});

test('pickPersona: low confidence collapses to no-match even with a persona id', () => {
  const { runner } = fakeRunner({
    status: 'ok',
    stdout: '{"persona":"code-reviewer","confidence":"low","reason":"weak match"}',
    stderr: ''
  });
  const result = pickPersona('something', SAMPLE_CANDIDATES, { runner });
  assert.equal(result.kind, 'no-match');
});

test('pickPersona: unknown persona id from model is rejected as no-match', () => {
  const { runner } = fakeRunner({
    status: 'ok',
    stdout: '{"persona":"made-up-persona","confidence":"high","reason":"hallucinated"}',
    stderr: ''
  });
  const result = pickPersona('do work', SAMPLE_CANDIDATES, { runner });
  assert.equal(result.kind, 'no-match');
  if (result.kind === 'no-match') {
    assert.match(result.reason, /unknown persona id/);
  }
});

test('pickPersona: ENOENT from subprocess maps to picker-unavailable', () => {
  const { runner } = fakeRunner({
    status: 'enoent',
    stdout: '',
    stderr: '',
    errorMessage: 'spawn claude ENOENT'
  });
  const result = pickPersona('do work', SAMPLE_CANDIDATES, { runner });
  assert.equal(result.kind, 'picker-unavailable');
  if (result.kind === 'picker-unavailable') {
    assert.match(result.message, /not found on PATH/);
  }
});

test('pickPersona: non-zero exit maps to picker-unavailable with stderr', () => {
  const { runner } = fakeRunner({
    status: 'error',
    stdout: '',
    stderr: 'rate limited',
    errorMessage: 'exit 1'
  });
  const result = pickPersona('do work', SAMPLE_CANDIDATES, { runner });
  assert.equal(result.kind, 'picker-unavailable');
  if (result.kind === 'picker-unavailable') {
    assert.match(result.message, /rate limited/);
  }
});

test('pickPersona: unparseable stdout collapses to no-match', () => {
  const { runner } = fakeRunner({
    status: 'ok',
    stdout: 'I refuse to answer in JSON.',
    stderr: ''
  });
  const result = pickPersona('do work', SAMPLE_CANDIDATES, { runner });
  assert.equal(result.kind, 'no-match');
  if (result.kind === 'no-match') {
    assert.match(result.reason, /no parseable response/);
  }
});

test('pickPersona: empty task short-circuits to no-match without invoking runner', () => {
  const { runner, calls } = fakeRunner({ status: 'ok', stdout: '', stderr: '' });
  const result = pickPersona('   ', SAMPLE_CANDIDATES, { runner });
  assert.equal(result.kind, 'no-match');
  assert.equal(calls.length, 0);
});

test('pickPersona: empty candidates short-circuits to no-match', () => {
  const { runner, calls } = fakeRunner({ status: 'ok', stdout: '', stderr: '' });
  const result = pickPersona('do work', [], { runner });
  assert.equal(result.kind, 'no-match');
  assert.equal(calls.length, 0);
});

test('pickPersona: respects custom claudeBin and model in args', () => {
  const { runner, calls } = fakeRunner({
    status: 'ok',
    stdout: '{"persona":"debugger","confidence":"medium","reason":"x"}',
    stderr: ''
  });
  pickPersona('hunt a bug', SAMPLE_CANDIDATES, {
    runner,
    claudeBin: '/custom/claude',
    model: 'claude-opus-4-7'
  });
  assert.equal(calls[0].bin, '/custom/claude');
  const modelIdx = calls[0].args.indexOf('--model');
  assert.notEqual(modelIdx, -1);
  assert.equal(calls[0].args[modelIdx + 1], 'claude-opus-4-7');
});
