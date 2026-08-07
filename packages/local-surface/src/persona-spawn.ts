import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';

import * as fleetSdk from '@agent-relay/fleet';
import {
  action,
  defineNode,
  type FleetActionContext,
  type FleetActionDefinition,
  type FleetNodeDefinition
} from '@agent-relay/fleet';
import {
  buildPersonaSpawnPlan,
  executePersonaSpawnPlan,
  type ExecutionHandle,
  type PersonaSpawnPlan
} from '@agentworkforce/persona-kit';
import {
  resolvePersonaReference,
  type LoadOptions,
  type ResolvedPersonaReference
} from '@agentworkforce/persona-registry';

export const WORKFORCE_PERSONA_SPAWN_CAPABILITY = 'spawn:persona';

export interface WorkforcePersonaSpawnInput {
  /** Agent Relay identity to register for the launched harness. */
  name: string;
  /** Persona id, built-in intent, or JSON path. */
  persona: string;
  /** Concrete assignment layered over the persona's standing instructions. */
  task?: string;
  /** Project cwd used for registry lookup and the isolated runtime mount. */
  cwd?: string;
  /** Relay channels the persona should join. */
  channels?: string[];
}

export interface WorkforcePersonaSpawnResult {
  spawned: true;
  name: string;
  persona: string;
  harness: string;
  model: string;
  source: string;
  result: unknown;
}

export interface WorkforcePersonaSpawnOptions {
  /** Default project cwd. Request-local `cwd` wins. */
  cwd?: string;
  /** Registry source configuration shared with `agentworkforce agent`. */
  registry?: Omit<LoadOptions, 'cwd'>;
  /** Forward non-fatal registry warnings to the node host. */
  onWarning?: (warning: string) => void;
}

export interface DefineWorkforcePersonaSpawnNodeOptions extends WorkforcePersonaSpawnOptions {
  nodeName: string;
  maxAgents?: number;
  tags?: string[];
  version?: string;
}

interface PreparedPersonaExecution {
  handle: ExecutionHandle;
  scratchDir: string;
  plan: PersonaSpawnPlan;
  resolved: ResolvedPersonaReference;
}

type ResolvePersona = typeof resolvePersonaReference;
type BuildPlan = typeof buildPersonaSpawnPlan;
type ExecutePlan = typeof executePersonaSpawnPlan;
type CheckFleetCompatibility = () => void;

let resolvePersonaImpl: ResolvePersona = resolvePersonaReference;
let buildPlanImpl: BuildPlan = buildPersonaSpawnPlan;
let executePlanImpl: ExecutePlan = executePersonaSpawnPlan;
let checkFleetCompatibilityImpl: CheckFleetCompatibility = assertFleetCompatibility;

/** @internal Test seam for SDK orchestration; not part of the stable API. */
export function __setPersonaSpawnImplementationsForTest(input?: {
  resolvePersona?: ResolvePersona;
  buildPlan?: BuildPlan;
  executePlan?: ExecutePlan;
  checkFleetCompatibility?: CheckFleetCompatibility;
}): void {
  resolvePersonaImpl = input?.resolvePersona ?? resolvePersonaReference;
  buildPlanImpl = input?.buildPlan ?? buildPersonaSpawnPlan;
  executePlanImpl = input?.executePlan ?? executePersonaSpawnPlan;
  checkFleetCompatibilityImpl = input?.checkFleetCompatibility ?? assertFleetCompatibility;
}

/**
 * A reusable `spawn:persona` capability for custom fleet node definitions.
 * Resolution and preparation happen on the target node, so local persona
 * paths, installed skills, and MCP configuration never have to exist on the
 * orchestrator.
 */
export function workforcePersonaSpawnCapability(
  options: WorkforcePersonaSpawnOptions = {}
): FleetActionDefinition<unknown, WorkforcePersonaSpawnResult> {
  const inFlight = new Map<string, Promise<WorkforcePersonaSpawnResult>>();
  const active = new Map<string, PreparedPersonaExecution>();

  return action({}, async (rawInput, ctx) => {
    checkFleetCompatibilityImpl();
    const input = parseSpawnInput(rawInput);
    const cwd = resolvePath(input.cwd ?? options.cwd ?? process.cwd());
    const resolved = resolvePersonaImpl(input.persona, {
      ...(options.registry ?? {}),
      cwd
    });
    for (const warning of resolved.warnings) options.onWarning?.(warning);

    // Same discipline as pear's personaSpawnRequestKey, but node-scoped: two
    // callers racing to launch the same persona into the same project await a
    // single preparation + capacity request.
    const key = [ctx.node.name, cwd, resolved.path ?? resolved.spec.id].join('\u001f');
    const existing = inFlight.get(key);
    if (existing) return existing;

    const launch = launchResolvedPersona({ input, cwd, resolved, ctx, active });
    inFlight.set(key, launch);
    try {
      return await launch;
    } finally {
      if (inFlight.get(key) === launch) inFlight.delete(key);
    }
  });
}

