import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const DEFAULT_STAGING_URL = 'https://staging.agentrelay.cloud/cloud';
const FIXTURE_REPO = envValue('WORKFORCE_E2E_FIXTURE_REPO') ?? 'AgentWorkforce/deploy-e2e-fixtures';
const ISSUE_TITLE_RE = /^Weekly digest\s+—\s+/u;
const POLL_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 5_000;
const READY_DEPLOYMENT_STATUSES = new Set(['active', 'ready', 'live', 'running']);

test(
  'weekly-digest deploys to staging cloud and fires from a cron tick',
  { timeout: 240_000 },
  async (t) => {
    const stagingToken = process.env.WORKFORCE_E2E_STAGING_TOKEN?.trim();
    if (!stagingToken) {
      console.log('SMOKE_TEST: SKIP — WORKFORCE_E2E_STAGING_TOKEN is unset');
      t.skip('WORKFORCE_E2E_STAGING_TOKEN is unset');
      return;
    }

    const workspaceId = (
      process.env.WORKFORCE_E2E_STAGING_WORKSPACE_ID ??
      process.env.WORKFORCE_WORKSPACE_ID ??
      ''
    ).trim();
    if (!workspaceId) {
      console.log('SMOKE_TEST: SKIP — WORKFORCE_E2E_STAGING_WORKSPACE_ID is unset');
      t.skip('WORKFORCE_E2E_STAGING_WORKSPACE_ID is unset');
      return;
    }

    const stagingUrl = normalizeBaseUrl(
      envValue('WORKFORCE_E2E_STAGING_URL') ?? envValue('WORKFORCE_CLOUD_URL') ?? DEFAULT_STAGING_URL
    );
    const startedAt = new Date(Date.now() - 120_000);

    try {
      const repoRoot = process.cwd();
      const personaPath = path.resolve(repoRoot, 'examples/weekly-digest/persona.json');
      const outDir = path.resolve(repoRoot, '.workforce/build/smoke-weekly-digest');

      const { persona } = await buildBundleLocally({ personaPath, outDir });
      assert.equal(persona.id, 'weekly-digest');

      let deployedAgentId;
      let deployedDeploymentId;
      try {
        const deploy = await deployViaCloudCli({
          repoRoot,
          personaPath,
          stagingUrl,
          stagingToken,
          workspaceId
        });

        const agentId = await resolveAgentId({
          stagingUrl,
          stagingToken,
          workspaceId,
          deployOutput: deploy.combinedOutput,
          personaId: persona.id
        });
        assert.ok(agentId, `expected deployed agent id in CLI output or cloud agent lookup`);
        deployedAgentId = agentId;

        const deploymentId = await resolveDeploymentId({
          stagingUrl,
          stagingToken,
          workspaceId,
          deployOutput: deploy.combinedOutput,
          agentId,
          personaId: persona.id
        });
        assert.ok(deploymentId, `expected deployment id in CLI output or cloud deployment lookup`);
        deployedDeploymentId = deploymentId;

        const tick = await forceCronTick({ stagingUrl, stagingToken, workspaceId, agentId });
        if (tick.skipped) {
          const status = await readDeploymentStatus({
            stagingUrl,
            stagingToken,
            workspaceId,
            deploymentId
          });
          assert.ok(
            READY_DEPLOYMENT_STATUSES.has(status),
            `expected ready deployment when test tick hook is unavailable; got ${String(status)}`
          );
          console.log(
            `SMOKE_TEST: PASS — deployed ${deploymentId}; tick hook unavailable, deployment status ${status} verified`
          );
          return;
        }

        const issue = await waitForWeeklyDigestIssue({ since: startedAt });
        assert.match(issue.title, ISSUE_TITLE_RE);
        await closeIssue(issue).catch((err) => {
          console.warn(`SMOKE_TEST: cleanup warning — failed to close issue #${issue.number}: ${messageOf(err)}`);
        });

        console.log(`SMOKE_TEST: PASS — deployed ${deploymentId}; issue #${issue.number} observed`);
      } finally {
        if (deployedAgentId || deployedDeploymentId) {
          await destroyDeployment({
            stagingUrl,
            stagingToken,
            workspaceId,
            agentId: deployedAgentId,
            deploymentId: deployedDeploymentId
          }).catch((err) => {
            console.warn(`SMOKE_TEST: cleanup warning — failed to destroy deployment: ${messageOf(err)}`);
          });
        }
      }
    } catch (err) {
      console.error(`SMOKE_TEST: FAIL — ${messageOf(err)}`);
      throw err;
    }
  }
);

async function buildBundleLocally({ personaPath, outDir }) {
  const raw = JSON.parse(await readFile(personaPath, 'utf8'));
  const { parsePersonaSpec } = await importDist('packages/persona-kit/dist/index.js');
  const deployModule = await importDist('packages/deploy/dist/index.js');
  const persona = parsePersonaSpec(raw, raw.intent ?? 'documentation');

  await mkdir(outDir, { recursive: true });
  const stageBundle =
    deployModule.stageBundle ??
    ((input) => {
      const stager = deployModule.bundleStager;
      if (!stager?.stage) {
        throw new Error('deploy package does not export stageBundle or bundleStager.stage');
      }
      return stager.stage(input);
    });

  const bundle = await stageBundle({ personaPath, persona, outDir });
  for (const key of ['runnerPath', 'bundlePath', 'packageJsonPath']) {
    assert.ok(bundle[key], `bundle missing ${key}`);
  }
  return { persona, bundle };
}

