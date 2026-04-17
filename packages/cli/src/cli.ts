#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { constants } from 'node:os';

import {
  PERSONA_TIERS,
  personaCatalog,
  useSelection,
  type Harness,
  type McpServerSpec,
  type PersonaPermissions,
  type PersonaSelection,
  type PersonaSpec,
  type PersonaTier
} from '@agentworkforce/workload-router';
import { loadLocalPersonas } from './local-personas.js';
import {
  makeLenientResolver,
  resolveStringMapLenient,
  type DroppedRef
} from './env-refs.js';

const USAGE = `Usage: agent-workforce agent <persona>[@<tier>] [task...]

  <persona>  repo persona id, repo intent, or local persona id
  <tier>     ${PERSONA_TIERS.join(' | ')}   (default: best-value)
  [task]     if provided, runs one-shot non-interactively;
             otherwise drops into an interactive harness session

Local personas cascade: <cwd>/.agent-workforce/*.json → ~/.agent-workforce/*.json → repo library.
Each layer only needs to specify fields it overrides; everything else inherits
from the next lower layer. "extends" explicitly names a base; omit it and the
loader implicitly inherits from the same-id persona below. (Override the home
layer path via AGENT_WORKFORCE_CONFIG_DIR.)

Examples:
  agent-workforce agent npm-provenance-publisher@best
  agent-workforce agent my-posthog@best
  agent-workforce agent review@best-value "look at the diff on this branch"
`;

function die(msg: string, withUsage = true): never {
  process.stderr.write(`${msg}\n`);
  if (withUsage) process.stderr.write(`\n${USAGE}`);
  process.exit(1);
}

const local = loadLocalPersonas();
for (const warning of local.warnings) {
  process.stderr.write(`warning: ${warning}\n`);
}

type ResolvedTarget =
  | { kind: 'repo'; spec: PersonaSpec; tier: PersonaTier }
  | { kind: 'local'; spec: PersonaSpec; tier: PersonaTier };

