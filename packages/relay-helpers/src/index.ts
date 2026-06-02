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
 * Every provider in the catalog has a named client (`asanaClient`,
 * `notionClient`, … through all 29), exposing its resources as
 * `.{resource}.{path,write,read,list}`. `linear` / `github` / `slack` add
 * named ergonomic methods on top. `relayClient(provider)` is the dynamic,
 * string-keyed escape hatch when the provider isn't known at author time.
 */
export { relayClient, encodeSegment, type RelayClient, type RelayParams } from './generic.js';
export { providerClient, type ProviderClient, type ResourceClient } from './provider-client.js';
export { created } from './receipt.js';

// Ergonomic clients (resource-keyed access + named methods).
export { linearClient, type LinearClient, type LinearCreateIssueArgs } from './linear.js';
export { githubClient, type GithubClient, type GithubTarget } from './github.js';
export { slackClient, type SlackClient } from './slack.js';

// Named resource-keyed clients for the remaining catalog providers
// (generated from the catalog — see scripts/generate-clients.mjs).
// `export *` so a newly-added provider needs only a re-`gen`, no edit here.
export * from './generated/clients.js';

export type { IntegrationClientOptions, WritebackResult } from '@agentworkforce/runtime/clients';
