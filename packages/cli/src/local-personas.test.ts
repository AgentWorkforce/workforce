import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  __mergeOverrideForTests,
  formatPersonaSourceLabel,
  loadLocalPersonas,
  loadPersonaSourceConfig,
  type LocalPersonaOverride
} from './local-personas.js';
import type { PersonaSpec } from '@agentworkforce/persona-kit';

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

test('user layer extends internal library and merges env', () => {
  withLayers(({ cwd, homeDir }) => {
    writeJson(join(homeDir, 'my-persona.json'), {
      id: 'my-persona',
      extends: 'persona-maker',
      env: { API_TOKEN: '$API_TOKEN', EXTRA: 'literal' }
    });
    const loaded = loadLocalPersonas({ cwd, homeDir });
    assert.deepEqual(loaded.warnings, []);
    const spec = loaded.byId.get('my-persona');
    assert.ok(spec);
    assert.equal(loaded.sources.get('my-persona'), 'user');
    assert.equal(spec.intent, 'persona-authoring');
    assert.equal(spec.env?.API_TOKEN, '$API_TOKEN');
    assert.equal(spec.env?.EXTRA, 'literal');
  });
});

test('cwd layer overrides user layer for the same id', () => {
  withLayers(({ cwd, homeDir, pwdDir }) => {
    writeJson(join(homeDir, 'ph.json'), {
      id: 'ph',
      extends: 'persona-maker',
      env: { POSTHOG_API_KEY: 'home-value', FROM_HOME: 'yes' }
    });
    writeJson(join(pwdDir, 'ph.json'), {
      id: 'ph',
      extends: 'persona-maker',
      env: { POSTHOG_API_KEY: 'pwd-value' }
    });
    const loaded = loadLocalPersonas({ cwd, homeDir });
    assert.deepEqual(loaded.warnings, []);
    const spec = loaded.byId.get('ph');
    assert.equal(loaded.sources.get('ph'), 'cwd');
    // cwd's env wins; note user is NOT layered here (cwd overrides user as a whole,
    // not merges). Base is persona-maker directly via cwd's own `extends`.
    assert.equal(spec?.env?.POSTHOG_API_KEY, 'pwd-value');
    assert.equal(spec?.env?.FROM_HOME, undefined);
  });
});

test('implicit same-id extends: cwd file with id=persona-maker inherits from library persona-maker', () => {
  withLayers(({ cwd, homeDir, pwdDir }) => {
    writeJson(join(pwdDir, 'persona-maker.json'), {
      id: 'persona-maker',
      env: { POSTHOG_API_KEY: '$POSTHOG_API_KEY' }
    });
    const loaded = loadLocalPersonas({ cwd, homeDir });
    assert.deepEqual(loaded.warnings, []);
    const spec = loaded.byId.get('persona-maker');
    assert.ok(spec);
    assert.equal(loaded.sources.get('persona-maker'), 'cwd');
    // Library fields still flow through (runtime, description, inputs).
    assert.equal(spec.harness, 'opencode');
    assert.equal(spec.inputs?.CREATE_MODE.default, 'local');
    assert.equal(spec.env?.POSTHOG_API_KEY, '$POSTHOG_API_KEY');
  });
});

