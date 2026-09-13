import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { InteractiveSandboxInput } from '@agentworkforce/deploy';
import { parseAgentArgs, runAgentSandbox } from './cli-impl.js';

const persona: InteractiveSandboxInput['persona'] = { id: 'demo', intent: 'documentation', description: '', tags: [], skills: [], harness: 'claude', harnessSettings: { reasoning: 'medium', timeoutSeconds: 300 } };
function fixture() {
  const exits: number[] = [];
  const processLike = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exit: (code: number) => { exits.push(code); },
  });
  let stops = 0;
  const calls: InteractiveSandboxInput[] = [];
  const deps = {
    processLike,
    resolveWorkspace: async (): Promise<string | undefined> => 'workspace',
    launchInteractiveSandbox: async (input: InteractiveSandboxInput) => {
      calls.push(input);
      return { sandboxId: 'sb', nodeId: 'node', attached: Promise.resolve(), finished: Promise.resolve(3), detach: async () => {}, stop: async () => { stops++; } };
    },
  };
  return { deps, calls, exits, stops: () => stops };
}
for (const byo of [false, true]) {
  test(`agent sandbox dispatch forwards stdio and options (${byo ? 'BYO' : 'managed'})`, async () => {
    const f = fixture();
    const { flags } = parseAgentArgs(['--mode=sandbox', '--sandbox-provider=e2b', '--sandbox-id=sb', '--attach-mode=view', ...(byo ? ['--byo-sandbox'] : [])]);
    await runAgentSandbox(persona, flags, f.deps);
    assert.equal(f.calls.length, 1);
    const call = f.calls[0];
    assert.equal(call.persona, persona); assert.equal(call.workspace, 'workspace');
    assert.equal(call.authMode, byo ? 'byo' : 'managed'); assert.equal(call.provider, 'e2b');
    assert.equal(call.sandboxId, 'sb'); assert.equal(call.attachMode, 'view');
    for (const stream of ['stdin', 'stdout', 'stderr'] as const) assert.equal(call.stdio[stream], f.deps.processLike[stream]);
    assert.deepEqual(f.exits, [3]); assert.equal(f.stops(), 1);
    assert.equal(f.deps.processLike.listenerCount('SIGINT'), 0);
  });
}
test('agent local dispatch never launches a sandbox or resolves workspace', async () => {
  const f = fixture();
  f.deps.resolveWorkspace = async () => { throw new Error('must not resolve'); };
  await runAgentSandbox(persona, parseAgentArgs([]).flags, f.deps);
  assert.equal(f.calls.length, 0);
});
test('agent sandbox requires active workspace with login hint', async () => {
  const f = fixture(); f.deps.resolveWorkspace = async () => undefined;
  await assert.rejects(runAgentSandbox(persona, parseAgentArgs(['--mode=sandbox']).flags, f.deps), /agentworkforce login/);
  assert.equal(f.calls.length, 0);
});
test('agent sandbox signal stops once and awaits cleanup even if finished settles first', async () => {
  const f = fixture();
  let finish!: (code: number) => void;
  const finished = new Promise<number>(resolve => { finish = resolve; });
  let deleted = false; let stopCalls = 0;
  f.deps.launchInteractiveSandbox = async () => {
    setImmediate(() => { f.deps.processLike.emit('SIGINT'); f.deps.processLike.emit('SIGTERM'); });
    return { sandboxId: 'sb', nodeId: 'n', attached: Promise.resolve(), finished, detach: async () => {}, stop: async () => {
      stopCalls++; finish(3); await new Promise(resolve => setImmediate(resolve)); deleted = true;
    } };
  };
  f.deps.processLike.exit = code => { assert.equal(deleted, true); f.exits.push(code); };
  await runAgentSandbox(persona, parseAgentArgs(['--mode=sandbox']).flags, f.deps);
  assert.equal(stopCalls, 1); assert.equal(f.exits.length, 1);
});
