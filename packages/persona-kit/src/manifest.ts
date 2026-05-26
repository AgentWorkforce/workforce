import { isObject } from './parse.js';
import type {
  IntegrationSource,
  PersonaInputSpec,
  PersonaSpec
} from './types.js';

/**
 * Agent manifest — the "app.json"-analog for one-click agent deploy.
 *
 * A manifest is the deployable unit a one-click deploy consumes. It is a thin
 * wrapper that references a persona (or a catalog template) and surfaces the
 * things a deployer must provide so the platform can prompt for exactly those.
 * It intentionally does NOT redefine persona concepts — integrations, triggers,
 * schedules, and inputs all live on the `PersonaSpec`. The manifest only adds:
 *   - a stable deployable identity (`name`) + where it comes from
 *     (`persona` ref or catalog `template`),
 *   - per-provider deploy hints (`required`, `reason`) layered over the
 *     persona's integrations,
 *   - an explicit `secrets` block that matters ONLY for Layer-B isolated-stage
 *     deploys (see {@link deriveDeployRequirements}).
 *
 * @see docs/one-click-agent-deploy.md (cloud repo) for the design + the
 * Layer A (deploy into the shared platform) vs Layer B (isolated stage) split.
 */
export const AGENT_MANIFEST_SCHEMA = 'agent-manifest/v1' as const;

/**
 * Per-provider deploy hint, layered over the persona's
 * `integrations.<provider>` config. On a Layer-A deploy, `required` providers
 * must have a live workspace connection before the agent can fire.
 */
export interface AgentManifestIntegration {
  /** Override the persona's integration source for this provider. */
  source?: IntegrationSource;
  /** Provider-specific scope, e.g. `{ repo: "org/name" }`. */
  scope?: Record<string, string>;
  /**
   * Whether a live connection is required before deploy. Defaults to `true`:
   * a declared integration is assumed load-bearing unless explicitly optional.
   */
  required?: boolean;
  /** Human-readable reason shown in the deploy prompt / dashboard form. */
  reason?: string;
}

/**
 * Platform SST-secret declaration. Relevant to **Layer B** (`--isolated`)
 * deploys ONLY: when standing up a fresh isolated stage, these secrets must be
 * seeded (see `scripts/seed-adhoc-stage-secrets.sh` in the cloud repo). On the
 * shared platform (Layer A — the MVP) these already exist and are NEVER seeded
 * per-agent, so a Layer-A deploy ignores this block entirely.
 */
export interface AgentManifestSecret {
  /** Whether the secret must hold a real value (vs a placeholder) to function. */
  required: boolean;
  /** Human-readable reason shown when prompting in `--isolated` mode. */
  reason?: string;
  /** Optional provider association for grouping in UIs. */
  provider?: string;
}

