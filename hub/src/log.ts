export type LogFields = Record<string, unknown>;
export type Logger = {
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
};

const SENSITIVE = /token|secret|code|data/i;

/** Drops fields whose key could carry a credential or payload. */
export function redact(fields: LogFields = {}): LogFields {
  return Object.fromEntries(Object.entries(fields).filter(([k]) => !SENSITIVE.test(k)));
}

/** One JSON line per call, sent to `sink` (default: stdout/stderr). */
export function createLogger(sink?: (line: string) => void): Logger {
  const emit = (level: "info" | "warn" | "error", msg: string, fields?: LogFields) => {
    const line = JSON.stringify({ level, msg, ...redact(fields) }, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
    if (sink) sink(line);
    else if (level === "info") console.log(line);
    else console.error(line);
  };
  return {
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
  };
}
