import { handler } from '@agentworkforce/runtime';

type GithubTarget = { owner: string; repo: string; number: number };

function githubTarget(event: Record<string, unknown>): GithubTarget {
  const repository = event.repository as {
    owner?: string | { login?: string };
    name?: string;
    full_name?: string;
  } | undefined;
  const pullRequest = event.pull_request as { number?: number } | undefined;
  const issue = event.issue as { number?: number } | undefined;
  const owner = typeof repository?.owner === 'string'
    ? repository.owner
    : repository?.owner?.login ?? repository?.full_name?.split('/')[0];
  const repo = repository?.name ?? repository?.full_name?.split('/')[1];
  const number = pullRequest?.number ?? issue?.number ?? Number(event.number);
  if (!owner || !repo || !Number.isFinite(number)) {
    throw new Error('GitHub event is missing owner, repo, or number');
  }
  return { owner, repo, number };
}

async function reviewPullRequest(ctx: Parameters<Parameters<typeof handler>[0]>[0], event: Record<string, unknown>) {
  if (!ctx.github) throw new Error('review-agent requires the github integration');
  const target = githubTarget(event);
  const pr = await ctx.github.getPr(target);
  const result = await ctx.harness.run({
    prompt: `Review this PR for correctness, risk, and missing tests.\n\nTitle: ${pr.title}\nAuthor: ${pr.author}\nBase: ${pr.base}\nHead: ${pr.head}\n\n${pr.diff}`,
    cwd: ctx.sandbox.cwd,
    tier: 'best-value'
  });
  await ctx.github.postReview(target, { event: 'COMMENT', body: result.output });
}

async function replyToGithubMention(ctx: Parameters<Parameters<typeof handler>[0]>[0], event: Record<string, unknown>) {
  if (!ctx.github) throw new Error('review-agent requires the github integration');
  const target = githubTarget(event);
  const comment = event.comment as { body?: string } | undefined;
  const result = await ctx.harness.run({
    prompt: `Reply to this GitHub discussion in context. Keep it specific and actionable.\n\n${comment?.body ?? ''}`,
    cwd: ctx.sandbox.cwd,
    tier: 'best-value'
  });
  await ctx.github.comment(target, result.output);
}

async function handleFailedCheck(ctx: Parameters<Parameters<typeof handler>[0]>[0], event: Record<string, unknown>) {
  if (!ctx.github) throw new Error('review-agent requires the github integration');
  const checkRun = event.check_run as { conclusion?: string; output?: { title?: string; summary?: string } } | undefined;
  if (checkRun?.conclusion !== 'failure') return;
  const target = githubTarget(event);
  const result = await ctx.harness.run({
    prompt: `CI failed. Inspect the failure and propose the smallest safe fix.\n\n${checkRun.output?.title ?? ''}\n\n${checkRun.output?.summary ?? ''}`,
    cwd: ctx.sandbox.cwd,
    tier: 'best'
  });
  await ctx.github.comment(target, result.output);
}

async function replyInSlack(ctx: Parameters<Parameters<typeof handler>[0]>[0], event: Record<string, unknown>) {
  if (!ctx.slack) throw new Error('review-agent requires the slack integration');
  const text = typeof event.text === 'string' ? event.text : '';
  const channel = typeof event.channel === 'string' ? event.channel : '';
  const ts = typeof event.threadTs === 'string'
    ? event.threadTs
    : typeof event.thread_ts === 'string'
      ? event.thread_ts
      : typeof event.ts === 'string'
        ? event.ts
        : '';
  if (!channel || !ts) throw new Error('Slack app_mention event is missing channel or thread timestamp');
  const memories = await ctx.memory.recall(text, { limit: 5 });
  const result = await ctx.harness.run({
    prompt: `Answer this Slack mention using the remembered context when useful.\n\nContext:\n${JSON.stringify(memories)}\n\nMessage:\n${text}`,
    cwd: ctx.sandbox.cwd,
    tier: 'best-value'
  });
  await ctx.slack.reply({ channel, ts }, result.output);
  await ctx.memory.save(`Slack mention handled: ${text.slice(0, 180)}`, {
    tags: ['slack', 'review-agent'],
    scope: 'workspace'
  });
}

export default handler(async (ctx, event) => {
  if (event.source === 'github') {
    if (event.type === 'pull_request.opened') {
      await reviewPullRequest(ctx, event);
      return;
    }
    if (event.type === 'issue_comment.created' || event.type === 'pull_request_review_comment.created') {
      await replyToGithubMention(ctx, event);
      return;
    }
    if (event.type === 'check_run.completed') {
      await handleFailedCheck(ctx, event);
      return;
    }
  }

  if (event.source === 'slack' && event.type === 'app_mention') {
    await replyInSlack(ctx, event);
  }
});
