/**
 * The bot's git side: stage `data/`, commit as `agi-frontier bot`, rebase on origin/main, push.
 * Per CLAUDE.md this is the one place allowed to write to `main` directly, and only for `data/**`.
 */
import { spawnSync } from 'node:child_process';
import type { Logger } from './log';

export const BOT_NAME = 'agi-frontier bot';
export const BOT_EMAIL = 'bot@agi.pablogfx.com';

export interface GitOptions {
  cwd: string;
  log?: Logger;
  /** Injected in tests. */
  run?: GitRunner;
}

export interface GitRun {
  status: number;
  stdout: string;
  stderr: string;
}

export type GitRunner = (args: string[], cwd: string) => GitRun;

export interface GitPushResult {
  committed: boolean;
  pushed: boolean;
  /** Set when the rebase conflicted: the commit stays local for the next run. */
  deferred: boolean;
  message?: string;
  error?: string;
}

/**
 * `data(bot): <lab>: <summary>` for a single lab; several labs are joined with `+`.
 * Kept short — the full detail lives in `changes.jsonl` and the site changelog.
 *
 * `fallbackSummary` is what the subject says when the caller described nothing but the tree is
 * still dirty (a previous step left uncommitted files behind). It is mandatory so every commit
 * names the step that made it — the generic "data update" of the first live run told nobody
 * that the arena step had run.
 */
export function buildCommitMessage(labs: string[], summaries: string[], fallbackSummary: string, maxLength = 100): string {
  const uniqueLabs = [...new Set(labs.filter(Boolean))];
  const scope = uniqueLabs.length === 0 ? 'data' : uniqueLabs.length <= 3 ? uniqueLabs.join('+') : `${uniqueLabs.length} labs`;
  const uniqueSummaries = [...new Set(summaries.filter(Boolean))];
  let summary = uniqueSummaries.slice(0, 3).join('; ');
  if (uniqueSummaries.length > 3) summary += `; +${uniqueSummaries.length - 3} more`;
  if (!summary) summary = fallbackSummary.trim() || 'uncommitted data changes';
  const head = `data(bot): ${scope}: `;
  const room = Math.max(12, maxLength - head.length);
  if (summary.length > room) summary = summary.slice(0, room - 1).trimEnd() + '…';
  return head + summary;
}

const defaultRunner: GitRunner = (args, cwd) => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // GIT_DIR/GIT_WORK_TREE default to the repo root; GIT_SSH_COMMAND (deploy key) passes through.
  if (!env['GIT_DIR']) delete env['GIT_DIR'];
  if (!env['GIT_WORK_TREE']) delete env['GIT_WORK_TREE'];
  const res = spawnSync('git', args, { cwd, env, encoding: 'utf8', windowsHide: true });
  return {
    status: res.status ?? (res.error ? 1 : 0),
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? (res.error ? res.error.message : ''),
  };
};

/** True when `git status --porcelain data` reports anything. */
export function dataDirty(opts: GitOptions, pathspec = 'data'): boolean {
  const run = opts.run ?? defaultRunner;
  const res = run(['status', '--porcelain', '--', pathspec], opts.cwd);
  return res.status === 0 && res.stdout.trim().length > 0;
}

/**
 * Commit whatever changed under `data/`, then rebase on `origin/main` and push.
 * On a rebase conflict we abort and keep the local commit — the next run tries again.
 */
export function commitAndPush(opts: GitOptions, message: string, pathspec = 'data'): GitPushResult {
  const run = opts.run ?? defaultRunner;
  const log = opts.log;
  if (!dataDirty(opts, pathspec)) return { committed: false, pushed: false, deferred: false };

  const add = run(['add', '--', pathspec], opts.cwd);
  if (add.status !== 0) return { committed: false, pushed: false, deferred: false, error: `git add: ${add.stderr.trim()}` };

  const commit = run(
    ['-c', `user.name=${BOT_NAME}`, '-c', `user.email=${BOT_EMAIL}`, 'commit', '-m', message, '--', pathspec],
    opts.cwd,
  );
  if (commit.status !== 0) {
    return { committed: false, pushed: false, deferred: false, error: `git commit: ${commit.stderr.trim() || commit.stdout.trim()}` };
  }
  log?.info('git commit', { message });

  const pull = run(['pull', '--rebase', 'origin', 'main'], opts.cwd);
  if (pull.status !== 0) {
    run(['rebase', '--abort'], opts.cwd);
    log?.error('git rebase conflict — commit kept locally for the next run', { stderr: pull.stderr.trim() });
    return { committed: true, pushed: false, deferred: true, message, error: pull.stderr.trim() };
  }

  const push = run(['push', 'origin', 'main'], opts.cwd);
  if (push.status !== 0) {
    log?.error('git push failed — commit kept locally for the next run', { stderr: push.stderr.trim() });
    return { committed: true, pushed: false, deferred: true, message, error: push.stderr.trim() };
  }
  log?.info('git push ok', { message });
  return { committed: true, pushed: true, deferred: false, message };
}
