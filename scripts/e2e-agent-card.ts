import assert from 'node:assert/strict';
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { A2aAgentCardSchema } from '@relaycast/a2a';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtureDir = mkdtempSync(join(repoRoot, '.tmp-e2e-agent-card-'));
const personaPath = join(fixtureDir, 'persona.ts');
const personaJsonPath = join(fixtureDir, 'persona.json');
const agentCardPath = join(fixtureDir, 'agent-card.json');
const baseUrl = 'https://review-agent.example.test';
const version = '9.8.7-e2e';

try {
  // Exercise the real checked-in example without mutating its generated files.
  cpSync(join(repoRoot, 'examples/review-agent/persona.ts'), personaPath);

  runCli([
    'persona',
    'compile',
    personaPath,
    '--base-url',
    baseUrl,
    '--version',
    version
  ]);

  const emittedJson = readFileSync(agentCardPath, 'utf8');
  const emittedCard = A2aAgentCardSchema.parse(JSON.parse(emittedJson));
  const skillIds = emittedCard.skills.map((skill) => skill.id);

  assert.ok(
    skillIds.includes('review-rubric'),
    'compiled card must include the example persona declared skill'
  );
  assert.ok(
    skillIds.includes('review'),
    'compiled card must include the enabled review capability'
  );
  assert.ok(
    !skillIds.includes('issueClaim'),
    'compiled card must omit the disabled issueClaim capability'
  );

  const cliJson = runCli([
    'agent-card',
    personaPath,
    '--base-url',
    baseUrl,
    '--version',
    version,
    '--json'
  ]);
  const mcpJson = runMcpTool();

  assert.equal(
    cliJson,
    mcpJson,
    'CLI --json and mcp-workforce get_agent_card JSON must be byte-identical'
  );
  assert.deepEqual(
    A2aAgentCardSchema.parse(JSON.parse(cliJson)),
    emittedCard,
    'compile and discovery surfaces must derive the same card'
  );

  const originalSource = readFileSync(personaPath, 'utf8');
  const toggledSource = originalSource
    .replace('review: true', 'review: false')
    .replace('issueClaim: false', 'issueClaim: true');
  assert.notEqual(
    toggledSource,
    originalSource,
    'E2E fixture must contain the capability flags it toggles'
  );
  writeFileSync(personaPath, toggledSource, 'utf8');

  runCli([
    'persona',
    'compile',
    personaPath,
    '--base-url',
    baseUrl,
    '--version',
    version
  ]);
  const toggledCard = A2aAgentCardSchema.parse(
    JSON.parse(readFileSync(agentCardPath, 'utf8'))
  );
  const toggledSkillIds = toggledCard.skills.map((skill) => skill.id);
  assert.ok(
    !toggledSkillIds.includes('review'),
    'disabling review in the persona must remove it from the compiled card'
  );
  assert.ok(
    toggledSkillIds.includes('issueClaim'),
    'enabling issueClaim in the persona must add it to the compiled card'
  );

  process.stdout.write(
    `agent-card E2E passed: ${emittedCard.name} (${skillIds.join(', ')} -> ${toggledSkillIds.join(', ')})\n`
  );
} finally {
  rmSync(fixtureDir, { recursive: true, force: true });
}

function runCli(args: string[]): string {
  const result = spawnSync(
    process.execPath,
    [join(repoRoot, 'packages/cli/dist/cli.js'), ...args],
    { cwd: repoRoot, encoding: 'utf8' }
  );
  if (result.status !== 0) {
    throw new Error(
      `CLI failed (${args.join(' ')}):\n${result.stderr || result.stdout}`
    );
  }
  return result.stdout;
}

function runMcpTool(): string {
  // Invoke the registered MCP handler, including its JSON text presenter, in
  // plain Node. This tests the real get_agent_card registration while keeping
  // tsx's CJS compatibility hook away from unrelated ESM-only server deps.
  const script = `
    import { readFileSync } from 'node:fs';
    import { createWorkforceMcpServer } from './packages/mcp-workforce/dist/server.js';
    const server = createWorkforceMcpServer({
      workspaceId: 'agent-card-e2e',
      cloudUrl: 'https://cloud.agentworkforce.com',
      writebackTimeoutMs: 30000
    });
    const tool = server._registeredTools?.get_agent_card;
    if (!tool?.handler) throw new Error('get_agent_card is not registered');
    const persona = JSON.parse(readFileSync(process.env.AGENT_CARD_PERSONA_PATH, 'utf8'));
    const result = await tool.handler({
      persona,
      baseUrl: process.env.AGENT_CARD_BASE_URL,
      version: process.env.AGENT_CARD_VERSION
    }, {});
    const text = result.content?.[0]?.text;
    if (typeof text !== 'string') throw new Error('get_agent_card returned no JSON text');
    process.stdout.write(text);
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      AGENT_CARD_PERSONA_PATH: personaJsonPath,
      AGENT_CARD_BASE_URL: baseUrl,
      AGENT_CARD_VERSION: version
    }
  });
  if (result.status !== 0) {
    throw new Error(`MCP get_agent_card failed:\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}
