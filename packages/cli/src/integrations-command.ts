import {
  IntegrationsListError,
  UnknownIntegrationProviderError,
  listIntegrations,
  resolveIntegrationProvider,
  type IntegrationsDocument,
  type IntegrationRow,
  type ListIntegrationsOptions
} from '@agentworkforce/deploy';

interface IntegrationsCommandOptions {
  all?: boolean;
  json?: boolean;
  provider?: string;
  workspace?: string;
  cloudUrl?: string;
}

interface Writable {
  write(chunk: string): unknown;
}

interface RunIntegrationsCommandDeps {
  stdout?: Writable;
  stderr?: Writable;
  env?: NodeJS.ProcessEnv;
  listIntegrations?: typeof listIntegrations;
}

export async function runIntegrationsCommand(
  args: readonly string[],
  deps: RunIntegrationsCommandDeps = {}
): Promise<void> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  try {
    if (args[0] === '-h' || args[0] === '--help') {
      stdout.write(INTEGRATIONS_USAGE);
      process.exitCode = 0;
      return;
    }

    const opts = parseIntegrationsArgs(args);
    const listOpts: ListIntegrationsOptions = {
      ...(opts.workspace ? { workspaceId: opts.workspace } : {}),
      ...(opts.cloudUrl ? { cloudUrl: opts.cloudUrl } : {}),
      ...(deps.env ? { env: deps.env } : {}),
      ...(opts.provider ? { provider: opts.provider } : {})
    };
    const document = await (deps.listIntegrations ?? listIntegrations)(listOpts);

    if (document.auth === 'unauthenticated' && !opts.all && !opts.provider) {
      stderr.write(
        'agentworkforce integrations requires login for connection status.\n' +
          'Run `agentworkforce login`, or use `agentworkforce integrations --all` for the offline catalog.\n'
      );
      process.exitCode = 1;
      return;
    }

    for (const warning of document.warnings) stderr.write(`warning: ${warning}\n`);

    if (opts.json) {
      stdout.write(`${JSON.stringify(document, null, 2)}\n`);
    } else if (opts.provider) {
      stdout.write(formatSingleProvider(document.integrations[0]));
    } else {
      stdout.write(formatIntegrationsTable(document));
    }
    process.exitCode = 0;
  } catch (err) {
    if (err instanceof UnknownIntegrationProviderError) {
      stderr.write(`${formatErrorMessage(err)}\n`);
    } else if (err instanceof IntegrationsListError) {
      stderr.write(`${formatErrorMessage(err)}\n`);
    } else {
      stderr.write(`agentworkforce integrations failed: ${formatErrorMessage(err)}\n`);
    }
    process.exitCode = 1;
  }
}

export function parseIntegrationsArgs(args: readonly string[]): IntegrationsCommandOptions {
  const opts: IntegrationsCommandOptions = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--all') {
      opts.all = true;
    } else if (arg === '--json') {
      opts.json = true;
    } else if (arg === '--workspace') {
      opts.workspace = expectValue('--workspace', args[++i]);
    } else if (arg.startsWith('--workspace=')) {
      opts.workspace = expectInlineValue('--workspace', arg.slice('--workspace='.length));
    } else if (arg === '--cloud-url') {
      opts.cloudUrl = expectValue('--cloud-url', args[++i]);
    } else if (arg.startsWith('--cloud-url=')) {
      opts.cloudUrl = expectInlineValue('--cloud-url', arg.slice('--cloud-url='.length));
    } else if (arg.startsWith('-')) {
      throw new Error(`integrations: unexpected argument "${arg}"`);
    } else if (opts.provider) {
      throw new Error(`integrations: unexpected argument "${arg}"`);
    } else {
      opts.provider = arg;
    }
  }
  return opts;
}

export function filterIntegrationsDocument(
  document: IntegrationsDocument,
  provider: string | undefined,
  includeTriggers: boolean
): IntegrationsDocument {
  const integrations = provider
    ? document.integrations.filter((row) => row.id === resolveIntegrationProvider(provider, document.integrations))
    : document.integrations;
  return {
    ...document,
    integrations: includeTriggers
      ? integrations
      : integrations.map((row) => ({ ...row, triggers: [], triggerSource: 'none' as const }))
  };
}