test('cascade chain: cwd extends user extends library', () => {
  withLayers(({ cwd, homeDir, pwdDir }) => {
    // user defines a mid-layer override that adds a default env key.
    writeJson(join(homeDir, 'ph-base.json'), {
      id: 'ph-base',
      extends: 'persona-maker',
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
    // Library inputs are preserved through the chain.
    assert.equal(prod.inputs?.CREATE_MODE.default, 'local');
  });
});

test('configured source directories cascade in configured order', () => {
  withLayers(({ cwd, home, homeDir }) => {
    const extraDir = join(home, 'checked-out-personas');
    mkdirSync(extraDir, { recursive: true });
    writeJson(join(homeDir, 'ph.json'), {
      id: 'ph',
      extends: 'persona-maker',
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
      extends: 'persona-maker'
    });
    const loaded = loadLocalPersonas({ cwd, homeDir });
    assert.deepEqual(loaded.warnings, []);
    assert.ok(loaded.byId.has('ph'));
  });
});

test('top-level runtime fields override the inherited base', () => {
  withLayers(({ cwd, homeDir }) => {
    writeJson(join(homeDir, 'ph.json'), {
      id: 'ph',
      extends: 'persona-maker',
      model: 'claude-sonnet-4-6'
    });
    const loaded = loadLocalPersonas({ cwd, homeDir });
    const spec = loaded.byId.get('ph');
    assert.equal(spec?.model, 'claude-sonnet-4-6');
    // systemPrompt is inherited when not overridden.
    assert.equal(spec?.systemPrompt, '$TASK_DESCRIPTION');
  });
});

test('top-level systemPrompt replaces the inherited prompt', () => {
  withLayers(({ cwd, homeDir }) => {
    writeJson(join(homeDir, 'ph.json'), {
      id: 'ph',
      extends: 'persona-maker',
      systemPrompt: 'You answer only yes or no.'
    });
    const loaded = loadLocalPersonas({ cwd, homeDir });
    const spec = loaded.byId.get('ph');
    assert.equal(spec?.systemPrompt, 'You answer only yes or no.');
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
      extends: 'persona-maker',
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
    writeJson(join(homeDir, 'a.json'), { id: 'dup', extends: 'persona-maker' });
    writeJson(join(homeDir, 'b.json'), { id: 'dup', extends: 'persona-maker' });
    const loaded = loadLocalPersonas({ cwd, homeDir });
    assert.equal(loaded.byId.size, 1);
    assert.equal(loaded.warnings.length, 1);
    assert.match(loaded.warnings[0], /duplicate id "dup"/);
  });
});

test('AGENT_WORKFORCE_CONFIG_DIR is trimmed before use (whitespace tolerated)', () => {
  withLayers(({ cwd, homeDir }) => {
    writeJson(join(homeDir, 'my-persona.json'), {
      id: 'my-persona',
      extends: 'persona-maker'
    });
    const prev = process.env.AGENT_WORKFORCE_CONFIG_DIR;
    process.env.AGENT_WORKFORCE_CONFIG_DIR = `   ${homeDir}   `;
    try {
      // Don't pass homeDir — force the loader to fall back to the env var,
      // which is the code path that used to return the untrimmed value.
      const loaded = loadLocalPersonas({ cwd });
      assert.ok(
        loaded.byId.has('my-persona'),
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
    // User adds a Bash deny + sets default mode; cwd adds an allow and
    // overrides the mode.
    writeJson(join(homeDir, 'ph.json'), {
      id: 'ph',
      extends: 'persona-maker',
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
      ['Bash(git *)']
    );
    assert.deepEqual(spec?.permissions?.deny, ['Bash(rm -rf *)']);
    assert.equal(spec?.permissions?.mode, 'acceptEdits');
  });
});

test('permissions allow list dedupes across layers', () => {
  withLayers(({ cwd, homeDir }) => {
    writeJson(join(homeDir, 'ph.json'), {
      id: 'ph',
      extends: 'persona-maker',
      permissions: { allow: ['Bash(git *)', 'Bash(git *)'] }
    });
    const loaded = loadLocalPersonas({ cwd, homeDir });
    const spec = loaded.byId.get('ph');
    assert.deepEqual(spec?.permissions?.allow, ['Bash(git *)']);
  });
});

test('codex harness settings merge across local persona layers', () => {
  withLayers(({ cwd, homeDir }) => {
    writeJson(join(homeDir, 'planner.json'), {
      id: 'planner',
      extends: 'persona-maker',
      harnessSettings: {
        sandboxMode: 'workspace-write',
        approvalPolicy: 'on-request',
        workspaceWriteNetworkAccess: true,
        webSearch: true
      }
    });
    const loaded = loadLocalPersonas({ cwd, homeDir });
    assert.deepEqual(loaded.warnings, []);
    const settings = loaded.byId.get('planner')?.harnessSettings;
    // Inherited reasoning passes through; sandbox+approval+network+webSearch overlay.
    assert.ok(settings);
    assert.equal(settings?.sandboxMode, 'workspace-write');
    assert.equal(settings?.approvalPolicy, 'on-request');
    assert.equal(settings?.workspaceWriteNetworkAccess, true);
    assert.equal(settings?.webSearch, true);
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
      extends: 'persona-maker',
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
      harness: 'codex',
      model: 'openai-codex/gpt-5.3-codex',
      systemPrompt: 'Write to $TARGET_DIR.',
      harnessSettings: { reasoning: 'high', timeoutSeconds: 30 }
    });
    const loaded = loadLocalPersonas({ cwd, homeDir });
    assert.deepEqual(loaded.warnings, []);
    const spec = loaded.byId.get('standalone-reviewer');
    assert.equal(spec?.inputs?.TARGET_DIR.default, '/tmp/reviews');
  });
});

test('dangerouslyBypassApprovalsAndSandbox is preserved on standalone local personas', () => {
  withLayers(({ cwd, homeDir }) => {
    writeJson(join(homeDir, 'standalone-bypass.json'), {
      id: 'standalone-bypass',
      intent: 'review',
      description: 'Standalone persona that opts out of codex approvals.',
      harness: 'codex',
      model: 'openai-codex/gpt-5.3-codex',
      systemPrompt: 'Do the work.',
      harnessSettings: {
        reasoning: 'medium',
        timeoutSeconds: 900,
        dangerouslyBypassApprovalsAndSandbox: true
      }
    });
    const loaded = loadLocalPersonas({ cwd, homeDir });
    assert.deepEqual(loaded.warnings, []);
    const settings = loaded.byId.get('standalone-bypass')?.harnessSettings;
    assert.ok(settings);
    // Regression: assertStandaloneHarnessSettings used to rebuild the
    // settings object field-by-field and drop this flag, so codex launched
    // without --dangerously-bypass-approvals-and-sandbox and kept prompting
    // (including for MCP tool calls).
    assert.equal(settings?.dangerouslyBypassApprovalsAndSandbox, true);
  });
});

test('standalone local personas reject bypass with explicit codex sandbox settings', () => {
  withLayers(({ cwd, homeDir }) => {
    writeJson(join(homeDir, 'standalone-bypass-conflict.json'), {
      id: 'standalone-bypass-conflict',
      intent: 'review',
      description: 'Standalone persona with contradictory codex settings.',
      harness: 'codex',
      model: 'openai-codex/gpt-5.3-codex',
      systemPrompt: 'Do the work.',
      harnessSettings: {
        reasoning: 'medium',
        timeoutSeconds: 900,
        sandboxMode: 'workspace-write',
        dangerouslyBypassApprovalsAndSandbox: true
      }
    });

    const loaded = loadLocalPersonas({ cwd, homeDir });
    assert.equal(loaded.byId.has('standalone-bypass-conflict'), false);
    assert.match(
      loaded.warnings.join('\n'),
      /dangerouslyBypassApprovalsAndSandbox is mutually exclusive with: sandboxMode/
    );
  });
});

test('optional input flag is preserved on standalone local personas', () => {
  withLayers(({ cwd, homeDir }) => {
    writeJson(join(homeDir, 'standalone-scaffolder.json'), {
      id: 'standalone-scaffolder',
      intent: 'standalone-scaffolder',
      tags: ['implementation'],
      description: 'Scaffolds with an optional task description sentinel.',
      inputs: {
        TASK_DESCRIPTION: {
          description: 'Optional natural-language task spec.',
          optional: true
        }
      },
      harness: 'codex',
      model: 'openai-codex/gpt-5.3-codex',
      systemPrompt: '$TASK_DESCRIPTION',
      harnessSettings: { reasoning: 'high', timeoutSeconds: 30 }
    });
    const loaded = loadLocalPersonas({ cwd, homeDir });
    assert.deepEqual(loaded.warnings, []);
    const spec = loaded.byId.get('standalone-scaffolder');
    assert.equal(spec?.inputs?.TASK_DESCRIPTION.optional, true);
  });
});

test('standalone local personas accept arbitrary intent names', () => {
  withLayers(({ cwd, homeDir }) => {
    writeJson(join(homeDir, 'nextjs-web-steward.json'), {
      id: 'nextjs-web-steward',
      intent: 'nextjs-web-steward',
      tags: ['implementation'],
      description: 'Stewards Next.js web surfaces.',
      harness: 'codex',
      model: 'openai-codex/gpt-5.3-codex',
      systemPrompt: 'Implement Next.js UI work carefully.',
      harnessSettings: { reasoning: 'high', timeoutSeconds: 30 }
    });

    const loaded = loadLocalPersonas({ cwd, homeDir });
    assert.deepEqual(loaded.warnings, []);
    const spec = loaded.byId.get('nextjs-web-steward');
    assert.equal(spec?.intent, 'nextjs-web-steward');
  });
});

test('rejects an override that still declares a tiers field', () => {
  withLayers(({ cwd, homeDir }) => {
    writeJson(join(homeDir, 'legacy.json'), {
      id: 'legacy',
      extends: 'persona-maker',
      tiers: { best: { model: 'x' } }
    });
    const loaded = loadLocalPersonas({ cwd, homeDir });
    assert.equal(loaded.byId.has('legacy'), false);
    assert.match(loaded.warnings.join('\n'), /tiers is no longer supported/);
  });
});

test('standalone local personas can use inlined AGENTS content as prompt fallback', () => {
  withLayers(({ cwd, homeDir }) => {
    writeJson(join(homeDir, 'nextjs-web-steward.json'), {
      id: 'nextjs-web-steward',
      intent: 'nextjs-web-stewardship',
      tags: ['implementation'],
      description: 'Stewards Next.js web surfaces.',
      agentsMd: 'AGENTS.md',
      agentsMdContent: '# Next.js Web Steward\n\nOwn implementation work in web/.\n',
      harness: 'codex',
      model: 'openai-codex/gpt-5.3-codex',
      systemPrompt: '',
      harnessSettings: { reasoning: 'high', timeoutSeconds: 30 }
    });

    const loaded = loadLocalPersonas({ cwd, homeDir });
    assert.deepEqual(loaded.warnings, []);
    const spec = loaded.byId.get('nextjs-web-steward');
    assert.match(spec?.systemPrompt ?? '', /Next\.js Web Steward/);
    assert.match(spec?.agentsMdContent ?? '', /implementation work/);
    assert.equal(spec?.agentsMd, undefined);
  });
});

test('rejects whitespace-only inlined sidecar content', () => {
  withLayers(({ cwd, homeDir }) => {
    writeJson(join(homeDir, 'blank-top-level.json'), {
      id: 'blank-top-level',
      intent: 'blank-top-level',
      tags: ['implementation'],
      description: 'Invalid blank sidecar content.',
      agentsMdContent: '   ',
      harness: 'codex',
      model: 'openai-codex/gpt-5.3-codex',
      systemPrompt: 'Prompt.',
      harnessSettings: { reasoning: 'high', timeoutSeconds: 30 }
    });

    const loaded = loadLocalPersonas({ cwd, homeDir });
    assert.equal(loaded.byId.has('blank-top-level'), false);
    assert.match(loaded.warnings.join('\n'), /blank-top-level\.json.*agentsMdContent must be a non-empty string/);
  });
});

test('extends can resolve a lower-layer standalone persona by intent', () => {
  withLayers(({ cwd, homeDir, pwdDir }) => {
    writeJson(join(homeDir, 'steward-base.json'), {
      id: 'steward-base',
      intent: 'nextjs-web-stewardship',
      tags: ['implementation'],
      description: 'Base steward persona.',
      harness: 'codex',
      model: 'openai-codex/gpt-5.3-codex',
      systemPrompt: 'Base prompt.',
      harnessSettings: { reasoning: 'high', timeoutSeconds: 30 }
    });
    writeJson(join(pwdDir, 'project-steward.json'), {
      id: 'project-steward',
      extends: 'nextjs-web-stewardship',
      env: { PROJECT: 'web' }
    });

    const loaded = loadLocalPersonas({ cwd, homeDir });
    assert.deepEqual(loaded.warnings, []);
    const spec = loaded.byId.get('project-steward');
    assert.equal(spec?.description, 'Base steward persona.');
    assert.equal(spec?.intent, 'nextjs-web-stewardship');
    assert.equal(spec?.env?.PROJECT, 'web');
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
      extends: 'persona-maker',
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

test('top-level claudeMd + mode round-trip through merge', () => {
  withLayers(({ cwd, homeDir }) => {
    writeFileSync(join(homeDir, 'top.md'), '# top\n');
    writeJson(join(homeDir, 'p.json'), {
      id: 'p',
      extends: 'persona-maker',
      claudeMd: 'top.md',
      claudeMdMode: 'extend'
    });
    const loaded = loadLocalPersonas({ cwd, homeDir });
    assert.deepEqual(loaded.warnings, []);
    const spec = loaded.byId.get('p');
    assert.equal(spec?.claudeMd, join(homeDir, 'top.md'));
    assert.equal(spec?.claudeMdMode, 'extend');
  });
});

test('rejects claudeMd with .. segment', () => {
  withLayers(({ cwd, homeDir }) => {
    writeJson(join(homeDir, 'p.json'), {
      id: 'p',
      extends: 'persona-maker',
      claudeMd: '../escape.md'
    });
    const loaded = loadLocalPersonas({ cwd, homeDir });
    assert.equal(loaded.byId.has('p'), false);
    assert.match(loaded.warnings.join('\n'), /\.\./);
  });
});

test('rejects Windows-rooted sidecar paths (backslash, UNC, drive-letter)', () => {
  // path.isAbsolute on POSIX doesn't catch these, but they're rooted on
  // Windows and would resolve outside the source dir.
  for (const bad of ['\\persona.md', '\\\\server\\share\\persona.md', 'C:persona.md', 'C:\\persona.md']) {
    withLayers(({ cwd, homeDir }) => {
      writeJson(join(homeDir, 'p.json'), {
        id: 'p',
        extends: 'persona-maker',
        claudeMd: bad
      });
      const loaded = loadLocalPersonas({ cwd, homeDir });
      assert.equal(loaded.byId.has('p'), false, `expected "${bad}" to be rejected`);
      assert.match(loaded.warnings.join('\n'), /must be a relative path/);
    });
  }
});

test('rejects non-md sidecar path', () => {
  withLayers(({ cwd, homeDir }) => {
    writeJson(join(homeDir, 'p.json'), {
      id: 'p',
      extends: 'persona-maker',
      claudeMd: 'persona.txt'
    });
    const loaded = loadLocalPersonas({ cwd, homeDir });
    assert.equal(loaded.byId.has('p'), false);
    assert.match(loaded.warnings.join('\n'), /\.md/);
  });
});

test('overlay claudeMdMode flips while inheriting the path from a lower layer', () => {
  withLayers(({ cwd, homeDir, pwdDir }) => {
    writeFileSync(join(homeDir, 'top.md'), '# top\n');
    writeJson(join(homeDir, 'sidecar-base.json'), {
      id: 'sidecar-base',
      extends: 'persona-maker',
      claudeMd: 'top.md',
      claudeMdMode: 'overwrite'
    });
    // cwd-level overlay flips ONLY the mode; the path inherits from below.
    writeJson(join(pwdDir, 'sidecar-base.json'), {
      id: 'sidecar-base',
      extends: 'sidecar-base',
      claudeMdMode: 'extend'
    });
    const loaded = loadLocalPersonas({ cwd, homeDir });
    assert.deepEqual(loaded.warnings, []);
    const spec = loaded.byId.get('sidecar-base');
    assert.equal(spec?.claudeMd, join(homeDir, 'top.md'));
    assert.equal(spec?.claudeMdMode, 'extend');
  });
});

test('relative local skill source resolves against the persona JSON directory', () => {
  withLayers(({ cwd, homeDir }) => {
    mkdirSync(join(homeDir, 'skills'), { recursive: true });
    writeFileSync(join(homeDir, 'skills', 'mount-policy.md'), '# mount policy\n');
    writeJson(join(homeDir, 'p.json'), {
      id: 'p',
      extends: 'persona-maker',
      skills: [
        {
          id: 'mount-policy',
          source: './skills/mount-policy.md',
          description: 'local skill'
        }
      ]
    });
    const loaded = loadLocalPersonas({ cwd, homeDir });
    assert.deepEqual(loaded.warnings, []);
    const spec = loaded.byId.get('p');
    assert.equal(spec?.skills[0]?.source, join(homeDir, 'skills', 'mount-policy.md'));
  });
});

test('relative local skill source falls back to the package root above the persona dir', () => {
  withLayers(({ cwd, home, homeDir }) => {
    // Persona-pack layout: skills/ sits next to personas/, not inside it.
    const packageSkillsDir = join(home, '.agentworkforce', 'workforce', 'skills');
    mkdirSync(packageSkillsDir, { recursive: true });
    writeFileSync(join(packageSkillsDir, 'pack-skill.md'), '# pack skill\n');
    writeJson(join(homeDir, 'p.json'), {
      id: 'p',
      extends: 'persona-maker',
      skills: [
        { id: 'pack-skill', source: './skills/pack-skill.md', description: 'pack skill' }
      ]
    });
    const loaded = loadLocalPersonas({ cwd, homeDir });
    assert.deepEqual(loaded.warnings, []);
    const spec = loaded.byId.get('p');
    assert.equal(spec?.skills[0]?.source, join(packageSkillsDir, 'pack-skill.md'));
  });
});

test('relative local skill source falls back to the loader cwd', () => {
  withLayers(({ cwd, homeDir }) => {
    // Installed packs can rewrite asset paths to cwd-relative locations.
    const assetsDir = join(cwd, '__assets', 'skills');
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(join(assetsDir, 'asset-skill.md'), '# asset skill\n');
    writeJson(join(homeDir, 'p.json'), {
      id: 'p',
      extends: 'persona-maker',
      skills: [
        { id: 'asset-skill', source: './__assets/skills/asset-skill.md', description: 'asset skill' }
      ]
    });
    const loaded = loadLocalPersonas({ cwd, homeDir });
    assert.deepEqual(loaded.warnings, []);
    const spec = loaded.byId.get('p');
    assert.equal(spec?.skills[0]?.source, join(assetsDir, 'asset-skill.md'));
  });
});

test('missing local skill file produces a warning and drops the skill, not a throw', () => {
  withLayers(({ cwd, homeDir }) => {
    writeJson(join(homeDir, 'p.json'), {
      id: 'p',
      extends: 'persona-maker',
      skills: [
        { id: 'kept', source: '@agent-relay/workspace-layout', description: 'prpm skill' },
        { id: 'gone', source: './skills/missing.md', description: 'broken pointer' }
      ]
    });
    const loaded = loadLocalPersonas({ cwd, homeDir });
    const spec = loaded.byId.get('p');
    assert.ok(spec, 'persona still loads');
    assert.deepEqual(
      spec?.skills.map((s) => s.id),
      ['kept'],
      'missing local skill is dropped; remote skills survive'
    );
    assert.match(loaded.warnings.join('\n'), /local skill file not found/);
  });
});

test('malformed local skill entries produce a warning instead of crashing resolution', () => {
  withLayers(({ cwd, homeDir }) => {
    writeJson(join(homeDir, 'p.json'), {
      id: 'p',
      extends: 'persona-maker',
      skills: [null]
    });
    const loaded = loadLocalPersonas({ cwd, homeDir });
    assert.equal(loaded.byId.has('p'), false);
    assert.match(loaded.warnings.join('\n'), /skills\[0\] must be an object/);
  });
});

test('missing sidecar file produces a warning, not a throw', () => {
  withLayers(({ cwd, homeDir }) => {
    writeJson(join(homeDir, 'p.json'), {
      id: 'p',
      extends: 'persona-maker',
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
  // Regression: when a base persona ships inlined `claudeMdContent` (only
  // built-ins do, via the catalog generator) and a local override sets a
  // new `claudeMd` path, runtime selection prefers Content over path —
  // so without the fix the override file is silently discarded.
  //
  // The file-based loader can't produce inherited content (the JSON
  // schema accepts only `claudeMd` paths), so this exercises the merge
  // directly via the test seam to construct a base with content and an
  // override with a path. Same for agentsMdContent.
  const base: PersonaSpec = {
    id: 'documentation',
    intent: 'documentation',
    tags: ['documentation'],
    description: 'd',
    skills: [],
    harness: 'claude',
    model: 'claude-3-5-sonnet',
    systemPrompt: 'base',
    harnessSettings: { reasoning: 'medium', timeoutSeconds: 300 },
    claudeMdContent: '# inlined from build-time\n',
    agentsMdContent: '# agents inlined from build-time\n'
  };

  // Set up a real .md file the override can resolve against.
  const tmp = mkdtempSync(join(tmpdir(), 'agentworkforce-merge-'));
  try {
    writeFileSync(join(tmp, 'override.md'), '# override\n');
    writeFileSync(join(tmp, 'agents-override.md'), '# agents override\n');
    const override: LocalPersonaOverride = {
      id: 'documentation',
      claudeMd: 'override.md',
      agentsMd: 'agents-override.md',
      __sourceDir: tmp
    };
    const warnings: string[] = [];
    const merged = __mergeOverrideForTests(base, override, warnings);
    assert.deepEqual(warnings, []);
    assert.equal(merged.claudeMd, join(tmp, 'override.md'));
    assert.equal(merged.claudeMdContent, undefined,
      'inherited claudeMdContent must be cleared when override sets a new path');
    assert.equal(merged.agentsMd, join(tmp, 'agents-override.md'));
    assert.equal(merged.agentsMdContent, undefined);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('override leaves channel alone: inherited claudeMdContent flows through', () => {
  // Sanity counterpart: when the override does NOT set a new path, the
  // inherited content must NOT be cleared. Otherwise we'd over-correct
  // and drop legitimate built-in sidecars.
  const base: PersonaSpec = {
    id: 'documentation',
    intent: 'documentation',
    tags: ['documentation'],
    description: 'd',
    skills: [],
    harness: 'claude',
    model: 'claude-3-5-sonnet',
    systemPrompt: 'base',
    harnessSettings: { reasoning: 'medium', timeoutSeconds: 300 },
    claudeMdContent: '# keep me\n'
  };
  const override: LocalPersonaOverride = {
    id: 'documentation',
    description: 'override description only',
    __sourceDir: '/dev/null'
  };
  const merged = __mergeOverrideForTests(base, override, []);
  assert.equal(merged.claudeMdContent, '# keep me\n');
  assert.equal(merged.claudeMd, undefined);
});

test('formatPersonaSourceLabel maps internal cascade keys to display labels', () => {
  assert.equal(formatPersonaSourceLabel('library'), 'built-in');
  assert.equal(formatPersonaSourceLabel('user'), 'personal');
  // cwd passes through — it's already a precise pointer to a real dir.
  assert.equal(formatPersonaSourceLabel('cwd'), 'cwd');
  // dir:N passes through unchanged so cascade position stays legible.
  assert.equal(formatPersonaSourceLabel('dir:1'), 'dir:1');
  assert.equal(formatPersonaSourceLabel('dir:42'), 'dir:42');
});
