import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createComposePreviewResult,
  loadTeamSpec,
  parseTeamSpecFile,
  planTeamSpec,
  TEAM_SPEC_JSON_SCHEMA,
  TeamSpecError,
  validateTeamSpec
} from './index.js';

const SPEC = {
  id: 'cloud-team-issue',
  lead: 'cloud-team-issue',
  members: [
    { name: 'implementer', persona: { slug: 'cloud-team-implementer' }, role: 'implementer' },
    { name: 'reviewer', persona: { slug: 'cloud-team-reviewer' }, role: 'reviewer' }
  ],
  tokenBudget: 400000,
  timeBudgetSeconds: 1800
};

test('loads the canonical team.json shape from spec section 12.3', () => {
  assert.deepEqual(loadTeamSpec(SPEC), SPEC);
  assert.deepEqual(validateTeamSpec(SPEC, { expectedId: 'cloud-team-issue' }), []);
  assert.equal(TEAM_SPEC_JSON_SCHEMA.properties.members.minItems, 1);
});

test('matches Cloud validation for persona refs, budgets, names, and ownership', () => {
  assert.throws(() => loadTeamSpec({ ...SPEC, tokenBudget: 0 }), /positive 32-bit integer/);
  assert.throws(() => loadTeamSpec({ ...SPEC, members: [{ name: 'x', persona: { version: 1 } }] }), /must include slug, path, or inline/);
  assert.throws(() => loadTeamSpec({ ...SPEC, members: [{ name: 'x', persona: 'a' }, { name: 'x', persona: 'b' }] }), /duplicate member name/);
  assert.throws(() => loadTeamSpec({ ...SPEC, members: [
    { name: 'a', persona: 'a', owns: [{ provider: 'linear', on: 'issue.created' }] },
    { name: 'b', persona: 'b', owns: [{ on: 'issue.created', provider: 'linear' }] }
  ] }), /claimed by both/);
  assert.throws(() => loadTeamSpec(null), TeamSpecError);
});

test('Compose preview resolves the roster and launches zero children', () => {
  const plan = planTeamSpec(SPEC);
  assert.equal(plan.status, 'valid');
  assert.deepEqual(plan.nodes.map((node) => node.id), ['cloud-team-issue', 'implementer', 'reviewer']);
  assert.deepEqual(plan.budget, { tokenBudget: 400000, timeBudgetSeconds: 1800 });
  const result = createComposePreviewResult(plan);
  assert.equal(result.status, 'previewed');
  assert.deepEqual(result.childRunIds, []);
});

test('file parser requires team id to match its directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'compose-team-'));
  try {
    const dir = join(root, 'expected');
    await mkdir(dir);
    const file = join(dir, 'team.json');
    await writeFile(file, JSON.stringify({ ...SPEC, id: 'wrong' }));
    await assert.rejects(() => parseTeamSpecFile(file), /must match team directory "expected"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
