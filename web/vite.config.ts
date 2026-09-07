import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';
import { defineConfig, type Plugin, type ViteDevServer } from 'vite';

// NOTE: Vite bundles this config with esbuild and externalises *bare* specifiers, so
// `@agi/shared` (which ships TypeScript source) cannot be imported by package name here.
// A relative import is bundled instead — it is still the one real implementation, never a copy.
// `bundle.ts` only has type-level imports, so nothing else is pulled in.
import { buildBundle, EMPTY_WORKER_STATE } from '../shared/src/bundle';
import { calibrateForecast } from '../shared/src/backtest';
import { todayISO } from '../shared/src/timeline';
import type { BacktestReport, Benchmark, ChangeEvent, Lab, LabFile } from '../shared/src/types';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(here, '..', 'data');
const fixtureFile = resolve(here, 'fixtures', 'latest.json');
const paperFile = resolve(here, '..', 'docs', 'PAPER.md');

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

/** Real lab files = `data/models/*.json` that do not start with `_`. */
function realLabFiles(): string[] {
  const dir = join(dataDir, 'models');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .sort()
    .map((f) => join(dir, f));
}

function readChanges(): ChangeEvent[] {
  const file = join(dataDir, 'history', 'changes.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as ChangeEvent);
}

/**
 * The dev bundle must carry the same backtest the worker publishes, or the site would draw
 * un-scaled forecast windows and hide the Backtest card in development only. It costs a few
 * seconds, so it is cached against the newest data-file mtime and the day it was computed.
 */
let backtestCache: { key: string; report: BacktestReport } | null = null;

function newestDataMtime(files: string[]): number {
  let newest = 0;
  for (const f of [...files, join(dataDir, 'benchmarks.json'), join(dataDir, 'labs.json')]) {
    if (!existsSync(f)) continue;
    newest = Math.max(newest, statSync(f).mtimeMs);
  }
  return newest;
}

function devBacktest(
  releases: LabFile['releases'],
  benchmarks: Benchmark[],
  labIds: Lab['id'][],
  key: string,
): BacktestReport {
  if (backtestCache && backtestCache.key === key) return backtestCache.report;
  // Rows are dropped exactly as the worker drops them (`worker/src/commands/bundle.ts`): the site
  // replays the scrubbed rows itself and only needs the aggregates.
  const report: BacktestReport = { ...calibrateForecast(releases, benchmarks, labIds, { to: todayISO() }).report, rows: [] };
  backtestCache = { key, report };
  return report;
}

/**
 * Assemble `/latest.json` live from ../data so the dev server always mirrors the data files.
 * Falls back to the synthetic fixture while `data/models/` holds no real lab file yet.
 */
function devBundle(): { body: string; source: 'data' | 'fixture' } {
  // `AGI_FIXTURE=1 bun run dev` forces the synthetic bundle even when real lab files exist,
  // which is how the fallback path stays testable once data/models is populated.
  const files = process.env.AGI_FIXTURE === '1' ? [] : realLabFiles();
  if (files.length === 0) {
    if (!existsSync(fixtureFile)) throw new Error('no lab files in data/models and no web/fixtures/latest.json');
    return { body: readFileSync(fixtureFile, 'utf8'), source: 'fixture' };
  }
  const labs = readJson<Lab[]>(join(dataDir, 'labs.json'));
  const benchmarks = readJson<Benchmark[]>(join(dataDir, 'benchmarks.json'));
  const labFiles = files.map((f) => readJson<LabFile>(f));
  const releases = labFiles.flatMap((f) => f.releases);
  const backtest = devBacktest(
    releases,
    benchmarks,
    labs.map((l) => l.id),
    `${newestDataMtime(files)}|${todayISO()}`,
  );
  const bundle = buildBundle(labs, benchmarks, labFiles, readChanges(), EMPTY_WORKER_STATE, undefined, 100, backtest);
  return { body: JSON.stringify(bundle), source: 'data' };
}

/** Dev-only: serve `/latest.json`; production serves the worker-generated file via nginx. */
function latestJsonPlugin(): Plugin {
  return {
    name: 'agi-frontier:latest-json',
    apply: 'serve',
    configureServer(server: ViteDevServer) {
      let announced = '';
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0];
        if (url !== '/latest.json') return next();
        try {
          const { body, source } = devBundle();
          if (source !== announced) {
            announced = source;
            server.config.logger.info(
              source === 'fixture'
                ? '  \x1b[33m➜\x1b[0m  /latest.json  \x1b[2mSYNTHETIC FIXTURE (no real files in data/models)\x1b[0m'
                : '  \x1b[32m➜\x1b[0m  /latest.json  \x1b[2mbuilt live from ../data (with backtest)\x1b[0m',
            );
          }
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          res.end(body);
        } catch (err) {
          server.config.logger.error(`[latest.json] ${(err as Error).message}`);
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ error: (err as Error).message }));
        }
      });

      // Editing a data file (other agents fill them in) reloads the page.
      if (existsSync(dataDir) && statSync(dataDir).isDirectory()) {
        server.watcher.add(dataDir);
        server.watcher.add(fixtureFile);
        const reload = (file: string) => {
          if (file.startsWith(dataDir) || file === fixtureFile) {
            announced = '';
            backtestCache = null;
            server.ws.send({ type: 'full-reload', path: '*' });
          }
        };
        server.watcher.on('change', reload);
        server.watcher.on('add', reload);
        server.watcher.on('unlink', reload);
      }
    },
  };
}

