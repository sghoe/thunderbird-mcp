"use strict";

// Finding C: a lookup by ID can return any calendar item. Task tools must
// only change tasks, event tools only events, and attendee-bearing tasks get
// the same Block-skipReview guard as meetings.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { loadCalendarRuntime } = require("./helpers/calendar-runtime.cjs");

const OTHER = { id: "mailto:guest@example.com", participationStatus: "NEEDS-ACTION" };
const SELF = { id: "mailto:organizer@example.com", participationStatus: "ACCEPTED" };

describe("calendar item type checks", () => {
  it("updateTask refuses an event found by direct lookup", async () => {
    const rt = loadCalendarRuntime({ blockSkipReview: false });
    const event = rt.seedEvent({ id: "meeting-1", attendees: [rt.makeAttendee(OTHER)] });
    const result = await rt.invoke("updateTask", { taskId: "meeting-1", calendarId: "calendar-1", title: "Changed" });
    assert.match(result.error, /not a task/);
    assert.equal(rt.calls.modifies.length, 0);
    assert.equal(event.title, "Existing event");
  });

  it("updateTask refuses an event even without attendees", async () => {
    const rt = loadCalendarRuntime({ blockSkipReview: false });
    rt.seedEvent({ id: "plain-event" });
    const result = await rt.invoke("updateTask", { taskId: "plain-event", calendarId: "calendar-1", completed: true });
    assert.match(result.error, /not a task/);
    assert.equal(rt.calls.modifies.length, 0);
  });

  it("updateEvent and deleteEvent refuse a task", async () => {
    const rt = loadCalendarRuntime({ blockSkipReview: false });
    rt.seedTask({ id: "task-9" });
    const updated = await rt.invoke("updateEvent", { eventId: "task-9", calendarId: "calendar-1", title: "x" });
    const deleted = await rt.invoke("deleteEvent", { eventId: "task-9", calendarId: "calendar-1" });
    assert.match(updated.error, /not an event/);
    assert.match(deleted.error, /not an event/);
    assert.equal(rt.calls.modifies.length, 0);
    assert.equal(rt.calls.deletes.length, 0);
  });

  it("fails closed for items of unknown type", async () => {
    const rt = loadCalendarRuntime({ blockSkipReview: false });
    const item = rt.seedTask({ id: "odd" });
    item.isTodo = undefined;
    item.isEvent = undefined;
    const result = await rt.invoke("updateTask", { taskId: "odd", calendarId: "calendar-1", title: "x" });
    assert.match(result.error, /not a task/);
    assert.equal(rt.calls.modifies.length, 0);
  });

  it("still updates ordinary tasks", async () => {
    const rt = loadCalendarRuntime();
    rt.seedTask({ id: "task-1" });
    const result = await rt.invoke("updateTask", { taskId: "task-1", calendarId: "calendar-1", title: "Renamed" });
    assert.equal(result.success, true, result.error);
    assert.equal(rt.calls.modifies.length, 1);
  });
});

describe("attendee-bearing tasks follow the meeting guard", () => {
  for (const [label, options] of [["default", {}], ["enabled", { blockSkipReview: true }], ["unreadable", { unreadableSkipReview: true }]]) {
    it(`refuses updates of a task with other attendees while Block skipReview is ${label}`, async () => {
      const rt = loadCalendarRuntime(options);
      rt.seedTask({ id: "assigned", attendees: [rt.makeAttendee(OTHER)] });
      const result = await rt.invoke("updateTask", { taskId: "assigned", calendarId: "calendar-1", completed: true });
      assert.match(result.error, /attendee|review/i);
      assert.equal(rt.calls.modifies.length, 0);
    });
  }

  it("allows the update once Block skipReview is off", async () => {
    const rt = loadCalendarRuntime({ blockSkipReview: false });
    rt.seedTask({ id: "assigned", attendees: [rt.makeAttendee(OTHER)] });
    const result = await rt.invoke("updateTask", { taskId: "assigned", calendarId: "calendar-1", completed: true });
    assert.equal(result.success, true, result.error);
  });

  it("refuses the update for a client without calendar.schedule even with Block skipReview off", async () => {
    const { Core } = require("./helpers/core-modules.cjs");
    const capabilities = Object.keys(Core.policy.CAPABILITIES).filter(cap => cap !== "calendar.schedule");
    const rt = loadCalendarRuntime({ blockSkipReview: false, client: { capabilities } });
    rt.seedTask({ id: "assigned", attendees: [rt.makeAttendee(OTHER)] });
    const result = await rt.invoke("updateTask", { taskId: "assigned", calendarId: "calendar-1", completed: true });
    assert.match(result.error, /requires calendar\.schedule/);
    assert.equal(rt.calls.modifies.length, 0);
  });
  it("allows tasks whose only attendee is the calendar user", async () => {
    const rt = loadCalendarRuntime();
    rt.seedTask({ id: "self", attendees: [rt.makeAttendee(SELF)] });
    const result = await rt.invoke("updateTask", { taskId: "self", calendarId: "calendar-1", percentComplete: 50 });
    assert.equal(result.success, true, result.error);
  });
});
