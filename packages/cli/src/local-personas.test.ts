import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadLocalPersonas, loadPersonaSourceConfig } from './local-personas.js';

type Dirs = { cwd: string; home: string; pwdDir: string; homeDir: string };

function withLayers<T>(fn: (dirs: Dirs) => T): T {
  const root = mkdtempSync(join(tmpdir(), 'agentworkforce-cascade-'));
  const cwd = join(root, 'project');
  const home = join(root, 'home');
  const pwdDir = join(cwd, '.agentworkforce', 'workforce', 'personas');
  const homeDir = join(home, '.agentworkforce', 'workforce', 'personas');
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

test('user layer extends library and merges env', () => {
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
    assert.equal(loaded.sources.get('my-posthog'), 'user');
    assert.equal(spec.intent, 'posthog');
    assert.equal(spec.env?.POSTHOG_API_KEY, '$POSTHOG_API_KEY');
    assert.equal(spec.env?.EXTRA, 'literal');
    assert.ok(spec.mcpServers?.posthog);
  });
});

test('cwd layer overrides user layer for the same id', () => {
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
    assert.equal(loaded.sources.get('ph'), 'cwd');
    // cwd's env wins; note user is NOT layered here (cwd overrides user as a whole,
    // not merges). Base is library/posthog directly via cwd's own `extends`.
    assert.equal(spec?.env?.POSTHOG_API_KEY, 'pwd-value');
    assert.equal(spec?.env?.FROM_HOME, undefined);
  });
});

test('implicit same-id extends: cwd file with id=posthog inherits from library posthog', () => {
  withLayers(({ cwd, homeDir, pwdDir }) => {
    writeJson(join(pwdDir, 'posthog.json'), {
      id: 'posthog',
      env: { POSTHOG_API_KEY: '$POSTHOG_API_KEY' }
    });
    const loaded = loadLocalPersonas({ cwd, homeDir });
    assert.deepEqual(loaded.warnings, []);
    const spec = loaded.byId.get('posthog');
    assert.ok(spec);
    assert.equal(loaded.sources.get('posthog'), 'cwd');
    // Library fields still flow through (mcpServers, tiers, description).
    assert.ok(spec.mcpServers?.posthog);
    assert.equal(spec.tiers.best.harness, 'claude');
    assert.equal(spec.env?.POSTHOG_API_KEY, '$POSTHOG_API_KEY');
  });
});

