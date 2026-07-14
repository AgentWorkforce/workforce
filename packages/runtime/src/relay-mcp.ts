import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';
import type { RelayMcpConfig } from '@agentworkforce/persona-kit';

export type { RelayMcpConfig };

export type RelayMcpLog = (
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  attrs?: Record<string, unknown>
) => void;

export interface BrokerMcpArgsOutput {
  args: string[];
  sideEffectFiles?: string[];
  agentToken?: string | null;
}

export function resolveRelayMcpFromEnv(env: NodeJS.ProcessEnv): RelayMcpConfig | undefined {
  const apiKey = env.RELAY_API_KEY?.trim();
  const agentName = env.RELAY_AGENT_NAME?.trim();
  if (!apiKey || !agentName) return undefined;
  const baseUrl = env.RELAY_BASE_URL?.trim();
  const defaultWorkspace = env.RELAY_DEFAULT_WORKSPACE?.trim();
  return {
    apiKey,
    agentName,
    ...(baseUrl ? { baseUrl } : {}),
    ...(defaultWorkspace ? { defaultWorkspace } : {})
  };
}

export async function resolveAgentRelayBrokerMcpArgs(args: {
  cli: 'claude' | 'codex';
  env: NodeJS.ProcessEnv;
  relayMcp: RelayMcpConfig;
  cwd: string;
  existingArgs: string[];
  log: RelayMcpLog;
}): Promise<string[] | undefined> {
  const broker = resolveAgentRelayBrokerBinary(args.env);
  const brokerArgs = [
    'mcp-args',
    '--cli',
    args.cli,
    '--agent-name',
    args.relayMcp.agentName,
    '--api-key',
    args.relayMcp.apiKey,
    ...(args.relayMcp.baseUrl ? ['--base-url', args.relayMcp.baseUrl] : []),
    '--register',
    '--cwd',
    args.cwd,
    '--existing-args',
    JSON.stringify(args.existingArgs)
  ];
  const workspacesJson = args.env.RELAY_WORKSPACES_JSON?.trim();
  if (workspacesJson) brokerArgs.push('--workspaces-json', workspacesJson);
  if (args.relayMcp.defaultWorkspace) {
    brokerArgs.push('--default-workspace', args.relayMcp.defaultWorkspace);
  }

  const result = await spawnAndCapture({
    bin: broker,
    args: brokerArgs,
    cwd: args.cwd,
    env: args.env,
    timeoutMs: 15_000
  });
  if (result.exitCode !== 0) {
    args.log('warn', 'harness.relay_mcp.broker_args_failed', {
      broker,
      exitCode: result.exitCode,
      stderr: redactRelayBrokerOutput(result.stderr.trim(), args.relayMcp)
    });
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.output);
  } catch (err) {
    args.log('warn', 'harness.relay_mcp.broker_args_invalid_json', {
      broker,
      error: err instanceof Error ? err.message : String(err)
    });
    return undefined;
  }
  if (!isBrokerMcpArgsOutput(parsed) || parsed.args.length === 0) {
    args.log('warn', 'harness.relay_mcp.broker_args_invalid_shape', { broker });
    return undefined;
  }
  if (parsed.sideEffectFiles?.length) {
    args.log('debug', 'harness.relay_mcp.side_effect_files', {
      files: parsed.sideEffectFiles
    });
  }
  return parsed.args;
}

export function resolveAgentRelayBrokerBinary(env: NodeJS.ProcessEnv): string {
  const configured = env.BROKER_BINARY_PATH?.trim() || env.AGENT_RELAY_BIN?.trim();
  if (configured) return configured;
  const sandboxBroker = resolveSandboxAgentRelayBrokerBinary();
  return sandboxBroker ?? 'agent-relay-broker';
}

function resolveSandboxAgentRelayBrokerBinary(): string | undefined {
  const suffix = agentRelayBrokerPlatformSuffix();
  if (!suffix) return undefined;
  const candidate = path.join(
    '/opt/relay-smoke/node_modules/@agent-relay/sdk/bin',
    `agent-relay-broker-${suffix}`
  );
  return canExecuteFileSync(candidate) ? candidate : undefined;
}

function agentRelayBrokerPlatformSuffix(): string | undefined {
  const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : undefined;
  if (!arch) return undefined;
  if (process.platform === 'linux') return `linux-${arch}`;
  if (process.platform === 'darwin') return `darwin-${arch}`;
  if (process.platform === 'win32') return 'win32-x64.exe';
  return undefined;
}

