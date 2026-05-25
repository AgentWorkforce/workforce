import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { compilePersonaFile } from './persona-compile.js';

test('compilePersonaFile bundles persona.ts, validates it, and writes persona.json', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aw-persona-compile-'));
  try {
    const inputPath = join(root, 'persona.ts');
    const outputPath = join(root, 'persona.json');
    writeFileSync(
      inputPath,
      `import { definePersona } from '@agentworkforce/persona-kit';

export default definePersona({
  id: 'compiled-persona',
  intent: 'review',
  description: 'Compiled persona fixture.',
  inputs: {
    TARGET: 'repo'
  },
  integrations: {
    github: {
      triggers: [
        { on: 'pull_request.opened' },
        { on: 'off_registry.github_event' }
      ]
    },
    linear: { triggers: [{ on: 'issue.updated' }] },
    slack: { triggers: [{ on: 'message.channels' }] },
    notion: { triggers: [{ on: 'page.created' }] },
    jira: { triggers: [{ on: 'issue.created' }] },
    unknown: { triggers: [{ on: 'whatever.happened' }] }
  },
  onEvent: './agent.ts',
  harnessSettings: {
    reasoning: 'medium',
    timeoutSeconds: 60
  }
});
`,
      'utf8'
    );

    const result = await compilePersonaFile(inputPath);
    const compiled = JSON.parse(readFileSync(outputPath, 'utf8')) as {
      id: string;
      inputs?: Record<string, unknown>;
      integrations?: Record<string, { triggers?: Array<{ on: string }> }>;
    };

    assert.equal(result.personaId, 'compiled-persona');
    assert.equal(result.outputPath, outputPath);
    assert.equal(compiled.id, 'compiled-persona');
    assert.equal(compiled.inputs?.TARGET, 'repo');
    assert.equal(
      compiled.integrations?.github.triggers?.[1].on,
      'off_registry.github_event'
    );
    assert.equal(compiled.integrations?.unknown.triggers?.[0].on, 'whatever.happened');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('compilePersonaFile fails loudly when validation rejects the authored spec', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aw-persona-compile-invalid-'));
  try {
    const inputPath = join(root, 'persona.ts');
    writeFileSync(
      inputPath,
      `export default {
  id: 'bad',
  intent: 'review',
  description: 'Bad persona fixture.',
  harnessSettings: { reasoning: 'turbo', timeoutSeconds: 60 },
  onEvent: './agent.ts'
};
`,
      'utf8'
    );

    await assert.rejects(
      () => compilePersonaFile(inputPath),
      /harnessSettings\.reasoning must be low\|medium\|high/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
