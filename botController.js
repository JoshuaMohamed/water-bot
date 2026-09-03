const cron = require("node-cron");
const store = require("./store");
const {
  formatAdminOverrideMessage,
  formatCooldownMessage,
  formatLogRejectedMessage,
  formatLogSuccessMessage,
  formatNightlySummary,
  formatNoOverrideMessage,
  formatStandings,
} = require("./content");
const { inspectWaterPhoto } = require("./referee");

function getSenderInfo(msg) {
  const rawId = msg.author || msg.from || "";
  const cleanNumber = rawId.split(":")[0].split("@")[0];
  const userId = cleanNumber ? `${cleanNumber}@c.us` : rawId;
  const userName = msg._data?.notifyName || msg._data?.pushname || "Hydrator";

  return { userId, userName };
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

function getMessageTrace(msg) {
  const body = getMessageText(msg);
  return {
    id: msg.id?._serialized || msg.id || null,
    from: msg.from || null,
    author: msg.author || null,
    hasMedia: Boolean(msg.hasMedia),
    bodyPreview: body.slice(0, 120),
    fromMe: Boolean(msg.fromMe),
  };
}

async function getImageData(client, msg) {
  if (typeof msg.downloadMedia === "function") {
    try {
      const downloaded = await msg.downloadMedia();
      if (downloaded?.data) {
        console.log("[water-bot] getImageData: using downloadMedia payload", {
          mimetype: downloaded.mimetype || "image/jpeg",
          dataLength: downloaded.data.length,
        });

        return {
          buffer: Buffer.from(downloaded.data, "base64"),
          mimetype: downloaded.mimetype || "image/jpeg",
        };
      }
    } catch (error) {
      console.error("[water-bot] downloadMedia failed:", error.message);
    }
  }

  const rawBody = msg._data?.body || msg._data?.preview;
  console.log("[water-bot] getImageData: checking payload", {
    msgId: msg.id?._serialized || msg.id,
    hasMedia: msg.hasMedia,
    hasRawBody: Boolean(rawBody),
    rawBodyLength: typeof rawBody === "string" ? rawBody.length : 0,
    mimetype: msg._data?.mimetype || "image/jpeg",
    from: msg.from,
  });

  if (rawBody && typeof rawBody === "string") {
    const base64Data = rawBody.includes(",") ? rawBody.split(",")[1] : rawBody;
    if (base64Data && base64Data.length > 100) {
      console.log("[water-bot] getImageData: using raw media body payload");
      return {
        buffer: Buffer.from(base64Data, "base64"),
        mimetype: msg._data?.mimetype || "image/jpeg",
      };
    }
  }

  try {
    const serializedId = msg.id?._serialized || msg.id;
    const base64 = await client.pupPage.evaluate(async (targetId) => {
      const imgEl = document.querySelector(`[data-id="${targetId}"] img`);
      if (imgEl && imgEl.src) {
        if (imgEl.src.startsWith("data:")) {
          return imgEl.src.split(",")[1];
        }
        if (imgEl.src.startsWith("blob:")) {
          const response = await fetch(imgEl.src);
          const blob = await response.blob();
          return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result.split(",")[1]);
            reader.readAsDataURL(blob);
          });
        }
      }
      return null;
    }, serializedId);

    if (base64) {
      console.log("[water-bot] getImageData: extracted media from DOM", {
        base64Length: base64.length,
      });
      return {
        buffer: Buffer.from(base64, "base64"),
        mimetype: "image/jpeg",
      };
    }

    console.log("[water-bot] getImageData: no image data found in DOM");
  } catch (error) {
    console.error("[water-bot] DOM image extraction failed:", error.message);
  }

  return null;
}

async function getChatContext(msg) {
  let chatId = msg.from || msg.chatId || msg.to || msg._data?.chatId || null;
  let chatName = "";
  let isGroup = false;

  try {
    const chat = await msg.getChat();
    chatId = chat?.id?._serialized || chatId;
    chatName = (
      chat?.name ||
      chat?.formattedTitle ||
      chat?.subject ||
      chat?.groupMetadata?.subject ||
      ""
    ).trim();
    isGroup = Boolean(chat?.isGroup);
  } catch {
    // If getChat() is unavailable, fall back to the raw message IDs above.
  }

  return { chatId, chatName, isGroup };
}

async function handleMessage(client, msg) {
  if (msg.fromMe) {
    return;
  }

  const body = getMessageText(msg);
  const normalizedBody = body.toLowerCase();
  const chatInfo = await getChatContext(msg);
  const chatId = chatInfo.chatId || msg.to || msg.chatId || msg.from;

  console.log("[water-bot] message received", {
    from: msg.from,
    chatId,
    hasMedia: Boolean(msg.hasMedia),
    bodyPreview: body.slice(0, 120),
    isGroup: chatInfo.isGroup,
    chatName: chatInfo.chatName,
  });

  if (!isRelevantMessage(msg)) {
    console.log(
      "[water-bot] ignoring message: no #water trigger or admin command",
    );
    return;
  }

  if (normalizedBody.includes("#water")) {
    console.log("[water-bot] #water media trigger detected");
    const { userId, userName } = getSenderInfo(msg);

    const cooldown = store.canLog(
      chatId,
      userId,
      parseInt(process.env.COOLDOWN_MINUTES || "10"),
    );
    console.log("[water-bot] cooldown check", {
      userId,
      allowed: cooldown.allowed,
      remainingMinutes: cooldown.remainingMinutes,
    });

    if (!cooldown.allowed) {
      await msg.reply(
        formatCooldownMessage(userName, cooldown.remainingMinutes),
      );
      return;
    }

    try {
      const imageData = await getImageData(client, msg);
      console.log("[water-bot] imageData result", {
        hasImageData: Boolean(imageData),
        mimetype: imageData?.mimetype,
        size: imageData?.buffer?.length || 0,
      });

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

      console.log("[water-bot] model evaluation", evaluation);

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
      console.error("[water-bot] Error processing image:", error);
      await msg.reply("❌ Failed to process photo. Please try again!");
    }
  }

  if (body.trim() === "!override") {
    const lastRejected = store.getLastRejected(chatId);
    if (lastRejected && Date.now() - lastRejected.timestamp < 10 * 60 * 1000) {
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

function attachMessageListeners(client) {
  const seenMessages = new Set();

  const traceAndHandle = async (eventName, msg) => {
    const trace = getMessageTrace(msg);
    if (!seenMessages.has(trace.id)) {
      seenMessages.add(trace.id);
      console.log(`[water-bot] ${eventName}`, trace);
    }

    try {
      await handleMessage(client, msg);
    } catch (error) {
      console.error(`[water-bot] ${eventName} handler error:`, error);
    }
  };

  client.on("message_create", (msg) => traceAndHandle("message_create", msg));
  client.on("message", (msg) => traceAndHandle("message", msg));
}

function registerBot(client) {
  client.on("ready", () => {
    console.log("✅ Water Referee Bot is online and listening!");

    cron.schedule("0 21 * * *", async () => {
      console.log("Running 9:00 PM Nightly Summary...");
      const db = store.loadData();
      for (const group of Object.values(db.groups)) {
        const summaryMsg = formatNightlySummary(group.users);
        console.log(summaryMsg);
      }
    });

    cron.schedule("0 0 * * *", () => {
      console.log("Resetting daily logs & updating streaks/shields...");
      store.resetDailyLogs();
    });
  });

  attachMessageListeners(client);
}

module.exports = { registerBot };