export interface AgentManifest {
  /** Schema discriminator. Must be {@link AGENT_MANIFEST_SCHEMA}. */
  schema: typeof AGENT_MANIFEST_SCHEMA;
  /** Display name for the deployed agent. Defaults to the persona id. */
  name?: string;
  /**
   * Path/ref to a `persona.json` (or `persona.ts`) — the deployable unit.
   * Exactly one of `persona` or `template` must be set.
   */
  persona?: string;
  /**
   * Catalog template id (e.g. `cloud-small-issue-codex`) — an alternative to
   * an explicit `persona` ref. Exactly one of `persona` or `template` must be
   * set.
   */
  template?: string;
  /** Target workspace. Defaults to the active workspace at deploy time. */
  workspace?: string;
  /** Per-provider deploy hints layered over the persona's integrations. */
  integrations?: Record<string, AgentManifestIntegration>;
  /** Platform secrets — Layer-B (`--isolated`) only. */
  secrets?: Record<string, AgentManifestSecret>;
  /** Pre-filled persona input values, keyed by input name. */
  inputs?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Parsing / validation (mirrors parse.ts: plain functions, throws Error with
// field-pointed messages, never returns a partially-valid object).
// ---------------------------------------------------------------------------

function fail(message: string): never {
  throw new Error(`Invalid agent manifest: ${message}`);
}

function parseManifestIntegration(
  value: unknown,
  provider: string
): AgentManifestIntegration {
  if (!isObject(value)) {
    fail(`integrations.${provider} must be an object`);
  }
  const out: AgentManifestIntegration = {};
  if (value.source !== undefined) {
    // Defer deep IntegrationSource validation to persona-kit's
    // parseIntegrationSource at the persona layer; here we only require an
    // object with a string `kind` so the manifest stays a thin overlay.
    if (!isObject(value.source) || typeof value.source.kind !== 'string') {
      fail(`integrations.${provider}.source must be an object with a string "kind"`);
    }
    out.source = value.source as IntegrationSource;
  }
  if (value.scope !== undefined) {
    if (!isObject(value.scope)) {
      fail(`integrations.${provider}.scope must be an object`);
    }
    const scope: Record<string, string> = {};
    for (const [k, v] of Object.entries(value.scope)) {
      if (typeof v !== 'string') {
        fail(`integrations.${provider}.scope.${k} must be a string`);
      }
      scope[k] = v;
    }
    out.scope = scope;
  }
  if (value.required !== undefined) {
    if (typeof value.required !== 'boolean') {
      fail(`integrations.${provider}.required must be a boolean`);
    }
    out.required = value.required;
  }
  if (value.reason !== undefined) {
    if (typeof value.reason !== 'string') {
      fail(`integrations.${provider}.reason must be a string`);
    }
    out.reason = value.reason;
  }
  return out;
}

function parseManifestSecret(value: unknown, name: string): AgentManifestSecret {
  if (!isObject(value)) {
    fail(`secrets.${name} must be an object`);
  }
  if (typeof value.required !== 'boolean') {
    fail(`secrets.${name}.required must be a boolean`);
  }
  const out: AgentManifestSecret = { required: value.required };
  if (value.reason !== undefined) {
    if (typeof value.reason !== 'string') fail(`secrets.${name}.reason must be a string`);
    out.reason = value.reason;
  }
  if (value.provider !== undefined) {
    if (typeof value.provider !== 'string') fail(`secrets.${name}.provider must be a string`);
    out.provider = value.provider;
  }
  return out;
}

/**
 * Validate an arbitrary value as an {@link AgentManifest}. Throws a descriptive
 * `Error` on any shape violation; returns a normalized manifest on success.
 * Mirrors {@link parsePersonaSpec}'s contract so the deploy CLI can treat both
 * the same way.
 */
export function parseAgentManifest(value: unknown): AgentManifest {
  if (!isObject(value)) {
    fail('manifest must be a JSON object');
  }
  if (value.schema !== AGENT_MANIFEST_SCHEMA) {
    fail(`schema must be "${AGENT_MANIFEST_SCHEMA}" (got ${JSON.stringify(value.schema)})`);
  }

  const hasPersona = typeof value.persona === 'string' && value.persona.length > 0;
  const hasTemplate = typeof value.template === 'string' && value.template.length > 0;
  if (value.persona !== undefined && typeof value.persona !== 'string') {
    fail('persona must be a string path/ref');
  }
  if (value.template !== undefined && typeof value.template !== 'string') {
    fail('template must be a string id');
  }
  if (hasPersona === hasTemplate) {
    fail('exactly one of "persona" or "template" must be set');
  }

  const manifest: AgentManifest = { schema: AGENT_MANIFEST_SCHEMA };
  if (hasPersona) manifest.persona = value.persona as string;
  if (hasTemplate) manifest.template = value.template as string;

  if (value.name !== undefined) {
    if (typeof value.name !== 'string') fail('name must be a string');
    manifest.name = value.name;
  }
  if (value.workspace !== undefined) {
    if (typeof value.workspace !== 'string') fail('workspace must be a string');
    manifest.workspace = value.workspace;
  }

  if (value.integrations !== undefined) {
    if (!isObject(value.integrations)) fail('integrations must be an object');
    const integrations: Record<string, AgentManifestIntegration> = {};
    for (const [provider, cfg] of Object.entries(value.integrations)) {
      integrations[provider] = parseManifestIntegration(cfg, provider);
    }
    manifest.integrations = integrations;
  }

  if (value.secrets !== undefined) {
    if (!isObject(value.secrets)) fail('secrets must be an object');
    const secrets: Record<string, AgentManifestSecret> = {};
    for (const [name, cfg] of Object.entries(value.secrets)) {
      secrets[name] = parseManifestSecret(cfg, name);
    }
    manifest.secrets = secrets;
  }

  if (value.inputs !== undefined) {
    if (!isObject(value.inputs)) fail('inputs must be an object');
    const inputs: Record<string, string> = {};
    for (const [k, v] of Object.entries(value.inputs)) {
      if (typeof v !== 'string') fail(`inputs.${k} must be a string`);
      inputs[k] = v;
    }
    manifest.inputs = inputs;
  }

  return manifest;
}

// ---------------------------------------------------------------------------
// Deploy requirements derivation — the "minimal real-secret prompt" logic.
// ---------------------------------------------------------------------------

/**
 * Default platform-secret mapping for Layer-B (`--isolated`) deploys: which SST
 * platform secrets must hold a REAL value for an integration provider to
 * function in a freshly-seeded isolated stage.
 *
 * Every Relayfile integration provider resolves per-workspace credentials
 * through Nango (`NangoSecretKey`) and mints a relayfile access token through
 * RelayAuth (`WebRelayauthApiKey`) — verified in the cloud repo
 * (`nango-service.ts`, `relayfile.ts`). The RS256 signing keypair
 * (`RelayauthSigningKeyPem`/`Public`) is GENERATED by the seed script, not
 * prompted, so it is not listed here. Everything else placeholders.
 *
 * On a Layer-A (shared-platform) deploy this mapping is NOT used: those
 * platform secrets already exist and are never seeded per-agent.
 */
export const DEFAULT_INTEGRATION_PLATFORM_SECRETS: Readonly<Record<string, readonly string[]>> = {
  github: ['NangoSecretKey', 'WebRelayauthApiKey'],
  slack: ['NangoSecretKey', 'WebRelayauthApiKey'],
  linear: ['NangoSecretKey', 'WebRelayauthApiKey'],
  notion: ['NangoSecretKey', 'WebRelayauthApiKey'],
  jira: ['NangoSecretKey', 'WebRelayauthApiKey'],
  gmail: ['NangoSecretKey', 'WebRelayauthApiKey'],
  dropbox: ['NangoSecretKey', 'WebRelayauthApiKey']
};

/** An integration the deployer must connect (Layer A) before the agent fires. */
export interface RequiredIntegration {
  provider: string;
  source?: IntegrationSource;
  required: boolean;
  reason?: string;
  /** Trigger event names declared on the persona for this provider. */
  triggers: string[];
}

/** A persona input the deployer must supply a value for. */
export interface RequiredInput {
  name: string;
  required: boolean;
  description?: string;
  /** Env var the launcher reads when no explicit value is given. */
  env?: string;
}

/** A platform SST secret to seed — Layer-B (`--isolated`) only. */
export interface RequiredPlatformSecret {
  name: string;
  required: boolean;
  reason?: string;
  provider?: string;
}

export interface DeployRequirements {
  /**
   * Layer A: providers that must have a live workspace connection. This IS the
   * "minimal real-secret prompt" for a shared-platform deploy — connect these
   * integrations; no SST secrets are touched.
   */
  integrations: RequiredIntegration[];
  /** Persona inputs the deployer must supply (no default, not optional, not pre-filled). */
  inputs: RequiredInput[];
  /**
   * Layer B (`--isolated`) ONLY: platform SST secrets to seed. Empty for a
   * shared-platform deploy.
   */
  platformSecrets: RequiredPlatformSecret[];
}

/**
 * Derive the minimal set of things a deployer must provide for a one-click
 * deploy: which integrations to connect, which inputs to supply, and (only in
 * `--isolated` mode) which platform secrets to seed.
 *
 * @param manifest parsed {@link AgentManifest}
 * @param persona  the resolved {@link PersonaSpec} the manifest points at
 * @param opts.isolated when true, compute Layer-B platform secrets; default false
 */
export function deriveDeployRequirements(
  manifest: AgentManifest,
  persona: PersonaSpec,
  opts: { isolated?: boolean } = {}
): DeployRequirements {
  const personaIntegrations = persona.integrations ?? {};
  const manifestIntegrations = manifest.integrations ?? {};
  const providers = new Set<string>([
    ...Object.keys(personaIntegrations),
    ...Object.keys(manifestIntegrations)
  ]);

  const integrations: RequiredIntegration[] = [];
  for (const provider of providers) {
    const personaCfg = personaIntegrations[provider];
    const manifestCfg = manifestIntegrations[provider];
    const triggers = (personaCfg?.triggers ?? []).map((t) => t.on);
    integrations.push({
      provider,
      source: manifestCfg?.source ?? personaCfg?.source,
      // A declared integration is required unless the manifest opts it out.
      required: manifestCfg?.required ?? true,
      reason: manifestCfg?.reason,
      triggers
    });
  }
  integrations.sort((a, b) => a.provider.localeCompare(b.provider));

  const inputs: RequiredInput[] = [];
  const personaInputs = persona.inputs ?? {};
  const prefilled = manifest.inputs ?? {};
  for (const [name, spec] of Object.entries(personaInputs) as [string, PersonaInputSpec][]) {
    if (name in prefilled) continue; // manifest supplies it already
    if (spec.default !== undefined) continue; // has a literal fallback
    if (spec.optional) continue; // absence is meaningful, no prompt needed
    inputs.push({ name, required: true, description: spec.description, env: spec.env });
  }
  inputs.sort((a, b) => a.name.localeCompare(b.name));

  const platformSecrets: RequiredPlatformSecret[] = [];
  if (opts.isolated) {
    const seen = new Set<string>();
    // Manifest-declared secrets win (explicit override).
    for (const [name, cfg] of Object.entries(manifest.secrets ?? {})) {
      seen.add(name);
      platformSecrets.push({
        name,
        required: cfg.required,
        reason: cfg.reason,
        provider: cfg.provider
      });
    }
    // Augment with the default mapping for each declared provider.
    for (const provider of providers) {
      for (const secret of DEFAULT_INTEGRATION_PLATFORM_SECRETS[provider] ?? []) {
        if (seen.has(secret)) continue;
        seen.add(secret);
        platformSecrets.push({
          name: secret,
          required: true,
          reason: `required for the ${provider} integration to function`,
          provider
        });
      }
    }
    platformSecrets.sort((a, b) => a.name.localeCompare(b.name));
  }

  return { integrations, inputs, platformSecrets };
}
