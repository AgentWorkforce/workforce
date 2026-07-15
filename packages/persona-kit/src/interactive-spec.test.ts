import test from 'node:test';
import assert from 'node:assert/strict';

import { buildInteractiveSpec, buildNonInteractiveSpec } from './interactive-spec.js';

function assertAiHistServer(server: unknown, env: Record<string, string>): void {
  assert.deepEqual(server, {
    type: 'stdio',
    command: 'npx',
    args: ['-y', 'ai-hist-mcp'],
    env
  });
}

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

test('codex translates sandbox harness settings to launch flags', () => {
  const result = buildInteractiveSpec({
    harness: 'codex',
    personaId: 'test-persona',
    model: 'openai-codex/gpt-5.3-codex',
    systemPrompt: 'x',
    harnessSettings: {
      reasoning: 'high',
      timeoutSeconds: 1200,
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
      workspaceWriteNetworkAccess: true,
      webSearch: true
    }
  });
  // approvalPolicy emits a warning but no flag (--ask-for-approval was removed in codex 0.1.77+)
  assert.deepEqual(result.args, [
    '-m',
    'gpt-5.3-codex',
    '--sandbox',
    'workspace-write',
    '-c',
    'sandbox_workspace_write.network_access=true',
    '--search'
  ]);
  assert.ok(
    result.warnings.some((w) => w.includes('approvalPolicy') && w.includes('not supported')),
    'expected a deprecation warning for approvalPolicy'
  );
});

test('codex emits the single bypass flag when dangerouslyBypassApprovalsAndSandbox is set', () => {
  const result = buildInteractiveSpec({
    harness: 'codex',
    personaId: 'test-persona',
    model: 'openai-codex/gpt-5.3-codex',
    systemPrompt: 'x',
    harnessSettings: {
      reasoning: 'high',
      timeoutSeconds: 1200,
      dangerouslyBypassApprovalsAndSandbox: true,
      webSearch: true
    }
  });
  assert.deepEqual(result.args, [
    '-m',
    'gpt-5.3-codex',
    '--dangerously-bypass-approvals-and-sandbox',
    '--search'
  ]);
});

test('codex warns for approvalPolicy even when dangerouslyBypassApprovalsAndSandbox is also set', () => {
  const result = buildInteractiveSpec({
    harness: 'codex',
    personaId: 'test-persona',
    model: 'openai-codex/gpt-5.3-codex',
    systemPrompt: 'x',
    harnessSettings: {
      reasoning: 'high',
      timeoutSeconds: 1200,
      dangerouslyBypassApprovalsAndSandbox: true,
      approvalPolicy: 'on-request',
    }
  });
  // bypass flag is still emitted
  assert.ok(result.args.includes('--dangerously-bypass-approvals-and-sandbox'));
  // approvalPolicy warning fires even though dangerouslyBypassApprovalsAndSandbox masked it
  assert.ok(
    result.warnings.some((w) => w.includes('approvalPolicy') && w.includes('not supported')),
    'expected deprecation warning for approvalPolicy even when bypass flag is set'
  );
});

test('codex translates http mcpServers into --config mcp_servers.* args', () => {
  const result = buildInteractiveSpec({
    harness: 'codex',
    personaId: 'test-persona',
    model: 'openai-codex/gpt-5.3-codex',
    systemPrompt: 'x',
    mcpServers: {
      nango: {
        type: 'http',
        url: 'https://nango.dev/docs/mcp',
        headers: {
          Authorization: 'Bearer token-value',
          'X-Client': 'agentworkforce'
        }
      }
    }
  });
  assert.deepEqual(result.args, [
    '-m',
    'gpt-5.3-codex',
    '--config',
    'mcp_servers.nango.url="https://nango.dev/docs/mcp"',
    '--config',
    'mcp_servers.nango.http_headers={ "Authorization" = "Bearer token-value", "X-Client" = "agentworkforce" }'
  ]);
  assert.deepEqual(result.warnings, []);
});