async function deployViaCloudCli({ repoRoot, personaPath, stagingUrl, stagingToken, workspaceId }) {
  const args = [
    path.resolve(repoRoot, 'packages/cli/dist/cli.js'),
    'deploy',
    personaPath,
    '--mode',
    'cloud',
    '--cloud-url',
    stagingUrl,
    '--workspace',
    workspaceId,
    '--no-connect',
    '--input',
    `WEEKLY_DIGEST_REPO=${FIXTURE_REPO}`,
    '--input',
    'WEEKLY_DIGEST_TOPICS=agentworkforce,relayfile,proactive-agents',
    '--detach'
  ];
  const env = {
    ...process.env,
    WORKFORCE_CLOUD_URL: stagingUrl,
    WORKFORCE_E2E_STAGING_URL: stagingUrl,
    WORKFORCE_WORKSPACE_ID: workspaceId,
    WORKFORCE_WORKSPACE_TOKEN: stagingToken,
    WORKFORCE_INTEGRATION_GITHUB_TOKEN: githubToken()
  };

  const result = await runNode(args, { cwd: repoRoot, env, timeoutMs: 120_000 });
  if (result.code !== 0) {
    throw new Error(
      `cloud deploy CLI exited ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    );
  }
  return { ...result, combinedOutput: `${result.stdout}\n${result.stderr}` };
}

async function resolveAgentId({ stagingUrl, stagingToken, workspaceId, deployOutput, personaId }) {
  const parsed = parseOutputId(deployOutput, ['agentId'], [
    /\bagentId["' ]*[:=]["' ]*([A-Za-z0-9_-]+)/,
    /\bagent\s+([0-9a-f-]{20,})\b/i
  ]);
  if (parsed) return parsed;

  const queryUrls = [
    `${stagingUrl}/api/v1/workspaces/${encodeURIComponent(workspaceId)}/agents?persona_slug=${encodeURIComponent(personaId)}`,
    `${stagingUrl}/api/v1/workspaces/${encodeURIComponent(workspaceId)}/agents?persona_id=${encodeURIComponent(personaId)}`
  ];
  for (const url of queryUrls) {
    const res = await fetch(url, { headers: authHeaders(stagingToken) });
    if (!res.ok) continue;
    const payload = await res.json();
    const candidate = firstAgent(payload);
    if (candidate?.id) return String(candidate.id);
  }
  return undefined;
}

async function resolveDeploymentId({ stagingUrl, stagingToken, workspaceId, deployOutput, agentId, personaId }) {
  const parsed = parseOutputId(deployOutput, ['deploymentId', 'id'], [
    /\bdeploymentId["' ]*[:=]["' ]*([A-Za-z0-9_-]+)/,
    /\bdeployment\s+([A-Za-z0-9_-]{8,})\b/i,
    /\bok:\s*([A-Za-z0-9_-]{8,})\b/
  ]);
  if (parsed && parsed !== personaId) return parsed;

  const queryUrls = [
    `${stagingUrl}/api/v1/workspaces/${encodeURIComponent(workspaceId)}/deployments?agent_id=${encodeURIComponent(agentId)}`,
    `${stagingUrl}/api/v1/workspaces/${encodeURIComponent(workspaceId)}/deployments?persona_slug=${encodeURIComponent(personaId)}`,
    `${stagingUrl}/api/v1/workspaces/${encodeURIComponent(workspaceId)}/deployments?persona_id=${encodeURIComponent(personaId)}`
  ];
  for (const url of queryUrls) {
    const res = await fetch(url, { headers: authHeaders(stagingToken) });
    if (!res.ok) continue;
    const payload = await res.json();
    const candidate = firstDeployment(payload);
    if (candidate?.id) return String(candidate.id);
  }
  return undefined;
}

function parseOutputId(output, jsonKeys, regexes) {
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('{')) {
      try {
        const json = JSON.parse(trimmed);
        const id =
          findJsonId(json, jsonKeys) ??
          findJsonId(json.agent, jsonKeys) ??
          findJsonId(json.deployment, jsonKeys) ??
          findJsonId(json.runHandle, jsonKeys);
        if (id) return String(id);
      } catch {
        // Continue with regex parsing below.
      }
    }
    for (const regex of regexes) {
      const match = trimmed.match(regex);
      if (match?.[1]) return match[1];
    }
  }
  return undefined;
}

function findJsonId(value, keys) {
  if (typeof value !== 'object' || value === null) return undefined;
  for (const key of keys) {
    if (value[key]) return value[key];
  }
  return undefined;
}

async function forceCronTick({ stagingUrl, stagingToken, workspaceId, agentId }) {
  const url = `${stagingUrl}/api/v1/workspaces/${encodeURIComponent(
    workspaceId
  )}/agents/${encodeURIComponent(agentId)}/_test/tick`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...authHeaders(stagingToken), 'content-type': 'application/json' },
    body: JSON.stringify({
      scheduleName: 'weekly',
      name: 'weekly',
      occurredAt: new Date().toISOString()
    })
  });
  if (res.status === 404 || res.status === 405 || res.status === 501) {
    return { skipped: true };
  }
  if (!res.ok) {
    throw new Error(`cron test tick failed: ${res.status} ${await res.text()}`);
  }
  return { skipped: false };
}

async function readDeploymentStatus({ stagingUrl, stagingToken, workspaceId, deploymentId }) {
  const url = `${stagingUrl}/api/v1/workspaces/${encodeURIComponent(
    workspaceId
  )}/deployments/${encodeURIComponent(deploymentId)}`;
  const res = await fetch(url, { headers: authHeaders(stagingToken) });
  if (!res.ok) {
    throw new Error(`deployment status lookup failed: ${res.status} ${await res.text()}`);
  }
  const payload = await res.json();
  return (
    payload.status ??
    payload.deployment?.status ??
    payload.data?.status ??
    payload.data?.deployment?.status
  );
}

async function destroyDeployment({ stagingUrl, stagingToken, workspaceId, agentId, deploymentId }) {
  const candidates = [
    deploymentId
      ? `${stagingUrl}/api/v1/workspaces/${encodeURIComponent(workspaceId)}/deployments/${encodeURIComponent(
          deploymentId
        )}`
      : undefined,
    agentId
      ? `${stagingUrl}/api/v1/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(agentId)}`
      : undefined
  ].filter(Boolean);

  let lastError;
  for (const url of candidates) {
    const res = await fetch(url, { method: 'DELETE', headers: authHeaders(stagingToken) });
    if (res.ok || res.status === 404 || res.status === 405 || res.status === 501) continue;
    lastError = new Error(`${res.status} ${await res.text()}`);
  }
  if (lastError) throw lastError;
}

async function waitForWeeklyDigestIssue({ since }) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const issue = await findWeeklyDigestIssue({ since });
      if (issue) return issue;
    } catch (err) {
      lastError = err;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  if (lastError) {
    throw new Error(`weekly digest issue was not observed within 90s; last error: ${messageOf(lastError)}`);
  }
  throw new Error(`weekly digest issue was not observed within 90s`);
}

async function findWeeklyDigestIssue({ since }) {
  const [owner, repo] = splitRepo(FIXTURE_REPO);
  const url = new URL(`https://api.github.com/repos/${owner}/${repo}/issues`);
  url.searchParams.set('state', 'open');
  url.searchParams.set('per_page', '30');
  url.searchParams.set('since', since.toISOString());

  const res = await fetch(url, { headers: githubHeaders() });
  if (!res.ok) {
    throw new Error(`GitHub issue lookup failed: ${res.status} ${await res.text()}`);
  }
  const issues = await res.json();
  return issues.find((issue) => {
    if (issue.pull_request) return false;
    if (!ISSUE_TITLE_RE.test(issue.title ?? '')) return false;
    return new Date(issue.updated_at).getTime() >= since.getTime();
  });
}

async function closeIssue(issue) {
  const token = githubToken();
  if (!token) return;
  const [owner, repo] = splitRepo(FIXTURE_REPO);
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${issue.number}`, {
    method: 'PATCH',
    headers: { ...githubHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({ state: 'closed', state_reason: 'completed' })
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${await res.text()}`);
  }
}

