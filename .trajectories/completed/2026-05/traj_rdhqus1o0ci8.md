# Trajectory: Add typed ProactiveCapabilities to persona-kit PersonaSpec

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** May 31, 2026 at 12:29 PM
> **Completed:** May 31, 2026 at 12:32 PM

---

## Summary

Added optional typed proactive capabilities to persona-kit PersonaSpec, exported the canonical types, preserved capabilities through define/parse, regenerated schema, bumped package version to 3.0.34, and validated build/typecheck/test.

**Approach:** Standard approach

---

## Key Decisions

### Preserve capabilities in parsePersonaSpec
- **Chose:** Preserve capabilities in parsePersonaSpec
- **Reasoning:** parsePersonaSpec reconstructs PersonaSpec and drops unknown top-level fields, so the new optional field needs parser support for define/parse round-trip

---

## Chapters

### 1. Work
*Agent: default*

- Preserve capabilities in parsePersonaSpec: Preserve capabilities in parsePersonaSpec
