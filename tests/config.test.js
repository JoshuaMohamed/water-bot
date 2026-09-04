const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

process.env.DAILY_TARGET = "abc"; // invalid -> falls back to 4
process.env.COOLDOWN_MINUTES = "0"; // invalid -> falls back to 10
process.env.OVERRIDE_WINDOW_MINUTES = "5";
process.env.ADMIN_NUMBERS = " 15551234567, +15557654321 ";

const { config, isAdmin } = require("../config");

describe("config", () => {
  it("falls back to safe defaults on invalid numbers", () => {
    assert.equal(config.dailyTarget, 4);
    assert.equal(config.cooldownMinutes, 10);
    assert.equal(config.overrideWindowMs, 5 * 60 * 1000);
  });

  it("parses admin numbers digit-only", () => {
    assert.ok(config.adminNumbers.has("15551234567"));
    assert.ok(config.adminNumbers.has("15557654321"));
  });

  it("treats same-account (fromMe) messages as admin", () => {
    assert.equal(isAdmin({ senderNumber: "", fromMe: true }), true);
    assert.equal(
      isAdmin({ senderNumber: "15551234567", fromMe: false }),
      true,
    );
    assert.equal(isAdmin({ senderNumber: "19998887777", fromMe: false }), false);
    assert.equal(isAdmin({ senderNumber: "", fromMe: false }), false);
  });
});
