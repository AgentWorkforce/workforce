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

The login command opens a browser, completes PKCE auth, lets you choose a workspace, and stores the workspace-scoped deploy token in keychain-backed storage.

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
