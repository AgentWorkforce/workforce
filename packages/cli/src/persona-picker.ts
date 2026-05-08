import { spawnSync, type SpawnSyncOptions } from 'node:child_process';

/**
 * Compact projection of a persona used for picker prompts. The model only
 * needs enough to reason about intent fit — full systemPrompts would inflate
 * the prompt without improving quality.
 */
export interface PickCandidate {
  id: string;
  intent: string;
  tags: readonly string[];
  description: string;
}

export type PickConfidence = 'high' | 'medium' | 'low';

export type PickResult =
  | {
      kind: 'match';
      personaId: string;
      confidence: 'high' | 'medium';
      reason: string;
    }
  | {
      kind: 'no-match';
      reason: string;
    }
  | {
      kind: 'picker-unavailable';
      message: string;
    };

/**
 * Test seam describing one round-trip to the picker subprocess. Returning a
 * structured shape keeps tests free of real `spawnSync` calls while preserving
 * the stdout/stderr/status surface the parser exercises.
 */
export interface PickerSubprocessRequest {
  bin: string;
  args: readonly string[];
  systemPrompt: string;
  userPrompt: string;
  timeoutMs: number;
}

export interface PickerSubprocessResult {
  status: 'ok' | 'enoent' | 'error';
  stdout: string;
  stderr: string;
  errorMessage?: string;
}

export type PickerRunner = (req: PickerSubprocessRequest) => PickerSubprocessResult;

export interface PickPersonaOptions {
  claudeBin?: string;
  model?: string;
  timeoutMs?: number;
  runner?: PickerRunner;
}

const DEFAULT_BIN = 'claude';
// Use the dated model id rather than the `claude-haiku-4-5` alias so the
// subprocess survives any future change in the Claude CLI's alias resolver.
// The alias works today but the dated id is strictly more robust.
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_TIMEOUT_MS = 30_000;

const SYSTEM_PROMPT = `You pick the single best persona for a user task from a fixed catalog.

Rules:
- Read the task and the candidate list.
- Choose the persona whose intent and description most directly match the task.
- If no persona is a clear fit, set "persona" to null with confidence "low".
- Output ONE JSON object on a single line. No prose, no code fences, no commentary.

Output schema:
{"persona": "<id from the candidate list, or null>", "confidence": "high" | "medium" | "low", "reason": "<one short sentence>"}`;

export function buildUserPrompt(task: string, candidates: readonly PickCandidate[]): string {
  const compact = candidates.map((c) => ({
    id: c.id,
    intent: c.intent,
    tags: [...c.tags],
    description: c.description
  }));
  return `Task:\n${task.trim()}\n\nCandidates (JSON):\n${JSON.stringify(compact)}`;
}

interface PickerJsonResponse {
  persona: string | null;
  confidence: PickConfidence;
  reason: string;
}

function isPickerJsonResponse(value: unknown): value is PickerJsonResponse {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.persona !== null && typeof v.persona !== 'string') return false;
  if (v.confidence !== 'high' && v.confidence !== 'medium' && v.confidence !== 'low') return false;
  if (typeof v.reason !== 'string') return false;
  return true;
}

/**
 * Parse the model's text output. Accepts either a bare JSON object or the
 * Claude CLI `--output-format json` envelope `{type, result, ...}` whose
 * `result` field carries the model text. Returns undefined when the output
 * cannot be coerced to the expected shape — callers translate that into a
 * `no-match` result.
 */
export function parsePickerOutput(stdout: string): PickerJsonResponse | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;

  let candidate: unknown;
  try {
    candidate = JSON.parse(trimmed);
  } catch {
    return undefined;
  }

  if (
    typeof candidate === 'object' &&
    candidate !== null &&
    'result' in candidate &&
    typeof (candidate as { result: unknown }).result === 'string'
  ) {
    const inner = (candidate as { result: string }).result.trim();
    try {
      candidate = JSON.parse(inner);
    } catch {
      return undefined;
    }
  }

  return isPickerJsonResponse(candidate) ? candidate : undefined;
}

function defaultRunner(req: PickerSubprocessRequest): PickerSubprocessResult {
  const opts: SpawnSyncOptions = {
    encoding: 'utf8',
    timeout: req.timeoutMs
  };
  const child = spawnSync(req.bin, [...req.args], opts);
  if (child.error) {
    const err = child.error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return { status: 'enoent', stdout: '', stderr: '', errorMessage: err.message };
    }
    return {
      status: 'error',
      stdout: typeof child.stdout === 'string' ? child.stdout : '',
      stderr: typeof child.stderr === 'string' ? child.stderr : '',
      errorMessage: err.message
    };
  }
  const stdout = typeof child.stdout === 'string' ? child.stdout : '';
  const stderr = typeof child.stderr === 'string' ? child.stderr : '';
  if (typeof child.status === 'number' && child.status !== 0) {
    return { status: 'error', stdout, stderr, errorMessage: `exit ${child.status}` };
  }
  return { status: 'ok', stdout, stderr };
}

export function pickPersona(
  task: string,
  candidates: readonly PickCandidate[],
  opts: PickPersonaOptions = {}
): PickResult {
  if (!task.trim()) {
    return { kind: 'no-match', reason: 'empty task description' };
  }
  if (candidates.length === 0) {
    return { kind: 'no-match', reason: 'no candidates available' };
  }

  const bin = opts.claudeBin ?? DEFAULT_BIN;
  const model = opts.model ?? DEFAULT_MODEL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const runner = opts.runner ?? defaultRunner;

  const userPrompt = buildUserPrompt(task, candidates);
  const args = [
    '-p',
    '--model',
    model,
    '--output-format',
    'json',
    '--system-prompt',
    SYSTEM_PROMPT,
    userPrompt
  ];

  const result = runner({ bin, args, systemPrompt: SYSTEM_PROMPT, userPrompt, timeoutMs });

  if (result.status === 'enoent') {
    return {
      kind: 'picker-unavailable',
      message: `\`${bin}\` not found on PATH. Install Claude Code (https://docs.claude.com/en/docs/claude-code) or run \`agentworkforce harness check\` to verify.`
    };
  }
  if (result.status === 'error') {
    return {
      kind: 'picker-unavailable',
      message: `picker subprocess failed: ${result.errorMessage ?? 'unknown error'}${result.stderr ? `\n${result.stderr.trim()}` : ''}`
    };
  }

  const parsed = parsePickerOutput(result.stdout);
  if (!parsed) {
    return { kind: 'no-match', reason: 'picker returned no parseable response' };
  }

  if (parsed.persona === null || parsed.confidence === 'low') {
    return { kind: 'no-match', reason: parsed.reason || 'low confidence' };
  }

  const known = new Set(candidates.map((c) => c.id));
  if (!known.has(parsed.persona)) {
    return {
      kind: 'no-match',
      reason: `picker returned unknown persona id "${parsed.persona}"`
    };
  }

  return {
    kind: 'match',
    personaId: parsed.persona,
    confidence: parsed.confidence,
    reason: parsed.reason
  };
}
