import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkforceMcpServer } from './server.js';
import { loadConfig } from './config.js';

test('jsonResult normalizes a void return so MCP text content is always valid JSON', async () => {
  const { jsonResult } = await import('./server.js');
  // `JSON.stringify(undefined)` is itself `undefined`, not a string — a
  // CallToolResult with text:undefined fails the MCP content-shape check.
  // jsonResult substitutes a sentinel so void-returning tools (e.g.
  // integration.github.postReview) still emit parseable JSON.
  const fromUndefined = jsonResult(undefined);
  assert.equal(fromUndefined.content[0].type, 'text');
  assert.equal(typeof fromUndefined.content[0].text, 'string');
  assert.deepEqual(JSON.parse(fromUndefined.content[0].text), { ok: true });

  // Non-void values pass through verbatim.
  const fromObject = jsonResult({ runId: 'r1', status: 'pending' });
  assert.deepEqual(JSON.parse(fromObject.content[0].text), {
    runId: 'r1',
    status: 'pending'
  });

  // `null` is a legitimate JSON value and should round-trip as such,
  // not be coerced to the void sentinel.
  const fromNull = jsonResult(null);
  assert.equal(fromNull.content[0].text, 'null');
});

test('createWorkforceMcpServer registers the documented tool set', () => {
  const config = loadConfig({
    WORKFORCE_WORKSPACE_ID: 'ws-demo',
    WORKFORCE_RUNTIME_TOKEN: 'tok',
    SUPERMEMORY_API_KEY: 'sm',
    RELAYFILE_MOUNT_ROOT: '/tmp/wf-mcp-server-test'
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
    'get_agent_card',
    'integration.github.comment',
    'integration.github.createIssue',
    'integration.github.getPr',
    'integration.github.postReview',
    'integration.github.upsertIssue',
    'list_integrations',
    'memory.recall',
    'memory.save',
    'workflow.run',
    'workflow.status'
  ]);
});

test('tool input schemas are advertised as JSON Schema and enforced over the MCP protocol', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const config = loadConfig({
    WORKFORCE_WORKSPACE_ID: 'ws-demo',
    WORKFORCE_RUNTIME_TOKEN: 'tok',
    SUPERMEMORY_API_KEY: 'sm',
    RELAYFILE_MOUNT_ROOT: '/tmp/wf-mcp-server-test'
  });
  const server = createWorkforceMcpServer(config);
  const client = new Client({ name: 'mcp-workforce-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const { tools } = await client.listTools();
    const run = tools.find((tool) => tool.name === 'workflow.run');
    assert.ok(run, 'workflow.run should be listed');
    assert.equal(run.inputSchema.type, 'object');
    assert.deepEqual(run.inputSchema.required, ['name']);
    const properties = run.inputSchema.properties as Record<string, Record<string, unknown>>;
    assert.equal(properties.name?.type, 'string');
    assert.equal(properties.name?.minLength, 1);
    assert.equal(properties.args?.type, 'object');

    const review = tools.find((tool) => tool.name === 'integration.github.postReview');
    const reviewProps = review?.inputSchema.properties as Record<string, Record<string, unknown>>;
    const event = (reviewProps.review?.properties as Record<string, Record<string, unknown>>)?.event;
    assert.deepEqual(event?.enum, ['COMMENT', 'APPROVE', 'REQUEST_CHANGES']);

    // Invalid input is rejected by the zod schema before the handler runs.
    const invalid = await client.callTool({ name: 'workflow.status', arguments: { runId: '' } });
    assert.equal(invalid.isError, true);
  } finally {
    await client.close();
    await server.close();
  }
});
