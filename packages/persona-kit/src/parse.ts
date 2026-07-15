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
  AgentSpec,
  CapabilityValue,
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
  PersonaAiMemoryConfig,
  PersonaHttpReadCapability,
  PersonaHttpReadRule,
  PersonaMemory,
  PersonaMemoryConfig,
  PersonaMemoryScope,
  PersonaRelay,
  PersonaRelayConfig,
  PersonaMount,
  PersonaTrajectoryConfig,
  PersonaPermissions,
  PersonaSchedule,
  PersonaSelection,
  PersonaSkill,
  PersonaSpec,
  PersonaTag,
  ProactiveCapabilities,
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

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isObject(value) || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
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

/**
 * Parse the sandbox field from a persona spec.
 * Valid values: `true`, `false`. Missing/undefined means default (sandbox always booted).
 */
function parseSandbox(
  value: unknown,
  context: string
): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === true || value === false) return value;
  throw new Error(
    `${context} must be true or false (got ${JSON.stringify(value)})`
  );
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
  const { on, match, where, maxConcurrency } = value;
  if (typeof on !== 'string' || !on.trim()) {
    throw new Error(`${context}.on must be a non-empty string`);
  }
  if (match !== undefined && (typeof match !== 'string' || !match.trim())) {
    throw new Error(`${context}.match must be a non-empty string if provided`);
  }
  if (where !== undefined && (typeof where !== 'string' || !where.trim())) {
    throw new Error(`${context}.where must be a non-empty string if provided`);
  }
  // Intentionally lenient: Cloud derives this as an optional backpressure hint,
  // so invalid values mean "unset" rather than a parse failure.
  const parsedMaxConcurrency =
    typeof maxConcurrency === 'number' &&
    Number.isInteger(maxConcurrency) &&
    maxConcurrency >= 1
      ? maxConcurrency
      : undefined;
  return {
    on,
    ...(typeof match === 'string' ? { match } : {}),
    ...(typeof where === 'string' ? { where } : {}),
    ...(parsedMaxConcurrency !== undefined
      ? { maxConcurrency: parsedMaxConcurrency }
      : {})
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
  const { source, scope, config, optional, enabledByInput } = value;

  // Hard cut: triggers moved from the persona to the agent. A persona
  // integration is connection-config only (source + scope). Fail loudly so
  // un-migrated personas surface the move instead of silently dropping events.
  if ('triggers' in value) {
    throw new Error(
      `${context}.triggers is no longer allowed — event triggers moved to the agent. ` +
        `Declare them in agent.ts via defineAgent({ triggers: { ${context.split('.').pop()}: [...] } }).`
    );
  }

  const out: PersonaIntegrationConfig = {};

  // Default-inject `deployer_user` when the persona omits `source` so
  // pre-discriminator personas keep parsing unchanged. The cloud-side
  // resolver can then trust `source` is always present on parsed specs.
  out.source =
    source === undefined
      ? { kind: 'deployer_user' }
      : parseIntegrationSource(source, `${context}.source`);
  if (source === undefined) {
    Object.defineProperty(out, '__agentworkforceImplicitSource', {
      value: true,
      enumerable: false
    });
  }

  if (scope !== undefined) {
    const parsedScope = parseStringMap(scope, `${context}.scope`);
    if (parsedScope && Object.keys(parsedScope).length > 0) {
      out.scope = parsedScope;
    }
  }

  if (config !== undefined) {
    if (!isPlainObject(config)) {
      throw new Error(`${context}.config must be a plain object if provided`);
    }
    out.config = config;
  }

  if (optional !== undefined) {
    if (typeof optional !== 'boolean') {
      throw new Error(`${context}.optional must be a boolean if provided`);
    }
    out.optional = optional;
  }

  if (enabledByInput !== undefined) {
    if (typeof enabledByInput !== 'string' || !enabledByInput.trim()) {
      throw new Error(`${context}.enabledByInput must be a non-empty string if provided`);
    }
    assertInputName(enabledByInput, `${context}.enabledByInput`);
    out.enabledByInput = enabledByInput;
  }

  if (out.optional === true && out.enabledByInput === undefined) {
    throw new Error(`${context}.enabledByInput is required when optional is true`);
  }
  if (out.enabledByInput !== undefined && out.optional !== true) {
    throw new Error(`${context}.optional must be true when enabledByInput is set`);
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

/**
 * Validate an **agent** spec (the `defineAgent(...)` shape the deploy CLI
 * extracts from `agent.ts`). The handler itself is not validated here — only
 * the listener declarations that travel to the cloud as the deploy `agent`
 * block: a provider-keyed `triggers` map, cron `schedules`, and relayfile
 * `watch` rules. Reuses {@link parseIntegrationTrigger} / {@link parseSchedules}
 * / {@link parseWatch} so trigger/schedule/watch validation stays identical to
 * the pre-move persona path.
 */
export function parseAgentSpec(value: unknown, context = 'agent'): AgentSpec {
  if (!isObject(value)) {
    throw new Error(`${context} must be an object`);
  }
  const { launchedBy, triggers, schedules, watch } = value;
  const out: AgentSpec = {};

  if (launchedBy !== undefined) {
    if (launchedBy !== 'team-dispatcher') {
      throw new Error(`${context}.launchedBy must be one of: team-dispatcher`);
    }
    out.launchedBy = launchedBy;
  }

  if (triggers !== undefined) {
    if (!isObject(triggers) || Array.isArray(triggers)) {
      throw new Error(
        `${context}.triggers must be an object keyed by provider slug (e.g. { github: [{ on: 'pull_request.opened' }] })`
      );
    }
    const parsed: Record<string, PersonaIntegrationTrigger[]> = {};
    for (const [provider, raw] of Object.entries(triggers)) {
      if (!provider.trim()) {
        throw new Error(`${context}.triggers keys must be non-empty provider slugs`);
      }
      if (!Array.isArray(raw) || raw.length === 0) {
        throw new Error(
          `${context}.triggers.${provider} must be a non-empty array of triggers`
        );
      }
      parsed[provider] = raw.map((entry, idx) =>
        parseIntegrationTrigger(entry, `${context}.triggers.${provider}[${idx}]`)
      );
    }
    if (Object.keys(parsed).length > 0) out.triggers = parsed;
  }

  const parsedSchedules = parseSchedules(schedules, `${context}.schedules`);
  if (parsedSchedules) out.schedules = parsedSchedules;

  const parsedWatch = parseWatch(watch, `${context}.watch`);
  if (parsedWatch) out.watch = parsedWatch;

  return out;
}

export function parseMemory(value: unknown, context: string): PersonaMemory | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  if (!isObject(value)) {
    throw new Error(`${context} must be a boolean or an object if provided`);
  }
  const { enabled, scopes, ttlDays, autoPromote, dedupMs, trajectories, aiMemory } = value;
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
  if (trajectories !== undefined) {
    out.trajectories = parseTrajectoryConfig(trajectories, `${context}.trajectories`);
  }
  if (aiMemory !== undefined) {
    out.aiMemory = parseAiMemoryConfig(aiMemory, `${context}.aiMemory`);
  }
  return out;
}

export function parseRelay(value: unknown, context: string): PersonaRelay | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  if (!isObject(value)) {
    throw new Error(`${context} must be a boolean or an object if provided`);
  }
  const { enabled, agentName, channels, inbox, defaultWorkspace } = value;
  const out: PersonaRelayConfig = {};
  if (enabled !== undefined) {
    if (typeof enabled !== 'boolean') {
      throw new Error(`${context}.enabled must be a boolean if provided`);
    }
    out.enabled = enabled;
  }
  if (agentName !== undefined) {
    if (typeof agentName !== 'string' || !agentName.trim()) {
      throw new Error(`${context}.agentName must be a non-empty string if provided`);
    }
    out.agentName = agentName.trim();
  }
  if (channels !== undefined) {
    out.channels = parseRelayStringList(channels, `${context}.channels`);
  }
  if (inbox !== undefined) {
    out.inbox = parseRelayStringList(inbox, `${context}.inbox`);
  }
  if (defaultWorkspace !== undefined) {
    if (typeof defaultWorkspace !== 'string' || !defaultWorkspace.trim()) {
      throw new Error(`${context}.defaultWorkspace must be a non-empty string if provided`);
    }
    out.defaultWorkspace = defaultWorkspace.trim();
  }
  return out;
}

