import {
  defineAgent,
  readJsonFile,
  writeJsonFile,
  resolveMountRoot,
  type IntegrationClientOptions,
  type WorkforceCtx,
  type WorkforceEvent
} from '@agentworkforce/runtime';

type GmailMessageFile = {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  summary?: string;
  subject?: string;
  from?: string;
  bodyText?: string;
  bodyHtml?: string;
  snippet?: string;
  canonicalPath?: string;
  [key: string]: unknown;
};

type GithubPullRequestFile = {
  number?: number;
  state?: string;
  merged?: boolean;
  merged_at?: string | null;
  mergedAt?: string | null;
  title?: string;
  html_url?: string;
  url?: string;
  [key: string]: unknown;
};

type GoogleMailIndexRow = {
  id?: string;
  path?: string;
  canonicalPath?: string;
  title?: string;
  summary?: string;
  senderEmail?: string;
  senderKey?: string;
  labels?: string[];
  updatedAt?: string;
  [key: string]: unknown;
};

function vfsClient(): IntegrationClientOptions {
  return { relayfileMountRoot: resolveMountRoot({}) };
}

function inputDefault(ctx: WorkforceCtx, name: string): string {
  const spec = ctx.persona.inputSpecs?.[name];
  const envName = spec?.env ?? name;
  const fromEnv = process.env[envName];
  const value =
    (fromEnv !== undefined && fromEnv !== '' ? fromEnv : undefined) ??
    ctx.persona.inputs?.[name] ??
    spec?.default;
  if (value === undefined) throw new Error(`${name} input is required`);
  return value;
}

