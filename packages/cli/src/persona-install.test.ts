import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { loadLocalPersonas } from './local-personas.js';
import {
  expandHomePath,
  installPersonas,
  isLocalInstallSource,
  npmExecutable
} from './persona-install.js';

function withTemp<T>(fn: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), 'aw-persona-install-'));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function fullPersona(id: string, description = `${id} persona`): unknown {
  const runtime = {
    harness: 'codex',
    model: 'gpt-5.2',
    systemPrompt: `You are ${id}.`,
    harnessSettings: { reasoning: 'medium', timeoutSeconds: 300 }
  };
  return {
    id,
    intent: 'review',
    tags: ['review'],
    description,
    skills: [],
    tiers: {
      best: runtime,
      'best-value': runtime,
      minimum: runtime
    }
  };
}

test('isLocalInstallSource: npm package specs with versions are not treated as paths', () => {
  assert.equal(isLocalInstallSource('@scope/pkg@1.2.3'), false);
  assert.equal(isLocalInstallSource('@scope/pkg@latest'), false);
  assert.equal(isLocalInstallSource('./local-personas'), true);
  assert.equal(isLocalInstallSource('/tmp/local-personas'), true);
  assert.equal(isLocalInstallSource('~\\local-personas'), true);
  assert.equal(isLocalInstallSource('C:\\packs\\personas'), true);
  assert.equal(isLocalInstallSource('\\\\server\\share\\personas'), true);
  assert.equal(expandHomePath('~\\local-personas'), join(homedir(), 'local-personas'));
});

test('npmExecutable: uses the Windows npm shim when shell is false', () => {
  assert.equal(npmExecutable('win32'), 'npm.cmd');
  assert.equal(npmExecutable('darwin'), 'npm');
});

test('cleans npm temp directory when package resolution throws', () => {
  withTemp((root) => {
    let capturedTempDir: string | undefined;
    assert.throws(
      () =>
        installPersonas({
          source: '@example/personas',
          cwd: join(root, 'project'),
          resolveNpmPackage: (_spec, tempDir) => {
            capturedTempDir = tempDir;
            assert.ok(existsSync(tempDir));
            throw new Error('resolver failed');
          }
        }),
      /resolver failed/
    );
    assert.ok(capturedTempDir);
    assert.equal(existsSync(capturedTempDir), false);
  });
});

test('installs multiple personas from a local fixture package', () => {
  withTemp((root) => {
    const project = join(root, 'project');
    const pack = join(root, 'pack');
    writeJson(join(pack, 'personas', 'alpha.json'), fullPersona('alpha'));
    writeJson(join(pack, 'personas', 'beta.json'), fullPersona('beta'));

    const result = installPersonas({ source: pack, cwd: project });

    assert.equal(result.installed.length, 2);
    assert.equal(result.conflicts.length, 0);
    assert.ok(existsSync(join(project, '.agentworkforce', 'workforce', 'personas', 'alpha.json')));
    assert.ok(existsSync(join(project, '.agentworkforce', 'workforce', 'personas', 'beta.json')));
  });
});

test('reads package.json agentworkforce.personas metadata', () => {
  withTemp((root) => {
    const project = join(root, 'project');
    const pack = join(root, 'pack');
    writeJson(join(pack, 'package.json'), {
      name: '@example/personas',
      version: '1.0.0',
      agentworkforce: { personas: 'agent-definitions' }
    });
    writeJson(join(pack, 'agent-definitions', 'metadata-persona.json'), fullPersona('metadata-persona'));

    const result = installPersonas({ source: pack, cwd: project });

    assert.equal(result.personaDir, join(pack, 'agent-definitions'));
    assert.ok(
      existsSync(join(project, '.agentworkforce', 'workforce', 'personas', 'metadata-persona.json'))
    );
  });
});

test('falls back to top-level personas directory when metadata is absent', () => {
  withTemp((root) => {
    const project = join(root, 'project');
    const pack = join(root, 'pack');
    writeJson(join(pack, 'package.json'), {
      name: '@example/personas',
      version: '1.0.0'
    });
    writeJson(join(pack, 'personas', 'fallback.json'), fullPersona('fallback'));

    const result = installPersonas({ source: pack, cwd: project });

    assert.equal(result.personaDir, join(pack, 'personas'));
    assert.ok(existsSync(join(project, '.agentworkforce', 'workforce', 'personas', 'fallback.json')));
  });
});

test('refuses to overwrite an existing persona file by default', () => {
  withTemp((root) => {
    const project = join(root, 'project');
    const pack = join(root, 'pack');
    const target = join(project, '.agentworkforce', 'workforce', 'personas', 'conflict.json');
    writeJson(target, { id: 'conflict', local: true });
    writeJson(join(pack, 'personas', 'conflict.json'), fullPersona('conflict', 'upstream'));

    const result = installPersonas({ source: pack, cwd: project });

    assert.equal(result.installed.length, 0);
    assert.deepEqual(result.conflicts.map((c) => c.id), ['conflict']);
    assert.deepEqual(readJson(target), { id: 'conflict', local: true });
  });
});

