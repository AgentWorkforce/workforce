import {
  CODEX_APPROVAL_POLICIES,
  CODEX_SANDBOX_MODES,
  HARNESS_VALUES,
  PERMISSION_MODES,
  PERSONA_INTENTS,
  PERSONA_TAGS,
  SIDECAR_MD_MODES
} from './constants.js';
import type {
  CodexApprovalPolicy,
  CodexSandboxMode,
  Harness,
  HarnessSettings,
  IntegrationSource,
  McpServerSpec,
  PermissionMode,
  PersonaInputSpec,
  PersonaIntegrationConfig,
  PersonaIntegrationTrigger,
  PersonaIntent,
  PersonaMemory,
  PersonaMemoryConfig,
  PersonaMemoryScope,
  PersonaMount,
  PersonaPermissions,
  PersonaSchedule,
  PersonaSelection,
  PersonaSkill,
  PersonaSpec,
  PersonaTag,
  SidecarMdMode,
  WatchEvent,
  WatchRule
} from './types.js';

/**
 * Max byte/char length for a single persona tag. Tags are denormalized
 * catalog metadata (mirroring `tags text[]` in cloud#553); they should
 * stay short enough to render in list/table UIs without truncation.
 */
const PERSONA_TAG_MAX_LEN = 64;

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isHarness(value: unknown): value is Harness {
  return typeof value === 'string' && HARNESS_VALUES.includes(value as Harness);
}

export function isIntent(value: unknown): value is PersonaIntent {
  return typeof value === 'string' && PERSONA_INTENTS.includes(value as PersonaIntent);
}

/**
 * Backwards-compat shim. Tags were briefly modeled as a closed enum (the
 * intent enum, mistakenly); they are denormalized free-form catalog
 * metadata per cloud#553's `tags text[]`. Kept exported only because
 * earlier package versions surfaced this helper — every reachable string
 * is a valid tag now.
 *
 * @deprecated Tags are free-form. Validate shape with {@link parseTags}.
 */
export function isTag(value: unknown): value is PersonaTag {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isSidecarMode(value: unknown): value is SidecarMdMode {
  return typeof value === 'string' && SIDECAR_MD_MODES.includes(value as SidecarMdMode);
}

/**
 * Parse the persona-level `tags` field. Tags are catalog metadata that the
 * cloud validates against the closed {@link PERSONA_TAGS} vocabulary — an
 * off-vocabulary tag is rejected at deploy with `400 invalid_persona`.
 * `definePersona` types `tags` against that vocabulary so typed authors get a
 * compile error first; this runtime parse stays lenient (accepts any
 * `string[]`) for forward-compatibility, but unknown tags will not deploy.
 *
 * Shape rules:
 *  - `undefined` / `null` → `undefined` (tags are optional)
 *  - `[]` → `undefined` (an empty array is the same as "no tags")
 *  - otherwise must be a `string[]`; each entry must trim to a non-empty
 *    string ≤ {@link PERSONA_TAG_MAX_LEN} chars
 *  - entries are trimmed, deduped, and sorted for stable serialization
 *
 * Returns `readonly string[]` so callers can treat the result as
 * immutable; the closed `PersonaTag` enum no longer applies.
 */
export function parseTags(
  value: unknown,
  context: string
): readonly string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`${context} must be an array of strings if provided`);
  }
  if (value.length === 0) return undefined;

  const out = new Set<string>();
  for (const [idx, entry] of value.entries()) {
    if (typeof entry !== 'string') {
      throw new Error(`${context}[${idx}] must be a string`);
    }
    const trimmed = entry.trim();
    if (!trimmed) {
      throw new Error(`${context}[${idx}] must be a non-empty string`);
    }
    if (trimmed.length > PERSONA_TAG_MAX_LEN) {
      throw new Error(
        `${context}[${idx}] must be ≤${PERSONA_TAG_MAX_LEN} characters`
      );
    }
    out.add(trimmed);
  }
  return Array.from(out).sort();
}

