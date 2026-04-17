import test from 'node:test';
import assert from 'node:assert/strict';

import { buildInteractiveSpec } from './harness.js';

test('claude branch always emits --mcp-config + --strict-mcp-config', () => {
  const result = buildInteractiveSpec({
    harness: 'claude',
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
    model: 'openai-codex/gpt-5.3-codex',
    systemPrompt: 'x',
    mcpServers: { foo: { type: 'http', url: 'https://example.com' } },
    permissions: { allow: ['mcp__foo'] }
  });
  assert.equal(result.warnings.length, 2);
  assert.match(result.warnings[0], /codex harness is not yet wired for runtime MCP/);
  assert.match(result.warnings[1], /codex harness is not yet wired for runtime permission/);
});

test('opencode carries system prompt and strips provider prefix', () => {
  const result = buildInteractiveSpec({
    harness: 'opencode',
    model: 'opencode/minimax-m2.5',
    systemPrompt: 'x'
  });
  assert.equal(result.bin, 'opencode');
  assert.deepEqual(result.args, ['--model', 'minimax-m2.5']);
  assert.equal(result.initialPrompt, 'x');
});

test('warnings are returned, not printed — library consumers route I/O themselves', () => {
  // Ensure no side effects on stderr: if the function wrote to stderr, this
  // test would leak output into the test runner. We just assert the shape.
  const result = buildInteractiveSpec({
    harness: 'codex',
    model: 'x',
    systemPrompt: 'x',
    mcpServers: { a: { type: 'http', url: 'https://x' } }
  });
  assert.ok(Array.isArray(result.warnings));
  assert.equal(result.warnings.length, 1);
});
