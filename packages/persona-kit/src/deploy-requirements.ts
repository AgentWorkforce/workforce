import type { IntegrationSource, PersonaInputSpec, PersonaSpec } from './types.js';

/**
 * Derive what a deployer must provide to stand up a persona, read DIRECTLY
 * from the persona definition — the single source of truth. There is no
 * separate manifest: a persona authored as `persona.ts` (via `definePersona`)
 * compiles to `persona.json` → {@link PersonaSpec}, and that parsed spec is the
 * runtime artifact loaders and the deploy CLI already read.
 *
 * One-click Layer-A deploy (into the existing shared platform) consumes this to
 * show the deployer exactly what's needed: which integrations to CONNECT and
 * which inputs to SUPPLY. Platform SST secrets are NOT a Layer-A concern (the
 * shared platform already has them) — `platformSecrets` is empty for Layer A.
 *
 * @see PersonaIntegrationConfig.optional (`required = !optional`)
 */

/** An integration the deployer must connect before the agent can fire. */
export interface RequiredIntegration {
  provider: string;
  /** Persona-declared source (defaults to `deployer_user` at parse time). */
  source?: IntegrationSource;
  /** `false` when the persona marks the integration `optional`. */
  required: boolean;
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

/**
 * A platform SST secret to seed — relevant to a Layer-B (`--isolated`) deploy
 * only. Empty for a Layer-A (shared-platform) deploy.
 */
export interface RequiredPlatformSecret {
  name: string;
  required: boolean;
  reason?: string;
  provider?: string;
}

export interface DeployRequirements {
  /**
   * Layer A: integrations to CONNECT (the deployer's only "real" prompt on the
   * shared platform). `required` integrations block the deploy until connected;
   * `optional` ones are surfaced but non-blocking.
   */
  integrations: RequiredIntegration[];
  /** Persona inputs the deployer must supply (no `default`, not `optional`). */
  inputs: RequiredInput[];
  /** Human-facing summary of what the deployed agent fires on. */
  firesOn: string[];
  /**
   * Layer-B (`--isolated`) ONLY: platform SST secrets to seed. Always empty for
   * a Layer-A shared-platform deploy. NOTE: the Layer-B backend-keyed mapping
   * (nango → NangoSecretKey+WebRelayauthApiKey; composio → ComposioApiKey+…;
   * gitlab/Nango-webhook-gap → +HookdeckSigningSecret) is derived from the
   * provider→backend registry, NOT a hand-list — that registry lives in the
   * cloud app, so this derivation lands with the `--isolated` mode (fast-follow).
   * Kept empty here to avoid a drift-prone hand-list in persona-kit.
   */
  platformSecrets: RequiredPlatformSecret[];
}

/**
 * Read a persona's declared integrations / inputs / schedules / watches and
 * derive the deploy requirements. Pure function over {@link PersonaSpec}.
 *
 * @param persona the parsed persona spec (runtime artifact)
 * @param opts.isolated reserved for Layer-B (`--isolated`); see
 *   {@link DeployRequirements.platformSecrets}. No effect on the Layer-A output.
 */
export function deriveDeployRequirements(
  persona: PersonaSpec,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- reserved for Layer-B (--isolated); see platformSecrets note
  opts: { isolated?: boolean } = {},
): DeployRequirements {
  const integrations: RequiredIntegration[] = Object.entries(
    persona.integrations ?? {},
  )
    .map(([provider, cfg]) => ({
      provider,
      ...(cfg.source ? { source: cfg.source } : {}),
      required: !cfg.optional,
      triggers: (cfg.triggers ?? []).map((t) => t.on),
    }))
    .sort((a, b) => a.provider.localeCompare(b.provider));

  const inputs: RequiredInput[] = Object.entries(
    (persona.inputs ?? {}) as Record<string, PersonaInputSpec>,
  )
    .filter(([, spec]) => spec.default === undefined && !spec.optional)
    .map(([name, spec]) => ({
      name,
      required: true,
      ...(spec.description ? { description: spec.description } : {}),
      ...(spec.env ? { env: spec.env } : {}),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const firesOn: string[] = [];
  for (const integration of integrations) {
    for (const event of integration.triggers) {
      firesOn.push(`${integration.provider}:${event}`);
    }
  }
  for (const schedule of persona.schedules ?? []) {
    firesOn.push(`schedule:${schedule.name}`);
  }
  for (const rule of persona.watch ?? []) {
    for (const event of rule.events ?? []) {
      firesOn.push(`relayfile:${event}`);
    }
  }

  return {
    integrations,
    inputs,
    firesOn: [...new Set(firesOn)],
    // Layer A: shared-platform secrets pre-exist; nothing for the deployer to
    // seed. Layer-B (--isolated) derivation is a fast-follow (see type note).
    platformSecrets: [],
  };
}
