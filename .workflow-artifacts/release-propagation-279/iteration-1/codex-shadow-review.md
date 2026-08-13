# Codex adversarial shadow review — workforce #279

VERDICT: FINDINGS

## Review state

Final adversarial review completed against draft PR #280 head `3a1fc1eae2572f2c240ba20e4848318e581595d3`. The principal implementation is correctly wired and its normal, duplicate-version, pnpm, valid-workspace-symlink, transport, and runtime-log paths are proven. One fail-closed edge remains incorrect and prevents comprehensive satisfaction.

## Root cause established from the baseline

`packages/deploy/src/bundle.ts` asks esbuild to bundle the persona handler and externalizes only Node builtins plus `@agentworkforce/runtime` and `@agentworkforce/runtime/raw`. Consequently, third-party and transitive package source that reaches the output is frozen into `agent.bundle.mjs`. The staged `package.json`, however, is built independently from esbuild's resolved graph and contains only the separately installed external runtime version. Neither `BundleResult`, the generated runner, sandbox upload, cloud request, `runner.started`, nor the deployments-list JSON surface carries an inventory of the package code actually inlined into the artifact.

This creates two distinct facts that the baseline conflates or omits:

1. `dependencies.@agentworkforce/runtime` describes code intentionally external to `agent.bundle.mjs` and installed at execution time.
2. Bundled-package attribution must describe package-owned inputs that contributed bytes to the actual esbuild output, including transitives and possibly multiple versions of the same package name.

An author dependency range or the repository lockfile alone cannot prove either fact for an already-staged artifact. Restarting the runner cannot change inlined bytes, and publishing a newer upstream dependency cannot propagate without a new resolution and bundle.

## Risky assumptions to disprove

- **Requested/imported is not actually bundled.** Metafile inputs that are fully tree-shaken, external imports, or packages used only by the external runtime must not be reported as inlined code. Evidence should be tied to the output contribution (`bytesInOutput > 0` or an equally strong graph fact), not to `package.json` declarations.
- **Direct is not complete.** The manifest must include transitive package inputs that contribute code, not only the persona's direct dependencies or a hard-coded `@relayfile/*` allowlist.
- **One name does not imply one version.** Nested dependency graphs can bundle two versions of the same package. A name-to-single-version object risks false attribution or last-write-wins nondeterminism; the schema and logs must preserve distinct `(name, version)` identities.
- **Filesystem path is not operator evidence.** pnpm's content-addressed `.pnpm` layout, symlinked workspaces, nested `node_modules`, scoped packages, conditional exports, and realpath-vs-symlink paths must resolve to the package manifest that owns each bundled input. Absolute source paths, pnpm store paths, user names, temp roots, and symlink targets must never enter generated metadata or logs.
- **Nearest manifest is not automatically the owner.** An upward package.json search must stop at defensible package boundaries and verify a valid name/version; it must not accidentally attribute persona-local source to the workspace root, a parent application, or a neighboring package.
- **Workspace version can overclaim provenance.** A workspace package's `package.json` version may label unpublished or locally modified source. If workspace packages are inventoried, the field must remain explicitly a resolved package version, not a claim that the bytes equal the published npm artifact.
- **Missing metadata must not become a lie.** Package-owned bundled code whose manifest is absent, unreadable, invalid, or has no name/version needs a deterministic, tested policy (fail closed or explicit unresolved evidence). Silently omitting it while describing the list as complete is unsafe.
- **Object traversal order is not a contract.** Manifest and log ordering must be explicitly sorted and stable across identical builds, platforms, symlink layouts, and repeated runs.
- **An auxiliary file can go stale or disappear.** The stager deliberately leaves auxiliary files from prior runs untouched; sandbox upload currently names exactly four files; cloud upload serializes only runner, agent, and package JSON. Any sibling manifest must be overwritten, represented in `BundleResult`, uploaded in every mode, and protected from stale residue. Embedding metadata in the already-uploaded package JSON avoids some, but not all, stale-artifact risks.
- **Runtime logging must describe this artifact.** `runner.started` must receive immutable metadata from the staged artifact/runner, not re-resolve the current filesystem or read the author project at cold start. It must remain structured, deterministic, bounded, and free of paths, environment values, tokens, source-map contents, or other secrets.
- **Presence in a staged file is not fleet queryability.** `--bundle-out` makes local package JSON queryable, but deployed fleet queryability requires cloud persistence/response wiring or another supported JSON surface. If cloud changes are outside this repository/iteration, that limitation must be explicit rather than implied complete.
- **Unit mocks can erase the defect.** Tests that replace `BundleStager`, feed a hand-written package JSON, or assert only a mocked cloud POST do not prove the real esbuild graph. Required proof must stage a real bundle from a realistic installed/package layout, inspect the emitted JS and metadata together, exercise transitive and workspace/symlink cases, and show the runtime's actual `runner.started` record.

