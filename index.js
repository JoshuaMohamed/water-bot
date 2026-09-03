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

  const hasStaleSession = staleFiles.some((file) =>
    fs.existsSync(path.join(sessionDir, file)),
  );

  if (!hasStaleSession) {
    return;
  }

  console.log("Removing stale WhatsApp auth session before startup...");
  fs.rmSync(targetDir, { recursive: true, force: true });
}

function createClient() {
  cleanupStaleAuth(authPath);

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: authPath }),
    puppeteer: {
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    },
  });

  client.on("qr", (qr) => {
    qrcode.generate(qr, { small: true });
  });

  registerBot(client);
  return client;
}

module.exports = { cleanupStaleAuth, createClient };

if (require.main === module) {
  createClient().initialize();
}
