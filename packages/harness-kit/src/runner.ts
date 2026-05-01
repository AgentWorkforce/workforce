import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  usePersona,
  useSelection,
  type Harness,
  type PersonaContext,
  type PersonaIntent,
  type PersonaSelection,
  type PersonaTier,
  type RoutingProfile,
  type RoutingProfileId
} from '@agentworkforce/workload-router';

import { resolveStringMapLenient } from './env-refs.js';
import { buildInteractiveSpec, type BuildInteractiveSpecInput } from './harness.js';
import { formatDropWarnings, resolveMcpServersLenient } from './mcp.js';

export interface PersonaSendOptions {
  workingDirectory?: string;
  name?: string;
  timeoutSeconds?: number;
  inputs?: Record<string, string | number | boolean>;
  installSkills?: boolean;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onProgress?: (chunk: { stream: 'stdout' | 'stderr'; text: string }) => void;
}

export interface PersonaExecutionResult {
  status: 'completed' | 'failed' | 'cancelled' | 'timeout';
  output: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  workflowRunId?: string;
  stepName?: string;
}

export interface PersonaExecution extends Promise<PersonaExecutionResult> {
  cancel(reason?: string): void;
  readonly runId: Promise<string>;
}

export interface RunnablePersonaContext {
  readonly selection: PersonaSelection;
  readonly install: PersonaContext['install'];
  sendMessage(task: string, options?: PersonaSendOptions): PersonaExecution;
}

export interface RunnablePersonaOptions {
  harness?: Harness;
  tier?: PersonaTier;
  profile?: RoutingProfile | RoutingProfileId;
  installRoot?: string;
  commandOverrides?: Partial<Record<Harness, string>>;
}

export interface RunnableSelectionOptions {
  harness?: Harness;
  installRoot?: string;
  commandOverrides?: Partial<Record<Harness, string>>;
}

export interface NonInteractiveSpec {
  bin: string;
  args: readonly string[];
  configFiles: readonly { path: string; contents: string }[];
  warnings: readonly string[];
}

interface SpawnCaptureResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  status: PersonaExecutionResult['status'];
}

interface ConfigWrite {
  path: string;
  existed: boolean;
  previous?: string;
}

const FORCE_KILL_GRACE_MS = 1_000;

export function useRunnablePersona(
  intent: PersonaIntent,
  options: RunnablePersonaOptions = {}
): RunnablePersonaContext {
  const context = usePersona(intent, {
    harness: options.harness,
    tier: options.tier,
    profile: options.profile,
    installRoot: options.installRoot
  });
  return makeRunnablePersonaContext(context, {
    commandOverrides: options.commandOverrides
  });
}

export function useRunnableSelection(
  selection: PersonaSelection,
  options: RunnableSelectionOptions = {}
): RunnablePersonaContext {
  const context = useSelection(selection, {
    harness: options.harness,
    installRoot: options.installRoot
  });
  return makeRunnablePersonaContext(context, {
    commandOverrides: options.commandOverrides
  });
}

