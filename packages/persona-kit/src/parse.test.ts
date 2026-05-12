import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertInputName,
  assertSidecarPath,
  INPUT_NAME_RE,
  parseHarnessSettings,
  parseIntegrations,
  parseInputs,
  parseMemory,
  parseMcpServers,
  parseMount,
  parsePermissions,
  parsePersonaSpec,
  parseSandbox,
  parseSchedules,
  parseSkills,
  parseStringList,
  parseStringMap,
  parseTags,
  parseTraits
} from './parse.js';

const baseRuntime = {
  harness: 'claude',
  model: 'anthropic/claude-3-5-sonnet',
  systemPrompt: 'be helpful',
  harnessSettings: { reasoning: 'medium', timeoutSeconds: 300 }
};

function validSpec(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'p',
    intent: 'documentation',
    tags: ['documentation'],
    description: 'd',
    tiers: { best: baseRuntime, 'best-value': baseRuntime, minimum: baseRuntime },
    ...over
  };
}

test('parsePersonaSpec accepts a minimal valid spec across all tiers', () => {
  const spec = parsePersonaSpec(validSpec(), 'documentation');
  assert.equal(spec.id, 'p');
  assert.equal(spec.intent, 'documentation');
  assert.deepEqual(spec.tags, ['documentation']);
  assert.equal(spec.tiers.best.harness, 'claude');
});

test('parsePersonaSpec strips unknown top-level fields silently', () => {
  const raw = validSpec({ unknownField: 'should be dropped', extra: { nested: true } });
  const spec = parsePersonaSpec(raw, 'documentation');
  assert.ok(!('unknownField' in spec), 'unknown fields are not preserved on the parsed spec');
  assert.ok(!('extra' in spec));
});

test('parsePersonaSpec accepts deploy-v1 optional fields', () => {
  const spec = parsePersonaSpec(
    validSpec({
      cloud: true,
      useSubscription: true,
      integrations: {
        github: {
          scope: { repo: 'AgentWorkforce/workforce' },
          triggers: [{ on: 'pull_request.opened' }]
        }
      },
      schedules: [{ name: 'weekly', cron: '0 9 * * 6', tz: 'UTC' }],
      sandbox: { enabled: true, timeoutSeconds: 1800, env: { NODE_ENV: 'production' } },
      memory: { enabled: true, scopes: ['workspace'], ttlDays: 30 },
      traits: { voice: 'professional-warm', preferMarkdown: true },
      onEvent: './agent.ts'
    }),
    'documentation'
  );

  assert.equal(spec.cloud, true);
  assert.equal(spec.integrations?.github.triggers?.[0].on, 'pull_request.opened');
  assert.equal(spec.schedules?.[0].name, 'weekly');
  assert.deepEqual(spec.sandbox, {
    enabled: true,
    timeoutSeconds: 1800,
    env: { NODE_ENV: 'production' }
  });
  assert.deepEqual(spec.memory, { enabled: true, scopes: ['workspace'], ttlDays: 30 });
  assert.equal(spec.traits?.preferMarkdown, true);
  assert.equal(spec.onEvent, './agent.ts');
});

test('parsePersonaSpec throws when intent does not match the expected intent', () => {
  assert.throws(
    () => parsePersonaSpec(validSpec({ intent: 'review' }), 'documentation'),
    /intent mismatch: got review/
  );
});

test('parsePersonaSpec throws with a precise field path on a malformed tier', () => {
  const raw = validSpec({
    tiers: {
      best: baseRuntime,
      'best-value': { ...baseRuntime, harnessSettings: { reasoning: 'turbo', timeoutSeconds: 1 } },
      minimum: baseRuntime
    }
  });
  assert.throws(
    () => parsePersonaSpec(raw, 'documentation'),
    /persona\[documentation\]\.tiers\.best-value\.harnessSettings\.reasoning must be low\|medium\|high/
  );
});

test('parsePersonaSpec defers malformed skills[i].source to plan time (does not throw at parse)', () => {
  // Issue 70 contract: parse only validates shape (string + non-empty); URL/source-kind
  // validation happens in materializeSkills so a typo blows up its own persona, not the dir.
  const spec = parsePersonaSpec(
    validSpec({
      skills: [
        { id: 'good', source: 'https://prpm.dev/packages/@scope/x', description: 'fine' },
        { id: 'odd', source: 'totally-bogus-source', description: 'should still parse' }
      ]
    }),
    'documentation'
  );
  assert.equal(spec.skills.length, 2);
  assert.equal(spec.skills[1].source, 'totally-bogus-source');
});

