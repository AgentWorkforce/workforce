import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkforceMcpServer } from './server.js';
import { loadConfig } from './config.js';

test('createWorkforceMcpServer registers the documented tool set', () => {
  const config = loadConfig({
    WORKFORCE_WORKSPACE_ID: 'ws-demo',
    WORKFORCE_RUNTIME_TOKEN: 'tok',
    SUPERMEMORY_API_KEY: 'sm',
    WORKFORCE_INTEGRATION_GITHUB_TOKEN: 'ghp'
  });
  const server = createWorkforceMcpServer(config);
  // The MCP SDK exposes the underlying low-level Server which holds the
  // registry. We probe it via internals — the public surface for tool
  // listing is the live MCP protocol, which would require a transport
  // pair to exercise. Internals are stable enough across the minor SDK
  // versions we ship against (>=1.21.0).
  type Registry = { _registeredTools?: Record<string, unknown> };
  const tools = (server as unknown as Registry)._registeredTools ?? {};
  const names = Object.keys(tools).sort();
  assert.deepEqual(names, [
    'integration.github.comment',
    'integration.github.createIssue',
    'integration.github.getPr',
    'integration.github.postReview',
    'integration.github.upsertIssue',
    'memory.recall',
    'memory.save',
    'workflow.run',
    'workflow.status'
  ]);
});
