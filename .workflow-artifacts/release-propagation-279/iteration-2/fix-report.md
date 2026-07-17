# Review fix report: workforce #279 iteration 2

## Scope

- Finding repaired: `WF279-CODEX-ITER2-001` only.
- Starting repair head: `af1bca99bf06b488f5c1b6f3098b1c9264426dea`.
- Branch: `codex/issue-279-bundle-versions`; draft PR: #280.
- The iteration-2 review verdict artifact was read but not modified.
- No ready-for-review transition, merge, publish, release, deployment, or
  production mutation was performed.

## Red evidence

A real `bundleStager`/esbuild regression was added before the source repair. Its
contributing package is resolved through
`node_modules/@relayfile/path-poison`, and its `package.json` contains an
absolute pnpm-store-like path in `version`. The package exports marker bytes
that are retained in `agent.bundle.mjs`.

Exact command at the reviewed head plus only the new regression:

```bash
pnpm --filter @agentworkforce/deploy exec tsc -p tsconfig.json && node --test --test-name-pattern='absolute store path' packages/deploy/dist/bundle.test.js
```

Observed result before the implementation change:

```text
tests 1; pass 0; fail 1
AssertionError [ERR_ASSERTION]: Missing expected rejection.
```

This proves the real stager accepted the unsafe non-version metadata before the
repair.

## Repair

Both package-metadata ownership paths now use one semantic policy:

- `validate-npm-package-name` requires a name valid for new npm packages;
- `node-semver` parses the version, after which the parsed identifiers are
  reconstructed and compared with the original string to require canonical,
  exact SemVer rather than a range or compatibility spelling;
- valid prerelease and build metadata such as
  `2.3.4-rc.1+build.20260717` is retained verbatim;
- arbitrary strings, ranges, workspace/file/npm locators, URLs, POSIX and
  Windows path forms, surrounding whitespace, control characters, and invalid
  prerelease/build identifiers are rejected;
- the rejection uses the stable logical dependency name and metadata field
  only. The invalid value and filesystem path are never interpolated.

The implementation leaves the prior logical-root/symlink ownership trace
unchanged. Output contribution remains gated by esbuild's
`bytesInOutput > 0`, so invalid metadata in a fully tree-shaken dependency is
not reported. Deduplication still keys the full `(name, version)` pair, and the
existing duplicate-version, workspace symlink, and pnpm graph regressions are
unchanged and passing.

The absolute-path regression additionally proves that rejected metadata does
not produce a generated `package.json` or `runner.mjs`, and that the emitted
bundle itself contains neither the unsafe value nor the temp root. Therefore
the unsafe value cannot enter `bundleManifest` or `runner.started` telemetry.

## Green regression evidence

Exact focused command after the repair:

```bash
pnpm --filter @agentworkforce/deploy exec tsc -p tsconfig.json && node --test --test-name-pattern='absolute store path|non-version package metadata|invalid metadata name|valid metadata for a dependency removed|actual bundled package versions' packages/deploy/dist/bundle.test.js
```

Observed result:

```text
tests 5; pass 5; fail 0
```

The focused tests cover the absolute/store path, the invalid-version matrix,
the logical-name-only error, the second filesystem ownership path, valid
prerelease/build metadata, and a tree-shaken invalid-metadata control.

## Full verification evidence

```bash
pnpm --filter @agentworkforce/deploy test
```

```text
tests 236; pass 236; fail 0
```

This includes the existing real-esbuild workspace/pnpm symlink tests and the
distinct `@relayfile/adapter-core@0.5.1` plus `@0.5.6` regression.

```bash
pnpm --filter @agentworkforce/runtime exec tsc -p tsconfig.json && node --test packages/runtime/dist/runner.test.js
```

```text
tests 13; pass 13; fail 0
```

The runner suite includes structured `runner.started.bundleManifest` evidence.

```bash
pnpm run build
pnpm run lint
pnpm run typecheck
git diff --check
```

```text
build: passed for 19 of 20 workspace projects
lint: passed for 19 of 20 workspace projects
typecheck: passed for 19 of 20 workspace projects and examples/tsconfig.json
git diff --check: passed
```

## Real installed relay graph probe

The built stager was exercised twice against the repository's actual
`packages/delivery/src/delivery.ts` entry and installed pnpm dependency graph.
The exact command was:

```bash
node --input-type=module -e 'import { mkdtemp, readFile, rm } from "node:fs/promises"; import os from "node:os"; import path from "node:path"; import { bundleStager } from "./packages/deploy/dist/bundle.js"; const root = await mkdtemp(path.join(os.tmpdir(), "wf279-installed-graph-")); try { const entry = path.resolve("packages/delivery/src/delivery.ts"); const persona = { id: "installed-relay-graph-probe", intent: "probe", tags: [], description: "probe", skills: [], harness: "claude", model: "anthropic/claude-3-5-sonnet", systemPrompt: "probe", harnessSettings: { reasoning: "medium", timeoutSeconds: 300 }, cloud: true, onEvent: entry }; const first = await bundleStager.stage({ personaPath: path.join(root, "persona.json"), persona, outDir: path.join(root, "first") }); const second = await bundleStager.stage({ personaPath: path.join(root, "persona.json"), persona, outDir: path.join(root, "second") }); const firstSource = await readFile(first.packageJsonPath, "utf8"); const secondSource = await readFile(second.packageJsonPath, "utf8"); const manifest = JSON.parse(firstSource).bundleManifest; const expected = [{ name: "@relayfile/adapter-core", version: "0.5.6" }, { name: "@relayfile/adapter-linear", version: "0.4.6" }, { name: "@relayfile/relay-helpers", version: "0.4.7" }, { name: "@relayfile/sdk", version: "0.7.40" }]; if (JSON.stringify(manifest.packages) !== JSON.stringify(expected)) throw new Error(`unexpected manifest: ${JSON.stringify(manifest)}`); const forbidden = [process.cwd(), root, "/.pnpm/", "node_modules/.pnpm"]; if (firstSource !== secondSource) throw new Error("generated package JSON is nondeterministic"); if (forbidden.some((value) => firstSource.includes(value))) throw new Error("generated package JSON leaked a filesystem path"); console.log(JSON.stringify({ manifest, deterministicPackageJson: true, pathFree: true })); } finally { await rm(root, { recursive: true, force: true }); }'
```

Observed manifest:

```json
{"schemaVersion":1,"packages":[{"name":"@relayfile/adapter-core","version":"0.5.6"},{"name":"@relayfile/adapter-linear","version":"0.4.6"},{"name":"@relayfile/relay-helpers","version":"0.4.7"},{"name":"@relayfile/sdk","version":"0.7.40"}]}
```

The two generated package JSON files were byte-identical and contained no
checkout root, temp root, `/.pnpm/`, or `node_modules/.pnpm` string.

## Changed files

- `packages/deploy/src/bundle.ts`
- `packages/deploy/src/bundle.test.ts`
- `packages/deploy/package.json`
- `pnpm-lock.yaml`
- `.workflow-artifacts/release-propagation-279/iteration-2/fix-report.md`
