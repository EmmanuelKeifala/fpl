import { access, mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export interface BacktestDataSourceOptions {
  season: string;
  cacheDir: string;
  sourceUrls: string[];
  fetchJson?: (url: string) => Promise<unknown>;
  fetchImpl?: FetchImpl;
  fetchTimeoutMs?: number;
  now?: () => Date;
}

export interface BacktestManifest {
  season: string;
  sourceUrls: string[];
  downloadedAt: string;
  snapshotVersion: string;
}

export function getDefaultBacktestCacheDir(season: string): string {
  return `data/historical/${season}`;
}

export class BacktestDataSource {
  private readonly fetchJson: (url: string) => Promise<unknown>;
  private readonly now: () => Date;

  constructor(private readonly options: BacktestDataSourceOptions) {
    this.fetchJson = options.fetchJson ?? (async (url: string) => {
      const fetchImpl = options.fetchImpl ?? fetch;
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
      return response.json();
    });
    this.now = options.now ?? (() => new Date());
  }

  async prepare(): Promise<void> {
    await mkdir(this.options.cacheDir, { recursive: true });
    await this.removeManifest();

    for (const [index, sourceUrl] of this.options.sourceUrls.entries()) {
      const data = await this.fetchJson(sourceUrl);
      await writeFile(join(this.options.cacheDir, `source-${index + 1}.json`), JSON.stringify(data, null, 2));
    }

    await this.writeManifest(this.options.sourceUrls);
  }

  async writeManifest(sourceUrls: string[]): Promise<void> {
    await mkdir(this.options.cacheDir, { recursive: true });
    const manifest: BacktestManifest = {
      season: this.options.season,
      sourceUrls,
      downloadedAt: this.now().toISOString(),
      snapshotVersion: `${this.options.season}-v1`,
    };
    await writeFile(join(this.options.cacheDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  }

  async hasPreparedDataset(): Promise<boolean> {
    try {
      await access(join(this.options.cacheDir, 'manifest.json'));
      return true;
    } catch {
      return false;
    }
  }

  private async removeManifest(): Promise<void> {
    try {
      await unlink(join(this.options.cacheDir, 'manifest.json'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
