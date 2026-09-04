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

// WhatsApp Web's mid-2026 frontend renamed the internal serialized-id
// getter `id._serialized` → `id.$1`. whatsapp-web.js still reads
// `message.id._serialized`, so `downloadMedia()` (and quoted replies) pass
// `undefined` as the message id into `page.evaluate` and the page throws
// the opaque minified `r: r`. Backfill it at the boundary — harmless no-op
// once upstream fixes the library.
function normalizeMessageId(msg) {
  const id = msg?.id;
  if (id && id._serialized == null && id.$1 != null) {
    try {
      id._serialized = id.$1;
    } catch {
      try {
        msg.id = { ...id, _serialized: id.$1 };
      } catch {
        // read-only shape we can't patch — leave as is.
      }
    }
    logger.debug("backfilled message id._serialized from $1");
    return true;
  }
  return false;
}

async function downloadFromMessage(mediaMsg, label = "direct") {
  if (!mediaMsg || typeof mediaMsg.downloadMedia !== "function") return null;
  normalizeMessageId(mediaMsg);
  // `downloadMedia()` runs `resolveMediaBlob` inside the page, which throws
  // a minified single-char error when the blob isn't in the WA Web cache
  // yet (or is gone). The message object from the event can be stale, so
  // reload it before retrying — this is the standard workaround for the
  // "media not yet synced" race.
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1 && typeof mediaMsg.reload === "function") {
      try {
        await mediaMsg.reload();
      } catch (error) {
        logger.warn(
          `downloadMedia ${label} reload before attempt ${attempt} failed:`,
          error?.stack || error?.message || error,
        );
      }
    }
    try {
      const downloaded = await mediaMsg.downloadMedia();
      if (!downloaded?.data) {
        logger.warn(`downloadMedia ${label} attempt ${attempt}: empty payload`);
      } else {
        const buffer = Buffer.from(downloaded.data, "base64");
        if (buffer.length > 0) {
          return {
            buffer,
            mimetype: downloaded.mimetype || "image/jpeg",
          };
        }
        logger.warn(`downloadMedia ${label} attempt ${attempt}: decoded to 0 bytes`);
      }
    } catch (error) {
      logger.warn(
        `downloadMedia ${label} attempt ${attempt} failed:`,
        error?.stack || error?.message || error,
      );
    }
    if (attempt < MAX_ATTEMPTS)
      await new Promise((resolve) =>
        setTimeout(resolve, attempt === 1 ? 1500 : 3000),
      );
  }
  // Booleans only — never log paths/keys.
  // idKeys tells us whether WA Web is still serving the renamed `$1`
  // shape (key names only, no values).
  logger.warn(
    `downloadMedia ${label} gave up:`,
    JSON.stringify({
      hasMedia: mediaMsg.hasMedia,
      type: mediaMsg.type,
      fromMe: mediaMsg.fromMe,
      idKeys: Object.keys(mediaMsg.id || {}),
      hasDirectPath: Boolean(mediaMsg._data?.directPath),
      isViewOnce: Boolean(
        mediaMsg._data?.isViewOnce || mediaMsg._data?.viewMode === 2,
      ),
      isEphemeral: Boolean(mediaMsg._data?.isEphemeral),
      hasDownloadMedia: typeof mediaMsg.downloadMedia === "function",
    }),
  );
  return null;
}

