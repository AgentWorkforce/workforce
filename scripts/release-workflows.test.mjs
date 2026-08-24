import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const publishWorkflow = readFileSync('.github/workflows/publish.yml', 'utf8');
const verifyWorkflow = readFileSync('.github/workflows/verify-publish.yml', 'utf8');
const personaWorkflow = readFileSync('.github/workflows/publish-persona.yml', 'utf8');
const internalPersonaWorkflow = readFileSync(
  '.github/workflows/publish-internal-personas.yml',
  'utf8'
);

function publishTargetDirectories(workflow) {
  const match = workflow.match(/echo "packages=([^"]+)"/);
  assert.ok(match, 'publish workflow must declare its package targets');

  return match[1].trim().split(/\s+/);
}

function publishPackageNames(workflow = publishWorkflow) {
  return publishTargetDirectories(workflow).map((directory) => {
    const packageJson = JSON.parse(readFileSync(`packages/${directory}/package.json`, 'utf8'));
    return packageJson.name;
  });
}

function verifyPackageChoices(workflow = verifyWorkflow) {
  const lines = workflow.replaceAll('\r\n', '\n').split('\n');
  const packageInput = lines.findIndex((line) => line === '      package:');
  assert.notEqual(packageInput, -1, 'verify workflow must declare the package input');

  const options = lines.findIndex(
    (line, index) => index > packageInput && line === '        options:'
  );
  assert.notEqual(options, -1, 'verify package input must declare choices');

  const choices = [];
  for (const line of lines.slice(options + 1)) {
    const match = line.match(/^          - '([^']+)'$/);
    if (!match) break;
    choices.push(match[1]);
  }
  return choices;
}

test('Verify Publish exposes every lockstep package exactly once', () => {
  const published = publishPackageNames();
  const verified = verifyPackageChoices();

  assert.equal(new Set(published).size, published.length, 'publish targets must be unique');
  assert.equal(new Set(verified).size, verified.length, 'verify choices must be unique');
  assert.deepEqual(verified, published);
});

test('release workflow parsing tolerates CRLF and target whitespace', () => {
  assert.deepEqual(publishTargetDirectories('echo "packages=  events persona-kit  "'), [
    'events',
    'persona-kit',
  ]);
  assert.deepEqual(
    verifyPackageChoices(verifyWorkflow.replaceAll('\n', '\r\n')),
    verifyPackageChoices()
  );
});

test('scoped CLI verification checks only the supported thin-entry contract', () => {
  const match = verifyWorkflow.match(
    /- name: Scoped CLI package smoke test([\s\S]*?)\n      - name: Library smoke test/
  );
  assert.ok(match, 'scoped CLI smoke step must exist');

  const step = match[1];
  assert.match(step, /assert\.equal\(pkg\.name, '@agentworkforce\/cli'\)/);
  assert.match(step, /assert\.equal\(pkg\.version, '\$\{\{ steps\.resolve\.outputs\.version \}\}'\)/);
  assert.match(step, /assert\.equal\(pkg\.bin, undefined\)/);
  assert.match(step, /@agentworkforce\/cli\/dist\/cli\.js/);
  assert.match(step, /assert\.equal\(typeof mod\.main, 'function'\)/);
  assert.doesNotMatch(step, /CLI_VERSION|cli-impl/);
});

/**
 * Publish workflows push their release commit *after* the packages are on npm,
 * so a rejected push leaves the registry ahead of git — which is what happened
 * on 2026-08-24 (run 32713237250). These tests run the real shared script
 * against throwaway git repos that replay that shape.
 */
const pushScript = 'scripts/push-release-commit.sh';

function stepScript(workflow, name) {
  const lines = workflow.replaceAll('\r\n', '\n').split('\n');
  const start = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  assert.notEqual(start, -1, `workflow must define a "${name}" step`);

  const next = lines.findIndex((line, index) => index > start && /^\s*- name: /.test(line));
  const stepLines = lines.slice(start, next === -1 ? lines.length : next);
  const runIndex = stepLines.findIndex((line) => /^\s+run: \|\s*$/.test(line));
  assert.notEqual(runIndex, -1, `"${name}" must carry a literal run block`);

  const body = stepLines.slice(runIndex + 1);
  const indent = body.find((line) => line.trim())?.match(/^\s*/)[0] ?? '';
  return body.map((line) => (line.startsWith(indent) ? line.slice(indent.length) : line)).join('\n');
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'release-test',
  GIT_AUTHOR_EMAIL: 'release-test@example.com',
  GIT_COMMITTER_NAME: 'release-test',
  GIT_COMMITTER_EMAIL: 'release-test@example.com',
};

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
}

