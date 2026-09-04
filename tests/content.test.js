const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  formatCooldownMessage,
  formatLogSuccessMessage,
  formatLogRejectedMessage,
  formatAdminOverrideMessage,
  formatNoOverrideMessage,
  formatNotAdminMessage,
  formatStandings,
  formatNightlySummary,
} = require("../content");

describe("content", () => {
  it("cooldown message names the user and wait time", () => {
    const msg = formatCooldownMessage("Alice", 7, 10);
    assert.match(msg, /Alice/);
    assert.match(msg, /7 min/);
    assert.match(msg, /10-minute/);
  });

  it("success message shows progress and goal state", () => {
    assert.match(formatLogSuccessMessage("Nice!", 2), /2\/4/);
    assert.match(formatLogSuccessMessage("Nice!", 2), /to go/);
    assert.match(formatLogSuccessMessage("Nice!", 4), /Goal hit/);
  });

  it("rejection points at the override command", () => {
    assert.match(formatLogRejectedMessage("Nope"), /!override/);
  });

  it("override and empty-override messages are clear", () => {
    assert.match(formatAdminOverrideMessage("Bob", 3), /Bob/);
    assert.match(formatNoOverrideMessage(), /No recently rejected/);
    assert.match(formatNotAdminMessage(), /admin/i);
  });

  it("standings list every user with streak and shields", () => {
    const text = formatStandings({
      "1@c.us": { name: "Alice", logsToday: [1, 2], streak: 3, shield: 1 },
      "2@c.us": { name: "Bob", logsToday: [], streak: 0, shield: 0 },
    });
    assert.match(text, /Alice/);
    assert.match(text, /Bob/);
    assert.match(text, /Streak/);
  });

  it("nightly summary flags goal, shield, and at-risk users", () => {
    const text = formatNightlySummary({
      "1@c.us": { name: "Alice", logsToday: [1, 2, 3, 4], streak: 5, shield: 1 },
      "2@c.us": { name: "Bob", logsToday: [1], streak: 1, shield: 1 },
      "3@c.us": { name: "Cara", logsToday: [], streak: 0, shield: 0 },
    });
    assert.match(text, /✅/);
    assert.match(text, /Shield Active/);
    assert.match(text, /At Risk/);
  });
});