function resolveSpec(key: string): ResolvedTarget['spec'] | { error: string } {
  const localSpec = local.byId.get(key);
  if (localSpec) return localSpec;
  const catalogAsIntent = (personaCatalog as Record<string, PersonaSpec>)[key];
  if (catalogAsIntent) return catalogAsIntent;
  const byId = Object.values(personaCatalog).find((p) => p.id === key);
  if (byId) return byId;

  const repoListing = Object.values(personaCatalog)
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((p) => `  ${p.id}  (intent: ${p.intent})`);
  const localListing = [...local.byId.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((p) => `  ${p.id}  (${local.sources.get(p.id) ?? 'local'})`);
  const listing = [...repoListing, ...localListing].join('\n');
  return { error: `Unknown persona "${key}". Known personas:\n${listing}` };
}

function parseSelector(sel: string): ResolvedTarget {
  const at = sel.indexOf('@');
  const key = at === -1 ? sel : sel.slice(0, at);
  const tierRaw = at === -1 ? undefined : sel.slice(at + 1);
  if (!key) die('Missing persona name before "@"');
  const tier = (tierRaw ?? 'best-value') as PersonaTier;
  if (tierRaw !== undefined && !PERSONA_TIERS.includes(tier)) {
    die(`Invalid tier "${tierRaw}". Must be one of: ${PERSONA_TIERS.join(', ')}`);
  }
  const result = resolveSpec(key);
  if ('error' in result) die(result.error, false);
  const kind = local.byId.has(key) ? 'local' : 'repo';
  return { kind, spec: result, tier };
}

function buildSelection(spec: PersonaSpec, tier: PersonaTier, kind: 'repo' | 'local'): PersonaSelection {
  return {
    personaId: spec.id,
    tier,
    runtime: spec.tiers[tier],
    skills: spec.skills,
    rationale: kind === 'local' ? `local-override: ${spec.id}` : `cli-tier-override: ${tier}`,
    ...(spec.env ? { env: spec.env } : {}),
    ...(spec.mcpServers ? { mcpServers: spec.mcpServers } : {}),
    ...(spec.permissions ? { permissions: spec.permissions } : {})
  };
}

function stripProviderPrefix(model: string): string {
  const idx = model.indexOf('/');
  return idx >= 0 ? model.slice(idx + 1) : model;
}

interface McpResolution {
  servers: Record<string, McpServerSpec> | undefined;
  /** Entries dropped because a referenced env var was not set. */
  dropped: DroppedRef[];
  /**
   * Servers dropped entirely because a structural field (`url`, `command`,
   * any `arg`) couldn't be resolved — the config for those servers would be
   * unusable without the missing value.
   */
  droppedServers: { name: string; refs: string[] }[];
}

function resolveMcpServersLenient(
  servers: Record<string, McpServerSpec> | undefined,
  processEnv: NodeJS.ProcessEnv
): McpResolution {
  if (!servers) return { servers: undefined, dropped: [], droppedServers: [] };
  const resolve = makeLenientResolver(processEnv);
  const out: Record<string, McpServerSpec> = {};
  const dropped: DroppedRef[] = [];
  const droppedServers: { name: string; refs: string[] }[] = [];

  for (const [name, spec] of Object.entries(servers)) {
    const field = `mcpServers.${name}`;
    const fatalRefs: string[] = [];

    const resolveFatal = (value: string, subfield: string): string | undefined => {
      const r = resolve(value, subfield);
      if (r.ok) return r.value;
      fatalRefs.push(r.ref);
      return undefined;
    };

    if (spec.type === 'stdio') {
      const command = resolveFatal(spec.command, `${field}.command`);
      const args = spec.args?.map((a, i) => resolveFatal(a, `${field}.args[${i}]`));
      if (!command || (args && args.some((a) => a === undefined))) {
        droppedServers.push({ name, refs: fatalRefs });
        continue;
      }
      const envResolution = resolveStringMapLenient(spec.env, processEnv, `${field}.env`);
      dropped.push(...envResolution.dropped);
      out[name] = {
        type: 'stdio',
        command,
        ...(args ? { args: args as string[] } : {}),
        ...(envResolution.value ? { env: envResolution.value } : {})
      };
    } else {
      const url = resolveFatal(spec.url, `${field}.url`);
      if (!url) {
        droppedServers.push({ name, refs: fatalRefs });
        continue;
      }
      const headersResolution = resolveStringMapLenient(
        spec.headers,
        processEnv,
        `${field}.headers`
      );
      dropped.push(...headersResolution.dropped);
      out[name] = {
        type: spec.type,
        url,
        ...(headersResolution.value ? { headers: headersResolution.value } : {})
      };
    }
  }

  return {
    servers: Object.keys(out).length > 0 ? out : undefined,
    dropped,
    droppedServers
  };
}

function formatDropWarnings(
  envDrops: DroppedRef[],
  mcpDrops: DroppedRef[],
  mcpServerDrops: { name: string; refs: string[] }[]
): string[] {
  const lines: string[] = [];
  for (const d of envDrops) {
    lines.push(`${d.field} dropped (env var ${d.ref} is not set).`);
  }
  for (const d of mcpDrops) {
    lines.push(`${d.field} dropped (env var ${d.ref} is not set).`);
  }
  for (const d of mcpServerDrops) {
    lines.push(
      `mcpServers.${d.name} dropped entirely (required fields referenced unset env vars: ${d.refs.join(', ')}).`
    );
  }
  return lines;
}

type InteractiveSpec = {
  bin: string;
  args: readonly string[];
  initialPrompt: string | null;
};

function buildInteractiveSpec(
  harness: Harness,
  model: string,
  systemPrompt: string,
  resolvedMcp: Record<string, McpServerSpec> | undefined,
  permissions: PersonaPermissions | undefined
): InteractiveSpec {
  switch (harness) {
    case 'claude': {
      // Always isolate MCP: pair --mcp-config with --strict-mcp-config so
      // only the persona's declared servers load. Without --strict, Claude
      // merges our config with ~/.claude.json and project-level MCP sources,
      // pulling in whatever the user has configured elsewhere.
      const mcpPayload = JSON.stringify({ mcpServers: resolvedMcp ?? {} });
      const base: string[] = [
        '--model',
        model,
        '--append-system-prompt',
        systemPrompt,
        '--mcp-config',
        mcpPayload,
        '--strict-mcp-config'
      ];
      if (permissions?.allow && permissions.allow.length > 0) {
        base.push('--allowedTools', ...permissions.allow);
      }
      if (permissions?.deny && permissions.deny.length > 0) {
        base.push('--disallowedTools', ...permissions.deny);
      }
      if (permissions?.mode) {
        base.push('--permission-mode', permissions.mode);
      }
      return { bin: 'claude', args: base, initialPrompt: null };
    }
    case 'codex':
      if (resolvedMcp && Object.keys(resolvedMcp).length > 0) {
        process.stderr.write(
          `warning: persona declares mcpServers but the codex harness is not yet wired for runtime MCP injection; proceeding without MCP.\n`
        );
      }
      if (permissions && (permissions.allow?.length || permissions.deny?.length || permissions.mode)) {
        process.stderr.write(
          `warning: persona declares permissions but the codex harness is not yet wired for runtime permission injection; proceeding with codex defaults.\n`
        );
      }
      return {
        bin: 'codex',
        args: ['-m', stripProviderPrefix(model)],
        initialPrompt: systemPrompt
      };
    case 'opencode':
      if (resolvedMcp && Object.keys(resolvedMcp).length > 0) {
        process.stderr.write(
          `warning: persona declares mcpServers but the opencode harness is not yet wired for runtime MCP injection; proceeding without MCP.\n`
        );
      }
      if (permissions && (permissions.allow?.length || permissions.deny?.length || permissions.mode)) {
        process.stderr.write(
          `warning: persona declares permissions but the opencode harness is not yet wired for runtime permission injection; proceeding with opencode defaults.\n`
        );
      }
      return {
        bin: 'opencode',
        args: ['--model', stripProviderPrefix(model)],
        initialPrompt: systemPrompt
      };
  }
}

function emitDropWarnings(lines: string[]): void {
  if (lines.length === 0) return;
  for (const line of lines) process.stderr.write(`warning: ${line}\n`);
  process.stderr.write(
    `        (referenced env vars were not set — proceeding without those values; if the agent relies on them it may need to authenticate interactively, e.g. via OAuth.)\n`
  );
}

async function runOneShot(
  selection: PersonaSelection,
  task: string
): Promise<never> {
  const { runtime } = selection;
  process.stderr.write(
    `→ ${selection.personaId} [${selection.tier}] via ${runtime.harness} (${runtime.model})\n`
  );

  const envResolution = resolveStringMapLenient(selection.env, process.env, 'env');
  emitDropWarnings(formatDropWarnings(envResolution.dropped, [], []));

  if (selection.mcpServers && Object.keys(selection.mcpServers).length > 0) {
    process.stderr.write(
      `warning: mcpServers are not yet wired through the one-shot (sendMessage) path; the agent will run without MCP. Use interactive mode for MCP access.\n`
    );
  }

  const ctx = useSelection(selection);
  const execution = ctx.sendMessage(task, {
    env: envResolution.value,
    onProgress: ({ stream, text }) => {
      (stream === 'stderr' ? process.stderr : process.stdout).write(text);
    }
  });
  try {
    const result = await execution;
    process.exit(result.exitCode ?? 0);
  } catch (err) {
    const typed = err as Error & {
      result?: { exitCode: number | null; status: string; stderr?: string };
    };
    const status = typed.result?.status ?? 'failed';
    process.stderr.write(`\n[${status}] ${typed.message}\n`);
    process.exit(typed.result?.exitCode ?? 1);
  }
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  if (!signal) return 0;
  const num = (constants.signals as Record<string, number | undefined>)[signal];
  return 128 + (num ?? 1);
}

function runInstall(command: readonly string[], label: string): void {
  const [bin, ...args] = command;
  if (!bin) return;
  process.stderr.write(`• ${label}\n`);
  const res = spawnSync(bin, args, { stdio: 'inherit', shell: false });
  if (res.status !== 0) {
    const code = res.status ?? 1;
    process.stderr.write(`${label} failed (exit ${code}). Aborting.\n`);
    process.exit(code);
  }
}

function runCleanup(command: readonly string[], commandString: string): void {
  if (commandString === ':') return;
  const [bin, ...args] = command;
  if (!bin) return;
  spawnSync(bin, args, { stdio: 'inherit', shell: false });
}

function runInteractive(selection: PersonaSelection): Promise<number> {
  const ctx = useSelection(selection);
  const { runtime, personaId, tier } = selection;
  const { install } = ctx;
  process.stderr.write(`→ ${personaId} [${tier}] via ${runtime.harness} (${runtime.model})\n`);

  const envResolution = resolveStringMapLenient(selection.env, process.env, 'env');
  const mcpResolution = resolveMcpServersLenient(selection.mcpServers, process.env);
  emitDropWarnings(
    formatDropWarnings(envResolution.dropped, mcpResolution.dropped, mcpResolution.droppedServers)
  );
  const resolvedEnv = envResolution.value;
  const resolvedMcp = mcpResolution.servers;

  if (install.plan.installs.length > 0) {
    const skillIds = install.plan.installs.map((i) => i.skillId).join(', ');
    runInstall(install.command, `Installing skills: ${skillIds}`);
  }

  const spec = buildInteractiveSpec(
    runtime.harness,
    runtime.model,
    runtime.systemPrompt,
    resolvedMcp,
    selection.permissions
  );
  const finalArgs = spec.initialPrompt ? [...spec.args, spec.initialPrompt] : [...spec.args];

  // Print a sanitized summary rather than raw argv: spec.args for the claude
  // harness contains the resolved --mcp-config JSON and the full system
  // prompt, either of which can carry secrets (Bearer tokens, API keys) once
  // env refs are interpolated. We show the bin, model, and the *names* of
  // the servers / permission fields so the user can verify the shape without
  // leaking credentials to stderr or CI logs.
  const summary: string[] = [`model=${runtime.model}`];
  if (runtime.harness === 'claude') {
    const servers = Object.keys(resolvedMcp ?? {});
    summary.push(`mcp-strict=${servers.length ? servers.join(',') : '(none)'}`);
    if (selection.permissions?.allow?.length) {
      summary.push(`allow=${selection.permissions.allow.length} rule(s)`);
    }
    if (selection.permissions?.deny?.length) {
      summary.push(`deny=${selection.permissions.deny.length} rule(s)`);
    }
    if (selection.permissions?.mode) {
      summary.push(`mode=${selection.permissions.mode}`);
    }
  }
  if (spec.initialPrompt) summary.push('initial-prompt=<systemPrompt>');
  process.stderr.write(`• spawning ${spec.bin} (${summary.join(', ')})\n`);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      runCleanup(install.cleanupCommand, install.cleanupCommandString);
      resolve(code);
    };

    const child = spawn(spec.bin, finalArgs, {
      stdio: 'inherit',
      env: resolvedEnv ? { ...process.env, ...resolvedEnv } : process.env
    });

    const forward = (signal: NodeJS.Signals) => {
      if (!child.killed) child.kill(signal);
    };
    process.on('SIGINT', () => forward('SIGINT'));
    process.on('SIGTERM', () => forward('SIGTERM'));

    child.on('exit', (code, signal) => {
      finish(code ?? signalExitCode(signal));
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        process.stderr.write(
          `Failed to spawn "${spec.bin}": binary not found on PATH. Install the ${runtime.harness} CLI and retry.\n`
        );
      } else {
        process.stderr.write(`Failed to spawn "${spec.bin}": ${err.message}\n`);
      }
      finish(127);
    });
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const [subcommand, ...rest] = argv;

  if (!subcommand || subcommand === '-h' || subcommand === '--help') {
    process.stdout.write(USAGE);
    process.exit(subcommand ? 0 : 1);
  }

  if (subcommand !== 'agent') {
    die(`Unknown subcommand "${subcommand}".`);
  }

  const [selector, ...taskParts] = rest;
  if (!selector) die('agent: missing persona selector.');

  const target = parseSelector(selector);
  const selection = buildSelection(target.spec, target.tier, target.kind);

  if (taskParts.length > 0) {
    await runOneShot(selection, taskParts.join(' '));
  } else {
    const code = await runInteractive(selection);
    process.exit(code);
  }
}

main().catch((err) => {
  process.stderr.write(`${(err as Error)?.stack ?? String(err)}\n`);
  process.exit(1);
});
