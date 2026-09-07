import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin, type ViteDevServer } from 'vite';

// NOTE: Vite bundles this config with esbuild and externalises *bare* specifiers, so
// `@agi/shared` (which ships TypeScript source) cannot be imported by package name here.
// A relative import is bundled instead — it is still the one real implementation, never a copy.
// `bundle.ts` only has type-level imports, so nothing else is pulled in.
import { buildBundle, EMPTY_WORKER_STATE } from '../shared/src/bundle';
import type { Benchmark, ChangeEvent, Lab, LabFile } from '../shared/src/types';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(here, '..', 'data');
const fixtureFile = resolve(here, 'fixtures', 'latest.json');

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
  const bundle = buildBundle(labs, benchmarks, labFiles, readChanges(), EMPTY_WORKER_STATE);
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
                : '  \x1b[32m➜\x1b[0m  /latest.json  \x1b[2mbuilt live from ../data\x1b[0m',
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

export default defineConfig({
  base: '/',
  appType: 'spa',
  server: { port: 5173, strictPort: false },
  preview: { port: 4173 },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    assetsInlineLimit: 2048,
    cssCodeSplit: false,
    reportCompressedSize: true,
    rollupOptions: {
      treeshake: {
        // `@agi/shared`'s barrel re-exports the zod schemas, which the site never uses.
        // Marking that module side-effect-free lets rollup drop zod from the browser bundle.
        moduleSideEffects: (id) => !/[\\/]shared[\\/]src[\\/]schema\.ts$/.test(id),
      },
    },
  },
  plugins: [latestJsonPlugin()],
});
