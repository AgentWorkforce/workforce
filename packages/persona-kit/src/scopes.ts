import { KNOWN_TRIGGER_CATALOG } from '@relayfile/adapter-core/triggers';

/**
 * Per-provider connection **scope** keys for typed persona authoring.
 *
 * Scope keys are the user-facing filter params a persona may set under
 * `integrations.<provider>.scope` (for example, github uses `owner`/`repo`).
 * They are distinct from triggers, which live on the agent, and from infra
 * config such as the integration connection source.
 *
 * The cloud adapter remains the source of truth at runtime; unknown keys are
 * still accepted by the typed authoring helpers for forward compatibility.
 */
export const KNOWN_SCOPE_CATALOG = {
  github: ['owner', 'repo'],
  linear: ['team'],
  notion: ['database'],
  slack: ['channel']
} as const satisfies Record<string, readonly string[]>;

export type KnownScopeProviderName = keyof typeof KNOWN_SCOPE_CATALOG;

export type KnownScopeKey<P extends KnownScopeProviderName> =
  (typeof KNOWN_SCOPE_CATALOG)[P][number];

export const ADAPTERS_WITHOUT_KNOWN_SCOPES = Object.keys(KNOWN_TRIGGER_CATALOG)
  .filter((provider) => !(provider in KNOWN_SCOPE_CATALOG))
  .map((provider) => ({
    provider,
    reason: 'No persona-kit connection scope keys are catalogued for this provider'
  }));
