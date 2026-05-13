import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  assertInputName,
  assertSidecarPath,
  INPUT_NAME_RE,
  isIntent,
  parseHarnessSettings,
  parseIntegrations,
  parseInputs,
  parseMemory,
  parseMcpServers,
  parseMount,
  parseOnEvent,
  parsePermissions,
  parsePersonaSpec,
  parseSchedules,
  parseSkills,
  parseStringList,
  parseStringMap,
  parseTags
} from './parse.js';

function validSpec(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'p',
    intent: 'documentation',
    tags: ['documentation'],
    description: 'd',
    harness: 'claude',
    model: 'anthropic/claude-3-5-sonnet',
    systemPrompt: 'be helpful',
    harnessSettings: { reasoning: 'medium', timeoutSeconds: 300 },
    ...over
  };
}

function parsePersonaFixture(path: string) {
  const fixtureUrl = new URL(`../../../${path}`, import.meta.url);
  const raw = JSON.parse(readFileSync(fixtureUrl, 'utf8')) as Record<string, unknown>;
  if (!isIntent(raw.intent)) {
    throw new Error(`${path} declares an invalid intent`);
  }
  return parsePersonaSpec(raw, raw.intent);
}

test('parsePersonaSpec accepts a minimal valid flat spec', () => {
  const spec = parsePersonaSpec(validSpec(), 'documentation');
  assert.equal(spec.id, 'p');
  assert.equal(spec.intent, 'documentation');
  assert.deepEqual(spec.tags, ['documentation']);
  assert.equal(spec.harness, 'claude');
  assert.equal(spec.model, 'anthropic/claude-3-5-sonnet');
  assert.equal(spec.systemPrompt, 'be helpful');
  assert.equal(spec.harnessSettings.reasoning, 'medium');
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
      memory: { enabled: true, scopes: ['workspace'], ttlDays: 30 },
      onEvent: './agent.ts'
    }),
    'documentation'
  );

  assert.equal(spec.cloud, true);
  assert.equal(spec.integrations?.github.triggers?.[0].on, 'pull_request.opened');
  assert.equal(spec.schedules?.[0].name, 'weekly');
  assert.deepEqual(spec.memory, { enabled: true, scopes: ['workspace'], ttlDays: 30 });
  assert.equal(spec.onEvent, './agent.ts');
});

test('parsePersonaSpec rejects removed deploy-v1 traits and sandbox keys', () => {
  assert.throws(
    () => parsePersonaSpec(validSpec({ traits: { voice: 'warm' } }), 'documentation'),
    {
      message:
        'traits was removed in v1; personality is handled by the persona-personality-builder tool (out of scope for v1). See docs/plans/deploy-v1.md'
    }
  );
  assert.throws(
    () => parsePersonaSpec(validSpec({ sandbox: true }), 'documentation'),
    {
      message:
        "sandbox was removed in v1; sandbox is on by default at deploy time. Use 'workforce deploy --no-sandbox' or runtime config to opt out. See docs/plans/deploy-v1.md"
    }
  );
});

test('parsePersonaSpec accepts the Relayfile-VFS example personas', () => {
  const reviewAgent = parsePersonaFixture('examples/review-agent/persona.json');
  assert.equal(reviewAgent.id, 'review-agent');
  assert.equal(reviewAgent.intent, 'review');
  assert.equal(reviewAgent.integrations?.github.triggers?.length, 4);
  assert.deepEqual(reviewAgent.memory, { enabled: true, scopes: ['workspace'] });

  const linearShipper = parsePersonaFixture('examples/linear-shipper/persona.json');
  assert.equal(linearShipper.id, 'linear-shipper');
  assert.equal(linearShipper.intent, 'implement-frontend');
  assert.equal(linearShipper.integrations?.linear.triggers?.[0].on, 'issue.created');
  assert.equal(linearShipper.inputs?.GITHUB_OWNER.default, 'AgentWorkforce');
});