test('codex translates stdio mcpServers into command/args/env config args', () => {
  const result = buildInteractiveSpec({
    harness: 'codex',
    personaId: 'test-persona',
    model: 'openai-codex/gpt-5.3-codex',
    systemPrompt: 'x',
    mcpServers: {
      relaycast: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@relaycast/mcp'],
        env: { RELAY_BASE_URL: 'https://api.relaycast.dev', RELAY_API_KEY: 'rk_live' }
      }
    }
  });
  assert.deepEqual(result.args, [
    '-m',
    'gpt-5.3-codex',
    '--config',
    'mcp_servers.relaycast.command="npx"',
    '--config',
    'mcp_servers.relaycast.args=["-y", "@relaycast/mcp"]',
    '--config',
    'mcp_servers.relaycast.env={ "RELAY_API_KEY" = "rk_live", "RELAY_BASE_URL" = "https://api.relaycast.dev" }'
  ]);
  assert.deepEqual(result.warnings, []);
});

test('codex quotes mcp server names in TOML keys when bare-key rules do not allow them', () => {
  const result = buildInteractiveSpec({
    harness: 'codex',
    personaId: 'test-persona',
    model: 'openai-codex/gpt-5.3-codex',
    systemPrompt: 'x',
    mcpServers: {
      'nango.docs': {
        type: 'http',
        url: 'https://nango.dev/docs/mcp'
      }
    }
  });
  assert.deepEqual(result.args, [
    '-m',
    'gpt-5.3-codex',
    '--config',
    'mcp_servers."nango.docs".url="https://nango.dev/docs/mcp"'
  ]);
  assert.deepEqual(result.warnings, []);
});

