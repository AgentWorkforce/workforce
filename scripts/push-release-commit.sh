#!/usr/bin/env bash
#
# Push the release commit at HEAD to $BRANCH, rebuilding it on the branch tip
# if the push is rejected.
#
# Publish workflows run this *after* the packages are already on npm, so a
# rejected push is the worst failure available: the registry moves ahead of git
# and the next run bumps from a version the branch has never seen. That is what
# happened on 2026-08-24 (run 32713237250), when a queued second publish run
# built from a stale dispatch SHA and lost the push race with the run ahead of
# it. Anything landing on the branch mid-run does this — a merged PR, another
# release commit — so reconcile instead of failing.
#
# HEAD must be a single release commit. Callers that create several commits per
# run need a different shape and should not use this script.
#
# Env:
#   BRANCH      branch to push to (default: main)
#   RELEASE_RE  regex matching the files the release commit owns
#
set -euo pipefail

BRANCH="${BRANCH:-main}"

# The files a release commit owns. Matched with a regex over the full tree
# listing rather than a git pathspec: `git ls-tree` does not glob, and quietly
# returns a short list instead of erroring — which would rebuild the release
# commit with no version bumps in it.
RELEASE_RE="${RELEASE_RE:-^(packages/[^/]+/(package\.json|CHANGELOG\.md)|CHANGELOG\.md)\$}"

for attempt in 1 2 3 4 5; do
  if git push origin "HEAD:refs/heads/$BRANCH"; then
    echo "Pushed the release commit to $BRANCH on attempt $attempt."
    exit 0
  fi

  echo "::warning::push to $BRANCH was rejected (attempt $attempt) - rebuilding the release commit on the current tip"
  REL=$(git rev-parse HEAD)
  MSG=$(git log -1 --format=%B "$REL")
  git fetch origin "$BRANCH"

  # Re-apply only files present in BOTH trees: `git checkout` with a
  # path that is missing from either side aborts under `set -e`, and
  # this is the one code path that must not die. Intersecting also
  # avoids resurrecting a file the newer tip deleted.
  FILES=$(comm -12 \
    <(git ls-tree -r --name-only "$REL" | grep -E "$RELEASE_RE" | sort) \
    <(git ls-tree -r --name-only "origin/$BRANCH" | grep -E "$RELEASE_RE" | sort))
  if [ -z "$FILES" ]; then
    echo "::error title=Release commit not pushed::None of this run's release files exist on $BRANCH. Packages are on npm; reconcile $BRANCH by hand." >&2
    exit 1
  fi

  # $FILES is deliberately unquoted below so it splits into one
  # argument per path; every path is a literal package.json or
  # CHANGELOG.md, so there is nothing to split on but newlines.
  # noglob keeps the shell from expanding them as patterns.
  set -f

  # Our copy of a release file overwrites the tip's. That is right for
  # a concurrent release commit and wrong for a hand-edited changelog,
  # so say which files it applies to instead of losing them silently.
  git diff --name-only "$REL^" "origin/$BRANCH" -- $FILES |
    while read -r changed; do
      echo "::warning::$changed also changed on $BRANCH during this run - this run's copy wins"
    done

  git reset --hard "origin/$BRANCH"
  git checkout "$REL" -- $FILES
  git add -- $FILES
  set +f
  if git diff --cached --quiet; then
    echo "$BRANCH already carries this run's release files; nothing to push."
    exit 0
  fi
  git commit -m "$MSG"
  sleep $((attempt * 5))
done

echo "::error title=Release commit not pushed::Packages are on npm but $BRANCH could not be updated after 5 attempts. Reconcile the workspace versions on $BRANCH by hand." >&2
exit 1
