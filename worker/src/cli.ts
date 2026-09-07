#!/usr/bin/env bun
/**
 * AGI Frontier worker CLI.
 *
 *   bun run worker/src/cli.ts validate
 *   bun run worker/src/cli.ts bundle
 *   bun run worker/src/cli.ts verify [--lab <id>] [--only-unverified] [--limit N]
 *   bun run worker/src/cli.ts poll   [--lab <id>] [--dry-run]
 *   bun run worker/src/cli.ts discover [--lab <id>] [--dry-run]
 *   bun run worker/src/cli.ts loop
 */
import { LAB_IDS, type LabId } from '@agi/shared';
import { createRuntime } from './runtime';
import { print } from './log';
import { runValidate } from './commands/validate';
import { runBundle } from './commands/bundle';
import { runVerify } from './commands/verify';
import { runPoll } from './commands/poll';
import { runDiscover } from './commands/discover';
import { runLoop } from './commands/loop';

export interface ParsedArgs {
  command: string;
  flags: Record<string, string | boolean>;
  positional: string[];
}

export function parseArgs(argv: string[]): ParsedArgs {
  const [command = 'help', ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === undefined) continue;
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) { flags[body.slice(0, eq)] = body.slice(eq + 1); continue; }
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith('--')) { flags[body] = next; i++; }
    else flags[body] = true;
  }
  return { command, flags, positional };
}

function labFlag(flags: Record<string, string | boolean>): LabId | undefined {
  const value = flags['lab'];
  if (typeof value !== 'string') return undefined;
  if (!(LAB_IDS as readonly string[]).includes(value)) {
    throw new Error(`unknown lab "${value}" — expected one of: ${LAB_IDS.join(', ')}`);
  }
  return value as LabId;
}

function intFlag(flags: Record<string, string | boolean>, name: string): number | undefined {
  const value = flags[name];
  if (typeof value !== 'string') return undefined;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name} expects a positive integer`);
  return n;
}

const HELP = `AGI Frontier worker

  validate                                   zod-validate everything under data/ and cross-check ids
  bundle                                     build data/public/latest.json
  verify   [--lab id] [--only-unverified] [--limit N]
                                             re-fetch every source and check its quote
  poll     [--lab id] [--dry-run]            hourly job: fetch, hash-diff, extract, merge, bundle
  discover [--lab id] [--dry-run]            daily web-search sweep for missed releases
  loop                                       poll on a timer, discover once a day

Environment is documented in worker/.env.example.`;

export async function main(argv: string[]): Promise<number> {
  const { command, flags } = parseArgs(argv);
  if (command === 'help' || command === '--help' || command === '-h' || flags['help'] === true) {
    print(HELP);
    return 0;
  }

  const rt = createRuntime();
  switch (command) {
    case 'validate':
      return runValidate(rt);
    case 'bundle':
      return runBundle(rt);
    case 'verify': {
      const opts: Parameters<typeof runVerify>[1] = {};
      const lab = labFlag(flags);
      if (lab) opts.lab = lab;
      if (flags['only-unverified'] === true) opts.onlyUnverified = true;
      const limit = intFlag(flags, 'limit');
      if (limit !== undefined) opts.limit = limit;
      return runVerify(rt, opts);
    }
    case 'poll': {
      const opts: Parameters<typeof runPoll>[1] = {};
      const lab = labFlag(flags);
      if (lab) opts.lab = lab;
      if (flags['dry-run'] === true) opts.dryRun = true;
      return runPoll(rt, opts);
    }
    case 'discover': {
      const opts: Parameters<typeof runDiscover>[1] = {};
      const lab = labFlag(flags);
      if (lab) opts.lab = lab;
      if (flags['dry-run'] === true) opts.dryRun = true;
      return runDiscover(rt, opts);
    }
    case 'loop':
      return runLoop(rt);
    default:
      print(`unknown command "${command}"\n`);
      print(HELP);
      return 2;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && /[\\/]cli\.ts$/.test(process.argv[1]);

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((e: unknown) => {
      process.stdout.write(
        JSON.stringify({ ts: new Date().toISOString(), level: 'error', msg: 'fatal', error: (e as Error).message }) + '\n',
      );
      process.exitCode = 1;
    });
}
