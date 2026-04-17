import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadLocalPersonas } from './local-personas.js';

type Dirs = { cwd: string; home: string; pwdDir: string; homeDir: string };

function withLayers<T>(fn: (dirs: Dirs) => T): T {
  const root = mkdtempSync(join(tmpdir(), 'agentworkforce-cascade-'));
  const cwd = join(root, 'project');
  const home = join(root, 'home');
  const pwdDir = join(cwd, '.agent-workforce');
  const homeDir = join(home, '.agent-workforce');
  mkdirSync(pwdDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  try {
    return fn({ cwd, home, pwdDir, homeDir });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value));
}

test('home layer extends library and merges env', () => {
  withLayers(({ cwd, homeDir }) => {
    writeJson(join(homeDir, 'my-posthog.json'), {
      id: 'my-posthog',
      extends: 'posthog',
      env: { POSTHOG_API_KEY: '$POSTHOG_API_KEY', EXTRA: 'literal' }
    });
    const loaded = loadLocalPersonas({ cwd, homeDir });
    assert.deepEqual(loaded.warnings, []);
    const spec = loaded.byId.get('my-posthog');
    assert.ok(spec);
    assert.equal(loaded.sources.get('my-posthog'), 'home');
    assert.equal(spec.intent, 'posthog');
    assert.equal(spec.env?.POSTHOG_API_KEY, '$POSTHOG_API_KEY');
    assert.equal(spec.env?.EXTRA, 'literal');
    assert.ok(spec.mcpServers?.posthog);
  });
});

test('pwd layer overrides home layer for the same id', () => {
  withLayers(({ cwd, homeDir, pwdDir }) => {
    writeJson(join(homeDir, 'ph.json'), {
      id: 'ph',
      extends: 'posthog',
      env: { POSTHOG_API_KEY: 'home-value', FROM_HOME: 'yes' }
    });
    writeJson(join(pwdDir, 'ph.json'), {
      id: 'ph',
      extends: 'posthog',
      env: { POSTHOG_API_KEY: 'pwd-value' }
    });
    const loaded = loadLocalPersonas({ cwd, homeDir });
    assert.deepEqual(loaded.warnings, []);
    const spec = loaded.byId.get('ph');
    assert.equal(loaded.sources.get('ph'), 'pwd');
    // pwd's env wins; note home is NOT layered here (pwd overrides home as a whole,
    // not merges). Base is library/posthog directly via pwd's own `extends`.
    assert.equal(spec?.env?.POSTHOG_API_KEY, 'pwd-value');
    assert.equal(spec?.env?.FROM_HOME, undefined);
  });
});

test('implicit same-id extends: pwd file with id=posthog inherits from library posthog', () => {
  withLayers(({ cwd, homeDir, pwdDir }) => {
    writeJson(join(pwdDir, 'posthog.json'), {
      id: 'posthog',
      env: { POSTHOG_API_KEY: '$POSTHOG_API_KEY' }
    });
    const loaded = loadLocalPersonas({ cwd, homeDir });
    assert.deepEqual(loaded.warnings, []);
    const spec = loaded.byId.get('posthog');
    assert.ok(spec);
    assert.equal(loaded.sources.get('posthog'), 'pwd');
    // Library fields still flow through (mcpServers, tiers, description).
    assert.ok(spec.mcpServers?.posthog);
    assert.equal(spec.tiers.best.harness, 'claude');
    assert.equal(spec.env?.POSTHOG_API_KEY, '$POSTHOG_API_KEY');
  });
});

test('cascade chain: pwd extends home extends library', () => {
  withLayers(({ cwd, homeDir, pwdDir }) => {
    // home defines a mid-layer override that adds a default env key.
    writeJson(join(homeDir, 'ph-base.json'), {
      id: 'ph-base',
      extends: 'posthog',
      env: { DEFAULT_ORG: 'acme' }
    });
    // pwd extends the home persona (not the library directly).
    writeJson(join(pwdDir, 'ph-prod.json'), {
      id: 'ph-prod',
      extends: 'ph-base',
      env: { POSTHOG_API_KEY: '$PROD_KEY' }
    });
    const loaded = loadLocalPersonas({ cwd, homeDir });
    assert.deepEqual(loaded.warnings, []);
    const prod = loaded.byId.get('ph-prod');
    assert.ok(prod);
    // Both env keys flow through the chain.
    assert.equal(prod.env?.DEFAULT_ORG, 'acme');
    assert.equal(prod.env?.POSTHOG_API_KEY, '$PROD_KEY');
    // MCP from library is preserved.
    assert.ok(prod.mcpServers?.posthog);
  });
});

