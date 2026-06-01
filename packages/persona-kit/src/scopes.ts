/**
 * Per-provider connection **scope** keys, sourced from
 * `@relayfile/adapter-core/scopes` (the `KNOWN_SCOPE_CATALOG` generated from
 * each adapter's `supportedScopes()`). Scope keys are the user-facing filter
 * params a persona may set under `integrations.<provider>.scope` (e.g. github
 * → `owner`/`repo`) — distinct from triggers (which live on the agent) and
 * from infra config.
 *
 * Mirrors {@link ./triggers.ts} so persona authoring can autocomplete + lint
 * scope keys per provider the same way it does trigger names. The cloud adapter
 * remains the source of truth at runtime; unknown keys are still accepted.
 */
export {
  KNOWN_SCOPE_CATALOG,
  ADAPTERS_WITHOUT_KNOWN_SCOPES,
  type KnownScopeProviderName,
  type KnownScopeKey
} from '@relayfile/adapter-core/scopes';
