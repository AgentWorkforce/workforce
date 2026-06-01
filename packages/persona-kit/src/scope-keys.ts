/**
 * Per-provider connection **scope keys**, sourced from
 * `@relayfile/adapter-core/scope-keys` (the `KNOWN_SCOPE_KEY_CATALOG` generated
 * from each adapter's `supportedScopeKeys()`). These are the user-facing filter
 * params a persona may set under `integrations.<provider>.scope` (e.g. github
 * → `owner`/`repo`) — distinct from triggers (which live on the agent), from
 * infra config, and from OAuth permission scopes.
 *
 * Mirrors {@link ./triggers.ts} so persona authoring can autocomplete + lint
 * scope keys per provider the same way it does trigger names. The cloud adapter
 * remains the source of truth at runtime; unknown keys are still accepted.
 */
export {
  KNOWN_SCOPE_KEY_CATALOG,
  ADAPTERS_WITHOUT_KNOWN_SCOPE_KEYS,
  type ScopeKeyProvider,
  type ScopeKey
} from '@relayfile/adapter-core/scope-keys';
