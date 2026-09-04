const { describe, it, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const path = require("path");
const fs = require("fs");

const tmpDb = path.join(
  os.tmpdir(),
  `water-override-test-${Date.now()}-${process.pid}.db`,
);
const store = require("../store");
store._setDbPathForTests(tmpDb);
const { handleMessage } = require("../botController");

after(() => {
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    try {
      fs.rmSync(tmpDb + suffix, { force: true });
    } catch {
      // Best effort cleanup.
    }
  }
});

const GROUP = "555000@g.us";
const ALICE = "11111@c.us";
const BOB = "22222@c.us";
const ADMIN = "99999@c.us";

let chatSeq = 0;

function photoMsg(author, name) {
  return {
    from: GROUP,
    author,
    fromMe: false,
    hasMedia: true,
    type: "image",
    _data: { notifyName: name },
  };
}

// Builds an !override message. fromMe:true makes the sender admin via the
// same-account rule, no ADMIN_NUMBERS env needed.
function overrideMsg({ quoted = null, fromMe = true, author = ADMIN } = {}) {
  const sent = [];
  const msg = {
    body: "!override",
    author,
    from: GROUP,
    fromMe,
    hasQuotedMsg: Boolean(quoted),
    _data: quoted ? { quotedMsg: {} } : {},
    getChat: async () => ({ id: { _serialized: GROUP } }),
    reply: async (text) => {
      sent.push(text);
      chatSeq += 1;
      return { id: { _serialized: `reply-${chatSeq}` } };
    },
  };
  if (quoted) msg.getQuotedMessage = async () => quoted;
  return { msg, sent };
}

function logsOf(userId) {
  return store.loadData().groups[GROUP]?.users[userId]?.logsToday.length || 0;
}

beforeEach(() => {
  store.resetDailyLogs();
});

describe("!override target resolution", () => {
  it("replying to a photo credits the photo author, not the lastRejected slot", async () => {
    // Alice rejected first, then the admin's own photo was rejected last,
    // clobbering the single per-chat slot — the reported bug credited Admin.
    store.setLastRejected(GROUP, ALICE, "Alice");
    store.setLastRejected(GROUP, ADMIN, "Admin");

    const { msg, sent } = overrideMsg({ quoted: photoMsg(ALICE, "Alice") });
    await handleMessage({}, msg);

    assert.match(sent[0], /Alice/);
    assert.equal(logsOf(ALICE), 1);
    assert.equal(logsOf(ADMIN), 0);
  });

  it("replying to a photo works with no lastRejected entry at all", async () => {
    assert.equal(store.getLastRejected(GROUP), null);
    const { msg, sent } = overrideMsg({ quoted: photoMsg(BOB, "Bob") });
    await handleMessage({}, msg);

    assert.match(sent[0], /Bob/);
    assert.equal(logsOf(BOB), 1);
  });

  it("standalone !override still falls back to the lastRejected slot", async () => {
    store.setLastRejected(GROUP, ALICE, "Alice");
    const { msg, sent } = overrideMsg();
    await handleMessage({}, msg);

    assert.match(sent[0], /Alice/);
    assert.equal(logsOf(ALICE), 1);
  });

  it("standalone !override with nothing recent reports no override", async () => {
    assert.equal(store.getLastRejected(GROUP), null);
    const { msg, sent } = overrideMsg();
    await handleMessage({}, msg);

    assert.match(sent[0], /No recently rejected/);
  });

  it("replying to a text notice (not a photo) falls back to lastRejected", async () => {
    store.setLastRejected(GROUP, BOB, "Bob");
    const botNotice = {
      from: GROUP,
      fromMe: true,
      hasMedia: false,
      type: "chat",
      body: "Couldn't verify that photo",
      _data: {},
    };
    const { msg, sent } = overrideMsg({ quoted: botNotice });
    await handleMessage({}, msg);

    assert.match(sent[0], /Bob/);
    assert.equal(logsOf(BOB), 1);
  });

  it("non-admin !override is rejected", async () => {
    store.setLastRejected(GROUP, ALICE, "Alice");
    const { msg, sent } = overrideMsg({ fromMe: false, author: "77777@c.us" });
    // senderNumber 77777 is not in ADMIN_NUMBERS (unset) -> not admin.
    await handleMessage({}, msg);

    assert.match(sent[0], /Only admins/);
    assert.equal(logsOf(ALICE), 0);
  });
});