test('codex warns for unsupported permission wiring and sse transport hints', () => {
  const result = buildInteractiveSpec({
    harness: 'codex',
    personaId: 'test-persona',
    model: 'openai-codex/gpt-5.3-codex',
    systemPrompt: 'x',
    mcpServers: { legacy: { type: 'sse', url: 'https://legacy.example.com/sse' } },
    permissions: { allow: ['mcp__legacy'] }
  });
  assert.equal(result.warnings.length, 2);
  assert.match(result.warnings[0], /codex harness is not yet wired for runtime permission/);
  assert.match(result.warnings[1], /type 'sse'; codex expects streamable-http/);
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

test('opencode non-interactive spec relies on cwd and agent config for directory and model', () => {
  const result = buildNonInteractiveSpec({
    harness: 'opencode',
    personaId: 'daily-ship',
    model: 'deepseek-v4-flash-free',
    systemPrompt: 'Reply pong.',
    task: 'say pong',
    name: 'daily-ship',
    workingDirectory: '/tmp/project'
  });

  assert.equal(result.bin, 'opencode');
  assert.deepEqual(result.args, [
    'run',
    '--agent',
    'daily-ship',
    '--format',
    'default',
    '--title',
    'daily-ship',
    'say pong'
  ]);
  assert.ok(!result.args.includes('--dir'));
  assert.ok(!result.args.includes('--model'));

  const [file] = result.configFiles;
  const parsed = JSON.parse(file.contents);
  assert.equal(parsed.agent['daily-ship'].model, 'deepseek-v4-flash-free');
});

test('grok launches the Grok Build CLI and writes systemPrompt to AGENTS.md', () => {
  const result = buildInteractiveSpec({
    harness: 'grok',
    personaId: 'test-persona',
    model: 'grok-build-0.1',
    systemPrompt: 'you are a test'
  });
  assert.equal(result.bin, 'grok');
  assert.deepEqual(result.args, ['--no-auto-update', '--model', 'grok-build-0.1']);
  assert.equal(result.initialPrompt, null);
  assert.deepEqual(result.configFiles, [
    { path: 'AGENTS.md', contents: 'you are a test\n' }
  ]);
  assert.deepEqual(result.warnings, []);
});

test('grok maps bypassPermissions to always-approve and wires plugin dirs', () => {
  const result = buildInteractiveSpec({
    harness: 'grok',
    personaId: 'test-persona',
    model: 'grok-build-0.1',
    systemPrompt: 'x',
    permissions: { mode: 'bypassPermissions' },
    pluginDirs: ['/tmp/session/grok/plugin']
  });
  assert.deepEqual(result.args, [
    '--no-auto-update',
    '--model',
    'grok-build-0.1',
    '--always-approve',
    '--plugin-dir',
    '/tmp/session/grok/plugin'
  ]);
  assert.deepEqual(result.warnings, []);
});

test('grok warns for unsupported permission fields', () => {
  const result = buildInteractiveSpec({
    harness: 'grok',
    personaId: 'test-persona',
    model: 'grok-build-0.1',
    systemPrompt: 'x',
    permissions: {
      allow: ['Bash(git *)'],
      deny: ['Bash(rm -rf *)'],
      mode: 'acceptEdits'
    }
  });
  assert.deepEqual(result.args, [
    '--no-auto-update',
    '--model',
    'grok-build-0.1',
  ]);
  assert.deepEqual(result.warnings, [
    'persona declares permission allow/deny lists but the grok harness is not wired for allow/deny injection; proceeding without allow/deny rules.',
    'persona declares permissions.mode "acceptEdits" but the grok harness only supports bypassPermissions via --always-approve; proceeding with Grok defaults.'
  ]);
});

test('grok non-interactive spec uses single-shot mode with cwd and always-approve', () => {
  const result = buildNonInteractiveSpec({
    harness: 'grok',
    personaId: 'daily-ship',
    model: 'grok-build-0.1',
    systemPrompt: 'Reply pong.',
    task: 'say pong',
    workingDirectory: '/tmp/project'
  });

  assert.equal(result.bin, 'grok');
  assert.deepEqual(result.args, [
    '--no-auto-update',
    '--model',
    'grok-build-0.1',
    '--output-format',
    'plain',
    '--cwd',
    '/tmp/project',
    '--always-approve',
    '--single',
    'Reply pong.\n\nUser task:\nsay pong'
  ]);
  assert.deepEqual(result.configFiles, [
    { path: 'AGENTS.md', contents: 'Reply pong.\n' }
  ]);
  assert.deepEqual(result.warnings, []);
});

test('grok non-interactive spec still adds always-approve for unsupported permission modes', () => {
  const result = buildNonInteractiveSpec({
    harness: 'grok',
    personaId: 'daily-ship',
    model: 'grok-build-0.1',
    systemPrompt: '',
    task: 'say pong',
    permissions: { mode: 'plan' }
  });

  assert.deepEqual(result.args, [
    '--no-auto-update',
    '--model',
    'grok-build-0.1',
    '--output-format',
    'plain',
    '--always-approve',
    '--single',
    'say pong'
  ]);
  assert.deepEqual(result.warnings, [
    'persona declares permissions.mode "plan" but the grok harness only supports bypassPermissions via --always-approve; proceeding with Grok defaults.'
  ]);
});

test('claude and codex emit an empty configFiles array; grok does so only with an empty systemPrompt', () => {
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

  const grok = buildInteractiveSpec({
    harness: 'grok',
    personaId: 'test-persona',
    model: 'grok-build-0.1',
    systemPrompt: ''
  });
  assert.deepEqual(grok.configFiles, []);
});

test('claude branch omits --append-system-prompt when systemPrompt is empty', () => {
  // Empty systemPrompt is the persona's signal that no kickoff message is
  // intended (e.g. an optional task input that wasn't forwarded). The
  // harness still auto-loads CLAUDE.md from cwd, so the agent has its
  // operating spec; we just don't want a stray `--append-system-prompt ''`
  // flag steering behavior on every turn.
  const result = buildInteractiveSpec({
    harness: 'claude',
    personaId: 'test-persona',
    model: 'claude-opus-4-6',
    systemPrompt: ''
  });
  assert.ok(!result.args.includes('--append-system-prompt'));
  // strict-mcp still emitted — that's about isolation, not the prompt.
  assert.ok(result.args.includes('--strict-mcp-config'));
});

test('claude non-interactive spec omits unsupported --name while preserving run flags', () => {
  const result = buildNonInteractiveSpec({
    harness: 'claude',
    personaId: 'daily-ship',
    model: 'claude-sonnet-4-6',
    systemPrompt: 'Reply pong.',
    task: 'say pong',
    name: 'daily-ship'
  });

  const args = result.args;
  const modelIdx = args.indexOf('--model');
  const promptIdx = args.indexOf('--append-system-prompt');
  const outputIdx = args.indexOf('--output-format');

  assert.equal(result.bin, 'claude');
  assert.ok(!args.includes('--name'));
  assert.ok(modelIdx >= 0);
  assert.equal(args[modelIdx + 1], 'claude-sonnet-4-6');
  assert.ok(args.includes('--print'));
  assert.ok(outputIdx >= 0);
  assert.equal(args[outputIdx + 1], 'text');
  assert.ok(promptIdx >= 0);
  assert.equal(args[promptIdx + 1], 'Reply pong.');
  assert.equal(args[args.length - 1], 'say pong');
});

test('opencode omits agent.prompt when systemPrompt is empty', () => {
  const result = buildInteractiveSpec({
    harness: 'opencode',
    personaId: 'test-persona',
    model: 'opencode/minimax-m2.5',
    systemPrompt: ''
  });
  const [file] = result.configFiles;
  const parsed = JSON.parse(file.contents);
  assert.equal(parsed.agent['test-persona'].prompt, undefined);
  assert.equal(parsed.agent['test-persona'].model, 'opencode/minimax-m2.5');
  assert.equal(parsed.agent['test-persona'].mode, 'primary');
});

test('codex passes empty systemPrompt through as a falsy initialPrompt', () => {
  // Caller appends initialPrompt only when truthy, so an empty
  // systemPrompt produces a TUI-only launch with no kickoff message.
  const result = buildInteractiveSpec({
    harness: 'codex',
    personaId: 'test-persona',
    model: 'openai-codex/gpt-5.3-codex',
    systemPrompt: ''
  });
  assert.equal(result.initialPrompt, '');
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

test('codex and opencode warn and ignore pluginDirs', () => {
  const codex = buildInteractiveSpec({
    harness: 'codex',
    personaId: 'test-persona',
    model: 'x',
    systemPrompt: 'x',
    pluginDirs: ['/tmp/session/plugin']
  });
  assert.ok(!codex.args.includes('--plugin-dir'));
  assert.ok(codex.warnings.some((w) => /supported only for claude and grok/.test(w)));

  const opencode = buildInteractiveSpec({
    harness: 'opencode',
    personaId: 'test-persona',
    model: 'x',
    systemPrompt: 'x',
    pluginDirs: ['/tmp/session/plugin']
  });
  assert.ok(!opencode.args.includes('--plugin-dir'));
  assert.ok(opencode.warnings.some((w) => /supported only for claude and grok/.test(w)));
});

test('warnings are returned, not printed — library consumers route I/O themselves', () => {
  // Ensure no side effects on stderr: if the function wrote to stderr, this
  // test would leak output into the test runner. We just assert the shape.
  const result = buildInteractiveSpec({
    harness: 'codex',
    personaId: 'test-persona',
    model: 'x',
    systemPrompt: 'x',
    permissions: { allow: ['Bash(*)'] }
  });
  assert.ok(Array.isArray(result.warnings));
  assert.equal(result.warnings.length, 1);
});

test('relayMcp injects a relaycast server into the claude --mcp-config payload', () => {
  const result = buildInteractiveSpec({
    harness: 'claude',
    personaId: 'test-persona',
    model: 'claude-sonnet-4-6',
    systemPrompt: 'x',
    relayMcp: {
      apiKey: 'wk_live_abc',
      agentName: 'Reviewer2',
      baseUrl: 'https://api.relaycast.dev',
      defaultWorkspace: 'ws_1'
    }
  });
  const mcpIdx = result.args.indexOf('--mcp-config');
  const payload = JSON.parse(result.args[mcpIdx + 1]);
  assert.deepEqual(payload.mcpServers.relaycast, {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@relaycast/mcp'],
    env: {
      RELAY_API_KEY: 'wk_live_abc',
      RELAY_AGENT_NAME: 'Reviewer2',
      RELAY_AGENT_TYPE: 'agent',
      RELAY_STRICT_AGENT_NAME: '1',
      RELAY_BASE_URL: 'https://api.relaycast.dev',
      RELAY_DEFAULT_WORKSPACE: 'ws_1'
    }
  });
  // --strict-mcp-config still present: relaycast rides inside the strict payload.
  assert.ok(result.args.includes('--strict-mcp-config'));
  assert.equal(result.mcpServers?.relaycast?.type, 'stdio');
});

test('relayMcp omits RELAY_BASE_URL / RELAY_DEFAULT_WORKSPACE when not provided', () => {
  const result = buildInteractiveSpec({
    harness: 'claude',
    personaId: 'p',
    model: 'm',
    systemPrompt: 'x',
    relayMcp: { apiKey: 'wk_live_abc', agentName: 'Solo1' }
  });
  const mcpIdx = result.args.indexOf('--mcp-config');
  const env = JSON.parse(result.args[mcpIdx + 1]).mcpServers.relaycast.env;
  assert.deepEqual(env, {
    RELAY_API_KEY: 'wk_live_abc',
    RELAY_AGENT_NAME: 'Solo1',
    RELAY_AGENT_TYPE: 'agent',
    RELAY_STRICT_AGENT_NAME: '1'
  });
});

test('relayMcp merges alongside persona-declared servers; a persona relaycast wins', () => {
  const result = buildInteractiveSpec({
    harness: 'claude',
    personaId: 'p',
    model: 'm',
    systemPrompt: 'x',
    mcpServers: {
      posthog: { type: 'http', url: 'https://mcp.posthog.com/mcp' },
      relaycast: { type: 'stdio', command: 'custom-relaycast' }
    },
    relayMcp: { apiKey: 'wk_live_abc', agentName: 'Solo1' }
  });
  const mcpIdx = result.args.indexOf('--mcp-config');
  const payload = JSON.parse(result.args[mcpIdx + 1]);
  // Persona's own server set is preserved...
  assert.ok(payload.mcpServers.posthog);
  // ...and a persona-declared `relaycast` overrides the injected one.
  assert.deepEqual(payload.mcpServers.relaycast, {
    type: 'stdio',
    command: 'custom-relaycast'
  });
  assert.deepEqual(result.mcpServers?.relaycast, {
    type: 'stdio',
    command: 'custom-relaycast'
  });
});

test('aiHist injects an ai-hist server into the claude --mcp-config payload', () => {
  const result = buildInteractiveSpec({
    harness: 'claude',
    personaId: 'test-persona',
    model: 'claude-sonnet-4-6',
    systemPrompt: 'x',
    aiHist: { trajectoryRoot: '/repo/.trajectories', dbPath: '/db/ai-history.db' }
  });
  const mcpIdx = result.args.indexOf('--mcp-config');
  const payload = JSON.parse(result.args[mcpIdx + 1]);
  assertAiHistServer(payload.mcpServers['ai-hist'], {
    TRAJECTORY_ROOT: '/repo/.trajectories',
    AI_HIST_DB: '/db/ai-history.db'
  });
  assert.ok(result.args.includes('--strict-mcp-config'));
  assert.equal(result.mcpServers?.['ai-hist']?.type, 'stdio');
});

test('aiHist omits TRAJECTORY_ROOT / AI_HIST_DB env when not provided', () => {
  const result = buildInteractiveSpec({
    harness: 'claude',
    personaId: 'p',
    model: 'm',
    systemPrompt: 'x',
    aiHist: {}
  });
  const mcpIdx = result.args.indexOf('--mcp-config');
  const server = JSON.parse(result.args[mcpIdx + 1]).mcpServers['ai-hist'];
  assertAiHistServer(server, {});
});

test('aiHist merges alongside relaycast + persona servers; a persona ai-hist wins', () => {
  const result = buildInteractiveSpec({
    harness: 'claude',
    personaId: 'p',
    model: 'm',
    systemPrompt: 'x',
    mcpServers: {
      posthog: { type: 'http', url: 'https://mcp.posthog.com/mcp' },
      'ai-hist': { type: 'stdio', command: 'custom-ai-hist' }
    },
    relayMcp: { apiKey: 'wk_live_abc', agentName: 'Solo1' },
    aiHist: { trajectoryRoot: '/repo/.trajectories' }
  });
  const mcpIdx = result.args.indexOf('--mcp-config');
  const payload = JSON.parse(result.args[mcpIdx + 1]);
  // relaycast still injected, persona servers preserved...
  assert.equal(payload.mcpServers.relaycast?.command, 'npx');
  assert.ok(payload.mcpServers.posthog);
  // ...and a persona-declared `ai-hist` overrides the injected one.
  assert.deepEqual(payload.mcpServers['ai-hist'], { type: 'stdio', command: 'custom-ai-hist' });
});

test('without aiHist the claude payload carries no ai-hist server', () => {
  const result = buildInteractiveSpec({
    harness: 'claude',
    personaId: 'p',
    model: 'm',
    systemPrompt: 'x'
  });
  const mcpIdx = result.args.indexOf('--mcp-config');
  const payload = JSON.parse(result.args[mcpIdx + 1]);
  assert.equal(payload.mcpServers['ai-hist'], undefined);
});

test('without relayMcp the claude payload carries no relaycast server', () => {
  const result = buildInteractiveSpec({
    harness: 'claude',
    personaId: 'p',
    model: 'm',
    systemPrompt: 'x'
  });
  const mcpIdx = result.args.indexOf('--mcp-config');
  const payload = JSON.parse(result.args[mcpIdx + 1]);
  assert.equal(payload.mcpServers.relaycast, undefined);
});

test('relayMcp wires relaycast into codex --config args', () => {
  const result = buildInteractiveSpec({
    harness: 'codex',
    personaId: 'p',
    model: 'm',
    systemPrompt: 'x',
    relayMcp: { apiKey: 'wk_live_abc', agentName: 'Coder1' }
  });
  const joined = result.args.join(' ');
  assert.ok(joined.includes('mcp_servers.relaycast.command'));
  assert.ok(joined.includes('RELAY_AGENT_NAME'));
});

test('relayMcp under opencode warns that MCP injection is unsupported', () => {
  const result = buildInteractiveSpec({
    harness: 'opencode',
    personaId: 'p',
    model: 'opencode/gpt-5',
    systemPrompt: 'x',
    relayMcp: { apiKey: 'wk_live_abc', agentName: 'Op1' }
  });
  assert.deepEqual(result.warnings, [
    'default relaycast MCP injection was requested but the opencode harness is not yet wired for runtime MCP injection; proceeding without MCP.'
  ]);
  assert.equal(result.mcpServers?.relaycast?.type, 'stdio');
});

test('relayMcp under grok warns that MCP injection is unsupported', () => {
  const result = buildInteractiveSpec({
    harness: 'grok',
    personaId: 'p',
    model: 'grok-build-0.1',
    systemPrompt: 'x',
    relayMcp: { apiKey: 'wk_live_abc', agentName: 'Grok1' }
  });
  assert.deepEqual(result.warnings, [
    'broker requested relaycast MCP injection but the grok harness is not yet wired for runtime MCP injection; proceeding without MCP.'
  ]);
  assert.equal(result.mcpServers?.relaycast?.type, 'stdio');
});

test('opencode warning names both persona and broker MCP sources when both are present', () => {
  const result = buildInteractiveSpec({
    harness: 'opencode',
    personaId: 'p',
    model: 'opencode/gpt-5',
    systemPrompt: 'x',
    mcpServers: {
      posthog: { type: 'http', url: 'https://mcp.posthog.com/mcp' }
    },
    relayMcp: { apiKey: 'wk_live_abc', agentName: 'Op1' }
  });
  assert.deepEqual(result.warnings, [
    'persona declares mcpServers and default relaycast MCP injection was requested, but the opencode harness is not yet wired for runtime MCP injection; proceeding without MCP.'
  ]);
});

test('grok warning names both persona and broker MCP sources when both are present', () => {
  const result = buildInteractiveSpec({
    harness: 'grok',
    personaId: 'p',
    model: 'grok-build-0.1',
    systemPrompt: 'x',
    mcpServers: {
      posthog: { type: 'http', url: 'https://mcp.posthog.com/mcp' }
    },
    relayMcp: { apiKey: 'wk_live_abc', agentName: 'Grok1' }
  });
  assert.deepEqual(result.warnings, [
    'persona declares mcpServers and broker requested relaycast MCP injection, but the grok harness is not yet wired for runtime MCP injection; proceeding without MCP.'
  ]);
});
