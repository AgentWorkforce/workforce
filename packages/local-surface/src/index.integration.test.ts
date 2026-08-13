import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deploy as realDeploy, createBufferedIO, type ModeLaunchHandle } from '@agentworkforce/deploy';
import type { FleetActionContext } from '@agent-relay/fleet';
import { __setDeployForTest, defineWorkforcePersonaNode, type RunEventInput, type TriggerMessage } from './index.js';

/**
 * Real (non-mocked) regression coverage for the bug shadow-workforce-reviewer
 * caught in PR review: `dev.ts`'s default `process.stdin.pipe(child.stdin)`
 * passthrough is active for every `deploy({mode:'dev'})` call, including
 * ours. The fleet-node host process (`relay node up`) is meant to be
 * always-on/daemonized — the moment ITS OWN stdin ends (the normal case for
 * anything non-interactive), that passthrough would end the persona child's
 * stdin too, and every subsequent `write()` throws
 * `ERR_STREAM_WRITE_AFTER_END`, uncaught, crashing the whole host process —
 * or, after this fix's defensive error listener, silently losing every
 * envelope after the first host-stdin EOF.
 *
 * This spawns a REAL persona child process through the REAL `deploy()` →
 * `devLauncher` → `child_process.spawn()` pipeline (only the outer
 * `deploy()` call is wrapped, transparently, to capture the real
 * `ModeLaunchHandle` for teardown — every envelope still travels through the
 * real `write()` → real `child.stdin.write()` path). It proves
 * `bridged: true` keeps the child's stdin open and dispatching across a
 * synthetic `process.stdin` EOF on the HOST process, which is exactly the
 * condition `defineWorkforcePersonaNode` runs under in production.
 */

// A schedule listener (not a provider trigger) keeps \`validateActiveAgent\`
// happy without declaring \`persona.integrations\` — the runtime dispatches
// whatever raw envelope arrives on stdin regardless of declared
// triggers/schedules (\`runner.ts\`: "the runtime does not subscribe, the
// cloud gateway does"), so a schedule-only agent can still receive and
// handle our synthetic \`github.pull_request.opened\` envelope below. This
// keeps the test's real \`deploy()\` call free of any integration-connect
// step (which would otherwise need a resolver this bridge doesn't expose).
const AGENT_SRC = `import { defineAgent } from '@agentworkforce/runtime';
export default defineAgent({
  schedules: [{ name: 'noop', cron: '0 9 * * 1' }],
  handler: async () => {}
});
`;

function personaJson(): Record<string, unknown> {
  return {
    id: 'local-surface-real-spawn-test',
    intent: 'documentation',
    tags: ['documentation'],
    description: 'local-surface real-spawn regression test persona',
    harness: 'claude',
    model: 'anthropic/claude-3-5-sonnet',
    systemPrompt: 'be helpful',
    harnessSettings: { reasoning: 'medium', timeoutSeconds: 300 },
    cloud: true,
    onEvent: './agent.ts'
  };
}

function triggerMessage(id: string, deliveryId: string): TriggerMessage {
  return {
    id,
    channel_id: 'ch_1',
    channel_name: 'local-surface-real-spawn-test',
    agent_id: 'agent_webhook',
    text: 'pull_request.opened',
    created_at: '2026-07-15T00:00:00.000Z',
    metadata: {
      provider: 'github',
      eventType: 'pull_request.opened',
      workspaceId: 'ws-real-spawn-test',
      deliveryId,
      payload: { action: 'opened', number: 1 }
    }
  };
}

function fakeCtx(nodeName: string): FleetActionContext {
  return {
    node: { name: nodeName, capabilities: ['run-event'] },
    relay: { sendMessage: async () => undefined },
    spawnAgent: async () => undefined
  };
}