export function makeRunnablePersonaContext(
  context: PersonaContext,
  options: { commandOverrides?: Partial<Record<Harness, string>> } = {}
): RunnablePersonaContext {
  const sendMessage = (task: string, sendOptions: PersonaSendOptions = {}) => {
    const runId = randomUUID();
    const controller = new AbortController();
    const startedAt = Date.now();
    let cancelReason = '';

    const cancel = (reason = 'cancelled') => {
      cancelReason = reason;
      controller.abort();
    };

    const promise = (async (): Promise<PersonaExecutionResult> => {
      const cwd = sendOptions.workingDirectory ?? process.cwd();
      const callerEnv = sendOptions.env ? { ...process.env, ...sendOptions.env } : process.env;
      const envResolution = resolveStringMapLenient(context.selection.env, callerEnv, 'env');
      const mcpResolution = resolveMcpServersLenient(context.selection.mcpServers, callerEnv);
      const dropWarnings = formatDropWarnings(
        envResolution.dropped,
        mcpResolution.dropped,
        mcpResolution.droppedServers
      );
      const spec = buildNonInteractiveSpec({
        harness: context.selection.runtime.harness,
        personaId: context.selection.personaId,
        model: context.selection.runtime.model,
        systemPrompt: context.selection.runtime.systemPrompt,
        mcpServers: mcpResolution.servers,
        permissions: context.selection.permissions,
        task: withInputs(task, sendOptions.inputs),
        name: sendOptions.name,
        workingDirectory: cwd
      });
      const warnings = [...dropWarnings, ...spec.warnings];
      const warningText = warnings.length ? warnings.map((w) => `warning: ${w}\n`).join('') : '';
      if (warningText) {
        sendOptions.onProgress?.({ stream: 'stderr', text: warningText });
      }

      const env = {
        ...callerEnv,
        ...(envResolution.value ?? {})
      };
      const bin = options.commandOverrides?.[context.selection.runtime.harness] ?? spec.bin;
      const signal = anySignal([controller.signal, sendOptions.signal]);
      if (signal?.aborted) {
        return {
          status: 'cancelled',
          output: '',
          stderr: warningText + abortReason(signal, cancelReason),
          exitCode: null,
          durationMs: Date.now() - startedAt
        };
      }
      const configWrites = materializeConfigFiles(cwd, spec.configFiles);
      try {
        if (sendOptions.installSkills === true && context.install.commandString !== ':') {
          const install = await spawnCapture(
            context.install.command[0],
            context.install.command.slice(1),
            { cwd, env, signal, timeoutSeconds: sendOptions.timeoutSeconds, onProgress: sendOptions.onProgress }
          );
          if (install.status !== 'completed' || install.exitCode !== 0) {
            return {
              status: install.status === 'completed' ? 'failed' : install.status,
              output: install.stdout,
              stderr: warningText + install.stderr,
              exitCode: install.exitCode,
              durationMs: Date.now() - startedAt
            };
          }
        }

        const result = await spawnCapture(bin, spec.args, {
          cwd,
          env,
          signal,
          timeoutSeconds: sendOptions.timeoutSeconds,
          onProgress: sendOptions.onProgress
        });
        const status =
          result.status === 'completed' && result.exitCode !== 0 ? 'failed' : result.status;
        return {
          status,
          output: result.stdout,
          stderr: warningText + result.stderr + (cancelReason ? `\n${cancelReason}` : ''),
          exitCode: result.exitCode,
          durationMs: Date.now() - startedAt
        };
      } finally {
        restoreConfigFiles(configWrites);
        if (sendOptions.installSkills === true && context.install.cleanupCommandString !== ':') {
          await spawnCapture(context.install.cleanupCommand[0], context.install.cleanupCommand.slice(1), {
            cwd,
            env,
            signal: undefined,
            timeoutSeconds: 30
          });
        }
      }
    })();

    const execution = promise as PersonaExecution;
    Object.defineProperties(execution, {
      cancel: { value: cancel },
      runId: { value: Promise.resolve(runId) }
    });
    return execution;
  };

  return Object.freeze({
    selection: context.selection,
    install: context.install,
    sendMessage
  });
}

export function buildNonInteractiveSpec(
  input: BuildInteractiveSpecInput & {
    task: string;
    name?: string;
    workingDirectory?: string;
  }
): NonInteractiveSpec {
  const interactive = buildInteractiveSpec(input);
  switch (input.harness) {
    case 'claude': {
      const args = [...interactive.args, '--print', '--output-format', 'text'];
      if (input.name) args.push('--name', input.name);
      args.push(input.task);
      return {
        bin: interactive.bin,
        args,
        configFiles: interactive.configFiles,
        warnings: interactive.warnings
      };
    }
    case 'codex': {
      const prompt = interactive.initialPrompt
        ? `${interactive.initialPrompt}\n\nUser task:\n${input.task}`
        : input.task;
      return {
        bin: interactive.bin,
        args: ['exec', ...interactive.args, '--skip-git-repo-check', prompt],
        configFiles: interactive.configFiles,
        warnings: interactive.warnings
      };
    }
    case 'opencode': {
      const args = ['run', ...interactive.args, '--model', input.model, '--format', 'default'];
      if (input.workingDirectory) args.push('--dir', input.workingDirectory);
      if (input.name) args.push('--title', input.name);
      args.push(input.task);
      return {
        bin: interactive.bin,
        args,
        configFiles: interactive.configFiles,
        warnings: interactive.warnings
      };
    }
    default: {
      const _exhaustive: never = input.harness;
      throw new Error(`Unhandled harness: ${String(_exhaustive)}`);
    }
  }
}

