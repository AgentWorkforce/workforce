import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { bundleStager } from '@agentworkforce/deploy';
import { decodeEventFrame } from '@agentworkforce/events';
import {
  executeLocalRun,
  mergeAllowedHttpRules,
  resolvePersonaHttpReadRules,
  resolveLocalEffectPolicy,
  type EffectPolicyV1,
  type LocalHttpFixture,
  type LocalModelFixture,
  type LocalPreviewState,
  type RunRecordV2
} from '@agentworkforce/runtime';
import {
  parseInvokeCase,
  type ParsedCaseModelFixture,
  type ParsedCaseExpectationProviderAction,
  type ParsedInvokeCase
} from './invoke/case-file.js';
import { prepareInvokeTarget } from './invoke/prepare-target.js';

export const INVOKE_USAGE = `usage: agentworkforce invoke <agent> (--fixture <file> | --schedule <name> | --case <file>) [flags]
       agentworkforce invoke --scaffold <type> [--output <file>]

Run a local preview invocation through the composable runtime path. Effects are
previewed locally: no live writes, shell execution, or child runs occur.

Flags:
  --fixture <file>         Event fixture, EventFrame, legacy gateway envelope,
                           replay bundle, JSON array, or NDJSON.
  --schedule <name>        Invoke the compiled agent's declared schedule by name.
  --case <file>            Run a checked-in YAML case with assertions.
  --reads <mode>           fixtures | live (default: fixtures)
  --model <mode>           stub | fixture | live (default: stub)
  --watch                  Re-run the selected source when authored files change.
  --output <file>          Write raw RunRecord JSON to <file>.
  --input <key>=<value>    Override a declared input (repeatable).
  --seed <path>=<file>     Seed preview file state from a local file (repeatable).
  --workspace <id>         Workspace id for locally synthesized events.
  --scaffold <type>        Emit a fixture skeleton for an event type instead of running.
  -h, --help               Print this message.
`;

type InvokeSource =
  | { kind: 'fixture'; path: string }
  | { kind: 'schedule'; name: string }
  | { kind: 'case'; path: string };

export interface InvokeOptions {
  personaPath: string;
  source: InvokeSource;
  outputPath?: string;
  inputs?: Record<string, string>;
  seeds?: Record<string, string>;
  workspaceId?: string;
  reads?: 'fixtures' | 'live';
  model?: 'stub' | 'fixture' | 'live';
  watch?: boolean;
}

export type ParsedInvokeArgs =
  | InvokeOptions
  | { help: true }
  | { scaffold: string; outputPath?: string };

export interface RunInvokeIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export interface InvokeInternals {
  waitForWatchChange?: (files: readonly string[]) => Promise<'change' | 'stop'>;
}

const defaultIO: RunInvokeIO = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text)
};

export async function runInvoke(
  args: readonly string[],
  io: RunInvokeIO = defaultIO,
  internals: InvokeInternals = {}
): Promise<RunRecordV2 | RunRecordV2[] | undefined> {
  let opts: ParsedInvokeArgs;
  try {
    opts = parseInvokeArgs(args);
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n\n${INVOKE_USAGE}`);
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
    return opts.watch
      ? await runInvokeWatchLoop(opts, io, internals)
      : (await runInvokeOnce(opts, io)).output;
  } catch (error) {
    io.stderr(`invoke: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return undefined;
  }
}

