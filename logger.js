const { config } = require("./config");

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

function shouldLog(level) {
  const configured = LEVELS[config.logLevel] ?? LEVELS.info;
  return LEVELS[level] >= configured;
}

function formatValue(arg) {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) return arg.stack || arg.message || String(arg);
  if (arg && typeof arg === "object" && "message" in arg && typeof arg.message === "string" && Object.keys(arg).length === 1) {
    return arg.message;
  }
  try {
    const seen = new Set();
    return JSON.stringify(arg, (key, value) => {
      if (value instanceof Error) return value.stack || value.message;
      if (typeof value === "object" && value !== null) {
        if (seen.has(value)) return "[Circular]";
        seen.add(value);
      }
      return value;
    });
  } catch {
    return String(arg);
  }
}

function formatArgs(args) {
  return args.map((arg) => formatValue(arg));
}

function debug(...args) {
  if (shouldLog("debug")) console.log("[water-bot]", ...formatArgs(args));
}

function info(...args) {
  if (shouldLog("info")) console.log("[water-bot]", ...formatArgs(args));
}

function warn(...args) {
  if (shouldLog("warn")) console.warn("[water-bot]", ...formatArgs(args));
}

function error(...args) {
  if (shouldLog("error")) console.error("[water-bot]", ...formatArgs(args));
}

module.exports = { debug, info, warn, error };
