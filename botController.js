const cron = require("node-cron");
const store = require("./store");
const { config, isAdmin } = require("./config");
const logger = require("./logger");
const {
  formatAdminOverrideMessage,
  formatCooldownMessage,
  formatLogRejectedMessage,
  formatLogSuccessMessage,
  formatNightlySummary,
  formatNoOverrideMessage,
  formatNotAdminMessage,
  formatStandings,
} = require("./content");
const { inspectWaterPhoto } = require("./referee");

function getSenderInfo(msg) {
  const rawId = msg.author || msg.from || "";
  const cleanNumber = rawId.split(":")[0].split("@")[0];
  const senderNumber = cleanNumber.replace(/\D/g, "");
  const userId = cleanNumber ? `${cleanNumber}@c.us` : rawId;
  const userName = msg._data?.notifyName || msg._data?.pushname || "Hydrator";

  return { userId, userName, senderNumber };
}

function getMessageText(msg) {
  return (msg.body || msg._data?.body || msg._data?.caption || "").trim();
}

function isRelevantMessage(msg) {
  const text = getMessageText(msg).toLowerCase();
  return (
    text.includes("#water") || text === "!override" || text === "!standings"
  );
}

async function getImageData(msg) {
  if (typeof msg.downloadMedia !== "function") return null;
  try {
    const downloaded = await msg.downloadMedia();
    if (!downloaded?.data) return null;
    return {
      buffer: Buffer.from(downloaded.data, "base64"),
      mimetype: downloaded.mimetype || "image/jpeg",
    };
  } catch {
    return null;
  }
}

async function getChatId(msg) {
  try {
    const chat = await msg.getChat();
    if (chat?.id?._serialized) return chat.id._serialized;
  } catch {
    // If getChat() is unavailable, fall back to the raw message IDs below.
  }
  return msg.from || msg.chatId || msg.to || msg._data?.chatId || null;
}

async function handleMessage(client, msg) {
  // Same-account bot: the owner sends commands from the logged-in account
  // itself (fromMe). Never block those — bot replies carry no command
  // triggers, so the relevance filter below already prevents self-loops.

  const body = getMessageText(msg);
  const normalizedBody = body.toLowerCase();
  const chatId = (await getChatId(msg)) || msg.to || msg.chatId || msg.from;

  if (!isRelevantMessage(msg)) {
    return;
  }

  if (normalizedBody.includes("#water")) {
    const { userId, userName } = getSenderInfo(msg);

    const cooldown = store.canLog(chatId, userId, config.cooldownMinutes);

    if (!cooldown.allowed) {
      await msg.reply(
        formatCooldownMessage(
          userName,
          cooldown.remainingMinutes,
          config.cooldownMinutes,
        ),
      );
      return;
    }

    try {
      const imageData = await getImageData(msg);

      if (!imageData) {
        await msg.reply(
          "❌ Could not read image payload. Please re-send the photo!",
        );
        return;
      }

      const user = store.getUser(chatId, userId, userName);
      const evaluation = await inspectWaterPhoto(
        imageData.buffer,
        imageData.mimetype,
        userName,
        user.logsToday.length,
      );

      if (evaluation.isValid) {
        const updatedUser = store.recordLog(chatId, userId, userName);
        await msg.reply(
          formatLogSuccessMessage(
            evaluation.reason,
            updatedUser.logsToday.length,
          ),
        );
      } else {
        store.setLastRejected(chatId, userId, userName);
        await msg.reply(formatLogRejectedMessage(evaluation.reason));
      }
    } catch (error) {
      logger.error("Error processing image:", error);
      await msg.reply("❌ Failed to process photo. Please try again!");
    }
  }

  if (body.trim() === "!override") {
    const { senderNumber } = getSenderInfo(msg);
    if (!isAdmin({ senderNumber, fromMe: Boolean(msg.fromMe) })) {
      await msg.reply(formatNotAdminMessage());
      return;
    }
    const lastRejected = store.getLastRejected(chatId);
    if (
      lastRejected &&
      Date.now() - lastRejected.timestamp < config.overrideWindowMs
    ) {
      const user = store.recordLog(
        chatId,
        lastRejected.userId,
        lastRejected.userName,
      );
      await msg.reply(
        formatAdminOverrideMessage(
          lastRejected.userName,
          user.logsToday.length,
        ),
      );
    } else {
      await msg.reply(formatNoOverrideMessage());
    }
  }

  if (body.trim() === "!standings") {
    const db = store.loadData();
    const groupUsers = db.groups[chatId]?.users || {};
    await msg.reply(formatStandings(groupUsers));
  }
}

function getMessageId(msg) {
  return msg.id?._serialized || msg.id || null;
}

// Bounded dedup: `message` and `message_create` can both fire for the same
// message. Evict oldest entries + expire after TTL so the cache can't leak.
const SEEN_TTL_MS = 5 * 60 * 1000;
const SEEN_MAX_IDS = 500;
const seenMessageIds = new Map();

function isDuplicateMessage(id) {
  if (!id) return false;
  const now = Date.now();
  const seenAt = seenMessageIds.get(id);
  if (seenAt && now - seenAt < SEEN_TTL_MS) return true;
  seenMessageIds.set(id, now);
  if (seenMessageIds.size > SEEN_MAX_IDS) {
    const oldest = seenMessageIds.keys().next().value;
    seenMessageIds.delete(oldest);
  }
  for (const [key, ts] of seenMessageIds) {
    if (now - ts >= SEEN_TTL_MS) seenMessageIds.delete(key);
    else break;
  }
  return false;
}

function attachMessageListeners(client) {
  const dedupAndHandle = async (msg) => {
    if (isDuplicateMessage(getMessageId(msg))) return;
    try {
      await handleMessage(client, msg);
    } catch (error) {
      logger.error("message handler error:", error);
    }
  };

  client.on("message_create", dedupAndHandle);
  client.on("message", dedupAndHandle);
}

function registerBot(client) {
  client.on("ready", () => {
    logger.info("Water Referee Bot is online and listening!");

    cron.schedule(config.nightlyCron, async () => {
      const db = store.loadData();
      for (const [chatId, group] of Object.entries(db.groups)) {
        try {
          await client.sendMessage(
            chatId,
            formatNightlySummary(group.users),
          );
        } catch (error) {
          logger.error(
            "nightly summary send failed:",
            error.message || error,
          );
        }
      }
    });

    cron.schedule(config.resetCron, () => {
      store.resetDailyLogs();
    });
  });

  attachMessageListeners(client);
}

module.exports = { registerBot, handleMessage, isRelevantMessage };
