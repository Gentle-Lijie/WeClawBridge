type Level = "debug" | "info" | "warn" | "error";

const COLORS: Record<Level, string> = {
  debug: "\x1b[90m",
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
};
const RESET = "\x1b[0m";

export interface LoggerOptions {
  /** Minimum level to emit. */
  level?: Level;
  /** Optional account tag for per-account log lines. */
  account?: string;
  /** Override the timestamp provider (mainly for tests). */
  now?: () => Date;
}

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export class Logger {
  readonly level: Level;
  private readonly account?: string;
  private readonly now: () => Date;

  constructor(opts: LoggerOptions = {}) {
    this.level = opts.level ?? "info";
    this.account = opts.account;
    this.now = opts.now ?? (() => new Date());
  }

  withAccount(account: string): Logger {
    return new Logger({ level: this.level, account, now: this.now });
  }

  private emit(level: Level, msg: string): void {
    if (ORDER[level] < ORDER[this.level]) return;
    const ts = this.now().toISOString();
    const tag = this.account ? `[${this.account}]` : "";
    process.stderr.write(`${COLORS[level]}${ts} ${level.toUpperCase()}${RESET} ${tag} ${msg}\n`);
  }

  debug(msg: string): void {
    this.emit("debug", msg);
  }
  info(msg: string): void {
    this.emit("info", msg);
  }
  warn(msg: string): void {
    this.emit("warn", msg);
  }
  error(msg: string): void {
    this.emit("error", msg);
  }
}

export const logger = new Logger();
