# Independent final review: workforce #279 / PR #280

## Verdict

**FINDINGS**

Reviewed exact head:

```text
76d4a7f75c1b0b99453ce7e891bea9c3dfd2f84f
```

This review is independent of the earlier Codex PASS artifact. I did not use
that verdict as evidence. No source, commit, PR state, deployment, publication,
or production state was changed. The only repository write from this review is
this iteration-4 artifact. The pre-existing untracked iteration-3 review was
left untouched.

No `AGENTS.md` exists in this repository checkout or its AgentWorkforce parent,
so there was no repository-local instruction file to apply.

## Severity-ranked findings

### HIGH — WF279-CODEX-INDEPENDENT-001

**Consumer-project metadata is validated before the consumer owner is excluded,
so legitimate private author projects can no longer be deployed.**

Location: `packages/deploy/src/bundle.ts:296` (ordering relative to the consumer
root exclusion at `packages/deploy/src/bundle.ts:304`).

`buildBundleManifest` intentionally computes `entryOwner` so the author/consumer
package is not reported as a bundled dependency. However, each contributing
owner's `invalidMetadata` is thrown at lines 296-303 before line 304 skips the
owner whose root equals `entryOwner.root`. The entry file itself is a
contributing esbuild input, so an author `package.json` with a missing version,
a private/workspace-style version, or a noncanonical name rejects the whole
stage even though that package must not enter `bundleManifest`.

Independent real-esbuild reproduction used a valid contributing
`safe-dep@1.2.3` and changed only the consumer project metadata:

```json
{
  "missingVersion": {
    "status": "error",
    "message": "bundle: bundled package \"private-author-app\" has no valid \"version\" metadata"
  },
  "noncanonicalVersion": {
    "status": "error",
    "message": "bundle: bundled package \"private-author-app\" has no valid \"version\" metadata"
  },
  "invalidName": {
    "status": "error",
    "message": "bundle: bundled dependency package has no valid \"name\" metadata"
  },
  "noAuthorPackageJsonControl": {
    "status": "ok",
    "manifest": {
      "schemaVersion": 1,
      "packages": [{ "name": "safe-dep", "version": "1.2.3" }]
    }
  }
}
```

The missing-version case is valid and common for private, unpublished Node
applications. This change therefore introduces a deploy denial unrelated to
the safety of any bundled dependency. It is release-blocking compatibility
risk in the core staging path.

Recommended repair: exclude `owner.root === entryOwner?.root` before evaluating
that owner's invalid metadata, while retaining fail-closed validation for all
other contributing owners. Add a real-esbuild regression whose consumer has a
private/versionless or otherwise non-package metadata file and whose valid
dependency still produces exactly `safe-dep@1.2.3`. Re-run the metadata-less
workspace regression to prove the target still cannot climb to consumer
metadata.

## Independent validation evidence

### Reviewed contract and current PR state

- Read issue #279, the full `main...HEAD` diff, PR body, commits, files, checks,
  review summaries, issue comments, and inline review comments.
- Read the iteration-1 implementation and repair report and the iteration-2 fix
  report as implementation claims to verify, not as signoff evidence.
- PR head and local `HEAD` both equal the exact SHA above.
- GitHub CI `check` is successful; CodeRabbit's status is successful but its
  review was skipped because the PR is draft. There are no inline review
  comments. The Gemini summary targets the older `3a1fc1e` head and was not used
  as evidence.
- GitHub currently reports `mergeable=false`, `mergeable_state=dirty`, even
  though its reported base `533b9669bcad1f06e31c8fa6644f7228e12fc510`
  equals local `main`, is the merge-base, and is a direct ancestor of the
  reviewed head. That external status inconsistency was recorded but is not the
  source-code finding above.

### Previously repaired HIGH class: metadata-less workspace target

Code inspection confirmed that bare-package resolution records the canonical
real package root and that `findDependencyPackageOwnership` reads metadata only
at that root. It does not walk from a metadata-less symlink target to consumer
or unrelated ancestor metadata. Errors use the logical package name only.

The current real-esbuild focused run passed the workspace missing/malformed
metadata, unrelated ancestor, valid recovery, tree-shaken control, pnpm/workspace
symlink, duplicate-version, and unsafe metadata cases:

```text
tests 9; pass 9; fail 0
```

The fixture's dependency bytes are retained in `agent.bundle.mjs`, so this is
not an eager declaration scan or a synthetic metafile test.