export function assertSidecarPath(value: unknown, context: string): void {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${context} must be a non-empty string`);
  }
  if (value.startsWith('/')) {
    throw new Error(`${context} must be a relative POSIX path; got absolute "${value}"`);
  }
  const segments = value.split(/[\\/]+/);
  if (segments.some((s) => s === '..')) {
    throw new Error(`${context} must not contain ".." segments`);
  }
  if (!value.toLowerCase().endsWith('.md')) {
    throw new Error(`${context} must end with .md`);
  }
}

export function parseHarnessSettings(value: unknown, context: string): HarnessSettings {
  if (!isObject(value)) {
    throw new Error(`${context} must be an object`);
  }

  const {
    reasoning,
    timeoutSeconds,
    sandboxMode,
    approvalPolicy,
    workspaceWriteNetworkAccess,
    webSearch,
    dangerouslyBypassApprovalsAndSandbox
  } = value;
  if (!['low', 'medium', 'high'].includes(String(reasoning))) {
    throw new Error(`${context}.reasoning must be low|medium|high`);
  }
  if (typeof timeoutSeconds !== 'number' || !Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error(`${context}.timeoutSeconds must be a positive number`);
  }

  const out: HarnessSettings = {
    reasoning: reasoning as HarnessSettings['reasoning'],
    timeoutSeconds
  };
  if (sandboxMode !== undefined) {
    if (!CODEX_SANDBOX_MODES.includes(sandboxMode as CodexSandboxMode)) {
      throw new Error(`${context}.sandboxMode must be one of: ${CODEX_SANDBOX_MODES.join(', ')}`);
    }
    out.sandboxMode = sandboxMode as CodexSandboxMode;
  }
  if (approvalPolicy !== undefined) {
    if (!CODEX_APPROVAL_POLICIES.includes(approvalPolicy as CodexApprovalPolicy)) {
      throw new Error(`${context}.approvalPolicy must be one of: ${CODEX_APPROVAL_POLICIES.join(', ')}`);
    }
    out.approvalPolicy = approvalPolicy as CodexApprovalPolicy;
  }
  if (workspaceWriteNetworkAccess !== undefined) {
    if (typeof workspaceWriteNetworkAccess !== 'boolean') {
      throw new Error(`${context}.workspaceWriteNetworkAccess must be a boolean`);
    }
    out.workspaceWriteNetworkAccess = workspaceWriteNetworkAccess;
  }
  if (webSearch !== undefined) {
    if (typeof webSearch !== 'boolean') {
      throw new Error(`${context}.webSearch must be a boolean`);
    }
    out.webSearch = webSearch;
  }
  if (dangerouslyBypassApprovalsAndSandbox !== undefined) {
    if (typeof dangerouslyBypassApprovalsAndSandbox !== 'boolean') {
      throw new Error(`${context}.dangerouslyBypassApprovalsAndSandbox must be a boolean`);
    }
    // Reject mixed-shape configs whenever the field is *present*, not only
    // when true. Co-declaring sandboxMode/approvalPolicy/workspaceWriteNetworkAccess
    // with an explicit `false` is still a contradictory shape — the two-flag
    // form and the single-flag form are mutually exclusive concepts.
    const conflicts: string[] = [];
    if (sandboxMode !== undefined) conflicts.push('sandboxMode');
    if (approvalPolicy !== undefined) conflicts.push('approvalPolicy');
    if (workspaceWriteNetworkAccess !== undefined) conflicts.push('workspaceWriteNetworkAccess');
    if (conflicts.length > 0) {
      throw new Error(
        `${context}.dangerouslyBypassApprovalsAndSandbox is mutually exclusive with: ${conflicts.join(', ')}`
      );
    }
    out.dangerouslyBypassApprovalsAndSandbox = dangerouslyBypassApprovalsAndSandbox;
  }

  return out;
}

export function parseSkills(value: unknown, context: string): PersonaSkill[] {
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

export function parseStringList(
  value: unknown,
  context: string
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`${context} must be an array if provided`);
  }
  const parsed = value.map((entry, idx) => {
    if (typeof entry !== 'string' || !entry.trim()) {
      throw new Error(`${context}[${idx}] must be a non-empty string`);
    }
    return entry;
  });
  return parsed.length > 0 ? parsed : undefined;
}

export function parseMount(
  value: unknown,
  context: string
): PersonaMount | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) {
    throw new Error(`${context} must be an object if provided`);
  }
  const ignoredPatterns = parseStringList(
    value.ignoredPatterns,
    `${context}.ignoredPatterns`
  );
  const readonlyPatterns = parseStringList(
    value.readonlyPatterns,
    `${context}.readonlyPatterns`
  );
  const enabled = value.enabled;
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    throw new Error(`${context}.enabled must be a boolean if provided`);
  }
  const hasPatterns = Boolean(ignoredPatterns || readonlyPatterns);
  const finalEnabled = typeof enabled === 'boolean'
    ? enabled
    : hasPatterns
      ? true
      : undefined;
  if (!hasPatterns && finalEnabled === undefined) {
    return undefined;
  }
  return {
    ...(finalEnabled !== undefined ? { enabled: finalEnabled } : {}),
    ...(ignoredPatterns ? { ignoredPatterns } : {}),
    ...(readonlyPatterns ? { readonlyPatterns } : {})
  };
}

export const INPUT_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

export function assertInputName(name: string, context: string): void {
  if (!INPUT_NAME_RE.test(name)) {
    throw new Error(`${context} must be an env-style name matching ${INPUT_NAME_RE.source}`);
  }
}

export function parseInputs(
  value: unknown,
  context: string
): Record<string, PersonaInputSpec> | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) {
    throw new Error(`${context} must be an object if provided`);
  }

  const out: Record<string, PersonaInputSpec> = {};
  for (const [name, raw] of Object.entries(value)) {
    assertInputName(name, `${context}.${name}`);
    if (typeof raw === 'string') {
      if (!raw) {
        throw new Error(`${context}.${name} default must be non-empty`);
      }
      out[name] = { default: raw };
      continue;
    }
    if (!isObject(raw)) {
      throw new Error(`${context}.${name} must be a string default or an object`);
    }
    const { description, env, default: defaultValue, optional, picker } = raw;
    const parsed: PersonaInputSpec = {};
    if (description !== undefined) {
      if (typeof description !== 'string' || !description.trim()) {
        throw new Error(`${context}.${name}.description must be a non-empty string if provided`);
      }
      parsed.description = description;
    }
    if (env !== undefined) {
      if (typeof env !== 'string' || !env.trim()) {
        throw new Error(`${context}.${name}.env must be a non-empty string if provided`);
      }
      assertInputName(env, `${context}.${name}.env`);
      parsed.env = env;
    }
    if (defaultValue !== undefined) {
      if (typeof defaultValue !== 'string' || !defaultValue) {
        throw new Error(`${context}.${name}.default must be a non-empty string if provided`);
      }
      parsed.default = defaultValue;
    }
    if (optional !== undefined) {
      if (typeof optional !== 'boolean') {
        throw new Error(`${context}.${name}.optional must be a boolean if provided`);
      }
      if (optional && parsed.default !== undefined) {
        throw new Error(
          `${context}.${name} cannot set both 'optional: true' and 'default' — pick one (defaults already make an input always-resolved)`
        );
      }
      parsed.optional = optional;
    }
    if (picker !== undefined) {
      if (!isObject(picker)) {
        throw new Error(`${context}.${name}.picker must be an object if provided`);
      }
      const { provider, resource } = picker;
      if (typeof provider !== 'string' || !provider.trim()) {
        throw new Error(`${context}.${name}.picker.provider must be a non-empty string`);
      }
      if (typeof resource !== 'string' || !resource.trim()) {
        throw new Error(`${context}.${name}.picker.resource must be a non-empty string`);
      }
      parsed.picker = { provider, resource };
    }
    out[name] = parsed;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

export function parsePermissions(
  value: unknown,
  context: string
): PersonaPermissions | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) {
    throw new Error(`${context} must be an object if provided`);
  }
  const out: PersonaPermissions = {};
  const { allow, deny, mode } = value;
  if (allow !== undefined) {
    if (!Array.isArray(allow) || allow.some((s) => typeof s !== 'string' || !s.trim())) {
      throw new Error(`${context}.allow must be an array of non-empty strings`);
    }
    out.allow = allow as string[];
  }
  if (deny !== undefined) {
    if (!Array.isArray(deny) || deny.some((s) => typeof s !== 'string' || !s.trim())) {
      throw new Error(`${context}.deny must be an array of non-empty strings`);
    }
    out.deny = deny as string[];
  }
  if (mode !== undefined) {
    if (!PERMISSION_MODES.includes(mode as PermissionMode)) {
      throw new Error(
        `${context}.mode must be one of: ${PERMISSION_MODES.join(', ')}`
      );
    }
    out.mode = mode as PermissionMode;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function parseStringMap(
  value: unknown,
  context: string
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) {
    throw new Error(`${context} must be an object if provided`);
  }
  const out: Record<string, string> = {};
  for (const [key, v] of Object.entries(value)) {
    if (typeof v !== 'string') {
      throw new Error(`${context}.${key} must be a string`);
    }
    out[key] = v;
  }
  return out;
}

export function parseMcpServers(
  value: unknown,
  context: string
): Record<string, McpServerSpec> | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) {
    throw new Error(`${context} must be an object if provided`);
  }
  const out: Record<string, McpServerSpec> = {};
  for (const [name, raw] of Object.entries(value)) {
    if (!isObject(raw)) {
      throw new Error(`${context}.${name} must be an object`);
    }
    const type = raw.type;
    if (type === 'http' || type === 'sse') {
      if (typeof raw.url !== 'string' || !raw.url.trim()) {
        throw new Error(`${context}.${name}.url must be a non-empty string for type=${type}`);
      }
      const headers = parseStringMap(raw.headers, `${context}.${name}.headers`);
      out[name] = { type, url: raw.url, ...(headers ? { headers } : {}) };
    } else if (type === 'stdio') {
      if (typeof raw.command !== 'string' || !raw.command.trim()) {
        throw new Error(`${context}.${name}.command must be a non-empty string for type=stdio`);
      }
      const args = raw.args;
      if (args !== undefined && (!Array.isArray(args) || args.some((a) => typeof a !== 'string'))) {
        throw new Error(`${context}.${name}.args must be an array of strings`);
      }
      const env = parseStringMap(raw.env, `${context}.${name}.env`);
      out[name] = {
        type: 'stdio',
        command: raw.command,
        ...(args ? { args: args as string[] } : {}),
        ...(env ? { env } : {})
      };
    } else {
      throw new Error(`${context}.${name}.type must be one of: http, sse, stdio`);
    }
  }
  return out;
}

const MEMORY_SCOPE_VALUES: readonly PersonaMemoryScope[] = [
  'workspace',
  'user',
  'global'
];

const ONEVENT_EXT_RE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/i;

// Standard 5-field cron: minute hour day-of-month month day-of-week. Each
// field is `*`, an integer, a range (`1-5`), a list (`1,3,5`), or a step
// like every-N (`*` slash `15`) or `5-25` slash `5`. Names like `MON` / `JAN`
// are deliberately not allowed at parse time; the runtime is the source of
// truth for what schedulers accept, and unknown shapes should propagate as
// runtime errors rather than silently passing through here.
const CRON_FIELD_RE = /^(?:\*|(?:\d+(?:-\d+)?)(?:,\d+(?:-\d+)?)*)(?:\/\d+)?$/;

// Windows absolute path shapes the parser must reject in addition to
// the POSIX "/abs" form. Drive-letter (`C:\…`, `C:/…`) and UNC
// (`\\server\share`, `//server/share`) forms both qualify as absolute
// for our purposes — personas need to stay portable, so onEvent paths
// must be relative to the persona JSON's directory.
const WIN_ABSOLUTE_RE = /^(?:[A-Za-z]:[\\/]|[\\/]{2})/;

function assertOnEventPath(value: unknown, context: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${context} must be a non-empty string`);
  }
  if (value.startsWith('/') || WIN_ABSOLUTE_RE.test(value)) {
    throw new Error(`${context} must be a relative POSIX path; got absolute "${value}"`);
  }
  const segments = value.split(/[\\/]+/);
  if (segments.some((s) => s === '..')) {
    throw new Error(`${context} must not contain ".." segments`);
  }
  if (!ONEVENT_EXT_RE.test(value)) {
    throw new Error(
      `${context} must point at a .ts/.tsx/.mts/.cts/.js/.mjs/.cjs file; got "${value}"`
    );
  }
  return value;
}

function assertCronExpression(value: string, context: string): void {
  const fields = value.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`${context} must be a 5-field cron expression; got ${fields.length} field(s)`);
  }
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    if (!CRON_FIELD_RE.test(field)) {
      throw new Error(`${context} field ${i + 1} is not a valid cron token: "${field}"`);
    }
  }
}

export function parseIntegrationTrigger(
  value: unknown,
  context: string
): PersonaIntegrationTrigger {
  if (!isObject(value)) {
    throw new Error(`${context} must be an object`);
  }
  const { on, match, where } = value;
  if (typeof on !== 'string' || !on.trim()) {
    throw new Error(`${context}.on must be a non-empty string`);
  }
  if (match !== undefined && (typeof match !== 'string' || !match.trim())) {
    throw new Error(`${context}.match must be a non-empty string if provided`);
  }
  if (where !== undefined && (typeof where !== 'string' || !where.trim())) {
    throw new Error(`${context}.where must be a non-empty string if provided`);
  }
  return {
    on,
    ...(typeof match === 'string' ? { match } : {}),
    ...(typeof where === 'string' ? { where } : {})
  };
}

/**
 * Slug rules for `workspace_service_account.name`: kebab-case, ≤64 chars,
 * lowercase ASCII letters/digits/hyphens, no leading/trailing/consecutive
 * hyphens. Mirrors the convention used by other persona-kit identifiers.
 */
export const INTEGRATION_SOURCE_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const INTEGRATION_SOURCE_NAME_MAX = 64;

const INTEGRATION_SOURCE_KINDS = [
  'deployer_user',
  'workspace',
  'workspace_service_account'
] as const;

type IntegrationSourceKind = (typeof INTEGRATION_SOURCE_KINDS)[number];

function isIntegrationSourceKind(value: unknown): value is IntegrationSourceKind {
  return (
    typeof value === 'string' &&
    INTEGRATION_SOURCE_KINDS.includes(value as IntegrationSourceKind)
  );
}

export function parseIntegrationSource(
  value: unknown,
  context: string
): IntegrationSource {
  if (!isObject(value)) {
    throw new Error(`${context} must be an object`);
  }
  const { kind, name } = value;
  if (!isIntegrationSourceKind(kind)) {
    throw new Error(
      `${context}.kind must be one of: ${INTEGRATION_SOURCE_KINDS.join(', ')}`
    );
  }
  if (kind === 'workspace_service_account') {
    if (typeof name !== 'string' || !name) {
      throw new Error(
        `${context}.name must be a non-empty string when kind="workspace_service_account"`
      );
    }
    if (name.length > INTEGRATION_SOURCE_NAME_MAX) {
      throw new Error(
        `${context}.name must be ≤${INTEGRATION_SOURCE_NAME_MAX} characters`
      );
    }
    if (!INTEGRATION_SOURCE_NAME_RE.test(name)) {
      throw new Error(
        `${context}.name must be kebab-case matching ${INTEGRATION_SOURCE_NAME_RE.source}`
      );
    }
    return { kind, name };
  }
  if (name !== undefined) {
    throw new Error(
      `${context}.name is only allowed when kind="workspace_service_account"`
    );
  }
  return { kind };
}

export function parseIntegrationConfig(
  value: unknown,
  context: string
): PersonaIntegrationConfig {
  if (!isObject(value)) {
    throw new Error(`${context} must be an object`);
  }
  const { source, scope, triggers } = value;

  const out: PersonaIntegrationConfig = {};

  // Default-inject `deployer_user` when the persona omits `source` so
  // pre-discriminator personas keep parsing unchanged. The cloud-side
  // resolver can then trust `source` is always present on parsed specs.
  out.source =
    source === undefined
      ? { kind: 'deployer_user' }
      : parseIntegrationSource(source, `${context}.source`);

  if (scope !== undefined) {
    const parsedScope = parseStringMap(scope, `${context}.scope`);
    if (parsedScope && Object.keys(parsedScope).length > 0) {
      out.scope = parsedScope;
    }
  }

  if (triggers !== undefined) {
    if (!Array.isArray(triggers)) {
      throw new Error(`${context}.triggers must be an array if provided`);
    }
    if (triggers.length === 0) {
      throw new Error(
        `${context}.triggers must contain at least one entry if provided (omit the field to declare an integration with no event triggers)`
      );
    }
    out.triggers = triggers.map((entry, idx) =>
      parseIntegrationTrigger(entry, `${context}.triggers[${idx}]`)
    );
  }

  return out;
}

export function parseIntegrations(
  value: unknown,
  context: string
): Record<string, PersonaIntegrationConfig> | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) {
    throw new Error(`${context} must be an object if provided`);
  }

  const out: Record<string, PersonaIntegrationConfig> = {};
  for (const [provider, raw] of Object.entries(value)) {
    if (!provider.trim()) {
      throw new Error(`${context} integration keys must be non-empty strings`);
    }
    out[provider] = parseIntegrationConfig(raw, `${context}.${provider}`);
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

export function parseSchedules(
  value: unknown,
  context: string
): PersonaSchedule[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`${context} must be an array if provided`);
  }
  if (value.length === 0) return undefined;

  // Trim every field before validating + deduping so stray whitespace
  // does not leak into schedule ids (used as `event.name`) or bypass
  // the duplicate-name guard (e.g. `"weekly"` vs `"weekly "`).
  const seenNames = new Set<string>();
  const out: PersonaSchedule[] = [];
  for (const [idx, entry] of value.entries()) {
    const entryContext = `${context}[${idx}]`;
    if (!isObject(entry)) {
      throw new Error(`${entryContext} must be an object`);
    }
    const { name, cron, tz } = entry;
    if (typeof name !== 'string' || !name.trim()) {
      throw new Error(`${entryContext}.name must be a non-empty string`);
    }
    const trimmedName = name.trim();
    if (seenNames.has(trimmedName)) {
      throw new Error(`${entryContext}.name "${trimmedName}" duplicates an earlier schedule`);
    }
    seenNames.add(trimmedName);
    if (typeof cron !== 'string' || !cron.trim()) {
      throw new Error(`${entryContext}.cron must be a non-empty string`);
    }
    const trimmedCron = cron.trim();
    assertCronExpression(trimmedCron, `${entryContext}.cron`);
    if (tz !== undefined && (typeof tz !== 'string' || !tz.trim())) {
      throw new Error(`${entryContext}.tz must be a non-empty string if provided`);
    }
    out.push({
      name: trimmedName,
      cron: trimmedCron,
      ...(typeof tz === 'string' ? { tz: tz.trim() } : {})
    });
  }
  return out;
}

const WATCH_EVENT_VALUES: readonly WatchEvent[] = ['created', 'updated', 'deleted'];

function isWatchEvent(value: unknown): value is WatchEvent {
  return (
    typeof value === 'string' &&
    WATCH_EVENT_VALUES.includes(value as WatchEvent)
  );
}

export function parseWatch(value: unknown, context: string): WatchRule[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`${context} must be an array if provided`);
  }
  if (value.length === 0) return undefined;

  return value.map((entry, idx) => {
    const entryContext = `${context}[${idx}]`;
    if (!isObject(entry)) {
      throw new Error(`${entryContext} must be an object`);
    }
    const { paths, events, debounceMs, match } = entry;
    if (!Array.isArray(paths) || paths.length === 0) {
      throw new Error(`${entryContext}.paths must be a non-empty array`);
    }
    const parsedPaths = paths.map((path, pathIdx) => {
      const pathContext = `${entryContext}.paths[${pathIdx}]`;
      if (typeof path !== 'string' || !path.trim()) {
        throw new Error(`${pathContext} must be a non-empty string`);
      }
      if (!path.startsWith('/')) {
        throw new Error(`${pathContext} must start with /`);
      }
      return path;
    });

    if (!Array.isArray(events) || events.length === 0) {
      throw new Error(`${entryContext}.events must be a non-empty array`);
    }
    const parsedEvents: WatchEvent[] = [];
    for (const [eventIdx, event] of events.entries()) {
      if (!isWatchEvent(event)) {
        throw new Error(
          `${entryContext}.events[${eventIdx}] must be one of: ${WATCH_EVENT_VALUES.join(', ')}`
        );
      }
      if (!parsedEvents.includes(event)) parsedEvents.push(event);
    }

    if (
      debounceMs !== undefined &&
      (typeof debounceMs !== 'number' || !Number.isFinite(debounceMs) || debounceMs < 0)
    ) {
      throw new Error(`${entryContext}.debounceMs must be a non-negative number if provided`);
    }
    if (match !== undefined && (typeof match !== 'string' || !match.trim())) {
      throw new Error(`${entryContext}.match must be a non-empty string if provided`);
    }

    return {
      paths: parsedPaths,
      events: parsedEvents,
      ...(typeof debounceMs === 'number' ? { debounceMs } : {}),
      ...(typeof match === 'string' ? { match } : {})
    };
  });
}

export function parseMemory(value: unknown, context: string): PersonaMemory | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  if (!isObject(value)) {
    throw new Error(`${context} must be a boolean or an object if provided`);
  }
  const { enabled, scopes, ttlDays, autoPromote, dedupMs } = value;
  const out: PersonaMemoryConfig = {};
  if (enabled !== undefined) {
    if (typeof enabled !== 'boolean') {
      throw new Error(`${context}.enabled must be a boolean if provided`);
    }
    out.enabled = enabled;
  }
  if (scopes !== undefined) {
    if (!Array.isArray(scopes) || scopes.length === 0) {
      throw new Error(
        `${context}.scopes must be a non-empty array of memory scopes if provided`
      );
    }
    const parsedScopes: PersonaMemoryScope[] = [];
    for (const [idx, entry] of scopes.entries()) {
      if (typeof entry !== 'string' || !MEMORY_SCOPE_VALUES.includes(entry as PersonaMemoryScope)) {
        throw new Error(
          `${context}.scopes[${idx}] must be one of: ${MEMORY_SCOPE_VALUES.join(', ')}`
        );
      }
      const scope = entry as PersonaMemoryScope;
      if (!parsedScopes.includes(scope)) parsedScopes.push(scope);
    }
    out.scopes = parsedScopes;
  }
  if (ttlDays !== undefined) {
    if (typeof ttlDays !== 'number' || !Number.isFinite(ttlDays) || ttlDays <= 0) {
      throw new Error(`${context}.ttlDays must be a positive number if provided`);
    }
    out.ttlDays = ttlDays;
  }
  if (autoPromote !== undefined) {
    if (typeof autoPromote !== 'boolean') {
      throw new Error(`${context}.autoPromote must be a boolean if provided`);
    }
    out.autoPromote = autoPromote;
  }
  if (dedupMs !== undefined) {
    if (typeof dedupMs !== 'number' || !Number.isFinite(dedupMs) || dedupMs < 0) {
      throw new Error(`${context}.dedupMs must be a non-negative number if provided`);
    }
    out.dedupMs = dedupMs;
  }
  return out;
}

export function parseOnEvent(value: unknown, context: string): string | undefined {
  if (value === undefined) return undefined;
  return assertOnEventPath(value, context);
}

export function parsePersonaSpec(value: unknown, expectedIntent: PersonaIntent): PersonaSpec {
  if (!isObject(value)) {
    throw new Error(`persona[${expectedIntent}] must be an object`);
  }
  if ('traits' in value) {
    throw new Error(
      'traits was removed in v1; personality is handled by the persona-personality-builder tool (out of scope for v1). See docs/plans/deploy-v1.md'
    );
  }
  if ('sandbox' in value) {
    throw new Error(
      "sandbox was removed in v1; sandbox is on by default at deploy time. Use 'workforce deploy --no-sandbox' or runtime config to opt out. See docs/plans/deploy-v1.md"
    );
  }

  const {
    id,
    intent,
    tags,
    description,
    harness,
    model,
    systemPrompt,
    harnessSettings,
    skills,
    inputs,
    env,
    mcpServers,
    permissions,
    mount,
    claudeMd,
    claudeMdMode,
    agentsMd,
    agentsMdMode,
    claudeMdContent,
    agentsMdContent,
    cloud,
    useSubscription,
    integrations,
    schedules,
    watch,
    memory,
    onEvent
  } = value;

  if (typeof id !== 'string' || !id.trim()) {
    throw new Error(`persona[${expectedIntent}].id must be a non-empty string`);
  }
  if (!isIntent(intent)) {
    throw new Error(`persona[${expectedIntent}].intent is invalid`);
  }
  if (intent !== expectedIntent) {
    throw new Error(`persona[${expectedIntent}] intent mismatch: got ${intent}`);
  }
  const parsedTags = parseTags(tags, `persona[${expectedIntent}].tags`);
  if (typeof description !== 'string' || !description.trim()) {
    throw new Error(`persona[${expectedIntent}].description must be a non-empty string`);
  }

  // Handler-style personas (`onEvent` set) run a bundled handler that
  // controls the flow itself; `harness` / `model` / `systemPrompt` are only
  // consumed when the handler calls `ctx.harness.run(...)`, so they're
  // optional here. A pure orchestrator (e.g. one that only fans out to
  // `ctx.workflow.run`) needs none of them and shouldn't have to carry stub
  // values to pass validation. Interactive personas (no `onEvent`) still
  // require all three — that's the harness session the CLI spawns.
  const isHandlerPersona = typeof onEvent === 'string' && onEvent.trim().length > 0;

  if (harness !== undefined) {
    if (!isHarness(harness)) {
      throw new Error(
        `persona[${expectedIntent}].harness must be one of: ${HARNESS_VALUES.join(', ')}`
      );
    }
  } else if (!isHandlerPersona) {
    throw new Error(
      `persona[${expectedIntent}].harness must be one of: ${HARNESS_VALUES.join(', ')}`
    );
  }
  if (model !== undefined) {
    if (typeof model !== 'string' || !model.trim()) {
      throw new Error(`persona[${expectedIntent}].model must be a non-empty string`);
    }
  } else if (!isHandlerPersona) {
    throw new Error(`persona[${expectedIntent}].model must be a non-empty string`);
  }
  const trimmedModel = typeof model === 'string' ? model.trim() : undefined;
  if (systemPrompt !== undefined) {
    if (typeof systemPrompt !== 'string' || !systemPrompt.trim()) {
      throw new Error(`persona[${expectedIntent}].systemPrompt must be a non-empty string`);
    }
  } else if (!isHandlerPersona) {
    throw new Error(`persona[${expectedIntent}].systemPrompt must be a non-empty string`);
  }
  const parsedHarnessSettings = parseHarnessSettings(
    harnessSettings,
    `persona[${expectedIntent}].harnessSettings`
  );

  const parsedSkills = parseSkills(skills, `persona[${expectedIntent}].skills`);
  const parsedInputs = parseInputs(inputs, `persona[${expectedIntent}].inputs`);
  const parsedEnv = parseStringMap(env, `persona[${expectedIntent}].env`);
  const parsedMcpServers = parseMcpServers(mcpServers, `persona[${expectedIntent}].mcpServers`);
  const parsedPermissions = parsePermissions(
    permissions,
    `persona[${expectedIntent}].permissions`
  );
  const parsedMount = parseMount(mount, `persona[${expectedIntent}].mount`);

  if (claudeMd !== undefined) assertSidecarPath(claudeMd, `persona[${expectedIntent}].claudeMd`);
  if (agentsMd !== undefined) assertSidecarPath(agentsMd, `persona[${expectedIntent}].agentsMd`);
  if (claudeMdMode !== undefined && !isSidecarMode(claudeMdMode)) {
    throw new Error(
      `persona[${expectedIntent}].claudeMdMode must be one of: ${SIDECAR_MD_MODES.join(', ')}`
    );
  }
  if (agentsMdMode !== undefined && !isSidecarMode(agentsMdMode)) {
    throw new Error(
      `persona[${expectedIntent}].agentsMdMode must be one of: ${SIDECAR_MD_MODES.join(', ')}`
    );
  }
  if (
    claudeMdContent !== undefined &&
    (typeof claudeMdContent !== 'string' || !claudeMdContent.length)
  ) {
    throw new Error(`persona[${expectedIntent}].claudeMdContent must be a non-empty string`);
  }
  if (
    agentsMdContent !== undefined &&
    (typeof agentsMdContent !== 'string' || !agentsMdContent.length)
  ) {
    throw new Error(`persona[${expectedIntent}].agentsMdContent must be a non-empty string`);
  }

  if (cloud !== undefined && typeof cloud !== 'boolean') {
    throw new Error(`persona[${expectedIntent}].cloud must be a boolean if provided`);
  }
  if (useSubscription !== undefined && typeof useSubscription !== 'boolean') {
    throw new Error(`persona[${expectedIntent}].useSubscription must be a boolean if provided`);
  }
  const parsedIntegrations = parseIntegrations(
    integrations,
    `persona[${expectedIntent}].integrations`
  );
  const parsedSchedules = parseSchedules(schedules, `persona[${expectedIntent}].schedules`);
  const parsedWatch = parseWatch(watch, `persona[${expectedIntent}].watch`);
  const parsedMemory = parseMemory(memory, `persona[${expectedIntent}].memory`);
  const parsedOnEvent = parseOnEvent(onEvent, `persona[${expectedIntent}].onEvent`);

  return {
    id,
    intent,
    ...(parsedTags ? { tags: parsedTags } : {}),
    description,
    skills: parsedSkills,
    ...(parsedInputs ? { inputs: parsedInputs } : {}),
    ...(harness !== undefined ? { harness: harness as Harness } : {}),
    ...(trimmedModel !== undefined ? { model: trimmedModel } : {}),
    ...(systemPrompt !== undefined ? { systemPrompt: systemPrompt as string } : {}),
    harnessSettings: parsedHarnessSettings,
    ...(parsedEnv ? { env: parsedEnv } : {}),
    ...(parsedMcpServers ? { mcpServers: parsedMcpServers } : {}),
    ...(parsedPermissions ? { permissions: parsedPermissions } : {}),
    ...(parsedMount ? { mount: parsedMount } : {}),
    ...(typeof claudeMd === 'string' ? { claudeMd } : {}),
    ...(claudeMdMode ? { claudeMdMode: claudeMdMode as SidecarMdMode } : {}),
    ...(typeof agentsMd === 'string' ? { agentsMd } : {}),
    ...(agentsMdMode ? { agentsMdMode: agentsMdMode as SidecarMdMode } : {}),
    ...(typeof claudeMdContent === 'string' ? { claudeMdContent } : {}),
    ...(typeof agentsMdContent === 'string' ? { agentsMdContent } : {}),
    ...(typeof cloud === 'boolean' ? { cloud } : {}),
    ...(typeof useSubscription === 'boolean' ? { useSubscription } : {}),
    ...(parsedIntegrations ? { integrations: parsedIntegrations } : {}),
    ...(parsedSchedules ? { schedules: parsedSchedules } : {}),
    ...(parsedWatch ? { watch: parsedWatch } : {}),
    ...(parsedMemory !== undefined ? { memory: parsedMemory } : {}),
    ...(parsedOnEvent !== undefined ? { onEvent: parsedOnEvent } : {})
  };
}

/**
 * Resolve the effective sidecar config for a persona. Each sidecar
 * (`claude*`, `agents*`) is a single channel of path + inlined content +
 * mode read directly off the spec. Modes default to `overwrite` and are
 * only meaningful when a path or inlined content is present.
 */
export function resolveSidecar(spec: PersonaSpec): {
  claudeMd?: string;
  claudeMdContent?: string;
  claudeMdMode: SidecarMdMode;
  agentsMd?: string;
  agentsMdContent?: string;
  agentsMdMode: SidecarMdMode;
} {
  return {
    ...(spec.claudeMd ? { claudeMd: spec.claudeMd } : {}),
    ...(spec.claudeMdContent ? { claudeMdContent: spec.claudeMdContent } : {}),
    claudeMdMode: spec.claudeMdMode ?? 'overwrite',
    ...(spec.agentsMd ? { agentsMd: spec.agentsMd } : {}),
    ...(spec.agentsMdContent ? { agentsMdContent: spec.agentsMdContent } : {}),
    agentsMdMode: spec.agentsMdMode ?? 'overwrite'
  };
}

export function sidecarSelectionFields(
  sidecar: ReturnType<typeof resolveSidecar>
): Pick<
  PersonaSelection,
  | 'claudeMd'
  | 'claudeMdContent'
  | 'claudeMdMode'
  | 'agentsMd'
  | 'agentsMdContent'
  | 'agentsMdMode'
> {
  return {
    ...(sidecar.claudeMd ? { claudeMd: sidecar.claudeMd } : {}),
    ...(sidecar.claudeMdContent ? { claudeMdContent: sidecar.claudeMdContent } : {}),
    ...(sidecar.claudeMd || sidecar.claudeMdContent
      ? { claudeMdMode: sidecar.claudeMdMode }
      : {}),
    ...(sidecar.agentsMd ? { agentsMd: sidecar.agentsMd } : {}),
    ...(sidecar.agentsMdContent ? { agentsMdContent: sidecar.agentsMdContent } : {}),
    ...(sidecar.agentsMd || sidecar.agentsMdContent
      ? { agentsMdMode: sidecar.agentsMdMode }
      : {})
  };
}

export function deepFreeze<T>(value: T): T {
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
