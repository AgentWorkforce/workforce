import { workflow } from '@agent-relay/sdk/workflows';
import { ClaudeModels, CodexModels } from '@agent-relay/config';

async function main() {
  const result = await workflow('workforce-fix-workload-router-persona-packaging')
    .description('Fix @agentworkforce/workload-router so its published package actually includes or resolves the persona data it imports at runtime, eliminating ERR_MODULE_NOT_FOUND for direct consumers like Agent Assistant SDK.')
    .pattern('supervisor')
    .channel('wf-workload-router-packaging-fix')
    .maxConcurrency(4)
    .timeout(5_400_000)

    .agent('lead-claude', {
      cli: 'claude',
      model: ClaudeModels.OPUS,
      role: 'Lead packaging-fix architect for workload-router, responsible for choosing the cleanest publish-safe strategy for persona resolution without breaking consumers.',
      retries: 1,
    })
    .agent('implementer-claude', {
      cli: 'claude',
      model: ClaudeModels.SONNET,
      preset: 'worker',
      role: 'Implements the workload-router packaging/export fix and adds the proof needed to show the package works after publish/install.',
      retries: 1,
    })
    .agent('review-codex', {
      cli: 'codex',
      model: CodexModels.GPT_5_4,
      preset: 'reviewer',
      role: 'Reviews the workload-router packaging fix for correctness, package hygiene, and install-time/runtime proof.',
      retries: 1,
    })

    .step('read-workload-router-context', {
      type: 'deterministic',
      command: [
        'echo "---WORKLOAD ROUTER PACKAGE JSON---"',
        'sed -n "1,220p" packages/workload-router/package.json',
        'echo "" && echo "---WORKLOAD ROUTER ENTRYPOINT---"',
        'sed -n "1,260p" packages/workload-router/src/index.ts',
        'echo "" && echo "---WORKLOAD ROUTER TESTS---"',
        'sed -n "1,260p" packages/workload-router/src/index.test.ts',
        'echo "" && echo "---PERSONAS TREE---"',
        'find personas -maxdepth 1 -type f | sort',
        'echo "" && echo "---ROUTING PROFILES TREE---"',
        'find packages/workload-router/routing-profiles -maxdepth 2 -type f | sort',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('define-packaging-fix-boundary', {
      agent: 'lead-claude',
      dependsOn: ['read-workload-router-context'],
      task: `Using the workload-router package context below, define the exact packaging fix boundary.

{{steps.read-workload-router-context.output}}

Write docs/workload-router-persona-packaging-fix-boundary.md.

The boundary doc must define:
1. whether personas should be bundled, copied into package files, or otherwise resolved canonically
2. what files/package.json fields must change
3. what tests/proof are required to show the installed package works after publish/install
4. what is out of scope

Hard constraints:
- optimize for correct published-package behavior
- do not leave runtime imports pointing at files that are not shipped
- keep the solution clean and maintainable

End with WORKLOAD_ROUTER_PACKAGING_FIX_BOUNDARY_READY.`,
      verification: { type: 'file_exists', value: 'docs/workload-router-persona-packaging-fix-boundary.md' },
    })

    .step('implement-packaging-fix', {
      agent: 'implementer-claude',
      dependsOn: ['define-packaging-fix-boundary'],
      task: `Implement the workload-router packaging fix.

Read and follow:
- docs/workload-router-persona-packaging-fix-boundary.md
- packages/workload-router/package.json
- packages/workload-router/src/index.ts
- packages/workload-router/src/index.test.ts

Requirements:
- fix the publish/install runtime problem cleanly
- update package metadata as needed
- add or update tests/proof for installed-package behavior
- do not print large file contents to stdout
- end your final summary with WORKLOAD_ROUTER_PACKAGING_FIX_READY`,
      verification: { type: 'file_exists', value: 'packages/workload-router/package.json' },
    })

    .step('run-packaging-proof', {
      type: 'deterministic',
      dependsOn: ['implement-packaging-fix'],
      command: [
        'cd packages/workload-router && npm test 2>&1',
        'cd packages/workload-router && npm pack --dry-run 2>&1',
        'echo "WORKLOAD_ROUTER_PACKAGING_PROOF_GREEN"',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('review-packaging-fix', {
      agent: 'review-codex',
      dependsOn: ['run-packaging-proof'],
      task: `Review the workload-router packaging fix.

Read:
- docs/workload-router-persona-packaging-fix-boundary.md
- changed workload-router files
- packaging proof output

Assess:
1. does the package now ship what it imports at runtime?
2. is the published-package/install story now credible?
3. is this ready for a Workforce PR?
4. is this PASS, PASS_WITH_FOLLOWUPS, or FAIL?

Write docs/workload-router-persona-packaging-fix-review-verdict.md.
End with WORKLOAD_ROUTER_PACKAGING_FIX_REVIEW_COMPLETE.`,
      verification: { type: 'file_exists', value: 'docs/workload-router-persona-packaging-fix-review-verdict.md' },
    })

    .step('verify-packaging-fix-artifacts', {
      type: 'deterministic',
      dependsOn: ['review-packaging-fix'],
      command: [
        'test -f docs/workload-router-persona-packaging-fix-boundary.md',
        'test -f docs/workload-router-persona-packaging-fix-review-verdict.md',
        'grep -q "WORKLOAD_ROUTER_PACKAGING_FIX_BOUNDARY_READY" docs/workload-router-persona-packaging-fix-boundary.md',
        'grep -q "WORKLOAD_ROUTER_PACKAGING_FIX_REVIEW_COMPLETE" docs/workload-router-persona-packaging-fix-review-verdict.md',
        'echo "WORKLOAD_ROUTER_PACKAGING_FIX_VERIFIED"',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .run({ cwd: process.cwd() });

  console.log(result.status);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
