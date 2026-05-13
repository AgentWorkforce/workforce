# Review Agent

This deployable persona listens for GitHub pull request events and Slack mentions, delegates code reasoning to the configured harness, and posts the result back through the connected integration.

## Setup

Connect GitHub and Slack before deploying. Because `useSubscription` is enabled, deployment also connects the model provider derived from the persona's `model` field.

⚠️ **Memory is not wired.** `ctx.memory` is a stub in v1; see `docs/plans/deploy-v1-schema-cascade-spec.md` § Loud hole. Memory wiring lands in a follow-up workflow (not yet specced).

```bash
workforce deploy ./examples/review-agent/persona.json --mode dev
```

## Events

The persona handles opened pull requests, issue comment mentions, pull request review comments, failed check runs, and Slack app mentions.

## Run

```bash
workforce deploy ./examples/review-agent/persona.json --mode sandbox
```
