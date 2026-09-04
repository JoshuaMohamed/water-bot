const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const path = require("path");
const fs = require("fs");

const tmpDb = path.join(
  os.tmpdir(),
  `water-store-test-${Date.now()}-${process.pid}.db`,
);
const store = require("../store");
store._setDbPathForTests(tmpDb);

after(() => {
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    try {
      fs.rmSync(tmpDb + suffix, { force: true });
    } catch {
      // Best effort cleanup.
    }
  }
});

describe("store (sqlite)", () => {
  it("allows a first log without creating rows as a side effect", () => {
    assert.deepEqual(store.canLog("chat1", "u1", 10), {
      allowed: true,
      remainingMinutes: 0,
    });
    assert.deepEqual(store.listChatIds(), []);
  });

  it("records a log then enforces cooldown", () => {
    const user = store.recordLog("chat1", "u1", "Alice");
    assert.equal(user.logsToday.length, 1);
    assert.ok(user.lastLogTimestamp > 0);
    const check = store.canLog("chat1", "u1", 60 * 24);
    assert.equal(check.allowed, false);
    assert.ok(check.remainingMinutes > 0);
  });

  it("round-trips rejected overrides", () => {
    assert.equal(store.getLastRejected("chat1"), null);
    store.setLastRejected("chat1", "u1", "Alice");
    const rejected = store.getLastRejected("chat1");
    assert.equal(rejected.userId, "u1");
    assert.equal(rejected.userName, "Alice");
  });

  it("keeps the standings shape for readers", () => {
    const db = store.loadData();
    assert.equal(db.groups.chat1.users.u1.name, "Alice");
    assert.equal(db.groups.chat1.users.u1.logsToday.length, 1);
  });

  it("reset clears daily logs and rejections", () => {
    store.resetDailyLogs();
    assert.equal(store.getUser("chat1", "u1").logsToday.length, 0);
    assert.equal(store.getLastRejected("chat1"), null);
  });
});
