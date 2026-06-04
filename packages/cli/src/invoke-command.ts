import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bundleStager, preflightPersona } from '@agentworkforce/deploy';
import { KNOWN_TRIGGER_CATALOG } from '@agentworkforce/persona-kit';
import {
  simulateInvocation,
  type RawGatewayEnvelope,
  type SimulationResult,
  type WorkforceHandler
} from '@agentworkforce/runtime';

export const INVOKE_USAGE = `usage: agentworkforce invoke <persona-path> --fixture <file> [flags]
       agentworkforce invoke --scaffold <type> [--output <file>]

Simulate an invocation: execute the persona's handler against fixture event
envelope(s) with every external side effect recorded, NOT executed, and emit
a machine-readable run record per envelope (Cloud-compatible shape,
origin "local_dry_run").

This is distinct from \`agentworkforce deploy --dry-run\`, which validates the
persona/config and exits without ever invoking the handler.

Flags:
  --fixture <file>         Event fixture (required): a JSON envelope object,
                           a JSON array of envelopes, or NDJSON (one envelope
                           per line). Envelope shape: the runner's
                           RawGatewayEnvelope (id, workspace, type,
                           occurredAt, resource?, name?/cron? for cron).
  --output <file>          Write the run-record JSON to <file>; a human
                           summary still prints to stderr. Default: stdout.
  --input <key>=<value>    Override a declared persona input (repeatable).
  --seed <path>=<file>     Seed the simulated filesystem: VFS <path> gets
                           <file>'s contents (repeatable). Use for provider
                           VFS data the handler reads (e.g.
                           /slack/channels/_index.json).
  --workspace <id>         Workspace id for the simulated ctx; defaults to
                           the first envelope's workspace.
  --scaffold <type>        Emit a fixture skeleton for an event type instead
                           of running a persona. Provider payloads are left
                           as explicit TODO holes; prefer runs export after
                           a real fire exists.
  -h, --help               Print this message.

Exit code: 0 when every dispatched envelope succeeded, 1 when any handler
invocation failed (or on usage/setup errors).
`;

export interface InvokeOptions {
  personaPath: string;
  fixturePath: string;
  outputPath?: string;
  inputs?: Record<string, string>;
  /** VFS path → local file whose contents seed it. */
  seeds?: Record<string, string>;
  workspaceId?: string;
}

export type ParsedInvokeArgs =
  | InvokeOptions
  | { help: true }
  | { scaffold: string; outputPath?: string };

/** Parse `invoke` args. Throws on usage errors (caller maps to exit 1). */
export function parseInvokeArgs(args: readonly string[]): ParsedInvokeArgs {
  let personaPath: string | undefined;
  let fixturePath: string | undefined;
  let outputPath: string | undefined;
  let workspaceId: string | undefined;
  let scaffoldType: string | undefined;
  let sawFixture = false;
  const inputs: Record<string, string> = {};
  const seeds: Record<string, string> = {};

  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '-h' || a === '--help') {
      return { help: true };
    } else if (a === '--fixture') {
      sawFixture = true;
      fixturePath = expectValue('--fixture', args[++i]);
    } else if (a.startsWith('--fixture=')) {
      sawFixture = true;
      fixturePath = expectInline('--fixture', a.slice('--fixture='.length));
    } else if (a === '--output') {
      outputPath = expectValue('--output', args[++i]);
    } else if (a.startsWith('--output=')) {
      outputPath = expectInline('--output', a.slice('--output='.length));
    } else if (a === '--scaffold') {
      scaffoldType = expectValue('--scaffold', args[++i]);
    } else if (a.startsWith('--scaffold=')) {
      scaffoldType = expectInline('--scaffold', a.slice('--scaffold='.length));
    } else if (a === '--workspace') {
      workspaceId = expectValue('--workspace', args[++i]);
    } else if (a.startsWith('--workspace=')) {
      workspaceId = expectInline('--workspace', a.slice('--workspace='.length));
    } else if (a === '--input') {
      addKeyValue('--input', expectValue('--input', args[++i]), inputs);
    } else if (a.startsWith('--input=')) {
      addKeyValue('--input', expectInline('--input', a.slice('--input='.length)), inputs);
    } else if (a === '--seed') {
      addKeyValue('--seed', expectValue('--seed', args[++i]), seeds);
    } else if (a.startsWith('--seed=')) {
      addKeyValue('--seed', expectInline('--seed', a.slice('--seed='.length)), seeds);
    } else if (a.startsWith('--')) {
      throw new Error(`invoke: unknown flag "${a}"`);
    } else if (!personaPath) {
      personaPath = path.resolve(a);
    } else {
      throw new Error(`invoke: unexpected positional argument "${a}"`);
    }
  }

  if (scaffoldType) {
    const invalidScaffoldFlags = [
      sawFixture ? '--fixture' : '',
      workspaceId ? '--workspace' : '',
      Object.keys(inputs).length > 0 ? '--input' : '',
      Object.keys(seeds).length > 0 ? '--seed' : '',
      personaPath ? '<persona-path>' : ''
    ].filter(Boolean);
    if (invalidScaffoldFlags.length > 0) {
      throw new Error(
        `invoke: --scaffold only accepts --output; remove ${invalidScaffoldFlags.join(', ')}`
      );
    }
    // Scaffold mode authors a fixture skeleton; no persona/fixture needed.
    return { scaffold: scaffoldType, ...(outputPath ? { outputPath: path.resolve(outputPath) } : {}) };
  }
  if (!personaPath) {
    throw new Error('invoke: missing persona path. Usage: agentworkforce invoke <persona-path> --fixture <file>');
  }
  if (!fixturePath) {
    throw new Error('invoke: missing --fixture <file> (a JSON envelope, JSON array, or NDJSON file)');
  }

  return {
    personaPath,
    fixturePath: path.resolve(fixturePath),
    ...(outputPath ? { outputPath: path.resolve(outputPath) } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(Object.keys(inputs).length > 0 ? { inputs } : {}),
    ...(Object.keys(seeds).length > 0 ? { seeds } : {})
  };
}

