import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PERSONA_INTENTS,
  materializeSkillsFor,
  type PersonaSelection
} from '@agentworkforce/persona-kit';
import {
  listBuiltInPersonas,
  personaCatalog,
  resolvePersona,
  resolvePersonaByTier,
  routingProfiles,
  usePersona,
  useSelection
} from './index.js';

const prpmSkill = {
  id: 'prpm/npm-trusted-publishing',
  source: '@prpm/npm-trusted-publishing',
  description: 'trusted publishing skill'
};

const skillShSkill = {
  id: 'skill.sh/find-skills',
  source: 'https://github.com/vercel-labs/skills#find-skills',
  description: 'skill.sh discovery skill'
};

function syntheticSelection(over: Partial<PersonaSelection> = {}): PersonaSelection {
  const runtime = {
    harness: 'codex' as const,
    model: 'test-model',
    systemPrompt: 'test prompt',
    harnessSettings: { reasoning: 'medium' as const, timeoutSeconds: 300 }
  };
  return {
    personaId: 'synthetic',
    tier: 'best-value',
    runtime,
    skills: [],
    rationale: 'test',
    ...over
  };
}

test('built-in catalog is limited to internal system personas', () => {
  const builtIns = listBuiltInPersonas();
  assert.deepEqual(builtIns.map((p) => p.id).sort(), ['persona-improver', 'persona-maker']);
  assert.equal(personaCatalog['persona-authoring']?.id, 'persona-maker');
  assert.equal(personaCatalog['persona-improvement']?.id, 'persona-improver');
  assert.equal(personaCatalog.review, undefined);
  assert.ok(PERSONA_INTENTS.includes('review'));
  assert.equal(routingProfiles.default.intents.review.tier, 'best-value');
});

test('resolves persona-maker from the default routing profile', () => {
  const selection = resolvePersona('persona-authoring');
  assert.equal(selection.personaId, 'persona-maker');
  assert.equal(selection.tier, 'best');
  assert.equal(selection.runtime.harness, 'codex');
  assert.match(selection.rationale, /balanced-default/);
  assert.equal(selection.inputs?.TARGET_DIR?.default, '.agentworkforce/workforce/personas');
  assert.equal(selection.inputs?.CREATE_MODE?.default, 'local');
  assert.match(selection.agentsMdContent ?? '', /\$TARGET_DIR\/<id>\.json/);
  assert.equal(selection.runtime.harnessSettings.sandboxMode, 'workspace-write');
  assert.equal(selection.runtime.harnessSettings.approvalPolicy, 'on-request');
  assert.equal(selection.runtime.harnessSettings.workspaceWriteNetworkAccess, true);
  assert.match(
    selection.agentsMdContent ?? '',
    /Do not request network escalation only to complete this fallback/
  );
});

test('optional pack-owned intents do not resolve from the built-in catalog', () => {
  assert.throws(
    () => resolvePersona('review'),
    /No built-in persona is registered for intent "review".*personas-core/
  );
  assert.throws(
    () => resolvePersonaByTier('review', 'best'),
    /No built-in persona is registered for intent "review"/
  );
});

test('legacy tier override remains available for internal personas', () => {
  const selection = resolvePersonaByTier('persona-authoring', 'minimum');
  assert.equal(selection.personaId, 'persona-maker');
  assert.equal(selection.tier, 'minimum');
  assert.equal(selection.runtime.harness, 'opencode');
  assert.match(selection.rationale, /legacy-tier-override/);
});

test('materializeSkillsFor derives an install plan from a resolved internal persona', () => {
  const selection = resolvePersona('persona-authoring');
  const plan = materializeSkillsFor(selection);
  assert.equal(plan.harness, 'codex');
  assert.equal(plan.installs.length, 1);
  assert.deepEqual([...plan.installs[0].installCommand], [
    'npx',
    '-y',
    'skills',
    'add',
    'https://github.com/vercel-labs/skills',
    '--skill',
    'find-skills',
    '-y'
  ]);
});

test('useSelection install command never embeds cleanup', () => {
  const context = useSelection(syntheticSelection({ skills: [prpmSkill] }));
  assert.doesNotMatch(context.install.commandString, /rm -rf/);
  assert.match(
    context.install.commandString,
    /prpm install @prpm\/npm-trusted-publishing --as codex/
  );
});

