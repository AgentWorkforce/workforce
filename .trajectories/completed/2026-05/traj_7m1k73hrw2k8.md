# Trajectory: Add Workforce runnable persona sendMessage bridge

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** May 1, 2026 at 08:52 PM
> **Completed:** May 1, 2026 at 09:00 PM

---

## Summary

Added a harness-kit runnable persona bridge with non-interactive sendMessage execution, fake-harness tests, README docs, and updated @relayfile/local-mount to 0.6.1 so the pulled main branch typechecks with includeGit.

**Approach:** Standard approach

---

## Key Decisions

### Added runnable persona bridge in harness-kit instead of workload-router
- **Chose:** Added runnable persona bridge in harness-kit instead of workload-router
- **Reasoning:** workload-router remains the pure selection/install metadata layer; harness-kit already owns per-harness command knowledge and can safely expose the side-effecting sendMessage bridge Ricky needs.

---

## Chapters

### 1. Work
*Agent: default*

- Added runnable persona bridge in harness-kit instead of workload-router: Added runnable persona bridge in harness-kit instead of workload-router

---

## Artifacts

**Commits:** e746d8a, 8051d7b
**Files changed:** 3
