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
};

// Same-account bot: the owner's messages come from the logged-in account
// itself (fromMe), so fromMe always counts as admin. Other senders must
// have their number listed in ADMIN_NUMBERS.
function isAdmin({ senderNumber, fromMe }) {
  if (fromMe) return true;
  return Boolean(senderNumber) && config.adminNumbers.has(senderNumber);
}

module.exports = { config, isAdmin };
