import {
  deepFreeze,
  isObject,
  materializeSkills,
  materializeSkillsFor,
  parsePersonaSpec,
  PERSONA_INTENTS,
  resolveSidecar,
  sidecarSelectionFields,
  buildInstallArtifacts,
  buildCleanupArtifacts,
  type Harness,
  type PersonaContext,
  type PersonaInstallContext,
  type PersonaIntent,
  type PersonaSelection,
  type PersonaSpec,
  type SkillMaterializationOptions
} from '@agentworkforce/persona-kit';

import { personaImprover, personaMaker } from './generated/personas.js';
import defaultRoutingProfileJson from '../routing-profiles/default.json' with { type: 'json' };

// ---------------------------------------------------------------------------
// Routing profile + built-in persona catalog (workload-router's own concern).
// ---------------------------------------------------------------------------

export interface RoutingProfileRule {
  rationale: string;
}

export interface RoutingProfile {
  id: string;
  description: string;
  intents: Record<PersonaIntent, RoutingProfileRule>;
}

function parseRoutingProfile(value: unknown, context: string): RoutingProfile {
  if (!isObject(value)) {
    throw new Error(`${context} must be an object`);
  }

  const { id, description, intents } = value;
  if (typeof id !== 'string' || !id.trim()) {
    throw new Error(`${context}.id must be a non-empty string`);
  }
  if (typeof description !== 'string' || !description.trim()) {
    throw new Error(`${context}.description must be a non-empty string`);
  }
  if (!isObject(intents)) {
    throw new Error(`${context}.intents must be an object`);
  }

  const parsedIntents = {} as Record<PersonaIntent, RoutingProfileRule>;
  for (const intent of PERSONA_INTENTS) {
    const rule = intents[intent];
    if (!isObject(rule)) {
      throw new Error(`${context}.intents.${intent} must be an object`);
    }
    const { rationale } = rule;
    if (typeof rationale !== 'string' || !rationale.trim()) {
      throw new Error(`${context}.intents.${intent}.rationale must be a non-empty string`);
    }
    parsedIntents[intent] = { rationale };
  }

  return {
    id,
    description,
    intents: parsedIntents
  };
}

export const personaCatalog: Partial<Record<PersonaIntent, PersonaSpec>> = {
  'persona-authoring': parsePersonaSpec(personaMaker, 'persona-authoring'),
  'persona-improvement': parsePersonaSpec(personaImprover, 'persona-improvement')
};

export function listBuiltInPersonas(): PersonaSpec[] {
  return Object.values(personaCatalog).filter(
    (spec): spec is PersonaSpec => spec !== undefined
  );
}

function requireBuiltInPersona(intent: PersonaIntent): PersonaSpec {
  const spec = personaCatalog[intent];
  if (!spec) {
    throw new Error(
      `No built-in persona is registered for intent "${intent}". ` +
        'Install a persona pack such as @agentworkforce/personas-core or @agentrelay/personas, ' +
        'or load a project-local persona before selecting this intent.'
    );
  }
  return spec;
}

export const routingProfiles = {
  default: parseRoutingProfile(defaultRoutingProfileJson, 'routingProfiles.default')
} as const;

export type RoutingProfileId = keyof typeof routingProfiles;

export function resolvePersona(intent: PersonaIntent, profile: RoutingProfile | RoutingProfileId = 'default'): PersonaSelection {
  const profileSpec = typeof profile === 'string' ? routingProfiles[profile] : profile;
  const rule = profileSpec.intents[intent];
  const spec = requireBuiltInPersona(intent);

  // Routing resolves to an interactive harness session, which requires a
  // harness/model/systemPrompt. Built-in catalog personas always declare
  // them; the guard narrows the now-optional spec fields and fails loudly
  // if a malformed built-in ever slips through.
  if (!spec.harness || !spec.model || !spec.systemPrompt) {
    throw new Error(
      `built-in persona "${spec.id}" (intent ${intent}) is missing harness/model/systemPrompt required for routing`
    );
  }

  return {
    personaId: spec.id,
    harness: spec.harness,
    model: spec.model,
    systemPrompt: spec.systemPrompt,
    harnessSettings: spec.harnessSettings,
    skills: spec.skills,
    rationale: `${profileSpec.id}: ${rule.rationale}`,
    ...(spec.inputs ? { inputs: spec.inputs } : {}),
    ...(spec.env ? { env: spec.env } : {}),
    ...(spec.mcpServers ? { mcpServers: spec.mcpServers } : {}),
    ...(spec.permissions ? { permissions: spec.permissions } : {}),
    ...(spec.mount ? { mount: spec.mount } : {}),
    ...(typeof spec.recordTrajectories === 'boolean'
      ? { recordTrajectories: spec.recordTrajectories }
      : {}),
    ...sidecarSelectionFields(resolveSidecar(spec))
  };
}

