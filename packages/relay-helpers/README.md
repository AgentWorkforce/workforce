# @agentworkforce/relay-helpers

Ergonomic, catalog-backed provider clients for Workforce agent handlers.

The runtime exposes only generic VFS helpers (`writeJsonFile`, `readJsonFile`, …);
the per-provider typed clients (`ctx.linear.comment(...)`) were removed. This
package recovers that ergonomics as an **opt-in factory**, with every path
sourced from [`@relayfile/adapter-core/writeback-paths`](https://www.npmjs.com/package/@relayfile/adapter-core)
(the adapter-owned source of truth) instead of hardcoded — so paths never drift
from the adapter that materializes the draft.

```ts
import { linearClient, githubClient, slackClient } from '@agentworkforce/relay-helpers';

const linear = linearClient();             // binds the mount root once (RELAYFILE_MOUNT_ROOT)
const issue = await linear.getIssue(issueId);
await linear.comment(issueId, ':rocket: done');

await githubClient().merge({ owner, repo, number });
await slackClient().post('#eng', 'shipped');
```

## A named client for every provider

Every provider in the catalog has a named client (`asanaClient`, `notionClient`,
`jiraClient`, … — all 29), exposing its resources as
`.{resource}.{path,write,read,list}`:

```ts
import { notionClient } from '@agentworkforce/relay-helpers';

const notion = notionClient();
notion.pages.path({ databaseId });                  // resolve a path (no IO)
await notion.pages.write({ databaseId }, { /* … */ }); // collection create or item write
await notion.pages.list({ databaseId });               // list a collection
```

- `write(params, body)` drops a uniquely-named draft for a collection resource,
  or writes directly to an item resource (a path ending in `.json`). The
  Relayfile writeback worker turns the draft into the real provider call.
- `read` / `list` operate over the catalog paths.
- Unknown providers/resources or missing path params throw loudly — never a
  guessed path.

`linearClient` / `githubClient` / `slackClient` are the same resource-keyed
clients **plus** named ergonomic methods (`comment`, `post`, `mergePullRequest`,
…). `relayClient(provider)` is the dynamic, string-keyed escape hatch when the
provider isn't known at author time.
