import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve as resolvePath } from 'node:path';
import type { RunnerStepExecutor, WorkflowRunRow } from '@agent-relay/sdk/workflows';
import { frontendImplementer, codeReviewer, architecturePlanner, requirementsAnalyst, debuggerPersona, securityReviewer, technicalWriter, verifierPersona, testStrategist, tddGuard, flakeHunter, opencodeWorkflowSpecialist, npmProvenancePublisher, cloudSandboxInfra } from './generated/personas.js';
import defaultRoutingProfileJson from '../routing-profiles/default.json' with { type: 'json' };

export const HARNESS_VALUES = ['opencode', 'codex', 'claude'] as const;
export const PERSONA_TIERS = ['best', 'best-value', 'minimum'] as const;
export const PERSONA_INTENTS = [
  'implement-frontend',
  'review',
  'architecture-plan',
  'requirements-analysis',
  'debugging',
  'security-review',
  'documentation',
  'verification',
  'test-strategy',
  'tdd-enforcement',
  'flake-investigation',
  'opencode-workflow-correctness',
  'npm-provenance',
  'cloud-sandbox-infra'
] as const;

export type Harness = (typeof HARNESS_VALUES)[number];
export type PersonaTier = (typeof PERSONA_TIERS)[number];
export type PersonaIntent = (typeof PERSONA_INTENTS)[number];

export interface HarnessSettings {
  reasoning: 'low' | 'medium' | 'high';
  timeoutSeconds: number;
}

export interface PersonaRuntime {
  harness: Harness;
  model: string;
  systemPrompt: string;
  harnessSettings: HarnessSettings;
}

/**
 * A skill is a named, reusable capability attached to a persona.
 * `source` points to canonical guidance the persona should apply
 * (e.g. a prpm.dev package URL, an internal runbook, a docs page).
 */
export interface PersonaSkill {
  id: string;
  source: string;
  description: string;
}

export interface PersonaSpec {
  id: string;
  intent: PersonaIntent;
  description: string;
  skills: PersonaSkill[];
  tiers: Record<PersonaTier, PersonaRuntime>;
}

export interface RoutingProfileRule {
  tier: PersonaTier;
  rationale: string;
}

export interface RoutingProfile {
  id: string;
  description: string;
  intents: Record<PersonaIntent, RoutingProfileRule>;
}

export interface PersonaSelection {
  personaId: string;
  tier: PersonaTier;
  runtime: PersonaRuntime;
  skills: PersonaSkill[];
  rationale: string;
}

// ---------------------------------------------------------------------------
// Skill materialization
// ---------------------------------------------------------------------------
//
// Personas declare *what* skill they need via `skills: [{ id, source, ... }]`.
// The SDK is the only layer that knows *how* to make that skill available to
// a given harness — because each harness has its own on-disk convention and
// its own prpm install flag. Keeping this mapping here means:
//
//   1. Workflow authors never hand-type `prpm install ... --as codex`.
//   2. Changing install rules is a one-line SDK edit, not a repo-wide grep.
//   3. Persona JSON stays harness-agnostic and forward-compatible.
//
// `materializeSkills` is a pure function: it returns the install plan but
// never touches the filesystem or spawns processes. Callers (relay workflows,
// the OpenClaw spawner, ad-hoc scripts) decide how to execute it.

export const SKILL_SOURCE_KINDS = ['prpm'] as const;
export type SkillSourceKind = (typeof SKILL_SOURCE_KINDS)[number];

/** Per-harness rules for where skills land on disk and how to ask prpm for them. */
export interface HarnessSkillTarget {
  /** Value passed to `prpm install --as <flag>`. */
  asFlag: string;
  /** Directory (relative to repo root) where prpm drops the skill package. */
  dir: string;
}

export const HARNESS_SKILL_TARGETS: Record<Harness, HarnessSkillTarget> = {
  claude: { asFlag: 'claude', dir: '.claude/skills' },
  codex: { asFlag: 'codex', dir: '.agents/skills' },
  opencode: { asFlag: 'opencode', dir: '.skills' }
};

