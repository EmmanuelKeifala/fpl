import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type NewsMode = 'llm-news-strict' | 'llm-news-loose';

export interface NewsItem {
  title: string;
  url: string;
  publisher?: string;
  publishedAt?: string;
  retrievedAt: string;
  summary?: string;
}

export interface NewsContext {
  items: NewsItem[];
  warnings: string[];
}

export interface NewsContextInput {
  cacheDir: string;
  season: string;
  gameweek: number;
  deadline: string;
  mode: NewsMode;
  fetchNews?: (input: Omit<NewsContextInput, 'fetchNews'>) => Promise<NewsItem[]>;
}

export async function getNewsContext(input: NewsContextInput): Promise<NewsContext> {
  const warnings: string[] = [];
  const items = await readOrFetchNews(input, warnings);
  if (input.mode === 'llm-news-loose') {
    warnings.push('Loose news mode is not strictly fair; articles may include around-gameweek context after deadline.');
    return { items, warnings };
  }

  const deadlineTime = Date.parse(input.deadline);
  const filtered = items.filter(item => item.publishedAt && Date.parse(item.publishedAt) <= deadlineTime);
  const removed = items.length - filtered.length;
  if (removed > 0) warnings.push(`Strict news mode filtered ${removed} item(s) without pre-deadline timestamps.`);
  return { items: filtered, warnings };
}

export async function fetchGdeltNews(input: Omit<NewsContextInput, 'fetchNews'>): Promise<NewsItem[]> {
  const url = buildGdeltUrl(input);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GDELT request failed with ${response.status}`);
  const body = await response.json() as { articles?: Array<{ title?: string; url?: string; sourceCountry?: string; domain?: string; seendate?: string }> };
  const retrievedAt = new Date().toISOString();
  return (body.articles ?? []).slice(0, 8).flatMap(article => {
    if (!article.title || !article.url) return [];
    return [{
      title: article.title,
      url: article.url,
      publisher: article.domain ?? article.sourceCountry,
      publishedAt: parseGdeltDate(article.seendate),
      retrievedAt,
    }];
  });
}

function buildGdeltUrl(input: Omit<NewsContextInput, 'fetchNews'>): string {
  const deadline = new Date(input.deadline);
  const start = new Date(deadline);
  start.setUTCDate(start.getUTCDate() - 7);
  const end = input.mode === 'llm-news-strict' ? deadline : new Date(deadline.getTime() + 36 * 60 * 60 * 1000);
  const params = new URLSearchParams({
    query: 'Fantasy Premier League injury OR suspension OR press conference OR predicted lineup',
    mode: 'ArtList',
    format: 'json',
    maxrecords: '10',
    startdatetime: formatGdeltDate(start),
    enddatetime: formatGdeltDate(end),
  });
  return `https://api.gdeltproject.org/api/v2/doc/doc?${params.toString()}`;
}

async function readOrFetchNews(input: NewsContextInput, warnings: string[]): Promise<NewsItem[]> {
  const cachePath = newsCachePath(input.cacheDir, input.season, input.gameweek, input.mode);
  try {
    return JSON.parse(await readFile(cachePath, 'utf8')) as NewsItem[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warnings.push(`Could not read news cache: ${(error as Error).message}`);
  }

  try {
    const fetchNews = input.fetchNews ?? fetchGdeltNews;
    const items = await fetchNews(input);
    await mkdir(join(input.cacheDir, input.season), { recursive: true });
    await writeFile(cachePath, `${JSON.stringify(items, null, 2)}\n`);
    return items;
  } catch (error) {
    warnings.push(`News fetch failed for ${input.season} GW${input.gameweek}: ${(error as Error).message}`);
    return [];
  }
}

function newsCachePath(cacheDir: string, season: string, gameweek: number, mode: NewsMode): string {
  return join(cacheDir, season, `gw-${gameweek}-${mode}.json`);
}

function parseGdeltDate(value?: string): string | undefined {
  if (!value) return undefined;
  const match = /^(\d{4})(\d{2})(\d{2})T?(\d{2})(\d{2})(\d{2})/.exec(value);
  if (!match) return undefined;
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`;
}

function formatGdeltDate(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}
