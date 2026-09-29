#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";

const CALENDAR_URL = "https://osborn.ryeschools.org/calendar";
const outputPath = join("docs", "osborn-day-schedule.ics");

export function parseCycleDays(html) {
  const $ = cheerio.load(html);
  const events = [];

  $(".fsCalendarDaybox").each((_, daybox) => {
    const dateElement = $(daybox).find(".fsCalendarDate").first();
    const year = Number(dateElement.attr("data-year"));
    const month = Number(dateElement.attr("data-month"));
    const day = Number(dateElement.attr("data-day"));
    if (!year || !Number.isInteger(month) || !day) return;

    $(daybox).find(".fsCalendarEventTitle").each((__, event) => {
      const summary = $(event).attr("title")?.trim();
      if (!/^Day [1-6]$/.test(summary || "")) return;
      events.push({
        date: `${year}${String(month + 1).padStart(2, "0")}${String(day).padStart(2, "0")}`,
        summary,
      });
    });
  });

  return events;
}

export function buildCalendar(events) {
  const uniqueEvents = [...new Map(events.map((event) => [event.date, event])).values()]
    .sort((left, right) => left.date.localeCompare(right.date));
  if (!uniqueEvents.length) throw new Error("The Osborn calendar did not contain any cycle days");

  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Lunchfeed//Osborn Day Schedule//EN",
    "CALSCALE:GREGORIAN",
    "X-WR-CALNAME:Osborn Day Schedule",
    ...uniqueEvents.flatMap(({ date, summary }) => [
      "BEGIN:VEVENT",
      `DTSTART;VALUE=DATE:${date}`,
      `SUMMARY:${summary}`,
      "END:VEVENT",
    ]),
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}

async function fetchSchoolYear(now = new Date()) {
  const currentMonth = now.getUTCMonth();
  const startYear = currentMonth >= 7 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  const months = Array.from({ length: 10 }, (_, offset) => {
    const month = 8 + offset;
    return { year: startYear + Math.floor(month / 12), month: month % 12 };
  });

  const events = [];
  for (const { year, month } of months) {
    const calendarUrl = new URL(CALENDAR_URL);
    calendarUrl.searchParams.set("cal_date", `${year}-${String(month + 1).padStart(2, "0")}-01`);
    const response = await fetch(calendarUrl, {
      headers: { "user-agent": "lunchfeed/1.0 (+school day-cycle calendar)" },
    });
    if (!response.ok) throw new Error(`GET ${calendarUrl} failed: ${response.status}`);
    events.push(...parseCycleDays(await response.text()));
  }
  return events;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const events = await fetchSchoolYear();
  const calendar = buildCalendar(events);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, calendar, "utf8");
  console.log(`Wrote ${outputPath} (${new Set(events.map(({ date }) => date)).size} cycle days)`);
}
