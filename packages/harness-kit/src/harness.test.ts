import test from 'node:test';
import assert from 'node:assert/strict';

import { buildInteractiveSpec } from './harness.js';

test('claude branch always emits --mcp-config + --strict-mcp-config', () => {
  const result = buildInteractiveSpec({
    harness: 'claude',
    personaId: 'test-persona',
    model: 'claude-opus-4-6',
    systemPrompt: 'you are a test'
  });
  assert.equal(result.bin, 'claude');
  assert.equal(result.initialPrompt, null);
  assert.deepEqual(result.warnings, []);
  // Both flags present even with no mcpServers — forces isolation from
  // user/project Claude Code config.
  const args = result.args;
  const mcpIdx = args.indexOf('--mcp-config');
  assert.ok(mcpIdx >= 0, 'expected --mcp-config');
  assert.equal(args[mcpIdx + 1], '{"mcpServers":{}}');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.ok(args.includes('--model'));
  assert.ok(args.includes('--append-system-prompt'));
});

test('claude branch serializes resolved mcpServers into the --mcp-config payload', () => {
  const result = buildInteractiveSpec({
    harness: 'claude',
    personaId: 'test-persona',
    model: 'claude-sonnet-4-6',
    systemPrompt: 'x',
    mcpServers: {
      posthog: {
        type: 'http',
        url: 'https://mcp.posthog.com/mcp',
        headers: { Authorization: 'Bearer phx_real' }
      }
    }
  });
  const mcpIdx = result.args.indexOf('--mcp-config');
  const payload = JSON.parse(result.args[mcpIdx + 1]);
  assert.deepEqual(payload, {
    mcpServers: {
      posthog: {
        type: 'http',
        url: 'https://mcp.posthog.com/mcp',
        headers: { Authorization: 'Bearer phx_real' }
      }
    }
  });
});

test('claude branch translates permissions to flags', () => {
  const result = buildInteractiveSpec({
    harness: 'claude',
    personaId: 'test-persona',
    model: 'claude-opus-4-6',
    systemPrompt: 'x',
    permissions: {
      allow: ['mcp__posthog', 'Bash(git *)'],
      deny: ['Bash(rm -rf *)'],
      mode: 'acceptEdits'
    }
  });
  const args = result.args;
  const allowIdx = args.indexOf('--allowedTools');
  const denyIdx = args.indexOf('--disallowedTools');
  const modeIdx = args.indexOf('--permission-mode');
  assert.ok(allowIdx >= 0 && denyIdx >= 0 && modeIdx >= 0);
  assert.equal(args[allowIdx + 1], 'mcp__posthog');
  assert.equal(args[allowIdx + 2], 'Bash(git *)');
  assert.equal(args[denyIdx + 1], 'Bash(rm -rf *)');
  assert.equal(args[modeIdx + 1], 'acceptEdits');
});

test('claude branch omits permission flags when unset or empty', () => {
  const result = buildInteractiveSpec({
    harness: 'claude',
    personaId: 'test-persona',
    model: 'claude-opus-4-6',
    systemPrompt: 'x',
    permissions: { allow: [], deny: [] }
  });
  assert.ok(!result.args.includes('--allowedTools'));
  assert.ok(!result.args.includes('--disallowedTools'));
  assert.ok(!result.args.includes('--permission-mode'));
});

test('codex carries system prompt as initial positional; strips provider prefix from model', () => {
  const result = buildInteractiveSpec({
    harness: 'codex',
    personaId: 'test-persona',
    model: 'openai-codex/gpt-5.3-codex',
    systemPrompt: 'system-directive'
  });
  assert.equal(result.bin, 'codex');
  assert.deepEqual(result.args, ['-m', 'gpt-5.3-codex']);
  assert.equal(result.initialPrompt, 'system-directive');
});

test('codex warns when mcpServers / permissions are declared', () => {
  const result = buildInteractiveSpec({
    harness: 'codex',
    personaId: 'test-persona',
    model: 'openai-codex/gpt-5.3-codex',
    systemPrompt: 'x',
    mcpServers: { foo: { type: 'http', url: 'https://example.com' } },
    permissions: { allow: ['mcp__foo'] }
  });
  assert.equal(result.warnings.length, 2);
  assert.match(result.warnings[0], /codex harness is not yet wired for runtime MCP/);
  assert.match(result.warnings[1], /codex harness is not yet wired for runtime permission/);
});

test('opencode defines a per-persona agent in opencode.json and selects it with --agent', () => {
  const result = buildInteractiveSpec({
    harness: 'opencode',
    personaId: 'test-persona',
    model: 'opencode/minimax-m2.5',
    systemPrompt: 'you are a test'
  });
  assert.equal(result.bin, 'opencode');
  // No --prompt (that flag pre-fills the TUI input with the system prompt as
  // a *user* message) and no bare -m (opencode's -m expects provider/model;
  // earlier code stripped the provider and silently fell back to the default
  // model). Model + system prompt now live in the emitted opencode.json,
  // selected by persona id via --agent.
  assert.deepEqual(result.args, ['--agent', 'test-persona']);
  assert.ok(!result.args.includes('--prompt'));
  assert.ok(!result.args.includes('--model'));
  assert.ok(!result.args.includes('-m'));
  assert.equal(result.initialPrompt, null);
});

