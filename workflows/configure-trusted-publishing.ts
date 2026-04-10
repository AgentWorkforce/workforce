/**
 * Configure OIDC trusted npm publishing for all publishable packages.
 *
 * Uses the npm-provenance-publisher persona (resolved via the workload-router
 * SDK) to update the existing .github/workflows/publish.yml, replacing the
 * long-lived NPM_TOKEN secret with GitHub Actions OIDC trusted publishing.
 *
 * The workflow:
 *   1. Builds the workload-router SDK so persona resolution works at runtime.
 *   2. Materializes and installs the persona's skills via prpm.
 *   3. Reads the current publish.yml and package.json for context.
 *   4. Has the npm-provenance-publisher agent rewrite publish.yml for OIDC.
 *   5. Verifies the output meets security requirements.
 *   6. Runs `pnpm run check` as a final gate.
 *
 * Run with:
 *   agent-relay run --dry-run workflows/configure-trusted-publishing.ts
 *   agent-relay run          workflows/configure-trusted-publishing.ts
 */

const { workflow } = require('@agent-relay/sdk/workflows');

async function main() {
  const result = await workflow('configure-trusted-publishing')
    .description(
      'Rewrite publish.yml to use OIDC trusted npm publishing with provenance for @agentworkforce/workload-router.'
    )
    .pattern('dag')
    .channel('wf-configure-trusted-publishing')
    .maxConcurrency(4)
    .timeout(3_600_000)

    .agent('publisher', {
      cli: 'opencode',
      preset: 'worker',
      role: 'npm trusted publishing implementer',
      retries: 2
    })
    .agent('checker', {
      cli: 'codex',
      preset: 'worker',
      role: 'Runs pnpm run check and reports failures verbatim',
      retries: 1
    })

    // --- Build the SDK so materializeSkills is callable at runtime ----------

    .step('install-deps', {
      type: 'deterministic',
      command: 'corepack pnpm install',
      failOnError: true
    })

    .step('build-sdk', {
      type: 'deterministic',
      dependsOn: ['install-deps'],
      command: 'corepack pnpm --filter @agentworkforce/workload-router run build',
      failOnError: true
    })

    // --- Derive + execute the prpm install plan from the persona ------------

    .step('plan-skills', {
      type: 'deterministic',
      dependsOn: ['build-sdk'],
      command: [
        'node',
        '-e',
        [
          "const {resolvePersona, materializeSkillsFor} = require('./packages/workload-router/dist/index.js');",
          "const plan = materializeSkillsFor(resolvePersona('npm-provenance'));",
          'for (const install of plan.installs) {',
          "  process.stdout.write(install.installCommand.join(' ') + '\\n');",
          '}'
        ].join(' ')
      ]
        .map((arg) => `'${arg.replace(/'/g, "'\\''")}'`)
        .join(' '),
      captureOutput: true,
      failOnError: true
    })

    .step('install-skills', {
      type: 'deterministic',
      dependsOn: ['plan-skills'],
      command: [
        'node',
        '-e',
        [
          "const {spawnSync} = require('child_process');",
          "const {resolvePersona, materializeSkillsFor} = require('./packages/workload-router/dist/index.js');",
          "const plan = materializeSkillsFor(resolvePersona('npm-provenance'));",
          'for (const install of plan.installs) {',
          "  console.log('[install]', install.skillId, '->', install.installedManifest);",
          "  const r = spawnSync(install.installCommand[0], install.installCommand.slice(1), {stdio: 'inherit'});",
          '  if (r.status !== 0) process.exit(r.status || 1);',
          '}'
        ].join(' ')
      ]
        .map((arg) => `'${arg.replace(/'/g, "'\\''")}'`)
        .join(' '),
      failOnError: true
    })

    .step('verify-skill-installed', {
      type: 'deterministic',
      dependsOn: ['install-skills'],
      command:
        '(test -d .opencode/skills/npm-trusted-publishing || test -d .opencode/skill/npm-trusted-publishing) && echo "OK" || (echo "SKILL MISSING" >&2; exit 1)',
      failOnError: true
    })

    // --- Read inputs needed by the publisher agent --------------------------

    .step('read-publish-yml', {
      type: 'deterministic',
      command: 'cat .github/workflows/publish.yml',
      captureOutput: true,
      failOnError: true
    })

    .step('read-router-pkg', {
      type: 'deterministic',
      command: 'cat packages/workload-router/package.json',
      captureOutput: true,
      failOnError: true
    })

    // --- Apply the installed skill to rewrite publish.yml -------------------

    .step('rewrite-publish-workflow', {
      agent: 'publisher',
      dependsOn: ['verify-skill-installed', 'read-publish-yml', 'read-router-pkg'],
      task: `Apply the @prpm/npm-trusted-publishing skill (already installed at .opencode/skills/npm-trusted-publishing/) to convert the existing publish workflow to OIDC trusted publishing.

Current .github/workflows/publish.yml:
{{steps.read-publish-yml.output}}

Current packages/workload-router/package.json:
{{steps.read-router-pkg.output}}

Rewrite .github/workflows/publish.yml in-place with these requirements:

1. REMOVE all NODE_AUTH_TOKEN / NPM_TOKEN secret references. OIDC only — no long-lived tokens.
2. Keep the existing workflow_dispatch trigger with version, tag, and dry_run inputs.
3. Job permissions MUST include: id-token: write, contents: write (contents: write is needed for the git tag + push step).
4. Add a step that runs 'npm install -g npm@latest' BEFORE the publish step to avoid stale-runner OIDC auth failures.
5. The publish step must run 'npm publish --provenance --access public --tag \${{ github.event.inputs.tag }}' with working-directory: packages/workload-router.
6. Keep all existing steps that are still needed: checkout, setup-node (with registry-url https://registry.npmjs.org), pnpm setup, install, build, test, version bump, commit, tag + push, summary.
7. The dry-run publish step should also NOT use NODE_AUTH_TOKEN.
8. Ensure packages/workload-router/package.json has repository.url set to https://github.com/AgentWorkforce/workforce. If already present, leave it alone.

IMPORTANT: Write the updated file to disk at .github/workflows/publish.yml. Only modify this file and optionally packages/workload-router/package.json. Do NOT touch any other file.`,
      verification: { type: 'exit_code' },
      retries: 2
    })

    // --- Verify the rewritten workflow meets security requirements ----------

    .step('verify-no-npm-token', {
      type: 'deterministic',
      dependsOn: ['rewrite-publish-workflow'],
      command:
        'if grep -q "NPM_TOKEN\\|NODE_AUTH_TOKEN" .github/workflows/publish.yml; then echo "FAIL: publish.yml still references NPM_TOKEN or NODE_AUTH_TOKEN" >&2; exit 1; fi; echo "OK: no token secrets found"',
      failOnError: true
    })

    .step('verify-oidc-permissions', {
      type: 'deterministic',
      dependsOn: ['rewrite-publish-workflow'],
      command:
        'grep -q "id-token: write" .github/workflows/publish.yml && echo "OK: id-token: write present" || (echo "FAIL: missing id-token: write permission" >&2; exit 1)',
      failOnError: true
    })

    .step('verify-provenance-flag', {
      type: 'deterministic',
      dependsOn: ['rewrite-publish-workflow'],
      command:
        'grep -q -- "--provenance" .github/workflows/publish.yml && echo "OK: --provenance flag present" || (echo "FAIL: missing --provenance flag" >&2; exit 1)',
      failOnError: true
    })

    .step('verify-npm-upgrade', {
      type: 'deterministic',
      dependsOn: ['rewrite-publish-workflow'],
      command:
        'grep -q "npm install -g npm@latest" .github/workflows/publish.yml && echo "OK: npm upgrade step present" || (echo "FAIL: missing npm install -g npm@latest step" >&2; exit 1)',
      failOnError: true
    })

    .step('verify-repository-url', {
      type: 'deterministic',
      dependsOn: ['rewrite-publish-workflow'],
      command:
        "node -e \"const p=require('./packages/workload-router/package.json');if(!p.repository||!p.repository.url){console.error('repository.url missing');process.exit(1)}console.log('OK:', p.repository.url)\"",
      failOnError: true
    })

    // --- Final guardrail ----------------------------------------------------

    .step('check', {
      agent: 'checker',
      dependsOn: [
        'verify-no-npm-token',
        'verify-oidc-permissions',
        'verify-provenance-flag',
        'verify-npm-upgrade',
        'verify-repository-url'
      ],
      task: 'Run `corepack pnpm run check` from the repo root. Report the full stderr/stdout of any failing command verbatim. Do not attempt fixes; just report. If everything passes, print the final "check" summary.',
      verification: { type: 'exit_code' }
    })

    .step('git-diff', {
      type: 'deterministic',
      dependsOn: ['check'],
      command: 'git diff .github/workflows/publish.yml',
      captureOutput: true,
      failOnError: false
    })

    .onError('fail-fast')
    .run({ cwd: process.cwd() });

  console.log('Result:', result.status);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
