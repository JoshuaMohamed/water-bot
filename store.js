const fs = require("fs");
const path = require("path");

const DB_FILE = path.join(__dirname, "data.json");

const defaultData = {
  groups: {},
};

function normalizeUser(user, userName) {
  const normalizedShield =
    typeof user.shield === "number"
      ? user.shield
      : typeof user.shields === "number"
        ? user.shields
        : 1;

  return {
    name: user.name || userName || "Hydrator",
    streak: user.streak || 0,
    shield: normalizedShield,
    logsToday: Array.isArray(user.logsToday) ? user.logsToday : [],
    lastLogTimestamp: user.lastLogTimestamp || 0,
  };
}

function normalizeGroup(group = {}) {
  const normalized = {
    users: {},
    lastRejectedLog: group.lastRejectedLog || null,
  };

  for (const [userId, user] of Object.entries(group.users || {})) {
    normalized.users[userId] = normalizeUser(user);
  }

  return normalized;
}

function normalizeData(data) {
  const normalized = { groups: {} };
  const rawGroups =
    data.groups && typeof data.groups === "object" ? data.groups : {};

  for (const [chatId, group] of Object.entries(rawGroups)) {
    normalized.groups[chatId] = normalizeGroup(group || {});
  }

  if (Object.keys(normalized.groups).length === 0) {
    const legacyUsers =
      data.users && typeof data.users === "object" ? data.users : {};
    if (Object.keys(legacyUsers).length > 0) {
      normalized.groups.legacy = normalizeGroup({
        users: legacyUsers,
        lastRejectedLog: data.lastRejectedLog || null,
      });
    }
  }

  return normalized;
}

function loadData() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify(defaultData, null, 2));
    return normalizeData(defaultData);
  }

  const data = JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
  const normalized = normalizeData(data);
  if (JSON.stringify(data) !== JSON.stringify(normalized)) {
    saveData(normalized);
  }
  return normalized;
}

function saveData(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(normalizeData(data), null, 2));
}

function getGroupData(db, chatId) {
  if (!db.groups[chatId]) {
    db.groups[chatId] = { users: {}, lastRejectedLog: null };
  }

  return db.groups[chatId];
}

function ensureUser(db, chatId, userId, userName) {
  const group = getGroupData(db, chatId);

  if (!group.users[userId]) {
    group.users[userId] = normalizeUser({}, userName);
  } else {
    group.users[userId] = normalizeUser(group.users[userId], userName);
  }

  return group.users[userId];
}

function getUser(chatId, userId, userName) {
  const db = loadData();
  const user = ensureUser(db, chatId, userId, userName);
  saveData(db);
  return user;
}

function canLog(chatId, userId, cooldownMinutes = 10) {
  const user = getUser(chatId, userId);
  const now = Date.now();
  const elapsedMinutes = (now - user.lastLogTimestamp) / (1000 * 60);
  return {
    allowed: elapsedMinutes >= cooldownMinutes,
    remainingMinutes: Math.ceil(cooldownMinutes - elapsedMinutes),
  };
}

function recordLog(chatId, userId, userName) {
  const db = loadData();
  const group = getGroupData(db, chatId);
  const user = ensureUser(db, chatId, userId, userName);
  user.lastLogTimestamp = Date.now();
  user.logsToday.push(Date.now());
  group.users[userId] = user;
  saveData(db);
  return user;
}

function setLastRejected(chatId, userId, userName) {
  const db = loadData();
  const group = getGroupData(db, chatId);
  group.lastRejectedLog = { userId, userName, chatId, timestamp: Date.now() };
  saveData(db);
}

function getLastRejected(chatId) {
  const db = loadData();
  return db.groups[chatId]?.lastRejectedLog || null;
}

function resetDailyLogs() {
  const db = loadData();
  const today = new Date();
  const isSunday = today.getDay() === 0;

  for (const [chatId, group] of Object.entries(db.groups)) {
    for (const [id, user] of Object.entries(group.users)) {
      const normalizedUser = normalizeUser(user);
      const loggedCount = normalizedUser.logsToday.length;
      const target = parseInt(process.env.DAILY_TARGET || "4");

      if (loggedCount < target) {
        if (normalizedUser.shield > 0) {
          normalizedUser.shield -= 1;
        } else {
          normalizedUser.streak = 0;
        }
      } else {
        normalizedUser.streak += 1;
      }

      if (isSunday) {
        normalizedUser.shield = 1;
      }

      normalizedUser.logsToday = [];
      group.users[id] = normalizedUser;
    }

    group.lastRejectedLog = null;
    db.groups[chatId] = group;
  }

  saveData(db);
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
};
