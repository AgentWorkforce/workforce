import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { Harness, PersonaSelection } from '@agentworkforce/workload-router';

export const BURN_ATTRIBUTION_INTERVAL_MS = 1_000;
export const BURN_OPT_OUT_ENV = 'AGENTWORKFORCE_BURN';

export type BurnIngestHarness = 'claude-code' | 'codex' | 'opencode';
export type BurnPendingStampHarness = Harness;

export interface BurnPendingStampOptions {
  harness: BurnPendingStampHarness;
  cwd: string;
  enrichment: Record<string, string>;
  sessionDirHint?: string;
  spawnStartTs?: string;
  spawnerPid?: number;
}

export interface BurnIngestOptions {
  harness: BurnIngestHarness;
}

export interface BurnSdkLike {
  writePendingStamp?: (opts: BurnPendingStampOptions) => unknown | Promise<unknown>;
  ingest?: (opts?: BurnIngestOptions) => unknown | Promise<unknown>;
}

export interface BurnAttributionStartOptions {
  selection: Pick<PersonaSelection, 'personaId' | 'tier' | 'runtime'>;
  personaSpec: unknown;
  personaSource: string;
  cwd: string;
  noBurn?: boolean;
  env?: NodeJS.ProcessEnv;
  sdk?: BurnSdkLike | (() => Promise<BurnSdkLike>);
  intervalMs?: number;
  now?: () => Date;
  onWarn?: (message: string) => void;
}

export interface BurnAttributionRun {
  readonly enabled: boolean;
  readonly tags: Record<string, string>;
  stop(): Promise<void>;
}

const NOOP_RUN: BurnAttributionRun = Object.freeze({
  enabled: false,
  tags: Object.freeze({}) as Record<string, string>,
  async stop() {
    /* no-op */
  }
});

export function shouldEnableBurnAttribution(input: {
  noBurn?: boolean;
  env?: NodeJS.ProcessEnv;
}): boolean {
  if (input.noBurn === true) return false;
  return input.env?.[BURN_OPT_OUT_ENV] !== '0';
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

export function buildBurnEnrichment(input: {
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

export function burnIngestHarness(harness: Harness): BurnIngestHarness {
  return harness === 'claude' ? 'claude-code' : harness;
}

export function burnSessionDirHint(harness: Harness): string | undefined {
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

export async function startBurnAttribution(
  options: BurnAttributionStartOptions
): Promise<BurnAttributionRun> {
  if (!shouldEnableBurnAttribution(options)) return NOOP_RUN;

  const tags = buildBurnEnrichment({
    selection: options.selection,
    personaSpec: options.personaSpec,
    personaSource: options.personaSource
  });
  const warn = makeOnceWarn(options.onWarn ?? ((msg) => process.stderr.write(`warning: ${msg}\n`)));

  let sdk: BurnSdkLike;
  try {
    sdk = await resolveBurnSdk(options.sdk);
  } catch (err) {
    warn(`burn attribution unavailable: ${errorMessage(err)}`);
    return disabledRun(tags);
  }

  if (typeof sdk.writePendingStamp !== 'function') {
    warn(
      'burn attribution unavailable: @relayburn/sdk does not export writePendingStamp; upgrade to a Burn SDK release with launcher tagging primitives.'
    );
    return disabledRun(tags);
  }
  if (typeof sdk.ingest !== 'function') {
    warn('burn attribution unavailable: @relayburn/sdk does not export ingest.');
    return disabledRun(tags);
  }

  try {
    await sdk.writePendingStamp({
      harness: options.selection.runtime.harness,
      cwd: options.cwd,
      enrichment: tags,
      sessionDirHint: burnSessionDirHint(options.selection.runtime.harness),
      spawnStartTs: (options.now?.() ?? new Date()).toISOString(),
      spawnerPid: process.pid
    });
  } catch (err) {
    warn(`burn attribution stamp failed: ${errorMessage(err)}`);
    return disabledRun(tags);
  }

  let stopped = false;
  let inFlight: Promise<void> | undefined;
  let ingestWarned = false;
  const runIngest = async () => {
    try {
      await sdk.ingest?.({ harness: burnIngestHarness(options.selection.runtime.harness) });
    } catch (err) {
      if (!ingestWarned) {
        ingestWarned = true;
        warn(`burn ingest failed: ${errorMessage(err)}`);
      }
    }
  };
  const tick = () => {
    if (stopped || inFlight) return;
    inFlight = runIngest().finally(() => {
      inFlight = undefined;
    });
  };
  const interval = setInterval(tick, options.intervalMs ?? BURN_ATTRIBUTION_INTERVAL_MS);
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

async function resolveBurnSdk(
  sdk: BurnAttributionStartOptions['sdk']
): Promise<BurnSdkLike> {
  if (typeof sdk === 'function') return await sdk();
  if (sdk) return sdk;
  return (await import('@relayburn/sdk')) as unknown as BurnSdkLike;
}

function disabledRun(tags: Record<string, string>): BurnAttributionRun {
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