export function parseInvokeArgs(args: readonly string[]): ParsedInvokeArgs {
  let personaPath: string | undefined;
  let fixturePath: string | undefined;
  let scheduleName: string | undefined;
  let casePath: string | undefined;
  let outputPath: string | undefined;
  let workspaceId: string | undefined;
  let scaffoldType: string | undefined;
  let reads: InvokeOptions['reads'];
  let model: InvokeOptions['model'];
  let watch = false;
  const inputs: Record<string, string> = {};
  const seeds: Record<string, string> = {};

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '-h' || arg === '--help') {
      return { help: true };
    } else if (arg === '--fixture') {
      fixturePath = expectValue('--fixture', args[++i]);
    } else if (arg.startsWith('--fixture=')) {
      fixturePath = expectInline('--fixture', arg.slice('--fixture='.length));
    } else if (arg === '--schedule') {
      scheduleName = expectValue('--schedule', args[++i]);
    } else if (arg.startsWith('--schedule=')) {
      scheduleName = expectInline('--schedule', arg.slice('--schedule='.length));
    } else if (arg === '--case') {
      casePath = expectValue('--case', args[++i]);
    } else if (arg.startsWith('--case=')) {
      casePath = expectInline('--case', arg.slice('--case='.length));
    } else if (arg === '--reads') {
      reads = expectEnum('--reads', args[++i], ['fixtures', 'live']);
    } else if (arg.startsWith('--reads=')) {
      reads = expectEnum('--reads', arg.slice('--reads='.length), ['fixtures', 'live']);
    } else if (arg === '--model') {
      model = expectEnum('--model', args[++i], ['stub', 'fixture', 'live']);
    } else if (arg.startsWith('--model=')) {
      model = expectEnum('--model', arg.slice('--model='.length), ['stub', 'fixture', 'live']);
    } else if (arg === '--watch') {
      watch = true;
    } else if (arg === '--output') {
      outputPath = expectValue('--output', args[++i]);
    } else if (arg.startsWith('--output=')) {
      outputPath = expectInline('--output', arg.slice('--output='.length));
    } else if (arg === '--workspace') {
      workspaceId = expectValue('--workspace', args[++i]);
    } else if (arg.startsWith('--workspace=')) {
      workspaceId = expectInline('--workspace', arg.slice('--workspace='.length));
    } else if (arg === '--scaffold') {
      scaffoldType = expectValue('--scaffold', args[++i]);
    } else if (arg.startsWith('--scaffold=')) {
      scaffoldType = expectInline('--scaffold', arg.slice('--scaffold='.length));
    } else if (arg === '--input') {
      addKeyValue('--input', expectValue('--input', args[++i]), inputs);
    } else if (arg.startsWith('--input=')) {
      addKeyValue('--input', expectInline('--input', arg.slice('--input='.length)), inputs);
    } else if (arg === '--seed') {
      addKeyValue('--seed', expectValue('--seed', args[++i]), seeds);
    } else if (arg.startsWith('--seed=')) {
      addKeyValue('--seed', expectInline('--seed', arg.slice('--seed='.length)), seeds);
    } else if (arg.startsWith('--')) {
      throw new Error(`invoke: unknown flag "${arg}"`);
    } else if (!personaPath) {
      personaPath = path.resolve(arg);
    } else {
      throw new Error(`invoke: unexpected positional argument "${arg}"`);
    }
  }

  if (scaffoldType) {
    const invalid = [
      fixturePath ? '--fixture' : '',
      scheduleName ? '--schedule' : '',
      casePath ? '--case' : '',
      workspaceId ? '--workspace' : '',
      Object.keys(inputs).length > 0 ? '--input' : '',
      Object.keys(seeds).length > 0 ? '--seed' : '',
      personaPath ? '<agent>' : ''
    ].filter(Boolean);
    if (invalid.length > 0) {
      throw new Error(`invoke: --scaffold only accepts --output; remove ${invalid.join(', ')}`);
    }
    return { scaffold: scaffoldType, ...(outputPath ? { outputPath: path.resolve(outputPath) } : {}) };
  }

  if (!personaPath) throw new Error('invoke: missing agent path');
  const sources = [
    fixturePath ? '--fixture' : '',
    scheduleName ? '--schedule' : '',
    casePath ? '--case' : ''
  ].filter(Boolean);
  if (sources.length === 0) {
    throw new Error('invoke: choose exactly one event source: --fixture <file>, --schedule <name>, or --case <file>');
  }
  if (sources.length > 1) {
    throw new Error(`invoke: event sources are mutually exclusive; choose one of ${sources.join(', ')}`);
  }

  return {
    personaPath,
    source: fixturePath
      ? { kind: 'fixture', path: path.resolve(fixturePath) }
      : scheduleName
        ? { kind: 'schedule', name: scheduleName }
        : { kind: 'case', path: path.resolve(casePath!) },
    ...(outputPath ? { outputPath: path.resolve(outputPath) } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(reads ? { reads } : {}),
    ...(model ? { model } : {}),
    ...(watch ? { watch: true } : {}),
    ...(Object.keys(inputs).length > 0 ? { inputs } : {}),
    ...(Object.keys(seeds).length > 0 ? { seeds } : {})
  };
}

