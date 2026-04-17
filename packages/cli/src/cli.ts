#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { constants } from 'node:os';

import {
  PERSONA_TIERS,
  personaCatalog,
  useSelection,
  type PersonaSelection,
  type PersonaSpec,
  type PersonaTier
} from '@agentworkforce/workload-router';
import {
  buildInteractiveSpec,
  detectHarnesses,
  formatDropWarnings,
  resolveMcpServersLenient,
  resolveStringMapLenient,
  type HarnessAvailability,
  type InteractiveSpec
} from '@agentworkforce/harness-kit';
import { loadLocalPersonas } from './local-personas.js';

const USAGE = `Usage: agent-workforce <command> [args...]

Commands:
  agent <persona>[@<tier>] [task...]
                      Run a persona. Tier one of: ${PERSONA_TIERS.join(' | ')}
                      (default: best-value). If [task] is provided, runs one-shot
                      non-interactively; otherwise drops into an interactive
                      harness session.
  harness check       Probe which harnesses (claude, codex, opencode) are
                      installed and runnable on this machine.

Local personas cascade: <cwd>/.agent-workforce/*.json → ~/.agent-workforce/*.json → repo library.
Each layer only needs to specify fields it overrides; everything else inherits
from the next lower layer. "extends" explicitly names a base; omit it and the
loader implicitly inherits from the same-id persona below. (Override the home
layer path via AGENT_WORKFORCE_CONFIG_DIR.)

Examples:
  agent-workforce agent npm-provenance-publisher@best
  agent-workforce agent my-posthog@best
  agent-workforce agent review@best-value "look at the diff on this branch"
  agent-workforce harness check
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

  const spec = buildInteractiveSpec({
    harness: runtime.harness,
    model: runtime.model,
    systemPrompt: runtime.systemPrompt,
    mcpServers: resolvedMcp,
    permissions: selection.permissions
  });
  for (const w of spec.warnings) process.stderr.write(`warning: ${w}\n`);
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

function formatAvailabilityTable(results: readonly HarnessAvailability[]): string {
  const rows = results.map((r) => ({
    harness: r.harness,
    status: r.available ? 'ok' : 'missing',
    version: r.available ? (r.version ?? '') : '',
    detail: r.available ? (r.path ?? '') : (r.error ?? '')
  }));
  const headers = { harness: 'HARNESS', status: 'STATUS', version: 'VERSION', detail: 'DETAIL' };
  const cols = ['harness', 'status', 'version', 'detail'] as const;
  const widths = Object.fromEntries(
    cols.map((c) => [c, Math.max(headers[c].length, ...rows.map((r) => r[c].length))])
  ) as Record<(typeof cols)[number], number>;
  const line = (row: Record<(typeof cols)[number], string>) =>
    cols.map((c) => row[c].padEnd(widths[c])).join('  ').trimEnd();
  return [line(headers), ...rows.map(line)].join('\n') + '\n';
}

function runHarnessCheck(): never {
  const results = detectHarnesses();
  process.stdout.write(formatAvailabilityTable(results));
  const available = results.filter((r) => r.available).length;
  process.stdout.write(`\n${available}/${results.length} harness(es) available.\n`);
  process.exit(0);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const [subcommand, ...rest] = argv;

  if (!subcommand || subcommand === '-h' || subcommand === '--help') {
    process.stdout.write(USAGE);
    process.exit(subcommand ? 0 : 1);
  }

  if (subcommand === 'harness') {
    const [action, ...extra] = rest;
    if (!action || action === '-h' || action === '--help') {
      die('harness: missing action. Expected: check');
    }
    if (action !== 'check') {
      die(`harness: unknown action "${action}". Expected: check`);
    }
    if (extra.length > 0) {
      die(`harness check: unexpected argument "${extra[0]}".`);
    }
    runHarnessCheck();
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
