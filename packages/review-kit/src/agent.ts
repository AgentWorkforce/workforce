import {
  defineAgent,
  listDirectoryEntries,
  normalizeWritebackStatus,
  readJsonFile,
  writeJsonFile,
  type IntegrationClientOptions,
  type WorkforceCtx,
  type WorkforceEvent
} from '@agentworkforce/runtime';
import packageJson from '../package.json' with { type: 'json' };
import { hasSkipLabel, readPullRequest } from './pull-request.js';
import type {
  GitHubRepository,
  ReviewEvidence,
  ReviewEvidenceList,
  ReviewPullRequest
} from './types.js';

/** Read at bundle/install time so npm-version bumps cannot leave a stale source literal. */
export const REVIEW_KIT_VERSION = packageJson.version;

const DEFAULT_TRIGGER_EVENTS = ['pull_request.opened', 'pull_request.synchronize'] as const;

export interface DefineReviewAgentOptions<
  Evidence extends ReviewEvidenceList = ReviewEvidenceList
> {
  repo: GitHubRepository;
  charter: string;
  /** Stable lowercase slug used in logs, markers, and the default skip label. */
  lens: string;
  evidence: Evidence;
  /** Defaults to `no-${lens}-review`; runtime SKIP_LABELS can override it. */
  skipLabels?: readonly string[];
  /** Defaults to true. */
  skipDrafts?: boolean;
}

interface ReviewAgentDependencies {
  client?: () => IntegrationClientOptions;
  writeComment?: typeof writeJsonFile;
  readRecord?: (client: IntegrationClientOptions, path: string) => Promise<unknown>;
  listEntries?: (client: IntegrationClientOptions, path: string) => Promise<string[]>;
}

interface ParsedReviewAgentOptions extends DefineReviewAgentOptions {
  owner: string;
  repository: string;
  paths: readonly [string, string];
  skipLabels: readonly string[];
  skipDrafts: boolean;
}