export function formatIntegrationsTable(document: IntegrationsDocument): string {
  const rows = document.integrations.map((row) => ({
    provider: providerLabel(row),
    connected: connectedLabel(row, document.auth),
    scope: row.connections?.length ? unique(row.connections.map((c) => c.scope)).join(' ') : '',
    triggers: triggerLabel(row)
  }));
  const header = {
    provider: 'PROVIDER',
    connected: 'CONNECTED',
    scope: 'SCOPE',
    triggers: 'TRIGGERS'
  };
  const widths = {
    provider: Math.max(header.provider.length, ...rows.map((row) => row.provider.length)),
    connected: Math.max(header.connected.length, ...rows.map((row) => row.connected.length)),
    scope: Math.max(header.scope.length, ...rows.map((row) => row.scope.length))
  };
  const line = (row: typeof header) =>
    `${row.provider.padEnd(widths.provider)}  ${row.connected.padEnd(widths.connected)}  ${row.scope.padEnd(widths.scope)}  ${row.triggers}`.trimEnd();
  return `${[line(header), ...rows.map(line)].join('\n')}\n`;
}

export function formatSingleProvider(row: IntegrationRow | undefined): string {
  if (!row) return '';
  const lines = [`${providerLabel(row)}`, '', 'Triggers:'];
  if (row.triggers.length === 0) {
    lines.push('  no known triggers');
  } else {
    for (const trigger of row.triggers) lines.push(`  ${trigger}`);
  }
  lines.push('', 'Connections:');
  if (row.connections === null) {
    lines.push('  unknown (not authenticated)');
  } else if (row.connections.length === 0) {
    lines.push('  none');
  } else {
    for (const connection of row.connections) {
      lines.push(`  ${connection.connectionId}`);
      lines.push(`    scope: ${connection.scope}`);
      if (connection.serviceAccountName) {
        lines.push(`    serviceAccountName: ${connection.serviceAccountName}`);
      }
      lines.push(`    status: ${connection.status}`);
      if (connection.registrationHealth) {
        lines.push(`    registrationHealth: ${JSON.stringify(connection.registrationHealth)}`);
      }
    }
  }
  if (row.registrationHealth) {
    lines.push('', 'Registration health:', `  ${JSON.stringify(row.registrationHealth)}`);
  }
  const firstTrigger = row.triggers[0] ?? 'event.name';
  lines.push(
    '',
    'Snippet:',
    '// persona.json',
    `"integrations": { "${row.id}": {} }`,
    '',
    '// agent.ts',
    `triggers: { "${row.id}": [{ "on": "${firstTrigger}" }] }`
  );
  return `${lines.join('\n')}\n`;
}

function providerLabel(row: Pick<IntegrationRow, 'id' | 'adapterSlug'>): string {
  return row.adapterSlug === row.id ? row.id : `${row.id} (${row.adapterSlug})`;
}

function connectedLabel(row: IntegrationRow, auth: IntegrationsDocument['auth']): string {
  if (auth === 'unauthenticated' || row.connected === null) return '?';
  return row.connected ? '✓' : '—';
}

function triggerLabel(row: IntegrationRow): string {
  const suffix = row.inCloudCatalog ? '' : ' - not in cloud catalog';
  if (row.triggerSource === 'none') return `no known triggers (connect-only)${suffix}`;
  const sample = row.triggers.slice(0, 2).join(', ');
  const more = row.triggers.length > 2 ? ', ...' : '';
  return `${row.triggers.length} known (${sample}${more})${suffix}`;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function expectValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith('-')) throw new Error(`${flag} requires a value`);
  return value;
}

function expectInlineValue(flag: string, value: string): string {
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function formatErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const INTEGRATIONS_USAGE = `Usage: agentworkforce integrations [provider] [--all] [--json] [--workspace <id>] [--cloud-url <url>]

Discover workforce integrations, connection status, and known trigger events.
`;