function expectValue(flag: string, value: string | undefined): string {
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`invoke: ${flag} expects a value`);
  }
  return value;
}

function expectInline(flag: string, value: string): string {
  if (!value) throw new Error(`invoke: ${flag} expects a value`);
  return value;
}

function addKeyValue(flag: string, raw: string, into: Record<string, string>): void {
  const eq = raw.indexOf('=');
  if (eq <= 0) {
    throw new Error(`invoke: ${flag} expects <key>=<value>; got "${raw}"`);
  }
  into[raw.slice(0, eq)] = raw.slice(eq + 1);
}

/**
 * Parse fixture file contents into raw envelopes. Accepts a single JSON
 * object, a JSON array of objects, or NDJSON (one JSON object per line).
 * Validation of envelope semantics happens downstream via the runner's own
 * `shimEnvelope`; this only enforces "every entry is an object".
 */
export function parseFixtureEnvelopes(raw: string, label: string): RawGatewayEnvelope[] {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error(`invoke: fixture ${label} is empty`);
  }

  if (trimmed.startsWith('[')) {
    const parsed = parseJson(trimmed, label) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error(`invoke: fixture ${label} starts with "[" but is not a JSON array`);
    }
    return parsed.map((entry, index) => asEnvelopeObject(entry, `${label}[${index}]`));
  }

  if (trimmed.startsWith('{')) {
    // Either a single JSON object (possibly pretty-printed across lines) or
    // NDJSON. Try whole-file JSON first; fall back to per-line parsing.
    try {
      const single = JSON.parse(trimmed) as unknown;
      return [asEnvelopeObject(single, label)];
    } catch {
      /* fall through to NDJSON */
    }
    return trimmed
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line, index) =>
        asEnvelopeObject(parseJson(line, `${label}:${index + 1}`), `${label}:${index + 1}`)
      );
  }

  throw new Error(
    `invoke: fixture ${label} must be a JSON envelope object, a JSON array, or NDJSON lines`
  );
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(
      `invoke: fixture ${label} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

function asEnvelopeObject(value: unknown, label: string): RawGatewayEnvelope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`invoke: fixture ${label} must be a JSON object envelope`);
  }
  return value as RawGatewayEnvelope;
}

/**
 * Extract the handler from a dynamically imported agent bundle. Mirrors the
 * extraction the generated runner.mjs performs (deploy bundle.ts
 * renderRunner): defineAgent default export → `.handler`; `{ handler }`
 * object → `.handler`; bare function fallback.
 */
export function extractBundleHandler(
  userModule: Record<string, unknown>,
  personaId: string
): WorkforceHandler {
  const exported = (userModule.default ?? userModule.handler) as
    | { __workforceAgent?: boolean; handler?: unknown }
    | ((...args: unknown[]) => unknown)
    | undefined;

  let candidate: unknown;
  if (exported && typeof exported === 'object' && exported.__workforceAgent) {
    candidate = exported.handler;
  } else if (exported && typeof exported === 'object' && typeof exported.handler === 'function') {
    candidate = exported.handler;
  } else {
    candidate = exported;
  }

  if (typeof candidate !== 'function') {
    throw new Error(
      `invoke: ${personaId} did not default-export defineAgent({ ..., handler }). Did you forget \`export default defineAgent(...)\`?`
    );
  }
  return candidate as WorkforceHandler;
}