function canExecuteFileSync(candidate: string): boolean {
  try {
    accessSync(candidate, constants.R_OK | constants.X_OK);
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

export function codexExistingArgs(args: string[]): string[] {
  return args[0] === 'exec' ? args.slice(1, -1) : [...args];
}

export function redactRelayBrokerOutput(value: string, relayMcp: RelayMcpConfig): string {
  let redacted = value;
  for (const secret of [relayMcp.apiKey]) {
    if (secret) redacted = redacted.replaceAll(secret, '[REDACTED]');
  }
  return redacted;
}

export function injectCodexSubcommandArgs(args: string[], injected: string[]): string[] {
  if (args[0] === 'exec') return ['exec', ...injected, ...args.slice(1)];
  if (args.length === 0 || args[0]?.startsWith('-')) return [...injected, ...args];
  return [...args];
}

export function injectClaudeAgentRelayMcpConfig(
  args: string[],
  injected: string[],
  log: RelayMcpLog
): string[] | undefined {
  const base = parseClaudeMcpConfigArg(args);
  const broker = parseClaudeMcpConfigArg(injected);
  if (!base || !broker) {
    log('warn', 'harness.relay_mcp.claude_mcp_config_missing');
    return undefined;
  }
  const baseServers = readMcpServersRecord(base.payload);
  const brokerServers = readMcpServersRecord(broker.payload);
  const agentRelay = brokerServers?.['agent-relay'];
  if (!baseServers || !brokerServers || agentRelay === undefined) {
    log('warn', 'harness.relay_mcp.claude_mcp_config_invalid');
    return undefined;
  }
  const mergedServers: Record<string, unknown> = {
    ...baseServers,
    'agent-relay': agentRelay
  };
  delete mergedServers.relaycast;
  const nextPayload = {
    ...base.payload,
    mcpServers: mergedServers
  };
  const next = [...args];
  next[base.valueIndex] = JSON.stringify(nextPayload);
  return next;
}

export function claudeMcpConfigHasRelayOverride(args: string[]): boolean {
  return relayOverrideServerNames(args).length > 0;
}

export function relayOverrideServerNames(args: string[]): string[] {
  const parsed = parseClaudeMcpConfigArg(args);
  const servers = parsed ? readMcpServersRecord(parsed.payload) : undefined;
  if (!servers) return [];
  return ['agent-relay', 'relaycast'].filter((name) => servers[name] !== undefined);
}

function parseClaudeMcpConfigArg(
  args: string[]
): { valueIndex: number; payload: Record<string, unknown> } | undefined {
  const flagIndex = args.indexOf('--mcp-config');
  if (flagIndex < 0) return undefined;
  const valueIndex = flagIndex + 1;
  const raw = args[valueIndex];
  if (typeof raw !== 'string') return undefined;
  try {
    const payload = JSON.parse(raw);
    return isRecord(payload) ? { valueIndex, payload } : undefined;
  } catch {
    return undefined;
  }
}

function readMcpServersRecord(
  payload: Record<string, unknown>
): Record<string, unknown> | undefined {
  const servers = payload.mcpServers;
  return isRecord(servers) ? servers : undefined;
}

function isBrokerMcpArgsOutput(value: unknown): value is BrokerMcpArgsOutput {
  if (!isRecord(value) || !Array.isArray(value.args)) return false;
  if (!value.args.every((arg) => typeof arg === 'string')) return false;
  if (
    value.sideEffectFiles !== undefined &&
    (!Array.isArray(value.sideEffectFiles) ||
      !value.sideEffectFiles.every((file) => typeof file === 'string'))
  ) {
    return false;
  }
  return value.agentToken === undefined ||
    value.agentToken === null ||
    typeof value.agentToken === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function spawnAndCapture(args: {
  bin: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<{ output: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn(args.bin, args.args, {
      cwd: args.cwd,
      env: args.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false
    });
    let stdout = '';
    let stderr = '';
    let forceKillTimeout: NodeJS.Timeout | undefined;
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    const timeout =
      args.timeoutMs !== undefined
        ? setTimeout(() => {
            child.kill('SIGTERM');
            forceKillTimeout = setTimeout(() => child.kill('SIGKILL'), 1000);
          }, args.timeoutMs)
        : undefined;
    const clearTimers = () => {
      if (timeout) clearTimeout(timeout);
      if (forceKillTimeout) clearTimeout(forceKillTimeout);
    };
    child.on('error', (err) => {
      clearTimers();
      resolve({ output: stdout, stderr: `${stderr}${err.message}\n`, exitCode: 1 });
    });
    child.on('close', (code, signal) => {
      clearTimers();
      resolve({
        output: stdout,
        stderr,
        exitCode: typeof code === 'number' ? code : signal ? signalExitCode(signal) : 1
      });
    });
  });
}

function signalExitCode(signal: NodeJS.Signals): number {
  const signals: Record<string, number> = {
    HUP: 1, INT: 2, QUIT: 3, KILL: 9, TERM: 15
  };
  const name = signal.startsWith('SIG') ? signal.slice(3) : signal;
  return signals[name] !== undefined ? 128 + signals[name] : 1;
}