function parseRelayStringList(value: unknown, context: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${context} must be an array of strings if provided`);
  }
  const out: string[] = [];
  for (const [idx, entry] of value.entries()) {
    if (typeof entry !== 'string' || !entry.trim()) {
      throw new Error(`${context}[${idx}] must be a non-empty string`);
    }
    const normalized = entry.trim();
    if (!out.includes(normalized)) out.push(normalized);
  }
  return out;
}

function parseTrajectoryConfig(
  value: unknown,
  context: string
): boolean | PersonaTrajectoryConfig {
  if (typeof value === 'boolean') return value;
  if (!isObject(value)) {
    throw new Error(`${context} must be a boolean or an object if provided`);
  }
  const out: PersonaTrajectoryConfig = {};
  if (value.enabled !== undefined) {
    if (typeof value.enabled !== 'boolean') {
      throw new Error(`${context}.enabled must be a boolean if provided`);
    }
    out.enabled = value.enabled;
  }
  if (value.autoCompact !== undefined) {
    if (typeof value.autoCompact !== 'boolean') {
      throw new Error(`${context}.autoCompact must be a boolean if provided`);
    }
    out.autoCompact = value.autoCompact;
  }
  return out;
}

function parseAiMemoryConfig(
  value: unknown,
  context: string
): boolean | PersonaAiMemoryConfig {
  if (typeof value === 'boolean') return value;
  if (!isObject(value)) {
    throw new Error(`${context} must be a boolean or an object if provided`);
  }
  const out: PersonaAiMemoryConfig = {};
  if (value.enabled !== undefined) {
    if (typeof value.enabled !== 'boolean') {
      throw new Error(`${context}.enabled must be a boolean if provided`);
    }
    out.enabled = value.enabled;
  }
  if (value.dbPath !== undefined) {
    if (typeof value.dbPath !== 'string' || !value.dbPath.trim()) {
      throw new Error(`${context}.dbPath must be a non-empty string if provided`);
    }
    out.dbPath = value.dbPath;
  }
  return out;
}

/**
 * Resolve the opt-in `memory.trajectories` facet (the "why" write side).
 * Off unless the persona declares it: `true`, or an object whose
 * `enabled !== false`. The boolean `memory: true` shorthand does NOT enable it.
 */
export function resolveTrajectoryRecording(memory: PersonaMemory | undefined): {
  enabled: boolean;
  autoCompact?: boolean;
} {
  if (!memory || typeof memory === 'boolean') return { enabled: false };
  const value = memory.trajectories;
  if (value === undefined) return { enabled: false };
  if (typeof value === 'boolean') return { enabled: value };
  return {
    enabled: value.enabled !== false,
    ...(value.autoCompact !== undefined ? { autoCompact: value.autoCompact } : {})
  };
}

/**
 * Resolve the opt-in `memory.aiMemory` facet (the "how"+"why" recall side that
 * loads the ai-hist MCP). Off unless declared; `memory: true` does NOT enable it.
 */
export function resolveAiMemory(memory: PersonaMemory | undefined): {
  enabled: boolean;
  dbPath?: string;
} {
  if (!memory || typeof memory === 'boolean') return { enabled: false };
  const value = memory.aiMemory;
  if (value === undefined) return { enabled: false };
  if (typeof value === 'boolean') return { enabled: value };
  return {
    enabled: value.enabled !== false,
    ...(value.dbPath ? { dbPath: value.dbPath } : {})
  };
}

function parseCapabilityValue(value: unknown, context: string): CapabilityValue {
  if (typeof value === 'boolean') return value;
  if (!isObject(value) || Array.isArray(value)) {
    throw new Error(`${context} must be a boolean or object if provided`);
  }
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') {
    throw new Error(`${context}.enabled must be a boolean if provided`);
  }
  return { ...value } as CapabilityValue;
}

function parseHttpReadRule(value: unknown, context: string): PersonaHttpReadRule {
  if (!isObject(value) || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  const entry = value as Record<string, unknown>;
  for (const key of Object.keys(entry)) {
    if (!['method', 'urlGlob'].includes(key)) {
      throw new Error(`${context}.${key} is not allowed`);
    }
  }
  if (entry.method !== 'GET' && entry.method !== 'HEAD') {
    throw new Error(`${context}.method must be "GET" or "HEAD"`);
  }
  if (typeof entry.urlGlob !== 'string' || !entry.urlGlob.trim()) {
    throw new Error(`${context}.urlGlob must be a non-empty string`);
  }
  return {
    method: entry.method,
    urlGlob: entry.urlGlob
  };
}

function parseHttpReadCapability(value: unknown, context: string): PersonaHttpReadCapability {
  if (!isObject(value) || Array.isArray(value)) {
    throw new Error(`${context} must be an object if provided`);
  }
  const entry = value as Record<string, unknown>;
  for (const key of Object.keys(entry)) {
    if (!['enabled', 'allow'].includes(key)) {
      throw new Error(`${context}.${key} is not allowed`);
    }
  }
  if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') {
    throw new Error(`${context}.enabled must be a boolean if provided`);
  }
  if (entry.allow !== undefined && !Array.isArray(entry.allow)) {
    throw new Error(`${context}.allow must be an array if provided`);
  }
  return {
    ...(entry.enabled !== undefined ? { enabled: entry.enabled } : {}),
    ...(entry.allow !== undefined
      ? {
          allow: entry.allow.map((rule, index) =>
            parseHttpReadRule(rule, `${context}.allow[${index}]`)
          )
        }
      : {})
  };
}

export function parseCapabilities(
  value: unknown,
  context: string
): ProactiveCapabilities | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value) || Array.isArray(value)) {
    throw new Error(`${context} must be an object if provided`);
  }

  const out: ProactiveCapabilities = {};
  // Preserve every declared capability, including consumer-defined cloud-only
  // capabilities (e.g. `teamSolve`) that persona-kit does not model directly.
  // Dropping unknown keys here silently strips them from the deployed persona
  // spec - the cause of the cloud team-launch regression where the CLI
  // preflight parse ran client-side before upload, so the cloud never received
  // `teamSolve` and its `isTeamLaunchN1` gate stayed false
  // (workforce#182 / cloud#1732). persona-kit is platform-agnostic; it must not
  // drop capability keys it happens not to recognize.
  for (const [key, raw] of Object.entries(value)) {
    if (raw === undefined) continue;
    out[key] = key === 'httpRead'
      ? parseHttpReadCapability(raw, `${context}.${key}`)
      : parseCapabilityValue(raw, `${context}.${key}`);
  }

  return Object.keys(out).length > 0 ? out : undefined;
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
  // Hard cut: schedules and watch moved from the persona to the agent.
  if ('schedules' in value) {
    throw new Error(
      `persona[${expectedIntent}].schedules is no longer allowed — cron schedules moved to the agent. ` +
        'Declare them in agent.ts via defineAgent({ schedules: [...] }).'
    );
  }
  if ('watch' in value) {
    throw new Error(
      `persona[${expectedIntent}].watch is no longer allowed — relayfile watch rules moved to the agent. ` +
        'Declare them in agent.ts via defineAgent({ watch: [...] }).'
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
    sandbox,
    claudeMd,
    claudeMdMode,
    agentsMd,
    agentsMdMode,
    claudeMdContent,
    agentsMdContent,
    cloud,
    useSubscription,
    integrations,
    capabilities,
    memory,
    relay,
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
  const parsedCapabilities = parseCapabilities(
    capabilities,
    `persona[${expectedIntent}].capabilities`
  );
  const parsedMemory = parseMemory(memory, `persona[${expectedIntent}].memory`);
  const parsedRelay = parseRelay(relay, `persona[${expectedIntent}].relay`);
  const parsedOnEvent = parseOnEvent(onEvent, `persona[${expectedIntent}].onEvent`);
  const parsedSandbox = parseSandbox(sandbox, `persona[${expectedIntent}].sandbox`);

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
    ...(parsedSandbox !== undefined ? { sandbox: parsedSandbox } : {}),
    ...(typeof claudeMd === 'string' ? { claudeMd } : {}),
    ...(claudeMdMode ? { claudeMdMode: claudeMdMode as SidecarMdMode } : {}),
    ...(typeof agentsMd === 'string' ? { agentsMd } : {}),
    ...(agentsMdMode ? { agentsMdMode: agentsMdMode as SidecarMdMode } : {}),
    ...(typeof claudeMdContent === 'string' ? { claudeMdContent } : {}),
    ...(typeof agentsMdContent === 'string' ? { agentsMdContent } : {}),
    ...(typeof cloud === 'boolean' ? { cloud } : {}),
    ...(typeof useSubscription === 'boolean' ? { useSubscription } : {}),
    ...(parsedIntegrations ? { integrations: parsedIntegrations } : {}),
    ...(parsedCapabilities ? { capabilities: parsedCapabilities } : {}),
    ...(parsedMemory !== undefined ? { memory: parsedMemory } : {}),
    ...(parsedRelay !== undefined ? { relay: parsedRelay } : {}),
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