test('opencode configFiles carries a well-formed opencode.json with the agent definition', () => {
  const result = buildInteractiveSpec({
    harness: 'opencode',
    personaId: 'test-persona',
    model: 'opencode/minimax-m2.5',
    systemPrompt: 'you are a test'
  });
  assert.equal(result.configFiles.length, 1);
  const [file] = result.configFiles;
  assert.equal(file.path, 'opencode.json');
  const parsed = JSON.parse(file.contents);
  assert.deepEqual(parsed, {
    agent: {
      'test-persona': {
        model: 'opencode/minimax-m2.5',
        prompt: 'you are a test',
        mode: 'primary',
        // Wildcard-allow across opencode's tool set — matches the built-in
        // `build` agent. Without this, opencode's restrictive default kept
        // agents from making any edits and autosync had nothing to
        // propagate on exit. Object form (not bare 'allow' string) because
        // opencode 1.14.x's agent-config decoder Object.assigns the value
        // before its string-normalizer runs, which mangles strings into
        // their indexed chars.
        permission: { '*': 'allow' }
      }
    }
  });
});

test('claude and codex emit an empty configFiles array', () => {
  const claude = buildInteractiveSpec({
    harness: 'claude',
    personaId: 'test-persona',
    model: 'claude-opus-4-6',
    systemPrompt: 'x'
  });
  assert.deepEqual(claude.configFiles, []);

  const codex = buildInteractiveSpec({
    harness: 'codex',
    personaId: 'test-persona',
    model: 'openai-codex/gpt-5.3-codex',
    systemPrompt: 'x'
  });
  assert.deepEqual(codex.configFiles, []);
});

test('claude branch appends --plugin-dir per entry in pluginDirs', () => {
  const result = buildInteractiveSpec({
    harness: 'claude',
    personaId: 'test-persona',
    model: 'claude-opus-4-6',
    systemPrompt: 'x',
    pluginDirs: ['/tmp/session-a/claude/plugin', '/tmp/session-b/claude/plugin']
  });
  const args = result.args;
  const indices: number[] = [];
  args.forEach((a, i) => {
    if (a === '--plugin-dir') indices.push(i);
  });
  assert.equal(indices.length, 2);
  assert.equal(args[indices[0] + 1], '/tmp/session-a/claude/plugin');
  assert.equal(args[indices[1] + 1], '/tmp/session-b/claude/plugin');
  assert.deepEqual(result.warnings, []);
});

test('claude branch omits --plugin-dir when pluginDirs is empty or absent', () => {
  const withEmpty = buildInteractiveSpec({
    harness: 'claude',
    personaId: 'test-persona',
    model: 'claude-opus-4-6',
    systemPrompt: 'x',
    pluginDirs: []
  });
  const without = buildInteractiveSpec({
    harness: 'claude',
    personaId: 'test-persona',
    model: 'claude-opus-4-6',
    systemPrompt: 'x'
  });
  assert.ok(!withEmpty.args.includes('--plugin-dir'));
  assert.ok(!without.args.includes('--plugin-dir'));
});

test('non-claude harnesses warn and ignore pluginDirs', () => {
  const codex = buildInteractiveSpec({
    harness: 'codex',
    personaId: 'test-persona',
    model: 'x',
    systemPrompt: 'x',
    pluginDirs: ['/tmp/session/plugin']
  });
  assert.ok(!codex.args.includes('--plugin-dir'));
  assert.ok(codex.warnings.some((w) => /pluginDirs is currently claude-only/.test(w)));

  const opencode = buildInteractiveSpec({
    harness: 'opencode',
    personaId: 'test-persona',
    model: 'x',
    systemPrompt: 'x',
    pluginDirs: ['/tmp/session/plugin']
  });
  assert.ok(!opencode.args.includes('--plugin-dir'));
  assert.ok(opencode.warnings.some((w) => /pluginDirs is currently claude-only/.test(w)));
});

test('warnings are returned, not printed — library consumers route I/O themselves', () => {
  // Ensure no side effects on stderr: if the function wrote to stderr, this
  // test would leak output into the test runner. We just assert the shape.
  const result = buildInteractiveSpec({
    harness: 'codex',
    personaId: 'test-persona',
    model: 'x',
    systemPrompt: 'x',
    mcpServers: { a: { type: 'http', url: 'https://x' } }
  });
  assert.ok(Array.isArray(result.warnings));
  assert.equal(result.warnings.length, 1);
});
