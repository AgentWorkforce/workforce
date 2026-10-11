import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, connect, type Socket } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { launchInteractiveSandbox, type InteractiveSandboxDependencies, type InteractiveSandboxInput } from './sandbox-interactive.js';
import { PersonaNotSandboxableError } from '@agentworkforce/persona-kit';

function input(): InteractiveSandboxInput {
  return {
    persona: { id: 'demo', intent: 'documentation', description: '', tags: [], skills: [], harness: 'claude', harnessSettings: { reasoning: 'medium', timeoutSeconds: 300 } },
    workspace: 'ws', stdio: { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() },
  };
}
async function fake() {
  // Keep UNIX socket names below macOS's 104-byte limit.
  const dir = await mkdtemp(join(tmpdir(), 'wf-'));
  const socketPath = join(dir, 's');
  const sockets = new Set<Socket>();
  const server = createServer(socket => { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); });
  server.listen(socketPath);
  await once(server, 'listening');
  let finish!: (code: number) => void;
  const finished = new Promise<number>(resolve => { finish = resolve; });
  const spawnCalls: Parameters<InteractiveSandboxDependencies['spawnFleetSandbox']>[0][] = [];
  const attachCalls: Parameters<InteractiveSandboxDependencies['startFleetNodeAttachProxy']>[0][] = [];
  let destroys = 0;
  let closes = 0;
  const deps: InteractiveSandboxDependencies = {
    spawnFleetSandbox: async request => { spawnCalls.push(request); return { sandboxId: 'sb_1', nodeId: 'node_1', destroy: async () => { destroys++; } }; },
    startFleetNodeAttachProxy: async opts => { attachCalls.push(opts); return { socketPath, finished, close: async () => { closes++; } }; },
    connect,
  };
  return { deps, server, finish, spawnCalls, attachCalls, counts: () => ({ destroys, closes }), cleanup: async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  } };
}

test('interactive sandbox: real bidirectional socket, attached, exit and idempotent stop', { timeout: 5000 }, async t => {
  const relay = await fake(); t.after(relay.cleanup);
  const request = input();
  const connection = once(relay.server, 'connection');
  const handle = await launchInteractiveSandbox(request, relay.deps); t.after(handle.stop);
  let attached = false;
  void handle.attached.then(() => { attached = true; });
  assert.equal(attached, false);
  const [peer] = await connection as [Socket];
  await handle.attached;
  const received = once(peer, 'data');
  (request.stdio.stdin as PassThrough).write('inbound');
  assert.equal(String((await received)[0]), 'inbound');
  const output = once(request.stdio.stdout, 'data');
  peer.write('outbound');
  assert.equal(String((await output)[0]), 'outbound');
  relay.finish(7);
  assert.equal(await handle.finished, 7);
  await Promise.all([handle.stop(), handle.stop()]);
  assert.deepEqual(relay.counts(), { destroys: 1, closes: 1 });
  assert.equal(request.stdio.stdin.listenerCount('data'), 0);
  assert.equal((request.stdio.stdout as PassThrough).writableEnded, false);
});

test('interactive sandbox: detach closes the proxy and leaves the sandbox running', { timeout: 5000 }, async t => {
  const relay = await fake(); t.after(relay.cleanup);
  const request = input();
  const handle = await launchInteractiveSandbox(request, relay.deps);
  await handle.attached;
  await handle.detach(); await handle.detach();
  assert.deepEqual(relay.counts(), { destroys: 0, closes: 1 });
  assert.equal(request.stdio.stdin.listenerCount('data'), 0);
});