test('parsePermissions throws on an invalid permission mode', () => {
  assert.throws(
    () => parsePermissions({ mode: 'oops' }, 'p'),
    /p\.mode must be one of:/
  );
});

test('parseMount accepts ignoredPatterns + readonlyPatterns; drops empties to undefined', () => {
  assert.equal(parseMount({}, 'mount'), undefined);
  const m = parseMount(
    { ignoredPatterns: ['secrets/**'], readonlyPatterns: ['vendor/**'] },
    'mount'
  );
  assert.deepEqual(m, {
    ignoredPatterns: ['secrets/**'],
    readonlyPatterns: ['vendor/**']
  });
});

test('parseMount throws when patterns are not non-empty strings', () => {
  assert.throws(() => parseMount({ ignoredPatterns: [''] }, 'mount'), /ignoredPatterns\[0\]/);
  assert.throws(
    () => parseMount({ readonlyPatterns: [42] }, 'mount'),
    /readonlyPatterns\[0\]/
  );
});

test('INPUT_NAME_RE matches env-var convention', () => {
  for (const ok of ['FOO', 'FOO_BAR', '_FOO', 'A1', 'A_1_B']) {
    assert.match(ok, INPUT_NAME_RE, `expected ${ok} to match`);
  }
  for (const bad of ['foo', '1FOO', 'FOO-BAR', 'FOO BAR', 'foo_bar']) {
    assert.doesNotMatch(bad, INPUT_NAME_RE, `expected ${bad} not to match`);
  }
});

test('assertInputName throws on names that violate the env-var convention', () => {
  assert.throws(() => assertInputName('lowercase', 'inputs.lowercase'), /env-style name/);
  assert.throws(() => assertInputName('1LEADING', 'inputs.1LEADING'), /env-style name/);
});

test('parseInputs accepts a string default and an object with description+env+default', () => {
  const inputs = parseInputs(
    {
      OUTPUT_PATH: '/tmp/out',
      TARGET: { description: 'where to go', env: 'TARGET_OVERRIDE', default: 'home' }
    },
    'inputs'
  );
  assert.equal(inputs?.OUTPUT_PATH.default, '/tmp/out');
  assert.equal(inputs?.TARGET.env, 'TARGET_OVERRIDE');
  assert.equal(inputs?.TARGET.default, 'home');
  assert.equal(inputs?.TARGET.description, 'where to go');
});

test('parseInputs forbids combining optional:true with a default', () => {
  assert.throws(
    () => parseInputs({ FOO: { optional: true, default: 'x' } }, 'inputs'),
    /cannot set both 'optional: true' and 'default'/
  );
});

test('parseInputs rejects names that violate the env-var convention', () => {
  assert.throws(() => parseInputs({ foo: 'x' }, 'inputs'), /inputs\.foo must be an env-style name/);
});

test('parseHarnessSettings accepts optional codex fields and rejects bad ones', () => {
  const ok = parseHarnessSettings(
    {
      reasoning: 'high',
      timeoutSeconds: 60,
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
      workspaceWriteNetworkAccess: true,
      webSearch: false
    },
    'rt'
  );
  assert.equal(ok.sandboxMode, 'workspace-write');
  assert.equal(ok.approvalPolicy, 'on-request');
  assert.equal(ok.workspaceWriteNetworkAccess, true);
  assert.equal(ok.webSearch, false);

  assert.throws(
    () => parseHarnessSettings({ reasoning: 'medium', timeoutSeconds: 0 }, 'rt'),
    /rt\.timeoutSeconds must be a positive number/
  );
  assert.throws(
    () =>
      parseHarnessSettings(
        { reasoning: 'medium', timeoutSeconds: 1, sandboxMode: 'bogus' },
        'rt'
      ),
    /rt\.sandboxMode must be one of:/
  );
});

test('parseHarnessSettings accepts dangerouslyBypassApprovalsAndSandbox alone', () => {
  for (const value of [true, false]) {
    const ok = parseHarnessSettings(
      {
        reasoning: 'high',
        timeoutSeconds: 60,
        dangerouslyBypassApprovalsAndSandbox: value
      },
      'rt'
    );
    assert.equal(ok.dangerouslyBypassApprovalsAndSandbox, value);
  }
});

test('parseHarnessSettings rejects dangerouslyBypassApprovalsAndSandbox with conflicting fields', () => {
  for (const conflict of ['sandboxMode', 'approvalPolicy', 'workspaceWriteNetworkAccess']) {
    const overlay: Record<string, unknown> = {
      reasoning: 'high',
      timeoutSeconds: 60,
      dangerouslyBypassApprovalsAndSandbox: true
    };
    if (conflict === 'sandboxMode') overlay.sandboxMode = 'workspace-write';
    if (conflict === 'approvalPolicy') overlay.approvalPolicy = 'never';
    if (conflict === 'workspaceWriteNetworkAccess') overlay.workspaceWriteNetworkAccess = true;
    assert.throws(
      () => parseHarnessSettings(overlay, 'rt'),
      new RegExp(`mutually exclusive with: .*${conflict}`)
    );
  }
});

