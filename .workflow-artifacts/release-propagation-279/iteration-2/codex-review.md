# Codex adversarial review — workforce #279, iteration 2

VERDICT: FINDINGS

## Review target and scope

- Exact reviewed SHA: `af1bca99bf06b488f5c1b6f3098b1c9264426dea`.
- Draft PR: workforce #280, `codex/issue-279-bundle-versions` into `main`.
- Issue: workforce #279.
- Local `HEAD`, `origin/codex/issue-279-bundle-versions`, and PR `headRefOid` all matched the reviewed SHA. Base was `533b9669bcad1f06e31c8fa6644f7228e12fc510`.
- The worktree was clean before review. No repository `AGENTS.md` exists.
- PR remained open and draft. CI `check` was complete/successful at the reviewed head; CodeRabbit's status was successful but its draft-skip comment contained no substantive review.
- Review was read-only except for this required artifact. No source edit, commit, push, PR-state change, merge, publish, deploy, or production mutation was performed.

## Fresh implementation assessment

The iteration-1 symlink repair is real and correct for the defect it targets. `traceLogicalDependencyRoots` observes bare-package resolution during the same esbuild build, retains logical names plus canonical real package roots, and `buildBundleManifest` selects only metafile inputs with `bytesInOutput > 0`. Ownership is anchored at the traced package root, so a metadata-less workspace symlink can no longer walk upward into the author project or an unrelated ancestor.

The normal end-to-end path is also correctly wired:

1. The manifest is derived from the actual `agent.bundle.mjs` output contribution map, not author dependency declarations.
2. Distinct `(name, version)` pairs are deduplicated by the full pair and sorted deterministically, so duplicate installed versions survive.
3. The exact external `@agentworkforce/runtime` pin remains under `dependencies`; `bundleManifest` is embedded in the same generated `package.json`, so there is no sibling manifest that can independently go stale.
4. Sandbox upload includes that exact `package.json`; cloud launch parses the same file into `bundle.packageJson`.
5. Generated `runner.mjs` reads the adjacent `package.json` and passes the object unchanged to `startRunner`; `runner.started` emits it as structured evidence.

The new repair tests are meaningful, non-mocked filesystem/esbuild tests. They create real `node_modules` symlinks, bundle marker bytes, assert missing/malformed target metadata rejects without paths, prevent unrelated-ancestor attribution, recover after adding valid metadata, and retain a tree-shaken control. `git show af1bca9^..af1bca9` confirms those regressions and the ownership repair were added together; the prior report records the expected 230-pass/2-fail red run, while the current exact-head run is independently green.

## Finding

### WF279-CODEX-ITER2-001 — semantic-invalid package metadata is accepted and can serialize absolute/store paths

- Severity: HIGH
- Files: `packages/deploy/src/bundle.ts:403` and `packages/deploy/src/bundle.ts:413`; duplicated fallback validation at `packages/deploy/src/bundle.ts:434` and `packages/deploy/src/bundle.ts:440`.
- Contract contradicted: `README.md:194` promises exact resolved package versions and `README.md:196` promises no build-machine paths.
- Cause: both metadata readers accept any nonempty string as `name` and `version`. They do not validate an npm package name or an exact semantic version. Therefore malformed values such as ranges, workspace/file locators, or absolute pnpm-store paths are treated as valid provenance and are copied verbatim into the artifact and then `runner.started`.
- Real-esbuild reproduction at the reviewed SHA: a package imported as `bad-meta` had `{ "name": "bad-meta", "version": "/Users/reviewer/.pnpm/store/v3/files/secret" }` and contributed a marker to the actual bundle. Staging returned:

  ```json
  {"stage":"SUCCEEDED","manifest":{"schemaVersion":1,"packages":[{"name":"bad-meta","version":"/Users/reviewer/.pnpm/store/v3/files/secret"}]},"leakedAbsoluteStorePath":true}
  ```

- Impact: the manifest can cease to be an exact-version inventory and can leak a build-machine/store path through generated `package.json`, cloud/sandbox transport, and structured startup logs. This directly misses the requested fail-closed and path-free boundary.
- Required fix: validate package metadata semantically before accepting it. Require a valid npm package name and a valid exact semver (including legitimate prerelease/build metadata, excluding ranges and file/workspace/path locators). On failure, reject with the stable logical dependency name from the resolution boundary only; never echo the invalid metadata value or a filesystem path. Apply the same policy to both metadata-reading paths.
- Required regression: use the real `bundleStager`/esbuild path with contributing packages whose `name` and `version` are nonempty but invalid, including an absolute/pnpm-store-like version. Assert staging rejects with a package-name-only error and that neither the invalid value nor any temp/store path appears. Include a tree-shaken invalid-metadata control if semantic validation remains output-contribution-gated.

## Commands and deterministic evidence

- `git status --short --untracked-files=all; git rev-parse HEAD` — clean; exact SHA matched.
- `gh pr view 280 --json ...` and `gh issue view 279 --json ...` — reviewed PR body, files, comments, reviews, checks, and issue contract; PR head matched; CI green.
- `git diff origin/main...HEAD`, `git show af1bca9`, and numbered source inspection — reviewed the full implementation, repair, tests, runtime wiring, and transports.
- `pnpm --filter @agentworkforce/deploy test` — 233 passed, 0 failed. This includes real esbuild coverage for actual-output attribution, workspace/pnpm symlinks, repaired missing/malformed metadata boundaries, unrelated ancestors, tree shaking, duplicate versions, cloud transport, and sandbox transport.
- Real installed-graph probe against `packages/delivery/src/delivery.ts` — manifest was exactly `@relayfile/adapter-core@0.5.6`, `@relayfile/adapter-linear@0.4.6`, `@relayfile/relay-helpers@0.4.7`, and `@relayfile/sdk@0.7.40`; two stages produced byte-identical generated package JSON; no checkout, temp, `/.pnpm/`, or `node_modules/.pnpm` string appeared in it.
- Generated-runner probe with a real bundled `runner-probe@7.8.9` — runner exit 0; `package.json.bundleManifest` and structured `runner.started.bundleManifest` were JSON-identical; neither package JSON nor stdout contained the temp root.
- Semantic-invalid metadata probe — reproduced WF279-CODEX-ITER2-001 exactly as quoted above.
- `pnpm --filter @agentworkforce/runtime exec tsc -p tsconfig.json; node --test packages/runtime/dist/runner.test.js` — compiled; 13 passed, 0 failed.
- `git diff --check` — passed.
- Final `git status --short --untracked-files=all; git rev-parse HEAD; gh pr view 280 --json headRefOid,isDraft,state,statusCheckRollup` — source tree remained unchanged, SHA still exact, PR still draft/open, CI still green.

## Residual notes

- The repaired workspace-symlink ownership boundary passed both its focused real-esbuild regressions and a real installed pnpm graph.
- Manifest selection is tied to bundled output bytes rather than declarations; tree-shaken versionless metadata remains omitted as intended.
- Duplicate name/version identities, deterministic ordering, runtime pin preservation, cloud/sandbox package JSON transport, and generated-runner startup parity all passed.
- Embedding the manifest in generated `package.json` avoids an auxiliary-file synchronization problem; repository search found no second bundle-manifest artifact or transport source of truth.
- Fleet-wide `deployments list --json` queryability still depends on cloud persistence/response behavior and is not claimed by this PR.

## Final verdict

FINDINGS