export interface SkillInstall {
  skillId: string;
  /** Original `source` string from the persona JSON. */
  source: string;
  sourceKind: SkillSourceKind;
  /** Normalized package reference used by prpm (e.g. `prpm/npm-trusted-publishing`). */
  packageRef: string;
  harness: Harness;
  /** argv-style command — safer than a shell string for execFile/spawn callers. */
  installCommand: readonly string[];
  /** Directory the skill is expected to land in after install. */
  installedDir: string;
  /** Path to the installed SKILL.md manifest (for prompt injection fallback). */
  installedManifest: string;
}

export interface SkillMaterializationPlan {
  harness: Harness;
  installs: SkillInstall[];
}

export interface ExecuteOptions {
  /** Absolute or repo-relative path the spawned agent should treat as its CWD. */
  workingDirectory?: string;
  /** Optional step name override for the ad-hoc workflow run. */
  name?: string;
  /** Hard timeout for the install + agent run in seconds. */
  timeoutSeconds?: number;
  /** Optional structured context appended to the task body as JSON. */
  inputs?: Record<string, string | number | boolean>;
  /** Install persona skills before execution. Defaults to true. */
  installSkills?: boolean;
  /** Additional environment variables available to install + agent processes. */
  env?: NodeJS.ProcessEnv;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
  /** Streaming stdout/stderr callback from install + agent subprocesses. */
  onProgress?: (chunk: { stream: 'stdout' | 'stderr'; text: string }) => void;
}

export interface ExecuteResult {
  status: 'completed' | 'failed' | 'cancelled' | 'timeout';
  output: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  workflowRunId?: string;
  stepName: string;
}

export interface PersonaExecution extends Promise<ExecuteResult> {
  cancel(reason?: string): void;
  readonly runId: Promise<string>;
}

export interface PersonaContext {
  readonly selection: PersonaSelection;
  readonly installPlan: SkillMaterializationPlan;
  readonly installCommand: readonly string[];
  readonly installCommandString: string;
  execute(task: string, options?: ExecuteOptions): PersonaExecution;
}

export class PersonaExecutionError extends Error {
  readonly result: ExecuteResult;
  override cause?: unknown;

  constructor(message: string, result: ExecuteResult, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'PersonaExecutionError';
    this.result = result;
    this.cause = cause;
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
  settled: boolean;
}

interface CommandCapture {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
}

class CapturedCommandError extends Error {
  readonly capture: CommandCapture;

