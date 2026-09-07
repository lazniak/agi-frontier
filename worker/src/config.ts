/**
 * Worker configuration. Everything comes from the environment; see `.env.example`.
 * No secrets are ever logged or written to `data/`.
 */
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Config {
  /** Repo root (cwd for git, base for DATA_DIR/STATE_DIR defaults). */
  repoRoot: string;
  dataDir: string;
  stateDir: string;
  openRouterApiKey: string | null;
  openRouterBaseUrl: string;
  /** Model used for page extraction. */
  openRouterModel: string;
  /** Model used by `discover` (web-search plugin, `:online` suffix). */
  openRouterModelOnline: string;
  loopIntervalMinutes: number;
  gitPush: boolean;
  userAgent: string;
  logLevel: LogLevel;
  /** Run `discover` from `loop`. */
  discoverEnabled: boolean;
  /** Hard cost guard: max LLM extraction calls in one poll/discover run. */
  maxLlmCallsPerRun: number;
  requestTimeoutMs: number;
  /** Reuse `.state/pages/*.txt` across runs when younger than this (0 = per-run cache only). */
  pageCacheTtlMs: number;
  siteUrl: string;
  siteTitle: string;
}

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/131.0.0.0 Safari/537.36 (+https://agi.pablogfx.com; agi-frontier-bot)';

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

function env(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === '' ? undefined : v;
}

function envInt(name: string, fallback: number): number {
  const raw = env(name);
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = env(name);
  if (raw === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

/** Walk up from this file until a directory looks like the repo root. */
export function findRepoRoot(start = dirname(fileURLToPath(import.meta.url))): string {
  const override = env('REPO_ROOT');
  if (override) return resolve(override);
  let dir = resolve(start);
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'data', 'labs.json')) && existsSync(join(dir, 'shared'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: worker/src -> worker -> repo root.
  return resolve(start, '..', '..');
}

function resolveDir(value: string | undefined, root: string, fallback: string): string {
  if (!value) return join(root, fallback);
  return isAbsolute(value) ? value : resolve(root, value);
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const repoRoot = overrides.repoRoot ?? findRepoRoot();
  const model = env('OPENROUTER_MODEL') ?? 'google/gemini-2.5-flash-lite';
  const rawLevel = (env('LOG_LEVEL') ?? 'info').toLowerCase();
  const logLevel = (LOG_LEVELS as readonly string[]).includes(rawLevel) ? (rawLevel as LogLevel) : 'info';
  const base: Config = {
    repoRoot,
    dataDir: resolveDir(env('DATA_DIR'), repoRoot, 'data'),
    stateDir: resolveDir(env('STATE_DIR'), repoRoot, join('worker', '.state')),
    openRouterApiKey: env('OPENROUTER_API_KEY') ?? null,
    openRouterBaseUrl: env('OPENROUTER_BASE_URL') ?? 'https://openrouter.ai/api/v1',
    openRouterModel: model,
    openRouterModelOnline: env('OPENROUTER_MODEL_ONLINE') ?? `${model}:online`,
    loopIntervalMinutes: envInt('LOOP_INTERVAL_MINUTES', 60),
    gitPush: envBool('GIT_PUSH', false),
    userAgent: env('HTTP_USER_AGENT') ?? DEFAULT_UA,
    logLevel,
    discoverEnabled: envBool('DISCOVER', true),
    maxLlmCallsPerRun: envInt('MAX_LLM_CALLS_PER_RUN', 20),
    requestTimeoutMs: envInt('HTTP_TIMEOUT_MS', 20_000),
    pageCacheTtlMs: envInt('PAGE_CACHE_TTL_MINUTES', 0) * 60_000,
    siteUrl: env('SITE_URL') ?? 'https://agi.pablogfx.com',
    siteTitle: env('SITE_TITLE') ?? 'AGI Frontier',
  };
  return { ...base, ...overrides };
}