### Previously repaired HIGH class: unsafe/noncanonical metadata

Both metadata ownership readers call the same `isValidPackageName` and
`isExactPackageVersion` predicates. The former requires a name valid for new
npm packages. The latter parses with node-semver and reconstructs the canonical
major/minor/patch, prerelease, and build spelling before exact string comparison.
There is no semantic divergence between the two readers' validation policy.

An independent real-esbuild matrix exercised both logical `node_modules`
ownership and relative/direct filesystem ownership. It rejected 52 cases in
total, covering POSIX/Windows absolute and store paths, URLs, `npm:`, `file:`,
and `workspace:` protocols, ranges, wildcard forms, leading `v`/`=`, leading or
trailing whitespace, control characters, invalid names/scopes/casing, leading
zeroes, and invalid prerelease identifiers. Every rejection used the stable
logical name/field or generic dependency label, not the unsafe value or temp
root:

```json
{"ownershipPaths":2,"rejected":52,"canonicalAccepted":2}
```

Both paths accepted the canonical scoped name `@scope/canonical-name` with the
exact version `2.3.4-rc.1+build.20260717` unchanged.

The readers do have the compatibility problem described in the HIGH finding:
their shared strict policy is incorrectly applied to the consumer entry owner
before that owner is excluded.

### Attribution, duplicates, symlinks, determinism, and path freedom

- `buildBundleManifest` selects only metafile inputs with
  `bytesInOutput > 0`; the tree-shaken invalid-metadata control passes.
- Deduplication keys the complete `(name, version)` pair, preserving both
  `@relayfile/adapter-core@0.5.1` and `@0.5.6`; deterministic sorting is by name
  then version.
- Workspace and pnpm symlink fixtures pass through real esbuild resolution.
- An independent two-run probe against the installed
  `packages/delivery/src/delivery.ts` graph retained actual delivery input bytes
  and produced byte-identical generated package JSON with no checkout root,
  temp root, `/.pnpm/`, or `node_modules/.pnpm` string:

```json
{
  "schemaVersion": 1,
  "packages": [
    { "name": "@relayfile/adapter-core", "version": "0.5.6" },
    { "name": "@relayfile/adapter-linear", "version": "0.4.6" },
    { "name": "@relayfile/relay-helpers", "version": "0.4.7" },
    { "name": "@relayfile/sdk", "version": "0.7.40" }
  ]
}
```

### Artifact transport and runner parity

- The staged generated `package.json` keeps the exact installed
  `@agentworkforce/runtime` dependency and embeds `bundleManifest`.
- Cloud transport reads that same file and sends the parsed object as
  `bundle.packageJson` (`packages/deploy/src/modes/cloud/index.ts:185`).
- Both direct and proxy sandbox transport upload that exact file as
  `/home/daytona/bundle/package.json`
  (`packages/deploy/src/modes/sandbox-client.ts:269-277`).
- The generated runner reads `packageJson.bundleManifest` and passes the same
  object to `startRunner`; runtime adds that object unchanged to the structured
  `runner.started` attributes (`packages/runtime/src/runner.ts:152-159`).
- Cloud transport, sandbox transport, generated-runner wiring, and exact
  `runner.started` parity assertions all pass in the focused/full suites.

## Gates rerun on the exact head

Host: Node `v25.8.1`, pnpm `10.17.1`.

```text
pnpm --filter @agentworkforce/deploy test
tests 236; pass 236; fail 0

pnpm --filter @agentworkforce/runtime exec tsc -p tsconfig.json &&
node --test packages/runtime/dist/runner.test.js
tests 13; pass 13; fail 0

pnpm run build
passed (19 of 20 workspace projects)

pnpm run lint
passed (19 of 20 workspace projects)

pnpm run typecheck
passed (19 of 20 workspace projects plus examples)

git diff --check
passed
```

The green existing suites do not cover invalid metadata on the consumer entry
owner, which is why they do not catch WF279-CODEX-INDEPENDENT-001.

## Final signoff

**FINDINGS** at `76d4a7f75c1b0b99453ce7e891bea9c3dfd2f84f`.

The two previously repaired HIGH safety classes validate successfully, as do
the requested graph attribution, version/name validation, duplicate, symlink,
determinism, transport, runtime parity, and workspace gates. The new HIGH
consumer-metadata compatibility regression must be repaired and independently
revalidated before final PASS.