/**
 * Define a fleet node whose capacity is interactive AgentWorkforce personas.
 * This is the ergonomic counterpart to `defineWorkforcePersonaNode`, which is
 * intentionally for one long-lived cloud/onEvent persona.
 */
export function defineWorkforcePersonaSpawnNode(
  options: DefineWorkforcePersonaSpawnNodeOptions
): FleetNodeDefinition {
  const nodeName = requireNonEmpty(options.nodeName, 'nodeName');
  return defineNode({
    name: nodeName,
    ...(options.maxAgents !== undefined ? { maxAgents: options.maxAgents } : {}),
    capabilities: {
      [WORKFORCE_PERSONA_SPAWN_CAPABILITY]: workforcePersonaSpawnCapability(options)
    },
    ...(options.tags ? { tags: [...options.tags] } : {}),
    ...(options.version ? { version: options.version } : {})
  });
}

async function launchResolvedPersona(input: {
  input: WorkforcePersonaSpawnInput;
  cwd: string;
  resolved: ResolvedPersonaReference;
  ctx: FleetActionContext;
  active: Map<string, PreparedPersonaExecution>;
}): Promise<WorkforcePersonaSpawnResult> {
  const { resolved, ctx } = input;
  const scratchDir = await mkdtemp(join(tmpdir(), 'agentworkforce-relay-persona-'));
  let execution: ExecutionHandle | undefined;
  try {
    const built = buildPlanImpl(resolved.selection);
    // Interactive CLI launches use an isolated mount by default even when the
    // persona has no custom filters. Preserve that safety property: skills,
    // AGENTS.md/CLAUDE.md, and generated MCP config must never overwrite the
    // real project while a remote spawn is running.
    const plan: PersonaSpawnPlan = built.mount
      ? built
      : {
          ...built,
          mount: { ignoredPatterns: [], readonlyPatterns: [] }
        };
    execution = await executePlanImpl(plan, {
      cwd: input.cwd,
      mount: { mountDir: scratchDir, includeGit: true, autoSync: true }
    });

    const args = plan.initialPrompt ? [...plan.args, plan.initialPrompt] : [...plan.args];
    const result = await ctx.spawnAgent({
      agent: {
        name: input.input.name,
        runtime: 'pty',
        cli: plan.cli,
        model: resolved.selection.model,
        args,
        ...(input.input.channels ? { channels: [...input.input.channels] } : {}),
        cwd: execution.cwd,
        harness_config: {
          runtime: 'pty',
          command: plan.cli,
          args,
          cwd: execution.cwd,
          ...(Object.keys(plan.env).length > 0 ? { env: plan.env } : {}),
          metadata: {
            workforce_persona: resolved.spec.id,
            // Relay 11.5+ treats this typed launch contract as synchronous:
            // node registration + worker_ready, with release on either failure.
            verify_ready: true,
            require_node_registration: true
          }
        }
      },
      ...(input.input.task !== undefined ? { initialTask: input.input.task } : {}),
      skipRelayPrompt: false,
      invocationId: ctx.invocationId
    });

    input.active.set(input.input.name, {
      handle: execution,
      scratchDir,
      plan,
      resolved
    });
    return {
      spawned: true,
      name: input.input.name,
      persona: resolved.spec.id,
      harness: resolved.selection.harness,
      model: resolved.selection.model,
      source: resolved.source,
      result
    };
  } catch (error) {
    await execution?.dispose();
    await rm(scratchDir, { recursive: true, force: true });
    throw error;
  }
}

function assertFleetCompatibility(): void {
  const supported = (
    fleetSdk as unknown as { FLEET_DYNAMIC_SPAWN_DELEGATION?: unknown }
  ).FLEET_DYNAMIC_SPAWN_DELEGATION;
  if (supported !== true) {
    throw new Error(
      'spawn:persona requires @agent-relay/fleet 11.5 or newer; older Fleet versions cannot delegate a persona action to its resolved harness'
    );
  }
}

function parseSpawnInput(value: unknown): WorkforcePersonaSpawnInput {
  if (!isRecord(value)) throw new Error('spawn:persona input must be an object');
  const name = requireNonEmpty(value.name, 'name');
  const persona = requireNonEmpty(value.persona, 'persona');
  const task = optionalString(value.task, 'task');
  const cwd = optionalString(value.cwd, 'cwd');
  let channels: string[] | undefined;
  if (value.channels !== undefined) {
    if (!Array.isArray(value.channels)) throw new Error('channels must be an array of strings');
    channels = value.channels.map((channel, index) => requireNonEmpty(channel, `channels[${index}]`));
  }
  return {
    name,
    persona,
    ...(task !== undefined ? { task } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(channels ? { channels } : {})
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  return value;
}

function requireNonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}
