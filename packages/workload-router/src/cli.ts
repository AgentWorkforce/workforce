#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { constants } from 'node:os';

import {
  PERSONA_TIERS,
  personaCatalog,
  usePersona,
  type Harness,
  type PersonaIntent,
  type PersonaTier,
  type PersonaSpec
} from './index.js';

const USAGE = `Usage: agent-workforce agent <persona>[@<tier>] [task...]

  <persona>  persona id or intent (e.g. npm-provenance-publisher or npm-provenance)
  <tier>     ${PERSONA_TIERS.join(' | ')}   (default: best-value)
  [task]     if provided, runs one-shot non-interactively;
             otherwise drops into an interactive harness session

Examples:
  agent-workforce agent npm-provenance-publisher@best
  agent-workforce agent review@best-value "look at the diff on this branch"
`;

function die(msg: string, withUsage = true): never {
  process.stderr.write(`${msg}\n`);
  if (withUsage) process.stderr.write(`\n${USAGE}`);
  process.exit(1);
}

function resolveIntent(key: string): PersonaIntent {
  if (Object.prototype.hasOwnProperty.call(personaCatalog, key)) {
    return key as PersonaIntent;
  }
  const specs = Object.values(personaCatalog) as PersonaSpec[];
  const byId = specs.find((p) => p.id === key);
  if (byId) return byId.intent;
  const listing = specs
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((p) => `  ${p.id}  (intent: ${p.intent})`)
    .join('\n');
  die(`Unknown persona "${key}". Known personas:\n${listing}`, false);
}

function parseSelector(sel: string): { intent: PersonaIntent; tier: PersonaTier } {
  const at = sel.indexOf('@');
  const id = at === -1 ? sel : sel.slice(0, at);
  const tierRaw = at === -1 ? undefined : sel.slice(at + 1);
  if (!id) die('Missing persona name before "@"');
  const tier = (tierRaw ?? 'best-value') as PersonaTier;
  if (tierRaw !== undefined && !PERSONA_TIERS.includes(tier)) {
    die(`Invalid tier "${tierRaw}". Must be one of: ${PERSONA_TIERS.join(', ')}`);
  }
  return { intent: resolveIntent(id), tier };
}

function stripProviderPrefix(model: string): string {
  const idx = model.indexOf('/');
  return idx >= 0 ? model.slice(idx + 1) : model;
}

type InteractiveSpec = {
  bin: string;
  args: readonly string[];
  initialPrompt: string | null;
};

function buildInteractiveSpec(
  harness: Harness,
  model: string,
  systemPrompt: string
): InteractiveSpec {
  switch (harness) {
    case 'claude':
      return {
        bin: 'claude',
        args: ['--model', model, '--append-system-prompt', systemPrompt],
        initialPrompt: null
      };
    case 'codex':
      return {
        bin: 'codex',
        args: ['-m', stripProviderPrefix(model)],
        initialPrompt: systemPrompt
      };
    case 'opencode':
      return {
        bin: 'opencode',
        args: ['--model', stripProviderPrefix(model)],
        initialPrompt: systemPrompt
      };
  }
}

async function runOneShot(
  intent: PersonaIntent,
  tier: PersonaTier,
  task: string
): Promise<never> {
  const ctx = usePersona(intent, { tier });
  const { personaId, runtime } = ctx.selection;
  process.stderr.write(
    `→ ${personaId} [${tier}] via ${runtime.harness} (${runtime.model})\n`
  );
  const execution = ctx.sendMessage(task, {
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

function runInteractive(intent: PersonaIntent, tier: PersonaTier): Promise<number> {
  const ctx = usePersona(intent, { tier });
  const { personaId, runtime } = ctx.selection;
  const { install } = ctx;
  process.stderr.write(
    `→ ${personaId} [${tier}] via ${runtime.harness} (${runtime.model})\n`
  );

  if (install.plan.installs.length > 0) {
    const skillIds = install.plan.installs.map((i) => i.skillId).join(', ');
    runInstall(install.command, `Installing skills: ${skillIds}`);
  }

  const spec = buildInteractiveSpec(runtime.harness, runtime.model, runtime.systemPrompt);
  const finalArgs = spec.initialPrompt ? [...spec.args, spec.initialPrompt] : [...spec.args];
  const promptNote = spec.initialPrompt ? ' <systemPrompt>' : '';
  process.stderr.write(`• spawning: ${spec.bin} ${spec.args.join(' ')}${promptNote}\n`);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      runCleanup(install.cleanupCommand, install.cleanupCommandString);
      resolve(code);
    };

    const child = spawn(spec.bin, finalArgs, { stdio: 'inherit' });

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

  const { intent, tier } = parseSelector(selector);

  if (taskParts.length > 0) {
    await runOneShot(intent, tier, taskParts.join(' '));
  } else {
    const code = await runInteractive(intent, tier);
    process.exit(code);
  }
}

main().catch((err) => {
  process.stderr.write(`${(err as Error)?.stack ?? String(err)}\n`);
  process.exit(1);
});
