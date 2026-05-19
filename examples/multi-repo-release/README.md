# multi-repo-release

Demonstrates a **multi-root mount persona**: one launch sees two repos
side-by-side (`./api/` and `./web/`) under a single sandbox.

## Run it

```sh
export ACME_API_DIR=~/work/acme-api
export ACME_WEB_DIR=~/work/acme-web

agentworkforce agent multi-repo-release
```

The harness starts with `cwd = <session>/mount/` and sees:

```
mount/
  api/    ← readonly mirror of $ACME_API_DIR
  web/    ← read-write mirror of $ACME_WEB_DIR
```

Edits inside `web/` sync back to `$ACME_WEB_DIR` when the session ends.
Edits inside `api/` are dropped (the root is `readonly: true`).

## Why multi-root?

`mount.roots` is **opt-in**. Personas that omit the field keep the
existing single-root cwd-mount behavior — they mount whatever directory
the CLI was invoked from. Multi-root suits cross-repo coordinators
(release bots, migration agents, monorepo bridges) where the right
"cwd" is a virtual workspace, not any one repo.

Paths use `$VAR` / `${VAR}` references resolved against the persona's
`inputs` and the caller's environment, so the persona JSON stays
portable across teammates' checkouts.

The `readonly` flag short-circuits relayfile's readonly handling for
the entire root — the agent can read but its writes don't sync back.
Per-root `ignoredPatterns` / `readonlyPatterns` extend the
persona-wide patterns when finer control is needed.

Mark a root `optional: true` if it's allowed to be absent — the
launcher silently drops missing optional roots and only fails when
no roots resolved at all.