/** Env first, then resolved cloud inputs, then the persona input default. */
export function reviewInput(ctx: WorkforceCtx, name: string): string | undefined {
  const spec = ctx.persona?.inputSpecs?.[name];
  const value =
    process.env[spec?.env ?? name] ?? ctx.persona?.inputs?.[name] ?? spec?.default;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function reviewMountPaths(
  repo: GitHubRepository
): readonly [pulls: string, issueComments: string] {
  const { owner, repository } = parseRepo(repo);
  return [
    `/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/pulls/**`,
    `/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/issues/**`
  ];
}

/**
 * Factory for the generic PR-review plumbing. The returned trigger paths are
 * already concrete strings when deploy's extractor evaluates this call; no
 * template literal or `where` rule reaches the uploaded agent spec.
 */
export function defineReviewAgent<const Evidence extends ReviewEvidenceList>(
  options: DefineReviewAgentOptions<Evidence>
) {
  const parsed = parseOptions(options);
  const paths = [...parsed.paths];
  return defineAgent({
    triggers: {
      github: DEFAULT_TRIGGER_EVENTS.map((on) => ({
        on,
        paths,
        maxConcurrency: 1
      }))
    },
    handler: createParsedReviewHandler(parsed)
  });
}

/** @internal Exported for focused contract tests; applications use defineReviewAgent. */
export function createReviewHandler(
  options: DefineReviewAgentOptions,
  dependencies: ReviewAgentDependencies = {}
): (ctx: WorkforceCtx, event: WorkforceEvent) => Promise<void> {
  return createParsedReviewHandler(parseOptions(options), dependencies);
}

function createParsedReviewHandler(
  parsed: ParsedReviewAgentOptions,
  dependencies: ReviewAgentDependencies = {}
): (ctx: WorkforceCtx, event: WorkforceEvent) => Promise<void> {
  const makeClient =
    dependencies.client ??
    // Never turn resolveMountRoot's cwd fallback into an explicit mount.
    // requireConfiguredReviewMount keeps read/list/write on one real filesystem boundary.
    (() => ({ writebackTimeoutMs: 0 }));
  const writeComment = dependencies.writeComment ?? writeJsonFile;
  const readRecord =
    dependencies.readRecord ??
    ((client, path) => readJsonFile<unknown>(client, 'github', 'review-idempotency', path));
  const listEntries =
    dependencies.listEntries ??
    ((client, path) =>
      listDirectoryEntries(client, 'github', 'review-idempotency', path));

  return async (ctx, event) => {
    ctx.log?.('info', 'review-kit.started', {
      version: REVIEW_KIT_VERSION,
      lens: parsed.lens,
      event: event.type
    });

    if (!event.type.startsWith('github.pull_request.')) {
      ctx.log?.('info', 'review-kit.skipped', {
        lens: parsed.lens,
        reason: 'non-pull-request-event',
        eventType: event.type
      });
      return;
    }

    const payload = (await event.expand('full')).data;
    const pullRequest = readPullRequest(payload);
    if (!pullRequest) {
      const root = asRecord(payload);
      ctx.log?.('info', 'review-kit.skipped', {
        lens: parsed.lens,
        reason: 'unreadable-pull-request',
        keys: root ? Object.keys(root).join(',') : typeof payload
      });
      return;
    }

    if (`${pullRequest.owner}/${pullRequest.repo}`.toLowerCase() !== parsed.repo.toLowerCase()) {
      ctx.log?.('info', 'review-kit.skipped', {
        lens: parsed.lens,
        pr: pullRequest.number,
        reason: 'different-repository'
      });
      return;
    }

    const runtimeSkipLabels = parseCommaSeparated(reviewInput(ctx, 'SKIP_LABELS'));
    const skipLabel = hasSkipLabel(
      pullRequest,
      runtimeSkipLabels.length > 0 ? runtimeSkipLabels : parsed.skipLabels
    );
    if (skipLabel) {
      ctx.log?.('info', 'review-kit.skipped', {
        lens: parsed.lens,
        pr: pullRequest.number,
        reason: `label:${skipLabel}`
      });
      return;
    }
    if (parsed.skipDrafts && pullRequest.draft) {
      ctx.log?.('info', 'review-kit.skipped', {
        lens: parsed.lens,
        pr: pullRequest.number,
        reason: 'draft'
      });
      return;
    }

    const headSha = await resolveHeadSha(ctx, pullRequest);
    const commandPath = reviewCommandPath(pullRequest, parsed.lens, headSha);
    const marker = idempotencyMarker(parsed.lens, headSha);
    const client = requireConfiguredReviewMount(makeClient());
    if (
      await reviewAlreadyExists(
        client,
        commentsDirectory(pullRequest),
        commandPath,
        marker,
        readRecord,
        listEntries
      )
    ) {
      ctx.log?.('info', 'review-kit.skipped', {
        lens: parsed.lens,
        pr: pullRequest.number,
        headSha,
        reason: 'already-reviewed'
      });
      return;
    }

    await requireCharter(ctx, parsed.charter);
    const gathered = await Promise.all(
      parsed.evidence.map((provider) =>
        provider.collect({
          ctx,
          pullRequest: { ...pullRequest, headSha },
          payload,
          charterPath: parsed.charter
        })
      )
    );

    const run = await ctx.harness.run({
      cwd: ctx.sandbox.cwd,
      prompt: reviewPrompt(pullRequest, parsed.charter, parsed.lens, gathered)
    });
    if (run.exitCode !== 0) {
      throw new Error(
        `${parsed.lens} review harness failed (exit ${run.exitCode}) for PR #${pullRequest.number}`
      );
    }
    const body = reviewBody(run.output);
    if (!body) {
      throw new Error(`${parsed.lens} review harness produced no review for PR #${pullRequest.number}`);
    }

    const result = await writeComment(
      client,
      'github',
      'comment',
      commandPath,
      {
        body: `${body}\n\n<sub>${parsed.lens} review · \`${parsed.charter}\`</sub>\n${marker}`
      }
    );
    const delivery = normalizeWritebackStatus(result);
    ctx.log?.(
      delivery.state === 'succeeded' ? 'info' : 'warn',
      delivery.state === 'succeeded'
        ? 'review-kit.delivery.confirmed'
        : 'review-kit.delivery.unconfirmed',
      {
        lens: parsed.lens,
        pr: pullRequest.number,
        headSha,
        path: commandPath,
        state: delivery.state
      }
    );
  };
}

/**
 * The review is what follows the verdict line — everything before it is thinking.
 *
 * `run.output` is the harness's raw stdout, so it carries whatever the model said
 * on its way to an answer: "Evidence confirmed.", "I have all evidence needed.",
 * a draft findings list, "Writing the review now." Posting that verbatim buries
 * the findings under the search that produced them.
 *
 * This cannot be fixed in the charter. A charter can forbid a preamble, and the
 * model still emits one, because you cannot instruct a model not to think — only
 * decline to publish the thinking. Measured on a real reviewer against a
 * 150-word cap: 537 words, then 256 after the ban was sharpened, then 191, then
 * 187 after the whole contract was moved to the top of the charter where it is
 * read first. Stripping in code took the same reviewer to 153 on the next run.
 * The findings were always inside budget; only the preamble was not.
 *
 * So the charter owns the SHAPE (which it gets right reliably) and the kit owns
 * the BOUNDARY. Same reason `agents/review` strips its own trailing `READY`
 * sentinel rather than trusting the model to omit it.
 *
 * Cuts at the LAST verdict line, not the first: a model that drafts its findings
 * before writing them emits two, and the real review is the final one.
 *
 * The match is deliberately tolerant of how the model bolds the line —
 * `**Verdict:`, `**Verdict**:`, `**Verdict** :`, any casing. The charter asks for
 * one exact form and the production reviewer emits it, but a stricter pattern
 * fails OPEN in the worst way: an unmatched line publishes the entire preamble,
 * which is the thing this function exists to prevent. Being lax here costs
 * nothing; being strict costs the whole feature on a formatting wobble.
 *
 * A body with no verdict line at all means the model ignored the format; return
 * it unchanged rather than nothing, because a malformed review still beats
 * silence — for an advisory agent, silence reads as approval.
 */
export function reviewBody(output: string): string {
  const text = (output ?? '').trim();
  let start = -1;
  for (const match of text.matchAll(/^\*\*Verdict(?:\*\*)?\s*:/gimu)) {
    start = match.index ?? start;
  }
  return start >= 0 ? text.slice(start).trim() : text;
}

export function idempotencyMarker(lens: string, headSha: string): string {
  return `<!-- agentworkforce-review:${lens}:${headSha} -->`;
}

function parseOptions(options: DefineReviewAgentOptions): ParsedReviewAgentOptions {
  const { owner, repository } = parseRepo(options.repo);
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62})$/u.test(options.lens)) {
    throw new TypeError('review lens must be a lowercase slug');
  }
  assertRepoRelativePath(options.charter, 'review charter');
  if (options.evidence.length === 0) {
    throw new TypeError('review agent requires at least one evidence provider');
  }
  const skipLabels = (options.skipLabels ?? [`no-${options.lens}-review`])
    .map((label) => label.trim())
    .filter(Boolean);
  if (skipLabels.length === 0) throw new TypeError('review skipLabels cannot be empty');
  return {
    ...options,
    owner,
    repository,
    paths: reviewMountPaths(options.repo),
    skipLabels,
    skipDrafts: options.skipDrafts ?? true
  };
}

