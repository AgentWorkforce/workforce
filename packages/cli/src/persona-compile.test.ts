import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { A2aAgentCardSchema } from '@relaycast/a2a';

import { compilePersonaFile } from './persona-compile.js';

test('compilePersonaFile bundles persona.ts, validates it, and writes persona.json', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aw-persona-compile-'));
  try {
    const inputPath = join(root, 'persona.ts');
    const outputPath = join(root, 'persona.json');
    const agentCardPath = join(root, 'agent-card.json');
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
    github: { scope: { repo: 'org/repo' } },
    linear: {},
    slack: {},
    notion: {},
    jira: {},
    unknown: {}
  },
  skills: [{
    id: 'review-rubric',
    source: '@agentworkforce/review-rubric',
    description: 'Apply the review rubric.'
  }],
  capabilities: {
    review: true,
    issueClaim: false
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
      integrations?: Record<string, { scope?: Record<string, string> }>;
    };

    assert.equal(result.personaId, 'compiled-persona');
    assert.equal(result.outputPath, outputPath);
    assert.equal(result.agentCardPath, agentCardPath);
    assert.equal(compiled.id, 'compiled-persona');
    assert.equal(compiled.inputs?.TARGET, 'repo');
    // Integration connections (source/scope) are preserved; triggers live in agent.ts.
    assert.equal(compiled.integrations?.github.scope?.repo, 'org/repo');
    assert.ok(compiled.integrations?.unknown);

    const card = A2aAgentCardSchema.parse(
      JSON.parse(readFileSync(agentCardPath, 'utf8'))
    );
    assert.equal(card.url, 'http://localhost:3000');
    assert.equal(card.version, '0.0.0');
    assert.ok(card.skills.some((skill) => skill.id === 'review-rubric'));
    assert.ok(card.skills.some((skill) => skill.id === 'review'));
    assert.ok(!card.skills.some((skill) => skill.id === 'issueClaim'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('compilePersonaFile evaluates authored persona.ts beside sibling files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aw-persona-compile-sibling-'));
  try {
    const inputPath = join(root, 'persona.ts');
    const outputPath = join(root, 'persona.json');
    writeFileSync(join(root, 'description.txt'), 'Description from sibling file.\n', 'utf8');
    writeFileSync(
      inputPath,
      `import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { definePersona } from '@agentworkforce/persona-kit';

const description = readFileSync(
  fileURLToPath(new URL('./description.txt', import.meta.url)),
  'utf8'
).trim();

export default definePersona({
  id: 'sibling-persona',
  intent: 'review',
  description,
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
      description: string;
    };

    assert.equal(result.personaId, 'sibling-persona');
    assert.equal(compiled.description, 'Description from sibling file.');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('compilePersonaFile preserves module-relative import.meta.url in local helpers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aw-persona-compile-helper-url-'));
  try {
    const inputPath = join(root, 'persona.ts');
    const outputPath = join(root, 'persona.json');
    mkdirSync(join(root, 'helpers'));
    writeFileSync(join(root, 'helpers', 'description.txt'), 'Description from helper.\n', 'utf8');
    writeFileSync(
      join(root, 'helpers', 'description.ts'),
      `import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const description = readFileSync(
  fileURLToPath(new URL('./description.txt', import.meta.url)),
  'utf8'
).trim();
`,
      'utf8'
    );
    writeFileSync(
      inputPath,
      `import { definePersona } from '@agentworkforce/persona-kit';
import { description } from './helpers/description';

export default definePersona({
  id: 'helper-url-persona',
  intent: 'review',
  description,
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
      description: string;
    };

    assert.equal(result.personaId, 'helper-url-persona');
    assert.equal(compiled.description, 'Description from helper.');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('compilePersonaFile evaluates CommonJS persona modules with node builtins', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aw-persona-compile-cjs-'));
  try {
    const inputPath = join(root, 'persona.cjs');
    const outputPath = join(root, 'persona.json');
    writeFileSync(join(root, 'description.txt'), 'Description from CommonJS.\n', 'utf8');
    writeFileSync(
      inputPath,
      `const { readFileSync } = require('node:fs');

exports.default = {
  id: 'cjs-persona',
  intent: 'review',
  description: readFileSync(__dirname + '/description.txt', 'utf8').trim(),
  onEvent: './agent.ts',
  harnessSettings: {
    reasoning: 'medium',
    timeoutSeconds: 60
  }
};
`,
      'utf8'
    );

    const result = await compilePersonaFile(inputPath);
    const compiled = JSON.parse(readFileSync(outputPath, 'utf8')) as {
      description: string;
    };

    assert.equal(result.personaId, 'cjs-persona');
    assert.equal(compiled.description, 'Description from CommonJS.');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('compilePersonaFile rewrites module locations inside template expressions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aw-persona-compile-template-location-'));
  try {
    const inputPath = join(root, 'persona.ts');
    const outputPath = join(root, 'persona.json');
    writeFileSync(join(root, 'description.txt'), 'Description from template path.\n', 'utf8');
    writeFileSync(
      inputPath,
      `import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { definePersona } from '@agentworkforce/persona-kit';

const descriptionFromDir = readFileSync(\`\${__dirname}/description.txt\`, 'utf8').trim();
const descriptionFromUrl = readFileSync(
  fileURLToPath(new URL('./description.txt', \`\${import.meta.url}\`)),
  'utf8'
).trim();

export default definePersona({
  id: 'template-location-persona',
  intent: 'review',
  description: \`\${descriptionFromDir} / \${descriptionFromUrl}\`,
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
      description: string;
    };

    assert.equal(result.personaId, 'template-location-persona');
    assert.equal(
      compiled.description,
      'Description from template path. / Description from template path.'
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('compilePersonaFile removes the temporary evaluated module', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aw-persona-compile-cleanup-'));
  try {
    const inputPath = join(root, 'persona.ts');
    const isolatedTemp = join(root, 'tmp');
    mkdirSync(isolatedTemp);
    writeFileSync(
      inputPath,
      `export default {
  id: 'cleanup-persona',
  intent: 'review',
  description: 'Cleanup persona fixture.',
  onEvent: './agent.ts',
  harnessSettings: { reasoning: 'medium', timeoutSeconds: 60 }
};
`,
      'utf8'
    );

    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { compilePersonaFile } from ${JSON.stringify(new URL('./persona-compile.js', import.meta.url).href)}; await compilePersonaFile(process.argv[1]);`,
        inputPath
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, TMPDIR: isolatedTemp }
      }
    );
    assert.equal(child.status, 0, child.stderr || child.stdout);
    const leftovers = readdirSync(isolatedTemp).filter((name) =>
      name.startsWith('agentworkforce-persona-')
    );
    assert.deepEqual(leftovers, []);
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
