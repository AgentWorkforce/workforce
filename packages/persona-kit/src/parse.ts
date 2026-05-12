import {
  CODEX_APPROVAL_POLICIES,
  CODEX_SANDBOX_MODES,
  HARNESS_VALUES,
  PERMISSION_MODES,
  PERSONA_INTENTS,
  PERSONA_TAGS,
  PERSONA_TIERS,
  SIDECAR_MD_MODES
} from './constants.js';
import type {
  CodexApprovalPolicy,
  CodexSandboxMode,
  Harness,
  HarnessSettings,
  IntegrationConfig,
  McpServerSpec,
  MemoryConfig,
  MemoryScope,
  PermissionMode,
  PersonaInputSpec,
  PersonaIntent,
  PersonaMount,
  PersonaPermissions,
  PersonaRuntime,
  PersonaSelection,
  PersonaSkill,
  PersonaSpec,
  PersonaTag,
  PersonaTier,
  SandboxConfig,
  Schedule,
  SidecarMdMode,
  Traits
} from './types.js';

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isHarness(value: unknown): value is Harness {
  return typeof value === 'string' && HARNESS_VALUES.includes(value as Harness);
}

export function isTier(value: unknown): value is PersonaTier {
  return typeof value === 'string' && PERSONA_TIERS.includes(value as PersonaTier);
}

export function isIntent(value: unknown): value is PersonaIntent {
  return typeof value === 'string' && PERSONA_INTENTS.includes(value as PersonaIntent);
}

export function isTag(value: unknown): value is PersonaTag {
  return typeof value === 'string' && PERSONA_TAGS.includes(value as PersonaTag);
}

export function isSidecarMode(value: unknown): value is SidecarMdMode {
  return typeof value === 'string' && SIDECAR_MD_MODES.includes(value as SidecarMdMode);
}