function parseOptionalCsv(raw: string): string[] {
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function parseBoolean(raw: string): boolean {
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

function parsePositiveInt(raw: string, fallback: number): number {
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isCronRun(event: WorkforceEvent, name: string): boolean {
  return event.source === 'cron' && event.name === name;
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function collectMessageText(message: GmailMessageFile): string {
  return [
    normalizeText(message.subject),
    normalizeText(message.summary),
    normalizeText(message.snippet),
    normalizeText(message.bodyText),
    normalizeText(message.bodyHtml)
  ].join('\n');
}

function extractGithubPrReference(message: GmailMessageFile): { owner: string; repo: string; number: number } | null {
  const text = collectMessageText(message);

  const urlMatch = text.match(/github\.com\/([^\s/]+)\/([^\s/#?]+)\/pull\/(\d+)/i);
  if (urlMatch) {
    return {
      owner: urlMatch[1]!,
      repo: urlMatch[2]!,
      number: Number.parseInt(urlMatch[3]!, 10)
    };
  }

  const slashPair = text.match(/\b([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\s*#(\d+)\b/);
  if (slashPair) {
    return {
      owner: slashPair[1]!,
      repo: slashPair[2]!,
      number: Number.parseInt(slashPair[3]!, 10)
    };
  }

  return null;
}

function isAllowedRepo(
  ref: { owner: string; repo: string },
  ownerAllowlist: string[],
  repoAllowlist: string[]
): boolean {
  const owner = ref.owner.toLowerCase();
  const fullRepo = `${ref.owner}/${ref.repo}`.toLowerCase();
  if (ownerAllowlist.length > 0 && !ownerAllowlist.some((entry) => entry.toLowerCase() === owner)) {
    return false;
  }
  if (repoAllowlist.length > 0 && !repoAllowlist.some((entry) => entry.toLowerCase() === fullRepo)) {
    return false;
  }
  return true;
}

function isMergedPullRequest(pr: GithubPullRequestFile): boolean {
  if (pr.merged === true) return true;
  if (typeof pr.mergedAt === 'string' && pr.mergedAt.length > 0) return true;
  if (typeof pr.merged_at === 'string' && pr.merged_at.length > 0) return true;
  return false;
}

function looksLikeGithubNotification(row: GoogleMailIndexRow): boolean {
  const sender = normalizeText(row.senderEmail).toLowerCase();
  if (sender === 'notifications@github.com') return true;
  const summary = [normalizeText(row.title), normalizeText(row.summary)].join('\n').toLowerCase();
  return summary.includes('github');
}

function matchesInboxQueryHints(row: GoogleMailIndexRow, query: string): boolean {
  const lowered = query.toLowerCase();
  const labels = Array.isArray(row.labels) ? row.labels.map((value) => String(value).toUpperCase()) : [];
  if (lowered.includes('in:inbox') && !labels.includes('INBOX')) {
    return false;
  }
  if (lowered.includes('from:notifications@github.com')) {
    return normalizeText(row.senderEmail).toLowerCase() === 'notifications@github.com';
  }
  return true;
}

async function listCandidateMessageIds(
  client: IntegrationClientOptions,
  query: string,
  maxResults: number
): Promise<string[]> {
  const rows = await readJsonFile<GoogleMailIndexRow[]>(
    client,
    'google-mail',
    'listMessages',
    '/google-mail/messages/_index.json'
  );

  return rows
    .filter((row) => looksLikeGithubNotification(row) && matchesInboxQueryHints(row, query))
    .slice(0, maxResults)
    .map((row) => row.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

async function loadGoogleMailMessage(
  client: IntegrationClientOptions,
  messageId: string
): Promise<GmailMessageFile> {
  return await readJsonFile<GmailMessageFile>(
    client,
    'google-mail',
    'getMessage',
    `/google-mail/messages/by-id/${encodeURIComponent(messageId)}.json`
  );
}

async function loadPullRequest(
  client: IntegrationClientOptions,
  ref: { owner: string; repo: string; number: number }
): Promise<GithubPullRequestFile> {
  return await readJsonFile<GithubPullRequestFile>(
    client,
    'github',
    'getPullRequest',
    `/github/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/pulls/by-id/${ref.number}.json`
  );
}

async function archiveGoogleMailMessage(
  client: IntegrationClientOptions,
  message: GmailMessageFile,
  messageId: string
): Promise<void> {
  const canonicalPath =
    typeof message.canonicalPath === 'string' && message.canonicalPath.length > 0
      ? message.canonicalPath
      : `/google-mail/messages/${encodeURIComponent(messageId)}.json`;

  const currentLabels = Array.isArray(message.labelIds)
    ? message.labelIds.map((label) => String(label))
    : [];
  const nextLabels = currentLabels.filter((label) => label.toUpperCase() !== 'INBOX');

  await writeJsonFile(
    client,
    'google-mail',
    'modify-message',
    canonicalPath,
    {
      id: messageId,
      removeLabelIds: ['INBOX'],
      ...(nextLabels.length > 0 ? { labelIds: nextLabels } : {})
    }
  );
}

export default defineAgent({
  schedules: [{ name: 'hourly-archive-pass', cron: '0 * * * *', tz: 'Europe/Oslo' }],
  handler: async (ctx, event) => {
    if (!isCronRun(event, 'hourly-archive-pass')) {
      ctx.log('warn', 'github-merged-email-archiver.ignored', { source: event.source });
      return;
    }

    const client = vfsClient();
    const gmailQuery = inputDefault(ctx, 'GMAIL_QUERY');
    const ownerAllowlist = parseOptionalCsv(inputDefault(ctx, 'GITHUB_OWNER_ALLOWLIST'));
    const repoAllowlist = parseOptionalCsv(inputDefault(ctx, 'GITHUB_REPO_ALLOWLIST'));
    const dryRun = parseBoolean(inputDefault(ctx, 'ARCHIVE_DRY_RUN'));
    const maxMessages = parsePositiveInt(inputDefault(ctx, 'MAX_MESSAGES_PER_RUN'), 50);

    ctx.log('info', 'github-merged-email-archiver.run.start', {
      gmailQuery,
      dryRun,
      maxMessages,
      ownerAllowlist,
      repoAllowlist
    });

    const candidateMessageIds = await listCandidateMessageIds(client, gmailQuery, maxMessages);
    let archivedCount = 0;
    let mergedCount = 0;
    let skippedCount = 0;

    for (const messageId of candidateMessageIds) {
      try {
        const message = await loadGoogleMailMessage(client, messageId);
        const ref = extractGithubPrReference(message);
        if (!ref) {
          skippedCount += 1;
          ctx.log('info', 'github-merged-email-archiver.skip.no-pr-ref', { messageId });
          continue;
        }

        if (!isAllowedRepo(ref, ownerAllowlist, repoAllowlist)) {
          skippedCount += 1;
          ctx.log('info', 'github-merged-email-archiver.skip.repo-filter', {
            messageId,
            owner: ref.owner,
            repo: ref.repo,
            number: ref.number
          });
          continue;
        }

        const pr = await loadPullRequest(client, ref);
        if (!pr) {
          skippedCount += 1;
          ctx.log('info', 'github-merged-email-archiver.skip.pr-missing', {
            messageId,
            owner: ref.owner,
            repo: ref.repo,
            number: ref.number
          });
          continue;
        }
        if (!isMergedPullRequest(pr)) {
          skippedCount += 1;
          ctx.log('info', 'github-merged-email-archiver.skip.not-merged', {
            messageId,
            owner: ref.owner,
            repo: ref.repo,
            number: ref.number,
            state: pr.state ?? 'unknown'
          });
          continue;
        }

        mergedCount += 1;

        if (dryRun) {
          ctx.log('info', 'github-merged-email-archiver.dry-run.archive', {
            messageId,
            owner: ref.owner,
            repo: ref.repo,
            number: ref.number,
            prUrl: pr.html_url ?? pr.url ?? null
          });
          continue;
        }

        await archiveGoogleMailMessage(client, message, messageId);
        archivedCount += 1;
        ctx.log('info', 'github-merged-email-archiver.archived', {
          messageId,
          threadId: message.threadId ?? null,
          owner: ref.owner,
          repo: ref.repo,
          number: ref.number,
          prUrl: pr.html_url ?? pr.url ?? null
        });
      } catch (error) {
        skippedCount += 1;
        ctx.log('error', 'github-merged-email-archiver.message.failed', {
          messageId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    ctx.log('info', 'github-merged-email-archiver.run.complete', {
      scanned: candidateMessageIds.length,
      mergedCount,
      archivedCount,
      skippedCount,
      dryRun
    });

    await ctx.memory.save(
      `github-merged-email-archiver scanned ${candidateMessageIds.length} messages, found ${mergedCount} merged PR matches, archived ${archivedCount}, dryRun=${dryRun}`,
      {
        tags: ['github-merged-email-archiver', dryRun ? 'dry-run' : 'live'],
        scope: 'workspace'
      }
    );
  }
});
