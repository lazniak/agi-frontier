/** Wiring shared by every command: config, logger, state store, fetcher, OpenRouter client. */
import { loadConfig, type Config } from './config';
import { Logger } from './log';
import { StateStore } from './state';
import { createFetcher, type Fetcher, type FetcherStats } from './fetcher';
import { OpenRouterClient } from './llm';

export interface Runtime {
  config: Config;
  log: Logger;
  state: StateStore;
  fetcher: Fetcher & { stats: FetcherStats };
  /** null when OPENROUTER_API_KEY is unset — `poll --dry-run` and `validate` do not need it. */
  openRouter: OpenRouterClient | null;
}

export interface RuntimeOverrides {
  config?: Partial<Config>;
  log?: Logger;
  fetchImpl?: typeof fetch;
  /** Tests drop the 1 req/s per-host throttle. */
  minHostIntervalMs?: number;
}

export function createRuntime(overrides: RuntimeOverrides = {}): Runtime {
  const config = loadConfig(overrides.config ?? {});
  const log = overrides.log ?? new Logger(config.logLevel);
  const state = new StateStore(config.stateDir);
  const fetcherOptions = {
    userAgent: config.userAgent,
    timeoutMs: config.requestTimeoutMs,
    retries: 2,
    cacheDir: state.pagesDir,
    cacheTtlMs: config.pageCacheTtlMs,
    minHostIntervalMs: overrides.minHostIntervalMs ?? 1000,
    log,
    ...(overrides.fetchImpl ? { fetchImpl: overrides.fetchImpl } : {}),
  };
  const fetcher = createFetcher(fetcherOptions);
  const openRouter = config.openRouterApiKey
    ? new OpenRouterClient({
        apiKey: config.openRouterApiKey,
        baseUrl: config.openRouterBaseUrl,
        referer: config.siteUrl,
        title: config.siteTitle,
        concurrency: config.researchConcurrency,
        log,
        ...(config.openRouterPriceIn !== null || config.openRouterPriceOut !== null
          ? {
              priceOverrides: {
                ...(config.openRouterPriceIn !== null ? { inPerM: config.openRouterPriceIn } : {}),
                ...(config.openRouterPriceOut !== null ? { outPerM: config.openRouterPriceOut } : {}),
              },
            }
          : {}),
        ...(overrides.fetchImpl ? { fetchImpl: overrides.fetchImpl } : {}),
      })
    : null;
  return { config, log, state, fetcher, openRouter };
}
