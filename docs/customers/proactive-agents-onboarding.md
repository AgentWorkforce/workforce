# Proactive Agents Onboarding

This guide walks the first customer through deploying the Notion to essay PR agent without hand-editing workspace auth environment variables.

## Prerequisites

Install Node.js 22 or newer and npm. You also need access to the AgentRelay workspace that will own the agent, a Notion database to watch, and a GitHub repository where the `release-bot` workspace service account can open pull requests.

## Install And Login

Install the CLI:

```bash
npm install -g @agentworkforce/cli
```

Then sign in once:

```bash
agentworkforce login
```

The login command opens a browser, signs you in to Agent Relay cloud, lets you choose a workspace, and prints its cloud workspace id. Later `deploy`, `deployments list` and `destroy` commands reuse that session automatically, so you do not need to set `WORKFORCE_WORKSPACE_ID` or `WORKFORCE_WORKSPACE_TOKEN`. If you do set them (for CI), the id must be the cloud workspace id (UUID), not the `rw_…` relaycast id, and the token must be a cloud access token, not the `rk_live_…` key from `workspaces.json` — see the CLI README's "Login and workspace ids" section.

## Configure The Persona

Copy `examples/notion-essay-pr/persona.json` into your project and set the two inputs when deploying:

```bash
export NOTION_SOURCE_DATABASE="your-notion-database-id"
export GITHUB_TARGET_REPO="owner/repo"
```

The persona listens for `page.created` events in the configured Notion database, uses workspace memory, writes the essay to `/workspace/output/<page-id>.md`, and opens a GitHub PR through the workspace service account named `release-bot`.

## Deploy

Run:

```bash
agentworkforce deploy ./persona.json --mode cloud
```

If Notion or GitHub are not connected for the workspace yet, the CLI will walk you through connecting them in the browser before creating the deployment.

## Verify And Test

List the running agent:

```bash
agentworkforce list
```

Create a new page in the configured Notion database. After the event is delivered, check the target GitHub repository for a pull request titled `Essay: <page-title>`.

## Tear Down

When you are done, destroy the agent:

```bash
agentworkforce destroy <agentId>
```
