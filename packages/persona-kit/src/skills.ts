import { HARNESS_SKILL_TARGETS } from './constants.js';
import type {
  Harness,
  PersonaSelection,
  PersonaSkill,
  SkillInstall,
  SkillMaterializationOptions,
  SkillMaterializationPlan,
  SkillSourceKind
} from './types.js';

// ---------------------------------------------------------------------------
// Skill materialization
// ---------------------------------------------------------------------------
//
// Personas declare *what* skill they need via `skills: [{ id, source, ... }]`.
// The SDK is the only layer that knows *how* to make that skill available to
// a given harness — because each harness has its own on-disk convention and
// its own prpm install flag. Keeping this mapping here means:
//
//   1. Workflow authors never hand-type `prpm install ... --as codex`.
//   2. Changing install rules is a one-line SDK edit, not a repo-wide grep.
//   3. Persona JSON stays harness-agnostic and forward-compatible.
//
// `materializeSkills` is a pure function: it returns the install plan but
// never touches the filesystem or spawns processes. Callers (relay workflows,
// the OpenClaw spawner, ad-hoc scripts) decide how to execute it.

interface ResolvedSkillSource {
  kind: SkillSourceKind;
  packageRef: string;
  /** Directory name used for the installed skill (e.g. `npm-trusted-publishing`). */
  installedName: string;
}

/**
 * Subset of {@link SkillMaterializationOptions} that providers care about when
 * building install commands. Forwarded by `materializeSkills` and the
 * `buildInstallArtifacts` chain. Optional so providers can ignore it.
 */
interface BuildInstallContext {
  repoRoot?: string;
}

interface SkillProvider {
  readonly kind: SkillSourceKind;
  /** Parse a persona `source` string; return null if this provider does not claim it. */
  parse(source: string): ResolvedSkillSource | null;
  /** Build the argv-style install command for `materializeSkills`. */
  buildInstallCommand(
    ref: ResolvedSkillSource,
    harness: Harness,
    context?: BuildInstallContext
  ): readonly string[];
  /**
   * Ephemeral paths the installer scatters for this skill under `harness` that are
   * safe to remove once the persona has finished reading them. Does not include
   * the provider's lockfile.
   */
  cleanupPaths(ref: ResolvedSkillSource, harness: Harness): readonly string[];
}

