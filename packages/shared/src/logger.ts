export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface AppLogger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  child(scope: string): AppLogger;
}

interface LoggerOptions {
  level?: LogLevel;
  format?: 'pretty' | 'json';
  destination?: (line: string) => void;
}

export function createLogger(scope: string, opts: LoggerOptions = {}): AppLogger {
  const level = opts.level ?? (process.env.NODE_ENV === 'production' ? 'info' : 'debug');
  const format = opts.format ?? (process.env.NODE_ENV === 'production' ? 'json' : 'pretty');
  const out = opts.destination ?? ((line) => process.stdout.write(line + '\n'));

  const write = (lvl: LogLevel, message: string, context: Record<string, unknown> | undefined) => {
    if (LEVEL_ORDER[lvl] < LEVEL_ORDER[level]) return;
    const entry = {
      ts: new Date().toISOString(),
      level: lvl,
      scope,
      message,
      ...(context && Object.keys(context).length > 0 ? { context } : {}),
    };
    if (format === 'json') {
      out(JSON.stringify(entry));
    } else {
      const ctx = context && Object.keys(context).length > 0 ? ` ${JSON.stringify(context)}` : '';
      out(`${entry.ts} [${lvl.toUpperCase()}] ${scope}: ${message}${ctx}`);
    }
  };

  return {
    debug: (m, c) => write('debug', m, c),
    info: (m, c) => write('info', m, c),
    warn: (m, c) => write('warn', m, c),
    error: (m, c) => write('error', m, c),
    child: (childScope) => createLogger(`${scope}.${childScope}`, { level, format, destination: out }),
  };
}
