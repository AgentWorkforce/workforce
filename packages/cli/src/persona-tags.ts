import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { Harness, PersonaSelection } from '@agentworkforce/workload-router';
import * as relayburnSdk from '@relayburn/sdk';

export const PERSONA_TAGGING_INTERVAL_MS = 1_000;
export const PERSONA_TAGS_OPT_OUT_ENV = 'AGENTWORKFORCE_PERSONA_TAGS';
const PERSONA_TAG_BACKEND_CALL_TIMEOUT_MS = 5_000;

export type PersonaTagIngestHarness = 'claude-code' | 'codex' | 'opencode';
export type PersonaTagPendingStampHarness = Harness;

export interface PersonaTagPendingStampOptions {
  harness: PersonaTagPendingStampHarness;
  cwd: string;
  enrichment: Record<string, string>;
  sessionDirHint?: string;
  spawnStartTs?: string;
  spawnerPid?: number;
}

export interface PersonaTagIngestOptions {
  harness: PersonaTagIngestHarness;
}

export interface PersonaTagBackendLike {
  writePendingStamp?: (opts: PersonaTagPendingStampOptions) => unknown | Promise<unknown>;
  ingest?: (opts?: PersonaTagIngestOptions) => unknown | Promise<unknown>;
}

export interface PersonaTaggingStartOptions {
  selection: Pick<PersonaSelection, 'personaId' | 'tier' | 'runtime'>;
  personaSpec: unknown;
  personaSource: string;
  cwd: string;
  noPersonaTags?: boolean;
  env?: NodeJS.ProcessEnv;
  sdk?: PersonaTagBackendLike | (() => Promise<PersonaTagBackendLike>);
  intervalMs?: number;
  now?: () => Date;
  onWarn?: (message: string) => void;
}

export interface PersonaTaggingRun {
  readonly enabled: boolean;
  readonly tags: Record<string, string>;
  stop(): Promise<void>;
}

const NOOP_RUN: PersonaTaggingRun = Object.freeze({
  enabled: false,
  tags: Object.freeze({}) as Record<string, string>,
  async stop() {
    /* no-op */
  }
});

export function shouldRecordPersonaTags(input: {
  noPersonaTags?: boolean;
  env?: NodeJS.ProcessEnv;
}): boolean {
  if (input.noPersonaTags === true) return false;
  const env = input.env ?? process.env;
  return env[PERSONA_TAGS_OPT_OUT_ENV] !== '0';
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

export function buildPersonaTagEnrichment(input: {
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

export function personaTagIngestHarness(harness: Harness): PersonaTagIngestHarness {
  return harness === 'claude' ? 'claude-code' : harness;
}

export function personaTagSessionDirHint(harness: Harness): string | undefined {
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

export async function startPersonaTagging(
  options: PersonaTaggingStartOptions
): Promise<PersonaTaggingRun> {
  if (!shouldRecordPersonaTags(options)) return NOOP_RUN;

  const tags = buildPersonaTagEnrichment({
    selection: options.selection,
    personaSpec: options.personaSpec,
    personaSource: options.personaSource
  });
  const warn = makeOnceWarn(options.onWarn ?? ((msg) => process.stderr.write(`warning: ${msg}\n`)));

  let sdk: PersonaTagBackendLike;
  try {
    sdk = await resolvePersonaTagBackend(options.sdk);
  } catch (err) {
    warn(`persona tag recording unavailable: ${errorMessage(err)}`);
    return disabledRun(tags);
  }

  if (typeof sdk.writePendingStamp !== 'function') {
    warn(
      'persona tag recording unavailable: installed tag backend does not support launcher tagging yet.'
    );
    return disabledRun(tags);
  }
  if (typeof sdk.ingest !== 'function') {
    warn('persona tag recording unavailable: installed tag backend does not support ingest.');
    return disabledRun(tags);
  }
  const writePendingStamp = sdk.writePendingStamp.bind(sdk);
  const ingest = sdk.ingest.bind(sdk);

  try {
    await withTimeout(
      writePendingStamp({
        harness: options.selection.runtime.harness,
        cwd: options.cwd,
        enrichment: tags,
        sessionDirHint: personaTagSessionDirHint(options.selection.runtime.harness),
        spawnStartTs: (options.now?.() ?? new Date()).toISOString(),
        spawnerPid: process.pid
      }),
      PERSONA_TAG_BACKEND_CALL_TIMEOUT_MS,
      'writePendingStamp'
    );
  } catch (err) {
    warn(`persona tag stamp failed: ${errorMessage(err)}`);
    return disabledRun(tags);
  }

  let stopped = false;
  let inFlight: Promise<void> | undefined;
  let ingestWarned = false;
  const runIngest = async () => {
    try {
      await withTimeout(
        ingest({ harness: personaTagIngestHarness(options.selection.runtime.harness) }),
        PERSONA_TAG_BACKEND_CALL_TIMEOUT_MS,
        'ingest'
      );
    } catch (err) {
      if (!ingestWarned) {
        ingestWarned = true;
        warn(`persona tag ingest failed: ${errorMessage(err)}`);
      }
    }
  };
  const tick = () => {
    if (stopped || inFlight) return;
    inFlight = runIngest().finally(() => {
      inFlight = undefined;
    });
  };
  const interval = setInterval(tick, options.intervalMs ?? PERSONA_TAGGING_INTERVAL_MS);
  interval.unref?.();

  return {
    enabled: true,
    tags,
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
      if (inFlight) await inFlight;
      await runIngest();
    }
  };
}

async function resolvePersonaTagBackend(
  sdk: PersonaTaggingStartOptions['sdk']
): Promise<PersonaTagBackendLike> {
  if (typeof sdk === 'function') return await sdk();
  if (sdk) return sdk;
  return relayburnSdk as unknown as PersonaTagBackendLike;
}

function disabledRun(tags: Record<string, string>): PersonaTaggingRun {
  return Object.freeze({
    enabled: false,
    tags,
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
