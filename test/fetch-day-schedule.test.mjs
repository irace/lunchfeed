import assert from "node:assert/strict";
import test from "node:test";
import { buildCalendar, parseCycleDays } from "../scripts/fetch-day-schedule.mjs";

test("parses cycle days from the public calendar page", () => {
  const html = `
    <div class="fsCalendarDaybox">
      <div class="fsCalendarDate" data-day="8" data-year="2026" data-month="8"></div>
      <a class="fsCalendarEventTitle" title="Day 1"></a>
      <a class="fsCalendarEventTitle" title="Back to School"></a>
    </div>`;

  assert.deepEqual(parseCycleDays(html), [{ date: "20260908", summary: "Day 1" }]);
});

test("builds a sorted calendar and removes adjacent-month duplicates", () => {
  const calendar = buildCalendar([
    { date: "20260909", summary: "Day 2" },
    { date: "20260908", summary: "Day 1" },
    { date: "20260909", summary: "Day 2" },
  ]);

  assert.match(calendar, /DTSTART;VALUE=DATE:20260908\r\nSUMMARY:Day 1/);
  assert.equal(calendar.match(/DTSTART;VALUE=DATE:20260909/g)?.length, 1);
  assert.ok(calendar.indexOf("20260908") < calendar.indexOf("20260909"));
});