/** Temp repos are throwaway, but leaving a pile of them in tmpdir is rude. */
function cleanup(...paths) {
  for (const path of paths) rmSync(path, { recursive: true, force: true });
}

function writeVersions(dir, version) {
  for (const pkg of ['cli', 'deploy']) {
    mkdirSync(join(dir, 'packages', pkg), { recursive: true });
    writeFileSync(join(dir, 'packages', pkg, 'package.json'), `{"version":"${version}"}\n`);
    writeFileSync(join(dir, 'packages', pkg, 'CHANGELOG.md'), `## ${version}\n`);
  }
  writeFileSync(join(dir, 'CHANGELOG.md'), `## ${version}\n`);
}

/** A bare origin at 4.1.47, plus a clone whose HEAD bumps it to 4.1.49. */
function stageRelease() {
  const root = mkdtempSync(join(tmpdir(), 'publish-push-'));
  const origin = join(root, 'origin.git');
  // -b main: the clones take their branch from the bare repo's HEAD, and a
  // runner whose init.defaultBranch is `master` would otherwise track a ref
  // these tests never push.
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);

  const seed = join(root, 'seed');
  git(root, 'clone', '-q', origin, seed);
  writeVersions(seed, '4.1.47');
  writeFileSync(join(seed, 'packages', 'cli', 'source.ts'), 'export const x = 1;\n');
  // A package this release does not bump, present in both trees — the shape
  // that separates "files this commit changed" from "files matching a pattern".
  mkdirSync(join(seed, 'packages', 'other'), { recursive: true });
  writeFileSync(join(seed, 'packages', 'other', 'package.json'), '{"version":"4.1.47"}\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-qm', 'base 4.1.47');
  git(seed, 'push', '-q', 'origin', 'HEAD:refs/heads/main');

  const run = join(root, 'run');
  git(root, 'clone', '-q', origin, run);
  writeVersions(run, '4.1.49');
  git(run, 'add', '-A');
  git(run, 'commit', '-qm', 'chore(release): @scope/cli@4.1.49 @scope/deploy@4.1.49');

  return { root, seed, run };
}

