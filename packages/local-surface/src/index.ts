import {
  action,
  defineNode,
  onMessage,
  type FleetActionContext,
  type FleetNodeDefinition
} from '@agent-relay/fleet';
import { deploy as deployPersona, type DeployIO, type ModeLaunchHandle } from '@agentworkforce/deploy';
import type { RawGatewayEnvelope } from '@agentworkforce/runtime';

// Test seam: swap the `deploy()` call `launchPersonaRunner` makes without
// changing `defineWorkforcePersonaNode`'s public signature. Not part of the
// package's public contract — used by this package's own tests only.
let deployImpl: typeof deployPersona = deployPersona;

/** @internal test-only override for the `deploy()` call this module makes. */
export function __setDeployForTest(impl: typeof deployPersona | undefined): void {
  deployImpl = impl ?? deployPersona;
}

/**
 * Coordinates the bridge needs to launch the persona's `deploy()` child in
 * the right cloud workspace. Mirrors the subset of `DeployOptions` a
 * long-lived fleet node can supply without re-prompting a human — the CLI
 * resolves these once at enrollment time and bakes them into the generated
 * node-config file.
 */
export interface WorkforcePersonaNodeConnection {
  /** Workforce workspace id the persona deploys into. */
  workspace: string;
  /** Workspace-scoped token from `resolveWorkspaceToken()`; avoids re-prompting login. */
  workspaceToken?: string;
  /** Override the WORKFORCE_CLOUD_URL; defaults to env or production. */
  cloudUrl?: string;
}

export interface DefineWorkforcePersonaNodeOptions {
  /** Path to the persona JSON/source file to run in `--mode dev`. */
  personaPath: string;
  /** Relaycast channel the local-surface webhook consumer posts events into. */
  channel: string;
  /** Cloud workspace + auth the persona deploy launches against. */
  connection: WorkforcePersonaNodeConnection;
  /** Fleet node name. Defaults to a channel-derived name. */
  nodeName?: string;
  /** Runtime log streaming hook, forwarded to `deploy()`. */
  onLog?: (line: string) => void;
  /** Override the IO the persona's `deploy()` call uses (tests only). */
  io?: DeployIO;
}

/** Shape relaycast's trigger engine invokes a fleet `onMessage` action with. */
export interface TriggerMessage {
  id: string;
  channel_id: string;
  channel_name: string;
  agent_id: string;
  agent_name?: string;
  text: string;
  mentions?: string[];
  metadata?: Record<string, unknown> | null;
  created_at: string;
}

export interface RunEventInput {
  trigger_id?: string;
  message: TriggerMessage;
}

const RUN_EVENT_ACTION = 'run-event';

/**
 * Wrap `@agent-relay/fleet`'s `defineNode` with a single `run-event`
 * capability triggered by `onMessage({channel})`. The returned definition is
 * meant to be the default export of a generated node-config file consumed by
 * `relay node up --config <file>`.
 *
 * On the first matched message, lazily launches the persona via the existing
 * `deploy()` orchestrator in `--mode dev --detach`, keeping the child process
 * alive across subsequent messages. Each message is mapped back into a
 * `RawGatewayEnvelope` (mirroring cloud's real gateway construction — see
 * `buildEnvelope`/`buildPayload` in
 * `cloud/packages/web/lib/proactive-runtime/{deployment-trigger-delivery,integration-watch-dispatcher}.ts`)
 * and written as one NDJSON line to the child's stdin.
 */