function parseRepo(repo: GitHubRepository): { owner: string; repository: string } {
  const parts = repo.split('/');
  if (parts.length !== 2 || parts.some((part) => !part.trim())) {
    throw new TypeError(`review repo must be exactly "owner/repo"; got "${repo}"`);
  }
  return { owner: parts[0], repository: parts[1] };
}

function assertRepoRelativePath(path: string, label: string): void {
  if (!path.trim() || path.startsWith('/') || path.split('/').includes('..')) {
    throw new TypeError(`${label} must be a safe repo-relative path`);
  }
}

function parseCommaSeparated(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function requireConfiguredReviewMount(client: IntegrationClientOptions): IntegrationClientOptions {
  const mountRoot = [
    client.relayfileMountRoot,
    client.relayfileRoot,
    client.mountRoot,
    process.env.RELAYFILE_MOUNT_PATH,
    process.env.WORKSPACE_ROOT,
    process.env.WORKFORCE_SANDBOX_ROOT,
    process.env.RELAYFILE_MOUNT_ROOT,
    process.env.RELAYFILE_ROOT
  ].find((value) => typeof value === 'string' && value.trim());
  if (!mountRoot) {
    throw new Error(
      'review-kit requires a configured Relayfile mount for durable head-SHA idempotency'
    );
  }
  return client;
}

async function requireCharter(ctx: WorkforceCtx, charterPath: string): Promise<void> {
  let charter: string;
  try {
    charter = await ctx.sandbox.readFile(`${ctx.sandbox.cwd}/${charterPath}`);
  } catch (error) {
    throw new Error(`review charter is missing ${charterPath}`, { cause: error });
  }
  if (!charter.trim()) throw new Error(`review charter ${charterPath} is empty`);
}

async function resolveHeadSha(ctx: WorkforceCtx, pullRequest: ReviewPullRequest): Promise<string> {
  if (pullRequest.headSha) return pullRequest.headSha;
  const result = await ctx.sandbox.exec('git rev-parse HEAD', { cwd: ctx.sandbox.cwd });
  const candidate = result.output.trim();
  if (result.exitCode === 0 && /^[a-f\d]{7,64}$/iu.test(candidate)) return candidate.toLowerCase();
  throw new Error(`cannot derive a head-SHA idempotency key for PR #${pullRequest.number}`);
}

function reviewCommandPath(
  pullRequest: Pick<ReviewPullRequest, 'owner' | 'repo' | 'number'>,
  lens: string,
  headSha: string
): string {
  return `/github/repos/${encodeURIComponent(pullRequest.owner)}/${encodeURIComponent(
    pullRequest.repo
  )}/issues/${pullRequest.number}/comments/review-${lens}-${headSha}.json`;
}

function commentsDirectory(
  pullRequest: Pick<ReviewPullRequest, 'owner' | 'repo' | 'number'>
): string {
  return `/github/repos/${encodeURIComponent(pullRequest.owner)}/${encodeURIComponent(
    pullRequest.repo
  )}/issues/${pullRequest.number}/comments`;
}

async function reviewAlreadyExists(
  client: IntegrationClientOptions,
  directory: string,
  commandPath: string,
  marker: string,
  readRecord: (client: IntegrationClientOptions, path: string) => Promise<unknown>,
  listEntries: (client: IntegrationClientOptions, path: string) => Promise<string[]>
): Promise<boolean> {
  // Pending/unconfirmed delivery: the deterministic draft still exists.
  try {
    await readRecord(client, commandPath);
    return true;
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }

  // Confirmed delivery: Relayfile renames collection drafts to either the
  // canonical directory record (`<id>/meta.json`) or the legacy flat
  // `<id>.json` shape. Scan both for the hidden head-SHA marker.
  const entries = await listEntries(client, directory);
  for (const entry of entries) {
    if (entry === commandPath.slice(directory.length + 1)) continue;
    const candidate = entry.endsWith('.json')
      ? `${directory}/${entry}`
      : `${directory}/${entry}/meta.json`;
    try {
      const value = await readRecord(client, candidate);
      if (JSON.stringify(value).includes(marker)) return true;
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }
  return false;
}

function isMissingFile(error: unknown): boolean {
  const errorRecord = asRecord(error);
  const code = errorRecord?.code;
  if (code === 'ENOENT') return true;
  const message = error instanceof Error ? error.message : String(error);
  if (/ENOENT|no such file|not found/iu.test(message)) return true;
  return errorRecord?.cause !== undefined && isMissingFile(errorRecord.cause);
}

function reviewPrompt(
  pullRequest: ReviewPullRequest,
  charterPath: string,
  lens: string,
  evidence: readonly ReviewEvidence[]
): string {
  return [
    `Review PR #${pullRequest.number} ("${pullRequest.title}") in ${pullRequest.owner}/${pullRequest.repo} through the ${lens} lens.`,
    '',
    `Read ${charterPath} first. It is the complete review doctrine; follow its severity and output rules exactly.`,
    '',
    ...evidence.flatMap((item, index) => [`Evidence ${index + 1} — ${item.title}:`, item.prompt, '']),
    'You are read-only. Do not create, edit, stage, delete, or commit files.',
    'Output only the review comment body as markdown, with no preamble or sign-off.'
  ].join('\n');
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}
