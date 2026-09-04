require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const { registerBot } = require("./botController");

const authPath =
  process.env.WWEBJS_AUTH_PATH || path.join(__dirname, ".wwebjs_auth");

function cleanupStaleAuth(targetDir) {
  const sessionDir = path.join(targetDir, "session");
  const staleFiles = [
    "SingletonLock",
    "SingletonSocket",
    "SingletonCookie",
    "DevToolsActivePort",
  ];

  if (!fs.existsSync(sessionDir)) {
    return;
  }

  const staleSessionFiles = staleFiles.filter((file) =>
    fs.existsSync(path.join(sessionDir, file)),
  );

  if (staleSessionFiles.length === 0) {
    return;
  }

  for (const file of staleSessionFiles) {
    fs.rmSync(path.join(sessionDir, file), { force: true });
  }
}

function createClient() {
  cleanupStaleAuth(authPath);

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: authPath }),
    puppeteer: {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--single-process",
        "--no-zygote",
      ],
    },
  });

  client.on("qr", (qr) => {
    qrcode.generate(qr, { small: true });
  });

  client.on("authenticated", () => {
    console.log("[water-bot] WhatsApp authenticated");
  });

  client.on("auth_failure", (message) => {
    console.error("[water-bot] WhatsApp auth failure:", message);
  });

  client.on("disconnected", (reason) => {
    console.log("[water-bot] WhatsApp disconnected:", reason);
  });

  registerBot(client);
  return client;
}

module.exports = { cleanupStaleAuth, createClient };

if (require.main === module) {
  createClient().initialize();
}
