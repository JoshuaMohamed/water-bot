const { config } = require("./config");

function getTarget() {
  return config.dailyTarget;
}

function buildVisionPrompt(userName, currentLogCount) {
  const target = getTarget();

  return `
    You are the witty, playful, and dry-humoured "Water Bot" for a friendly water drinking competition.
    Analyze this image to determine if it shows a drinking container (water bottle, glass, cup, mug, hydration pack) containing water or a drinkable liquid.

    Current user: ${userName}
    This would be their Log #${currentLogCount + 1} for today. Target is ${target} containers.

    Return JSON with this exact schema:
    {
      "isValid": boolean, // true if image clearly shows a water bottle or glass containing fluid
      "reason": string,   // 1-2 sentence snappy comment in persona. If valid: witty approval mentioning user and log count. If invalid: funny, mild callout explaining why it's rejected.
    }
    `;
}

function formatCooldownMessage(userName, remainingMinutes, cooldownMinutes) {
  const window = cooldownMinutes || config.cooldownMinutes;
  return `⏳ Easy there, ${userName}! Minimum ${window}-minute cooldown between logs. Try again in ${remainingMinutes} min.`;
}

function formatLogSuccessMessage(reason, loggedCount) {
  const target = getTarget();
  const remaining = Math.max(0, target - loggedCount);

  return `${reason}\n\n*Today's Progress:* ${loggedCount}/${target} ${remaining === 0 ? "🎉 Goal hit!" : `(${remaining} to go)`}`;
}

function formatLogRejectedMessage(reason) {
  return `${reason}\n\n_If I misjudged, an admin can reply to the photo with \`!override\` to grant this point._`;
}

function formatAdminOverrideMessage(userName, loggedCount) {
  const target = getTarget();
  return `🛡️ *ADMIN OVERRIDE APPROVED!* Point granted to ${userName}. Today's total: ${loggedCount}/${target}`;
}

function formatNoOverrideMessage() {
  return "⚠️ No recently rejected photo found to override.";
}

function formatNotAdminMessage() {
  return "⛔ Only admins can use !override.";
}

function formatStandings(dbUsers) {
  const target = getTarget();
  let text = `🚰 *CURRENT STANDINGS*\n\n`;

  for (const user of Object.values(dbUsers)) {
    text += `• *${user.name}*: ${user.logsToday.length}/${target} today | 🔥 Streak: ${user.streak} days | 🛡️ Shields: ${user.shield}\n`;
  }

  return text;
}

function formatNightlySummary(dbUsers) {
  const target = getTarget();
  let summaryMsg = `📊 *NIGHTLY WATER LEADERBOARD* 🚰\n\n`;

  for (const user of Object.values(dbUsers)) {
    const count = user.logsToday.length;
    const statusEmoji =
      count >= target
        ? "✅"
        : user.shield > 0
          ? "🛡️ (Shield Active)"
          : "⚠️ (At Risk)";
    summaryMsg += `• *${user.name}*: ${count}/${target} logged | Streak: ${user.streak} days ${statusEmoji}\n`;
  }

  return summaryMsg;
}

module.exports = {
  buildVisionPrompt,
  formatAdminOverrideMessage,
  formatCooldownMessage,
  formatLogRejectedMessage,
  formatLogSuccessMessage,
  formatNightlySummary,
  formatNoOverrideMessage,
  formatNotAdminMessage,
  formatStandings,
};