test('--overwrite replaces existing persona files', () => {
  withTemp((root) => {
    const project = join(root, 'project');
    const pack = join(root, 'pack');
    const target = join(project, '.agentworkforce', 'workforce', 'personas', 'replace-me.json');
    writeJson(target, { id: 'replace-me', description: 'old' });
    writeJson(join(pack, 'personas', 'replace-me.json'), fullPersona('replace-me', 'new'));

    const result = installPersonas({ source: pack, cwd: project, overwrite: true });

    assert.equal(result.installed.length, 1);
    assert.equal(result.conflicts.length, 0);
    assert.equal((readJson(target) as { description: string }).description, 'new');
  });
});

test('relative local path installs work end-to-end', () => {
  withTemp((root) => {
    const project = join(root, 'project');
    const pack = join(project, 'local-personas');
    writeJson(join(pack, 'personas', 'relative.json'), fullPersona('relative'));

    const result = installPersonas({ source: './local-personas', cwd: project });

    assert.equal(result.installed.length, 1);
    assert.ok(existsSync(join(project, '.agentworkforce', 'workforce', 'personas', 'relative.json')));
  });
});

test('--persona installs only requested ids and supports repeated selections', () => {
  withTemp((root) => {
    const project = join(root, 'project');
    const pack = join(root, 'pack');
    writeJson(join(pack, 'personas', 'alpha.json'), fullPersona('alpha'));
    writeJson(join(pack, 'personas', 'beta.json'), fullPersona('beta'));
    writeJson(join(pack, 'personas', 'gamma.json'), fullPersona('gamma'));

    const result = installPersonas({
      source: pack,
      cwd: project,
      personaIds: ['gamma', 'alpha']
    });

    assert.deepEqual(result.installed.map((p) => p.id), ['gamma', 'alpha']);
    const targetDir = join(project, '.agentworkforce', 'workforce', 'personas');
    assert.ok(existsSync(join(targetDir, 'alpha.json')));
    assert.ok(!existsSync(join(targetDir, 'beta.json')));
    assert.ok(existsSync(join(targetDir, 'gamma.json')));
  });
});

test('--persona unknown id fails before copying anything', () => {
  withTemp((root) => {
    const project = join(root, 'project');
    const pack = join(root, 'pack');
    writeJson(join(pack, 'personas', 'alpha.json'), fullPersona('alpha'));

    assert.throws(
      () => installPersonas({ source: pack, cwd: project, personaIds: ['missing'] }),
      /missing/
    );
    assert.ok(!existsSync(join(project, '.agentworkforce', 'workforce', 'personas', 'alpha.json')));
  });
});

test('flattens nested persona file layouts into the target personas directory', () => {
  withTemp((root) => {
    const project = join(root, 'project');
    const pack = join(root, 'pack');
    writeJson(join(pack, 'personas', 'nested', 'deep.json'), fullPersona('deep'));

    installPersonas({ source: pack, cwd: project });

    const targetDir = join(project, '.agentworkforce', 'workforce', 'personas');
    assert.ok(existsSync(join(targetDir, 'deep.json')));
    assert.ok(!existsSync(join(targetDir, 'nested', 'deep.json')));
  });
});

test('filename collisions across installed packages conflict, then overwrite when requested', () => {
  withTemp((root) => {
    const project = join(root, 'project');
    const packA = join(root, 'pack-a');
    const packB = join(root, 'pack-b');
    const target = join(project, '.agentworkforce', 'workforce', 'personas', 'code-reviewer.json');
    writeJson(join(packA, 'personas', 'code-reviewer.json'), fullPersona('reviewer-a', 'from a'));
    writeJson(join(packB, 'personas', 'code-reviewer.json'), fullPersona('reviewer-b', 'from b'));

    installPersonas({ source: packA, cwd: project });
    const conflict = installPersonas({ source: packB, cwd: project });
    assert.deepEqual(conflict.conflicts.map((c) => c.fileName), ['code-reviewer.json']);
    assert.equal((readJson(target) as { description: string }).description, 'from a');

    const overwritten = installPersonas({ source: packB, cwd: project, overwrite: true });
    assert.equal(overwritten.conflicts.length, 0);
    assert.equal((readJson(target) as { description: string }).description, 'from b');
  });
});

test('installed standalone personas are loaded through the cwd cascade', () => {
  withTemp((root) => {
    const project = join(root, 'project');
    const pack = join(root, 'pack');
    writeJson(join(pack, 'personas', 'pack-reviewer.json'), fullPersona('pack-reviewer'));

    installPersonas({ source: pack, cwd: project });

    const loaded = loadLocalPersonas({
      cwd: project,
      homeDir: join(root, 'home', '.agentworkforce', 'workforce', 'personas')
    });
    assert.deepEqual(loaded.warnings, []);
    assert.ok(loaded.byId.has('pack-reviewer'));
    assert.equal(loaded.sources.get('pack-reviewer'), 'cwd');
  });
});