export function parseTags(value: unknown, context: string): PersonaTag[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${context} must be a non-empty array of tags`);
  }
  const out: PersonaTag[] = [];
  for (const [idx, entry] of value.entries()) {
    if (!isTag(entry)) {
      throw new Error(
        `${context}[${idx}] must be one of: ${PERSONA_TAGS.join(', ')}`
      );
    }
    if (!out.includes(entry)) out.push(entry);
  }
  return out;
}

export function assertSidecarPath(value: unknown, context: string): void {
  assertRelativePath(value, context);
  if (!String(value).toLowerCase().endsWith('.md')) {
    throw new Error(`${context} must end with .md`);
  }
}

export function assertRelativePath(value: unknown, context: string): void {
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

export function parseRuntime(value: unknown, context: string): PersonaRuntime {
  if (!isObject(value)) {
    throw new Error(`${context} must be an object`);
  }

  const {
    harness,
    model,
    systemPrompt,
    harnessSettings,
    claudeMd,
    claudeMdMode,
    agentsMd,
    agentsMdMode,
    claudeMdContent,
    agentsMdContent
  } = value;

  if (!isHarness(harness)) {
    throw new Error(`${context}.harness must be one of: ${HARNESS_VALUES.join(', ')}`);
  }
  if (typeof model !== 'string' || !model.trim()) {
    throw new Error(`${context}.model must be a non-empty string`);
  }
  if (typeof systemPrompt !== 'string' || !systemPrompt.trim()) {
    throw new Error(`${context}.systemPrompt must be a non-empty string`);
  }
  const parsedHarnessSettings = parseHarnessSettings(
    harnessSettings,
    `${context}.harnessSettings`
  );

  if (claudeMd !== undefined) assertSidecarPath(claudeMd, `${context}.claudeMd`);
  if (agentsMd !== undefined) assertSidecarPath(agentsMd, `${context}.agentsMd`);
  if (claudeMdMode !== undefined && !isSidecarMode(claudeMdMode)) {
    throw new Error(`${context}.claudeMdMode must be one of: ${SIDECAR_MD_MODES.join(', ')}`);
  }
  if (agentsMdMode !== undefined && !isSidecarMode(agentsMdMode)) {
    throw new Error(`${context}.agentsMdMode must be one of: ${SIDECAR_MD_MODES.join(', ')}`);
  }
  // Mode is allowed without a same-level path: a tier may declare just
  // `claudeMdMode` and inherit the path from the spec top-level (or vice
  // versa). The cascade validates that a path/content actually exists at
  // runtime — a stranded mode with no path anywhere becomes a no-op.
  if (claudeMdContent !== undefined && (typeof claudeMdContent !== 'string' || !claudeMdContent.length)) {
    throw new Error(`${context}.claudeMdContent must be a non-empty string`);
  }
  if (agentsMdContent !== undefined && (typeof agentsMdContent !== 'string' || !agentsMdContent.length)) {
    throw new Error(`${context}.agentsMdContent must be a non-empty string`);
  }

  return {
    harness,
    model,
    systemPrompt,
    harnessSettings: parsedHarnessSettings,
    ...(typeof claudeMd === 'string' ? { claudeMd } : {}),
    ...(claudeMdMode ? { claudeMdMode: claudeMdMode as SidecarMdMode } : {}),
    ...(typeof agentsMd === 'string' ? { agentsMd } : {}),
    ...(agentsMdMode ? { agentsMdMode: agentsMdMode as SidecarMdMode } : {}),
    ...(typeof claudeMdContent === 'string' ? { claudeMdContent } : {}),
    ...(typeof agentsMdContent === 'string' ? { agentsMdContent } : {})
  };
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
  return ignoredPatterns || readonlyPatterns
    ? {
        ...(ignoredPatterns ? { ignoredPatterns } : {}),
        ...(readonlyPatterns ? { readonlyPatterns } : {})
      }
    : undefined;
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
    const { description, env, default: defaultValue, optional } = raw;
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

export function parseIntegrations(
  value: unknown,
  context: string
): Record<string, IntegrationConfig> | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) {
    throw new Error(`${context} must be an object if provided`);
  }
  const out: Record<string, IntegrationConfig> = {};
  for (const [provider, raw] of Object.entries(value)) {
    if (typeof provider !== 'string' || !provider.trim()) {
      throw new Error(`${context} provider names must be non-empty strings`);
    }
    if (!isObject(raw)) {
      throw new Error(`${context}.${provider} must be an object`);
    }
    const integration: IntegrationConfig = {};
    if (raw.scope !== undefined) {
      if (!isObject(raw.scope)) {
        throw new Error(`${context}.${provider}.scope must be an object if provided`);
      }
      integration.scope = { ...raw.scope };
    }
    if (raw.triggers !== undefined) {
      if (!Array.isArray(raw.triggers)) {
        throw new Error(`${context}.${provider}.triggers must be an array if provided`);
      }
      integration.triggers = raw.triggers.map((trigger, idx) => {
        const triggerContext = `${context}.${provider}.triggers[${idx}]`;
        if (!isObject(trigger)) {
          throw new Error(`${triggerContext} must be an object`);
        }
        if (typeof trigger.on !== 'string' || !trigger.on.trim()) {
          throw new Error(`${triggerContext}.on must be a non-empty string`);
        }
        const parsed: NonNullable<IntegrationConfig['triggers']>[number] = {
          on: trigger.on
        };
        if (trigger.match !== undefined) {
          if (typeof trigger.match !== 'string' || !trigger.match.trim()) {
            throw new Error(`${triggerContext}.match must be a non-empty string if provided`);
          }
          parsed.match = trigger.match;
        }
        if (trigger.where !== undefined) {
          if (typeof trigger.where !== 'string' || !trigger.where.trim()) {
            throw new Error(`${triggerContext}.where must be a non-empty string if provided`);
          }
          parsed.where = trigger.where;
        }
        return parsed;
      });
    }
    out[provider] = integration;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function parseSchedules(value: unknown, context: string): Schedule[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`${context} must be an array if provided`);
  }
  const names = new Set<string>();
  const schedules = value.map((entry, idx) => {
    const entryContext = `${context}[${idx}]`;
    if (!isObject(entry)) {
      throw new Error(`${entryContext} must be an object`);
    }
    if (typeof entry.name !== 'string' || !entry.name.trim()) {
      throw new Error(`${entryContext}.name must be a non-empty string`);
    }
    if (names.has(entry.name)) {
      throw new Error(`${entryContext}.name must be unique within schedules`);
    }
    names.add(entry.name);
    if (typeof entry.cron !== 'string' || !entry.cron.trim()) {
      throw new Error(`${entryContext}.cron must be a non-empty string`);
    }
    if (entry.tz !== undefined && (typeof entry.tz !== 'string' || !entry.tz.trim())) {
      throw new Error(`${entryContext}.tz must be a non-empty string if provided`);
    }
    return {
      name: entry.name,
      cron: entry.cron,
      ...(typeof entry.tz === 'string' ? { tz: entry.tz } : {})
    };
  });
  return schedules.length > 0 ? schedules : undefined;
}

export function parseSandbox(
  value: unknown,
  context: string
): boolean | SandboxConfig | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  if (!isObject(value)) {
    throw new Error(`${context} must be a boolean or object if provided`);
  }
  const out: SandboxConfig = {};
  if (value.enabled !== undefined) {
    if (typeof value.enabled !== 'boolean') {
      throw new Error(`${context}.enabled must be a boolean if provided`);
    }
    out.enabled = value.enabled;
  }
  if (value.timeoutSeconds !== undefined) {
    if (
      typeof value.timeoutSeconds !== 'number' ||
      !Number.isFinite(value.timeoutSeconds) ||
      value.timeoutSeconds <= 0
    ) {
      throw new Error(`${context}.timeoutSeconds must be a positive number if provided`);
    }
    out.timeoutSeconds = value.timeoutSeconds;
  }
  const env = parseStringMap(value.env, `${context}.env`);
  if (env) out.env = env;
  return out;
}

export function parseMemory(
  value: unknown,
  context: string
): boolean | MemoryConfig | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  if (!isObject(value)) {
    throw new Error(`${context} must be a boolean or object if provided`);
  }
  const out: MemoryConfig = {};
  if (value.enabled !== undefined) {
    if (typeof value.enabled !== 'boolean') {
      throw new Error(`${context}.enabled must be a boolean if provided`);
    }
    out.enabled = value.enabled;
  }
  if (value.scopes !== undefined) {
    if (!Array.isArray(value.scopes) || value.scopes.length === 0) {
      throw new Error(`${context}.scopes must be a non-empty array if provided`);
    }
    const allowedScopes: MemoryScope[] = ['session', 'user', 'workspace'];
    const scopes = value.scopes.map((scope, idx) => {
      if (!allowedScopes.includes(scope as MemoryScope)) {
        throw new Error(`${context}.scopes[${idx}] must be one of: ${allowedScopes.join(', ')}`);
      }
      return scope as MemoryScope;
    });
    out.scopes = [...new Set(scopes)];
  }
  if (value.ttlDays !== undefined) {
    if (typeof value.ttlDays !== 'number' || !Number.isFinite(value.ttlDays) || value.ttlDays <= 0) {
      throw new Error(`${context}.ttlDays must be a positive number if provided`);
    }
    out.ttlDays = value.ttlDays;
  }
  if (value.autoPromote !== undefined) {
    if (typeof value.autoPromote !== 'boolean') {
      throw new Error(`${context}.autoPromote must be a boolean if provided`);
    }
    out.autoPromote = value.autoPromote;
  }
  if (value.dedupMs !== undefined) {
    if (typeof value.dedupMs !== 'number' || !Number.isFinite(value.dedupMs) || value.dedupMs <= 0) {
      throw new Error(`${context}.dedupMs must be a positive number if provided`);
    }
    out.dedupMs = value.dedupMs;
  }
  return out;
}

export function parseTraits(value: unknown, context: string): Traits | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) {
    throw new Error(`${context} must be an object if provided`);
  }
  const out: Traits = {};
  for (const key of ['voice', 'formality', 'proactivity', 'riskPosture', 'domain'] as const) {
    const raw = value[key];
    if (raw !== undefined) {
      if (typeof raw !== 'string' || !raw.trim()) {
        throw new Error(`${context}.${key} must be a non-empty string if provided`);
      }
      out[key] = raw;
    }
  }
  const vocabulary = parseStringList(value.vocabulary, `${context}.vocabulary`);
  if (vocabulary) out.vocabulary = vocabulary;
  if (value.preferMarkdown !== undefined) {
    if (typeof value.preferMarkdown !== 'boolean') {
      throw new Error(`${context}.preferMarkdown must be a boolean if provided`);
    }
    out.preferMarkdown = value.preferMarkdown;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function parsePersonaSpec(value: unknown, expectedIntent: PersonaIntent): PersonaSpec {
  if (!isObject(value)) {
    throw new Error(`persona[${expectedIntent}] must be an object`);
  }

  const {
    id,
    intent,
    tags,
    description,
    tiers,
    defaultTier,
    skills,
    inputs,
    env,
    mcpServers,
    permissions,
    mount,
    cloud,
    useSubscription,
    integrations,
    schedules,
    sandbox,
    memory,
    traits,
    onEvent,
    claudeMd,
    claudeMdMode,
    agentsMd,
    agentsMdMode,
    claudeMdContent,
    agentsMdContent
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
  if (!isObject(tiers)) {
    throw new Error(`persona[${expectedIntent}].tiers must be an object`);
  }

  const parsedTiers = {} as Record<PersonaTier, PersonaRuntime>;
  for (const tier of PERSONA_TIERS) {
    parsedTiers[tier] = parseRuntime(tiers[tier], `persona[${expectedIntent}].tiers.${tier}`);
  }

  let parsedDefaultTier: PersonaTier | undefined;
  if (defaultTier !== undefined) {
    if (!isTier(defaultTier)) {
      throw new Error(
        `persona[${expectedIntent}].defaultTier must be one of: ${PERSONA_TIERS.join(', ')}`
      );
    }
    parsedDefaultTier = defaultTier;
  }

  const parsedSkills = parseSkills(skills, `persona[${expectedIntent}].skills`);
  const parsedInputs = parseInputs(inputs, `persona[${expectedIntent}].inputs`);
  const parsedEnv = parseStringMap(env, `persona[${expectedIntent}].env`);
  const parsedMcpServers = parseMcpServers(mcpServers, `persona[${expectedIntent}].mcpServers`);
  const parsedPermissions = parsePermissions(
    permissions,
    `persona[${expectedIntent}].permissions`
  );
  const parsedMount = parseMount(mount, `persona[${expectedIntent}].mount`);
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
  const parsedSandbox = parseSandbox(sandbox, `persona[${expectedIntent}].sandbox`);
  const parsedMemory = parseMemory(memory, `persona[${expectedIntent}].memory`);
  const parsedTraits = parseTraits(traits, `persona[${expectedIntent}].traits`);
  if (onEvent !== undefined) {
    assertRelativePath(onEvent, `persona[${expectedIntent}].onEvent`);
  }

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
  // Spec-level mode without a spec-level path is allowed — a tier may
  // supply the path while inheriting the mode here. See parseRuntime.
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

  return {
    id,
    intent,
    tags: parsedTags,
    description,
    skills: parsedSkills,
    ...(parsedInputs ? { inputs: parsedInputs } : {}),
    tiers: parsedTiers,
    ...(parsedDefaultTier ? { defaultTier: parsedDefaultTier } : {}),
    ...(parsedEnv ? { env: parsedEnv } : {}),
    ...(parsedMcpServers ? { mcpServers: parsedMcpServers } : {}),
    ...(parsedPermissions ? { permissions: parsedPermissions } : {}),
    ...(parsedMount ? { mount: parsedMount } : {}),
    ...(typeof cloud === 'boolean' ? { cloud } : {}),
    ...(typeof useSubscription === 'boolean' ? { useSubscription } : {}),
    ...(parsedIntegrations ? { integrations: parsedIntegrations } : {}),
    ...(parsedSchedules ? { schedules: parsedSchedules } : {}),
    ...(parsedSandbox !== undefined ? { sandbox: parsedSandbox } : {}),
    ...(parsedMemory !== undefined ? { memory: parsedMemory } : {}),
    ...(parsedTraits ? { traits: parsedTraits } : {}),
    ...(typeof onEvent === 'string' ? { onEvent } : {}),
    ...(typeof claudeMd === 'string' ? { claudeMd } : {}),
    ...(claudeMdMode ? { claudeMdMode: claudeMdMode as SidecarMdMode } : {}),
    ...(typeof agentsMd === 'string' ? { agentsMd } : {}),
    ...(agentsMdMode ? { agentsMdMode: agentsMdMode as SidecarMdMode } : {}),
    ...(typeof claudeMdContent === 'string' ? { claudeMdContent } : {}),
    ...(typeof agentsMdContent === 'string' ? { agentsMdContent } : {})
  };
}

/**
 * Resolve the effective sidecar config for a (spec, tier) pair.
 *
 * Path-or-content resolution: each sidecar (`claude*`, `agents*`) is a
 * single "channel" — its `*Md` and `*MdContent` fields are tied together
 * and travel as a unit through the cascade. If the tier-level runtime
 * declares EITHER `claudeMd` or `claudeMdContent`, the tier owns the
 * channel and the top-level path/content is ignored (otherwise a tier
 * path override would silently lose to inherited inlined content, since
 * downstream consumers prefer Content over a path).
 *
 * Mode resolution: independent — a tier can set just `claudeMdMode` and
 * inherit the top-level path. Defaults to `overwrite` if neither layer
 * sets a mode. Modes are only meaningful when a path/content is present.
 */
export function resolveSidecar(
  spec: PersonaSpec,
  tier: PersonaTier
): {
  claudeMd?: string;
  claudeMdContent?: string;
  claudeMdMode: SidecarMdMode;
  agentsMd?: string;
  agentsMdContent?: string;
  agentsMdMode: SidecarMdMode;
} {
  const runtime = spec.tiers[tier];
  const tierOwnsClaude = runtime.claudeMd !== undefined || runtime.claudeMdContent !== undefined;
  const tierOwnsAgents = runtime.agentsMd !== undefined || runtime.agentsMdContent !== undefined;
  const claudePath = tierOwnsClaude ? runtime.claudeMd : spec.claudeMd;
  const claudeContent = tierOwnsClaude ? runtime.claudeMdContent : spec.claudeMdContent;
  const agentsPath = tierOwnsAgents ? runtime.agentsMd : spec.agentsMd;
  const agentsContent = tierOwnsAgents ? runtime.agentsMdContent : spec.agentsMdContent;
  return {
    ...(claudePath ? { claudeMd: claudePath } : {}),
    ...(claudeContent ? { claudeMdContent: claudeContent } : {}),
    claudeMdMode: runtime.claudeMdMode ?? spec.claudeMdMode ?? 'overwrite',
    ...(agentsPath ? { agentsMd: agentsPath } : {}),
    ...(agentsContent ? { agentsMdContent: agentsContent } : {}),
    agentsMdMode: runtime.agentsMdMode ?? spec.agentsMdMode ?? 'overwrite'
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