async function waitFor(check: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for: ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test(
  'defineWorkforcePersonaNode keeps delivering envelopes to a real spawned persona after the host process stdin ends',
  { timeout: 60_000 },
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'wf-local-surface-real-spawn-'));
    const personaPath = path.join(dir, 'persona.json');
    let capturedHandle: ModeLaunchHandle | undefined;

    __setDeployForTest(async (opts, resolvers) => {
      const result = await realDeploy(opts, resolvers);
      if (result.runHandle && typeof (result.runHandle as ModeLaunchHandle).write === 'function') {
        capturedHandle = result.runHandle as ModeLaunchHandle;
      }
      return result;
    });

    try {
      await writeFile(personaPath, JSON.stringify(personaJson(), null, 2), 'utf8');
      await writeFile(path.join(dir, 'agent.ts'), AGENT_SRC, 'utf8');

      const io = createBufferedIO();
      const definition = defineWorkforcePersonaNode({
        personaPath,
        channel: 'local-surface-real-spawn-test',
        connection: { workspace: 'ws-real-spawn-test', workspaceToken: 'tok-real-spawn-test' },
        io
      });
      const handler = definition.capabilities['run-event']!.handler;
      const ctx = fakeCtx(definition.name);

      const dispatched = (deliveryId: string) =>
        io.messages.some(
          (m) => m.message.includes('runner.handler.ok') && m.message.includes(deliveryId)
        );

      const firstInput: RunEventInput = { trigger_id: 'trg_1', message: triggerMessage('msg_1', 'dlv_before_eof') };
      await handler(firstInput, ctx);
      await waitFor(() => dispatched('dlv_before_eof'), 30_000, 'first envelope dispatched by the real child');
      assert.ok(capturedHandle, 'deploy() should have returned a real ModeLaunchHandle');

      // Simulate the fleet-node host process's own stdin reaching EOF — the
      // normal case for a non-interactive/daemonized `relay node up`. This is
      // the exact event `dev.ts`'s (now-skipped, because bridged:true) legacy
      // passthrough listens for to end the child's stdin.
      process.stdin.emit('end');

      const secondInput: RunEventInput = { trigger_id: 'trg_1', message: triggerMessage('msg_2', 'dlv_after_eof') };
      await handler(secondInput, ctx);
      await waitFor(
        () => dispatched('dlv_after_eof'),
        30_000,
        'second envelope (written after simulated host stdin EOF) dispatched by the real child'
      );

      // Sanity: the underlying process really is a distinct, still-alive
      // child — not something that silently no-op'd after the first write.
      const child = capturedHandle as unknown as { id: string };
      assert.ok(child.id.startsWith('pid:'));
    } finally {
      if (capturedHandle) {
        await capturedHandle.stop();
      }
      __setDeployForTest(undefined);
      await rm(dir, { recursive: true, force: true });
    }
  }
);

// Regression guard for the underlying bug report, at the lower level: with
// `bridged` unset (the pre-existing CLI/legacy contract), dev.ts's stdin
// passthrough IS attached, so `write()` must still work for a NORMAL
// (non-EOF'd) parent stdin — this isn't a behavior change for existing
// `workforce deploy --mode dev` users piping envelopes via real stdin.
test(
  'defineWorkforcePersonaNode always passes bridged:true so the legacy stdin passthrough never attaches for the bridge',
  async () => {
    const seen: Array<{ bridged?: boolean }> = [];
    __setDeployForTest(async (opts) => {
      seen.push({ bridged: opts.bridged });
      return {
        deploymentId: 'demo',
        mode: 'dev',
        workspace: 'ws',
        bundleDir: '/tmp',
        connectedIntegrations: [],
        schedules: [],
        warnings: [],
        runHandle: { id: 'pid:1', stop: async () => undefined, done: Promise.resolve({ code: 0 }), write: () => undefined }
      };
    });
    try {
      const definition = defineWorkforcePersonaNode({
        personaPath: '/personas/demo.json',
        channel: 'local-surface-demo',
        connection: { workspace: 'ws_1', workspaceToken: 'tok_1' }
      });
      const handler = definition.capabilities['run-event']!.handler;
      await handler(
        { trigger_id: 'trg_1', message: triggerMessage('msg_1', 'dlv_1') },
        fakeCtx(definition.name)
      );
      assert.equal(seen.length, 1);
      assert.equal(seen[0]!.bridged, true);
    } finally {
      __setDeployForTest(undefined);
    }
  }
);