test('per-tier override only replaces the named tier, leaving others untouched', () => {
  withLayers(({ cwd, homeDir }) => {
    writeJson(join(homeDir, 'ph.json'), {
      id: 'ph',
      extends: 'posthog',
      tiers: {
        best: { model: 'claude-sonnet-4-6' }
      }
    });
    const loaded = loadLocalPersonas({ cwd, homeDir });
    const spec = loaded.byId.get('ph');
    assert.equal(spec?.tiers.best.model, 'claude-sonnet-4-6');
    // systemPrompt is inherited on the overridden tier too (partial per-tier merge).
    assert.match(spec?.tiers.best.systemPrompt ?? '', /PostHog/);
    // Other tiers untouched.
    assert.equal(spec?.tiers['best-value'].model, 'claude-sonnet-4-6');
    assert.equal(spec?.tiers.minimum.model, 'claude-haiku-4-5-20251001');
  });
});

test('top-level systemPrompt replaces prompt across all inherited tiers', () => {
  withLayers(({ cwd, homeDir }) => {
    writeJson(join(homeDir, 'ph.json'), {
      id: 'ph',
      extends: 'posthog',
      systemPrompt: 'You answer only yes or no.'
    });
    const loaded = loadLocalPersonas({ cwd, homeDir });
    const spec = loaded.byId.get('ph');
    assert.equal(spec?.tiers.best.systemPrompt, 'You answer only yes or no.');
    assert.equal(spec?.tiers['best-value'].systemPrompt, 'You answer only yes or no.');
    assert.equal(spec?.tiers.minimum.systemPrompt, 'You answer only yes or no.');
  });
});

test('warns when extends base does not exist in lower layers', () => {
  withLayers(({ cwd, homeDir }) => {
    writeJson(join(homeDir, 'broken.json'), {
      id: 'broken',
      extends: 'does-not-exist'
    });
    const loaded = loadLocalPersonas({ cwd, homeDir });
    assert.equal(loaded.byId.size, 0);
    assert.equal(loaded.warnings.length, 1);
    assert.match(loaded.warnings[0], /does-not-exist/);
  });
});

test('warns on duplicate ids within a single layer', () => {
  withLayers(({ cwd, homeDir }) => {
    writeJson(join(homeDir, 'a.json'), { id: 'dup', extends: 'posthog' });
    writeJson(join(homeDir, 'b.json'), { id: 'dup', extends: 'posthog' });
    const loaded = loadLocalPersonas({ cwd, homeDir });
    assert.equal(loaded.byId.size, 1);
    assert.equal(loaded.warnings.length, 1);
    assert.match(loaded.warnings[0], /duplicate id "dup"/);
  });
});

test('returns empty result when neither layer exists', () => {
  const loaded = loadLocalPersonas({
    cwd: '/tmp/agentworkforce-nonexistent-pwd-zzz',
    homeDir: '/tmp/agentworkforce-nonexistent-home-zzz'
  });
  assert.equal(loaded.byId.size, 0);
  assert.deepEqual(loaded.warnings, []);
});

test('permissions merge: allow/deny union dedup, mode overrides', () => {
  withLayers(({ cwd, homeDir, pwdDir }) => {
    // Base posthog already has permissions.allow = ["mcp__posthog"] in the
    // library file. Home adds a Bash deny + sets default mode; pwd adds
    // another allow and overrides the mode.
    writeJson(join(homeDir, 'ph.json'), {
      id: 'ph',
      extends: 'posthog',
      permissions: {
        deny: ['Bash(rm -rf *)'],
        mode: 'default'
      }
    });
    writeJson(join(pwdDir, 'ph.json'), {
      id: 'ph',
      extends: 'ph',
      permissions: {
        allow: ['Bash(git *)'],
        mode: 'acceptEdits'
      }
    });
    const loaded = loadLocalPersonas({ cwd, homeDir });
    assert.deepEqual(loaded.warnings, []);
    const spec = loaded.byId.get('ph');
    assert.deepEqual(
      spec?.permissions?.allow?.slice().sort(),
      ['Bash(git *)', 'mcp__posthog'].sort()
    );
    assert.deepEqual(spec?.permissions?.deny, ['Bash(rm -rf *)']);
    assert.equal(spec?.permissions?.mode, 'acceptEdits');
  });
});

test('permissions allow list dedupes across layers', () => {
  withLayers(({ cwd, homeDir }) => {
    writeJson(join(homeDir, 'ph.json'), {
      id: 'ph',
      extends: 'posthog',
      permissions: { allow: ['mcp__posthog'] }
    });
    const loaded = loadLocalPersonas({ cwd, homeDir });
    const spec = loaded.byId.get('ph');
    assert.deepEqual(spec?.permissions?.allow, ['mcp__posthog']);
  });
});

test('surfaces parse errors as per-file warnings without throwing', () => {
  withLayers(({ cwd, homeDir }) => {
    writeFileSync(join(homeDir, 'bad.json'), '{ not valid json');
    const loaded = loadLocalPersonas({ cwd, homeDir });
    assert.equal(loaded.byId.size, 0);
    assert.equal(loaded.warnings.length, 1);
    assert.match(loaded.warnings[0], /bad\.json/);
  });
});
