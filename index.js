require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const { registerBot } = require("./botController");
const logger = require("./logger");

const authPath =
  process.env.WWEBJS_AUTH_PATH || path.join(__dirname, ".wwebjs_auth");

function cleanupStaleAuth(targetDir) {
  const staleNames = new Set([
    "SingletonLock",
    "SingletonSocket",
    "SingletonCookie",
    "DevToolsActivePort",
  ]);

  if (!targetDir || !fs.existsSync(targetDir)) {
    return;
  }

  // LocalAuth stores the Chromium profile under
  // <dataPath>/session-<clientId>/ (default: session-client), not
  // <dataPath>/session. The volume at /data persists across Railway
  // restarts on different hosts, so a SingletonLock from the previous
  // container blocks Chromium with:
  // "The profile appears to be in use by another Chromium process".
  // Walk the whole auth dir and remove stale lock files.
  const stack = [targetDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (staleNames.has(entry.name)) {
        try {
          fs.rmSync(fullPath, { force: true });
        } catch {
          // Best-effort: a leftover lock must never crash boot.
        }
      }
    }
  }
}

function resolveChromiumPath() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore and try next candidate
    }
  }
  return undefined;
}

function createClient() {
  cleanupStaleAuth(authPath);

  // Dockerfile sets PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium with
  // PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true. whatsapp-web.js/puppeteer
  // will otherwise try its (missing) bundled Chromium. Pass it through,
  // with fallbacks for chromium-browser / google-chrome image variants.
  const executablePath = resolveChromiumPath();

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: authPath }),
    puppeteer: {
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      timeout: 60000,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-zygote",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-background-networking",
      ],
    },
  });

  client.on("qr", (qr) => {
    qrcode.generate(qr, { small: true });
  });

  client.on("authenticated", () => {
    logger.info("WhatsApp authenticated");
  });

  client.on("auth_failure", (message) => {
    logger.error("WhatsApp auth failure:", message);
  });

  client.on("disconnected", (reason) => {
    logger.info("WhatsApp disconnected:", reason);
  });

  registerBot(client);
  return client;
}

module.exports = { cleanupStaleAuth, createClient, resolveChromiumPath };

if (require.main === module) {
  createClient().initialize();
}
