import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { Harness, PersonaSelection } from '@agentworkforce/workload-router';
import * as launchMetadataBackendSdk from '@relayburn/sdk';

export const LAUNCH_METADATA_INTERVAL_MS = 1_000;
export const LAUNCH_METADATA_OPT_OUT_ENV = 'AGENTWORKFORCE_LAUNCH_METADATA';
const LAUNCH_METADATA_BACKEND_CALL_TIMEOUT_MS = 5_000;

export type LaunchMetadataIngestHarness = 'claude-code' | 'codex' | 'opencode';
export type LaunchMetadataPendingStampHarness = Harness;

export interface LaunchMetadataPendingStampOptions {
  harness: LaunchMetadataPendingStampHarness;
  cwd: string;
  enrichment: Record<string, string>;
  sessionDirHint?: string;
  spawnStartTs?: string;
  spawnerPid?: number;
}

export interface LaunchMetadataIngestOptions {
  harness: LaunchMetadataIngestHarness;
}

export interface LaunchMetadataBackendLike {
  writePendingStamp?: (opts: LaunchMetadataPendingStampOptions) => unknown | Promise<unknown>;
  ingest?: (opts?: LaunchMetadataIngestOptions) => unknown | Promise<unknown>;
}

export interface LaunchMetadataStartOptions {
  selection: Pick<PersonaSelection, 'personaId' | 'tier' | 'runtime'>;
  personaSpec: unknown;
  personaSource: string;
  cwd: string;
  noLaunchMetadata?: boolean;
  env?: NodeJS.ProcessEnv;
  sdk?: LaunchMetadataBackendLike | (() => Promise<LaunchMetadataBackendLike>);
  intervalMs?: number;
  now?: () => Date;
  onWarn?: (message: string) => void;
}

export interface LaunchMetadataRun {
  readonly enabled: boolean;
  readonly metadata: Record<string, string>;
  stop(): Promise<void>;
}

const NOOP_RUN: LaunchMetadataRun = Object.freeze({
  enabled: false,
  metadata: Object.freeze({}) as Record<string, string>,
  async stop() {
    /* no-op */
  }
});

export function shouldRecordLaunchMetadata(input: {
  noLaunchMetadata?: boolean;
  env?: NodeJS.ProcessEnv;
}): boolean {
  if (input.noLaunchMetadata === true) return false;
  const env = input.env ?? process.env;
  return env[LAUNCH_METADATA_OPT_OUT_ENV] !== '0';
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function personaVersionHash(personaSpec: unknown): string {
  return createHash('sha256').update(canonicalJson(personaSpec)).digest('hex');
}

export function personaVersionShort(personaSpec: unknown): string {
  return personaVersionHash(personaSpec).slice(0, 12);
}

export function buildLaunchMetadata(input: {
  selection: Pick<PersonaSelection, 'personaId' | 'tier'>;
  personaSpec: unknown;
  personaSource: string;
}): Record<string, string> {
  return {
    agentworkforce: '1',
    persona: input.selection.personaId,
    personaTier: input.selection.tier,
    personaVersion: personaVersionHash(input.personaSpec),
    personaSource: input.personaSource
  };
}

export function launchMetadataIngestHarness(harness: Harness): LaunchMetadataIngestHarness {
  return harness === 'claude' ? 'claude-code' : harness;
}

export function launchMetadataSessionDirHint(harness: Harness): string | undefined {
  const home = homedir();
  switch (harness) {
    case 'claude':
      return join(home, '.claude', 'projects');
    case 'codex':
      return join(home, '.codex', 'sessions');
    case 'opencode':
      return join(home, '.local', 'share', 'opencode', 'storage', 'session');
    default: {
      const _exhaustive: never = harness;
      return _exhaustive;
    }
  }
}

export async function startLaunchMetadataRecording(
  options: LaunchMetadataStartOptions
): Promise<LaunchMetadataRun> {
  if (!shouldRecordLaunchMetadata(options)) return NOOP_RUN;

  const metadata = buildLaunchMetadata({
    selection: options.selection,
    personaSpec: options.personaSpec,
    personaSource: options.personaSource
  });
  const warn = makeOnceWarn(options.onWarn ?? ((msg) => process.stderr.write(`warning: ${msg}\n`)));

  let sdk: LaunchMetadataBackendLike;
  try {
    sdk = await resolveLaunchMetadataBackend(options.sdk);
  } catch (err) {
    warn(`launch metadata recording unavailable: ${errorMessage(err)}`);
    return disabledRun(metadata);
  }

  if (typeof sdk.writePendingStamp !== 'function') {
    warn(
      'launch metadata recording unavailable: installed metadata backend does not support launcher metadata yet.'
    );
    return disabledRun(metadata);
  }
  if (typeof sdk.ingest !== 'function') {
    warn('launch metadata recording unavailable: installed metadata backend does not support ingest.');
    return disabledRun(metadata);
  }
  const writePendingStamp = sdk.writePendingStamp.bind(sdk);
  const ingest = sdk.ingest.bind(sdk);

  try {
    await withTimeout(
      writePendingStamp({
        harness: options.selection.runtime.harness,
        cwd: options.cwd,
        enrichment: metadata,
        sessionDirHint: launchMetadataSessionDirHint(options.selection.runtime.harness),
        spawnStartTs: (options.now?.() ?? new Date()).toISOString(),
        spawnerPid: process.pid
      }),
      LAUNCH_METADATA_BACKEND_CALL_TIMEOUT_MS,
      'writePendingStamp'
    );
  } catch (err) {
    warn(`launch metadata stamp failed: ${errorMessage(err)}`);
    return disabledRun(metadata);
  }

  let stopped = false;
  let inFlight: Promise<void> | undefined;
  let ingestWarned = false;
  const runIngest = async () => {
    try {
      await withTimeout(
        ingest({ harness: launchMetadataIngestHarness(options.selection.runtime.harness) }),
        LAUNCH_METADATA_BACKEND_CALL_TIMEOUT_MS,
        'ingest'
      );
    } catch (err) {
      if (!ingestWarned) {
        ingestWarned = true;
        warn(`launch metadata ingest failed: ${errorMessage(err)}`);
      }
    }
  };
  const tick = () => {
    if (stopped || inFlight) return;
    inFlight = runIngest().finally(() => {
      inFlight = undefined;
    });
  };
  const interval = setInterval(tick, options.intervalMs ?? LAUNCH_METADATA_INTERVAL_MS);
  interval.unref?.();

  return {
    enabled: true,
    metadata,
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
      if (inFlight) await inFlight;
      await runIngest();
    }
  };
}

async function resolveLaunchMetadataBackend(
  sdk: LaunchMetadataStartOptions['sdk']
): Promise<LaunchMetadataBackendLike> {
  if (typeof sdk === 'function') return await sdk();
  if (sdk) return sdk;
  return launchMetadataBackendSdk as unknown as LaunchMetadataBackendLike;
}

function disabledRun(metadata: Record<string, string>): LaunchMetadataRun {
  return Object.freeze({
    enabled: false,
    metadata,
    async stop() {
      /* no-op */
    }
  });
}

function makeOnceWarn(onWarn: (message: string) => void): (message: string) => void {
  let warned = false;
  return (message: string) => {
    if (warned) return;
    warned = true;
    onWarn(message);
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function withTimeout<T>(value: T | Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve(value),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs
        );
        timeout.unref?.();
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));

  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const child = (value as Record<string, unknown>)[key];
    if (child !== undefined) out[key] = canonicalize(child);
  }
  return out;
}