function withInputs(task: string, inputs: PersonaSendOptions['inputs']): string {
  if (!inputs || Object.keys(inputs).length === 0) return task;
  return `${task}\n\nRun inputs:\n${JSON.stringify(inputs, null, 2)}`;
}

function assertSafeRelativePath(path: string): void {
  if (!path) throw new Error('config file path must be non-empty');
  if (isAbsolute(path)) throw new Error(`config file path must be relative: ${path}`);
  const normalized = normalize(path);
  if (normalized === '..' || normalized.startsWith(`..${sep}`)) {
    throw new Error(`config file path must not escape the working directory: ${path}`);
  }
}

function materializeConfigFiles(
  cwd: string,
  files: readonly { path: string; contents: string }[]
): ConfigWrite[] {
  const writes: ConfigWrite[] = [];
  for (const file of files) {
    assertSafeRelativePath(file.path);
    const target = join(cwd, file.path);
    const existed = existsSync(target);
    const previous = existed ? readFileSync(target, 'utf8') : undefined;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.contents, 'utf8');
    writes.push({ path: target, existed, previous });
  }
  return writes;
}

function restoreConfigFiles(writes: readonly ConfigWrite[]): void {
  for (const write of [...writes].reverse()) {
    if (write.existed) {
      writeFileSync(write.path, write.previous ?? '', 'utf8');
    } else {
      rmSync(write.path, { force: true });
    }
  }
}

async function spawnCapture(
  bin: string | undefined,
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    timeoutSeconds?: number;
    onProgress?: PersonaSendOptions['onProgress'];
  }
): Promise<SpawnCaptureResult> {
  if (!bin) {
    return { stdout: '', stderr: 'missing command\n', exitCode: 127, status: 'failed' };
  }
  if (options.signal?.aborted) {
    return { stdout: '', stderr: abortReason(options.signal), exitCode: null, status: 'cancelled' };
  }

  return await new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let forceKillTimeout: NodeJS.Timeout | undefined;
    const child = spawn(bin, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const timeout =
      options.timeoutSeconds && options.timeoutSeconds > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
            forceKillTimeout = setTimeout(() => {
              if (!settled) child.kill('SIGKILL');
            }, FORCE_KILL_GRACE_MS);
          }, options.timeoutSeconds * 1000)
        : undefined;
    const abort = () => {
      cancelled = true;
      child.kill('SIGTERM');
    };
    options.signal?.addEventListener('abort', abort, { once: true });

    const finish = (exitCode: number | null, status?: PersonaExecutionResult['status']) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (forceKillTimeout) clearTimeout(forceKillTimeout);
      options.signal?.removeEventListener('abort', abort);
      resolve({
        stdout,
        stderr,
        exitCode,
        status: status ?? (timedOut ? 'timeout' : cancelled ? 'cancelled' : 'completed')
      });
    };

    child.stdout.on('data', (buf: Buffer) => {
      const text = buf.toString();
      stdout += text;
      options.onProgress?.({ stream: 'stdout', text });
    });
    child.stderr.on('data', (buf: Buffer) => {
      const text = buf.toString();
      stderr += text;
      options.onProgress?.({ stream: 'stderr', text });
    });
    child.on('exit', (code) => finish(code));
    child.on('error', (err: NodeJS.ErrnoException) => {
      stderr += err.message;
      finish(err.code === 'ENOENT' ? 127 : 1, 'failed');
    });
  });
}

function abortReason(signal: AbortSignal, fallback = 'cancelled'): string {
  return signal.reason instanceof Error
    ? signal.reason.message
    : typeof signal.reason === 'string'
      ? signal.reason
      : fallback;
}

function anySignal(signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const active = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0];
  const controller = new AbortController();
  for (const signal of active) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}