test('parsePersonaSpec throws when intent does not match the expected intent', () => {
  assert.throws(
    () => parsePersonaSpec(validSpec({ intent: 'review' }), 'documentation'),
    /intent mismatch: got review/
  );
});

test('parsePersonaSpec throws with a precise field path on a malformed harnessSettings', () => {
  const raw = validSpec({
    harnessSettings: { reasoning: 'turbo', timeoutSeconds: 1 }
  });
  assert.throws(
    () => parsePersonaSpec(raw, 'documentation'),
    /persona\[documentation\]\.harnessSettings\.reasoning must be low\|medium\|high/
  );
});

test('parsePersonaSpec throws when required runtime fields are missing', () => {
  assert.throws(
    () => parsePersonaSpec(validSpec({ harness: 'mystery' }), 'documentation'),
    /persona\[documentation\]\.harness must be one of:/
  );
  assert.throws(
    () => parsePersonaSpec(validSpec({ model: '' }), 'documentation'),
    /persona\[documentation\]\.model must be a non-empty string/
  );
  assert.throws(
    () => parsePersonaSpec(validSpec({ systemPrompt: '   ' }), 'documentation'),
    /persona\[documentation\]\.systemPrompt must be a non-empty string/
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

// --- deploy-v1 schema additions ----------------------------------------------

test('parseMemory accepts boolean + object forms and validates scopes', () => {
  assert.equal(parseMemory(true, 'memory'), true);
  assert.equal(parseMemory(false, 'memory'), false);
  assert.equal(parseMemory(undefined, 'memory'), undefined);
  const m = parseMemory(
    {
      enabled: true,
      scopes: ['user', 'user', 'workspace', 'global'],
      ttlDays: 7,
      autoPromote: true,
      dedupMs: 0
    },
    'memory'
  );
  // Duplicates are deduped while preserving first-seen order.
  assert.deepEqual(m, {
    enabled: true,
    scopes: ['user', 'workspace', 'global'],
    ttlDays: 7,
    autoPromote: true,
    dedupMs: 0
  });
});

test('parseMemory rejects unknown scopes and non-positive ttl', () => {
  assert.throws(
    () => parseMemory({ scopes: ['planet'] }, 'memory'),
    /memory\.scopes\[0\] must be one of: workspace, user, global/
  );
  assert.throws(
    () => parseMemory({ scopes: ['session'] }, 'memory'),
    /memory\.scopes\[0\] must be one of: workspace, user, global/
  );
  assert.throws(() => parseMemory({ scopes: [] }, 'memory'), /scopes must be a non-empty array/);
  assert.throws(() => parseMemory({ ttlDays: 0 }, 'memory'), /ttlDays must be a positive number/);
  assert.throws(() => parseMemory({ dedupMs: -1 }, 'memory'), /dedupMs must be a non-negative number/);
});

test('parseSchedules validates cron, requires unique names, preserves tz when set', () => {
  const s = parseSchedules(
    [
      { name: 'morning', cron: '0 9 * * 1-5', tz: 'America/New_York' },
      { name: 'sweep', cron: '*/15 0,12 * * *' }
    ],
    'schedules'
  );
  assert.deepEqual(s, [
    { name: 'morning', cron: '0 9 * * 1-5', tz: 'America/New_York' },
    { name: 'sweep', cron: '*/15 0,12 * * *' }
  ]);

  assert.throws(
    () =>
      parseSchedules(
        [
          { name: 'dup', cron: '0 9 * * *' },
          { name: 'dup', cron: '0 10 * * *' }
        ],
        'schedules'
      ),
    /duplicates an earlier schedule/
  );
  assert.throws(
    () => parseSchedules([{ name: 'short', cron: '0 9 * *' }], 'schedules'),
    /must be a 5-field cron expression/
  );
  assert.throws(
    () => parseSchedules([{ name: 'bad', cron: '0 9 * * MON' }], 'schedules'),
    /is not a valid cron token/
  );
  assert.equal(parseSchedules(undefined, 'schedules'), undefined);
  assert.equal(parseSchedules([], 'schedules'), undefined);
});

test('parseIntegrations preserves scope + triggers; rejects empty trigger arrays', () => {
  const i = parseIntegrations(
    {
      github: {
        scope: { repo: 'org/r' },
        triggers: [
          { on: 'pull_request.opened' },
          { on: 'issue_comment.created', match: '@mention' }
        ]
      },
      linear: {} // no scope, no triggers — still a declared integration
    },
    'integrations'
  );
  assert.equal(i?.github.scope?.repo, 'org/r');
  assert.equal(i?.github.triggers?.length, 2);
  assert.equal(i?.github.triggers?.[1].match, '@mention');
  assert.deepEqual(i?.linear, {});

  assert.throws(
    () =>
      parseIntegrations(
        { github: { triggers: [] } },
        'integrations'
      ),
    /triggers must contain at least one entry/
  );
  assert.throws(
    () =>
      parseIntegrations(
        { github: { triggers: [{ on: '' }] } },
        'integrations'
      ),
    /triggers\[0\]\.on must be a non-empty string/
  );
});

test('parseOnEvent enforces relative path with a supported extension', () => {
  assert.equal(parseOnEvent('./agent.ts', 'onEvent'), './agent.ts');
  assert.equal(parseOnEvent('handlers/main.mjs', 'onEvent'), 'handlers/main.mjs');
  assert.equal(parseOnEvent(undefined, 'onEvent'), undefined);

  assert.throws(() => parseOnEvent('/abs/agent.ts', 'onEvent'), /must be a relative POSIX path/);
  assert.throws(() => parseOnEvent('a/../b.ts', 'onEvent'), /must not contain ".." segments/);
  assert.throws(() => parseOnEvent('agent.py', 'onEvent'), /must point at a \.ts/);
  assert.throws(() => parseOnEvent('', 'onEvent'), /must be a non-empty string/);
});

test('parseOnEvent rejects Windows-absolute path shapes too', () => {
  assert.throws(
    () => parseOnEvent('C:\\handlers\\agent.ts', 'onEvent'),
    /must be a relative POSIX path/
  );
  assert.throws(
    () => parseOnEvent('C:/handlers/agent.ts', 'onEvent'),
    /must be a relative POSIX path/
  );
  assert.throws(
    () => parseOnEvent('\\\\server\\share\\agent.ts', 'onEvent'),
    /must be a relative POSIX path/
  );
});

test('parseSchedules trims name/cron/tz before validation and dedupe', () => {
  // Whitespace variants of the same name should collapse so dedupe works.
  assert.throws(
    () =>
      parseSchedules(
        [
          { name: 'weekly', cron: '0 9 * * 6' },
          { name: ' weekly ', cron: '0 10 * * 6' }
        ],
        'schedules'
      ),
    /duplicates an earlier schedule/
  );
  const s = parseSchedules(
    [{ name: '  morning  ', cron: '  0 9 * * 1-5  ', tz: '  America/New_York  ' }],
    'schedules'
  );
  assert.deepEqual(s, [
    { name: 'morning', cron: '0 9 * * 1-5', tz: 'America/New_York' }
  ]);
});

test('parsePersonaSpec rejects non-boolean cloud / useSubscription', () => {
  assert.throws(
    () => parsePersonaSpec(validSpec({ cloud: 'yes' }), 'documentation'),
    /cloud must be a boolean/
  );
  assert.throws(
    () => parsePersonaSpec(validSpec({ useSubscription: 1 }), 'documentation'),
    /useSubscription must be a boolean/
  );
});

test('parsePersonaSpec keeps boolean shorthand memory through round-trip', () => {
  const spec = parsePersonaSpec(
    validSpec({ cloud: true, memory: false }),
    'documentation'
  );
  assert.equal(spec.memory, false);
});
