# Verification Plan

Run or satisfy these verification requirements before signoff:

- file_exists gate for declared targets
- deterministic structural sanity gate using a parser, inline assertion, or scoped file/diff check
- active-reference gate for deleted manifest paths
- npx tsc --noEmit
- npm test --workspace='packages/cli' && npm test --workspace='packages/deploy'
- git diff gate comparing git diff --name-status against the declared change inventory and requiring a non-empty diff
- PR URL or explicit result summary

Generated workflow quality:

- Include a real deterministic sanity gate over produced files, not just prose saying one exists.
- Prefer structural checks, scoped file/diff checks, or a small inline assertion command that exits non-zero when expected content/state is missing.
- If using rg, guard it with command -v rg and provide a grep or git grep fallback.
- For cleanup or deletion work, persist a changed-files inventory with statuses, active-reference evidence for deleted paths, and command summaries for final signoff.
- For cleanup or deletion work, start from .workflow-artifacts/generated/spec-agentworkforce-integrations-integration-tri/cleanup-candidate-prescan.txt and cite that exact path in .workflow-artifacts/generated/spec-agentworkforce-integrations-integration-tri/cleanup-report.md so the evidence trail names its prescan input.
- Keep each agent step bounded to one coherent slice. Split broad implementation or test-writing work into sequential/fan-out steps with deterministic gates between them instead of relying on a single long agent timeout.
