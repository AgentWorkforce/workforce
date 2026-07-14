import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveAgentRelayBrokerBinary } from './relay-mcp.js';

test('broker-only relay MCP prefers BROKER_BINARY_PATH over the Agent Relay CLI', () => {
  assert.equal(
    resolveAgentRelayBrokerBinary({
      AGENT_RELAY_BIN: '/opt/agent-relay',
      BROKER_BINARY_PATH: '/opt/agent-relay-broker'
    }),
    '/opt/agent-relay-broker'
  );
});

test('broker-only relay MCP treats an empty Agent Relay CLI override as unset', () => {
  const fallback = resolveAgentRelayBrokerBinary({});

  assert.ok(fallback.trim().length > 0);
  assert.equal(
    resolveAgentRelayBrokerBinary({ AGENT_RELAY_BIN: '   ' }),
    fallback
  );
});

test('broker-only relay MCP preserves the legacy AGENT_RELAY_BIN broker override', () => {
  assert.equal(
    resolveAgentRelayBrokerBinary({ AGENT_RELAY_BIN: '  /opt/legacy-agent-relay-broker  ' }),
    '/opt/legacy-agent-relay-broker'
  );
});
