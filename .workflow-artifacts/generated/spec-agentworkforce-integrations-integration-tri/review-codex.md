verdict: FINDINGS

finding_id: diff-inventory-not-deterministic
severity: high
file: .workflow-artifacts/generated/spec-agentworkforce-integrations-integration-tri/lead-plan.md
issue: The git diff gate requires `git diff --name-status main...HEAD` to be non-empty and equal to, or a subset of, the declared change inventory, but the declared targets mix read-only references/non-files (`@relayfile/adapter-core/triggers`, `/me/integrations`) with broad package scopes and omit files the same plan requires changing, including `packages/cli/src/cli.ts`, CLI README updates, and test files. This makes the deterministic gate ambiguous: it can fail required implementation changes as "unexpected", or pass an incomplete subset that does not include required dispatch/docs/tests.
fix_required: Replace the target-file list used for diff validation with an explicit per-slice change inventory split into `required_changed_paths`, `allowed_changed_paths`, and `read_only_reference_paths`. Include required P2 paths such as `packages/cli/src/cli.ts`, `packages/cli/src/integrations-command.ts`, `packages/cli/src/integrations-command.test.ts`, and `packages/cli/README.md`; include P1/P3 tests, package entrypoints, and any README/package metadata paths that are expected. Keep read-only references out of the diff allowlist except as evidence-only checks.
test_required: Add or run a deterministic gate that fails when required changed paths are missing and fails on unexpected changed paths, using `git diff --name-status main...HEAD` plus an explicit allowlist/required-list comparison. The gate output should be persisted in this artifact directory.
status: open
evidence: Read `lead-plan.md` lines 73, 105, 109-117, and 159; read `acceptance-contract.json` targetFiles at lines 17-24; read `verification-plan.md` git diff gate requirement. Commands run included `sed -n`/`nl -ba` over the requested artifacts and `rg -n "agent-relay|@agent-relay|concurrency|80|100|review|fix|signoff|Relaycast|relaycast|mcp__relaycast|add_agent|GENERATION_LEAD_PLAN_READY|process\\.exit|configKey|PR URL|non-empty|diff" .workflow-artifacts/generated/spec-agentworkforce-integrations-integration-tri`.

finding_id: offline-all-contract-weakened
severity: medium
file: .workflow-artifacts/generated/spec-agentworkforce-integrations-integration-tri/lead-plan.md
issue: The plan allows unauthenticated catalog lookup to fall back to trigger-catalog-only rows when the cloud catalog is unreachable, but the normalized spec says `agentworkforce integrations --all` is the full catalog, works offline/logged-out, and rows are the full union of cloud-catalog entries and trigger-catalog providers. Trigger-catalog-only fallback drops cloud-only/connect-only providers, so it does not satisfy the documented full-union `--all` behavior.
fix_required: Resolve the contract explicitly. Either change the spec/lead plan to say `--all` works logged-out only when the cloud catalog is reachable and true offline mode is partial with a warning, or add a deterministic bundled/static cloud provider catalog for offline mode and reconcile that with the no-caching decision. Do not leave the implementation plan silently accepting a partial catalog while the acceptance text promises the full union.
test_required: Add a logged-out/offline fixture test for `agentworkforce integrations --all` and `--json` that proves the chosen contract: either it includes a cloud-only connect-only provider in the full union, or it emits the explicitly documented partial-catalog warning/exit behavior.
status: open
evidence: Read `normalized-spec.md` lines 33-35, 67-69, 75-88, and `lead-plan.md` lines 53-56 and 68-70. The conflict is between the full-union/offline `--all` promise and the trigger-catalog-only fallback.
