#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants, homedir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  HARNESS_VALUES,
  PERSONA_TAGS,
  PERSONA_TIERS,
  personaCatalog,
  routingProfiles,
  useSelection,
  type Harness,
  type PersonaIntent,
  type PersonaSelection,
  type PersonaSpec,
  type PersonaTag,
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
import { launchOnMount } from '@relayfile/local-mount';
import { loadLocalPersonas, type PersonaSource } from './local-personas.js';

const USAGE = `Usage: agent-workforce <command> [args...]

Commands:
  agent [flags] <persona>[@<tier>] [task...]
                      Run a persona. Tier one of: ${PERSONA_TIERS.join(' | ')}
                      (default: best-value). If [task] is provided, runs one-shot
                      non-interactively; otherwise drops into an interactive
                      harness session.

                      Flags:
                        --install-in-repo   Install skills into the repo's
                                            .claude/skills/ (legacy). By default,
                                            interactive claude sessions stage
                                            skills under ~/.agent-workforce/
                                            sessions/<id>/ and pass --plugin-dir
                                            so the repo is never touched.
                        --clean             Launch interactive claude inside a
                                            @relayfile/local-mount sandbox that
                                            hides the repo's CLAUDE.md,
                                            CLAUDE.local.md, .claude, and
                                            .mcp.json from the session. Persona
                                            skills and keychain auth are
                                            preserved. Claude interactive only;
                                            incompatible with --install-in-repo.
  list [flags]        List available personas from the cascade (pwd → home →
                      library). By default shows one row per persona at the
                      recommended tier for its intent; pass --all to see every
                      tier. Flags:
                        --all                         show every tier (overrides default)
                        --json                        emit JSON instead of a table
                        --filter-rating <tier>        only show this tier; disables
                                                      the recommended-only default
                                                      (${PERSONA_TIERS.join(' | ')})
                        --filter-harness <harness>    only show this harness
                                                      (${HARNESS_VALUES.join(' | ')})
                        --filter-tag <tag>            only show personas carrying this tag
                                                      (${PERSONA_TAGS.join(' | ')})
                        --no-display-description      hide the DESCRIPTION column
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
  agent-workforce list
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

/**
 * Remove the whole per-session directory after the run, including the
 * enclosing `<homedir>/.agent-workforce/sessions/<id>/` that the CLI
 * created. The workload-router cleanup only covers the install subtree
 * (`<root>/claude/plugin`), so without this step empty parent dirs
 * would accumulate under `~/.agent-workforce/sessions/`.
 */
function removeSessionRoot(sessionRoot: string | undefined): void {
  if (!sessionRoot) return;
  spawnSync('rm', ['-rf', sessionRoot], { stdio: 'ignore', shell: false });
}

/**
 * Compute the absolute root directory for an interactive claude session.
 * Layout (under `root`):
 *
 *   ~/.agent-workforce/sessions/<personaId>-<timestamp>-<rand>/
 *     ├── claude/plugin/     ← skill install target + --plugin-dir
 *     └── mount/             ← @relayfile/local-mount mount (--clean only)
 *
 * The timestamp + random suffix keep concurrent sessions from colliding on
 * the same dir. Both the skill-install path and the mount path are derived
 * from the same `root` so a single session ID describes the whole run.
 */
function generateSessionRoot(personaId: string): string {
  const sessionId = `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
  return join(homedir(), '.agent-workforce', 'sessions', `${personaId}-${sessionId}`);
}

function sessionInstallRoot(sessionRoot: string): string {
  return join(sessionRoot, 'claude', 'plugin');
}

function sessionMountDir(sessionRoot: string): string {
  return join(sessionRoot, 'mount');
}

/** Patterns hidden from an interactive claude session when `--clean` is set.
 * Applied by `@relayfile/local-mount` with gitignore semantics, so bare names
 * match at any depth in the project tree (e.g. `.claude` hides both
 * `./.claude/` and `./packages/foo/.claude/`). */
export const CLEAN_IGNORED_PATTERNS = [
  'CLAUDE.md',
  'CLAUDE.local.md',
  '.claude',
  '.mcp.json'
] as const;

/**
 * Decide whether `--clean` should engage for this run. Returns a warning
 * string when the flag was requested but cannot apply (e.g. non-claude
 * harness); callers emit the warning to stderr and proceed with
 * `useClean: false`. Pure — no side effects, trivially testable.
 */
export function decideCleanMode(
  harness: Harness,
  clean: boolean
): { useClean: boolean; warning?: string } {
  if (!clean) return { useClean: false };
  if (harness !== 'claude') {
    return {
      useClean: false,
      warning: `--clean is only supported for the claude harness (this session uses ${harness}). Ignoring flag.`
    };
  }
  return { useClean: true };
}

