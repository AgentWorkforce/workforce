import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  computeTuiView,
  fuzzyScore,
  nextRecents,
  parseRecents,
  rankCandidates,
  recentCandidates,
  recordRecent,
  loadRecents,
  type TuiCandidate
} from './persona-tui.js';

const CANDIDATES: TuiCandidate[] = [
  {
    id: 'code-reviewer',
    description: 'Reviews pull requests for quality, correctness and security.',
    source: 'library'
  },
  {
    id: 'fix-flaky',
    description: 'Repairs flaky tests across the test suite.',
    source: 'user'
  },
  {
    id: 'persona-maker',
    description: 'Scaffolds a new persona via interactive Q&A.',
    source: 'library'
  },
  {
    id: 'my-reviewer',
    description: 'Local reviewer override with team-specific style rules.',
    source: 'cwd'
  }
];

test('fuzzyScore returns null when chars are absent or out of order', () => {
  assert.equal(fuzzyScore('zzz', 'code-reviewer'), null);
  assert.equal(fuzzyScore('reverse', 'reviewer'), null);
});

test('fuzzyScore prefers prefix and dense matches', () => {
  const prefix = fuzzyScore('code', 'code-reviewer');
  const scattered = fuzzyScore('code', 'committed-old-de');
  assert.ok(prefix !== null && scattered !== null);
  assert.ok(prefix! < scattered!, `expected prefix=${prefix} < scattered=${scattered}`);
});

test('rankCandidates surfaces name matches over description matches', () => {
  // Both reviewer ids match by name; "review" doesn't subsequence-match
  // anything else, so the two name matches are the only results and rank
  // by leading-offset (my-reviewer first because "r" appears earlier).
  const ranked = rankCandidates(CANDIDATES, 'review');
  assert.deepEqual(ranked.map((c) => c.id), ['my-reviewer', 'code-reviewer']);
});

test('rankCandidates returns empty array when nothing matches', () => {
  assert.deepEqual(rankCandidates(CANDIDATES, 'xxxxxxxx'), []);
});

test('rankCandidates returns all candidates with empty query', () => {
  const ranked = rankCandidates(CANDIDATES, '   ');
  assert.equal(ranked.length, CANDIDATES.length);
});

test('rankCandidates can match purely from description text', () => {
  const ranked = rankCandidates(CANDIDATES, 'flaky');
  assert.equal(ranked[0].id, 'fix-flaky');
});

test('recentCandidates preserves order and drops unknown ids', () => {
  const recents = recentCandidates(
    CANDIDATES,
    ['fix-flaky', 'gone-persona', 'code-reviewer', 'my-reviewer'],
    3
  );
  assert.deepEqual(
    recents.map((c) => c.id),
    ['fix-flaky', 'code-reviewer', 'my-reviewer']
  );
});

test('nextRecents moves an existing id to the front and caps the list', () => {
  const result = nextRecents(['a', 'b', 'c', 'd', 'e'], 'c', 3);
  assert.deepEqual(result, ['c', 'a', 'b']);
});

test('nextRecents prepends a new id', () => {
  assert.deepEqual(nextRecents(['a', 'b'], 'z'), ['z', 'a', 'b']);
});

test('parseRecents tolerates garbage input', () => {
  assert.deepEqual(parseRecents('not json'), []);
  assert.deepEqual(parseRecents('null'), []);
  assert.deepEqual(parseRecents('{"ids": "nope"}'), []);
  assert.deepEqual(parseRecents('{"ids": [1, "ok", "  ", "ok"]}'), ['ok']);
});

test('recordRecent + loadRecents round-trip via the filesystem', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aw-tui-'));
  const path = join(dir, 'nested', 'recents.json');
  try {
    recordRecent('code-reviewer', path);
    recordRecent('fix-flaky', path);
    recordRecent('code-reviewer', path);
    assert.deepEqual(loadRecents(path), ['code-reviewer', 'fix-flaky']);
    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as { version: number; ids: string[] };
    assert.equal(onDisk.version, 1);
    assert.deepEqual(onDisk.ids, ['code-reviewer', 'fix-flaky']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('computeTuiView: empty query with resolved recents → recents mode', () => {
  const view = computeTuiView(CANDIDATES, ['fix-flaky', 'code-reviewer'], '');
  assert.equal(view.mode, 'recents');
  assert.deepEqual(view.items.map((c) => c.id), ['fix-flaky', 'code-reviewer']);
});

test('computeTuiView: recents pointing only at unknown ids → all mode (regression)', () => {
  // Prior bug: header said "RECENT" because recentIds was non-empty even
  // though every id had been uninstalled/renamed and the full catalog was
  // being shown.
  const view = computeTuiView(CANDIDATES, ['ghost-persona', 'also-gone'], '');
  assert.equal(view.mode, 'all');
  assert.equal(view.items.length, CANDIDATES.length);
});

test('computeTuiView: empty query with no recents → all mode', () => {
  const view = computeTuiView(CANDIDATES, [], '');
  assert.equal(view.mode, 'all');
});

test('computeTuiView: non-empty query → matches mode', () => {
  const view = computeTuiView(CANDIDATES, ['fix-flaky'], 'review');
  assert.equal(view.mode, 'matches');
  assert.ok(view.items.length > 0);
  assert.ok(view.items.every((c) => c.id.includes('review')));
});

test('computeTuiView: matches mode honors visibleCap', () => {
  const view = computeTuiView(CANDIDATES, [], 'e', 2);
  assert.equal(view.mode, 'matches');
  assert.ok(view.items.length <= 2);
});

test('loadRecents returns [] when the file is absent or corrupt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aw-tui-'));
  const path = join(dir, 'recents.json');
  try {
    assert.deepEqual(loadRecents(path), []);
    writeFileSync(path, '{ not json', 'utf8');
    assert.deepEqual(loadRecents(path), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
