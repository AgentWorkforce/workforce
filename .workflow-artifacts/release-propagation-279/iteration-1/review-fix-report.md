# Review fix report: workforce #279 iteration 1

## Scope

- Finding repaired: `WF279-SHADOW-001` only.
- Branch: `codex/issue-279-bundle-versions`.
- Draft PR: #280.
- Starting repair head: `3a1fc1eae2572f2c240ba20e4848318e581595d3`.
- No ready-for-review transition, merge, publish, release, or deployment was performed.

## Real-esbuild reproduction

A red regression was added before the implementation change. Its author project
has a valid `package.json`, imports `missing-workspace` through a real
`node_modules/missing-workspace` symlink, and points that symlink at an
in-project `packages/missing-workspace/index.js` containing a bundled marker but
no target `package.json`.

The first run of:

```bash
pnpm --filter @agentworkforce/deploy test
```

reproduced the pushed-head defect with real esbuild: both new staging assertions
reported `Missing expected rejection`. The suite result was 230 passed and 2
failed. The first fixture therefore staged bundled marker bytes without failing
closed; the analogous fixture also accepted a metadata-less target below a
different valid ancestor package.

The completed regression now proves all of the following through the real
`bundleStager` and esbuild:

- a metadata-less in-project workspace target rejects with only the stable
  logical package name;
- malformed target JSON rejects with the same path-free package-only error;
- neither the author project path, symlink target path, nor unrelated ancestor
  label appears in the error;
- an unrelated valid ancestor is never accepted as the dependency owner;
- adding a valid target manifest produces exactly
  `missing-workspace@2.4.6`, and the output still contains the marker bytes;
- a versionless dependency removed from the actual output remains omitted
  rather than becoming an eagerly reported package.

## Repair

`packages/deploy/src/bundle.ts` now traces bare-package resolution during the
normal esbuild build. This retains each logical `node_modules` package name and
its canonical real package root without enabling esbuild's preserve-symlinks
mode, so pnpm's realpath-based transitive resolution behavior is unchanged.

Manifest ownership checks use the longest matching traced real root and read
metadata only at that package root. Dependency ownership never walks upward
from a symlink target into the consumer or another ancestor. Missing,
malformed, nameless, or versionless contributing package metadata fails closed
with a deterministic package-name-only error. Malformed metadata that prevents
esbuild resolution is normalized through the same path-free error surface.

The existing metafile `bytesInOutput > 0` filter, full `(name, version)`
deduplication, deterministic sorting, runtime pin, embedded manifest transport,
and runner wiring are unchanged.

## Changed files

- `packages/deploy/src/bundle.ts` — retain logical dependency boundaries across
  esbuild realpath resolution and anchor metadata at the dependency root.
- `packages/deploy/src/bundle.test.ts` — add real-esbuild missing/malformed
  workspace-target, unrelated-ancestor, valid-recovery, and tree-shaken control
  regressions.
- `.workflow-artifacts/release-propagation-279/iteration-1/codex-shadow-review.md`
  — adversarial review input supplied for this repair.
- `.workflow-artifacts/release-propagation-279/iteration-1/review-fix-report.md`
  — this reproduction and verification record.

## Exact verification evidence

```text
pnpm --filter @agentworkforce/deploy test
tests 233; pass 233; fail 0

pnpm run build
19 of 20 workspace projects; passed

pnpm run lint
19 of 20 workspace projects; passed

pnpm run typecheck
19 of 20 workspace projects plus examples/tsconfig.json; passed

git diff --check
passed
```

The built stager was also exercised against the repository's real
`packages/delivery/src/delivery.ts` installed graph after the repair. It emitted
the same deterministic, path-free manifest as the original implementation:

```json
{"schemaVersion":1,"packages":[{"name":"@relayfile/adapter-core","version":"0.5.6"},{"name":"@relayfile/adapter-linear","version":"0.4.6"},{"name":"@relayfile/relay-helpers","version":"0.4.7"},{"name":"@relayfile/sdk","version":"0.7.40"}]}
```

This preserves duplicate-version, workspace/pnpm symlink, deterministic-order,
path-redaction, cloud/sandbox transport, and runner-manifest parity coverage in
the passing deploy suite.
