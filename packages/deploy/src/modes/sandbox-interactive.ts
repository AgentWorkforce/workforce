import { connect, type Socket } from 'node:net';
import { personaToSandboxParams, type PersonaSpec, type PersonaSandboxParams } from '@agentworkforce/persona-kit';
import { createIdempotentStop, destroyOnFailure } from './sandbox-shared.js';

export interface InteractiveSandboxInput {
  persona: PersonaSpec;
  workspace: string;
  inputs?: Record<string, string>;
  authMode?: 'byo' | 'managed';
  provider?: 'daytona' | 'e2b';
  sandboxId?: string;
  attachMode?: 'view' | 'drive';
  task?: string;
  stdio: {
    stdin: NodeJS.ReadableStream;
    stdout: NodeJS.WritableStream;
    stderr: NodeJS.WritableStream;
  };
}

export interface InteractiveSandboxHandle {
  sandboxId: string;
  nodeId: string;
  attached: Promise<void>;
  finished: Promise<number>;
  detach(): Promise<void>;
  stop(): Promise<void>;
}

interface SpawnRequest extends Omit<PersonaSandboxParams, 'relayfilePaths'> {
  workspace: string;
  relayfilePaths?: string[];
  authMode: 'byo' | 'managed';
  provider?: 'daytona' | 'e2b';
  sandboxId?: string;
  task?: string;
}
interface Sandbox {
  sandboxId: string;
  nodeId: string;
  destroy(): Promise<void>;
}
interface AttachProxy {
  socketPath: string;
  finished: Promise<number>;
  close(): Promise<void>;
}
/** @internal Injection boundary until Relay publishes the specified subpaths. */
export interface InteractiveSandboxDependencies {
  spawnFleetSandbox(request: SpawnRequest): Promise<Sandbox>;
  startFleetNodeAttachProxy(options: { nodeId: string; mode: 'view' | 'drive' }): Promise<AttachProxy>;
  connect(path: string): Socket;
}

async function relayDependencies(): Promise<InteractiveSandboxDependencies> {
  // Keep unrelated deploy/local commands loadable with the current Relay release.
  // These names are deliberately resolved at runtime: no CLI or private-file fallback.
  const fleetPath = '@agent-relay/cloud/fleet';
  const attachPath = '@agent-relay/cloud/attach';
  const [fleet, attach] = await Promise.all([import(fleetPath), import(attachPath)]).catch(cause => {
    throw new Error('Interactive sandbox requires a published @agent-relay/cloud release with /fleet and /attach exports. The installed Relay SDK does not provide that contract.', { cause });
  });
  if (typeof fleet.spawnFleetSandbox !== 'function' || typeof attach.startFleetNodeAttachProxy !== 'function') {
    throw new Error('Relay SDK is missing spawnFleetSandbox or startFleetNodeAttachProxy.');
  }
  return { spawnFleetSandbox: fleet.spawnFleetSandbox, startFleetNodeAttachProxy: attach.startFleetNodeAttachProxy, connect };
}

export async function launchInteractiveSandbox(
  input: InteractiveSandboxInput,
  deps?: InteractiveSandboxDependencies,
): Promise<InteractiveSandboxHandle> {
  const { relayfilePaths, ...params } = personaToSandboxParams(input.persona, input);
  const relay = deps ?? await relayDependencies();
  const sandbox = await relay.spawnFleetSandbox({
    ...params,
    ...(relayfilePaths.length ? { relayfilePaths } : {}),
    workspace: input.workspace,
    authMode: input.authMode ?? 'managed',
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.sandboxId ? { sandboxId: input.sandboxId } : {}),
    ...(input.task !== undefined ? { task: input.task } : {}),
  });
  let proxy: AttachProxy;
  let socket: Socket;
  try {
    proxy = await relay.startFleetNodeAttachProxy({ nodeId: sandbox.nodeId, mode: input.attachMode ?? 'drive' });
    // An incompatible adapter must never result in net.connect(undefined).
    if (typeof proxy.socketPath !== 'string' || !proxy.socketPath || !proxy.finished || typeof proxy.close !== 'function') {
      const error = new Error('Relay attach adapter does not expose the required UNIX socket/finished contract.');
      return await destroyOnFailure(() => typeof proxy.close === 'function' ? proxy.close() : Promise.resolve(), error);
    }
    try { socket = relay.connect(proxy.socketPath); }
    catch (err) { return await destroyOnFailure(() => proxy.close(), err); }
  } catch (err) {
    return destroyOnFailure(() => sandbox.destroy(), err);
  }

  let detached = false;
  let connected = false;
  let disconnected: Promise<void> | undefined;
  const disconnect = (): Promise<void> => disconnected ??= (async () => {
    input.stdio.stdin.unpipe(socket);
    socket.unpipe(input.stdio.stdout);
    socket.end();
    socket.destroy();
    await proxy.close();
  })();
  const stop = createIdempotentStop(async () => {
    try { await disconnect(); } finally { await sandbox.destroy(); }
  }, { warn: message => { input.stdio.stderr.write(`${message}\n`); } });

  let resolveAttached!: () => void;
  let rejectAttached!: (error: unknown) => void;
  const attached = new Promise<void>((resolve, reject) => { resolveAttached = resolve; rejectAttached = reject; });
  let rejectTransport!: (error: unknown) => void;
  const transportFailure = new Promise<never>((_, reject) => { rejectTransport = reject; });
  socket.once('connect', () => {
    connected = true;
    input.stdio.stdin.pipe(socket);
    socket.pipe(input.stdio.stdout, { end: false });
    resolveAttached();
  });
  socket.on('error', err => {
    rejectAttached(err);
    rejectTransport(err);
    if (!detached) void stop();
  });
  socket.once('close', () => {
    if (!connected) {
      const error = new Error('Sandbox socket closed before connecting.');
      rejectAttached(error);
      rejectTransport(error);
    }
  });
  // Observe failures immediately even if a caller awaits finished before attached.
  void attached.catch(() => undefined);
  const finished = Promise.race([proxy.finished, transportFailure]).then(async code => {
    rejectAttached(new Error('Sandbox attach ended before the socket connected.'));
    await disconnect();
    return code;
  }, async err => {
    rejectAttached(err);
    if (!detached) await stop();
    throw err;
  });
  void finished.catch(() => undefined);
  return {
    sandboxId: sandbox.sandboxId,
    nodeId: sandbox.nodeId,
    attached,
    finished,
    detach: async () => {
      detached = true;
      rejectAttached(new Error('Sandbox detached before the socket connected.'));
      await disconnect();
    },
    stop: () => {
      rejectAttached(new Error('Sandbox stopped before the socket connected.'));
      return stop();
    },
  };
}