const PRPM_URL_RE =
  /^https?:\/\/prpm\.dev\/packages\/([^/\s?#]+)\/([^/\s?#]+)\/?(?:[?#].*)?$/i;
const PRPM_BARE_REF_RE = /^([^/\s]+)\/([^/\s]+)$/;

function lastSegment(ref: string): string {
  const slash = ref.lastIndexOf('/');
  return slash >= 0 ? ref.slice(slash + 1) : ref;
}

const prpmProvider: SkillProvider = {
  kind: 'prpm',
  parse(source) {
    const urlMatch = source.match(PRPM_URL_RE);
    if (urlMatch) {
      const ref = `${urlMatch[1]}/${urlMatch[2]}`;
      return { kind: 'prpm', packageRef: ref, installedName: lastSegment(ref) };
    }
    const bareMatch = source.match(PRPM_BARE_REF_RE);
    if (bareMatch) {
      return { kind: 'prpm', packageRef: source, installedName: lastSegment(source) };
    }
    return null;
  },
  buildInstallCommand(ref, harness) {
    const target = HARNESS_SKILL_TARGETS[harness];
    return Object.freeze([
      'npx',
      '-y',
      'prpm',
      'install',
      ref.packageRef,
      '--as',
      target.asFlag
    ]) as readonly string[];
  },
  cleanupPaths(ref, harness) {
    const target = HARNESS_SKILL_TARGETS[harness];
    return Object.freeze([`${target.dir}/${ref.installedName}`]) as readonly string[];
  }
};

// skill.sh source forms:
// - `<github-url>#<skill-name>`
// - `<github-url>/tree/<ref>/<path-to-skill>`
// Examples:
// - `https://github.com/vercel-labs/skills#find-skills`
// - `https://github.com/wsimmonds/claude-nextjs-skills/tree/main/nextjs-anti-patterns`
const SKILL_SH_URL_RE =
  /^(https?:\/\/github\.com\/[^/\s?#]+\/[^/\s?#]+?)(?:\.git)?#([^\s?#]+)$/i;
const SKILL_SH_TREE_URL_RE =
  /^(https?:\/\/github\.com\/[^/\s?#]+\/[^/\s?#]+?)(?:\.git)?\/tree\/([^/\s?#]+)\/([^?#]+?)(?:[?#].*)?$/i;
const SKILL_NAME_RE = /^(?!\.{1,2}$)[A-Za-z0-9][A-Za-z0-9._-]*$/;

function toSafeSkillName(raw: string): string | null {
  const name = raw.trim();
  return SKILL_NAME_RE.test(name) ? name : null;
}

/**
 * Paths `npx skills add` writes per install. Mirrors the on-disk layout from
 * a live `npx -y skills add ... -y` run (universal dir + harness-side
 * symlinks). `skills-lock.json` is deliberately excluded so repeat runs can
 * re-resolve from the lock instead of refetching sources.
 */
function skillShArtifactPaths(installedName: string): readonly string[] {
  return Object.freeze([
    `.agents/skills/${installedName}`,
    `.claude/skills/${installedName}`,
    `.factory/skills/${installedName}`,
    `.kiro/skills/${installedName}`,
    `skills/${installedName}`
  ]) as readonly string[];
}

const skillShProvider: SkillProvider = {
  kind: 'skill.sh',
  parse(source) {
    const match = source.match(SKILL_SH_URL_RE);
    if (match) {
      const [, repoUrl, rawSkillName] = match;
      const skillName = toSafeSkillName(rawSkillName);
      if (!skillName) return null;
      return {
        kind: 'skill.sh',
        // packageRef preserves the full `<repo>#<skill>` shape so the command builder
        // can reconstruct both halves without re-parsing the original source.
        packageRef: `${repoUrl}#${skillName}`,
        installedName: skillName
      };
    }

    const treeMatch = source.match(SKILL_SH_TREE_URL_RE);
    if (!treeMatch) return null;
    const [, repoUrl, ref, skillPath] = treeMatch;
    const skillName = toSafeSkillName(skillPath.split('/').filter(Boolean).at(-1) ?? '');
    if (!skillName) return null;
    return {
      kind: 'skill.sh',
      packageRef: `${repoUrl}/tree/${ref}#${skillName}`,
      installedName: skillName
    };
  },
  buildInstallCommand(ref) {
    const [repoUrl, skillName] = ref.packageRef.split('#');
    return Object.freeze([
      'npx',
      '-y',
      'skills',
      'add',
      repoUrl,
      '--skill',
      skillName,
      '-y'
    ]) as readonly string[];
  },
  cleanupPaths(ref) {
    // skill.sh installs the same universal dir + harness symlinks regardless
    // of which agent is the "host" — clean all of them so nothing leaks into
    // `.claude/`, `.agents/`, etc. after the persona run.
    return skillShArtifactPaths(ref.installedName);
  }
};

// Local source forms:
// - A repo-relative or absolute path to a single `.md` file that will be
//   installed as `<harness-skill-dir>/<name>/SKILL.md`.
// Examples:
// - `.agentworkforce/workforce/skills/essay-authoring.md`
// - `./skills/my-skill.md`
// - `/abs/path/to/SKILL.md`
//
// The provider intentionally rejects URLs and prpm `<scope>/<name>` shorthand
// (no `.md` suffix) so it never claims sources the other providers should
// handle. It is registered FIRST so its narrow `.md`-suffix test gets first
// refusal on path-shaped strings before prpm's bare-ref regex sees them.
const LOCAL_MD_RE = /\.md$/i;
const URL_PREFIX_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

function localInstalledName(source: string): string | null {
  const lastSlash = source.lastIndexOf('/');
  const basename = lastSlash >= 0 ? source.slice(lastSlash + 1) : source;
  const stem = basename.replace(/\.md$/i, '');
  // A SKILL.md inside a skill dir is conventional; in that case the parent
  // directory name is the meaningful identifier. Strip a trailing `/SKILL`
  // stem and use the segment above it instead.
  if (stem === 'SKILL' && lastSlash > 0) {
    const parentSlice = source.slice(0, lastSlash);
    const parentSlash = parentSlice.lastIndexOf('/');
    const parent = parentSlash >= 0 ? parentSlice.slice(parentSlash + 1) : parentSlice;
    return toSafeSkillName(parent);
  }
  return toSafeSkillName(stem);
}

const localProvider: SkillProvider = {
  kind: 'local',
  parse(source) {
    if (URL_PREFIX_RE.test(source)) return null;
    if (!LOCAL_MD_RE.test(source)) return null;
    const installedName = localInstalledName(source);
    if (!installedName) return null;
    return {
      kind: 'local',
      // packageRef preserves the original source string verbatim so the
      // command builder can resolve it against `repoRoot` if supplied.
      packageRef: source,
      installedName
    };
  },
  buildInstallCommand(ref, harness, context) {
    const target = HARNESS_SKILL_TARGETS[harness];
    const destDir = `${target.dir}/${ref.installedName}`;
    const source = resolveLocalSource(ref.packageRef, context?.repoRoot);
    // A single shell command so the mkdir + cp pair is atomic from the
    // caller's perspective (one spawn, one exit code) and survives a
    // `cd <installRoot> && …` wrapper in session mode — the destination
    // stays harness-relative, the source is absolute when `repoRoot` is set.
    const script = `mkdir -p ${shellEscape(destDir)} && cp ${shellEscape(source)} ${shellEscape(`${destDir}/SKILL.md`)}`;
    return Object.freeze(['sh', '-c', script]) as readonly string[];
  },
  cleanupPaths(ref, harness) {
    const target = HARNESS_SKILL_TARGETS[harness];
    return Object.freeze([`${target.dir}/${ref.installedName}`]) as readonly string[];
  }
};

function resolveLocalSource(source: string, repoRoot: string | undefined): string {
  // Absolute paths and `file://` URLs (already stripped above for the URL
  // check, but kept defensive here) stand on their own. Relative paths are
  // joined to `repoRoot` when supplied so session-mode `cd <installRoot>`
  // doesn't change their meaning.
  if (source.startsWith('/')) return source;
  if (!repoRoot) return source;
  const trimmedRoot = repoRoot.endsWith('/') ? repoRoot.slice(0, -1) : repoRoot;
  const trimmedSource = source.startsWith('./') ? source.slice(2) : source;
  return `${trimmedRoot}/${trimmedSource}`;
}

const SKILL_PROVIDERS: readonly SkillProvider[] = Object.freeze([
  localProvider,
  prpmProvider,
  skillShProvider
]);

export function resolveSkillSource(source: string): ResolvedSkillSource {
  for (const provider of SKILL_PROVIDERS) {
    const parsed = provider.parse(source);
    if (parsed) {
      return parsed;
    }
  }
  throw new Error(
    `Unsupported skill source: ${source}. ` +
      `Supported forms: prpm.dev package URL (https://prpm.dev/packages/<scope>/<name>), ` +
      `bare "<scope>/<name>" prpm reference, ` +
      `skill.sh github URL with skill fragment (https://github.com/<org>/<repo>#<skill>), ` +
      `GitHub tree URL to a skill directory (https://github.com/<org>/<repo>/tree/<ref>/<skill>), ` +
      `or a local repo-relative path to a SKILL markdown file (e.g. ./skills/my-skill.md, .agentworkforce/workforce/skills/my-skill.md).`
  );
}

function providerFor(kind: SkillSourceKind): SkillProvider {
  const provider = SKILL_PROVIDERS.find((p) => p.kind === kind);
  if (!provider) {
    throw new Error(`No skill provider registered for kind: ${kind}`);
  }
  return provider;
}

/**
 * Given a set of persona skills and the harness the persona will run under,
 * produce the concrete install plan: which install invocations to run, where
 * the skill will land on disk, and which artifact paths should be cleaned up
 * after the persona run to keep the workspace tidy.
 *
 * Pure function — does not execute commands or touch the filesystem.
 */
export function materializeSkills(
  skills: readonly PersonaSkill[],
  harness: Harness,
  options: SkillMaterializationOptions = {}
): SkillMaterializationPlan {
  const target = HARNESS_SKILL_TARGETS[harness];
  if (!target) {
    throw new Error(`No skill install target configured for harness: ${harness}`);
  }
  const { installRoot, repoRoot } = options;
  if (installRoot !== undefined && harness !== 'claude') {
    throw new Error(
      `installRoot is only supported for the claude harness (got: ${harness}). ` +
        `codex and opencode still install into the harness's conventional repo-relative directory.`
    );
  }

  const providerContext: BuildInstallContext | undefined =
    repoRoot !== undefined ? { repoRoot } : undefined;

  const installs = skills.map((skill): SkillInstall => {
    const resolved = resolveSkillSource(skill.source);
    const provider = providerFor(resolved.kind);
    const baseCommand = provider.buildInstallCommand(resolved, harness, providerContext);
    // In session-install-root mode, the install runs `cd <installRoot> && <prpm>`
    // so that prpm's harness-relative dirs (`.claude/skills/<name>`) land
    // inside the stage dir instead of the user's repo. The per-install command
    // stays self-contained so callers who run a single install.installCommand
    // directly still get the correct placement.
    const installCommand =
      installRoot !== undefined
        ? (Object.freeze([
            'sh',
            '-c',
            `cd ${shellEscape(installRoot)} && ${commandToShellString(baseCommand)}`
          ]) as readonly string[])
        : baseCommand;
    // For prompt-injection fallback we still want a single canonical manifest
    // path. prpm installs into the harness target dir; skill.sh installs into
    // its universal `.agents/skills` dir regardless of harness, so key off
    // whichever cleanup path ends in the installed name.
    const repoRelativeDir =
      resolved.kind === 'skill.sh'
        ? `.agents/skills/${resolved.installedName}`
        : `${target.dir}/${resolved.installedName}`;
    const installedDir =
      installRoot !== undefined ? `${installRoot}/${repoRelativeDir}` : repoRelativeDir;
    // When the plan stages into `installRoot`, cleanup targets the whole
    // session dir (handled at plan level in buildCleanupArtifacts). Leave
    // per-skill cleanupPaths empty so callers running individual
    // install.cleanupPaths don't accidentally remove unrelated things.
    const cleanupPaths =
      installRoot !== undefined
        ? (Object.freeze([]) as readonly string[])
        : provider.cleanupPaths(resolved, harness);
    return {
      skillId: skill.id,
      source: skill.source,
      sourceKind: resolved.kind,
      packageRef: resolved.packageRef,
      harness,
      installCommand,
      installedDir,
      installedManifest: `${installedDir}/SKILL.md`,
      cleanupPaths
    };
  });

  return {
    harness,
    installs,
    ...(installRoot !== undefined ? { sessionInstallRoot: installRoot } : {}),
    ...(repoRoot !== undefined ? { repoRoot } : {})
  };
}

/**
 * Convenience wrapper: derive the install plan directly from a resolved
 * persona selection, using its tier's harness automatically.
 */
export function materializeSkillsFor(
  selection: PersonaSelection,
  options: SkillMaterializationOptions = {}
): SkillMaterializationPlan {
  return materializeSkills(selection.skills, selection.runtime.harness, options);
}

function shellEscape(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function commandToShellString(command: readonly string[]): string {
  return command.map(shellEscape).join(' ');
}

/**
 * Minimal Claude Code plugin manifest written to `<root>/.claude-plugin/plugin.json`
 * in session-install-root mode. Claude's plugin loader treats any directory
 * that contains this file (alongside a `skills/` tree) as a plugin; we pass
 * the root to `claude --plugin-dir <root>` so the session sees exactly the
 * skills we staged — and nothing the repo happens to carry.
 */
const SESSION_PLUGIN_MANIFEST = JSON.stringify({
  name: 'agent-workforce-session',
  version: '0.0.0',
  description: 'Ephemeral skills staged by agent-workforce for this session.'
});

function buildSessionScaffoldCommand(root: string): string {
  const q = shellEscape(root);
  // mkdir -p creates both the plugin metadata dir and the prpm target.
  // `ln -sfn .claude/skills skills` makes Claude's expected plugin layout
  // (`<root>/skills/<name>/SKILL.md`) resolve to prpm's actual output
  // (`<root>/.claude/skills/<name>/SKILL.md`) without moving any files.
  // The -n guards against following into an existing `skills/` dir (e.g.
  // when the session dir is reused), and -f replaces a prior symlink so
  // the scaffold is idempotent.
  return [
    `mkdir -p ${q}/.claude-plugin ${q}/.claude/skills`,
    `ln -sfn .claude/skills ${q}/skills`,
    `printf '%s' ${shellEscape(SESSION_PLUGIN_MANIFEST)} > ${q}/.claude-plugin/plugin.json`
  ].join(' && ');
}

export function buildInstallArtifacts(plan: SkillMaterializationPlan): {
  installCommand: readonly string[];
  installCommandString: string;
} {
  if (plan.sessionInstallRoot !== undefined) {
    // Session mode always stages a plugin dir so the caller can pass
    // `--plugin-dir <root>` to claude unconditionally. Even for personas
    // with zero skills, we emit the scaffold (mkdir + manifest + symlink)
    // so the `--plugin-dir` target exists.
    const root = plan.sessionInstallRoot;
    const scaffold = buildSessionScaffoldCommand(root);
    if (plan.installs.length === 0) {
      return {
        installCommand: Object.freeze(['sh', '-c', scaffold]) as readonly string[],
        installCommandString: scaffold
      };
    }
    // Chain the raw provider commands after a single `cd <root>` so we emit
    // one shell invocation instead of repeating the cd per skill. Each
    // install.installCommand is already self-contained (`sh -c 'cd <root> &&
    // …'`) for callers who want to run one at a time, but here we flatten
    // to the underlying prpm argv for a cleaner chain.
    const providerContext: BuildInstallContext | undefined =
      plan.repoRoot !== undefined ? { repoRoot: plan.repoRoot } : undefined;
    const perSkill = plan.installs
      .map((install) => {
        const resolved = resolveSkillSource(install.source);
        const provider = providerFor(resolved.kind);
        return commandToShellString(
          provider.buildInstallCommand(resolved, plan.harness, providerContext)
        );
      })
      .join(' && ');
    const installCommandString = `${scaffold} && cd ${shellEscape(root)} && ${perSkill}`;
    return {
      installCommand: Object.freeze(['sh', '-c', installCommandString]) as readonly string[],
      installCommandString
    };
  }

  if (plan.installs.length === 0) {
    return {
      installCommand: Object.freeze(['sh', '-c', ':']) as readonly string[],
      installCommandString: ':'
    };
  }

  const installCommandString = plan.installs
    .map((install) => commandToShellString(install.installCommand))
    .join(' && ');
  return {
    installCommand: Object.freeze(['sh', '-c', installCommandString]) as readonly string[],
    installCommandString
  };
}

/**
 * Post-run cleanup: one shell command that removes every ephemeral artifact
 * path declared across all installs in the plan. Runs AFTER the agent step so
 * the agent can still read skill manifests off disk during execution. The
 * provider lockfile is deliberately not in the path set, so repeat runs keep
 * cached resolution.
 *
 * Empty plans return `:` (shell no-op) to keep the post-step shape uniform.
 */
export function buildCleanupArtifacts(plan: SkillMaterializationPlan): {
  cleanupCommand: readonly string[];
  cleanupCommandString: string;
} {
  // Session mode: cleanup is the whole stage dir. The scaffold always runs
  // (even for zero-skill personas), so cleanup unconditionally drops the
  // stage dir. The CLI is responsible for removing the enclosing session
  // root; this command covers the install subtree.
  if (plan.sessionInstallRoot !== undefined) {
    const cleanupCommandString = `rm -rf ${shellEscape(plan.sessionInstallRoot)}`;
    return {
      cleanupCommand: Object.freeze(['sh', '-c', cleanupCommandString]) as readonly string[],
      cleanupCommandString
    };
  }
  const allPaths = plan.installs.flatMap((install) => [...install.cleanupPaths]);
  const cleanupCommandString =
    allPaths.length === 0 ? ':' : `rm -rf ${allPaths.map(shellEscape).join(' ')}`;
  return {
    cleanupCommand: Object.freeze(['sh', '-c', cleanupCommandString]) as readonly string[],
    cleanupCommandString
  };
}
