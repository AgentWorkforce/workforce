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
  McpServerSpec,
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
  SidecarMdMode
} from './types.js';

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
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
    if (dangerouslyBypassApprovalsAndSandbox) {
      const conflicts: string[] = [];
      if (sandboxMode !== undefined) conflicts.push('sandboxMode');
      if (approvalPolicy !== undefined) conflicts.push('approvalPolicy');
      if (workspaceWriteNetworkAccess !== undefined) conflicts.push('workspaceWriteNetworkAccess');
      if (conflicts.length > 0) {
        throw new Error(
          `${context}.dangerouslyBypassApprovalsAndSandbox is mutually exclusive with: ${conflicts.join(', ')}`
        );
      }
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
