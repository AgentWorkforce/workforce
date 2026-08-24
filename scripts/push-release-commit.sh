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
# HEAD must be a single release commit with a parent. Callers that create
# several commits per run need a different shape and should not use this script.
#
# Env:
#   BRANCH         branch to push to (default: main)
#   PUSH_ATTEMPTS  how many pushes to make before giving up (default: 5)
#
set -euo pipefail

BRANCH="${BRANCH:-main}"
ATTEMPTS="${PUSH_ATTEMPTS:-5}"

for attempt in $(seq 1 "$ATTEMPTS"); do
  if git push origin "HEAD:refs/heads/$BRANCH"; then
    echo "Pushed the release commit to $BRANCH on attempt $attempt."
    exit 0
  fi

  # Every rebuild must get a push of its own, so stop rebuilding once the last
  # attempt has been spent rather than leaving a commit that never gets tried.
  if [ "$attempt" -eq "$ATTEMPTS" ]; then
    break
  fi

  echo "::warning::push to $BRANCH was rejected (attempt $attempt) - rebuilding the release commit on the current tip"
  REL=$(git rev-parse HEAD)
  if ! git rev-parse -q --verify "$REL^" >/dev/null; then
    echo "::error title=Release commit not pushed::HEAD has no parent, so there is no release commit to rebuild. Reconcile $BRANCH by hand." >&2
    exit 1
  fi
  MSG=$(git log -1 --format=%B "$REL")
  git fetch origin "$BRANCH"

  # Exactly the files this release commit changed, taken from its own diff.
  # A pattern over the tree would also pick up files the release never touched
  # and revert them — another package's version bumped by whatever landed on
  # the branch mid-run, say. `--diff-filter=d` drops paths the commit deleted,
  # which cannot be checked out of it.
  FILES=$(git diff --name-only --diff-filter=d "$REL^" "$REL")
  if [ -z "$FILES" ]; then
    echo "::error title=Release commit not pushed::The commit at HEAD adds or modifies no files. Packages may already be on npm; reconcile $BRANCH by hand." >&2
    exit 1
  fi

  git diff --name-only --diff-filter=D "$REL^" "$REL" |
    while read -r removed; do
      echo "::warning::$removed was deleted by the release commit; the rebuild does not re-apply that deletion"
    done

  # $FILES is deliberately unquoted below so it splits into one argument per
  # path. Release files are package.json / CHANGELOG.md paths with no spaces;
  # noglob keeps the shell from expanding any of them as a pattern.
  set -f

  # This run's copy of a file it owns overwrites the tip's. That is right for a
  # concurrent release commit and wrong for a hand-edited changelog, so name the
  # overlap instead of losing it silently.
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

echo "::error title=Release commit not pushed::Packages are on npm but $BRANCH could not be updated in $ATTEMPTS attempts. Reconcile the workspace versions on $BRANCH by hand." >&2
exit 1
