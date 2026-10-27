---
name: slack-relayfile-readdown-debugging
description: Use when inbound Slack content (channel messages, thread replies, or DMs) doesn't read down to local disk, or an integration-event preview says "Message unavailable" though the bytes may be on disk. Covers reading mount sync state, write-only-vs-mirror mounts, the bare-vs-suffixed channel-id drop, the preview two-shape gap, mount wedges, and the relayfile#262 backfill trap.
---

# Debugging Slack read-down failures (relayfile mount ↔ cloud fs/events)

You are diagnosing why inbound Slack content isn't materializing under the local mount (`~/.agentworkforce/pear/relayfile/workspaces/<ws>/slack/...`, mirrored to `.integrations/slack/...`). Localize to a layer, then prove it with the mount log / state file.

## First read the mount state

For `<mount>/.relay/`:
- **`mount.log`** launch line: `sync=mirror|write-only mode=poll`. `sync=write-only` ⇒ **zero read-down** (push only). `sync=mirror` ⇒ reads down + pushes. Steady `mount sync cycle completed` ≈ 30s healthy (or ~5min if websocket fell back to poll). Repeated `mount sync cycle failed: context deadline exceeded` with **0 completed** = a wedge. `restart fast-path: … skipping bootstrap full pull` ⇒ no full pull this launch.
- **`state.json`**: `syncMode`, `eventsCursor`/`lastEventAt` (null/null on a write-only mount that never read down), `files{}`, `pendingWriteback`.

## Symptom → root cause → fix

- **Top-level msgs and/or DMs don't read down, but THREAD replies do** → those mounts are `sync=write-only` while `threads` is `mirror`. Root: pear `integration-mounts.ts` `mountSpecsFor` made the dual-purpose command roots write-only with no read-down leg. **Fix:** set all Slack mounts to `syncMode:'mirror'` (mirror is a strict superset of write-only) — pear#170; needs a Pear rebuild+restart.
  - ⚠️ **relayfile#262 trap:** flipping write-only→mirror does NOT backfill already-missed messages. A write-only mount sets `BootstrapComplete=true` with no pull; on the mirror restart the fast-path seeds the cursor to the tip and skips the bootstrap full pull → only NEW messages read down. **Backfill = `clearState`** the mount (delete `.relay/`) before relaunch — but only if its outbound command dirs are clean (else re-dispatch risk).
- **Thread replies specifically don't read down (incremental); only a full pull recovers them** → **bare-vs-suffixed**: cloud's fs/events feed emitted the BARE channel id (`/slack/channels/<id>/threads/...`) while the mount root + fs/tree are SUFFIXED (`<id>__<slug>`). The Go daemon's `isUnderRemoteRoot` (`syncer.go`) is a pure literal-prefix match → bare-rooted events silently `continue`-dropped (no fetch/404/error). **Fix:** cloud emits the suffixed path at the fs/events source (cloud#2010) — deploys server-side, **no Pear restart**. Same class as the bridge fix pear#155/cloud#1995, one layer over.
- **File IS on disk with content, but the preview says "unavailable"** → a PREVIEW gap, not read-down. Two causes: (a) preview reader was SDK-read-only with no local-disk fallback + didn't translate bare→suffixed (pear#155/#163); (b) **two record shapes** — older/flat records have top-level `text`; newer wrap under `payload` (`payload.text`). A reader checking only one shape renders "unavailable" though bytes are present. **Read-down ≠ preview:** confirm by reading the file (handle BOTH shapes).
- **A mount wedges** (`context deadline exceeded`, 0 completed, no recovery) → pear#160: health poll force-restarted only on AUTH failures + read the wrong state path + timeout unset. Fix: generous `RELAYFILE_MOUNT_TIMEOUT` + a non-auth wedge / stalled-revision detector (`queueForcedRestart(path,…,{clearState:true})`). A wedged-but-alive mount child is NOT auto-respawned by electron — only an app restart respawns it.

## Fix-to-layer matching (don't cross wires)
- bare-vs-suffixed fs/events, record paths, DM D→U mapping = **cloud**, deploys without a Pear restart.
- mount `syncMode` / topology / health = **pear**, needs a rebuild+restart.
- `isUnderRemoteRoot` literal-prefix, write-only-skips-pull, restart fast-path = **relayfile Go daemon** (api.relayfile.dev is Cloud's TS worker, not this Go server).
