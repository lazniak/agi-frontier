/** Structured JSON-lines logging to stdout: {ts, level, lab?, msg, ...fields}. */
import type { LogLevel } from './config';

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Record<string, unknown>;

export interface Sink {
  (line: string): void;
}

export class Logger {
  constructor(
    private readonly level: LogLevel = 'info',
    private readonly base: LogFields = {},
    private readonly sink: Sink = (line) => process.stdout.write(line + '\n'),
  ) {}

  child(fields: LogFields): Logger {
    return new Logger(this.level, { ...this.base, ...fields }, this.sink);
  }

  enabled(level: LogLevel): boolean {
    return RANK[level] >= RANK[this.level];
  }

  log(level: LogLevel, msg: string, fields: LogFields = {}): void {
    if (!this.enabled(level)) return;
    const row: LogFields = { ts: new Date().toISOString(), level, msg, ...this.base, ...fields };
    this.sink(JSON.stringify(row, replacer));
  }

  debug(msg: string, fields?: LogFields): void { this.log('debug', msg, fields); }
  info(msg: string, fields?: LogFields): void { this.log('info', msg, fields); }
  warn(msg: string, fields?: LogFields): void { this.log('warn', msg, fields); }
  error(msg: string, fields?: LogFields): void { this.log('error', msg, fields); }
}

function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message };
  return value;
}

/** Human-readable output for interactive commands (tables, summaries). */
export function print(line = ''): void {
  process.stdout.write(line + '\n');
}
