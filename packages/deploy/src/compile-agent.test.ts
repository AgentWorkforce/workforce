import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { compileAgentSource, projectCompiledAgentForPersistence } from './compile-agent.js';
import { preflightPersona } from './preflight.js';

const PRESET = `
import { defineAgent } from '@agentworkforce/runtime';
export default defineAgent({
  id: 'golden-agent',
  intent: 'relay-orchestrator',
  tags: ['discovery'],
  description: 'Golden single-file agent.',
  cloud: true,
  harness: 'claude',
  model: 'claude-haiku-4-5-20251001',
  systemPrompt: 'Keep extension data intact.',
  harnessSettings: { reasoning: 'low', timeoutSeconds: 300 },
  integrations: { github: {} },
  capabilities: {
    futureCapability: {
      enabled: true,
      nested: { mode: 'golden', values: [1, 2, 3] }
    }
  },
  triggers: { github: [{ on: 'pull_request.opened' }] },
  handler: async () => {}
});
`;

test('single-file source compiles into existing persona/agent deploy fields', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'compiled-agent-'));
  try {
    const sourcePath = path.join(dir, 'agent.ts');
    await writeFile(sourcePath, PRESET);
    const compiled = await compileAgentSource(sourcePath);
    assert.equal(compiled.sourceKind, 'single-file');
    assert.equal(compiled.handlerEntry, sourcePath);
    assert.equal(compiled.persona.onEvent, './agent.ts');
    assert.deepEqual(compiled.agent.triggers, { github: [{ on: 'pull_request.opened' }] });
    assert.match(compiled.sourceDigest, /^sha256:[a-f0-9]{64}$/);

    const preflight = await preflightPersona(sourcePath);
    assert.equal(preflight.persona.id, 'golden-agent');
    assert.equal(preflight.compiledAgent?.sourceKind, 'single-file');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('unknown capability extensions survive source-to-persistence projection', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'compiled-agent-golden-'));
  try {
    const sourcePath = path.join(dir, 'agent.ts');
    await writeFile(sourcePath, PRESET);
    const compiled = await compileAgentSource(sourcePath);
    const persisted = projectCompiledAgentForPersistence(compiled);
    assert.deepEqual(persisted.persona.capabilities?.futureCapability, {
      enabled: true,
      nested: { mode: 'golden', values: [1, 2, 3] }
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('split persona plus agent form remains supported', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'compiled-agent-split-'));
  try {
    const personaPath = path.join(dir, 'persona.json');
    const agentPath = path.join(dir, 'agent.ts');
    await writeFile(personaPath, JSON.stringify({
      id: 'split-agent', intent: 'relay-orchestrator', description: 'Split.', cloud: true,
      onEvent: './agent.ts', skills: [], harnessSettings: { reasoning: 'low', timeoutSeconds: 300 },
      integrations: { github: {} }
    }));
    await writeFile(agentPath, `import { defineAgent } from '@agentworkforce/runtime'; export default defineAgent({ triggers: { github: [{ on: 'pull_request.opened' }] }, handler: async () => {} });`);
    const compiled = await compileAgentSource(personaPath);
    assert.equal(compiled.sourceKind, 'split');
    assert.equal(compiled.handlerEntry, agentPath);
    assert.equal(compiled.persona.id, 'split-agent');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
