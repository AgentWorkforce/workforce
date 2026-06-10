---
name: agentworkforce-repo-map
description: Canonical map of all AgentWorkforce GitHub org repos, their roles, responsibilities, and key signals. Read this before routing any issue or deciding which repo to open a PR in. Use as a seed index — always verify against the live org with `gh repo list AgentWorkforce` since new repos are created frequently.
---

# AgentWorkforce Repo Map

This skill is the canonical reference for which repo owns what in the AgentWorkforce GitHub organization. Read it before routing an issue, spawning an agent, or opening a PR.

## How to verify against the live org

```bash
# List all repos with descriptions
gh repo list AgentWorkforce --limit 100 --json name,description

# Read a specific repo's README
gh api repos/AgentWorkforce/{repo}/contents/README.md --jq '.content' | base64 -d

# Read package.json
gh api repos/AgentWorkforce/{repo}/contents/package.json --jq '.content' | base64 -d

# List top-level directory structure
gh api repos/AgentWorkforce/{repo}/contents --jq '[.[] | {name, type}]'
```

## Core repos

### `pear`
**Role**: Desktop application — the primary user-facing product.
**Stack**: Electron, TypeScript, React, relayfile mount client.
**Owns**: Claude Code session UI, renderer process, PTY I/O, relayfile mount integration, integration event rendering (Slack/Linear/GitHub panels), Pear app settings, local persona installation.
**Key signals in issues**: "pear", "desktop", "renderer", "mount", "PTY", "session", "UI", "Electron", "integration panel", "local", "writeback path", "integration-remote-paths".

### `cloud`
**Role**: Backend — Cloudflare Workers API and integration orchestration.
**Stack**: Cloudflare Workers, TypeScript, D1, KV, Durable Objects, Nango, Hono.
**Owns**: REST API, Slack/Linear/GitHub webhook consumers, Nango connection management, picker options, worker dispatch, relay worker identity, conversation sandbox, proactive agent triggers.
**Key signals in issues**: "cloud", "API", "worker", "Slack", "Linear", "webhook", "Nango", "cf-", "KV", "D1", "Durable Object", "picker", "integration event", "cloud worker".

### `agents`
**Role**: Autonomous agent harnesses deployed as persistent workers.
**Stack**: TypeScript, agent-relay SDK, relayfile.
**Owns**: pr-reviewer agent, merge-on-green logic, agent harness framework, agents deployed as long-running relay workers.
**Key signals in issues**: "pr-reviewer", "merge-on-green", "agent harness", "autonomous agent", "review bot", "persistent agent", "relay worker".

### `workforce`
**Role**: Tooling for building, installing, and running agent personas.
**Stack**: TypeScript, Node.js monorepo (pnpm workspaces).
**Owns**: persona packages (`@agentworkforce/persona-*`), CLI (`agentworkforce install`), runtime, deploy tooling, workload router, persona-kit, harness-kit.
**Key signals in issues**: "persona", "CLI", "runtime", "deploy", "workforce", "install", "agentworkforce", "persona-kit", "harness", "workload router".

### `relay`
**Role**: The core relay product — server, broker, SDK, protocol.
**Stack**: Go (server), TypeScript (SDK).
**Owns**: relay server, broker, `@agent-relay/sdk`, relay protocol, agent registration, message routing, workspace management.
**Key signals in issues**: "relay", "broker", "SDK", "@agent-relay/sdk", "relay server", "subscription", "workspace", "agent registration", "message routing".

### `relayfile-adapters`
**Role**: TypeScript packages that sync external providers into the relayfile mount.
**Stack**: TypeScript, Cloudflare Workers.
**Owns**: provider adapters (Linear, Slack, GitHub, Notion), writeback contract implementation, mount sync, event emission, adapter publish/deploy pipeline.
**Key signals in issues**: "relayfile", "adapter", "sync", "provider", "writeback protocol", "mount sync", "event emission", "relayfile-adapter", "@relayfile/".

### `skills`
**Role**: Skill packs consumed by agent personas at runtime.
**Stack**: Markdown (SKILL.md files), PRPM package manager.
**Owns**: `@agent-relay/` and `@agent-workforce/` skill namespaces, skill authoring tooling, skill discovery.
**Key signals in issues**: "skill", "SKILL.md", "skill pack", "@agent-relay/skill", "@agent-workforce/skill", "skills repo".

## Routing rules

| Issue surface | Primary repo | Secondary repo (if applicable) |
|---|---|---|
| Desktop UI, session rendering, local mount | `pear` | — |
| Slack/Linear webhook, API endpoint, Nango | `cloud` | — |
| PR reviewer, merge automation, agent harness | `agents` | — |
| Persona authoring, CLI, runtime deploy | `workforce` | — |
| Relay protocol, broker, SDK | `relay` | — |
| Writeback contract, provider sync | `relayfile-adapters` | — |
| Skill content | `skills` | — |
| Slack feature end-to-end | `cloud` + `pear` | cloud = webhook/dispatch, pear = mount/render |
| New integration (e.g. Jira) | `relayfile-adapters` + `cloud` | adapter = sync, cloud = Nango connection |
| New persona | `workforce` | — |

## Multi-repo issues

When an issue spans multiple repos, spawn one implementer per repo in parallel. Common patterns:
- **New Slack integration feature**: `cloud` (webhook + API) + `pear` (mount rendering)
- **New external provider**: `relayfile-adapters` (adapter) + `cloud` (Nango connection setup)
- **Agent behavior + UI**: `agents` (harness logic) + `pear` (rendering the agent's output)

## Disambiguation

If an issue is ambiguous, use `gh api repos/AgentWorkforce/{repo}/contents` to check directory structure of candidate repos before deciding. For example: if an issue mentions "writeback" it could be `pear` (path construction) or `relayfile-adapters` (sync protocol) — check which layer the bug is in.
