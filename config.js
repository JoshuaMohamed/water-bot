const path = require("path");

function parsePositiveInt(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseAdminNumbers(value) {
  return new Set(
    String(value || "")
      .split(",")
      .map((entry) => entry.replace(/\D/g, ""))
      .filter(Boolean),
  );
}

function parseModelList(value) {
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseTimeoutMs(value, fallback) {
  const parsed = parseInt(value, 10);
  // Clamp to 5s..120s so a typo can't disable the timeout or hang the bot.
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(120000, Math.max(5000, parsed));
}

const config = {
  dailyTarget: parsePositiveInt(process.env.DAILY_TARGET, 4),
  cooldownMinutes: parsePositiveInt(process.env.COOLDOWN_MINUTES, 10),
  overrideWindowMs:
    parsePositiveInt(process.env.OVERRIDE_WINDOW_MINUTES, 10) * 60 * 1000,
  adminNumbers: parseAdminNumbers(process.env.ADMIN_NUMBERS),
  dbPath: process.env.DB_PATH || path.join(__dirname, "water.db"),
  nightlyCron: process.env.NIGHTLY_CRON || "0 21 * * *",
  resetCron: process.env.RESET_CRON || "0 0 * * *",
  logLevel: (process.env.LOG_LEVEL || "info").toLowerCase(),
  // Vision model settings — fail fast instead of replying minutes late.
  // GEMINI_MODEL: primary model. GEMINI_FALLBACK_MODELS: comma-separated
  // cheap fallbacks tried once each on 503/429/5xx/timeout/fetch errors.
  // GEMINI_TIMEOUT_MS: per-attempt timeout (clamped 5s..120s, default 20s).
  geminiModel: (process.env.GEMINI_MODEL || "gemini-3.5-flash-lite").trim(),
  geminiFallbackModels: parseModelList(
    process.env.GEMINI_FALLBACK_MODELS || "gemini-3.5-flash",
  ),
  geminiTimeoutMs: parseTimeoutMs(process.env.GEMINI_TIMEOUT_MS, 20000),
};

// Same-account bot: the owner's messages come from the logged-in account
// itself (fromMe), so fromMe always counts as admin. Other senders must
// have their number listed in ADMIN_NUMBERS.
function isAdmin({ senderNumber, fromMe }) {
  if (fromMe) return true;
  return Boolean(senderNumber) && config.adminNumbers.has(senderNumber);
}

module.exports = { config, isAdmin };
