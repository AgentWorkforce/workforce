import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { defaultWorkforceHomeDir } from './local-personas.js';

/**
 * Persona projection shown in the interactive picker. Description and source
 * label come straight from the resolved spec / cascade so the user sees what
 * they'd see in `agentworkforce list`.
 */
export interface TuiCandidate {
  id: string;
  description: string;
  source: string;
}

const RECENTS_FILENAME = 'recents.json';
const RECENTS_CAP = 20;
const RECENT_DEFAULT_VISIBLE = 3;

export function defaultRecentsPath(workforceHomeDir = defaultWorkforceHomeDir()): string {
  return join(workforceHomeDir, RECENTS_FILENAME);
}

/**
 * Parse the on-disk recents file. Returns an empty list on any shape problem —
 * the recents store is best-effort UX and must never block the CLI from
 * launching an agent.
 */
export function parseRecents(text: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) return [];
  const ids = (parsed as { ids?: unknown }).ids;
  if (!Array.isArray(ids)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id !== 'string') continue;
    const trimmed = id.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= RECENTS_CAP) break;
  }
  return out;
}

export function loadRecents(path = defaultRecentsPath()): string[] {
  if (!existsSync(path)) return [];
  try {
    return parseRecents(readFileSync(path, 'utf8'));
  } catch {
    return [];
  }
}

/**
 * Move `id` to the front of the recents list, dedup, cap. Pure so tests don't
 * need a temp dir.
 */
export function nextRecents(
  prev: readonly string[],
  id: string,
  cap = RECENTS_CAP
): string[] {
  const filtered = prev.filter((x) => x !== id);
  return [id, ...filtered].slice(0, cap);
}

/**
 * Persist a persona id at the top of the recents list. Swallows IO errors —
 * a corrupt or unwritable recents file should never block a launch.
 */
