/**
 * `@agentworkforce/relay-helpers` — ergonomic, catalog-backed provider clients
 * for Workforce agent handlers.
 *
 * The runtime exposes only generic VFS helpers (`writeJsonFile`, `readJsonFile`,
 * …); the per-provider typed clients (`ctx.linear.comment(...)`) were removed.
 * This package recovers that ergonomics as an opt-in factory, with every path
 * sourced from `@relayfile/adapter-core/writeback-paths` (the adapter-owned
 * source of truth) instead of hardcoded — so paths never drift from the
 * adapter that materializes the draft.
 *
 *   import { linearClient } from '@agentworkforce/relay-helpers';
 *   const linear = linearClient();              // binds the mount root once
 *   const issue = await linear.getIssue(issueId);
 *   await linear.comment(issueId, ':rocket: done');
 *
 * `relayClient(provider)` gives the same transport for any of the 29 providers
 * in the catalog, with generic `write` / `read` / `list` methods.
 */
export { relayClient, encodeSegment, type RelayClient, type RelayParams } from './generic.js';
export { linearClient, type LinearClient } from './linear.js';
export { githubClient, type GithubClient, type GithubTarget } from './github.js';
export { slackClient, type SlackClient } from './slack.js';
export { created } from './receipt.js';
export type { IntegrationClientOptions, WritebackResult } from '@agentworkforce/runtime/clients';
