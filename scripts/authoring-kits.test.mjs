import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

/**
 * A persona is authored as `persona.ts` and compiled by the CLI, which resolves
 * the file's imports out of the CLI's own install tree — the user's repo
 * usually has no `node_modules` at all when the CLI is installed globally.
 *
 * So every kit a persona.ts can import has to ship inside that tree, or
 * `agentworkforce deploy ./persona.ts` dies with "Could not resolve" on a fresh
 * install. persona-kit was already there; turn-kit and review-kit were not,
 * which is the same failure workforce#325 fixed for persona-kit.
 */
function packageJson(dir) {
  return JSON.parse(readFileSync(`packages/${dir}/package.json`, 'utf8'));
}

function personaAuthoringKits() {
  const kits = [];
  for (const dir of readdirSync('packages')) {
    let sources;
    try {
      sources = readdirSync(`packages/${dir}/src`);
    } catch {
      continue; // not a source package
    }
    const authorsPersonas = sources.some((file) => {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts')) return false;
      const source = readFileSync(`packages/${dir}/src/${file}`, 'utf8');
      return /export function define\w*Persona\b/.test(source);
    });
    if (authorsPersonas) kits.push(packageJson(dir).name);
  }
  return kits.sort();
}

test('every persona-authoring kit ships in the CLI install tree', () => {
  const kits = personaAuthoringKits();
  // Guard against the discovery silently finding nothing and passing vacuously.
  assert.ok(
    kits.includes('@agentworkforce/persona-kit'),
    `discovery failed to find the authoring kits (found: ${kits.join(', ') || 'none'})`
  );

  const cli = packageJson('cli');
  for (const kit of kits) {
    assert.ok(
      cli.dependencies?.[kit],
      `${kit} exports a define*Persona entry point, so a persona.ts can import it, ` +
        'but @agentworkforce/cli does not depend on it — it will not be installed ' +
        'alongside the CLI and the persona will fail to compile on a fresh install'
    );
  }
});

test('authoring kits are published in lockstep with the CLI', () => {
  const publishWorkflow = readFileSync('.github/workflows/publish.yml', 'utf8');
  const targets = publishWorkflow.match(/echo "packages=([^"]+)"/)[1].trim().split(/\s+/);
  const published = new Set(targets.map((dir) => packageJson(dir).name));

  for (const kit of personaAuthoringKits()) {
    assert.ok(published.has(kit), `${kit} must publish with the CLI to stay version-matched`);
  }
});
