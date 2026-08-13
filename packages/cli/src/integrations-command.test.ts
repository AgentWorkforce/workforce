import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatIntegrationsTable,
  parseIntegrationsArgs,
  runIntegrationsCommand
} from './integrations-command.js';
import type { IntegrationsDocument } from '@agentworkforce/deploy';

const fixture: IntegrationsDocument = {
  workspaceId: 'ws-1',
  auth: 'authenticated',
  integrations: [
    {
      id: 'github',
      adapterSlug: 'github',
      inCloudCatalog: true,
      connected: true,
      registrationHealth: { workspace: { registered: true, healthy: true } },
      connections: [
        {
          connectionId: 'conn-github',
          scope: 'workspace',
          serviceAccountName: null,
          status: 'ready',
          registrationHealth: { registered: true, healthy: true }
        }
      ],
      triggers: ['issues.opened', 'pull_request.opened', 'pull_request.closed'],
      triggerSource: 'catalog'
    },
    {
      id: 'google-mail',
      adapterSlug: 'gmail',
      inCloudCatalog: true,
      connected: false,
      connections: [],
      triggers: ['message.received'],
      triggerSource: 'catalog'
    }
  ],
  warnings: []
};

function capture() {
  return {
    stdout: {
      text: '',
      write(chunk: string) {
        this.text += chunk;
      }
    },
    stderr: {
      text: '',
      write(chunk: string) {
        this.text += chunk;
      }
    }
  };
}

test('parseIntegrationsArgs parses flags and provider', () => {
  assert.deepEqual(parseIntegrationsArgs(['--all', '--json', '--workspace=ws-1', 'gmail']), {
    all: true,
    json: true,
    workspace: 'ws-1',
    provider: 'gmail'
  });
});

test('formatIntegrationsTable renders provider aliases, scopes, and trigger summaries', () => {
  const table = formatIntegrationsTable(fixture);
  assert.match(table, /PROVIDER\s+CONNECTED\s+SCOPE\s+TRIGGERS/);
  assert.match(table, /github\s+✓\s+workspace\s+3 known \(issues\.opened, pull_request\.opened, \.\.\.\)/);
  assert.match(table, /google-mail \(gmail\)\s+—\s+1 known \(message\.received\)/);
});

test('runIntegrationsCommand writes only JSON to stdout in --json mode', async () => {
  const io = capture();
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    await runIntegrationsCommand(['--json'], {
      stdout: io.stdout,
      stderr: io.stderr,
      listIntegrations: async () => fixture
    });
    assert.equal(process.exitCode, 0);
    assert.equal(io.stderr.text, '');
    assert.deepEqual(JSON.parse(io.stdout.text), fixture);
  } finally {
    process.exitCode = previousExitCode;
  }
});

test('runIntegrationsCommand requires login for default status view', async () => {
  const io = capture();
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    await runIntegrationsCommand([], {
      stdout: io.stdout,
      stderr: io.stderr,
      listIntegrations: async () => ({
        ...fixture,
        workspaceId: null,
        auth: 'unauthenticated',
        integrations: fixture.integrations.map((row) => ({
          ...row,
          connected: null,
          connections: null
        }))
      })
    });
    assert.equal(process.exitCode, 1);
    assert.equal(io.stdout.text, '');
    assert.match(io.stderr.text, /agentworkforce login/);
    assert.match(io.stderr.text, /--all/);
  } finally {
    process.exitCode = previousExitCode;
  }
});

test('runIntegrationsCommand --all --json succeeds for partial logged-out offline catalog', async () => {
  const io = capture();
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  const warning =
    'cloud integration catalog unavailable; showing trigger catalog only (partial, cloud-only/connect-only integrations omitted): 503 catalog';
  try {
    await runIntegrationsCommand(['--all', '--json'], {
      stdout: io.stdout,
      stderr: io.stderr,
      listIntegrations: async () => ({
        ...fixture,
        workspaceId: null,
        auth: 'unauthenticated',
        integrations: fixture.integrations.map((row) => ({
          ...row,
          inCloudCatalog: false,
          connected: null,
          connections: null
        })),
        warnings: [warning]
      })
    });
    assert.equal(process.exitCode, 0);
    assert.match(io.stderr.text, /partial, cloud-only\/connect-only integrations omitted/);
    const parsed = JSON.parse(io.stdout.text) as IntegrationsDocument;
    assert.equal(parsed.auth, 'unauthenticated');
    assert.equal(parsed.integrations.every((row) => row.connected === null), true);
    assert.equal(parsed.warnings[0], warning);
  } finally {
    process.exitCode = previousExitCode;
  }
});

test('runIntegrationsCommand renders single-provider details and snippet', async () => {
  const io = capture();
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    await runIntegrationsCommand(['github'], {
      stdout: io.stdout,
      stderr: io.stderr,
      listIntegrations: async () => ({
        ...fixture,
        integrations: [fixture.integrations[0]]
      })
    });
    assert.equal(process.exitCode, 0);
    assert.match(io.stdout.text, /Triggers:\n  issues\.opened/);
    assert.match(io.stdout.text, /connectionId|conn-github/);
    assert.match(io.stdout.text, /registrationHealth/);
    assert.match(io.stdout.text, /"integrations": \{ "github": \{\} \}/);
    assert.match(io.stdout.text, /triggers: \{ "github": \[\{ "on": "issues\.opened" \}\] \}/);
  } finally {
    process.exitCode = previousExitCode;
  }
});