async function runInteractive(
  selection: PersonaSelection,
  options: { installInRepo?: boolean; clean?: boolean } = {}
): Promise<number> {
  const { runtime, personaId, tier } = selection;
  // Out-of-repo staging only applies to the claude harness today (it's the
  // only one with a `--plugin-dir` hook). For codex/opencode, keep the legacy
  // behavior of installing into the repo's harness-conventional directory.
  // The --install-in-repo flag forces legacy behavior across the board.
  const useSessionDir = !options.installInRepo && runtime.harness === 'claude';
  const sessionRoot = useSessionDir ? generateSessionRoot(personaId) : undefined;
  const installRoot = sessionRoot ? sessionInstallRoot(sessionRoot) : undefined;
  // --clean applies to interactive claude only. For non-claude harnesses, warn
  // and drop the flag (same pattern as pluginDirs warnings in buildInteractiveSpec).
  const cleanDecision = decideCleanMode(runtime.harness, options.clean === true);
  if (cleanDecision.warning) {
    process.stderr.write(`warning: ${cleanDecision.warning}\n`);
  }
  const useClean = cleanDecision.useClean;
  const ctx = useSelection(
    selection,
    installRoot !== undefined ? { installRoot } : {}
  );
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
    const targetLabel = installRoot ? ` → ${installRoot}` : '';
    runInstall(install.command, `Installing skills: ${skillIds}${targetLabel}`);
  }

  const spec = buildInteractiveSpec({
    harness: runtime.harness,
    model: runtime.model,
    systemPrompt: runtime.systemPrompt,
    mcpServers: resolvedMcp,
    permissions: selection.permissions,
    ...(installRoot !== undefined ? { pluginDirs: [installRoot] } : {})
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
  if (useClean) summary.push('clean=on');
  process.stderr.write(`• spawning ${spec.bin} (${summary.join(', ')})\n`);

  // --clean branch: delegate process lifecycle (spawn, signal forwarding,
  // syncback, cleanup) to @relayfile/local-mount. Skill plugin dir lives
  // outside the mount, so claude resolves --plugin-dir normally regardless
  // of cwd.
  if (useClean && sessionRoot) {
    const mountDir = sessionMountDir(sessionRoot);
    process.stderr.write(`• clean mount → ${mountDir}\n`);
    try {
      const result = await launchOnMount({
        cli: spec.bin,
        projectDir: process.cwd(),
        mountDir,
        args: finalArgs,
        ignoredPatterns: [...CLEAN_IGNORED_PATTERNS],
        // launchOnMount passes `env` straight to the child spawn, so without
        // merging process.env we'd strip PATH/HOME/etc. Match the non-clean
        // branch: persona env overlays the inherited environment.
        env: resolvedEnv ? { ...process.env, ...resolvedEnv } : process.env,
        agentName: personaId
      });
      return result.exitCode;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') {
        process.stderr.write(
          `Failed to spawn "${spec.bin}" inside clean mount: binary not found on PATH. Install the ${runtime.harness} CLI and retry.\n`
        );
      } else {
        process.stderr.write(`Failed to launch clean mount: ${e.message}\n`);
      }
      return 127;
    } finally {
      runCleanup(install.cleanupCommand, install.cleanupCommandString);
      removeSessionRoot(sessionRoot);
    }
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      runCleanup(install.cleanupCommand, install.cleanupCommandString);
      removeSessionRoot(sessionRoot);
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

interface PersonaListRow {
  persona: string;
  source: PersonaSource;
  harness: string;
  model: string;
  intent: string;
  tags: PersonaTag[];
  description: string;
  rating: PersonaTier;
}

function collectPersonaRows(): PersonaListRow[] {
  const rows: PersonaListRow[] = [];
  const pushSpec = (spec: PersonaSpec, source: PersonaSource): void => {
    for (const tier of PERSONA_TIERS) {
      rows.push({
        persona: spec.id,
        source,
        harness: spec.tiers[tier].harness,
        model: spec.tiers[tier].model,
        intent: spec.intent,
        tags: spec.tags,
        description: spec.description,
        rating: tier
      });
    }
  };
  const seen = new Set<string>();
  for (const [id, spec] of local.byId) {
    pushSpec(spec, local.sources.get(id) ?? 'library');
    seen.add(id);
  }
  for (const spec of Object.values(personaCatalog)) {
    if (seen.has(spec.id)) continue;
    pushSpec(spec, 'library');
  }
  const tierOrder = new Map(PERSONA_TIERS.map((t, i) => [t, i] as const));
  return rows.sort(
    (a, b) =>
      a.persona.localeCompare(b.persona) ||
      (tierOrder.get(a.rating)! - tierOrder.get(b.rating)!)
  );
}

interface ListDisplayOptions {
  description: boolean;
}

function formatPersonaTable(
  rows: readonly PersonaListRow[],
  display: ListDisplayOptions
): string {
  interface RenderRow {
    persona: string;
    source: string;
    harness: string;
    model: string;
    rating: string;
    tags: string;
    description: string;
  }
  const headers: RenderRow = {
    persona: 'PERSONA',
    source: 'SOURCE',
    harness: 'HARNESS',
    model: 'MODEL',
    rating: 'RATING',
    tags: 'TAGS',
    description: 'DESCRIPTION'
  };
  const rendered: RenderRow[] = rows.map((r) => ({
    persona: r.persona,
    source: r.source,
    harness: r.harness,
    model: r.model,
    rating: r.rating,
    tags: r.tags.join(','),
    description: r.description
  }));
  const widths = {
    persona: Math.max(headers.persona.length, ...rendered.map((r) => r.persona.length)),
    source: Math.max(headers.source.length, ...rendered.map((r) => r.source.length)),
    harness: Math.max(headers.harness.length, ...rendered.map((r) => r.harness.length)),
    model: Math.max(headers.model.length, ...rendered.map((r) => r.model.length)),
    rating: Math.max(headers.rating.length, ...rendered.map((r) => r.rating.length)),
    tags: Math.max(headers.tags.length, ...rendered.map((r) => r.tags.length)),
    description: headers.description.length
  };
  const termWidth =
    process.stdout.isTTY && typeof process.stdout.columns === 'number' ? process.stdout.columns : 140;
  const fixed =
    widths.persona +
    widths.source +
    widths.harness +
    widths.model +
    widths.rating +
    widths.tags +
    (6 + (display.description ? 1 : 0) - 1) * 2;
  const descBudget = Math.max(20, termWidth - fixed - 1);
  const truncate = (s: string, n: number) => (s.length <= n ? s : s.slice(0, Math.max(1, n - 1)) + '…');
  const line = (row: RenderRow) => {
    const parts = [
      row.persona.padEnd(widths.persona),
      row.source.padEnd(widths.source),
      row.harness.padEnd(widths.harness),
      row.model.padEnd(widths.model),
      row.rating.padEnd(widths.rating),
      row.tags.padEnd(widths.tags)
    ];
    if (display.description) {
      parts.push(truncate(row.description.replace(/\s+/g, ' ').trim(), descBudget));
    }
    return parts.join('  ').trimEnd();
  };
  return [line(headers), ...rendered.map(line)].join('\n') + '\n';
}

function parseListArgs(args: readonly string[]): {
  json: boolean;
  filterRating?: PersonaTier;
  filterHarness?: Harness;
  filterTag?: PersonaTag;
  display: ListDisplayOptions;
  showAll: boolean;
  filterRatingExplicit: boolean;
} {
  let json = false;
  let filterRating: PersonaTier | undefined;
  let filterRatingExplicit = false;
  let filterHarness: Harness | undefined;
  let filterTag: PersonaTag | undefined;
  let showAll = false;
  const display: ListDisplayOptions = { description: true };

  const valueOf = (i: number, flag: string): string => {
    const v = args[i + 1];
    if (v === undefined || v.startsWith('--')) {
      die(`list: ${flag} requires a value.`);
    }
    return v;
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') {
      json = true;
    } else if (arg === '-h' || arg === '--help') {
      process.stdout.write(
        'Usage: agent-workforce list [--all] [--json] [--filter-rating <tier>] [--filter-harness <harness>] [--filter-tag <tag>] [--no-display-description]\n'
      );
      process.exit(0);
    } else if (arg === '--all' || arg === '--no-recommended') {
      showAll = true;
    } else if (arg === '--recommended') {
      showAll = false;
    } else if (arg === '--filter-rating') {
      const v = valueOf(i++, arg);
      if (!(PERSONA_TIERS as readonly string[]).includes(v)) {
        die(`list: invalid --filter-rating "${v}". Must be one of: ${PERSONA_TIERS.join(', ')}`);
      }
      filterRating = v as PersonaTier;
      filterRatingExplicit = true;
    } else if (arg === '--filter-harness') {
      const v = valueOf(i++, arg);
      if (!(HARNESS_VALUES as readonly string[]).includes(v)) {
        die(`list: invalid --filter-harness "${v}". Must be one of: ${HARNESS_VALUES.join(', ')}`);
      }
      filterHarness = v as Harness;
    } else if (arg === '--filter-tag') {
      const v = valueOf(i++, arg);
      if (!(PERSONA_TAGS as readonly string[]).includes(v)) {
        die(`list: invalid --filter-tag "${v}". Must be one of: ${PERSONA_TAGS.join(', ')}`);
      }
      filterTag = v as PersonaTag;
    } else if (arg === '--display-description') {
      display.description = true;
    } else if (arg === '--no-display-description') {
      display.description = false;
    } else {
      die(`list: unexpected argument "${arg}".`);
    }
  }
  return { json, filterRating, filterHarness, filterTag, display, showAll, filterRatingExplicit };
}

function runList(args: readonly string[]): never {
  const { json, filterRating, filterHarness, filterTag, display, showAll, filterRatingExplicit } =
    parseListArgs(args);

  const recommendedByIntent = routingProfiles.default.intents;
  const applyRecommended = !showAll && !filterRatingExplicit;

  const rows = collectPersonaRows().filter((r) => {
    if (filterRating && r.rating !== filterRating) return false;
    if (filterHarness && r.harness !== filterHarness) return false;
    if (filterTag && !r.tags.includes(filterTag)) return false;
    if (applyRecommended) {
      const rule = recommendedByIntent[r.intent as PersonaIntent];
      if (!rule || r.rating !== rule.tier) return false;
    }
    return true;
  });

  if (json) {
    process.stdout.write(JSON.stringify({ personas: rows }, null, 2) + '\n');
  } else {
    process.stdout.write(formatPersonaTable(rows, display));
    const uniq = new Set(rows.map((r) => r.persona)).size;
    const suffix = applyRecommended ? ' (recommended tier per intent; pass --all to see every tier)' : '';
    process.stdout.write(`\n${uniq} persona(s), ${rows.length} row(s)${suffix}.\n`);
  }
  process.exit(0);
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

  if (subcommand === 'list') {
    runList(rest);
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

  const { flags, positional } = parseAgentArgs(rest);
  const [selector, ...taskParts] = positional;
  if (!selector) die('agent: missing persona selector.');

  const target = parseSelector(selector);
  const selection = buildSelection(target.spec, target.tier, target.kind);

  if (taskParts.length > 0) {
    // One-shot (sendMessage) currently goes through the agent-relay workflow
    // SDK, which doesn't yet thread `--plugin-dir` into claude. For now it
    // keeps the legacy in-repo install regardless of --install-in-repo so
    // skills remain visible to the model. Flipping this requires upstream
    // SDK work on the claude agent adapter.
    if (flags.installInRepo) {
      process.stderr.write(
        'note: --install-in-repo is redundant for one-shot runs (already the current behavior).\n'
      );
    }
    if (flags.clean) {
      // Parallel to --install-in-repo: the agent-relay workflow SDK doesn't
      // thread @relayfile/local-mount integration today, so --clean on a
      // one-shot run is a no-op. Interactive mode gets the sandbox.
      process.stderr.write(
        'note: --clean is ignored for one-shot runs; it currently only applies to interactive claude sessions.\n'
      );
    }
    await runOneShot(selection, taskParts.join(' '));
  } else {
    const code = await runInteractive(selection, {
      installInRepo: flags.installInRepo,
      clean: flags.clean
    });
    process.exit(code);
  }
}

export interface AgentFlags {
  installInRepo: boolean;
  clean: boolean;
}

export function parseAgentArgs(args: readonly string[]): {
  flags: AgentFlags;
  positional: string[];
} {
  const flags: AgentFlags = { installInRepo: false, clean: false };
  const positional: string[] = [];
  let seenDoubleDash = false;
  for (const arg of args) {
    if (seenDoubleDash) {
      positional.push(arg);
      continue;
    }
    if (arg === '--') {
      seenDoubleDash = true;
      continue;
    }
    if (arg === '--install-in-repo') {
      flags.installInRepo = true;
      continue;
    }
    if (arg === '--clean') {
      flags.clean = true;
      continue;
    }
    if (arg === '-h' || arg === '--help') {
      process.stdout.write(USAGE);
      process.exit(0);
    }
    positional.push(arg);
  }
  if (flags.installInRepo && flags.clean) {
    die(
      'agent: --install-in-repo and --clean are mutually exclusive. ' +
        '--install-in-repo stages skills into the real repo; --clean hides ' +
        'the repo behind a mount. Pick one.'
    );
  }
  return { flags, positional };
}

// Only run main when invoked as the CLI entry, not when imported by tests.
// Node ESM: import.meta.url is the module URL; argv[1] is the entry script
// path, which may be relative (e.g. `node ./dist/cli.js`) and pathToFileURL
// throws on relative paths. Resolve to absolute first.
const isCliEntry = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(resolvePath(entry)).href;
  } catch {
    return false;
  }
})();

if (isCliEntry) {
  main().catch((err) => {
    process.stderr.write(`${(err as Error)?.stack ?? String(err)}\n`);
    process.exit(1);
  });
}
