import type { PersonaSpec } from './types.js';

/**
 * Lint a persona's integration mount `scope` globs.
 *
 * ## Why this exists
 *
 * `scope` decides two things at once: which Relayfile paths the sandbox
 * mirrors, and what the runtime token is allowed to touch. Both failure modes
 * are SILENT at runtime — a scope the mount rejects produces an empty mirror,
 * so reads come back empty and writebacks land on unmounted disk as no-ops.
 * Nothing throws. The agent simply does nothing and reports success.
 *
 * Every path rule below mirrors the authoritative validation in cloud's
 * `relayfile/mount-intent.ts`, so a path this lint rejects is one the mount
 * would also reject. The lint runs at deploy time, where the author can still
 * fix it, rather than leaving them to infer it from an agent that quietly
 * read nothing.
 *
 * ## Why only `/`-leading values are checked
 *
 * `scope` is overloaded. {@link PersonaIntegrationConfig} documents it as
 * "provider-specific filter metadata" — `{ repo: 'org/repo' }` for github,
 * `{ database: '<id>' }` for notion, `{ team: 'ENG' }` for linear — while the
 * cloud-persona docs use it for Relayfile mount globs. Both are real and in use.
 *
 * A value that does not start with `/` is therefore filter metadata, not a
 * malformed path, and this lint says nothing about it. There is no way to tell
 * `'org/repo'` (correct) from a path someone forgot to anchor, and guessing
 * wrong would fire a warning on every github and notion persona in the fleet.
 * A warning channel only works while every warning is worth reading, so this
 * one stays silent where it cannot be sure.
 */
export type ScopeLintLevel = 'warning';

/**
 * Machine-readable issue category, so callers can branch on `issue.code`
 * without parsing the human-readable `message`.
 */
export type ScopeLintCode =
  | 'scope_empty_value'
  | 'scope_untrimmed'
  | 'scope_trailing_slash'
  | 'scope_mid_path_wildcard'
  | 'scope_traversal_segment'
  | 'scope_provider_root'
  | 'scope_high_cardinality_root';

export interface ScopeLintIssue {
  level: ScopeLintLevel;
  code: ScopeLintCode;
  /** Provider slug the issue was raised under (`slack`, `linear`, …). */
  provider: string;
  /** The scope key that was flagged (`channels`, `issues`, …). */
  resource: string;
  /** Field-pointed location, e.g. `integrations.slack.scope.channels`. */
  path: string;
  message: string;
}

/**
 * Collections that grow with workspace HISTORY rather than with configuration,
 * so their size is unbounded from the persona author's point of view.
 *
 * This is a heuristic and deliberately short. It exists because the failure it
 * predicts is not otherwise visible in the glob: `/slack/channels/**` is
 * syntactically identical to `/linear/projects/**`, but one is a handful of
 * entries and the other was ~5,950 (2,008 files / 3,940 directories) in a real
 * workspace — enough that the boot mirror could not traverse it inside its
 * budget, leaving the agent running degraded and later failing outright.
 *
 * Being on this list is not an error. A read-heavy agent may genuinely need
 * the whole collection; the warning asks the author to confirm that, and points
 * write-only agents at the much cheaper single-entry scope.
 */