test('interactive sandbox: mount and option forwarding, defaults and omitted empty paths', { timeout: 5000 }, async t => {
  const relay = await fake(); t.after(relay.cleanup);
  const plain = await launchInteractiveSandbox(input(), relay.deps);
  await plain.attached; await plain.stop();
  assert.equal(Object.hasOwn(relay.spawnCalls[0], 'relayfilePaths'), false);
  assert.equal(relay.spawnCalls[0].authMode, 'managed');
  assert.equal(relay.attachCalls[0].mode, 'drive');
  const request = input();
  request.persona.mount = { ignoredPatterns: ['/*', '!web', '!web/**'], readonlyPatterns: ['docs/**'] };
  Object.assign(request, { provider: 'e2b', sandboxId: 'sb_replay', task: 'hello', authMode: 'byo', attachMode: 'view' });
  const scoped = await launchInteractiveSandbox(request, relay.deps);
  await scoped.attached; await scoped.stop();
  const call = relay.spawnCalls[1];
  assert.deepEqual(call.relayfilePaths, ['/web/**']);
  assert.deepEqual(call.readonlyPaths, ['docs/**']);
  assert.notEqual(call.readonlyPaths, request.persona.mount.readonlyPatterns);
  assert.equal(call.provider, 'e2b'); assert.equal(call.sandboxId, 'sb_replay');
  assert.equal(call.task, 'hello'); assert.equal(call.authMode, 'byo');
  assert.deepEqual(relay.attachCalls[1], { nodeId: 'node_1', mode: 'view' });
});

test('interactive sandbox: failed attach destroys and preserves original error', async () => {
  let destroys = 0;
  const failure = new Error('attach refused');
  await assert.rejects(launchInteractiveSandbox(input(), {
    spawnFleetSandbox: async () => ({ sandboxId: 's', nodeId: 'n', destroy: async () => { destroys++; throw new Error('cleanup'); } }),
    startFleetNodeAttachProxy: async () => { throw failure; }, connect,
  }), err => err === failure);
  assert.equal(destroys, 1);
});

test('interactive sandbox: invalid persona is rejected before spawn', async () => {
  let spawns = 0;
  const request = input(); request.persona.sandbox = false;
  await assert.rejects(launchInteractiveSandbox(request, {
    spawnFleetSandbox: async () => { spawns++; throw new Error('unreachable'); },
    startFleetNodeAttachProxy: async () => { throw new Error('unreachable'); }, connect,
  }), PersonaNotSandboxableError);
  assert.equal(spawns, 0);
});

test('interactive sandbox: connection failure rejects attached and finished and destroys', { timeout: 5000 }, async () => {
  let destroys = 0;
  const handle = await launchInteractiveSandbox(input(), {
    spawnFleetSandbox: async () => ({ sandboxId: 's', nodeId: 'n', destroy: async () => { destroys++; } }),
    startFleetNodeAttachProxy: async () => ({ socketPath: '/nonexistent-wf-socket', finished: new Promise(() => {}), close: async () => {} }), connect,
  });
  await assert.rejects(handle.attached, /ENOENT/);
  await assert.rejects(handle.finished, /ENOENT/);
  await handle.stop(); assert.equal(destroys, 1);
});

test('interactive sandbox: explicit detach never destroys when proxy close rejects finished', { timeout: 5000 }, async t => {
  const relay = await fake(); t.after(relay.cleanup);
  let rejectFinished!: (err: Error) => void;
  const finished = new Promise<number>((_, reject) => { rejectFinished = reject; });
  const attach = relay.deps.startFleetNodeAttachProxy;
  relay.deps.startFleetNodeAttachProxy = async opts => {
    const proxy = await attach(opts);
    return { ...proxy, finished, close: async () => { await proxy.close(); rejectFinished(new Error('detached')); } };
  };
  const handle = await launchInteractiveSandbox(input(), relay.deps);
  await handle.attached;
  await handle.detach();
  await assert.rejects(handle.finished, /detached/);
  assert.equal(relay.counts().destroys, 0);
});

test('interactive sandbox: failed proxy close cannot prevent sandbox deletion', { timeout: 5000 }, async t => {
  const relay = await fake(); t.after(relay.cleanup);
  const attach = relay.deps.startFleetNodeAttachProxy;
  relay.deps.startFleetNodeAttachProxy = async opts => {
    const proxy = await attach(opts);
    return { ...proxy, close: async () => { await proxy.close(); throw new Error('close failed'); } };
  };
  const request = input(); let warnings = '';
  request.stdio.stderr.on('data', value => { warnings += value; });
  const handle = await launchInteractiveSandbox(request, relay.deps);
  await handle.attached; await handle.stop();
  assert.equal(relay.counts().destroys, 1);
  assert.match(warnings, /cleanup failed: close failed/);
});
