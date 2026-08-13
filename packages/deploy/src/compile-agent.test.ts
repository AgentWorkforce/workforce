import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { compileAgentSource, projectCompiledAgentForPersistence } from './compile-agent.js';
import { preflightPersona } from './preflight.js';

const PRESET_TRIGGER_BLOCK = `  triggers: {
    github: [{
      on: 'pull_request.opened',
      conditions: { labels: ['ready'] },
      futureTriggerOption: { delivery: 'batched' }
    }]
  },`;

const PRESET = `
import { defineAgent } from '@agentworkforce/runtime';
export default defineAgent({
  id: 'golden-agent',
  intent: 'relay-orchestrator',
  tags: ['discovery'],
  description: 'Golden single-file agent.',
  futurePersonaPolicy: { owner: 'cloud', revision: 2 },
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
${PRESET_TRIGGER_BLOCK}
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
    assert.deepEqual(compiled.agent.triggers, {
      github: [
        {
          on: 'pull_request.opened',
          conditions: { labels: ['ready'] },
          futureTriggerOption: { delivery: 'batched' }
        }
      ]
    });
    assert.match(compiled.sourceDigest, /^sha256:[a-f0-9]{64}$/);

    const preflight = await preflightPersona(sourcePath);
    assert.equal(preflight.persona.id, 'golden-agent');
    assert.equal(preflight.compiledAgent?.sourceKind, 'single-file');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('preflight evaluates a single-file Agent source exactly once', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'compiled-agent-once-'));
  const counterKey = `__agentworkforce_compile_${Date.now()}_${Math.random()}`;
  const counters = globalThis as unknown as Record<string, unknown>;
  try {
    const sourcePath = path.join(dir, 'agent.ts');
    const source = PRESET.replace(
      "import { defineAgent } from '@agentworkforce/runtime';",
      `import { defineAgent } from '@agentworkforce/runtime';\n` +
      `const counters = globalThis as unknown as Record<string, number>;\n` +
      `counters[${JSON.stringify(counterKey)}] = (counters[${JSON.stringify(counterKey)}] ?? 0) + 1;`
    );
    await writeFile(sourcePath, source);
    await preflightPersona(sourcePath);
    assert.equal(counters[counterKey], 1);
  } finally {
    delete counters[counterKey];
    await rm(dir, { recursive: true, force: true });
  }
});

test('single-file detection routes invalid persona fields to precise validation', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'compiled-agent-invalid-'));
  try {
    const sourcePath = path.join(dir, 'agent.ts');
    await writeFile(sourcePath, PRESET.replace("description: 'Golden single-file agent.'", 'description: 42'));
    await assert.rejects(compileAgentSource(sourcePath), /description/);
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
    assert.deepEqual(persisted.persona.futurePersonaPolicy, {
      owner: 'cloud',
      revision: 2
    });
    assert.deepEqual(persisted.persona.capabilities?.futureCapability, {
      enabled: true,
      nested: { mode: 'golden', values: [1, 2, 3] }
    });
    assert.deepEqual(persisted.agent.triggers?.github[0].conditions, {
      labels: ['ready']
    });
    assert.deepEqual(persisted.agent.triggers?.github[0].futureTriggerOption, {
      delivery: 'batched'
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('split agent top-level extensions survive source-to-persistence projection', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'compiled-agent-split-extensions-'));
  try {
    const personaPath = path.join(dir, 'persona.json');
    const agentPath = path.join(dir, 'agent.ts');
    await writeFile(personaPath, JSON.stringify({
      id: 'split-extension-agent',
      intent: 'relay-orchestrator',
      tags: ['discovery'],
      description: 'Split extension fixture.',
      skills: [],
      harness: 'claude',
      model: 'claude-haiku-4-5-20251001',
      systemPrompt: 'Keep extensions.',
      harnessSettings: { reasoning: 'low', timeoutSeconds: 300 },
      integrations: { github: {} },
      cloud: true,
      onEvent: './agent.ts'
    }), 'utf8');
    await writeFile(agentPath, `
      import { defineAgent } from '@agentworkforce/runtime';
      export default defineAgent({
        futureDispatchPolicy: { queue: 'priority', revision: 3 },
        triggers: {
          github: [{ on: 'pull_request.opened', futureTriggerOption: true }]
        },
        handler: async () => {}
      });
    `, 'utf8');

    const persisted = projectCompiledAgentForPersistence(
      await compileAgentSource(personaPath)
    );
    assert.deepEqual(persisted.agent.futureDispatchPolicy, {
      queue: 'priority',
      revision: 3
    });
    assert.equal(
      persisted.agent.triggers?.github[0].futureTriggerOption,
      true
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('trigger paths survive source-to-persistence projection for wake scoping', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'compiled-agent-trigger-paths-'));
  try {
    const sourcePath = path.join(dir, 'agent.ts');
    const source = PRESET
      .replace('integrations: { github: {} },', 'integrations: { github: {}, slack: {} },')
      .replace(
        PRESET_TRIGGER_BLOCK,
        "  triggers: {\n" +
          "    github: [{ on: 'pull_request.opened', paths: ['/github/repos/AgentWorkforce/workforce/pulls/**'] }],\n" +
          "    slack: [{ on: 'message.created', paths: ['/slack/channels/C_REVIEW/**'] }]\n" +
          '  },'
      );
    await writeFile(sourcePath, source);

    const compiled = await compileAgentSource(sourcePath);
    const persisted = projectCompiledAgentForPersistence(compiled);

    assert.deepEqual(persisted.agent.triggers, {
      github: [
        {
          on: 'pull_request.opened',
          paths: ['/github/repos/AgentWorkforce/workforce/pulls/**']
        }
      ],
      slack: [
        {
          on: 'message.created',
          paths: ['/slack/channels/C_REVIEW/**']
        }
      ]
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
