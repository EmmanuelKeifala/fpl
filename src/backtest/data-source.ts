import { access, mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export interface BacktestSourceDescriptor {
  url: string;
  fileName: string;
  format: 'json' | 'text';
  optional?: boolean;
}

export interface BacktestDataSourceOptions {
  season: string;
  cacheDir: string;
  sourceUrls: string[];
  sources?: BacktestSourceDescriptor[];
  fetchJson?: (url: string) => Promise<unknown>;
  fetchText?: (url: string) => Promise<string>;
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
  private readonly fetchText: (url: string) => Promise<string>;
  private readonly now: () => Date;

  constructor(private readonly options: BacktestDataSourceOptions) {
    this.fetchJson = options.fetchJson ?? (async (url: string) => {
      const fetchImpl = options.fetchImpl ?? fetch;
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
      return response.json();
    });
    this.fetchText = options.fetchText ?? (async (url: string) => {
      const fetchImpl = options.fetchImpl ?? fetch;
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
      return response.text();
    });
    this.now = options.now ?? (() => new Date());
  }

  async prepare(): Promise<void> {
    await mkdir(this.options.cacheDir, { recursive: true });
    await this.removeManifest();

    const sources = this.options.sources ?? this.options.sourceUrls.map((url, index) => ({
      url,
      fileName: `source-${index + 1}.json`,
      format: 'json' as const,
    }));

    for (const source of sources) {
      try {
        if (source.format === 'json') {
          const data = await this.fetchJson(source.url);
          await writeFile(join(this.options.cacheDir, source.fileName), JSON.stringify(data, null, 2));
        } else {
          await writeFile(join(this.options.cacheDir, source.fileName), await this.fetchText(source.url));
        }
      } catch (error) {
        if (!source.optional) throw error;
      }
    }

    await this.writeManifest(sources.map((source) => source.url));
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
