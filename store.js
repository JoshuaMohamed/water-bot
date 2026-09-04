const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { config } = require("./config");

const LEGACY_JSON = path.join(__dirname, "data.json");

let db = null;
let dbPath = null;

function openDb(targetPath) {
  const instance = new DatabaseSync(targetPath);
  instance.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS users (
      chat_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT 'Hydrator',
      streak INTEGER NOT NULL DEFAULT 0,
      shield INTEGER NOT NULL DEFAULT 1,
      last_log_ts INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (chat_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_logs_chat_user ON logs(chat_id, user_id);
    CREATE TABLE IF NOT EXISTS rejected (
      chat_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      user_name TEXT NOT NULL,
      ts INTEGER NOT NULL
    );
  `);
  return instance;
}

function getDb() {
  if (!db) {
    dbPath = config.dbPath;
    const dir = path.dirname(dbPath);
    if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    db = openDb(dbPath);
    migrateLegacyJsonIfNeeded();
  }
  return db;
}

// Test hook: point the store at a temp file.
function _setDbPathForTests(targetPath) {
  if (db) {
    db.close();
    db = null;
  }
  dbPath = targetPath;
  const dir = path.dirname(targetPath);
  if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  db = openDb(targetPath);
}

function tableIsEmpty(table) {
  return getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n === 0;
}

function normalizeImportedShield(user) {
  if (typeof user.shield === "number") return user.shield;
  if (typeof user.shields === "number") return user.shields;
  return 1;
}

// One-time import from the old data.json layout (groups + legacy users).
// Runs only when the DB is empty; the JSON is renamed to a backup.
// Set WATER_SKIP_LEGACY_MIGRATION=1 to disable (tests).
function migrateLegacyJsonIfNeeded() {
  if (process.env.WATER_SKIP_LEGACY_MIGRATION === "1") return;
  if (!fs.existsSync(LEGACY_JSON)) return;
  if (!tableIsEmpty("users") || !tableIsEmpty("logs")) return;

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(LEGACY_JSON, "utf-8"));
  } catch {
    return;
  }

  const groups =
    raw.groups && typeof raw.groups === "object" ? raw.groups : {};
  if (Object.keys(groups).length === 0 && raw.users) {
    groups.legacy = { users: raw.users, lastRejectedLog: raw.lastRejectedLog };
  }

  const database = getDb();
  database.exec("BEGIN IMMEDIATE");
  try {
    const upsertUser = database.prepare(`
      INSERT INTO users (chat_id, user_id, name, streak, shield, last_log_ts)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id, user_id) DO NOTHING
    `);
    const insertLog = database.prepare(`
      INSERT INTO logs (chat_id, user_id, ts) VALUES (?, ?, ?)
    `);
    const upsertRejected = database.prepare(`
      INSERT INTO rejected (chat_id, user_id, user_name, ts)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET user_id = excluded.user_id, user_name = excluded.user_name, ts = excluded.ts
    `);

    for (const [chatId, group] of Object.entries(groups)) {
      for (const [userId, user] of Object.entries(group.users || {})) {
        upsertUser.run(
          chatId,
          userId,
          user.name || "Hydrator",
          user.streak || 0,
          normalizeImportedShield(user || {}),
          user.lastLogTimestamp || 0,
        );
        for (const ts of Array.isArray(user.logsToday) ? user.logsToday : []) {
          insertLog.run(chatId, userId, ts);
        }
      }
      const rej = group.lastRejectedLog;
      if (rej && rej.userId) {
        upsertRejected.run(
          chatId,
          rej.userId,
          rej.userName || "Hydrator",
          rej.timestamp || Date.now(),
        );
      }
    }
    database.exec("COMMIT");
  } catch {
    database.exec("ROLLBACK");
    return;
  }

  try {
    fs.renameSync(LEGACY_JSON, `${LEGACY_JSON}.migrated`);
  } catch {
    // Keep the JSON in place; migration won't rerun once tables are filled.
  }
}

function rowToUser(row, logsToday) {
  return {
    name: row.name,
    streak: row.streak,
    shield: row.shield,
    logsToday,
    lastLogTimestamp: row.last_log_ts,
  };
}

function getUser(chatId, userId, userName) {
  const database = getDb();
  const existing = database
    .prepare("SELECT * FROM users WHERE chat_id = ? AND user_id = ?")
    .get(chatId, userId);
  if (!existing) {
    database
      .prepare(
        "INSERT INTO users (chat_id, user_id, name) VALUES (?, ?, ?)",
      )
      .run(chatId, userId, userName || "Hydrator");
    return {
      name: userName || "Hydrator",
      streak: 0,
      shield: 1,
      logsToday: [],
      lastLogTimestamp: 0,
    };
  }
  if (
    userName &&
    existing.name !== userName &&
    (existing.name === "Hydrator" || !existing.name)
  ) {
    database
      .prepare("UPDATE users SET name = ? WHERE chat_id = ? AND user_id = ?")
      .run(userName, chatId, userId);
    existing.name = userName;
  }
  const logs = database
    .prepare(
      "SELECT ts FROM logs WHERE chat_id = ? AND user_id = ? ORDER BY ts ASC",
    )
    .all(chatId, userId)
    .map((r) => r.ts);
  return rowToUser(existing, logs);
}

// Read-only: unlike the old JSON store, checking cooldown never creates or
// modifies a user row.
function canLog(chatId, userId, cooldownMinutes = 10) {
  const row = getDb()
    .prepare("SELECT last_log_ts FROM users WHERE chat_id = ? AND user_id = ?")
    .get(chatId, userId);
  if (!row) return { allowed: true, remainingMinutes: 0 };
  const now = Date.now();
  const elapsedMinutes = (now - row.last_log_ts) / (1000 * 60);
  return {
    allowed: elapsedMinutes >= cooldownMinutes,
    remainingMinutes: Math.max(
      0,
      Math.ceil(cooldownMinutes - elapsedMinutes),
    ),
  };
}

function recordLog(chatId, userId, userName) {
  const database = getDb();
  getUser(chatId, userId, userName);
  const now = Date.now();
  database
    .prepare("INSERT INTO logs (chat_id, user_id, ts) VALUES (?, ?, ?)")
    .run(chatId, userId, now);
  database
    .prepare("UPDATE users SET last_log_ts = ? WHERE chat_id = ? AND user_id = ?")
    .run(now, chatId, userId);
  return getUser(chatId, userId, userName);
}

function setLastRejected(chatId, userId, userName) {
  getDb()
    .prepare(
      `INSERT INTO rejected (chat_id, user_id, user_name, ts)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET user_id = excluded.user_id, user_name = excluded.user_name, ts = excluded.ts`,
    )
    .run(chatId, userId, userName, Date.now());
}

function getLastRejected(chatId) {
  const row = getDb()
    .prepare("SELECT * FROM rejected WHERE chat_id = ?")
    .get(chatId);
  if (!row) return null;
  return {
    userId: row.user_id,
    userName: row.user_name,
    chatId,
    timestamp: row.ts,
  };
}

// Shape kept for standings/summary readers: { groups: { [chatId]: { users, lastRejectedLog } } }
function loadData() {
  const database = getDb();
  const groups = {};
  for (const row of database.prepare("SELECT * FROM users").all()) {
    groups[row.chat_id] = groups[row.chat_id] || {
      users: {},
      lastRejectedLog: null,
    };
    const logs = database
      .prepare(
        "SELECT ts FROM logs WHERE chat_id = ? AND user_id = ? ORDER BY ts ASC",
      )
      .all(row.chat_id, row.user_id)
      .map((r) => r.ts);
    groups[row.chat_id].users[row.user_id] = rowToUser(row, logs);
  }
  for (const row of database.prepare("SELECT * FROM rejected").all()) {
    groups[row.chat_id] = groups[row.chat_id] || {
      users: {},
      lastRejectedLog: null,
    };
    groups[row.chat_id].lastRejectedLog = {
      userId: row.user_id,
      userName: row.user_name,
      chatId: row.chat_id,
      timestamp: row.ts,
    };
  }
  return { groups };
}

// Deprecated: the JSON read-modify-write cycle is gone. Kept so old callers
// don't crash; bulk-imports the shape instead of overwriting a file.
function saveData(data) {
  if (!data || typeof data !== "object") return;
  const database = getDb();
  const groups =
    data.groups && typeof data.groups === "object" ? data.groups : {};
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const [chatId, group] of Object.entries(groups)) {
      for (const [userId, user] of Object.entries(group.users || {})) {
        database
          .prepare(
            `INSERT INTO users (chat_id, user_id, name, streak, shield, last_log_ts)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(chat_id, user_id) DO UPDATE SET name = excluded.name, streak = excluded.streak, shield = excluded.shield, last_log_ts = excluded.last_log_ts`,
          )
          .run(
            chatId,
            userId,
            user.name || "Hydrator",
            user.streak || 0,
            normalizeImportedShield(user || {}),
            user.lastLogTimestamp || 0,
          );
      }
    }
    database.exec("COMMIT");
  } catch {
    database.exec("ROLLBACK");
  }
}

function listChatIds() {
  const ids = new Set();
  for (const row of getDb().prepare("SELECT chat_id FROM users").all()) {
    ids.add(row.chat_id);
  }
  for (const row of getDb().prepare("SELECT chat_id FROM rejected").all()) {
    ids.add(row.chat_id);
  }
  return [...ids];
}

function resetDailyLogs() {
  const database = getDb();
  // Sunday check in UTC to match the container timezone (TZ=UTC).
  const isSunday = new Date().getUTCDay() === 0;
  const target = config.dailyTarget;

  database.exec("BEGIN IMMEDIATE");
  try {
    const users = database.prepare("SELECT * FROM users").all();
    const countStmt = database.prepare(
      "SELECT COUNT(*) AS n FROM logs WHERE chat_id = ? AND user_id = ?",
    );
    const updateStmt = database.prepare(
      "UPDATE users SET streak = ?, shield = ? WHERE chat_id = ? AND user_id = ?",
    );
    for (const user of users) {
      const loggedCount = countStmt.get(user.chat_id, user.user_id).n;
      let { streak, shield } = user;
      if (loggedCount < target) {
        if (shield > 0) shield -= 1;
        else streak = 0;
      } else {
        streak += 1;
      }
      if (isSunday) shield = 1;
      updateStmt.run(streak, shield, user.chat_id, user.user_id);
    }
    database.prepare("DELETE FROM logs").run();
    database.prepare("DELETE FROM rejected").run();
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

module.exports = {
  loadData,
  saveData,
  getUser,
  canLog,
  recordLog,
  setLastRejected,
  getLastRejected,
  resetDailyLogs,
  listChatIds,
  _setDbPathForTests,
};
