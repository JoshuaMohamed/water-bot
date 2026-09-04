const { config } = require("./config");

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

function shouldLog(level) {
  const configured = LEVELS[config.logLevel] ?? LEVELS.info;
  return LEVELS[level] >= configured;
}

function formatArgs(args) {
  return args.map((arg) =>
    typeof arg === "string" ? arg : JSON.stringify(arg),
  );
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
