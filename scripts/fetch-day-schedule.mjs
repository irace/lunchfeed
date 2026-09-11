#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const DAY_SCHEDULE_URL = "https://osborn.ryeschools.org/calendar/calendar_375_gmt.ics";
const outputPath = join("docs", "osborn-day-schedule.ics");

const response = await fetch(DAY_SCHEDULE_URL, {
  headers: { "user-agent": "lunchfeed/1.0 (+school day-cycle calendar)" },
});
if (!response.ok) throw new Error(`GET ${DAY_SCHEDULE_URL} failed: ${response.status}`);

const sourceCalendar = await response.text();
if (!sourceCalendar.includes("BEGIN:VCALENDAR") || !sourceCalendar.includes("SUMMARY:Day ")) {
  throw new Error("The Osborn day schedule response was not the expected iCalendar feed");
}

const unfolded = sourceCalendar.replace(/\r?\n[ \t]/g, "");
const events = [];
for (const block of unfolded.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) || []) {
  const date = block.match(/^DTSTART(?:;[^:]*)?:(\d{8})$/m)?.[1];
  const summary = block.match(/^SUMMARY:(Day [1-6])$/m)?.[1];
  if (date && summary) events.push({ date, summary });
}
if (!events.length) throw new Error("The Osborn day schedule did not contain any cycle days");

events.sort((left, right) => left.date.localeCompare(right.date));
const calendar = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Lunchfeed//Osborn Day Schedule//EN",
  "CALSCALE:GREGORIAN",
  "X-WR-CALNAME:Osborn Day Schedule",
  ...events.flatMap(({ date, summary }) => [
    "BEGIN:VEVENT",
    `DTSTART;VALUE=DATE:${date}`,
    `SUMMARY:${summary}`,
    "END:VEVENT",
  ]),
  "END:VCALENDAR",
  "",
].join("\r\n");

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, calendar, "utf8");
console.log(`Wrote ${outputPath} (${events.length} cycle days)`);
