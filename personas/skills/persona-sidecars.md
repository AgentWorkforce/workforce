---
name: persona-sidecars
description: When to use claudeMd/agentsMd (path) vs claudeMdContent/agentsMdContent (inline) sidecar fields — the silent-footgun distinction the dry-run does NOT catch
---

# Persona sidecar fields — path vs inline

A persona's heavy operating spec belongs in a sidecar markdown file, not in `systemPrompt`. The harness auto-loads `CLAUDE.md` (claude) or `AGENTS.md` (codex / opencode) from the session cwd on startup, so the CLI stages the sidecar there before launch.

## Four fields, two pairs

| Field | Type | What it holds |
|-------|------|---------------|
| `claudeMd` | path | Relative path (from the persona JSON's directory) to a sibling `.md` file |
| `claudeMdContent` | string | Inline markdown body as a literal string |
| `agentsMd` | path | Relative path to a sibling `.md` file |
| `agentsMdContent` | string | Inline markdown body as a literal string |

`claudeMd` / `claudeMdContent` are claude-only. `agentsMd` / `agentsMdContent` are codex + opencode.

## These are NOT interchangeable

Pick ONE shape per persona:

- **Separate sidecar file** → `"claudeMd": "./my-persona.md"`
- **Inlined body** → `"claudeMdContent": "# My Persona\n\n..."`

Putting a file path string into a `*MdContent` field stores that path verbatim as the entire body of `CLAUDE.md` / `AGENTS.md` at session start. The agent's operating spec becomes one line of garbage that looks like a filename. The agent then has no idea what its job is.

## The dry-run does NOT catch this

The validator only checks that the field is a non-empty string, not whether the string is real markdown content. A persona with `"claudeMdContent": "my-persona.md"` will:

- Dry-run green (`✓ sidecar: CLAUDE.md`)
- Stage a CLAUDE.md whose body is the literal text `my-persona.md`
- Boot the harness with no operational spec

This is one of the most expensive footguns in workforce because failure is silent.

## Which to use

- **Local personas** (authored under `.agentworkforce/workforce/personas/<id>.json` in a user repo) typically use the **path form**. The `.md` sidecar lives next to the JSON; you can edit it as a real markdown file instead of escaping a long string into JSON.
- **Built-in personas** (under workforce's own `/personas` catalog) use the **inline form** because the catalog build inlines the sibling `.md` at compile time so the published package ships only the bundled JSON.

## Mode

Both pairs accept an optional `claudeMdMode` / `agentsMdMode` of `"overwrite"` (default) or `"extend"`. Use `"extend"` when the persona's spec should append to a user-supplied CLAUDE.md/AGENTS.md already in the cwd rather than replacing it.

## Quick checklist before declaring a sidecar

- [ ] Authoring a local persona with a separate `.md` file? → use `claudeMd` / `agentsMd` (path form).
- [ ] Authoring a built-in for the workforce catalog? → use `claudeMdContent` / `agentsMdContent` (inline form, generator handles it).
- [ ] Value in the `*Content` field looks like a filename string (ends in `.md`, contains slashes, single line)? STOP — that's the wrong field. Move it to the `*Md` (path) field.
- [ ] Path in the `*Md` field is relative to the persona JSON's directory (not to the project root or session cwd)?
