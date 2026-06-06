import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertInputName,
  assertSidecarPath,
  INPUT_NAME_RE,
  isIntent,
  parseAgentSpec,
  parseCapabilities,
  parseHarnessSettings,
  parseIntegrations,
  parseInputs,
  parseMemory,
  parseMcpServers,
  parseMount,
  parseOnEvent,
  parsePermissions,
  parsePersonaSpec,
  resolveAiMemory,
  resolveTrajectoryRecording,
  parseSchedules,
  parseSkills,
  parseStringList,
  parseStringMap,
  parseTags,
  parseWatch
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

test('parsePersonaSpec accepts deploy-v1 optional fields (connection-only integrations)', () => {
  const spec = parsePersonaSpec(
    validSpec({
      cloud: true,
      useSubscription: true,
      integrations: {
        github: { scope: { repo: 'AgentWorkforce/workforce' } }
      },
      memory: { enabled: true, scopes: ['workspace'], ttlDays: 30 },
      onEvent: './agent.ts'
    }),
    'documentation'
  );

  assert.equal(spec.cloud, true);
  assert.equal(spec.integrations?.github.scope?.repo, 'AgentWorkforce/workforce');
  assert.deepEqual(spec.memory, { enabled: true, scopes: ['workspace'], ttlDays: 30 });
  assert.equal(spec.onEvent, './agent.ts');
});

test('parsePersonaSpec hard-rejects triggers/schedules/watch (moved to the agent)', () => {
  assert.throws(
    () =>
      parsePersonaSpec(
        validSpec({ integrations: { github: { triggers: [{ on: 'pull_request.opened' }] } } }),
        'documentation'
      ),
    /integrations\.github\.triggers is no longer allowed .* moved to the agent/
  );
  assert.throws(
    () => parsePersonaSpec(validSpec({ schedules: [{ name: 'weekly', cron: '0 9 * * 6' }] }), 'documentation'),
    /schedules is no longer allowed .* moved to the agent/
  );
  assert.throws(
    () =>
      parsePersonaSpec(
        validSpec({ watch: [{ paths: ['/x'], events: ['created'] }] }),
        'documentation'
      ),
    /watch is no longer allowed .* moved to the agent/
  );
});

test('parsePersonaSpec rejects removed deploy-v1 traits but accepts sandbox', () => {
  assert.throws(
    () => parsePersonaSpec(validSpec({ traits: { voice: 'warm' } }), 'documentation'),
    {
      message:
        'traits was removed in v1; personality is handled by the persona-personality-builder tool (out of scope for v1). See docs/plans/deploy-v1.md'
    }
  );
  // sandbox field is now accepted with boolean values
  const specFalse = parsePersonaSpec(validSpec({ sandbox: false }), 'documentation');
  assert.equal(specFalse.sandbox, false);
  const specTrue = parsePersonaSpec(validSpec({ sandbox: true }), 'documentation');
  assert.equal(specTrue.sandbox, true);
  // omitting sandbox is fine (defaults to true at runtime)
  const specOmitted = parsePersonaSpec(validSpec({}), 'documentation');
  assert.equal(specOmitted.sandbox, undefined);
  // Invalid sandbox value throws
  assert.throws(
    () => parsePersonaSpec(validSpec({ sandbox: 'optional' }), 'documentation'),
    /sandbox must be true or false/
  );
});