test('parseHarnessSettings rejects dangerouslyBypassApprovalsAndSandbox:false with conflicting fields', () => {
  for (const conflict of ['sandboxMode', 'approvalPolicy', 'workspaceWriteNetworkAccess']) {
    const overlay: Record<string, unknown> = {
      reasoning: 'high',
      timeoutSeconds: 60,
      dangerouslyBypassApprovalsAndSandbox: false
    };
    if (conflict === 'sandboxMode') overlay.sandboxMode = 'workspace-write';
    if (conflict === 'approvalPolicy') overlay.approvalPolicy = 'never';
    if (conflict === 'workspaceWriteNetworkAccess') overlay.workspaceWriteNetworkAccess = true;
    assert.throws(
      () => parseHarnessSettings(overlay, 'rt'),
      new RegExp(`mutually exclusive with: .*${conflict}`)
    );
  }
});

test('parseHarnessSettings rejects non-boolean dangerouslyBypassApprovalsAndSandbox', () => {
  assert.throws(
    () =>
      parseHarnessSettings(
        { reasoning: 'high', timeoutSeconds: 60, dangerouslyBypassApprovalsAndSandbox: 'yes' },
        'rt'
      ),
    /dangerouslyBypassApprovalsAndSandbox must be a boolean/
  );
});

test('parseTags rejects empty arrays and unknown tags', () => {
  assert.throws(() => parseTags([], 'tags'), /must be a non-empty array/);
  assert.throws(() => parseTags(['nonsense-tag'], 'tags'), /tags\[0\] must be one of:/);
});

test('parseSkills returns [] for undefined, validates shape per entry', () => {
  assert.deepEqual(parseSkills(undefined, 'skills'), []);
  assert.throws(
    () => parseSkills([{ id: '', source: 'x', description: 'y' }], 'skills'),
    /skills\[0\]\.id must be a non-empty string/
  );
});

test('parseStringList drops undefined and rejects empty strings', () => {
  assert.equal(parseStringList(undefined, 'list'), undefined);
  assert.throws(() => parseStringList([''], 'list'), /list\[0\] must be a non-empty string/);
});

test('parseStringMap rejects non-string values', () => {
  assert.throws(() => parseStringMap({ FOO: 1 }, 'env'), /env\.FOO must be a string/);
});

test('parseMcpServers validates the http/sse/stdio union', () => {
  const ok = parseMcpServers(
    {
      api: { type: 'http', url: 'https://example.com', headers: { Authorization: 'x' } },
      tail: { type: 'sse', url: 'https://example.com/sse' },
      local: { type: 'stdio', command: 'node', args: ['index.js'], env: { NODE_ENV: 'test' } }
    },
    'mcpServers'
  );
  assert.equal(ok?.api.type, 'http');
  assert.equal(ok?.local.type, 'stdio');
  assert.throws(
    () => parseMcpServers({ bad: { type: 'mystery' } }, 'mcpServers'),
    /mcpServers\.bad\.type must be one of: http, sse, stdio/
  );
  assert.throws(
    () => parseMcpServers({ http: { type: 'http' } }, 'mcpServers'),
    /mcpServers\.http\.url must be a non-empty string/
  );
});

test('assertSidecarPath rejects absolute paths and ".." traversal', () => {
  assert.throws(() => assertSidecarPath('/abs.md', 'claudeMd'), /must be a relative POSIX path/);
  assert.throws(() => assertSidecarPath('a/../escape.md', 'claudeMd'), /must not contain ".." segments/);
  assert.throws(() => assertSidecarPath('not-md.txt', 'claudeMd'), /must end with .md/);
});

test('parsePersonaSpec rejects a non-object spec', () => {
  assert.throws(() => parsePersonaSpec(null, 'documentation'), /must be an object/);
  assert.throws(() => parsePersonaSpec('nope', 'documentation'), /must be an object/);
});

test('parsePersonaSpec preserves defaultTier when valid and rejects when invalid', () => {
  const ok = parsePersonaSpec(validSpec({ defaultTier: 'best' }), 'documentation');
  assert.equal(ok.defaultTier, 'best');
  assert.throws(
    () => parsePersonaSpec(validSpec({ defaultTier: 'turbo' }), 'documentation'),
    /defaultTier must be one of:/
  );
});
