import frontendImplementer from '../../../personas/frontend-implementer.json' with { type: 'json' };
import codeReviewer from '../../../personas/code-reviewer.json' with { type: 'json' };
import architecturePlanner from '../../../personas/architecture-planner.json' with { type: 'json' };
import requirementsAnalyst from '../../../personas/requirements-analyst.json' with { type: 'json' };
import debuggerPersona from '../../../personas/debugger.json' with { type: 'json' };
import securityReviewer from '../../../personas/security-reviewer.json' with { type: 'json' };
import technicalWriter from '../../../personas/technical-writer.json' with { type: 'json' };
import verifierPersona from '../../../personas/verifier.json' with { type: 'json' };
import testStrategist from '../../../personas/test-strategist.json' with { type: 'json' };
import tddGuard from '../../../personas/tdd-guard.json' with { type: 'json' };
import flakeHunter from '../../../personas/flake-hunter.json' with { type: 'json' };
import opencodeWorkflowSpecialist from '../../../personas/opencode-workflow-specialist.json' with { type: 'json' };
import npmProvenancePublisher from '../../../personas/npm-provenance-publisher.json' with { type: 'json' };
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
  'npm-provenance'
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
  opencode: { asFlag: 'opencode', dir: '.agents/skills' }
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
  'npm-provenance': parsePersonaSpec(npmProvenancePublisher, 'npm-provenance')
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

export * from './eval.js';