test('parsePersonaSpec accepts the Relayfile-VFS example personas', () => {
  const reviewAgent = parsePersonaFixture('examples/review-agent/persona.json');
  assert.equal(reviewAgent.id, 'review-agent');
  assert.equal(reviewAgent.intent, 'review');
  // Triggers moved to agent.ts; persona declares the github/slack connections.
  assert.ok(reviewAgent.integrations?.github);
  assert.ok(reviewAgent.integrations?.slack);
  assert.deepEqual(reviewAgent.memory, { enabled: true, scopes: ['workspace'] });

  const linearShipper = parsePersonaFixture('examples/linear-shipper/persona.json');
  assert.equal(linearShipper.id, 'linear-shipper');
  assert.equal(linearShipper.intent, 'implement-frontend');
  assert.ok(linearShipper.integrations?.linear);
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

test('parsePersonaSpec requires harness/model/systemPrompt for interactive personas (no onEvent)', () => {
  // Build a spec missing each runtime field with no onEvent — still required.
  const base = {
    id: 'p',
    intent: 'documentation',
    tags: ['documentation'],
    description: 'd',
    harnessSettings: { reasoning: 'medium', timeoutSeconds: 300 }
  };
  assert.throws(
    () => parsePersonaSpec({ ...base, model: 'm', systemPrompt: 's' }, 'documentation'),
    /persona\[documentation\]\.harness must be one of:/
  );
  assert.throws(
    () => parsePersonaSpec({ ...base, harness: 'claude', systemPrompt: 's' }, 'documentation'),
    /persona\[documentation\]\.model must be a non-empty string/
  );
  assert.throws(
    () => parsePersonaSpec({ ...base, harness: 'claude', model: 'm' }, 'documentation'),
    /persona\[documentation\]\.systemPrompt must be a non-empty string/
  );
});

test('parsePersonaSpec allows handler personas (onEvent) to omit harness/model/systemPrompt', () => {
  // A pure orchestrator: the bundled handler controls flow and never calls
  // ctx.harness.run, so it carries no harness/model/systemPrompt.
  const spec = parsePersonaSpec(
    {
      id: 'orchestrator',
      intent: 'documentation',
      tags: ['documentation'],
      description: 'fans out to a workflow on each issue event',
      harnessSettings: { reasoning: 'medium', timeoutSeconds: 1800 },
      cloud: true,
      integrations: { github: { scope: { repo: 'org/r' } } },
      onEvent: './agent.ts'
    },
    'documentation'
  );
  assert.equal(spec.onEvent, './agent.ts');
  assert.equal(spec.harness, undefined);
  assert.equal(spec.model, undefined);
  assert.equal(spec.systemPrompt, undefined);
});

test('parsePersonaSpec still validates harness enum for handler personas when provided', () => {
  // Optional ≠ unvalidated: a handler that DOES call ctx.harness.run supplies
  // harness/model, and a bad harness value is still rejected.
  assert.throws(
    () =>
      parsePersonaSpec(
        {
          id: 'h',
          intent: 'documentation',
          tags: ['documentation'],
          description: 'd',
          harnessSettings: { reasoning: 'medium', timeoutSeconds: 300 },
          cloud: true,
          integrations: { github: {} },
          onEvent: './agent.ts',
          harness: 'mystery'
        },
        'documentation'
      ),
    /persona\[documentation\]\.harness must be one of:/
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
    enabled: true,
    ignoredPatterns: ['secrets/**'],
    readonlyPatterns: ['vendor/**']
  });
});

test('parseMount accepts enabled without pattern lists', () => {
  assert.deepEqual(parseMount({ enabled: false }, 'mount'), { enabled: false });
  assert.deepEqual(parseMount({ enabled: true }, 'mount'), { enabled: true });
  assert.throws(() => parseMount({ enabled: 'no' }, 'mount'), /mount\.enabled must be a boolean/);
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

test('parseInputs keeps a picker alongside env/optional', () => {
  const inputs = parseInputs(
    {
      BENJAMIN: { env: 'BENJAMIN', optional: true, picker: { provider: 'slack', resource: 'users' } }
    },
    'inputs'
  );
  assert.deepEqual(inputs?.BENJAMIN.picker, { provider: 'slack', resource: 'users' });
  assert.equal(inputs?.BENJAMIN.optional, true);
});

test('parseInputs rejects a picker missing provider or resource', () => {
  assert.throws(
    () => parseInputs({ FOO: { picker: { provider: 'slack' } } }, 'inputs'),
    /inputs\.FOO\.picker\.resource must be a non-empty string/
  );
  assert.throws(
    () => parseInputs({ FOO: { picker: { resource: 'users' } } }, 'inputs'),
    /inputs\.FOO\.picker\.provider must be a non-empty string/
  );
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

test('parseTags accepts an array of arbitrary string tags', () => {
  // Free-form per cloud#553 `tags text[]` — no closed-enum check.
  // Output is deduped and sorted for stable serialization.
  assert.deepEqual(
    parseTags(['proactive', 'notion', 'github'], 'tags'),
    ['github', 'notion', 'proactive']
  );
});

test('parseTags returns undefined when tags is missing', () => {
  assert.equal(parseTags(undefined, 'tags'), undefined);
});

test('parseTags returns undefined when tags is null', () => {
  assert.equal(parseTags(null, 'tags'), undefined);
});

test('parseTags returns undefined when tags is an empty array', () => {
  // Empty array and "no tags" are semantically identical — both collapse
  // to undefined so the field stays omitted from the parsed spec.
  assert.equal(parseTags([], 'tags'), undefined);
});

test('parseTags rejects non-string entries', () => {
  assert.throws(
    () => parseTags(['proactive', 123], 'tags'),
    /tags\[1\] must be a string/
  );
});

test('parseTags rejects empty / whitespace-only strings', () => {
  assert.throws(
    () => parseTags(['proactive', '   '], 'tags'),
    /tags\[1\] must be a non-empty string/
  );
  assert.throws(
    () => parseTags([''], 'tags'),
    /tags\[0\] must be a non-empty string/
  );
});

test('parseTags rejects entries over 64 characters', () => {
  const tooLong = 'x'.repeat(65);
  assert.throws(
    () => parseTags(['proactive', tooLong], 'tags'),
    /tags\[1\] must be ≤64 characters/
  );
});

test('parseTags rejects non-array input', () => {
  assert.throws(
    () => parseTags('proactive', 'tags'),
    /tags must be an array of strings if provided/
  );
});

test('parsePersonaSpec omits tags from the spec when the field is missing', () => {
  // Tags are optional; the parsed spec should not synthesize an empty array
  // when the input omits the field — the schema treats absence and `[]`
  // identically per cloud#553's denormalized `tags text[]`.
  const raw = { ...validSpec() } as Record<string, unknown>;
  delete raw.tags;
  const spec = parsePersonaSpec(raw, 'documentation');
  assert.equal(spec.tags, undefined);
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

test('parseMemory accepts and resolves trajectory and ai-memory facets', () => {
  const m = parseMemory(
    {
      trajectories: { autoCompact: false },
      aiMemory: { dbPath: '/tmp/ai-history.db' }
    },
    'memory'
  );

  assert.deepEqual(m, {
    trajectories: { autoCompact: false },
    aiMemory: { dbPath: '/tmp/ai-history.db' }
  });
  assert.deepEqual(resolveTrajectoryRecording(m), {
    enabled: true,
    autoCompact: false
  });
  assert.deepEqual(resolveAiMemory(m), {
    enabled: true,
    dbPath: '/tmp/ai-history.db'
  });
  assert.deepEqual(resolveTrajectoryRecording(undefined), { enabled: false });
  assert.deepEqual(resolveTrajectoryRecording(true), { enabled: false });
  assert.deepEqual(resolveAiMemory(undefined), { enabled: false });
  assert.deepEqual(resolveAiMemory(true), { enabled: false });
});

test('parseMemory rejects malformed trajectory and ai-memory facet configs', () => {
  assert.throws(
    () => parseMemory({ trajectories: [] }, 'memory'),
    /memory\.trajectories must be a boolean or an object if provided/
  );
  assert.throws(
    () => parseMemory({ aiMemory: [] }, 'memory'),
    /memory\.aiMemory must be a boolean or an object if provided/
  );
  assert.throws(
    () => parseMemory({ trajectories: { enabled: 'yes' } }, 'memory'),
    /memory\.trajectories\.enabled must be a boolean if provided/
  );
  assert.throws(
    () => parseMemory({ trajectories: { autoCompact: 'no' } }, 'memory'),
    /memory\.trajectories\.autoCompact must be a boolean if provided/
  );
  assert.throws(
    () => parseMemory({ aiMemory: { dbPath: '' } }, 'memory'),
    /memory\.aiMemory\.dbPath must be a non-empty string if provided/
  );
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

test('parseIntegrations preserves scope (connection-only); rejects persona-level triggers', () => {
  const i = parseIntegrations(
    {
      github: { scope: { repo: 'org/r' } },
      linear: {} // no scope — still a declared connection
    },
    'integrations'
  );
  assert.equal(i?.github.scope?.repo, 'org/r');
  // Default-injected source keeps existing personas resolving against
  // the deploying user's `user_integrations` row.
  assert.deepEqual(i?.github.source, { kind: 'deployer_user' });
  assert.deepEqual(i?.linear, { source: { kind: 'deployer_user' } });

  // Triggers moved to the agent — a persona integration carrying triggers fails loudly.
  assert.throws(
    () => parseIntegrations({ github: { triggers: [{ on: 'pull_request.opened' }] } }, 'integrations'),
    /integrations\.github\.triggers is no longer allowed/
  );
});

test('parseAgentSpec validates launchedBy plus provider-keyed triggers, schedules, and watch', () => {
  const agent = parseAgentSpec({
    launchedBy: 'team-dispatcher',
    triggers: {
      github: [
        { on: 'pull_request.opened' },
        { on: 'issue_comment.created', match: '@mention' }
      ],
      slack: [{ on: 'app_mention' }]
    },
    schedules: [{ name: 'nightly', cron: '0 2 * * *', tz: 'UTC' }],
    watch: [{ paths: ['/github/x.json'], events: ['created'] }]
  });
  assert.equal(agent.triggers?.github.length, 2);
  assert.equal(agent.triggers?.github[1].match, '@mention');
  assert.equal(agent.triggers?.slack[0].on, 'app_mention');
  assert.equal(agent.schedules?.[0].name, 'nightly');
  assert.equal(agent.watch?.[0].paths[0], '/github/x.json');
  assert.equal(agent.launchedBy, 'team-dispatcher');
});

test('parseAgentSpec rejects malformed triggers maps with precise field paths', () => {
  assert.throws(
    () => parseAgentSpec({ launchedBy: 'cron' }),
    /launchedBy must be one of: team-dispatcher/
  );
  assert.throws(() => parseAgentSpec({ triggers: [] }), /triggers must be an object keyed by provider/);
  assert.throws(() => parseAgentSpec({ triggers: { github: [] } }), /triggers\.github must be a non-empty array/);
  assert.throws(
    () => parseAgentSpec({ triggers: { github: [{ on: '' }] } }),
    /triggers\.github\[0\]\.on must be a non-empty string/
  );
  // An empty agent (no listeners) parses to {}; the deploy CLI enforces "at least one".
  assert.deepEqual(parseAgentSpec({}), {});
});

test('parseIntegrations default-injects source=deployer_user when the persona omits it', () => {
  const i = parseIntegrations({ github: {} }, 'integrations');
  assert.deepEqual(i?.github.source, { kind: 'deployer_user' });
  assert.equal(
    (i?.github as { __agentworkforceImplicitSource?: unknown }).__agentworkforceImplicitSource,
    true
  );
  assert.equal(Object.keys(i?.github ?? {}).includes('__agentworkforceImplicitSource'), false);
});

test('parseIntegrations round-trips all three valid IntegrationSource kinds', () => {
  const i = parseIntegrations(
    {
      github: { source: { kind: 'deployer_user' } },
      slack: { source: { kind: 'workspace' } },
      linear: {
        source: { kind: 'workspace_service_account', name: 'release-bot' }
      }
    },
    'integrations'
  );
  assert.deepEqual(i?.github.source, { kind: 'deployer_user' });
  assert.equal(
    (i?.github as { __agentworkforceImplicitSource?: unknown }).__agentworkforceImplicitSource,
    undefined
  );
  assert.deepEqual(i?.slack.source, { kind: 'workspace' });
  assert.deepEqual(i?.linear.source, {
    kind: 'workspace_service_account',
    name: 'release-bot'
  });
});

test('parseIntegrations rejects an unknown source.kind with a precise field path', () => {
  assert.throws(
    () =>
      parseIntegrations(
        { github: { source: { kind: 'org' } } },
        'integrations'
      ),
    /integrations\.github\.source\.kind must be one of: deployer_user, workspace, workspace_service_account/
  );
});

test('parseIntegrations rejects workspace_service_account missing name', () => {
  assert.throws(
    () =>
      parseIntegrations(
        { github: { source: { kind: 'workspace_service_account' } } },
        'integrations'
      ),
    /integrations\.github\.source\.name must be a non-empty string when kind="workspace_service_account"/
  );
});

test('parseIntegrations rejects workspace_service_account with non-kebab-case name', () => {
  assert.throws(
    () =>
      parseIntegrations(
        {
          github: {
            source: { kind: 'workspace_service_account', name: 'Release_Bot' }
          }
        },
        'integrations'
      ),
    /integrations\.github\.source\.name must be kebab-case/
  );
});

test('IntegrationSource fixtures round-trip through parsePersonaSpec', () => {
  // Fixtures live under src/__fixtures__/personas/. The compiled test
  // sits at dist/parse.test.js, so resolve back through the package root.
  const here = dirname(fileURLToPath(import.meta.url));
  const fixturesRoot = resolve(here, '..', 'src', '__fixtures__', 'personas');
  const load = (name: string) =>
    JSON.parse(readFileSync(resolve(fixturesRoot, name), 'utf8'));

  const deployer = parsePersonaSpec(
    load('integration-source-deployer.json'),
    'documentation'
  );
  assert.deepEqual(deployer.integrations?.github.source, { kind: 'deployer_user' });

  const workspace = parsePersonaSpec(
    load('integration-source-workspace.json'),
    'documentation'
  );
  assert.deepEqual(workspace.integrations?.slack.source, { kind: 'workspace' });

  const sa = parsePersonaSpec(
    load('integration-source-service-account.json'),
    'documentation'
  );
  assert.deepEqual(sa.integrations?.github.source, {
    kind: 'workspace_service_account',
    name: 'release-bot'
  });
});

test('parseIntegrations rejects extra name on deployer_user / workspace kinds', () => {
  assert.throws(
    () =>
      parseIntegrations(
        { github: { source: { kind: 'deployer_user', name: 'release-bot' } } },
        'integrations'
      ),
    /integrations\.github\.source\.name is only allowed when kind="workspace_service_account"/
  );
  assert.throws(
    () =>
      parseIntegrations(
        { slack: { source: { kind: 'workspace', name: 'release-bot' } } },
        'integrations'
      ),
    /integrations\.slack\.source\.name is only allowed when kind="workspace_service_account"/
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

test('parseWatch accepts relayfile watch rules and dedupes events', () => {
  const watch = parseWatch(
    [
      {
        paths: ['/integrations/github/repos/acme/web/issues/**/*.json'],
        events: ['created', 'updated', 'created'],
        debounceMs: 5000,
        match: '.state == "open"'
      }
    ],
    'watch'
  );
  assert.deepEqual(watch, [
    {
      paths: ['/integrations/github/repos/acme/web/issues/**/*.json'],
      events: ['created', 'updated'],
      debounceMs: 5000,
      match: '.state == "open"'
    }
  ]);
  assert.equal(parseWatch(undefined, 'watch'), undefined);
  assert.equal(parseWatch([], 'watch'), undefined);
});

test('parseWatch rejects malformed relayfile watch rules with precise field paths', () => {
  assert.throws(() => parseWatch({}, 'watch'), /watch must be an array if provided/);
  assert.throws(() => parseWatch([null], 'watch'), /watch\[0\] must be an object/);
  assert.throws(() => parseWatch([{ events: ['created'] }], 'watch'), /watch\[0\]\.paths must be a non-empty array/);
  assert.throws(() => parseWatch([{ paths: [], events: ['created'] }], 'watch'), /watch\[0\]\.paths must be a non-empty array/);
  assert.throws(() => parseWatch([{ paths: [42], events: ['created'] }], 'watch'), /watch\[0\]\.paths\[0\] must be a non-empty string/);
  assert.throws(() => parseWatch([{ paths: ['relative/**'], events: ['created'] }], 'watch'), /watch\[0\]\.paths\[0\] must start with \//);
  assert.throws(() => parseWatch([{ paths: ['/x'] }], 'watch'), /watch\[0\]\.events must be a non-empty array/);
  assert.throws(() => parseWatch([{ paths: ['/x'], events: [] }], 'watch'), /watch\[0\]\.events must be a non-empty array/);
  assert.throws(() => parseWatch([{ paths: ['/x'], events: ['changed'] }], 'watch'), /watch\[0\]\.events\[0\] must be one of: created, updated, deleted/);
  assert.throws(() => parseWatch([{ paths: ['/x'], events: ['created'], debounceMs: -1 }], 'watch'), /watch\[0\]\.debounceMs must be a non-negative number/);
  assert.throws(() => parseWatch([{ paths: ['/x'], events: ['created'], match: '' }], 'watch'), /watch\[0\]\.match must be a non-empty string/);
});

test('parsePersonaSpec round-trips mount.enabled=false (watch now lives on the agent)', () => {
  const spec = parsePersonaSpec(
    validSpec({
      cloud: true,
      onEvent: './agent.ts',
      mount: { enabled: false }
    }),
    'documentation'
  );
  assert.deepEqual(spec.mount, { enabled: false });
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

// Regression: persona-kit must not silently drop consumer-defined capabilities
// it does not model directly (e.g. the cloud-only `teamSolve`). The CLI runs
// this parse client-side before upload, so a dropped key never reaches the
// cloud and `cloud-team-issue` team-launch stays dormant
// (workforce#182 / cloud#1732).
test('parseCapabilities preserves unknown consumer-defined capabilities (teamSolve)', () => {
  const caps = parseCapabilities(
    {
      review: true,
      teamSolve: {
        enabled: true,
        maxMembers: 1,
        roles: ['implementer'],
        tokenBudget: 400000,
        timeBudgetSeconds: 1800
      }
    },
    'persona.capabilities'
  );
  assert.ok(caps, 'capabilities should be defined');
  assert.equal(caps?.review, true);
  // The load-bearing assertion: the unknown key survives the parse with its
  // full object value intact (RED before the pass-through fix).
  assert.deepEqual(caps?.teamSolve, {
    enabled: true,
    maxMembers: 1,
    roles: ['implementer'],
    tokenBudget: 400000,
    timeBudgetSeconds: 1800
  });
});

test('parseCapabilities rejects arrays for the capabilities map and values', () => {
  assert.throws(
    () => parseCapabilities([true], 'persona.capabilities'),
    /persona\.capabilities must be an object if provided/
  );
  assert.throws(
    () => parseCapabilities({ teamSolve: [] }, 'persona.capabilities'),
    /persona\.capabilities\.teamSolve must be a boolean or object if provided/
  );
});

test('parsePersonaSpec round-trip preserves a declared teamSolve capability', () => {
  const spec = parsePersonaSpec(
    validSpec({
      cloud: true,
      capabilities: { teamSolve: { enabled: true, maxMembers: 1 } }
    }),
    'documentation'
  );
  assert.deepEqual(spec.capabilities?.teamSolve, {
    enabled: true,
    maxMembers: 1
  });
});