  constructor(message: string, capture: CommandCapture) {
    super(message);
    this.name = 'CapturedCommandError';
    this.capture = capture;
  }
}

const PRPM_URL_RE =
  /^https?:\/\/prpm\.dev\/packages\/([^/\s?#]+)\/([^/\s?#]+)\/?(?:[?#].*)?$/i;
const PRPM_BARE_REF_RE = /^([^/\s]+)\/([^/\s]+)$/;

interface ResolvedSkillSource {
  kind: SkillSourceKind;
  packageRef: string;
}

function resolveSkillSource(source: string): ResolvedSkillSource {
  const urlMatch = source.match(PRPM_URL_RE);
  if (urlMatch) {
    return { kind: 'prpm', packageRef: `${urlMatch[1]}/${urlMatch[2]}` };
  }
  const bareMatch = source.match(PRPM_BARE_REF_RE);
  if (bareMatch) {
    return { kind: 'prpm', packageRef: source };
  }
  throw new Error(
    `Unsupported skill source: ${source}. ` +
      `Supported forms: prpm.dev package URL (https://prpm.dev/packages/<scope>/<name>) ` +
      `or a bare "<scope>/<name>" reference.`
  );
}

function deriveInstalledName(packageRef: string): string {
  const slash = packageRef.lastIndexOf('/');
  return slash >= 0 ? packageRef.slice(slash + 1) : packageRef;
}

/**
 * Given a set of persona skills and the harness the persona will run under,
 * produce the concrete install plan: which `prpm install` invocations to run
 * and where the skill will land on disk once installed.
 *
 * Pure function — does not execute commands or touch the filesystem.
 */
export function materializeSkills(
  skills: readonly PersonaSkill[],
  harness: Harness
): SkillMaterializationPlan {
  const target = HARNESS_SKILL_TARGETS[harness];
  if (!target) {
    throw new Error(`No skill install target configured for harness: ${harness}`);
  }

  const installs = skills.map((skill): SkillInstall => {
    const { kind, packageRef } = resolveSkillSource(skill.source);
    const installedName = deriveInstalledName(packageRef);
    const installedDir = `${target.dir}/${installedName}`;
    return {
      skillId: skill.id,
      source: skill.source,
      sourceKind: kind,
      packageRef,
      harness,
      installCommand: Object.freeze([
        'npx',
        '-y',
        'prpm',
        'install',
        packageRef,
        '--as',
        target.asFlag
      ]) as readonly string[],
      installedDir,
      installedManifest: `${installedDir}/SKILL.md`
    };
  });

  return { harness, installs };
}

/**
 * Convenience wrapper: derive the install plan directly from a resolved
 * persona selection, using its tier's harness automatically.
 */
export function materializeSkillsFor(selection: PersonaSelection): SkillMaterializationPlan {
  return materializeSkills(selection.skills, selection.runtime.harness);
}

function shellEscape(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function commandToShellString(command: readonly string[]): string {
  return command.map(shellEscape).join(' ');
}

function buildInstallArtifacts(plan: SkillMaterializationPlan): {
  installCommand: readonly string[];
  installCommandString: string;
} {
  const installCommandString =
    plan.installs.length === 0
      ? ':'
      : plan.installs.map((install) => commandToShellString(install.installCommand)).join(' && ');

  return {
    installCommand: Object.freeze(['sh', '-c', installCommandString]) as readonly string[],
    installCommandString
  };
}

function buildExecutionTask(
  systemPrompt: string,
  task: string,
  inputs?: Record<string, string | number | boolean>
): string {
  const sections = [`System Instructions:\n${systemPrompt.trim()}`, `Task:\n${task.trim()}`];
  if (inputs && Object.keys(inputs).length > 0) {
    sections.push(`Additional Inputs (JSON):\n${JSON.stringify(inputs, null, 2)}`);
  }
  return sections.join('\n\n');
}

function hash8(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8);
}

function sanitizeExecutionName(value: string): string {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return sanitized || `persona-${hash8(value)}`;
}

function createDeferred<T>(): Deferred<T> {
  let settled = false;
  let resolveFn!: Deferred<T>['resolve'];
  let rejectFn!: Deferred<T>['reject'];
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = (value) => {
      settled = true;
      resolve(value);
    };
    rejectFn = (reason) => {
      settled = true;
      reject(reason);
    };
  });
  return {
    promise,
    resolve: resolveFn,
    reject: rejectFn,
    get settled() {
      return settled;
    }
  };
}

function createAbortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function isTimeoutError(message: string | undefined): boolean {
  return typeof message === 'string' && /timed out/i.test(message);
}

function deepFreeze<T>(value: T): T {
  if (value === null || value === undefined || typeof value !== 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      deepFreeze(entry);
    }
    return Object.freeze(value) as T;
  }

  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return Object.freeze(value) as T;
}

