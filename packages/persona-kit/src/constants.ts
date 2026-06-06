import type { Harness, HarnessSkillTarget } from './types.js';

export const HARNESS_VALUES = ['opencode', 'codex', 'claude', 'grok', 'cursor'] as const;
/**
 * The closed persona-tag vocabulary. The cloud deploy endpoint validates
 * `tags` against exactly this set and rejects anything else with
 * `400 invalid_persona` ("tags[n] must be one of: …"). Keep this in sync with
 * the cloud; `definePersona` types `tags` against it so a bad tag is a compile
 * error instead of a deploy-time 400.
 */
export const PERSONA_TAGS = [
  'planning',
  'implementation',
  'review',
  'testing',
  'debugging',
  'documentation',
  'release',
  'discovery',
  'analytics'
] as const;

/**
 * The closed authoring vocabulary as a union (one of {@link PERSONA_TAGS}).
 * Distinct from the runtime `PersonaTag` (= `string`) in types.ts, which stays
 * open for catalog filtering/legacy data — this is the strict type
 * `definePersona` holds authors to so a bad tag is a compile error.
 */
export type KnownPersonaTag = (typeof PERSONA_TAGS)[number];
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
  'cloud-sandbox-infra',
  'sage-slack-egress-migration',
  'sage-proactive-rewire',
  'cloud-slack-proxy-guard',
  'sage-cloud-e2e-conduction',
  'capability-discovery',
  'npm-package-compat',
  'posthog',
  'persona-authoring',
  'persona-improvement',
  'agent-relay-workflow',
  'slop-audit',
  'api-contract-review',
  'local-stack-orchestration',
  'e2e-validation',
  'write-integration-tests',
  'relay-orchestrator',
  'scaffold-proactive-agent'
] as const;

export const BUILT_IN_PERSONA_INTENTS = ['persona-authoring', 'persona-improvement'] as const;

export const CODEX_SANDBOX_MODES = [
  'read-only',
  'workspace-write',
  'danger-full-access'
] as const;

export const CODEX_APPROVAL_POLICIES = [
  'untrusted',
  'on-failure',
  'on-request',
  'never'
] as const;

/**
 * Sidecar markdown delivery mode. `overwrite` writes only the persona's
 * resolved markdown into the harness's mount file. `extend` reads the
 * caller's real-cwd file (if any) and prepends it to the persona content,
 * separated by `\n\n---\n\n`. With no real-cwd file `extend` degrades to
 * `overwrite` semantics — the persona content lands alone.
 */
export const SIDECAR_MD_MODES = ['overwrite', 'extend'] as const;

export const PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan'
] as const;

export const SKILL_SOURCE_KINDS = ['prpm', 'skill.sh', 'local'] as const;

export const HARNESS_SKILL_TARGETS: Record<Harness, HarnessSkillTarget> = {
  claude: { asFlag: 'claude', dir: '.claude/skills' },
  codex: { asFlag: 'codex', dir: '.agents/skills' },
  opencode: { asFlag: 'opencode', dir: '.skills' },
  grok: { asFlag: 'grok', dir: '.grok/skills' },
  cursor: { asFlag: 'cursor', dir: '.cursor/rules' }
};