export function parseFixtureEnvelopes(raw: string, label: string): unknown[] {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error(`invoke: fixture ${label} is empty`);
  if (trimmed.startsWith('[')) {
    const parsed = parseJson(trimmed, label);
    if (!Array.isArray(parsed)) throw new Error(`invoke: fixture ${label} starts with "[" but is not a JSON array`);
    return parsed;
  }
  if (trimmed.startsWith('{')) {
    try {
      return [JSON.parse(trimmed) as unknown];
    } catch {
      return trimmed
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line, index) => parseJson(line, `${label}:${index + 1}`));
    }
  }
  throw new Error(`invoke: fixture ${label} must be a JSON object, JSON array, or NDJSON lines`);
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(
      `invoke: fixture ${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function runInvokeOnce(
  opts: InvokeOptions,
  io: RunInvokeIO,
  initialState?: LocalPreviewState
): Promise<{ output: RunRecordV2 | RunRecordV2[]; state?: LocalPreviewState }> {
  const target = await prepareInvokeTarget(opts.personaPath);
  for (const warning of target.warnings) io.stderr(`warn: ${warning}\n`);

  const buildRoot = path.join(path.dirname(target.personaPath), '.workforce', 'invoke-build');
  await mkdir(buildRoot, { recursive: true });
  const buildDir = await mkdtemp(path.join(buildRoot, `${target.compiled.persona.id}-`));

  try {
    const bundle = await bundleStager.stage({
      personaPath: target.personaPath,
      persona: target.compiled.persona,
      outDir: buildDir
    });

    const seededFiles = initialState ? undefined : await loadSeeds(opts.seeds);
    const initialPreviewState = initialState ?? (seededFiles ? { files: seededFiles } : undefined);
    const initialPolicy = resolveLocalEffectPolicy({
      ...(opts.reads ? { reads: opts.reads } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      allowedHttp: resolvePersonaHttpReadRules(target.compiled.persona)
    });

    let output: RunRecordV2 | RunRecordV2[];
    let state: LocalPreviewState | undefined;
    if (opts.source.kind === 'case') {
      ({ output, state } = await runCaseInvoke(
        target.compiled,
        bundle.bundlePath,
        opts as InvokeOptions & { source: { kind: 'case'; path: string } },
        initialPolicy,
        initialPreviewState
      ));
    } else if (opts.source.kind === 'schedule') {
      ({ output, state } = await runScheduleInvoke(
        target.compiled,
        bundle.bundlePath,
        opts as InvokeOptions & { source: { kind: 'schedule'; name: string } },
        initialPolicy,
        initialPreviewState
      ));
    } else {
      ({ output, state } = await runFixtureInvoke(
        target.compiled,
        bundle.bundlePath,
        opts as InvokeOptions & { source: { kind: 'fixture'; path: string } },
        initialPolicy,
        initialPreviewState
      ));
    }

    io.stderr(renderHumanSummary(output));
    const json = `${JSON.stringify(output, null, 2)}\n`;
    if (opts.outputPath) {
      await writeFile(opts.outputPath, json, 'utf8');
      io.stderr(`run record written to ${opts.outputPath}\n`);
    } else {
      io.stdout(json);
    }
    process.exitCode = deriveExitCode(output);
    return { output, state };
  } finally {
    await rm(buildDir, { recursive: true, force: true });
  }
}

async function runInvokeWatchLoop(
  opts: InvokeOptions,
  io: RunInvokeIO,
  internals: InvokeInternals
): Promise<RunRecordV2 | RunRecordV2[]> {
  const waitForWatchChange = internals.waitForWatchChange ?? waitForWatchedFilesChange;
  let run = await runInvokeOnce(opts, io);
  let latest = run.output;
  let state = run.state;

  while (true) {
    const watchFiles = await collectWatchedFiles(opts);
    io.stderr(`watch: waiting for changes across ${watchFiles.length} file(s); press Ctrl+C to stop\n`);
    const next = await waitForWatchChange(watchFiles);
    if (next === 'stop') return latest;
    io.stderr('watch: change detected, rerunning preview...\n');
    run = await runInvokeOnce(opts, io, state);
    latest = run.output;
    state = run.state;
  }
}

async function runScheduleInvoke(
  compiled: Awaited<ReturnType<typeof prepareInvokeTarget>>['compiled'],
  bundlePath: string,
  opts: InvokeOptions & { source: { kind: 'schedule'; name: string } },
  policy: EffectPolicyV1,
  initialState: LocalPreviewState | undefined
): Promise<{ output: RunRecordV2; state: LocalPreviewState }> {
  const schedule = compiled.agent.schedules?.find((entry) => entry.name === opts.source.name);
  if (!schedule) {
    const valid = compiled.agent.schedules?.map((entry) => entry.name).join(', ') ?? '(none)';
    throw new Error(`invoke: unknown schedule "${opts.source.name}". Declared schedules: ${valid}`);
  }
  const event = decodeEventFrame({
    id: `cron_${schedule.name}`,
    workspace: opts.workspaceId ?? 'ws-local',
    type: 'cron.tick',
    occurredAt: '2026-07-15T09:00:00.000Z',
    name: schedule.name,
    cron: schedule.cron
  }).frame;
  const result = await executeLocalRun({
    request: {
      schemaVersion: 1,
      agent: compiled,
      event,
      mode: 'preview',
      inputs: opts.inputs ?? {},
      policy,
      state: {
        schemaVersion: 1,
        kind: initialState?.files ? 'fixtures' : 'empty',
        fidelity: initialState?.files ? 'fixture' : 'simulated'
      }
    },
    bundlePath,
    sourcePath: compiled.handlerEntry,
    inputs: opts.inputs,
    state: initialState,
    sourceFidelity: {
      state: initialState?.files ? 'fixture' : 'simulated',
      inputs: opts.inputs && Object.keys(opts.inputs).length > 0 ? 'current' : 'unavailable',
      http: policy.reads === 'live' ? 'current' : 'unavailable',
      model: policy.model === 'live' ? 'current' : policy.model === 'stub' ? 'simulated' : 'unavailable'
    }
  });
  return { output: result.record, state: result.state };
}

async function runFixtureInvoke(
  compiled: Awaited<ReturnType<typeof prepareInvokeTarget>>['compiled'],
  bundlePath: string,
  opts: InvokeOptions & { source: { kind: 'fixture'; path: string } },
  policy: EffectPolicyV1,
  initialState: LocalPreviewState | undefined
): Promise<{ output: RunRecordV2 | RunRecordV2[]; state: LocalPreviewState | undefined }> {
  const raw = await readFile(opts.source.path, 'utf8');
  const entries = parseFixtureEnvelopes(raw, path.basename(opts.source.path));
  let state: LocalPreviewState = initialState ?? {};
  const records: RunRecordV2[] = [];
  for (const entry of entries) {
    const normalized = normalizeFixtureEntry(entry);
    const { event, historicalState, stateFidelity, replayProvenance } = normalized;
    const replaySource = stateFidelity !== undefined;
    const inputs = normalized.historicalInputs ? { ...normalized.historicalInputs, ...(opts.inputs ?? {}) } : (opts.inputs ?? {});
    const result = await executeLocalRun({
      request: {
        schemaVersion: 1,
        agent: compiled,
        event,
        mode: replaySource ? 'replay' : 'preview',
        inputs,
        policy,
        state: {
          schemaVersion: 1,
          kind: replaySource ? 'replay' : initialState?.files ? 'fixtures' : 'empty',
          fidelity: stateFidelity ?? (initialState?.files ? 'fixture' : 'simulated')
        }
      },
      bundlePath,
      sourcePath: compiled.handlerEntry,
      inputs,
      state: mergeState(state, historicalState),
      ...(replayProvenance ? { replayProvenance } : {}),
      sourceFidelity: normalized.sourceFidelity ?? {
        state: stateFidelity ?? (initialState?.files ? 'fixture' : 'simulated'),
        inputs: normalized.historicalInputs
          ? Object.keys(opts.inputs ?? {}).length > 0 ? 'current' : 'historical'
          : opts.inputs && Object.keys(opts.inputs).length > 0 ? 'current' : 'unavailable',
        http: replaySource ? 'unavailable' : policy.reads === 'live' ? 'current' : 'unavailable',
        model: replaySource
          ? 'unavailable'
          : policy.model === 'live'
            ? 'current'
            : policy.model === 'stub'
              ? 'simulated'
              : 'unavailable'
      }
    });
    state = result.state;
    records.push(result.record);
  }
  return { output: records.length === 1 ? records[0] : records, state };
}

async function runCaseInvoke(
  compiled: Awaited<ReturnType<typeof prepareInvokeTarget>>['compiled'],
  bundlePath: string,
  opts: InvokeOptions & { source: { kind: 'case'; path: string } },
  basePolicy: EffectPolicyV1,
  initialState: LocalPreviewState | undefined
): Promise<{ output: RunRecordV2; state: LocalPreviewState }> {
  const parsedCase = await parseInvokeCase(opts.source.path);
  const httpFixtures = await loadCaseHttpFixtures(parsedCase);
  const modelFixtures = await loadCaseModelFixtures(parsedCase);
  const policy = resolveLocalEffectPolicy({
    ...basePolicy,
    ...parsedCase.policy,
    allowedHttp: mergeAllowedHttpRules(
      basePolicy.allowedHttp,
      httpFixtures.map((fixture) => ({ method: fixture.method, urlGlob: fixture.match }))
    )
  });
  const inputs = { ...parsedCase.inputs, ...(opts.inputs ?? {}) };
  let state: LocalPreviewState = initialState ?? {};
  const records: RunRecordV2[] = [];
  const allLogs: string[] = [];

  for (const event of parsedCase.events) {
    const result = await executeLocalRun({
      request: {
        schemaVersion: 1,
        agent: compiled,
        event: {
          ...event,
          workspace: opts.workspaceId ?? event.workspace ?? 'ws-local'
        },
        mode: 'preview',
        inputs,
        policy,
        state: {
          schemaVersion: 1,
          kind: 'fixtures',
          fidelity: 'fixture'
        }
      },
      bundlePath,
      sourcePath: compiled.handlerEntry,
      inputs,
      state,
      httpFixtures,
      modelFixtures,
      sourceFidelity: {
        state: 'fixture',
        inputs: Object.keys(parsedCase.inputs).length > 0
          ? Object.keys(opts.inputs ?? {}).length > 0 ? 'current' : 'fixture'
          : Object.keys(opts.inputs ?? {}).length > 0 ? 'current' : 'unavailable',
        http: httpFixtures.length > 0 ? 'fixture' : policy.reads === 'live' ? 'current' : 'unavailable',
        model: policy.model === 'live'
          ? 'current'
          : policy.model === 'stub'
            ? 'simulated'
            : modelFixtures.length > 0
              ? 'fixture'
              : 'unavailable'
      }
    });
    state = result.state;
    records.push(result.record);
    allLogs.push(...result.logs);
  }

  const aggregate = aggregateCaseRecords(parsedCase, records, allLogs);
  const failures = evaluateCaseAssertions(parsedCase, aggregate, allLogs);
  if (failures.length > 0) {
    process.exitCode = 1;
    throw new Error(failures.join('\n'));
  }
  return { output: aggregate, state };
}

function aggregateCaseRecords(
  parsedCase: ParsedInvokeCase,
  records: RunRecordV2[],
  logs: string[]
): RunRecordV2 {
  const final = records[records.length - 1]!;
  const failed = records.some((record) => record.status !== 'succeeded');
  return {
    ...final,
    status: failed ? 'failed' : 'succeeded',
    actions: records.flatMap((record) => record.actions),
    trace: records.flatMap((record) => record.trace),
    stateDiff: final.stateDiff,
    extensions: {
      ...(typeof final.extensions === 'object' && final.extensions !== null ? final.extensions as Record<string, unknown> : {}),
      caseId: parsedCase.id,
      logs,
      turns: records.map((record) => ({
        runId: record.runId,
        status: record.status,
        eventContract: record.eventContract
      }))
    }
  };
}

function evaluateCaseAssertions(
  parsedCase: ParsedInvokeCase,
  record: RunRecordV2,
  logs: string[]
): string[] {
  const failures: string[] = [];
  const joinedLogs = logs.join('\n');

  if (parsedCase.expect.status && record.status !== parsedCase.expect.status) {
    failures.push(`$.expect.status: expected ${parsedCase.expect.status}, got ${record.status}`);
  }
  if (parsedCase.expect.eventSource) {
    const actual = deriveEventSource(record.eventContract);
    if (!actual || actual !== parsedCase.expect.eventSource) {
      failures.push(`$.expect.eventSource: expected ${parsedCase.expect.eventSource}, got ${actual ?? 'unknown'}`);
    }
  }
  for (const expected of parsedCase.expect.logsContain) {
    if (!joinedLogs.includes(expected)) failures.push(`$.expect.logsContain: missing "${expected}"`);
  }
  for (const expected of parsedCase.expect.effectsContain) {
    if (!record.actions.some((action) => action.kind === expected)) {
      failures.push(`$.expect.effectsContain: missing effect kind "${expected}"`);
    }
  }
  for (const expected of parsedCase.expect.providerActions) {
    const matched = record.actions.find((action) => matchesExpectedProviderAction(action, expected));
    if (!matched) {
      failures.push(`$.expect.providerActions: missing ${expected.provider}.${expected.resource}`);
    }
  }
  return failures;
}

export function matchesExpectedProviderAction(
  action: RunRecordV2['actions'][number],
  expected: ParsedCaseExpectationProviderAction
): boolean {
  const data = asRecord(action.data);
  if (action.kind !== 'provider.write') return false;
  if (action.provider !== expected.provider) return false;
  const threadedSlackReplyMatch =
    expected.provider === 'slack' &&
    expected.resource === 'messages' &&
    expected.threaded === true &&
    action.resource === 'replies';
  if (action.resource !== expected.resource && !threadedSlackReplyMatch) return false;
  if (expected.channel) {
    const channel = typeof data?.parameters === 'object' && data.parameters !== null
      ? String((data.parameters as Record<string, unknown>).channelId ?? (data.parameters as Record<string, unknown>).channel ?? '')
      : '';
    const pathValue = typeof data?.path === 'string' ? data.path : '';
    if (channel !== expected.channel && !pathValue.includes(`/${encodeURIComponent(expected.channel)}/`)) return false;
  }
  if (expected.threaded === true) {
    const body = asRecord(data?.body);
    const threaded =
      typeof body?.parentRef === 'string' ||
      typeof body?.thread_ts === 'string' ||
      action.resource === 'replies' ||
      (typeof data?.path === 'string' && data.path.includes('/replies/')) ||
      (typeof data?.parameters === 'object' &&
        data.parameters !== null &&
        typeof (data.parameters as Record<string, unknown>).messageTs === 'string');
    if (!threaded) return false;
  }
  if (expected.textContains?.length) {
    const body = asRecord(data?.body);
    const text = typeof body?.text === 'string' ? body.text : typeof data?.text === 'string' ? data.text : '';
    if (!expected.textContains.every((snippet) => text.includes(snippet))) return false;
  }
  return true;
}

export function deriveEventSource(eventContract: string): string | undefined {
  const type = eventContract.split('@', 1)[0] ?? '';
  if (!type) return undefined;
  if (type === 'cron.tick') return 'cron';
  if (type === 'startup') return 'startup';
  const dot = type.indexOf('.');
  if (dot <= 0) return undefined;
  const prefix = type.slice(0, dot);
  return prefix || undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

async function loadCaseHttpFixtures(parsedCase: ParsedInvokeCase): Promise<LocalHttpFixture[]> {
  return await Promise.all(parsedCase.http.map(async (fixture) => ({
    method: fixture.method,
    match: fixture.match,
    body: await readFile(fixture.file, 'utf8'),
    sourcePath: fixture.file
  })));
}

async function loadCaseModelFixtures(parsedCase: ParsedInvokeCase): Promise<LocalModelFixture[]> {
  return await Promise.all(parsedCase.model.map(async (fixture) => ({
    output: fixture.output ?? await readFile(fixture.file!, 'utf8'),
    ...(fixture.file ? { sourcePath: fixture.file } : {})
  })));
}

function normalizeFixtureEntry(entry: unknown): {
  event: ReturnType<typeof decodeEventFrame>['frame'];
  historicalState?: LocalPreviewState;
  stateFidelity?: 'historical' | 'unavailable';
  replayProvenance?: Record<string, unknown>;
  historicalInputs?: Record<string, string>;
  sourceFidelity?: {
    state: 'historical' | 'current' | 'fixture' | 'simulated' | 'unavailable';
    inputs: 'historical' | 'current' | 'fixture' | 'simulated' | 'unavailable';
    http: 'historical' | 'current' | 'fixture' | 'simulated' | 'unavailable';
    model: 'historical' | 'current' | 'fixture' | 'simulated' | 'unavailable';
  };
} {
  const replayBundle = unwrapReplayBundle(entry);
  if (replayBundle) return replayBundle;

  const record = asRecord(entry);
  if (record && record.event !== undefined) {
    const state = asRecord(record.state);
    const replayProvenance = extractReplayProvenance(record);
    return {
      event: decodeEventFrame(record.event).frame,
      ...(state ? { historicalState: normalizeHistoricalState(state), stateFidelity: 'historical' as const } : {}),
      ...(!state && Object.hasOwn(record, 'state') ? { stateFidelity: 'unavailable' as const } : {}),
      ...(replayProvenance ? { replayProvenance } : {})
    };
  }
  return { event: decodeEventFrame(entry).frame };
}

function unwrapReplayBundle(entry: unknown): {
  event: ReturnType<typeof decodeEventFrame>['frame'];
  historicalState?: LocalPreviewState;
  stateFidelity?: 'historical' | 'unavailable';
  replayProvenance?: Record<string, unknown>;
  historicalInputs?: Record<string, string>;
  sourceFidelity?: {
    state: 'historical' | 'current' | 'fixture' | 'simulated' | 'unavailable';
    inputs: 'historical' | 'current' | 'fixture' | 'simulated' | 'unavailable';
    http: 'historical' | 'current' | 'fixture' | 'simulated' | 'unavailable';
    model: 'historical' | 'current' | 'fixture' | 'simulated' | 'unavailable';
  };
} | null {
  const bundle = asRecord(entry);
  const files = asRecord(bundle?.files);
  const manifest = asRecord(bundle?.manifest);
  const eventFile = asRecord(files?.['event.json']);
  if (!bundle || bundle.schemaVersion !== 1 || !files || !eventFile || eventFile.content === undefined) {
    return null;
  }

  const stateFile = asRecord(files['state/manifest.json']);
  const stateFidelity = normalizeReplayFidelity(
    stateFile?.fidelity,
    asRecord(asRecord(manifest?.files)?.['state/manifest.json'])?.fidelity
  );
  const inputsFile = asRecord(files['inputs.json']) ?? asRecord(files['inputs/manifest.json']);
  const inputsFidelity = normalizeReplayFidelity(
    inputsFile?.fidelity,
    asRecord(asRecord(manifest?.files)?.['inputs.json'])?.fidelity,
    asRecord(asRecord(manifest?.files)?.['inputs/manifest.json'])?.fidelity
  );
  const historicalState = stateFidelity === 'historical'
    ? normalizeHistoricalState(asRecord(stateFile?.content) ?? {})
    : undefined;
  const historicalInputs = inputsFidelity === 'historical'
    ? normalizeHistoricalInputs(asRecord(inputsFile?.content) ?? {})
    : undefined;
  const replayProvenance = extractReplayBundleProvenance(manifest, files);

  return {
    event: decodeEventFrame(eventFile.content).frame,
    ...(historicalState ? { historicalState } : {}),
    ...(stateFidelity ? { stateFidelity } : {}),
    ...(historicalInputs ? { historicalInputs } : {}),
    ...(replayProvenance ? { replayProvenance } : {})
    ,
    sourceFidelity: {
      state: stateFidelity ?? 'unavailable',
      inputs: historicalInputs ? 'historical' : inputsFidelity ?? 'unavailable',
      http: 'unavailable',
      model: 'unavailable'
    }
  };
}

function normalizeReplayFidelity(...values: unknown[]): 'historical' | 'unavailable' | undefined {
  for (const value of values) {
    if (value === 'historical' || value === 'unavailable') return value;
  }
  return undefined;
}

function normalizeHistoricalState(value: Record<string, unknown>): LocalPreviewState {
  const files = asRecord(value.files);
  return {
    ...(files
      ? {
          files: Object.fromEntries(
            Object.entries(files).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
          )
        }
      : {})
  };
}

function normalizeHistoricalInputs(value: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  );
}

function extractReplayBundleProvenance(
  manifest: Record<string, unknown> | null,
  files: Record<string, unknown>
): Record<string, unknown> | undefined {
  const provenance: Record<string, unknown> = {};
  const runFile = asRecord(files['run.json']);
  const run = asRecord(runFile?.content);
  const runId = typeof manifest?.runId === 'string'
    ? manifest.runId
    : typeof run?.id === 'string'
      ? run.id
      : typeof run?.runId === 'string'
        ? run.runId
        : undefined;
  if (runId) provenance.sourceRunId = runId;
  const eventId = typeof manifest?.eventId === 'string' ? manifest.eventId : undefined;
  if (eventId) provenance.sourceEventId = eventId;
  return Object.keys(provenance).length > 0 ? provenance : undefined;
}

function extractReplayProvenance(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const provenance: Record<string, unknown> = {};
  const run = asRecord(record.run);
  const runId = typeof record.runId === 'string'
    ? record.runId
    : typeof run?.id === 'string'
      ? run.id
      : typeof run?.runId === 'string'
        ? run.runId
        : undefined;
  if (runId) provenance.sourceRunId = runId;
  const eventId = typeof record.eventId === 'string' ? record.eventId : undefined;
  if (eventId) provenance.sourceEventId = eventId;
  return Object.keys(provenance).length > 0 ? provenance : undefined;
}

function mergeState(
  base: LocalPreviewState,
  overlay: LocalPreviewState | undefined
): LocalPreviewState {
  if (!overlay) return base;
  return {
    ...(base.files || overlay.files ? { files: { ...(base.files ?? {}), ...(overlay.files ?? {}) } } : {}),
    ...(base.memory || overlay.memory ? { memory: [...(overlay.memory ?? base.memory ?? [])] } : {}),
    ...(base.transport || overlay.transport ? { transport: overlay.transport ?? base.transport } : {}),
    ...(base.model || overlay.model ? { model: overlay.model ?? base.model } : {})
  };
}

async function loadSeeds(
  seeds: Record<string, string> | undefined
): Promise<Record<string, string> | undefined> {
  if (!seeds) return undefined;
  const loaded: Record<string, string> = {};
  for (const [vfsPath, localFile] of Object.entries(seeds)) {
    loaded[vfsPath] = await readFile(path.resolve(localFile), 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') throw new Error(`--seed ${vfsPath}: local file not found at ${localFile}`);
      throw error;
    });
  }
  return loaded;
}

async function collectWatchedFiles(opts: InvokeOptions): Promise<string[]> {
  const files = await collectRelativeDependencyFiles(opts.personaPath);
  if (opts.source.kind === 'fixture') {
    files.add(opts.source.path);
  } else if (opts.source.kind === 'case') {
    files.add(opts.source.path);
    const parsedCase = await parseInvokeCase(opts.source.path);
    for (const fixture of parsedCase.http) files.add(fixture.file);
    for (const fixture of parsedCase.model) {
      if (fixture.file) files.add(fixture.file);
    }
  }
  for (const localFile of Object.values(opts.seeds ?? {})) {
    files.add(path.resolve(localFile));
  }
  return [...files].sort();
}

async function collectRelativeDependencyFiles(
  entryPath: string,
  seen = new Set<string>()
): Promise<Set<string>> {
  const absPath = path.resolve(entryPath);
  if (seen.has(absPath)) return seen;
  seen.add(absPath);

  let sourceText: string;
  try {
    sourceText = await readFile(absPath, 'utf8');
  } catch {
    return seen;
  }

  for (const specifier of extractLocalSpecifiers(sourceText)) {
    const resolved = await resolveRelativeModule(absPath, specifier);
    if (resolved) await collectRelativeDependencyFiles(resolved, seen);
  }
  return seen;
}

function extractLocalSpecifiers(sourceText: string): string[] {
  const matches = new Set<string>();
  const patterns = [
    /from\s+['"]([^'"]+)['"]/g,
    /import\s+['"]([^'"]+)['"]/g,
    /import\(\s*['"]([^'"]+)['"]\s*\)/g,
    /require\(\s*['"]([^'"]+)['"]\s*\)/g
  ];
  for (const pattern of patterns) {
    for (const match of sourceText.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier?.startsWith('.')) matches.add(specifier);
    }
  }
  return [...matches];
}

async function resolveRelativeModule(fromPath: string, specifier: string): Promise<string | undefined> {
  const basePath = path.resolve(path.dirname(fromPath), specifier);
  for (const candidate of moduleResolutionCandidates(basePath)) {
    try {
      const details = await stat(candidate);
      if (details.isFile()) return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

function moduleResolutionCandidates(basePath: string): string[] {
  const directExt = path.extname(basePath);
  const extensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json'];
  const candidates = [basePath];
  if (!directExt) {
    for (const ext of extensions) candidates.push(`${basePath}${ext}`);
    for (const ext of extensions) candidates.push(path.join(basePath, `index${ext}`));
  }
  return candidates;
}

async function waitForWatchedFilesChange(files: readonly string[]): Promise<'change'> {
  const baseline = await snapshotWatchedFiles(files);
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const current = await snapshotWatchedFiles(files);
    if (!watchedSnapshotsEqual(baseline, current)) return 'change';
  }
}

async function snapshotWatchedFiles(files: readonly string[]): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  for (const file of files) {
    try {
      const details = await stat(file);
      snapshot.set(file, `${details.mtimeMs}:${details.size}`);
    } catch {
      snapshot.set(file, 'missing');
    }
  }
  return snapshot;
}

function watchedSnapshotsEqual(
  left: ReadonlyMap<string, string>,
  right: ReadonlyMap<string, string>
): boolean {
  if (left.size !== right.size) return false;
  for (const [file, value] of left) {
    if (right.get(file) !== value) return false;
  }
  return true;
}

function deriveExitCode(output: RunRecordV2 | RunRecordV2[]): 0 | 1 {
  return Array.isArray(output)
    ? output.some((record) => record.status !== 'succeeded') ? 1 : 0
    : output.status === 'succeeded' ? 0 : 1;
}

export function renderHumanSummary(output: RunRecordV2 | RunRecordV2[]): string {
  const records = Array.isArray(output) ? output : [output];
  const failed = records.filter((record) => record.status !== 'succeeded').length;
  const lines = [`preview: ${records.length} run(s) — ${records.length - failed} ok, ${failed} failed`];
  for (const record of records) {
    lines.push(`  [${record.status === 'succeeded' ? 'ok' : 'FAIL'}] ${record.eventContract} ${record.runId} (${record.actions.length} action(s))`);
    lines.push(
      `    policy: reads=${record.policy.reads} writes=${record.policy.writes} model=${record.policy.model} shell=${record.policy.shell} compose=${record.policy.compose}`
    );
    const fidelity = recordSourceFidelity(record);
    if (fidelity) {
      lines.push(`    fidelity: ${Object.entries(fidelity).map(([key, value]) => `${key}=${value}`).join(' ')}`);
    }
    lines.push('    trace:');
    if (record.actions.length === 0) {
      lines.push('      (no effects)');
    } else {
      record.actions.forEach((action, index) => {
        lines.push(...renderHumanAction(record, action, index + 1));
      });
    }
    lines.push(...renderHumanStateChanges(record));
    if (typeof record.error === 'string' && record.error) {
      lines.push(`    error: ${record.error}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function renderHumanAction(
  record: RunRecordV2,
  action: RunRecordV2['actions'][number],
  sequence: number
): string[] {
  const data = asRecord(action.data) ?? {};
  const prefix = `      ${String(sequence).padStart(2, '0')}.`;

  if (action.kind === 'provider.write') {
    return renderHumanProviderWrite(prefix, action, data);
  }

  if (action.kind === 'http.read' || action.kind === 'provider.read') {
    const decision = action.status === 'denied' ? 'DENY' : 'ALLOW';
    const fidelity = actionFidelity(record, action, data);
    const provider = action.provider ? ` ${action.provider}${action.resource ? `.${action.resource}` : ''}` : '';
    const method = typeof data.method === 'string' ? ` ${data.method}` : '';
    const target = typeof data.url === 'string'
      ? ` ${data.url}`
      : typeof data.path === 'string'
        ? ` ${data.path}`
        : '';
    const lines = [`${prefix} [${decision}] ${action.kind}${provider}${method}${target} fidelity=${fidelity}`];
    const parameters = asRecord(data.parameters);
    if (action.kind === 'provider.read' && parameters) {
      lines.push(`          parameters: ${JSON.stringify(parameters)}`);
    }
    return lines;
  }

  if (action.kind === 'model.complete') {
    const mode = typeof data.mode === 'string' ? data.mode : record.policy.model;
    const source = typeof data.source === 'string' ? data.source : 'unknown';
    const fidelity = actionFidelity(record, action, data);
    const sizes = [
      typeof data.promptChars === 'number' ? `promptChars=${data.promptChars}` : '',
      typeof data.outputChars === 'number' ? `outputChars=${data.outputChars}` : ''
    ].filter(Boolean).join(' ');
    return [
      `${prefix} [${humanActionStatus(action)}] model.complete mode=${mode} source=${source} fidelity=${fidelity}${sizes ? ` ${sizes}` : ''}`
    ];
  }

  const details = Object.keys(data).length > 0 ? ` ${JSON.stringify(data)}` : '';
  return [`${prefix} [${humanActionStatus(action)}] ${action.kind}${details}`];
}

function renderHumanProviderWrite(
  prefix: string,
  action: RunRecordV2['actions'][number],
  data: Record<string, unknown>
): string[] {
  const provider = action.provider ?? 'unknown';
  const resource = action.resource ?? 'unknown';
  const method = typeof data.method === 'string' ? data.method : 'write';
  const pathValue = typeof data.path === 'string' ? data.path : undefined;
  const parameters = asRecord(data.parameters);
  const body = asRecord(data.body);
  const receipt = asRecord(data.simulatedReceipt);
  const lines = [
    `${prefix} [${humanActionStatus(action)}] provider.write ${provider}.${resource}`,
    `          method: ${method}`
  ];
  if (pathValue) lines.push(`          path: ${pathValue}`);
  if (parameters) lines.push(`          parameters: ${JSON.stringify(parameters)}`);

  if (provider === 'slack') {
    const channel = slackChannel(parameters, pathValue);
    const parentRef = typeof body?.parentRef === 'string' ? body.parentRef : undefined;
    const threadTs = typeof body?.thread_ts === 'string' ? body.thread_ts : undefined;
    const isReply = resource === 'replies' || parentRef !== undefined || threadTs !== undefined;
    lines.push(`          slack message: ${isReply ? 'reply' : 'parent'}`);
    lines.push(`          channel: ${channel ?? '(unknown)'}`);
    lines.push(
      `          linkage: parentRef=${parentRef ?? '(none)'} thread_ts=${threadTs ?? '(none)'} receipt=${typeof receipt?.id === 'string' ? receipt.id : '(none)'}`
    );
    if (typeof body?.text === 'string') lines.push(`          text (exact): ${JSON.stringify(body.text)}`);
  }

  if (body) lines.push(`          body: ${JSON.stringify(body)}`);
  if (receipt) lines.push(`          simulated receipt: ${JSON.stringify(receipt)}`);
  lines.push(`          provider data: ${JSON.stringify(data)}`);
  return lines;
}

function humanActionStatus(action: RunRecordV2['actions'][number]): string {
  if (action.status === 'denied') return 'DENIED';
  if (action.status === 'previewed') return 'PREVIEW';
  if (action.status === 'sandboxed') return 'SANDBOX';
  return 'EXECUTED';
}

function recordSourceFidelity(record: RunRecordV2): Record<string, string> | undefined {
  const extensions = asRecord(record.extensions);
  const sourceFidelity = asRecord(extensions?.sourceFidelity);
  if (!sourceFidelity) return undefined;
  const entries = Object.entries(sourceFidelity).filter((entry): entry is [string, string] =>
    typeof entry[1] === 'string'
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function actionFidelity(
  record: RunRecordV2,
  action: RunRecordV2['actions'][number],
  data: Record<string, unknown>
): string {
  const extensions = asRecord(action.extensions);
  if (typeof extensions?.sourceFidelity === 'string') return extensions.sourceFidelity;
  if (typeof data.source === 'string') return data.source;
  const sourceFidelity = recordSourceFidelity(record);
  if (action.kind === 'http.read' && sourceFidelity?.http) return sourceFidelity.http;
  if (action.kind === 'model.complete' && sourceFidelity?.model) return sourceFidelity.model;
  if (action.kind === 'provider.read' && sourceFidelity?.state) return sourceFidelity.state;
  if (action.status === 'denied') return 'unavailable';
  return 'unknown';
}

function slackChannel(
  parameters: Record<string, unknown> | null,
  pathValue: string | undefined
): string | undefined {
  const parameterChannel = parameters?.channelId ?? parameters?.channel;
  if (typeof parameterChannel === 'string') return parameterChannel;
  const match = pathValue?.match(/^\/slack\/channels\/([^/]+)/u);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

function renderHumanStateChanges(record: RunRecordV2): string[] {
  const files = record.stateDiff.files ?? [];
  const memory = record.stateDiff.memory ?? [];
  const providers = record.stateDiff.providers ?? [];
  if (files.length === 0 && memory.length === 0 && providers.length === 0) return [];

  const lines = ['    state changes:'];
  for (const file of files) {
    const change = file.before === undefined ? 'created' : file.after === undefined ? 'deleted' : 'updated';
    lines.push(`      file ${change}: ${file.path}`);
  }
  for (const entry of memory) lines.push(`      memory: ${JSON.stringify(entry)}`);
  for (const entry of providers) lines.push(`      provider: ${JSON.stringify(entry)}`);
  return lines;
}

function expectValue(flag: string, value: string | undefined): string {
  if (value === undefined || value.startsWith('--')) throw new Error(`invoke: ${flag} expects a value`);
  return value;
}

function expectInline(flag: string, value: string): string {
  if (!value) throw new Error(`invoke: ${flag} expects a value`);
  return value;
}

function addKeyValue(flag: string, raw: string, into: Record<string, string>): void {
  const eq = raw.indexOf('=');
  if (eq <= 0) throw new Error(`invoke: ${flag} expects <key>=<value>; got "${raw}"`);
  into[raw.slice(0, eq)] = raw.slice(eq + 1);
}

function expectEnum<const T extends readonly string[]>(
  flag: string,
  value: string | undefined,
  allowed: T
): T[number] {
  const text = expectValue(flag, value);
  if (!(allowed as readonly string[]).includes(text)) {
    throw new Error(`invoke: ${flag} must be one of ${allowed.join(', ')}`);
  }
  return text as T[number];
}

export function scaffoldFixture(type: string): {
  fixture: Record<string, unknown>;
  warnings: string[];
} {
  const warnings: string[] = [];
  const occurredAt = new Date().toISOString();

  if (type === 'cron.tick' || type.startsWith('cron.')) {
    if (type !== 'cron.tick') {
      warnings.push(
        `the gateway delivers schedule fires as "cron.tick"; preserving requested type "${type}" for authoring`
      );
    }
    return {
      fixture: {
        id: 'evt_local_1',
        workspace: 'ws-local',
        type,
        occurredAt,
        name: 'TODO: declared schedule name',
        cron: '0 9 * * 1'
      },
      warnings
    };
  }

  return {
    fixture: {
      id: 'evt_local_1',
      workspace: 'ws-local',
      type,
      occurredAt,
      resource: {
        TODO:
          'export a real run with `agentworkforce runs export <runId> --bundle replay.json` or `--fixture event.json` to capture the exact payload shape'
      }
    },
    warnings
  };
}