## Deterministic baseline evidence

- Review base and HEAD before implementation: `533b9669bcad1f06e31c8fa6644f7228e12fc510`; `git diff origin/main...HEAD` was empty.
- Issue #279 states that a deployed artifact inlines `@relayfile/relay-helpers` and `@relayfile/adapter-core`, while generated package JSON pins only `@agentworkforce/runtime`.
- Baseline `packages/deploy/src/bundle.ts` calls esbuild without `metafile: true`, writes only `agent.bundle.mjs`, `runner.mjs`, `persona.json`, and `package.json`, and resolves only the external runtime version.
- Baseline `packages/runtime/src/runner.ts` logs `runner.started` with persona, workspace, schedules, triggers, and integrations only.
- Baseline sandbox upload enumerates exactly those four staged files. Baseline cloud upload includes runner source, agent source, and parsed package JSON; deployments-list parsing exposes no bundle inventory.
- Lockfile evidence illustrates why graph attribution matters: the workspace contains both `@relayfile/adapter-core@0.5.1` and transitive `@relayfile/adapter-core@0.5.6`; a single version inferred from a direct declaration would be false for some bundle graphs.

## End-to-end wiring assessment

The main path is end-to-end wired:

1. esbuild emits a metafile and the stager selects only input entries with `bytesInOutput > 0` for `agent.bundle.mjs`.
2. Valid package owners become a deterministic array of distinct `(name, version)` pairs. Deduplication uses the full pair, so `@relayfile/adapter-core@0.5.1` and `@relayfile/adapter-core@0.5.6` coexist.
3. The generated `package.json` retains the exact external `@agentworkforce/runtime` pin and embeds the path-free `bundleManifest` as the sole persisted source of truth.
4. The generated runner reads that exact object from its adjacent package JSON and passes it to `startRunner`; `runner.started` emits it unchanged.
5. Sandbox transport uploads the package JSON and cloud transport places the parsed package JSON under `bundle.packageJson`. Local operators can query a staged artifact with `jq .bundleManifest <bundle-dir>/package.json`.

Fleet-wide `deployments list --json` queryability still depends on cloud persistence/response work and is explicitly not claimed. That limitation is acceptable under the iteration's “artifact or supported JSON surface” acceptance wording, but it remains an operational follow-up.

The missing-metadata workspace-symlink path breaks the otherwise correct build step: logical dependency identity is erased by `realpath()` before ownership is determined, allowing bundled dependency bytes to be silently omitted from the manifest.

## Findings

### WF279-SHADOW-001 — workspace symlink without its own package metadata is silently omitted