test('cascade chain: cwd extends user extends library', () => {
  withLayers(({ cwd, homeDir, pwdDir }) => {
    // user defines a mid-layer override that adds a default env key.
    writeJson(join(homeDir, 'ph-base.json'), {
      id: 'ph-base',
      extends: 'posthog',
      env: { DEFAULT_ORG: 'acme' }
    });
    // cwd extends the user persona (not the library directly).
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

test('configured source directories cascade in configured order', () => {
  withLayers(({ cwd, home, homeDir }) => {
    const extraDir = join(home, 'checked-out-personas');
    mkdirSync(extraDir, { recursive: true });
    writeJson(join(homeDir, 'ph.json'), {
      id: 'ph',
      extends: 'posthog',
      env: { DEFAULT_ORG: 'acme', POSTHOG_API_KEY: 'user-key' }
    });
    writeJson(join(extraDir, 'ph.json'), {
      id: 'ph',
      env: { POSTHOG_API_KEY: 'extra-key' }
    });
    const configPath = join(home, '.agentworkforce', 'workforce', 'config.json');
    writeJson(configPath, { personaDirs: [extraDir, homeDir] });

    const loaded = loadLocalPersonas({ cwd, userPersonaDir: homeDir, configPath });
    assert.deepEqual(loaded.warnings, []);
    const spec = loaded.byId.get('ph');
    assert.equal(loaded.sources.get('ph'), 'dir:1');
    assert.equal(spec?.env?.DEFAULT_ORG, 'acme');
    assert.equal(spec?.env?.POSTHOG_API_KEY, 'extra-key');
  });
});

test('source config defaults to the dotless user persona directory', () => {
  withLayers(({ home }) => {
    const workforceHomeDir = join(home, '.agentworkforce', 'workforce');
    const config = loadPersonaSourceConfig({ workforceHomeDir });
    assert.equal(config.userPersonaDir, join(workforceHomeDir, 'personas'));
    assert.deepEqual(config.personaDirs, [join(workforceHomeDir, 'personas')]);
  });
});

test('cwd workforce config file is not scanned as a persona', () => {
  withLayers(({ cwd, homeDir, pwdDir }) => {
    writeJson(join(cwd, '.agentworkforce', 'workforce', 'config.json'), {
      personaDirs: [homeDir]
    });
    writeJson(join(pwdDir, 'ph.json'), {
      id: 'ph',
      extends: 'posthog'
    });
    const loaded = loadLocalPersonas({ cwd, homeDir });
    assert.deepEqual(loaded.warnings, []);
    assert.ok(loaded.byId.has('ph'));
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

test('warns when an overlay combines extends with standalone intent', () => {
  withLayers(({ cwd, homeDir }) => {
    writeJson(join(homeDir, 'broken.json'), {
      id: 'broken',
      extends: 'posthog',
      intent: 'review'
    });
    const loaded = loadLocalPersonas({ cwd, homeDir });
    assert.equal(loaded.byId.size, 0);
    assert.equal(loaded.warnings.length, 1);
    assert.match(loaded.warnings[0], /intent cannot be combined with \.extends/);
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

test('AGENT_WORKFORCE_CONFIG_DIR is trimmed before use (whitespace tolerated)', () => {
  withLayers(({ cwd, homeDir }) => {
    writeJson(join(homeDir, 'my-posthog.json'), {
      id: 'my-posthog',
      extends: 'posthog'
    });
    const prev = process.env.AGENT_WORKFORCE_CONFIG_DIR;
    process.env.AGENT_WORKFORCE_CONFIG_DIR = `   ${homeDir}   `;
    try {
      // Don't pass homeDir — force the loader to fall back to the env var,
      // which is the code path that used to return the untrimmed value.
      const loaded = loadLocalPersonas({ cwd });
      assert.ok(
        loaded.byId.has('my-posthog'),
        'persona should load despite whitespace in AGENT_WORKFORCE_CONFIG_DIR'
      );
    } finally {
      if (prev === undefined) delete process.env.AGENT_WORKFORCE_CONFIG_DIR;
      else process.env.AGENT_WORKFORCE_CONFIG_DIR = prev;
    }
  });
});

test('AGENT_WORKFORCE_CONFIG_DIR does not bypass configured source dirs', () => {
  withLayers(({ home, homeDir }) => {
    const extraDir = join(home, 'extra-personas');
    mkdirSync(extraDir, { recursive: true });
    const workforceHomeDir = join(home, '.agentworkforce', 'workforce');
    writeJson(join(workforceHomeDir, 'config.json'), {
      personaDirs: [homeDir, extraDir]
    });

    const prev = process.env.AGENT_WORKFORCE_CONFIG_DIR;
    process.env.AGENT_WORKFORCE_CONFIG_DIR = `   ${homeDir}   `;
    try {
      const config = loadPersonaSourceConfig({ workforceHomeDir });
      assert.equal(config.userPersonaDir, homeDir);
      assert.deepEqual(config.personaDirs, [homeDir, extraDir]);
    } finally {
      if (prev === undefined) delete process.env.AGENT_WORKFORCE_CONFIG_DIR;
      else process.env.AGENT_WORKFORCE_CONFIG_DIR = prev;
    }
  });
});

test('source config reads defaultCreateTarget', () => {
  withLayers(({ home, homeDir }) => {
    const workforceHomeDir = join(home, '.agentworkforce', 'workforce');
    const configPath = join(workforceHomeDir, 'config.json');
    writeJson(configPath, {
      personaDirs: [homeDir],
      defaultCreateTarget: 'user'
    });

    const loaded = loadPersonaSourceConfig({ workforceHomeDir });
    assert.equal(loaded.defaultCreateTarget, 'user');
    assert.deepEqual(loaded.personaDirs, [homeDir]);
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
    // library file. User adds a Bash deny + sets default mode; cwd adds
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

test('inputs merge across local persona layers', () => {
  withLayers(({ cwd, homeDir, pwdDir }) => {
    writeJson(join(homeDir, 'maker-base.json'), {
      id: 'maker-base',
      extends: 'persona-maker',
      inputs: {
        TARGET_DIR: {
          default: '/tmp/user-personas'
        }
      }
    });
    writeJson(join(pwdDir, 'maker-project.json'), {
      id: 'maker-project',
      extends: 'maker-base',
      inputs: {
        CREATE_MODE: {
          default: 'local'
        }
      }
    });
    const loaded = loadLocalPersonas({ cwd, homeDir });
    assert.deepEqual(loaded.warnings, []);
    const spec = loaded.byId.get('maker-project');
    assert.equal(spec?.inputs?.TARGET_DIR.default, '/tmp/user-personas');
    assert.equal(spec?.inputs?.CREATE_MODE.default, 'local');
  });
});

test('mount patterns merge across local persona layers', () => {
  withLayers(({ cwd, homeDir, pwdDir }) => {
    writeJson(join(homeDir, 'site-agent.json'), {
      id: 'site-agent',
      extends: 'frontend-implementer',
      mount: {
        ignoredPatterns: ['.env*'],
        readonlyPatterns: ['*']
      }
    });
    writeJson(join(pwdDir, 'site-agent.json'), {
      id: 'site-agent',
      extends: 'site-agent',
      mount: {
        ignoredPatterns: ['secrets/**'],
        readonlyPatterns: ['!app/**']
      }
    });
    const loaded = loadLocalPersonas({ cwd, homeDir });
    assert.deepEqual(loaded.warnings, []);
    const spec = loaded.byId.get('site-agent');
    assert.deepEqual(spec?.mount?.ignoredPatterns, ['.env*', 'secrets/**']);
    assert.deepEqual(spec?.mount?.readonlyPatterns, ['*', '!app/**']);
  });
});

test('inputs are preserved on standalone local personas', () => {
  withLayers(({ cwd, homeDir }) => {
    writeJson(join(homeDir, 'standalone-reviewer.json'), {
      id: 'standalone-reviewer',
      intent: 'review',
      tags: ['review'],
      description: 'Reviews with a standalone local prompt.',
      inputs: {
        TARGET_DIR: {
          default: '/tmp/reviews'
        }
      },
      tiers: {
        best: {
          harness: 'codex',
          model: 'openai-codex/gpt-5.3-codex',
          systemPrompt: 'Write to $TARGET_DIR.',
          harnessSettings: { reasoning: 'high', timeoutSeconds: 30 }
        },
        'best-value': {
          harness: 'opencode',
          model: 'opencode/gpt-5-nano',
          systemPrompt: 'Write to $TARGET_DIR.',
          harnessSettings: { reasoning: 'medium', timeoutSeconds: 30 }
        },
        minimum: {
          harness: 'opencode',
          model: 'opencode/minimax-m2.5-free',
          systemPrompt: 'Write to $TARGET_DIR.',
          harnessSettings: { reasoning: 'low', timeoutSeconds: 30 }
        }
      }
    });
    const loaded = loadLocalPersonas({ cwd, homeDir });
    assert.deepEqual(loaded.warnings, []);
    const spec = loaded.byId.get('standalone-reviewer');
    assert.equal(spec?.inputs?.TARGET_DIR.default, '/tmp/reviews');
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

test('top-level claudeMd resolves to absolute path anchored to its layer dir', () => {
  withLayers(({ cwd, homeDir }) => {
    writeFileSync(join(homeDir, 'persona.md'), '# Persona-specific guidance\n');
    writeJson(join(homeDir, 'docs-bot.json'), {
      id: 'docs-bot',
      extends: 'documentation',
      claudeMd: 'persona.md',
      claudeMdMode: 'extend'
    });
    const loaded = loadLocalPersonas({ cwd, homeDir });
    assert.deepEqual(loaded.warnings, []);
    const spec = loaded.byId.get('docs-bot');
    assert.equal(spec?.claudeMd, join(homeDir, 'persona.md'));
    assert.equal(spec?.claudeMdMode, 'extend');
  });
});

test('per-tier claudeMd overrides top-level path; mode resolves independently', () => {
  withLayers(({ cwd, homeDir }) => {
    writeFileSync(join(homeDir, 'top.md'), '# top\n');
    writeFileSync(join(homeDir, 'best.md'), '# best\n');
    writeJson(join(homeDir, 'p.json'), {
      id: 'p',
      extends: 'documentation',
      claudeMd: 'top.md',
      claudeMdMode: 'extend',
      tiers: {
        best: { claudeMd: 'best.md' }
      }
    });
    const loaded = loadLocalPersonas({ cwd, homeDir });
    assert.deepEqual(loaded.warnings, []);
    const spec = loaded.byId.get('p');
    // top-level resolves to top.md
    assert.equal(spec?.claudeMd, join(homeDir, 'top.md'));
    // per-tier `best` resolves to best.md
    assert.equal(spec?.tiers.best.claudeMd, join(homeDir, 'best.md'));
    // mode is independent of path — top-level mode applies, tier inherits.
    assert.equal(spec?.claudeMdMode, 'extend');
  });
});

test('rejects claudeMd with .. segment', () => {
  withLayers(({ cwd, homeDir }) => {
    writeJson(join(homeDir, 'p.json'), {
      id: 'p',
      extends: 'documentation',
      claudeMd: '../escape.md'
    });
    const loaded = loadLocalPersonas({ cwd, homeDir });
    assert.equal(loaded.byId.has('p'), false);
    assert.match(loaded.warnings.join('\n'), /\.\./);
  });
});

test('rejects non-md sidecar path', () => {
  withLayers(({ cwd, homeDir }) => {
    writeJson(join(homeDir, 'p.json'), {
      id: 'p',
      extends: 'documentation',
      claudeMd: 'persona.txt'
    });
    const loaded = loadLocalPersonas({ cwd, homeDir });
    assert.equal(loaded.byId.has('p'), false);
    assert.match(loaded.warnings.join('\n'), /\.md/);
  });
});

test('mode-only override: tier mode flips while inheriting top-level path', () => {
  // A common pattern from the issue's design notes: "Mode independence:
  // tier overrides path, inherits top-level mode (and vice versa)."
  // The cwd-layer override here only sets a tier-level mode, expecting
  // the top-level path declared in a lower layer to flow through.
  withLayers(({ cwd, homeDir, pwdDir }) => {
    writeFileSync(join(homeDir, 'top.md'), '# top\n');
    writeJson(join(homeDir, 'sidecar-base.json'), {
      id: 'sidecar-base',
      extends: 'documentation',
      claudeMd: 'top.md',
      claudeMdMode: 'overwrite'
    });
    // cwd-level overlay flips ONLY the per-tier mode; the path inherits
    // from sidecar-base in the user layer.
    writeJson(join(pwdDir, 'sidecar-base.json'), {
      id: 'sidecar-base',
      extends: 'sidecar-base',
      tiers: {
        best: { claudeMdMode: 'extend' }
      }
    });
    const loaded = loadLocalPersonas({ cwd, homeDir });
    assert.deepEqual(loaded.warnings, []);
    const spec = loaded.byId.get('sidecar-base');
    assert.equal(spec?.claudeMd, join(homeDir, 'top.md'));
    assert.equal(spec?.tiers.best.claudeMdMode, 'extend');
    // Other tiers still inherit the top-level mode.
    assert.equal(spec?.claudeMdMode, 'overwrite');
  });
});

test('missing sidecar file produces a warning, not a throw', () => {
  withLayers(({ cwd, homeDir }) => {
    writeJson(join(homeDir, 'p.json'), {
      id: 'p',
      extends: 'documentation',
      claudeMd: 'missing.md'
    });
    const loaded = loadLocalPersonas({ cwd, homeDir });
    const spec = loaded.byId.get('p');
    assert.ok(spec, 'persona still loads');
    assert.equal(spec?.claudeMd, undefined, 'missing path is dropped from spec');
    assert.match(loaded.warnings.join('\n'), /sidecar file not found/);
  });
});

test('override path clears inherited claudeMdContent so the override is not shadowed', () => {
  // Regression: when a built-in persona inlines `claudeMdContent` and a
  // local override supplies a new `claudeMd` path, runtime selection
  // prefers Content — so the override path was silently discarded.
  // After the fix the override path takes ownership of the channel and
  // the inherited content is dropped from the merged spec.
  withLayers(({ cwd, homeDir }) => {
    writeFileSync(join(homeDir, 'persona.md'), '# Persona override\n');
    // We extend a built-in that has no inlined sidecar today, so
    // simulate the inherited-content scenario by stacking two local
    // layers: user-layer ships content, cwd-layer overrides with a path.
    writeJson(join(homeDir, 'sidecar-stack.json'), {
      id: 'sidecar-stack',
      intent: 'documentation',
      tags: ['documentation'],
      description: 'sidecar stack base',
      tiers: {
        best: {
          harness: 'claude',
          model: 'claude-3-5-sonnet',
          systemPrompt: 'base',
          harnessSettings: { reasoning: 'medium', timeoutSeconds: 300 }
        },
        'best-value': {
          harness: 'claude',
          model: 'claude-3-5-sonnet',
          systemPrompt: 'base',
          harnessSettings: { reasoning: 'medium', timeoutSeconds: 300 }
        },
        minimum: {
          harness: 'claude',
          model: 'claude-3-5-sonnet',
          systemPrompt: 'base',
          harnessSettings: { reasoning: 'medium', timeoutSeconds: 300 }
        }
      },
      claudeMd: 'persona.md'
    });
    const loaded = loadLocalPersonas({ cwd, homeDir });
    assert.deepEqual(loaded.warnings, []);
    const spec = loaded.byId.get('sidecar-stack');
    assert.equal(spec?.claudeMd, join(homeDir, 'persona.md'));
    assert.equal(spec?.claudeMdContent, undefined);
  });
});
