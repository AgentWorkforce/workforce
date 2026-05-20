# Trajectory: Persistent skill cache + upstream drift detection

> **Status:** ✅ Completed
> **Confidence:** 86%
> **Started:** May 15, 2026 at 10:47 PM
> **Completed:** May 15, 2026 at 10:58 PM

---

## Summary

Extended the persistent skill-cache PR with opt-in upstream drift detection. Marker bumped to schema v2 (v1 read-compatible) recording per-skill upstream identity (prpm resolved version / GitHub blob SHA). TTL-gated (24h default) parallel probes on launch flip a cache hit to a reinstall when upstream moved; fail-open on any probe error. Added --check-upstream/--no-check-upstream + AGENTWORKFORCE_SKILL_CACHE_CHECK_INTERVAL. 22 new unit tests (mocked HTTP) + verified end-to-end against live prpm.dev and api.github.com.

**Approach:** Reused installer lockfiles (prpm.lock version, skills-lock.json skillPath) for precise per-file identity; conditional GET (If-None-Match) for the cheapest GitHub check; mutable cache-hit flag downgraded by an awaited drift probe before the install decision.

---

## Key Decisions

### Content-addressed cache keyed by (harness, sorted skill sources, local-file SHA) under ~/.agentworkforce/workforce/cache/plugins/<fp>/
- **Chose:** Content-addressed cache keyed by (harness, sorted skill sources, local-file SHA) under ~/.agentworkforce/workforce/cache/plugins/<fp>/
- **Rejected:** Per-session install (status quo, slow); global shared plugin dir (skill collisions across personas); TTL-only cache (still pays install on expiry)
- **Reasoning:** The reported slowness was npx prpm install / npx skills add re-running every launch. A persistent dir keyed by a stable fingerprint lets repeat launches skip the install entirely. Local .md sources fold their content hash in so edits auto-invalidate without a version bump.

### Never auto-invalidate on the source-key fingerprint; cover all three harnesses
- **Chose:** Never auto-invalidate on the source-key fingerprint; cover all three harnesses
- **Rejected:** Daily TTL on the fingerprint; claude-only scope with mount harnesses as follow-up
- **Reasoning:** User explicitly chose 'never auto-invalidate' for the fingerprint layer and 'all harnesses now' when asked. Claude reuses the cache dir as --plugin-dir; opencode/codex mirror it into the relayfile mount before launch (mount-ignored patterns stop syncback).

### Add opt-in upstream drift detection: prpm registry GET + GitHub Contents API blob SHA, TTL-gated (24h default), fail-open
- **Chose:** Add opt-in upstream drift detection: prpm registry GET + GitHub Contents API blob SHA, TTL-gated (24h default), fail-open
- **Rejected:** Manual --refresh-skills only (user must remember); always-check (slows every launch); coarse repo-HEAD commit SHA for github (over-invalidates monorepos)
- **Reasoning:** User asked how a new upstream skill version is consumed when the source string is unchanged. Explored prpm info / registry HTTP API (latest_version.version) and skill.sh — both expose cheap version probes. A 24h TTL keeps most launches network-free; only the daily check launch pays ~150-500ms parallel probes. Fail-open so a flaky registry never blocks a launch.

### Precise per-file GitHub blob SHA via skills-lock.json skillPath, not coarse repo-HEAD; conditional GET with If-None-Match
- **Chose:** Precise per-file GitHub blob SHA via skills-lock.json skillPath, not coarse repo-HEAD; conditional GET with If-None-Match
- **Rejected:** repos/<o>/<r>/commits?per_page=1 repo-HEAD (1 call, but any push invalidates); re-download SKILL.md and hash (heavier, needs path anyway)
- **Reasoning:** skill.sh writes skills-lock.json with skillPath + computedHash per skill. Building the Contents API URL from skillPath gives per-file drift (a monorepo of 50 skills doesn't invalidate on an unrelated commit). The blob SHA is also the ETag, so If-None-Match returns 304 with no body — cheapest possible check.

### Marker schema v2, v1 read-compatible; fingerprint content-version pinned to 1 independent of marker version
- **Chose:** Marker schema v2, v1 read-compatible; fingerprint content-version pinned to 1 independent of marker version
- **Rejected:** Hard v2 cutover (invalidates all caches); separate sidecar file for upstream metadata (more files to keep consistent)
- **Reasoning:** Bumping the marker schema must not invalidate every cache entry in the wild. readSkillCacheMarker accepts v1+v2 and upgrades v1 in place with no upstream records (next drift pass captures identity). The fingerprint's internal 'v' stays 1 so existing dirs keep resolving.

---

## Chapters

### 1. Initial work
*Agent: claude-skill-cache*

- Content-addressed cache keyed by (harness, sorted skill sources, local-file SHA) under ~/.agentworkforce/workforce/cache/plugins/<fp>/: Content-addressed cache keyed by (harness, sorted skill sources, local-file SHA) under ~/.agentworkforce/workforce/cache/plugins/<fp>/
- Never auto-invalidate on the source-key fingerprint; cover all three harnesses: Never auto-invalidate on the source-key fingerprint; cover all three harnesses
- Add opt-in upstream drift detection: prpm registry GET + GitHub Contents API blob SHA, TTL-gated (24h default), fail-open: Add opt-in upstream drift detection: prpm registry GET + GitHub Contents API blob SHA, TTL-gated (24h default), fail-open
- Precise per-file GitHub blob SHA via skills-lock.json skillPath, not coarse repo-HEAD; conditional GET with If-None-Match: Precise per-file GitHub blob SHA via skills-lock.json skillPath, not coarse repo-HEAD; conditional GET with If-None-Match
- Marker schema v2, v1 read-compatible; fingerprint content-version pinned to 1 independent of marker version: Marker schema v2, v1 read-compatible; fingerprint content-version pinned to 1 independent of marker version
- Verified end-to-end against live prpm.dev + api.github.com: cache miss records resolved version; in-TTL launches skip probing; --check-upstream detects a tampered stale version (1.0.0→1.1.3) and reinstalls; marker self-heals; --no-check-upstream bypasses. GitHub 304 If-None-Match path confirmed.