const HIGH_CARDINALITY_ROOTS = new Set([
  'slack/channels',
  'google-mail/messages',
  'google-mail/threads',
  'gmail/messages',
  'gmail/threads'
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Walk a persona's `integrations[].scope` globs and flag ones the runtime
 * mount would reject or silently over-mirror. Always returns; never throws.
 *
 * The deploy CLI surfaces these as yellow warnings before deploy and continues
 * regardless — same contract as {@link lintTriggers}. None of these are fatal:
 * a persona whose scope is wrong still deploys, it just will not do what its
 * author expects, and the warning is the only place that gets said out loud.
 */
export function lintScopes(persona: PersonaSpec): ScopeLintIssue[] {
  const issues: ScopeLintIssue[] = [];
  const integrations = persona.integrations;
  if (!isRecord(integrations)) return issues;

  for (const [provider, config] of Object.entries(integrations)) {
    if (!isRecord(config)) continue;

    // An empty `scope: {}` is deliberately NOT flagged: `parseIntegrationConfig`
    // drops it before the spec ever reaches this lint (it only assigns
    // `out.scope` when the parsed map is non-empty), so by deploy time it is
    // indistinguishable from an omitted scope — which is itself legitimate, as a
    // credential-only provider like an MCP server has no Relayfile side at all.
    // There is no signal here to warn on.
    const scope = config.scope;
    if (!isRecord(scope)) continue;

    for (const [resource, raw] of Object.entries(scope)) {
      if (typeof raw !== 'string') continue;
      const path = `integrations.${provider}.scope.${resource}`;

      // Lint the value DEPLOY sees, not a cleaned-up copy of it. `parseStringMap`
      // stores scope values verbatim — no trimming — so checking `raw.trim()`
      // here would clear a padded path that then fails at the mount.
      const value = raw;

      if (!value.trim()) {
        issues.push({
          level: 'warning',
          code: 'scope_empty_value',
          provider,
          resource,
          path,
          message:
            `${path} is empty, which mirrors nothing and filters nothing. Reads come ` +
            `back empty and writebacks are silent no-ops. Give it the concrete path or ` +
            `filter this agent needs, or drop the key.`
        });
        continue;
      }

      if (value !== value.trim()) {
        issues.push({
          level: 'warning',
          code: 'scope_untrimmed',
          provider,
          resource,
          path,
          message:
            `${path}: "${value}" has leading or trailing whitespace, which is stored and ` +
            `forwarded verbatim — the mount sees the padded string and will not match.`
        });
        continue;
      }

      // Everything below is a PATH rule. A value that does not start with "/" is
      // provider filter metadata (`{ repo: 'org/repo' }`), not a malformed path,
      // and is left alone — see the note on this module.
      if (!value.startsWith('/')) continue;

      if (value !== '/' && value.endsWith('/')) {
        issues.push({
          level: 'warning',
          code: 'scope_trailing_slash',
          provider,
          resource,
          path,
          message: `${path}: "${value}" has a trailing slash, which the mount rejects.`
        });
        continue;
      }

      // Only a TERMINAL `/**` is allowed. A wildcard anywhere else — the
      // classic `/slack/*/messages` — is rejected by the mount and the agent
      // silently sees an empty tree.
      const withoutGlob = value.endsWith('/**') ? value.slice(0, -3) : value;
      if (/[*?{}[\]]/u.test(withoutGlob)) {
        issues.push({
          level: 'warning',
          code: 'scope_mid_path_wildcard',
          provider,
          resource,
          path,
          message:
            `${path}: "${value}" uses a wildcard outside a terminal "/**". The mount ` +
            `accepts only a terminal "/**", so this scope mirrors nothing and the ` +
            `agent will read an empty tree without error.`
        });
        continue;
      }

      const segments = withoutGlob.split('/').slice(1);
      if (segments.some((s) => s === '' || s === '.' || s === '..')) {
        issues.push({
          level: 'warning',
          code: 'scope_traversal_segment',
          provider,
          resource,
          path,
          message: `${path}: "${value}" contains an empty or traversal ("."/"..") segment, which the mount rejects.`
        });
        continue;
      }

      // Valid, but it mirrors the provider's entire tree. This is a cost
      // warning rather than a correctness one: the mirror is traversed at
      // sandbox boot, so a collection that grows with workspace history (Slack
      // channels being the usual one) can outgrow the mount budget and leave
      // the agent running degraded — or, once a deployment cancels a
      // non-converging mount, failing outright.
      if (segments.length === 2 && value.endsWith('/**') && HIGH_CARDINALITY_ROOTS.has(segments.join('/'))) {
        issues.push({
          level: 'warning',
          code: 'scope_high_cardinality_root',
          provider,
          resource,
          path,
          message:
            `${path}: "${value}" mirrors every entry under ${segments.join('/')}, which grows ` +
            `with workspace history rather than with configuration. The mirror is traversed at ` +
            `sandbox boot, so this can outrun the mount budget and leave the agent reading an ` +
            `empty tree or failing to start. If the agent only WRITES here (posting a message, ` +
            `say), scope the single entry it targets instead — the mirror is not needed for the ` +
            `write, only the grant is.`
        });
        continue;
      }

      if (segments.length === 1 && value.endsWith('/**')) {
        issues.push({
          level: 'warning',
          code: 'scope_provider_root',
          provider,
          resource,
          path,
          message:
            `${path}: "${value}" mirrors the whole ${provider} tree. The mirror is ` +
            `traversed at sandbox boot, so this grows with workspace history and can ` +
            `outrun the mount budget. Scope the concrete subpaths the handler reads ` +
            `or writes back to instead.`
        });
      }
    }
  }

  return issues;
}