export function recordRecent(id: string, path = defaultRecentsPath()): void {
  if (!id) return;
  try {
    const prev = loadRecents(path);
    const next = nextRecents(prev, id);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ version: 1, ids: next }, null, 2)}\n`, 'utf8');
  } catch {
    /* best-effort */
  }
}

/**
 * Subsequence fuzzy match. Returns null when not all query chars appear in
 * order; otherwise returns a numeric score where smaller is a better match.
 * Score combines leading offset and gap size so prefix / dense matches sort
 * above scattered ones.
 */
export function fuzzyScore(query: string, target: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  let firstIdx = -1;
  let lastIdx = -1;
  let totalGap = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      if (firstIdx === -1) firstIdx = ti;
      if (lastIdx !== -1) totalGap += ti - lastIdx - 1;
      lastIdx = ti;
      qi += 1;
    }
  }
  if (qi < q.length) return null;
  return firstIdx + totalGap * 2 + Math.floor(t.length / 32);
}

/**
 * Rank candidates by best fuzzy match across name OR description. Name matches
 * outrank description matches at equal score to keep the picker feeling
 * direct — typing "rev" should surface "code-reviewer" not whichever persona
 * happens to mention "reviews" in prose.
 */
export function rankCandidates(
  candidates: readonly TuiCandidate[],
  query: string
): TuiCandidate[] {
  const trimmed = query.trim();
  if (!trimmed) return [...candidates];
  const DESCRIPTION_PENALTY = 5;
  const scored: Array<{ c: TuiCandidate; s: number }> = [];
  for (const c of candidates) {
    const nameScore = fuzzyScore(trimmed, c.id);
    const descScore = fuzzyScore(trimmed, c.description);
    let score: number | null = null;
    if (nameScore !== null && descScore !== null) {
      score = Math.min(nameScore, descScore + DESCRIPTION_PENALTY);
    } else if (nameScore !== null) {
      score = nameScore;
    } else if (descScore !== null) {
      score = descScore + DESCRIPTION_PENALTY;
    }
    if (score !== null) scored.push({ c, s: score });
  }
  scored.sort((a, b) => a.s - b.s || a.c.id.localeCompare(b.c.id));
  return scored.map((r) => r.c);
}

/**
 * Project recent ids onto the candidate list, preserving recency order and
 * dropping ids that no longer resolve (uninstalled pack, renamed local
 * persona, etc.).
 */
export function recentCandidates(
  candidates: readonly TuiCandidate[],
  recentIds: readonly string[],
  cap = RECENT_DEFAULT_VISIBLE
): TuiCandidate[] {
  const byId = new Map(candidates.map((c) => [c.id, c] as const));
  const out: TuiCandidate[] = [];
  for (const id of recentIds) {
    const c = byId.get(id);
    if (!c) continue;
    out.push(c);
    if (out.length >= cap) break;
  }
  return out;
}

const ESC = '\x1b';
const SEQ = {
  enterAlt: `${ESC}[?1049h`,
  leaveAlt: `${ESC}[?1049l`,
  hideCursor: `${ESC}[?25l`,
  showCursor: `${ESC}[?25h`,
  clear: `${ESC}[2J${ESC}[H`,
  reset: `${ESC}[0m`,
  inverse: `${ESC}[7m`,
  dim: `${ESC}[2m`,
  bold: `${ESC}[1m`,
  cyan: `${ESC}[36m`
} as const;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return text.slice(0, Math.max(0, max));
  return `${text.slice(0, max - 1)}…`;
}

export interface RunPersonaTuiOptions {
  candidates: readonly TuiCandidate[];
  recentIds: readonly string[];
  stdin?: NodeJS.ReadStream;
  stderr?: NodeJS.WriteStream;
  /** Cap on visible rows. Tests inject a small number; default 20. */
  visibleCap?: number;
  /** Escape-sequence debounce in ms. Tests inject 0; default 50. */
  escapeTimeoutMs?: number;
}

const DEFAULT_VISIBLE_CAP = 20;
/**
 * Window we wait for the rest of an escape sequence before treating a bare
 * `\x1b` as a quit keystroke. Arrow keys arrive as `\x1b[A` / `\x1b[B`, and
 * over slow connections (SSH, multiplexers, low-baud serial) those bytes can
 * land in separate `data` events. 50ms is well below the human-perceptible
 * delay for a real Esc press but plenty of slack for fragmented sequences.
 */
const DEFAULT_ESCAPE_TIMEOUT_MS = 50;

export type TuiViewMode = 'recents' | 'all' | 'matches';

export interface TuiView {
  mode: TuiViewMode;
  items: TuiCandidate[];
}

/**
 * Decide what the picker should show given the candidate set, recents list,
 * and current query. Exported (and pure) so the recents-header logic can be
 * unit-tested without spinning up a TTY.
 *
 * - `recents` — empty query AND at least one recent id still resolves to a
 *   known candidate.
 * - `all`     — empty query AND no recent ids resolve (fresh install, or all
 *               previously-used personas have been uninstalled/renamed).
 * - `matches` — non-empty query; items are the ranked fuzzy hits.
 */
export function computeTuiView(
  candidates: readonly TuiCandidate[],
  recentIds: readonly string[],
  query: string,
  visibleCap: number = DEFAULT_VISIBLE_CAP
): TuiView {
  if (!query.trim()) {
    const recents = recentCandidates(candidates, recentIds, RECENT_DEFAULT_VISIBLE);
    if (recents.length > 0) return { mode: 'recents', items: recents };
    return { mode: 'all', items: [...candidates].slice(0, visibleCap) };
  }
  return {
    mode: 'matches',
    items: rankCandidates(candidates, query).slice(0, visibleCap)
  };
}

/**
 * Interactive persona picker. Renders inside the alternate screen buffer so
 * scrollback survives, raw-mode reads single keystrokes for arrow/enter/esc
 * handling, and resolves with the chosen persona id (or undefined on quit).
 *
 * Falls back to undefined immediately when stdin or stderr isn't a TTY — the
 * caller should print the regular help text in that case.
 */
export async function runPersonaPickerTui(
  opts: RunPersonaTuiOptions
): Promise<string | undefined> {
  const stdin = opts.stdin ?? process.stdin;
  const stderr = opts.stderr ?? process.stderr;
  if (!stdin.isTTY || !stderr.isTTY) return undefined;

  const visibleCap = opts.visibleCap ?? DEFAULT_VISIBLE_CAP;
  const escapeTimeoutMs = opts.escapeTimeoutMs ?? DEFAULT_ESCAPE_TIMEOUT_MS;
  let query = '';
  let cursor = 0;
  let view = computeTuiView(opts.candidates, opts.recentIds, query, visibleCap);

  function render(): void {
    const cols = stderr.columns ?? 100;
    const items = view.items;
    let out = SEQ.clear;
    out += `${SEQ.bold}agentworkforce${SEQ.reset}  ·  pick a persona\n`;
    out += `${SEQ.dim}↑↓ navigate · enter run · esc quit · type to search${SEQ.reset}\n\n`;
    out += `${SEQ.cyan}›${SEQ.reset} ${query || `${SEQ.dim}(type to search by name or description)${SEQ.reset}`}\n\n`;
    const header = items.length === 0
      ? 'NO MATCHES'
      : view.mode === 'recents'
        ? 'RECENT'
        : 'PERSONAS';
    out += `${SEQ.dim}${header}${SEQ.reset}\n`;
    if (items.length === 0) {
      out += `${SEQ.dim}(no persona name or description matches "${query}")${SEQ.reset}\n`;
    } else {
      const nameWidth = Math.min(
        32,
        Math.max(8, ...items.map((c) => c.id.length))
      );
      const sourceWidth = Math.min(
        14,
        Math.max(7, ...items.map((c) => c.source.length))
      );
      const descBudget = Math.max(20, cols - nameWidth - sourceWidth - 7);
      for (let i = 0; i < items.length; i += 1) {
        const c = items[i];
        const isSel = i === cursor;
        const marker = isSel ? `${SEQ.cyan}›${SEQ.reset}` : ' ';
        const desc = truncate(c.description.replace(/\s+/g, ' ').trim(), descBudget);
        const body = `${c.id.padEnd(nameWidth)}  ${c.source.padEnd(sourceWidth)}  ${desc}`;
        const styled = isSel ? `${SEQ.inverse}${body}${SEQ.reset}` : `${SEQ.dim}${body}${SEQ.reset}`;
        out += `${marker} ${styled}\n`;
      }
    }
    stderr.write(out);
  }

  function refresh(): void {
    view = computeTuiView(opts.candidates, opts.recentIds, query, visibleCap);
    if (cursor >= view.items.length) cursor = Math.max(0, view.items.length - 1);
    render();
  }

  return new Promise<string | undefined>((resolve) => {
    let settled = false;
    // Buffered bare-Escape: stays set while we wait for the rest of a possible
    // escape sequence. If `escapeTimer` fires first the user pressed Esc on
    // its own; if more bytes arrive first we glue them together and dispatch.
    let pendingEscape = '';
    let escapeTimer: NodeJS.Timeout | undefined;
    function clearEscapeBuffer(): void {
      pendingEscape = '';
      if (escapeTimer) {
        clearTimeout(escapeTimer);
        escapeTimer = undefined;
      }
    }
    function settle(value: string | undefined): void {
      if (settled) return;
      settled = true;
      clearEscapeBuffer();
      stdin.removeListener('data', onData);
      try {
        stdin.setRawMode?.(false);
      } catch {
        /* not a TTY anymore */
      }
      stdin.pause();
      stderr.write(`${SEQ.showCursor}${SEQ.leaveAlt}`);
      resolve(value);
    }
    function handleKey(text: string): void {
      // Ctrl-C — quit.
      if (text === '\x03') {
        settle(undefined);
        return;
      }
      // Bare Escape that has already cleared the debounce window.
      if (text === '\x1b') {
        settle(undefined);
        return;
      }
      // Enter — accept current selection.
      if (text === '\r' || text === '\n') {
        const sel = view.items[cursor];
        settle(sel?.id);
        return;
      }
      // Arrow Up / Ctrl-P
      if (text === '\x1b[A' || text === '\x10') {
        if (view.items.length === 0) return;
        cursor = (cursor - 1 + view.items.length) % view.items.length;
        render();
        return;
      }
      // Arrow Down / Ctrl-N
      if (text === '\x1b[B' || text === '\x0e') {
        if (view.items.length === 0) return;
        cursor = (cursor + 1) % view.items.length;
        render();
        return;
      }
      // Backspace
      if (text === '\x7f' || text === '\b') {
        if (query.length > 0) {
          query = query.slice(0, -1);
          cursor = 0;
          refresh();
        }
        return;
      }
      // Anything else that *starts* with ESC is an unrecognized CSI / SS3 /
      // function-key sequence — swallow it rather than typing the bytes into
      // the search box.
      if (text.startsWith('\x1b')) return;
      // Strip any remaining control bytes and append printable input.
      let printable = '';
      for (const ch of text) {
        const code = ch.charCodeAt(0);
        if (code >= 0x20 && code !== 0x7f) printable += ch;
      }
      if (printable.length > 0) {
        query += printable;
        cursor = 0;
        refresh();
      }
    }
    function onData(chunk: Buffer | string): void {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      // Mid-sequence: the previous tick buffered a lone ESC. Glue and
      // dispatch as a single keystroke so `\x1b` + `[A` is treated as an
      // arrow press, not Esc-then-`[A`.
      if (pendingEscape) {
        const combined = pendingEscape + text;
        clearEscapeBuffer();
        handleKey(combined);
        return;
      }
      // Lone ESC: wait briefly for the rest of a possible sequence.
      if (text === '\x1b' && escapeTimeoutMs > 0) {
        pendingEscape = text;
        escapeTimer = setTimeout(() => {
          if (pendingEscape !== '\x1b') return;
          clearEscapeBuffer();
          handleKey('\x1b');
        }, escapeTimeoutMs);
        return;
      }
      handleKey(text);
    }
    try {
      stdin.setRawMode?.(true);
    } catch {
      /* not a TTY */
    }
    stdin.resume();
    stderr.write(`${SEQ.enterAlt}${SEQ.hideCursor}`);
    stdin.on('data', onData);
    render();
  });
}