export function defineWorkforcePersonaNode(options: DefineWorkforcePersonaNodeOptions): FleetNodeDefinition {
  const channel = requireNonEmpty(options.channel, 'channel');
  const personaPath = requireNonEmpty(options.personaPath, 'personaPath');
  const workspace = requireNonEmpty(options.connection.workspace, 'connection.workspace');
  const nodeName = options.nodeName?.trim() || `local-surface-${sanitizeForNodeName(channel)}`;

  let runnerPromise: Promise<ModeLaunchHandle | undefined> | undefined;

  async function ensureRunner(ctx: FleetActionContext): Promise<ModeLaunchHandle | undefined> {
    if (!runnerPromise) {
      runnerPromise = launchPersonaRunner({ personaPath, workspace, options }).catch((err) => {
        // Allow a retry on the next event rather than permanently wedging the
        // node on a transient launch failure (e.g. a momentarily-down cloud).
        runnerPromise = undefined;
        throw err;
      });
    }
    return runnerPromise.catch((err) => {
      throw new Error(
        `local-surface: failed to launch persona "${personaPath}" (node ${ctx.node.name}): ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    });
  }

  return defineNode({
    name: nodeName,
    capabilities: {
      // `action`'s handler type is contravariant in its input, so the
      // capabilities record (typed `unknown` inputs) rejects a handler typed
      // to `RunEventInput` directly. The wire input truly is unstructured
      // (no zod schema is registered) so validate it structurally instead.
      [RUN_EVENT_ACTION]: action<unknown, { ok: boolean; skipped?: string }>({}, async (rawInput, ctx) => {
        if (!isRunEventInput(rawInput)) {
          return { ok: true, skipped: 'malformed run-event input' };
        }
        const envelope = buildEnvelopeFromTriggerMessage(rawInput.message, workspace);
        if (!envelope) {
          return { ok: true, skipped: 'unsupported message shape' };
        }
        const runner = await ensureRunner(ctx);
        writeEnvelope(runner, envelope);
        return { ok: true };
      })
    },
    triggers: [onMessage({ channel }, RUN_EVENT_ACTION)]
  });
}

function writeEnvelope(runner: ModeLaunchHandle | undefined, envelope: RawGatewayEnvelope): void {
  if (!runner || typeof runner.write !== 'function') {
    throw new Error(
      'local-surface: persona runner has no writable stdin — expected `--mode dev` (the only mode `defineWorkforcePersonaNode` supports)'
    );
  }
  runner.write(`${JSON.stringify(envelope)}\n`);
}

async function launchPersonaRunner(input: {
  personaPath: string;
  workspace: string;
  options: DefineWorkforcePersonaNodeOptions;
}): Promise<ModeLaunchHandle | undefined> {
  const { personaPath, workspace, options } = input;
  const result = await deployImpl(
    {
      personaPath,
      mode: 'dev',
      detach: true,
      // The fleet-node host process (`relay node up`) is meant to be
      // always-on/daemonized; the moment ITS OWN stdin ends — the normal
      // case for anything non-interactive — dev.ts's default stdin
      // passthrough would end the persona child's stdin too, crashing every
      // subsequent writeEnvelope() call. `bridged: true` opts out of that
      // passthrough since this bridge owns the child's stdin via `write()`.
      bridged: true,
      workspace,
      noPrompt: true,
      ...(options.connection.cloudUrl ? { cloudUrl: options.connection.cloudUrl } : {}),
      ...(options.onLog ? { onLog: options.onLog } : {}),
      ...(options.io ? { io: options.io } : {})
    },
    {
      workspaceAuth: {
        async resolveWorkspace() {
          const token = options.connection.workspaceToken?.trim();
          if (!token) {
            throw new Error(
              'local-surface: connection.workspaceToken is required — the generated node-config file must bake in a workspace-scoped token'
            );
          }
          return { workspace, token };
        }
      }
    }
  );
  return isModeLaunchHandle(result.runHandle) ? result.runHandle : undefined;
}

/**
 * Reconstruct a `RawGatewayEnvelope` from a relaycast `TriggerMessage`. The
 * message's metadata is the `NormalizedWebhook` cloud posted to
 * `POST /v1/hooks/:webhookId`, flattened onto `message.metadata` by
 * relaycast's `triggerWebhook()` (`inboundWebhookMessageMetadata(...)` keys
 * are `__relaycast_`-prefixed and ignored here). Field derivation mirrors
 * cloud's real gateway construction, not an ad hoc shape — see
 * `buildPayload()` in
 * `cloud/packages/web/lib/proactive-runtime/integration-watch-dispatcher.ts`
 * (`type: `${provider}.${eventType}``, `resource: payload`) and
 * `buildEnvelope()` in `.../deployment-trigger-delivery.ts` (`resource:
 * payload.resource ?? payload`).
 *
 * Returns `null` for messages that aren't local-surface webhook deliveries
 * (e.g. a human posting into the bound channel) — mirrors
 * `envelopeToAgentEvent`'s drop-and-ack convention for unsupported shapes.
 */
export function buildEnvelopeFromTriggerMessage(
  message: TriggerMessage,
  fallbackWorkspace: string
): RawGatewayEnvelope | null {
  const metadata = message.metadata ?? {};
  const provider = firstString(metadata.provider);
  const eventType = firstString(metadata.eventType);
  if (!provider || !eventType) {
    return null;
  }

  const deliveryId = firstString(metadata.deliveryId);
  const path = firstString(metadata.path);
  // Cloud's real construction (`buildPayload`) preserves `payload` verbatim
  // (only substituting `{}` for null/undefined) — no plain-object narrowing.
  // Coercing a non-object payload (e.g. an array, a valid webhook shape for
  // some providers) down to `{}` would silently discard real event data.
  const resource = metadata.payload ?? {};

  return {
    // Mirrors cloud's own fallback exactly (`buildPayload`:
    // `input.deliveryId ?? \`${provider}:${eventType}:${Date.now().toString(36)}\``)
    // rather than substituting the relaycast message id, which cloud's real
    // gateway never does.
    id: deliveryId ?? `${provider}:${eventType}:${Date.now().toString(36)}`,
    workspace: firstString(metadata.workspaceId) ?? fallbackWorkspace,
    type: `${provider}.${eventType}`,
    occurredAt: firstString(metadata.timestamp) ?? message.created_at,
    attempt: 1,
    provider,
    eventType,
    ...(deliveryId ? { deliveryId } : {}),
    ...(path ? { paths: [path] } : {}),
    resource
  };
}

function isModeLaunchHandle(value: unknown): value is ModeLaunchHandle {
  if (typeof value !== 'object' || value === null || !('done' in value)) {
    return false;
  }
  const done = (value as { done?: unknown }).done;
  return typeof done === 'object' && done !== null && typeof (done as { then?: unknown }).then === 'function';
}

function isRunEventInput(value: unknown): value is RunEventInput {
  if (!isPlainObject(value) || !isPlainObject(value.message)) {
    return false;
  }
  const message = value.message;
  return (
    typeof message.id === 'string' &&
    typeof message.channel_id === 'string' &&
    typeof message.channel_name === 'string' &&
    typeof message.agent_id === 'string' &&
    typeof message.text === 'string' &&
    typeof message.created_at === 'string'
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function firstString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function sanitizeForNodeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '-');
}

function requireNonEmpty(value: string | undefined, label: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`defineWorkforcePersonaNode: ${label} is required`);
  }
  return trimmed;
}

export type { FleetNodeDefinition } from '@agent-relay/fleet';