test('useSelection exposes a post-run cleanupCommandString targeting skill artifacts', () => {
  const context = useSelection(syntheticSelection({ skills: [prpmSkill] }));
  assert.ok(Array.isArray(context.install.cleanupCommand));
  assert.equal(context.install.cleanupCommand[0], 'sh');
  assert.match(context.install.cleanupCommandString, /^rm -rf /);
  assert.match(context.install.cleanupCommandString, /npm-trusted-publishing/);
  assert.doesNotMatch(context.install.cleanupCommandString, /prpm\.lock|skills-lock\.json/);
});

test('useSelection cleanupCommandString chains paths from every install in the plan', () => {
  const context = useSelection(
    syntheticSelection({ skills: [skillShSkill, prpmSkill] })
  );
  const cleanup = context.install.cleanupCommandString;
  assert.match(cleanup, /^rm -rf /);
  assert.match(cleanup, /find-skills/);
  assert.match(cleanup, /npm-trusted-publishing/);
  assert.match(cleanup, /\.agents\/skills\/find-skills/);
  assert.match(cleanup, /\.claude\/skills\/find-skills/);
  assert.match(cleanup, /\.factory\/skills\/find-skills/);
  assert.match(cleanup, /\.kiro\/skills\/find-skills/);
});

test('useSelection cleanupCommandString is a shell no-op when the persona declares no skills', () => {
  const context = useSelection(syntheticSelection());
  assert.equal(context.install.cleanupCommandString, ':');
});

test('useSelection with installRoot emits scaffold plus chained prpm', () => {
  const installRoot = '/tmp/agent-workforce/sessions/scaffold-test/claude/plugin';
  const selection = syntheticSelection({ skills: [prpmSkill] });
  const context = useSelection(selection, { harness: 'claude', installRoot });
  assert.equal(context.install.plan.sessionInstallRoot, installRoot);
  const cmd = context.install.commandString;
  assert.match(cmd, /^mkdir -p /);
  assert.match(cmd, /\.claude-plugin/);
  assert.match(cmd, /ln -sfn \.claude\/skills /);
  assert.match(cmd, /printf '%s' /);
  assert.match(cmd, / && cd '?\/tmp\/agent-workforce\/sessions\/scaffold-test\/claude\/plugin'? && /);
  assert.match(cmd, /npx -y prpm install @prpm\/npm-trusted-publishing --as claude/);
});

test('useSelection with installRoot collapses cleanup to a single rm -rf of the stage dir', () => {
  const installRoot = '/tmp/agent-workforce/sessions/cleanup-test/claude/plugin';
  const context = useSelection(
    syntheticSelection({ skills: [prpmSkill] }),
    { harness: 'claude', installRoot }
  );
  assert.equal(
    context.install.cleanupCommandString,
    `rm -rf /tmp/agent-workforce/sessions/cleanup-test/claude/plugin`
  );
});

test('useSelection with installRoot and no skills emits scaffold so plugin dir exists', () => {
  const installRoot = '/tmp/agent-workforce/sessions/empty-scaffold/claude/plugin';
  const context = useSelection(syntheticSelection(), { harness: 'claude', installRoot });
  assert.equal(context.install.plan.sessionInstallRoot, installRoot);
  assert.equal(context.install.plan.installs.length, 0);
  assert.notEqual(context.install.commandString, ':');
  assert.match(context.install.commandString, /^mkdir -p /);
  assert.equal(context.install.cleanupCommandString, `rm -rf ${installRoot}`);
});

test('usePersona combines selection and grouped install metadata into a frozen context', () => {
  const context = usePersona('persona-authoring');
  const selection = resolvePersona('persona-authoring');
  const plan = materializeSkillsFor(selection);

  assert.deepEqual(context.selection, selection);
  assert.deepEqual(context.install.plan, plan);
  assert.equal(context.install.command[0], 'sh');
  assert.match(context.install.commandString, /skills add/);
  assert.ok(Object.isFrozen(context));
  assert.ok(Object.isFrozen(context.selection));
  assert.ok(Object.isFrozen(context.install));
  assert.ok(Object.isFrozen(context.install.plan));
  assert.ok(Object.isFrozen(context.install.command));
});

test('PersonaSpec catalog leaves defaultTier unset for built-ins', () => {
  assert.equal(personaCatalog['persona-authoring']?.defaultTier, undefined);
});

test('resolvePersona populates sidecar selection fields from the internal catalog', () => {
  const sel = resolvePersona('persona-authoring');
  assert.equal(sel.claudeMd, undefined);
  assert.equal(sel.claudeMdContent, undefined);
  assert.equal(sel.claudeMdMode, undefined);
  assert.equal(sel.agentsMd, undefined);
  assert.match(sel.agentsMdContent ?? '', /Persona author/);
  assert.equal(sel.agentsMdMode, 'overwrite');
});