function firstAgent(payload) {
  if (Array.isArray(payload)) return payload[0];
  if (Array.isArray(payload?.agents)) return payload.agents[0];
  if (Array.isArray(payload?.data)) return payload.data[0];
  if (Array.isArray(payload?.data?.agents)) return payload.data.agents[0];
  return payload?.agent ?? payload?.data?.agent;
}

function firstDeployment(payload) {
  if (Array.isArray(payload)) return payload[0];
  if (Array.isArray(payload?.deployments)) return payload.deployments[0];
  if (Array.isArray(payload?.data)) return payload.data[0];
  if (Array.isArray(payload?.data?.deployments)) return payload.data.deployments[0];
  return payload?.deployment ?? payload?.data?.deployment;
}

function authHeaders(token) {
  return { authorization: `Bearer ${token}` };
}

function githubHeaders() {
  const token = githubToken();
  return {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    ...(token ? { authorization: `Bearer ${token}` } : {})
  };
}

function githubToken() {
  return (process.env.WORKFORCE_E2E_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN ?? '').trim();
}

function splitRepo(repo) {
  const parts = repo.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`WORKFORCE_E2E_FIXTURE_REPO must be owner/repo; got "${repo}"`);
  }
  return parts;
}

function normalizeBaseUrl(value) {
  return value.replace(/\/+$/, '');
}

function envValue(name) {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function importDist(relativePath) {
  return import(pathToFileURL(path.resolve(process.cwd(), relativePath)).href);
}

function runNode(args, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      stderr += `\nprocess timed out after ${timeoutMs}ms`;
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}

function messageOf(err) {
  return err instanceof Error ? err.message : String(err);
}