function linkAbortSignal(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (!signal) {
    return () => {};
  }

  if (signal.aborted) {
    controller.abort(signal.reason);
    return () => {};
  }

  const onAbort = () => controller.abort(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener('abort', onAbort);
}

async function runCapturedCommand(options: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  onSpawn?: () => void;
  onProgress?: (chunk: { stream: 'stdout' | 'stderr'; text: string }) => void;
}): Promise<CommandCapture> {
  const { command, args, cwd, env, timeoutMs, signal, onSpawn, onProgress } = options;
  return new Promise<CommandCapture>((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError('Execution aborted before the process started'));
      return;
    }

    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let timeoutId: NodeJS.Timeout | undefined;
    let killId: NodeJS.Timeout | undefined;
    let abortDelayId: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (killId) {
        clearTimeout(killId);
      }
      if (abortDelayId) {
        clearTimeout(abortDelayId);
      }
      if (signal && abortHandler) {
        signal.removeEventListener('abort', abortHandler);
      }
    };

    const terminate = () => {
      child.kill('SIGTERM');
      killId = setTimeout(() => child.kill('SIGKILL'), 5_000);
      killId.unref?.();
    };

    const abortHandler = () => {
      if (stdout.length === 0 && stderr.length === 0) {
        abortDelayId = setTimeout(() => {
          abortDelayId = undefined;
          terminate();
        }, 15);
        abortDelayId.unref?.();
        return;
      }

      terminate();
    };

    if (signal) {
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    if (timeoutMs !== undefined) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        killId = setTimeout(() => child.kill('SIGKILL'), 5_000);
        killId.unref?.();
      }, timeoutMs);
      timeoutId.unref?.();
    }

    child.stdout?.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      onProgress?.({ stream: 'stdout', text });
    });

    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      onProgress?.({ stream: 'stderr', text });
    });

    onSpawn?.();

    child.once('error', (error) => {
      cleanup();
      reject(error);
    });

    child.once('close', (code, exitSignal) => {
      cleanup();
      const capture: CommandCapture = {
        stdout,
        stderr,
        exitCode: code,
        exitSignal: (exitSignal as NodeJS.Signals | null) ?? null
      };

      if (signal?.aborted) {
        const error = createAbortError('Execution cancelled');
        Object.assign(error, { capture });
        reject(error);
        return;
      }

      if (timedOut) {
        reject(
          new CapturedCommandError(
            `Command timed out after ${timeoutMs ?? 'unknown'}ms`,
            capture
          )
        );
        return;
      }

      resolve(capture);
    });
  });
}