export interface RunInvokeIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const defaultIO: RunInvokeIO = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text)
};

/**
 * `agentworkforce invoke` entry. Stages the agent bundle next to the
 * persona (under `.workforce/invoke-build/`, mirroring deploy's build dir
 * so the externalized `@agentworkforce/runtime` import resolves from the
 * persona's project tree), imports the handler, replays the fixture through
 * `simulateInvocation`, prints a human summary to stderr and the
 * machine-readable record to stdout (or `--output`).
 *
 * Sets `process.exitCode` (never calls `process.exit`) so streams flush
 * and tests can call this directly.
 */
export async function runInvoke(
  args: readonly string[],
  io: RunInvokeIO = defaultIO
): Promise<SimulationResult | undefined> {
  let opts: ParsedInvokeArgs;
  try {
    opts = parseInvokeArgs(args);
  } catch (err) {
    io.stderr(`${err instanceof Error ? err.message : String(err)}\n\n${INVOKE_USAGE}`);
    process.exitCode = 1;
    return undefined;
  }
  if ('help' in opts) {
    io.stdout(INVOKE_USAGE);
    return undefined;
  }
  if ('scaffold' in opts) {
    const { fixture, warnings } = scaffoldFixture(opts.scaffold);
    for (const warning of warnings) io.stderr(`warn: ${warning}\n`);
    const text = `${JSON.stringify(fixture, null, 2)}\n`;
    if (opts.outputPath) {
      await writeFile(opts.outputPath, text, 'utf8');
      io.stderr(`fixture skeleton written to ${opts.outputPath}\n`);
    } else {
      io.stdout(text);
    }
    return undefined;
  }

  try {
    return await runInvokeWithOptions(opts, io);
  } catch (err) {
    io.stderr(`invoke: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
    return undefined;
  }
}

async function runInvokeWithOptions(
  opts: InvokeOptions,
  io: RunInvokeIO
): Promise<SimulationResult> {
  const preflight = await preflightPersona(opts.personaPath);
  for (const warning of preflight.warnings) {
    io.stderr(`warn: ${warning}\n`);
  }

  // Stage inside the persona's tree (not os.tmpdir) — the bundle leaves
  // `@agentworkforce/runtime` external, so Node must be able to walk up
  // from the bundle to a node_modules that provides it, exactly like
  // deploy's `.workforce/build/` convention.
  const buildRoot = path.join(preflight.personaDir, '.workforce', 'invoke-build');
  await mkdir(buildRoot, { recursive: true });
  const buildDir = await mkdtemp(path.join(buildRoot, `${preflight.persona.id}-`));

  try {
    const bundle = await bundleStager.stage({
      personaPath: preflight.personaPath,
      persona: preflight.persona,
      outDir: buildDir
    });

    // Cache-bust the import so repeated invokes in one process (tests,
    // watch flows) load the freshly staged bundle, not the ESM cache.
    const bundleUrl = `${pathToFileURL(bundle.bundlePath).href}?invoke=${randomUUID()}`;
    const userModule = (await import(bundleUrl)) as Record<string, unknown>;
    const handler = extractBundleHandler(userModule, preflight.persona.id);

    const fixtureRaw = await readFile(opts.fixturePath, 'utf8').catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        throw new Error(`fixture not found at ${opts.fixturePath}`);
      }
      throw err;
    });
    const envelopes = parseFixtureEnvelopes(fixtureRaw, path.basename(opts.fixturePath));

    const seeds = await loadSeeds(opts.seeds);

    const result = await simulateInvocation({
      persona: preflight.persona,
      handler,
      envelopes,
      ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
      ...(opts.inputs ? { agent: { inputValues: opts.inputs } } : {}),
      ...(seeds ? { files: seeds } : {})
    });

    io.stderr(renderHumanSummary(result));

    const json = `${JSON.stringify(result, null, 2)}\n`;
    if (opts.outputPath) {
      await writeFile(opts.outputPath, json, 'utf8');
      io.stderr(`run record written to ${opts.outputPath}\n`);
    } else {
      io.stdout(json);
    }

    process.exitCode = result.exitCode;
    return result;
  } finally {
    await rm(buildDir, { recursive: true, force: true });
  }
}

async function loadSeeds(
  seeds: Record<string, string> | undefined
): Promise<Record<string, string> | undefined> {
  if (!seeds) return undefined;
  const loaded: Record<string, string> = {};
  for (const [vfsPath, localFile] of Object.entries(seeds)) {
    loaded[vfsPath] = await readFile(path.resolve(localFile), 'utf8').catch(
      (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') {
          throw new Error(`--seed ${vfsPath}: local file not found at ${localFile}`);
        }
        throw err;
      }
    );
  }
  return loaded;
}

export function renderHumanSummary(result: SimulationResult): string {
  const lines: string[] = [];
  lines.push(`simulation: ${result.summary.total} run(s) — ${result.summary.succeeded} ok, ${result.summary.failed} failed${result.summary.unsupported > 0 ? `, ${result.summary.unsupported} unsupported envelope(s) skipped` : ''}`);
  for (const run of result.runs) {
    const head = `  [${run.status === 'succeeded' ? 'ok' : 'FAIL'}] ${run.trigger.eventSource}/${run.trigger.kind} ${run.runId} (${run.durationMs}ms, ${run.simulation.sideEffects.length} side effect(s) recorded)`;
    lines.push(head);
    if (run.summary) lines.push(`        summary: ${run.summary}`);
    if (run.error) lines.push(`        error: ${run.error}`);
  }
  for (const skipped of result.unsupported) {
    lines.push(`  [skip] unsupported envelope ${skipped.id} (${skipped.type})`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Cold-start fixture authoring (workforce#189): emit a RawGatewayEnvelope
 * skeleton for an event type before any real fire exists. The frame is
 * filled in; for provider events the `resource` payload shape is decided by
 * adapter normalization + cloud's buildEnvelope and CANNOT be guessed here,
 * so it is left as an explicit TODO hole — prefer
 * `agentworkforce runs export <runId> --fixture …` once a real fire exists.
 *
 * `<type>` is validated against KNOWN_TRIGGER_CATALOG with the same
 * warn-don't-block stance as lintTriggers.
 */
export function scaffoldFixture(type: string): {
  fixture: Record<string, unknown>;
  warnings: string[];
} {
  const warnings: string[] = [];
  const occurredAt = new Date().toISOString();

  if (type === 'cron.tick' || type.startsWith('cron.')) {
    if (type !== 'cron.tick') {
      // Preserve what was asked for (a silent rewrite would scaffold a
      // DIFFERENT event type than requested) but warn: the gateway
      // delivers schedule fires as `cron.tick`, and the runner shim
      // treats any `cron.*` as a cron event.
      warnings.push(
        `the gateway delivers schedule fires as "cron.tick"; preserving requested type "${type}" (the runner shim still dispatches any cron.* as a cron event)`
      );
    }
    return {
      fixture: {
        id: 'evt_local_1',
        workspace: 'ws-local',
        type,
        occurredAt,
        name: 'TODO: your schedule name (persona schedules[].name)',
        cron: '0 9 * * 1'
      },
      warnings
    };
  }

  const firstDot = type.indexOf('.');
  const provider = firstDot > 0 ? type.slice(0, firstDot) : '';
  const eventName = firstDot > 0 ? type.slice(firstDot + 1) : '';
  if (!provider || !eventName) {
    warnings.push(
      `"${type}" is not a recognized envelope type shape (expected "cron.tick" or "<provider>.<event>"); emitting a provider-style skeleton anyway`
    );
  } else {
    const catalog = KNOWN_TRIGGER_CATALOG as Record<string, unknown>;
    const events = catalog[provider];
    if (events === undefined) {
      warnings.push(
        `provider "${provider}" is not in KNOWN_TRIGGER_CATALOG (known: ${Object.keys(catalog).join(', ')}); scaffolding anyway`
      );
    } else {
      const known = Array.isArray(events)
        ? events.includes(eventName)
        : typeof events === 'object' && events !== null && eventName in (events as Record<string, unknown>);
      if (!known) {
        warnings.push(
          `event "${eventName}" is not a known ${provider} trigger in KNOWN_TRIGGER_CATALOG; scaffolding anyway`
        );
      }
    }
  }

  return {
    fixture: {
      id: 'evt_local_1',
      workspace: 'ws-local',
      type,
      occurredAt,
      resource: {
        TODO:
          'the provider payload shape is decided by adapter normalization + cloud buildEnvelope; ' +
          'export a real fire with `agentworkforce runs export <runId> --fixture event.json` to get the exact shape'
      }
    },
    warnings
  };
}
