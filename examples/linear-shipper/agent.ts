import { handler } from '@agentworkforce/runtime';

type LinearIssueEvent = {
  issue?: { id?: string; identifier?: string; title?: string; url?: string };
};

function inputDefault(ctx: Parameters<Parameters<typeof handler>[0]>[0], name: string): string {
  const value = ctx.persona.inputs?.[name]?.default;
  if (!value) throw new Error(`${name} input is required`);
  return value;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function safeRepoDirName(value: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error('GITHUB_REPO must be a repository name, not a path or shell fragment');
  }
  return value;
}

export default handler(async (ctx, event) => {
  if (event.source !== 'linear' || event.type !== 'issue.created') return;
  if (!ctx.linear) throw new Error('linear-shipper requires the linear integration');
  if (!ctx.github) throw new Error('linear-shipper requires the github integration');

  const issueRef = (event as LinearIssueEvent).issue;
  const issueId = issueRef?.id ?? issueRef?.identifier;
  if (!issueId) throw new Error('Linear event is missing an issue id');

  const issue = await ctx.linear.getIssue(issueId);
  const repoUrl = inputDefault(ctx, 'REPO_URL');
  const owner = inputDefault(ctx, 'GITHUB_OWNER');
  const repo = safeRepoDirName(inputDefault(ctx, 'GITHUB_REPO'));
  const repoDir = `${ctx.sandbox.cwd}/${repo}`;

  await ctx.sandbox.exec(`git clone ${shellQuote(repoUrl)} ${shellQuote(repoDir)}`);
  const result = await ctx.harness.run({
    prompt: `Implement this Linear issue. Create the smallest reviewable change and include verification notes.\n\nTitle: ${issue.title}\n\n${issue.description ?? ''}`,
    cwd: repoDir,
    tier: 'best'
  });

  // TODO(human): createPr is not in the published GithubClient contract yet.
  const created = await ctx.github.createIssue({
    owner,
    repo,
    title: `Draft PR needed: ${issue.title}`,
    body: [
      `Linear issue: ${issue.url ?? issueId}`,
      '',
      'The harness produced an implementation attempt, but GithubClient.createPr is not exposed yet.',
      '',
      result.output
    ].join('\n')
  });

  await ctx.linear.comment(issueId, `Implementation attempt captured in GitHub issue: ${created.url}`);
});
