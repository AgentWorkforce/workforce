import { handler } from '@agentworkforce/runtime';

type BraveResult = {
  title?: string;
  url?: string;
  description?: string;
};

type ClusteredFinding = {
  host: string;
  items: Array<{ title: string; url: string; description: string }>;
};

function topicsFromPersona(value: unknown): string[] {
  const raw = typeof value === 'string' ? value : 'AgentWorkforce,AI coding agents,developer productivity';
  return raw
    .split(',')
    .map((topic) => topic.trim())
    .filter(Boolean);
}

function isoWeek(date = new Date()): string {
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((utc.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function clusterByHost(results: BraveResult[]): ClusteredFinding[] {
  const seen = new Set<string>();
  const clusters = new Map<string, ClusteredFinding>();
  for (const result of results) {
    if (!result.url || seen.has(result.url)) continue;
    seen.add(result.url);
    const url = new URL(result.url);
    const host = url.host.replace(/^www\./, '');
    const cluster = clusters.get(host) ?? { host, items: [] };
    cluster.items.push({
      title: result.title?.trim() || result.url,
      url: result.url,
      description: result.description?.trim() || 'No description returned.'
    });
    clusters.set(host, cluster);
  }
  return [...clusters.values()].sort((a, b) => b.items.length - a.items.length);
}

function renderDigest(clusters: ClusteredFinding[], week: string): string {
  const sections = clusters.map((cluster) => {
    const items = cluster.items
      .slice(0, 5)
      .map((item) => `- [${item.title}](${item.url}) - ${item.description}`)
      .join('\n');
    return `## ${cluster.host}\n\n${items}`;
  });
  return [`# Weekly digest - ${week}`, ...sections].join('\n\n');
}

export default handler(async (ctx, event) => {
  if (event.source !== 'cron') return;
  if (!ctx.github) throw new Error('weekly-digest requires the github integration');

  const apiKey = process.env.BRAVE_API_KEY;
  if (!apiKey) throw new Error('BRAVE_API_KEY is required');

  const inputs = ctx.persona.inputs ?? {};
  const topics = topicsFromPersona(inputs.TOPICS?.default);
  const results: BraveResult[] = [];

  for (const topic of topics) {
    const params = new URLSearchParams({ q: topic, count: '10' });
    const response = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
      headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey }
    });
    if (!response.ok) {
      throw new Error(`Brave Search failed for "${topic}" with HTTP ${response.status}`);
    }
    const body = (await response.json()) as { web?: { results?: BraveResult[] } };
    results.push(...(body.web?.results ?? []));
  }

  const week = isoWeek();
  const body = renderDigest(clusterByHost(results), week);
  const owner = inputs.GITHUB_OWNER?.default ?? 'AgentWorkforce';
  const repo = inputs.GITHUB_REPO?.default ?? 'weekly-digest';
  const title = `Weekly digest - ${week}`;

  await ctx.github.upsertIssue({
    owner,
    repo,
    title,
    body,
    labels: ['digest'],
    matchTitle: title
  });
  await ctx.memory.save(`digest published for week ${week}`, {
    tags: ['digest', `week:${week}`],
    scope: 'workspace'
  });
});
