type LogLevel = "info" | "warn" | "error";

const SENSITIVE_KEYS = new Set([
  "accesskeyid",
  "answer",
  "apikey",
  "authorization",
  "completion",
  "content",
  "cookie",
  "credential",
  "message",
  "messageContent",
  "password",
  "presignedurl",
  "prompt",
  "rawText",
  "secret",
  "snippet",
  "text",
  "token",
  "url",
]);

type LogSink = (record: Record<string, unknown>) => void;

function shouldRedactKey(key: string): boolean {
  const normalized = key.toLowerCase();

  return (
    SENSITIVE_KEYS.has(normalized) ||
    /accesskeyid|apikey|answer|authorization|completion|content|cookie|credential|message|password|presignedurl|prompt|rawtext|secret|snippet|text|token|url/.test(
      normalized
    )
  );
}

function sanitizeValue(value: unknown, key = ""): unknown {
  if (shouldRedactKey(key)) {
    return "[REDACTED]";
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: "[REDACTED]",
    };
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item));
  }

  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
        entryKey,
        sanitizeValue(entryValue, entryKey),
      ])
    );
  }

  return value;
}

export function createRedactedLogRecord(
  level: LogLevel,
  event: string,
  fields: Record<string, unknown> = {}
): Record<string, unknown> {
  const sanitizedFields = sanitizeValue(fields) as Record<string, unknown>;

  return {
    level,
    event,
    time: new Date().toISOString(),
    ...sanitizedFields,
  };
}

function writeLog(level: LogLevel, event: string, fields: Record<string, unknown>, sink: LogSink) {
  sink(createRedactedLogRecord(level, event, fields));
}

export const logger = {
  info(event: string, fields: Record<string, unknown> = {}) {
    writeLog("info", event, fields, (record) => console.log(JSON.stringify(record)));
  },
  warn(event: string, fields: Record<string, unknown> = {}) {
    writeLog("warn", event, fields, (record) => console.warn(JSON.stringify(record)));
  },
  error(event: string, fields: Record<string, unknown> = {}) {
    writeLog("error", event, fields, (record) => console.error(JSON.stringify(record)));
  },
};