async function getImageData(msg) {
  // Case 1: photo sent WITH "#water" in the caption — media is on this msg.
  // (msg.hasMedia may be undefined on old mocks — treat undefined as "try".)
  if (msg.hasMedia !== false) {
    const direct = await downloadFromMessage(msg, "direct");
    if (direct) return direct;
    // If the message explicitly has media but decryption failed, don't
    // silently fall through — there is nothing else to try except a quote.
    if (msg.hasMedia === true && !msg.hasQuotedMsg && !msg._data?.quotedMsg) {
      return null;
    }
  }

  // Case 2: photo sent first, "#water" sent as a separate message that
  // replies to / quotes the photo — media lives on the quoted message.
  if (msg.hasQuotedMsg || msg._data?.quotedMsg) {
    try {
      if (typeof msg.getQuotedMessage === "function") {
        const quoted = await msg.getQuotedMessage();
        normalizeMessageId(quoted);
        if (quoted?.hasMedia) {
          const fromQuote = await downloadFromMessage(quoted, "quoted");
          if (fromQuote) return fromQuote;
        } else {
          logger.warn("quoted message has no media");
        }
      }
    } catch (error) {
      logger.warn(
        "getQuotedMessage failed:",
        error?.stack || error?.message || error,
      );
    }
  }

  return null;
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

async function getOverrideQuotedTarget(msg) {
  // Resolve the !override target from the quoted message when the admin
  // replied to a photo. Returns { userId, userName } or null when there is
  // no usable quote (standalone !override, quote fetch failed, or the quote
  // is not a photo — e.g. a reply to the bot's own text notice — in which
  // case the caller falls back to the lastRejected slot).
  if (!msg.hasQuotedMsg && !msg._data?.quotedMsg) return null;
  if (typeof msg.getQuotedMessage !== "function") return null;
  try {
    const quoted = await msg.getQuotedMessage();
    normalizeMessageId(quoted);
    if (!quoted || quoted.hasMedia === false) return null;
    const { userId, userName } = getSenderInfo(quoted);
    if (!userId) return null;
    return { userId, userName };
  } catch (error) {
    logger.warn(
      "override getQuotedMessage failed, falling back to lastRejected:",
      error?.stack || error?.message || error,
    );
    return null;
  }
}

async function handleMessage(client, msg) {
  // Same-account bot: the owner sends commands from the logged-in account
  // itself (fromMe), so we can't blanket-ignore fromMe messages.
  // Instead, bot replies must never contain command triggers (like #water),
  // and every bot reply ID is marked seen so message_create for our own
  // outgoing messages is deduped before it can re-trigger.

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
      await botReply(
        msg,
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
        await botReply(
          msg,
          "❌ Couldn't grab that photo. Send the photo WITH the water hashtag in the caption, or reply to the photo with the water hashtag!",
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
        await botReply(
          msg,
          formatLogSuccessMessage(
            evaluation.reason,
            updatedUser.logsToday.length,
          ),
        );
      } else {
        store.setLastRejected(chatId, userId, userName);
        await botReply(msg, formatLogRejectedMessage(evaluation.reason));
      }
    } catch (error) {
      logger.error("Error processing image:", error);
      try {
        await botReply(msg, "❌ Failed to process photo. Please try again!");
      } catch (replyError) {
        logger.error(
          "Failed to send error reply:",
          replyError?.stack || replyError?.message || replyError,
        );
      }
    }
  }

  if (body.trim() === "!override") {
    const { senderNumber } = getSenderInfo(msg);
    if (!isAdmin({ senderNumber, fromMe: Boolean(msg.fromMe) })) {
      await botReply(msg, formatNotAdminMessage());
      return;
    }
    // Preferred target: the author of the quoted/replied-to photo.
    // Admins use override by replying to the rejected photo, so the photo
    // owner must win — the per-chat lastRejected slot may hold someone
    // else's (or the admin's own) more recent rejection.
    const quotedTarget = await getOverrideQuotedTarget(msg);
    if (quotedTarget) {
      const user = store.recordLog(
        chatId,
        quotedTarget.userId,
        quotedTarget.userName,
      );
      const displayName =
        user.name && user.name !== "Hydrator"
          ? user.name
          : quotedTarget.userName;
      await botReply(
        msg,
        formatAdminOverrideMessage(displayName, user.logsToday.length),
      );
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
      await botReply(
        msg,
        formatAdminOverrideMessage(
          lastRejected.userName,
          user.logsToday.length,
        ),
      );
    } else {
      await botReply(msg, formatNoOverrideMessage());
    }
  }

  if (body.trim() === "!standings") {
    const db = store.loadData();
    const groupUsers = db.groups[chatId]?.users || {};
    await botReply(msg, formatStandings(groupUsers));
  }
}

function getMessageId(msg) {
  return msg?.id?._serialized || msg?.id || null;
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

function markMessageSeen(id) {
  if (!id) return;
  seenMessageIds.set(id, Date.now());
  if (seenMessageIds.size > SEEN_MAX_IDS) {
    const oldest = seenMessageIds.keys().next().value;
    seenMessageIds.delete(oldest);
  }
}

// Reply via msg.reply, then mark the outgoing message ID as seen so the
// subsequent `message_create` event for our own reply is deduped instead of
// re-entering handleMessage (self-trigger loop protection). This preserves
// same-account owner commands because only IDs we just sent are ignored.
// Belt-and-braces: scrub "#water" (substring trigger) from everything we
// send, so even a Gemini-written reason containing "#water" can never make
// our own reply look like a new #water command. ("!override"/"!standings"
// need an exact match so they are safe to include in help text.)
async function botReply(msg, content) {
  const safeContent =
    typeof content === "string"
      ? content.replace(/#water/gi, "water")
      : content;
  normalizeMessageId(msg);
  const sent = await msg.reply(safeContent);
  normalizeMessageId(sent);
  markMessageSeen(getMessageId(sent));
  return sent;
}

function attachMessageListeners(client) {
  const dedupAndHandle = async (msg) => {
    normalizeMessageId(msg);
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
          const sent = await client.sendMessage(
            chatId,
            formatNightlySummary(group.users),
          );
          markMessageSeen(getMessageId(sent));
        } catch (error) {
          logger.error(
            "nightly summary send failed:",
            error?.stack || error?.message || error,
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

module.exports = { registerBot, handleMessage, isRelevantMessage, getImageData };