/**
 * Resolve a persona for `intent` and return a {@link PersonaContext}
 * bundling the resolved persona and grouped install metadata.
 *
 * **This is not a React hook.** The `use*` prefix is unfortunate — it is
 * a plain synchronous factory with no implicit state, no side effects,
 * and no rules-of-hooks constraints. Calling `usePersona(intent)` does
 * nothing but resolve routing config and pre-compute the install plan.
 * Nothing is installed, spawned, or written to disk until you run
 * `install.commandString` yourself.
 *
 * This resolves the internal built-in system catalog only. Optional persona
 * packs should be loaded through the CLI/source cascade and passed to
 * `useSelection` or `materializeSkillsFor` as resolved selections.
 *
 * @example
 * const { selection, install } = usePersona('persona-authoring');
 * spawnSync(install.commandString, { shell: true, stdio: 'inherit' });
 * // hand `selection` to your harness launcher of choice.
 *
 * @param intent   The internal persona intent to resolve (e.g. `'persona-authoring'`).
 * @param options  Optional overrides. `harness` forces a specific harness
 *                 (otherwise inferred from the persona's declared harness).
 *                 `profile` selects the routing profile (defaults to `'default'`).
 */
export function usePersona(
  intent: PersonaIntent,
  options: {
    harness?: Harness;
    profile?: RoutingProfile | RoutingProfileId;
    /**
     * Stage claude skills under this absolute directory instead of the
     * repo's `.claude/skills/`. See {@link SkillMaterializationOptions.installRoot}.
     */
    installRoot?: string;
    /**
     * Filesystem root that relative `local`-kind skill sources resolve
     * against. See {@link SkillMaterializationOptions.repoRoot}.
     */
    repoRoot?: string;
  } = {}
): PersonaContext {
  const baseSelection = resolvePersona(intent, options.profile ?? 'default');

  return useSelection(baseSelection, {
    harness: options.harness,
    installRoot: options.installRoot,
    repoRoot: options.repoRoot
  });
}

/**
 * Same as {@link usePersona}, but takes a pre-resolved {@link PersonaSelection}
 * instead of an intent. Use this when you have a selection produced outside
 * the standard repo catalog — for example, a user-local persona override
 * loaded from disk.
 */
export function useSelection(
  baseSelection: PersonaSelection,
  options: { harness?: Harness; installRoot?: string; repoRoot?: string } = {}
): PersonaContext {
  const effectiveHarness = options.harness ?? baseSelection.harness;
  const selection =
    effectiveHarness === baseSelection.harness
      ? baseSelection
      : { ...baseSelection, harness: effectiveHarness };

  const materializationOptions: SkillMaterializationOptions = {
    ...(options.installRoot !== undefined ? { installRoot: options.installRoot } : {}),
    ...(options.repoRoot !== undefined ? { repoRoot: options.repoRoot } : {})
  };
  const installPlan =
    effectiveHarness === baseSelection.harness
      ? materializeSkillsFor(selection, materializationOptions)
      : materializeSkills(selection.skills, effectiveHarness, materializationOptions);

  const { installCommand, installCommandString } = buildInstallArtifacts(installPlan);
  const { cleanupCommand, cleanupCommandString } = buildCleanupArtifacts(installPlan);
  const frozenSelection = deepFreeze(selection);
  const frozenInstallPlan = deepFreeze(installPlan);
  const frozenInstall: PersonaInstallContext = Object.freeze({
    plan: frozenInstallPlan,
    command: installCommand,
    commandString: installCommandString,
    cleanupCommand,
    cleanupCommandString
  });

  return Object.freeze({
    selection: frozenSelection,
    install: frozenInstall
  });
}

export * from './eval.js';