- Severity: HIGH
- File: `packages/deploy/src/bundle.ts` (`findPackageOwnership`, `findPackageOwnershipFromDirectory`, and the `entryOwner` exclusion in `buildBundleManifest`)
- Issue: Ownership discovery immediately realpaths each esbuild input. For a logical `node_modules/missing-workspace` symlink whose target is inside the author project and lacks `package.json`, the search walks from the real target into the author project's package manifest. That owner equals `entryOwner`, so the contributing dependency input is skipped. The bundle contains the dependency bytes while `bundleManifest.packages` is empty. A target beneath a different ancestor package can analogously be falsely attributed to that ancestor. This contradicts the implementation report's fail-closed claim and acceptance focus #5.
- Deterministic reproduction: Create an author project with `{name:"author-project",version:"1.0.0"}`, symlink `node_modules/missing-workspace` to `packages/missing-workspace`, omit a package manifest at the target, import its exported marker from the agent, and stage with the real built `bundleStager`. Observed output at pushed head: `{"stage":"SUCCEEDED","manifest":{"schemaVersion":1,"packages":[]},"bundleContainsMarker":true,"leaksPath":false}`.
- Exact fix: Preserve the logical esbuild input path alongside its realpath. Detect and retain the logical `node_modules` package boundary before dereferencing symlinks; require that dependency boundary/target to supply its own valid package name and version, and never walk above that package root into the consumer or an unrelated ancestor. Continue using real roots for deduplication/cache identity and keep all failure messages path-free.
- Required test: Add a real `bundleStager`/esbuild regression with an author-project package manifest and a `node_modules` workspace symlink to an in-project target that has code but no `package.json`. Assert staging rejects, the error contains a stable inferred dependency label but no temp/absolute path, and the same fixture succeeds with the correct `(name, version)` only after a valid target manifest is added. Add the analogous protection against attribution to a different valid ancestor package.

## Deterministic final evidence

- Exact review target: local `HEAD`, branch remote, and PR #280 `headRefOid` all resolved to `3a1fc1eae2572f2c240ba20e4848318e581595d3`; base was `533b9669bcad1f06e31c8fa6644f7228e12fc510`.
- Scope diff contains only the two iteration artifacts, README/changelogs, deploy bundle/tests/transport tests, and runtime runner/tests. The reviewer artifact is the only additional untracked file.
- `pnpm --filter @agentworkforce/deploy test`: 230 passed, 0 failed. These include real esbuild fixtures for output-only attribution, unused declaration exclusion, deterministic sorting, valid workspace and pnpm symlinks, versionless metadata rejection, and simultaneous `@relayfile/adapter-core@0.5.1` plus `@0.5.6` representation.
- `node --test packages/runtime/dist/runner.test.js`: 13 passed, 0 failed.
- `git diff --check`: passed.
- Real repository graph probe using `packages/delivery/src/index.ts`: emitted `@relayfile/adapter-core@0.5.6`, `@relayfile/adapter-linear@0.4.6`, `@relayfile/relay-helpers@0.4.7`, and `@relayfile/sdk@0.7.40`; retained runtime `4.1.26`; left no external `@relayfile/*` imports; serialized no working-directory path.
- Actual generated-runner probe: staged a real `shadow-probe@7.8.9` package, executed generated `runner.mjs`, observed exit 0, and confirmed byte-for-byte JSON parity between `package.json.bundleManifest` and the structured `runner.started.bundleManifest`; stdout/artifact metadata contained no temp root.
- Adversarial missing-metadata workspace-symlink probe reproduced WF279-SHADOW-001 exactly as documented above.
- PR #280 remained draft. CI `check` was in progress at review time. CodeRabbit's draft-skip notice is informational only and provides no substantive review evidence.

## Scope-matrix status

- `workforce` #279: draft PR #280 delivered at `3a1fc1e`; main wiring is complete, but WF279-SHADOW-001 requires repair and regression proof.
- `relayfile-adapters` #248: deferred dependency-only context; no changes authorized in this iteration.
- `cloud` #2678: deferred; no changes authorized in this iteration.

## Remaining risks

- Until WF279-SHADOW-001 is fixed, a workspace-linked dependency with absent metadata can ship bundled bytes with no corresponding manifest entry or can inherit an unrelated ancestor identity.
- The manifest records a workspace package's declared resolved version, not proof that locally modified bytes match the published artifact; README correctly states this limitation.
- Fleet-wide version queries remain unavailable until the cloud service persists and returns `bundle.packageJson.bundleManifest`; this workforce iteration provides artifact and startup-log queryability only.
- CI completion was not yet available at the review timestamp and must be rechecked before any readiness decision.
