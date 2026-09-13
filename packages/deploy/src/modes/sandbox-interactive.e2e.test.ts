import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { ensureCloudSession, readStoredAuth } from '@agent-relay/cloud';
import { launchInteractiveSandbox } from './sandbox-interactive.js';

// Explicit opt-in; workspace must be the Cloud UUID accepted by the fleet API.
const enabled = process.env.WORKFORCE_E2E_SANDBOX === '1';
const workspace = process.env.WORKFORCE_E2E_SANDBOX_WORKSPACE;
test('live Daytona: task output, exit and fleet deletion', {
  skip: !enabled || !workspace ? 'Set WORKFORCE_E2E_SANDBOX=1 and WORKFORCE_E2E_SANDBOX_WORKSPACE with a logged-in Relay session.' : false,
  timeout: 600_000,
}, async t => {
  if (!(await readStoredAuth())) { t.skip('No stored Relay credentials available.'); return; }
  // Once credentials exist, auth/network errors fail the live gate rather than skipping it.
  const session = await ensureCloudSession({ interactive: false });
  const stdout = new PassThrough();
  let output = '';
  stdout.on('data', chunk => { output += String(chunk); });
  const handle = await launchInteractiveSandbox({
    persona: { id: 'sandbox-smoke', intent: 'documentation', description: 'Sandbox smoke test', tags: [], skills: [], harness: 'claude', harnessSettings: { reasoning: 'medium', timeoutSeconds: 120 } },
    workspace: workspace!, provider: 'daytona', task: 'echo hello && exit 0',
    stdio: { stdin: new PassThrough(), stdout, stderr: new PassThrough() },
  });
  t.after(handle.stop);
  const roster = async () => {
    const response = await session.client.fetch(`/api/v1/fleet/nodes?workspaceId=${encodeURIComponent(workspace!)}`, { method: 'GET' });
    assert.equal(response.ok, true, `Fleet lookup failed (${response.status})`);
    const body = await response.json() as { nodes?: Array<{ id: string }> };
    assert.ok(Array.isArray(body.nodes), 'Fleet response must contain a nodes array');
    return body.nodes;
  };
  await handle.attached;
  assert.ok((await roster()).some(node => node.id === handle.nodeId), 'Live resource must exist before deletion');
  assert.equal(await handle.finished, 0);
  assert.match(output, /hello/);
  await handle.stop();
  for (let attempt = 0; attempt < 30; attempt++) {
    const nodes = await roster();
    if (!nodes.some(node => node.id === handle.nodeId || JSON.stringify(node).includes(handle.sandboxId))) return;
    await delay(1000);
  }
  assert.fail(`Sandbox ${handle.sandboxId} is still present in the live fleet after stop()`);
});
