/**
 * Finish the "add skills to personas + npm-provenance persona" task.
 *
 * Long-term fix for skill materialization: the workflow does NOT hard-code
 * `prpm install` commands. Instead it builds the workload-router SDK, asks it
 * to derive a harness-correct install plan from the persona via
 * `materializeSkillsFor(resolvePersona('npm-provenance'))`, and executes that
 * plan. Persona edits (adding skills, switching tiers, changing harnesses)
 * automatically flow through here — no grep-and-replace needed.
 *
 * Remaining work after the in-conversation SDK edits + README updates:
 *   1. Build the workload-router SDK so the install plan can be computed.
 *   2. Materialize and install the persona's skills via prpm (harness-aware).
 *   3. Apply the installed prpm/npm-trusted-publishing skill to create
 *      .github/workflows/publish-workload-router.yml for
 *      @agentworkforce/workload-router.
 *   4. Run `pnpm run check` as the final verification gate.
 *
 * Run with:
 *   agent-relay run --dry-run workflows/finish-npm-provenance-persona.ts
 *   agent-relay run          workflows/finish-npm-provenance-persona.ts
 */

const { workflow } = require('@agent-relay/sdk/workflows');

async function main() {
  const result = await workflow('finish-npm-provenance-persona')
    .description(
      'Materialize persona skills via prpm and configure OIDC trusted publishing for workload-router.'
    )
    .pattern('dag')
    .channel('wf-finish-npm-provenance-persona')
    .maxConcurrency(4)
    .timeout(3_600_000)

    .agent('publisher', {
      cli: 'claude',
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
      command: 'corepack pnpm install --frozen-lockfile',
      failOnError: true
    })

    .step('build-sdk', {
      type: 'deterministic',
      dependsOn: ['install-deps'],
      command: 'corepack pnpm --filter @agentworkforce/workload-router run build',
      failOnError: true
    })

    // --- Derive + execute the prpm install plan from the persona ------------
    //
    // Uses the SDK's materializeSkillsFor() so the workflow stays harness-
    // agnostic. If the persona ever moves from codex to claude (or declares
    // a new skill), this step re-derives the correct `prpm install --as <x>`
    // command automatically.

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
      // The npm-provenance persona uses opencode at best-value, so prpm
      // lands the skill under .skills/. Derive the path from the
      // SDK's HARNESS_SKILL_TARGETS if the persona ever changes harness.
      command:
        '(test -d .skills/npm-trusted-publishing || test -d .skills/npm-trusted-publishing) && echo "OK" || (echo "SKILL MISSING" >&2; exit 1)',
      failOnError: true
    })

    // --- Read inputs needed by the publisher agent --------------------------

    .step('read-router-pkg', {
      type: 'deterministic',
      command: 'cat packages/workload-router/package.json',
      captureOutput: true,
      failOnError: true
    })

    // --- Apply the installed skill to configure trusted publishing ----------

    .step('create-publish-workflow', {
      agent: 'publisher',
      dependsOn: ['verify-skill-installed', 'read-router-pkg'],
      task: `Apply the @prpm/npm-trusted-publishing skill (already installed at .skills/npm-trusted-publishing/) to configure OIDC trusted publishing for @agentworkforce/workload-router.

Current packages/workload-router/package.json:
{{steps.read-router-pkg.output}}

Create a new file: .github/workflows/publish-workload-router.yml

Requirements:
- Trigger on release published and on workflow_dispatch.
- Job permissions MUST include: id-token: write, contents: read.
- Steps: checkout, setup-node with registry-url https://registry.npmjs.org, corepack enable, pnpm install --frozen-lockfile, build workload-router, run 'npm install -g npm@latest' inside packages/workload-router to avoid stale-runner OIDC auth failures, then 'npm publish --provenance --access public' with cwd packages/workload-router.
- Do NOT use NODE_AUTH_TOKEN / NPM_TOKEN secrets. OIDC only.

Also ensure packages/workload-router/package.json has a repository.url field pointing at the GitHub repo (https://github.com/AgentWorkforce/workforce). If missing, add it; otherwise leave the file alone.

IMPORTANT: Write files to disk. Only create .github/workflows/publish-workload-router.yml and optionally edit packages/workload-router/package.json. Do NOT output to stdout. Do NOT touch any other file.`,
      verification: { type: 'exit_code' },
      retries: 2
    })

    .step('verify-publish-workflow', {
      type: 'deterministic',
      dependsOn: ['create-publish-workflow'],
      command:
        'test -f .github/workflows/publish-workload-router.yml && grep -q "id-token: write" .github/workflows/publish-workload-router.yml && grep -q -- "--provenance" .github/workflows/publish-workload-router.yml && echo "OK"',
      failOnError: true
    })

    .step('verify-repository-url', {
      type: 'deterministic',
      dependsOn: ['create-publish-workflow'],
      command:
        'node -e "const p=require(\'./packages/workload-router/package.json\');if(!p.repository||!p.repository.url){console.error(\'repository.url missing\');process.exit(1)}console.log(p.repository.url)"',
      failOnError: true
    })

    // --- Final guardrail ----------------------------------------------------

    .step('check', {
      agent: 'checker',
      dependsOn: ['verify-publish-workflow', 'verify-repository-url'],
      task: `Run \`corepack pnpm run check\` from the repo root. Report the full stderr/stdout of any failing command verbatim. Do not attempt fixes; just report. If everything passes, print the final "check" summary.`,
      verification: { type: 'exit_code' }
    })

    .step('git-status', {
      type: 'deterministic',
      dependsOn: ['check'],
      command: 'git status --short && git diff --stat',
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
