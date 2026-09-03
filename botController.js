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

async function getImageData(client, msg) {
  const rawBody = msg._data?.body || msg._data?.preview;
  if (rawBody && typeof rawBody === "string") {
    const base64Data = rawBody.includes(",") ? rawBody.split(",")[1] : rawBody;
    if (base64Data && base64Data.length > 100) {
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
      return {
        buffer: Buffer.from(base64, "base64"),
        mimetype: "image/jpeg",
      };
    }
  } catch (error) {
    console.error("DOM image extraction failed:", error.message);
  }

  return null;
}

function getGroupChatId(msg) {
  const chatId = msg.to || msg.chatId || msg._data?.to || msg._data?.chatId;
  return typeof chatId === "string" && chatId.endsWith("@g.us") ? chatId : null;
}

async function isWaterGroupChat(client, msg) {
  const groupChatId = getGroupChatId(msg);

  if (!groupChatId) {
    return { matches: false, groupChatId: null, chatName: "", isGroup: false };
  }

  let browserChat = null;
  if (client?.pupPage) {
    browserChat = await client.pupPage
      .evaluate(async (targetId) => {
        try {
          const WAW = window.require("WAWebCollections");
          const ChatCollection = WAW.Chat;
          const wid = window.require("WAWebWidFactory").createWid(targetId);
          const chatObj = ChatCollection.get(wid);

          if (!chatObj) {
            return null;
          }

          return {
            id: chatObj.id?._serialized || targetId,
            name:
              chatObj.formattedTitle ||
              chatObj.name ||
              chatObj.groupMetadata?.subject ||
              "",
            formattedTitle: chatObj.formattedTitle || chatObj.name || "",
            isGroup: Boolean(chatObj.isGroup || chatObj.groupMetadata),
            subject: chatObj.groupMetadata?.subject || "",
          };
        } catch (error) {
          return null;
        }
      }, groupChatId)
      .catch(() => null);
  }

  const chatName = (
    browserChat?.name ||
    browserChat?.formattedTitle ||
    browserChat?.subject ||
    ""
  ).trim();
  const normalizedChatName = chatName.toLowerCase();
  const isGroup = Boolean(
    browserChat?.isGroup ||
    (typeof groupChatId === "string" && groupChatId.endsWith("@g.us")),
  );
  const matches = Boolean(isGroup && normalizedChatName.includes("#water"));

  return { matches, groupChatId, chatName, isGroup };
}

async function handleMessage(client, msg) {
  const body = msg.body || "";
  const groupInfo = await isWaterGroupChat(client, msg);
  const chatId = groupInfo.groupChatId || msg.to || msg.chatId || msg.from;

  if (!groupInfo.matches) {
    return;
  }

  if (body.toLowerCase().includes("#water") && msg.hasMedia) {
    const { userId, userName } = getSenderInfo(msg);

    const cooldown = store.canLog(
      chatId,
      userId,
      parseInt(process.env.COOLDOWN_MINUTES || "10"),
    );
    if (!cooldown.allowed) {
      await msg.reply(
        formatCooldownMessage(userName, cooldown.remainingMinutes),
      );
      return;
    }

    try {
      const imageData = await getImageData(client, msg);
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
      console.error("Error processing image:", error);
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

  client.on("message_create", (msg) => handleMessage(client, msg));
}

module.exports = { registerBot };