const PAPER_ID = 'virtual:paper';
const PAPER_RESOLVED = '\0virtual:paper';

/** First sentences of the abstract — the paper page's `<meta name="description">`. */
function paperDescription(md: string): string {
  const abstract = md.split(/^###\s+Abstract\s*$/m)[1] ?? '';
  const text = abstract
    .split(/\n---/)[0]!
    .replace(/\s+/g, ' ')
    .replace(/\*\*|\[|\]\([^)]*\)/g, '')
    .trim();
  let out = '';
  for (const sentence of text.split(/(?<=\.)\s+/)) {
    out = out ? `${out} ${sentence}` : sentence;
    if (out.length >= 140) break;
  }
  return out.slice(0, 300);
}

/**
 * `virtual:paper` — `docs/PAPER.md` rendered to HTML at build time, plus the
 * `%PAPER_DESCRIPTION%` placeholder in `paper.html`. No markdown parser reaches the browser.
 */
function paperPlugin(): Plugin {
  return {
    name: 'agi-frontier:paper',
    resolveId(id) {
      return id === PAPER_ID ? PAPER_RESOLVED : null;
    },
    load(id) {
      if (id !== PAPER_RESOLVED) return null;
      if (!existsSync(paperFile)) {
        return `export default ${JSON.stringify('<p>docs/PAPER.md is missing from this build.</p>')};`;
      }
      const rendered = marked.parse(readFileSync(paperFile, 'utf8'), { async: false, gfm: true }) as string;
      return `export default ${JSON.stringify(rendered)};`;
    },
    transformIndexHtml(htmlText) {
      if (!htmlText.includes('%PAPER_DESCRIPTION%')) return htmlText;
      const md = existsSync(paperFile) ? readFileSync(paperFile, 'utf8') : '';
      const desc = paperDescription(md).replace(/"/g, '&quot;').replace(/</g, '&lt;');
      return htmlText.replace(/%PAPER_DESCRIPTION%/g, desc);
    },
    configureServer(server: ViteDevServer) {
      server.watcher.add(paperFile);
      const reload = (file: string): void => {
        if (file !== paperFile) return;
        const mod = server.moduleGraph.getModuleById(PAPER_RESOLVED);
        if (mod) server.moduleGraph.invalidateModule(mod);
        server.ws.send({ type: 'full-reload', path: '*' });
      };
      server.watcher.on('change', reload);
    },
  };
}

export default defineConfig({
  base: '/',
  appType: 'mpa',
  server: { port: 5173, strictPort: false },
  preview: { port: 4173 },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    assetsInlineLimit: 2048,
    // Two entries now: the chart page and the paper. Splitting keeps the paper from downloading
    // the chart's stylesheet.
    cssCodeSplit: true,
    reportCompressedSize: true,
    rollupOptions: {
      input: {
        main: resolve(here, 'index.html'),
        paper: resolve(here, 'paper.html'),
      },
      treeshake: {
        // `@agi/shared`'s barrel re-exports the zod schemas, which the site never uses.
        // Marking that module side-effect-free lets rollup drop zod from the browser bundle.
        moduleSideEffects: (id) => !/[\\/]shared[\\/]src[\\/]schema\.ts$/.test(id),
      },
    },
  },
  plugins: [latestJsonPlugin(), paperPlugin()],
});
