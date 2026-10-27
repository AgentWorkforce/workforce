import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNonInteractiveSpec, type Harness } from '@agentworkforce/persona-kit';
import {
  NO_REPLY_MARKER,
  NO_REPLY_PROMPT_CONTRACT,
  appendNoReplyPromptContract,
  sanitizeNoReplyOutput
} from './no-reply.js';

test('sanitizeNoReplyOutput suppresses an exact marker with surrounding transport whitespace', () => {
  assert.deepEqual(sanitizeNoReplyOutput(`  ${NO_REPLY_MARKER}\n`), {
    output: '',
    containsMarker: true,
    suppressed: true
  });
});

test('sanitizeNoReplyOutput strips a leaked marker while preserving visible prose', () => {
  assert.deepEqual(
    sanitizeNoReplyOutput(`Keep this paragraph.\n\n${NO_REPLY_MARKER}\n\nAnd keep this one.`),
    {
      output: 'Keep this paragraph.\n\n\n\nAnd keep this one.',
      containsMarker: true,
      suppressed: false
    }
  );
});

test('sanitizeNoReplyOutput leaves ordinary harness output unchanged', () => {
  assert.deepEqual(sanitizeNoReplyOutput('  visible response\n'), {
    output: '  visible response\n',
    containsMarker: false,
    suppressed: false
  });
});

test('the no-reply prompt contract is appended once', () => {
  const appended = appendNoReplyPromptContract('Persona instructions.');
  assert.equal(appended, `Persona instructions.\n\n${NO_REPLY_PROMPT_CONTRACT}`);
  assert.equal(appendNoReplyPromptContract(appended), appended);
});

for (const harness of ['claude', 'codex', 'opencode', 'grok'] as const satisfies readonly Harness[]) {
  test(`${harness} receives the no-reply contract on its harness-specific prompt surface`, () => {
    const spec = buildNonInteractiveSpec({
      harness,
      personaId: 'no-reply-test',
      model: modelFor(harness),
      systemPrompt: appendNoReplyPromptContract('Persona instructions.'),
      task: 'Handle the event.',
      name: 'no-reply-test',
      workingDirectory: '/workspace'
    });
    const harnessVisiblePrompt = [
      ...spec.args,
      spec.prompt.contents,
      ...spec.configFiles.map((file) => file.contents)
    ].join('\n');

    assert.match(harnessVisiblePrompt, /Persona instructions\./);
    assert.match(
      harnessVisiblePrompt,
      /When no visible reply is useful, make the final message exactly \[\[NO_REPLY\]\]\./
    );
  });
}

function modelFor(harness: Harness): string {
  switch (harness) {
    case 'claude':
      return 'anthropic/claude-sonnet-4-6';
    case 'codex':
      return 'gpt-5.4';
    case 'opencode':
      return 'opencode/minimax-m2.5';
    case 'grok':
      return 'grok-build-0.1';
  }
}
