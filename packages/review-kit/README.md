# @agentworkforce/review-kit

Strongly typed factories for charter-driven GitHub pull-request reviewers. The
kit owns event parsing, repo/draft/label gates, evidence collection, read-only
checkout configuration, comment delivery, and retry idempotency; a reviewer
supplies its lens, charter, and evidence.

```ts
// agent.ts
import {
  defineReviewAgent,
  gitHistory,
  prDiff
} from '@agentworkforce/review-kit';

export default defineReviewAgent({
  repo: 'AgentWorkforce/workforce',
  charter: '.agentworkforce/workforce/personas/maintainability.md',
  lens: 'maintainability',
  evidence: [prDiff(), gitHistory()]
});
```

```ts
// persona.ts
import { defineReviewPersona } from '@agentworkforce/review-kit';

export default defineReviewPersona({
  repo: 'AgentWorkforce/workforce',
  lens: 'maintainability',
  systemPrompt: 'Review maintainability against the checked-in charter.',
  fetchDepth: 'full'
});
```

Custom evidence providers implement `ReviewEvidenceProvider`, or use
`defineReviewEvidence()` to preserve a literal provider name.

## Encoded failure boundaries

The factory deliberately encodes the seven silent failures from workforce
issue #281:

1. It accepts flattened, raw nested, and normalized Relayfile PR payloads.
2. Trigger paths are concrete strings in the extracted agent spec.
3. Every trigger mounts both `pulls/**` and `issues/**`, because PR comments
   use GitHub's issue-comment path.
4. GitHub triggers never declare `where`; the handler retains a repo guard.
5. The persona enables PR checkout but keeps branch writeback off. This relies
   on the clone-only credential contract fixed in AgentWorkforce/cloud#2664.
6. Comment writes are fire-and-forget. A missing receipt is logged as
   unconfirmed and is never turned into a delivery retry. The kit requires a
   real Relayfile mount because durable dedupe must read canonical comments; it
   never mixes filesystem reads with HTTP writes or writes a stray cwd draft.
7. The comment command path and hidden audit marker are keyed by lens + head
   SHA. A retry sees the existing command and skips before running the harness.

The factory also logs its package version on each handler invocation, making
the bundled review-kit version visible in deployed logs.