function createLocalExecutor(
  stepCaptures: Map<string, CommandCapture>,
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    onStepSpawn?: (stepName: string) => void;
    onStepProgress?: (
      stepName: string,
      chunk: { stream: 'stdout' | 'stderr'; text: string }
    ) => void;
    onProgress?: (chunk: { stream: 'stdout' | 'stderr'; text: string }) => void;
  },
  buildCommand: (cli: Harness, extraArgs: string[] | undefined, task: string) => string[]
): RunnerStepExecutor {
  const execute = async (
    stepName: string,
    command: string,
    args: string[],
    cwd: string,
    timeoutMs?: number,
    ignoreExitCode = false
  ): Promise<CommandCapture> => {
    const partialCapture: CommandCapture = {
      stdout: '',
      stderr: '',
      exitCode: null,
      exitSignal: null
    };

    try {
      const capture = await runCapturedCommand({
        command,
        args,
        cwd,
        env: options.env,
        timeoutMs,
        signal: options.signal,
        onSpawn: () => {
          stepCaptures.set(stepName, { ...partialCapture });
          options.onStepSpawn?.(stepName);
        },
        onProgress: (chunk) => {
          if (chunk.stream === 'stdout') {
            partialCapture.stdout += chunk.text;
          } else {
            partialCapture.stderr += chunk.text;
          }
          stepCaptures.set(stepName, { ...partialCapture });
          options.onStepProgress?.(stepName, chunk);
          options.onProgress?.(chunk);
        }
      });
      stepCaptures.set(stepName, capture);
      if (!ignoreExitCode && capture.exitCode !== null && capture.exitCode !== 0) {
        throw new CapturedCommandError(
          `Step "${stepName}" exited with code ${capture.exitCode}`,
          capture
        );
      }
      return capture;
    } catch (error) {
      const capture = error instanceof CapturedCommandError ? error.capture : (error as { capture?: CommandCapture }).capture;
      if (capture) {
        stepCaptures.set(stepName, capture);
      }
      throw error;
    }
  };

  return {
    async executeAgentStep(step, agentDef, resolvedTask, timeoutMs) {
      const extraArgs = agentDef.constraints?.model ? ['--model', agentDef.constraints.model] : undefined;
      const [command, ...args] = buildCommand(agentDef.cli as Harness, extraArgs, resolvedTask);
      const capture = await execute(
        step.name,
        command,
        args,
        resolvePath(step.cwd ?? options.cwd),
        timeoutMs,
        agentDef.cli === 'opencode'
      );
      return capture.stdout;
    },
    async executeDeterministicStep(step, resolvedCommand, cwd) {
      const capture = await execute(
        step.name,
        'sh',
        ['-c', resolvedCommand],
        resolvePath(cwd),
        step.timeoutMs
      );
      return {
        output: capture.stdout,
        exitCode: capture.exitCode ?? 0
      };
    }
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isHarness(value: unknown): value is Harness {
  return typeof value === 'string' && HARNESS_VALUES.includes(value as Harness);
}

function isTier(value: unknown): value is PersonaTier {
  return typeof value === 'string' && PERSONA_TIERS.includes(value as PersonaTier);
}

function isIntent(value: unknown): value is PersonaIntent {
  return typeof value === 'string' && PERSONA_INTENTS.includes(value as PersonaIntent);
}

function parseRuntime(value: unknown, context: string): PersonaRuntime {
  if (!isObject(value)) {
    throw new Error(`${context} must be an object`);
  }

  const { harness, model, systemPrompt, harnessSettings } = value;

  if (!isHarness(harness)) {
    throw new Error(`${context}.harness must be one of: ${HARNESS_VALUES.join(', ')}`);
  }
  if (typeof model !== 'string' || !model.trim()) {
    throw new Error(`${context}.model must be a non-empty string`);
  }
  if (typeof systemPrompt !== 'string' || !systemPrompt.trim()) {
    throw new Error(`${context}.systemPrompt must be a non-empty string`);
  }
  if (!isObject(harnessSettings)) {
    throw new Error(`${context}.harnessSettings must be an object`);
  }

  const { reasoning, timeoutSeconds } = harnessSettings;
  if (!['low', 'medium', 'high'].includes(String(reasoning))) {
    throw new Error(`${context}.harnessSettings.reasoning must be low|medium|high`);
  }
  if (typeof timeoutSeconds !== 'number' || !Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error(`${context}.harnessSettings.timeoutSeconds must be a positive number`);
  }

  return {
    harness,
    model,
    systemPrompt,
    harnessSettings: {
      reasoning: reasoning as HarnessSettings['reasoning'],
      timeoutSeconds
    }
  };
}

function parseSkills(value: unknown, context: string): PersonaSkill[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${context} must be an array if provided`);
  }

  return value.map((entry, idx) => {
    const entryContext = `${context}[${idx}]`;
    if (!isObject(entry)) {
      throw new Error(`${entryContext} must be an object`);
    }
    const { id, source, description } = entry;
    if (typeof id !== 'string' || !id.trim()) {
      throw new Error(`${entryContext}.id must be a non-empty string`);
    }
    if (typeof source !== 'string' || !source.trim()) {
      throw new Error(`${entryContext}.source must be a non-empty string`);
    }
    if (typeof description !== 'string' || !description.trim()) {
      throw new Error(`${entryContext}.description must be a non-empty string`);
    }
    return { id, source, description };
  });
}

function parsePersonaSpec(value: unknown, expectedIntent: PersonaIntent): PersonaSpec {
  if (!isObject(value)) {
    throw new Error(`persona[${expectedIntent}] must be an object`);
  }

  const { id, intent, description, tiers, skills } = value;

  if (typeof id !== 'string' || !id.trim()) {
    throw new Error(`persona[${expectedIntent}].id must be a non-empty string`);
  }
  if (!isIntent(intent)) {
    throw new Error(`persona[${expectedIntent}].intent is invalid`);
  }
  if (intent !== expectedIntent) {
    throw new Error(`persona[${expectedIntent}] intent mismatch: got ${intent}`);
  }
  if (typeof description !== 'string' || !description.trim()) {
    throw new Error(`persona[${expectedIntent}].description must be a non-empty string`);
  }
  if (!isObject(tiers)) {
    throw new Error(`persona[${expectedIntent}].tiers must be an object`);
  }

  const parsedTiers = {} as Record<PersonaTier, PersonaRuntime>;
  for (const tier of PERSONA_TIERS) {
    parsedTiers[tier] = parseRuntime(tiers[tier], `persona[${expectedIntent}].tiers.${tier}`);
  }

  const parsedSkills = parseSkills(skills, `persona[${expectedIntent}].skills`);

  return {
    id,
    intent,
    description,
    skills: parsedSkills,
    tiers: parsedTiers
  };
}

function parseRoutingProfile(value: unknown, context: string): RoutingProfile {
  if (!isObject(value)) {
    throw new Error(`${context} must be an object`);
  }

  const { id, description, intents } = value;
  if (typeof id !== 'string' || !id.trim()) {
    throw new Error(`${context}.id must be a non-empty string`);
  }
  if (typeof description !== 'string' || !description.trim()) {
    throw new Error(`${context}.description must be a non-empty string`);
  }
  if (!isObject(intents)) {
    throw new Error(`${context}.intents must be an object`);
  }

  const parsedIntents = {} as Record<PersonaIntent, RoutingProfileRule>;
  for (const intent of PERSONA_INTENTS) {
    const rule = intents[intent];
    if (!isObject(rule)) {
      throw new Error(`${context}.intents.${intent} must be an object`);
    }
    const { tier, rationale } = rule;
    if (!isTier(tier)) {
      throw new Error(`${context}.intents.${intent}.tier must be one of: ${PERSONA_TIERS.join(', ')}`);
    }
    if (typeof rationale !== 'string' || !rationale.trim()) {
      throw new Error(`${context}.intents.${intent}.rationale must be a non-empty string`);
    }
    parsedIntents[intent] = { tier, rationale };
  }

  return {
    id,
    description,
    intents: parsedIntents
  };
}

export const personaCatalog: Record<PersonaIntent, PersonaSpec> = {
  'implement-frontend': parsePersonaSpec(frontendImplementer, 'implement-frontend'),
  review: parsePersonaSpec(codeReviewer, 'review'),
  'architecture-plan': parsePersonaSpec(architecturePlanner, 'architecture-plan'),
  'requirements-analysis': parsePersonaSpec(requirementsAnalyst, 'requirements-analysis'),
  debugging: parsePersonaSpec(debuggerPersona, 'debugging'),
  'security-review': parsePersonaSpec(securityReviewer, 'security-review'),
  documentation: parsePersonaSpec(technicalWriter, 'documentation'),
  verification: parsePersonaSpec(verifierPersona, 'verification'),
  'test-strategy': parsePersonaSpec(testStrategist, 'test-strategy'),
  'tdd-enforcement': parsePersonaSpec(tddGuard, 'tdd-enforcement'),
  'flake-investigation': parsePersonaSpec(flakeHunter, 'flake-investigation'),
  'opencode-workflow-correctness': parsePersonaSpec(
    opencodeWorkflowSpecialist,
    'opencode-workflow-correctness'
  ),
  'npm-provenance': parsePersonaSpec(npmProvenancePublisher, 'npm-provenance'),
  'cloud-sandbox-infra': parsePersonaSpec(cloudSandboxInfra, 'cloud-sandbox-infra')
};

export const routingProfiles = {
  default: parseRoutingProfile(defaultRoutingProfileJson, 'routingProfiles.default')
} as const;

export type RoutingProfileId = keyof typeof routingProfiles;

export function resolvePersona(intent: PersonaIntent, profile: RoutingProfile | RoutingProfileId = 'default'): PersonaSelection {
  const profileSpec = typeof profile === 'string' ? routingProfiles[profile] : profile;
  const rule = profileSpec.intents[intent];
  const spec = personaCatalog[intent];

  return {
    personaId: spec.id,
    tier: rule.tier,
    runtime: spec.tiers[rule.tier],
    skills: spec.skills,
    rationale: `${profileSpec.id}: ${rule.rationale}`
  };
}

/**
 * Backward-compatible helper for callers that already selected a tier directly.
 * Prefer resolvePersona(intent, profile) for policy-driven selection.
 */
export function resolvePersonaByTier(intent: PersonaIntent, tier: PersonaTier = 'best-value'): PersonaSelection {
  const spec = personaCatalog[intent];
  return {
    personaId: spec.id,
    tier,
    runtime: spec.tiers[tier],
    skills: spec.skills,
    rationale: `legacy-tier-override: ${tier}`
  };
}

export function usePersona(
  intent: PersonaIntent,
  options: {
    harness?: Harness;
    tier?: PersonaTier;
    profile?: RoutingProfile | RoutingProfileId;
  } = {}
): PersonaContext {
  const baseSelection = options.tier
    ? resolvePersonaByTier(intent, options.tier)
    : resolvePersona(intent, options.profile ?? 'default');

  const effectiveHarness = options.harness ?? baseSelection.runtime.harness;
  const selection =
    effectiveHarness === baseSelection.runtime.harness
      ? baseSelection
      : {
          ...baseSelection,
          runtime: {
            ...baseSelection.runtime,
            harness: effectiveHarness
          }
        };

  const installPlan =
    effectiveHarness === baseSelection.runtime.harness
      ? materializeSkillsFor(selection)
      : materializeSkills(selection.skills, effectiveHarness);

  const { installCommand, installCommandString } = buildInstallArtifacts(installPlan);
  const frozenSelection = deepFreeze(selection);
  const frozenInstallPlan = deepFreeze(installPlan);

  const execute = (task: string, executeOptions: ExecuteOptions = {}): PersonaExecution => {
    const runId = createDeferred<string>();
    const abortController = new AbortController();
    const unlinkAbort = linkAbortSignal(executeOptions.signal, abortController);
    const stepName = sanitizeExecutionName(
      executeOptions.name ?? `${frozenSelection.personaId}-${hash8(task)}`
    );
    const workflowName = `use-persona-${stepName}`;
    const installStepName = `${stepName}-install-skills`;
    const workingDirectory = resolvePath(executeOptions.workingDirectory ?? process.cwd());
    const timeoutMs = Math.max(
      1,
      Math.round(
        (executeOptions.timeoutSeconds ?? frozenSelection.runtime.harnessSettings.timeoutSeconds) * 1000
      )
    );
    const shouldInstallSkills =
      executeOptions.installSkills !== false && frozenInstallPlan.installs.length > 0;
    const stepCaptures = new Map<string, CommandCapture>();
    let cancelReason: string | undefined;
    let workflowRunId: string | undefined;
    let runIdReadyTimer: NodeJS.Timeout | undefined;

    const resolveRunId = (value = workflowRunId) => {
      if (runIdReadyTimer) {
        clearTimeout(runIdReadyTimer);
        runIdReadyTimer = undefined;
      }
      if (value && !runId.settled) {
        runId.resolve(value);
      }
    };

    const resultPromise = (async (): Promise<ExecuteResult> => {
      try {
        const { InMemoryWorkflowDb, WorkflowRunner, buildCommand, workflow } = await import(
          '@agent-relay/sdk/workflows'
        );
        const executor = createLocalExecutor(
          stepCaptures,
          {
            cwd: workingDirectory,
            env: { ...process.env, ...executeOptions.env },
            signal: abortController.signal,
            onStepSpawn: (startedStepName) => {
              if (startedStepName !== stepName || runId.settled || runIdReadyTimer) {
                return;
              }

              runIdReadyTimer = setTimeout(() => resolveRunId(), 250);
              runIdReadyTimer.unref?.();
            },
            onStepProgress: (progressStepName) => {
              if (progressStepName === stepName) {
                resolveRunId();
              }
            },
            onProgress: executeOptions.onProgress
          },
          buildCommand
        );
        const runner = new WorkflowRunner({
          cwd: workingDirectory,
          db: new InMemoryWorkflowDb(),
          executor
        });

        runner.on((event) => {
          if (event.type === 'run:started') {
            workflowRunId = event.runId;
          }

          if (
            (event.type === 'step:completed' || event.type === 'step:failed') &&
            event.stepName === stepName
          ) {
            resolveRunId(event.runId);
          }
        });

        const agentName = `${stepName}-agent`;
        const builder = workflow(workflowName)
          .description(`Ad-hoc persona execution for ${frozenSelection.personaId}`)
          .pattern('dag')
          .timeout(timeoutMs)
          .trajectories(false)
          .agent(agentName, {
            cli: frozenSelection.runtime.harness,
            model: frozenSelection.runtime.model,
            role: frozenSelection.personaId,
            preset: 'worker',
            interactive: false,
            timeoutMs
          });

        if (shouldInstallSkills) {
          builder.step(installStepName, {
            type: 'deterministic',
            command: installCommandString,
            cwd: workingDirectory,
            timeoutMs,
            captureOutput: true,
            failOnError: true
          });
        }

        builder.step(stepName, {
          agent: agentName,
          task: buildExecutionTask(
            frozenSelection.runtime.systemPrompt,
            task,
            executeOptions.inputs
          ),
          cwd: workingDirectory,
          timeoutMs,
          verification: { type: 'exit_code', value: '0' },
          ...(shouldInstallSkills ? { dependsOn: [installStepName] } : {})
        });

        if (abortController.signal.aborted) {
          runner.abort();
        } else {
          abortController.signal.addEventListener('abort', () => runner.abort(), { once: true });
        }
        const run = (await runner.execute(builder.toConfig())) as WorkflowRunRow;
        if (!runId.settled) {
          runId.resolve(run.id);
        }

        const primaryCapture = stepCaptures.get(stepName);
        const fallbackCapture = shouldInstallSkills ? stepCaptures.get(installStepName) : undefined;
        const capture = primaryCapture ?? fallbackCapture;
        const result: ExecuteResult = {
          status:
            run.status === 'cancelled'
              ? 'cancelled'
              : run.status === 'failed' && isTimeoutError(run.error)
                ? 'timeout'
                : run.status === 'completed'
                  ? 'completed'
                  : 'failed',
          output: capture?.stdout ?? '',
          stderr: capture?.stderr ?? '',
          exitCode: capture?.exitCode ?? null,
          durationMs: Date.now() - (Date.parse(run.startedAt) || Date.now()),
          workflowRunId: run.id,
          stepName
        };

        if (run.status === 'completed') {
          return result;
        }

        if (run.status === 'cancelled') {
          const error = createAbortError(cancelReason ?? 'Execution cancelled');
          Object.assign(error, { result });
          throw error;
        }

        throw new PersonaExecutionError(
          run.error ?? `Persona execution failed for step "${stepName}"`,
          result
        );
      } catch (error) {
        if (!runId.settled) {
          runId.reject(error);
        }
        throw error;
      } finally {
        if (runIdReadyTimer) {
          clearTimeout(runIdReadyTimer);
        }
        unlinkAbort();
      }
    })();

    return Object.assign(resultPromise, {
      cancel(reason?: string) {
        cancelReason = reason;
        abortController.abort(reason);
      },
      runId: runId.promise
    }) as PersonaExecution;
  };

  return Object.freeze({
    selection: frozenSelection,
    installPlan: frozenInstallPlan,
    installCommand,
    installCommandString,
    execute
  });
}

export * from './eval.js';