function runPushStep(cwd, env = {}) {
  // /bin/bash, not the PATH bash: the runner's is 5.x but macOS ships 3.2,
  // so this also pins the script to portable syntax.
  return execFileSync('/bin/bash', [resolve(pushScript)], {
    cwd,
    encoding: 'utf8',
    env: { ...GIT_ENV, BRANCH: 'main', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function versionOnMain(seed, pkg) {
  git(seed, 'fetch', '-q', 'origin');
  return JSON.parse(git(seed, 'show', `origin/main:packages/${pkg}/package.json`)).version;
}

test('release commit pushes unchanged when the branch has not moved', () => {
  const { seed, run } = stageRelease();
  const output = runPushStep(run);

  assert.match(output, /on attempt 1/);
  assert.equal(versionOnMain(seed, 'cli'), '4.1.49');
});

test('release commit is rebuilt on the tip when the branch moved mid-run', () => {
  const { seed, run } = stageRelease();

  // Another publish run's release commit, then a PR merging mid-run.
  writeVersions(seed, '4.1.48');
  git(seed, 'commit', '-qam', 'chore(release): @scope/cli@4.1.48 @scope/deploy@4.1.48');
  writeFileSync(join(seed, 'packages', 'cli', 'source.ts'), 'export const x = 2;\n');
  git(seed, 'commit', '-qam', 'feat: merged mid-run');
  git(seed, 'push', '-q', 'origin', 'HEAD:refs/heads/main');

  const output = runPushStep(run);
  assert.match(output, /on attempt 2/);

  // Every bumped package lands — not just the ones a short file list caught.
  assert.equal(versionOnMain(seed, 'cli'), '4.1.49');
  assert.equal(versionOnMain(seed, 'deploy'), '4.1.49');

  // The mid-run merge survives, and the overwritten release files are named.
  assert.equal(git(seed, 'show', 'origin/main:packages/cli/source.ts'), 'export const x = 2;\n');
  assert.match(output, /packages\/cli\/package\.json also changed on main/);

  const history = git(seed, 'log', '--format=%s', 'origin/main');
  assert.match(history, /@scope\/cli@4\.1\.49/);
  assert.match(history, /@scope\/cli@4\.1\.48/);
  assert.match(history, /feat: merged mid-run/);
});

test('rebuilding leaves files the release commit never touched alone', () => {
  const { seed, run } = stageRelease();

  // A concurrent release bumps a package that this run's release commit left
  // untouched — e.g. the lockstep workflow landing while a persona run retries.
  writeFileSync(join(seed, 'packages', 'other', 'package.json'), '{"version":"9.9.9"}\n');
  git(seed, 'commit', '-qam', 'chore(release): @scope/other@9.9.9');
  git(seed, 'push', '-q', 'origin', 'HEAD:refs/heads/main');

  runPushStep(run);

  // A pattern over the tree would have reverted this to the release commit's
  // base; only the files the release commit actually changed may move.
  assert.equal(versionOnMain(seed, 'other'), '9.9.9');
  assert.equal(versionOnMain(seed, 'cli'), '4.1.49');
});

test('exhausted attempts fail loudly instead of stranding a rebuilt commit', () => {
  const { seed, run } = stageRelease();

  writeVersions(seed, '4.1.48');
  git(seed, 'commit', '-qam', 'chore(release): @scope/cli@4.1.48 @scope/deploy@4.1.48');
  git(seed, 'push', '-q', 'origin', 'HEAD:refs/heads/main');

  const tipBefore = git(seed, 'rev-parse', 'origin/main').trim();
  const releaseBefore = git(run, 'rev-parse', 'HEAD').trim();
  assert.throws(
    () => runPushStep(run, { PUSH_ATTEMPTS: '1' }),
    /Release commit not pushed/,
    'a spent attempt budget must surface, not exit clean'
  );

  git(seed, 'fetch', '-q', 'origin');
  assert.equal(git(seed, 'rev-parse', 'origin/main').trim(), tipBefore, 'branch must be untouched');
  // No rebuild on the last attempt: rebuilding one that can never be pushed
  // burns the release commit and leaves the checkout disagreeing with the
  // "reconcile by hand" the error message asks for.
  assert.equal(git(run, 'rev-parse', 'HEAD').trim(), releaseBefore);
});

test('a non-branch target is refused before anything is pushed', () => {
  const { root, seed, run } = stageRelease();
  try {
    // What a tag dispatch produces: github.ref_name is the tag, not a branch.
    git(seed, 'tag', '-a', 'v9.9.9', '-m', 'a tag');
    git(seed, 'push', '-q', 'origin', 'refs/tags/v9.9.9');
    git(run, 'fetch', '-q', 'origin');

    assert.throws(
      () => runPushStep(run, { BRANCH: 'v9.9.9' }),
      /not an existing branch on origin/,
      'pushing HEAD to refs/heads/<tag> would invent a branch named after the tag'
    );
    git(seed, 'fetch', '-q', 'origin');
    assert.throws(
      () => git(seed, 'rev-parse', '--verify', 'origin/v9.9.9'),
      'no branch may be created for the tag'
    );
  } finally {
    cleanup(root);
  }
});

test('release commit is a no-op when the branch already carries its files', () => {
  const { seed, run } = stageRelease();

  // Same release files, different commit — a re-dispatched run that got there
  // first. The differing message keeps the SHAs apart; identical content and
  // timestamps would otherwise produce the same commit and fast-forward.
  writeVersions(seed, '4.1.49');
  git(seed, 'commit', '-qam', 'chore(release): 4.1.49 from an earlier dispatch');
  git(seed, 'push', '-q', 'origin', 'HEAD:refs/heads/main');

  const output = runPushStep(run);
  assert.match(output, /nothing to push/);
  assert.equal(versionOnMain(seed, 'cli'), '4.1.49');
});

// Every workflow that publishes to npm and then updates git. `push` names the
// step that lands the release commit; each must reconcile, and must tag only
// after that commit is on the branch.
for (const [name, workflow, push] of [
  ['publish.yml', publishWorkflow, 'Push release commit'],
  ['publish-persona.yml', personaWorkflow, 'Push release commit'],
  ['publish-internal-personas.yml', internalPersonaWorkflow, 'Commit + push release'],
]) {
  test(`${name} pushes the release commit before tagging it`, () => {
    const lines = workflow.split('\n');
    const pushStep = lines.findIndex((line) => line.trim() === `- name: ${push}`);
    const tag = lines.findIndex((line) => line.trim() === '- name: Tag + push tags');
    assert.notEqual(pushStep, -1, 'must reconcile its push');
    assert.notEqual(tag, -1, 'must tag in its own step');
    assert.ok(pushStep < tag, 'tagging before the push can strand tags on an unreachable commit');
    assert.ok(workflow.includes(pushScript), 'must use the shared reconciling push script');
    assert.ok(
      !/git push origin HEAD --follow-tags/.test(workflow),
      'the unreconciled push is what left npm ahead of git on 2026-08-24'
    );
  });

  test(`${name} refuses a dispatch that is not from a branch`, () => {
    const lines = workflow.split('\n');
    const guard = lines.findIndex((line) => line.trim() === '- name: Require a branch dispatch');
    assert.notEqual(guard, -1, 'a tag dispatch would push the release commit to refs/heads/<tag>');
    const firstStep = lines.findIndex((line) => /^\s*- name: /.test(line));
    assert.equal(guard, firstStep, 'the guard must run before anything is published');
    assert.match(workflow, /if: \$\{\{ github\.ref_type != 'branch' \}\}/);
  });

  test(`${name} checks out the branch tip, not the dispatch SHA`, () => {
    assert.match(
      workflow,
      /fetch-depth: 0\n(\s+#.*\n)*\s+ref: \$\{\{ github\.ref_name \}\}/,
      'a queued run built from the pinned dispatch SHA bumps from a stale base'
    );
  });
}

/**
 * publish-internal-personas.yml used to commit and tag once per persona inside
 * its publish loop, which cannot be reconciled onto a branch that moved. It now
 * stages every bump and makes one release commit after the loop; this exercises
 * that step against a staged index rather than trusting the YAML to read right.
 */
test('internal personas make a single release commit for every pack', () => {
  const root = mkdtempSync(join(tmpdir(), 'persona-release-'));
  git(root, 'init', '-q', '-b', 'main', root);

  for (const [dir, version] of [['persona-a', '1.2.3'], ['persona-b', '4.5.6']]) {
    mkdirSync(join(root, 'packages', dir), { recursive: true });
    writeFileSync(join(root, 'packages', dir, 'package.json'), `{"version":"${version}"}\n`);
  }
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'base');

  // What the publish loop leaves behind: bumped manifests, staged, uncommitted.
  writeFileSync(join(root, 'packages', 'persona-a', 'package.json'), '{"version":"1.2.4"}\n');
  writeFileSync(join(root, 'packages', 'persona-b', 'package.json'), '{"version":"4.5.7"}\n');
  git(root, 'add', '-A');
  writeFileSync(
    '/tmp/persona-publish-targets.tsv',
    '@scope/persona-a\tpackages/persona-a\t1.2.4\n@scope/persona-b\tpackages/persona-b\t4.5.7\n'
  );

  // The step ends by delegating the push; stub it so the test stays local.
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'push-release-commit.sh'), '#!/bin/sh\ntouch pushed.marker\n');
  execFileSync('chmod', ['+x', join(root, 'scripts', 'push-release-commit.sh')]);

  const script = join(root, 'commit-step.sh');
  writeFileSync(script, stepScript(internalPersonaWorkflow, 'Commit + push release'));
  execFileSync('/bin/bash', [script], { cwd: root, encoding: 'utf8', env: GIT_ENV });

  const subjects = git(root, 'log', '--format=%s').trim().split('\n');
  assert.equal(subjects.length, 2, 'one release commit on top of the base, not one per pack');
  assert.equal(subjects[0], 'chore(release): @scope/persona-a@1.2.4 @scope/persona-b@4.5.7');
  assert.ok(readdirSync(root).includes('pushed.marker'), 'must delegate to the push script');

  cleanup(root, '/tmp/persona-publish-targets.tsv');
});
