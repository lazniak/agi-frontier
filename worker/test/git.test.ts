import { describe, expect, test } from 'bun:test';
import { BOT_EMAIL, BOT_NAME, buildCommitMessage, commitAndPush, dataDirty, type GitRun, type GitRunner } from '../src/git';

describe('buildCommitMessage', () => {
  const FALLBACK = 'poll: sweep of uncommitted data changes';

  test('uses the Conventional-Commits shape the repo requires', () => {
    expect(buildCommitMessage(['openai'], ['openai: 1 release'], FALLBACK)).toBe('data(bot): openai: openai: 1 release');
  });

  test('joins a couple of labs with +', () => {
    expect(buildCommitMessage(['openai', 'anthropic'], ['2 scores'], FALLBACK)).toBe('data(bot): openai+anthropic: 2 scores');
  });

  test('summarises when many labs changed', () => {
    const labs = ['openai', 'anthropic', 'google', 'xai', 'meta'];
    expect(buildCommitMessage(labs, ['a', 'b', 'c', 'd'], FALLBACK)).toBe('data(bot): 5 labs: a; b; c; +1 more');
  });

  test('deduplicates labs and summaries', () => {
    expect(buildCommitMessage(['openai', 'openai'], ['x', 'x'], FALLBACK)).toBe('data(bot): openai: x');
  });

  test('names the step in the subject when nothing was described — never a bare "data update"', () => {
    expect(buildCommitMessage([], [], FALLBACK)).toBe(`data(bot): data: ${FALLBACK}`);
    expect(buildCommitMessage([], [], '   ')).toBe('data(bot): data: uncommitted data changes');
    expect(buildCommitMessage([], [], FALLBACK)).not.toContain('data update');
  });

  test('stays within the subject-line budget', () => {
    const msg = buildCommitMessage(['openai'], ['x'.repeat(300)], FALLBACK);
    expect(msg.length).toBeLessThanOrEqual(100);
    expect(msg.startsWith('data(bot): openai: ')).toBe(true);
  });
});

/** The git subcommand, skipping `-c key=value` pairs. */
function subcommand(args: string[]): string {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === '-c') { i++; continue; }
    if (arg.startsWith('-')) continue;
    return arg;
  }
  return '';
}

function recorder(results: Record<string, GitRun>): { run: GitRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: GitRunner = (args) => {
    calls.push(args);
    return results[subcommand(args)] ?? { status: 0, stdout: '', stderr: '' };
  };
  return { run, calls };
}

const dirty: GitRun = { status: 0, stdout: ' M data/models/openai.json\n', stderr: '' };
const clean: GitRun = { status: 0, stdout: '', stderr: '' };

describe('dataDirty', () => {
  test('true when git reports changes under data/', () => {
    const { run, calls } = recorder({ status: dirty });
    expect(dataDirty({ cwd: '/repo', run })).toBe(true);
    expect(calls[0]).toEqual(['status', '--porcelain', '--', 'data']);
  });

  test('false when the tree is clean', () => {
    const { run } = recorder({ status: clean });
    expect(dataDirty({ cwd: '/repo', run })).toBe(false);
  });
});

describe('commitAndPush', () => {
  test('does nothing when there is nothing to commit', () => {
    const { run, calls } = recorder({ status: clean });
    expect(commitAndPush({ cwd: '/repo', run }, 'msg')).toEqual({ committed: false, pushed: false, deferred: false });
    expect(calls).toHaveLength(1);
  });

  test('add, commit as the bot, rebase, push', () => {
    const { run, calls } = recorder({ status: dirty });
    const result = commitAndPush({ cwd: '/repo', run }, 'data(bot): openai: 1 release');
    expect(result).toMatchObject({ committed: true, pushed: true, deferred: false });
    expect(calls.map(subcommand)).toEqual(['status', 'add', 'commit', 'pull', 'push']);
    const commit = calls[2] ?? [];
    expect(commit).toContain(`user.name=${BOT_NAME}`);
    expect(commit).toContain(`user.email=${BOT_EMAIL}`);
    expect(commit).toContain('data(bot): openai: 1 release');
    expect(calls[3]).toEqual(['pull', '--rebase', 'origin', 'main']);
    expect(calls[4]).toEqual(['push', 'origin', 'main']);
  });

  test('a rebase conflict aborts and keeps the commit for the next run', () => {
    const { run, calls } = recorder({
      status: dirty,
      pull: { status: 1, stdout: '', stderr: 'CONFLICT (content): Merge conflict in data/models/openai.json' },
    });
    const result = commitAndPush({ cwd: '/repo', run }, 'msg');
    expect(result).toMatchObject({ committed: true, pushed: false, deferred: true });
    expect(result.error).toContain('CONFLICT');
    expect(calls.map(subcommand)).toContain('rebase');
    expect(calls.find((c) => subcommand(c) === 'rebase')).toEqual(['rebase', '--abort']);
    expect(calls.some((c) => subcommand(c) === 'push')).toBe(false);
  });

  test('a failed push is deferred, not lost', () => {
    const { run } = recorder({ status: dirty, push: { status: 1, stdout: '', stderr: 'Permission denied (publickey)' } });
    const result = commitAndPush({ cwd: '/repo', run }, 'msg');
    expect(result).toMatchObject({ committed: true, pushed: false, deferred: true });
  });

  test('a failed commit reports the error and stops', () => {
    const { run, calls } = recorder({ status: dirty, commit: { status: 1, stdout: '', stderr: 'nothing added' } });
    const result = commitAndPush({ cwd: '/repo', run }, 'msg');
    expect(result.committed).toBe(false);
    expect(result.error).toContain('nothing added');
    expect(calls.some((c) => subcommand(c) === 'pull')).toBe(false);
  });
});
