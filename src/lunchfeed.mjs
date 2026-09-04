import { basename, extname } from "node:path";
import * as cheerio from "cheerio";
import { createWorker, PSM } from "tesseract.js";

export const FOOD_SERVICE_URL =
  "https://www.ryeschools.org/departments/food-service";
export const DEFAULT_SCHOOL = "Osborn";

export function isFreeOpenRouterModel(model) {
  return model === "openrouter/free" || model.endsWith(":free");
}

const MONTH_NAMES = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

export class MenuNotPublishedError extends Error {
  constructor(month, candidates = []) {
    const labels = [...new Set(candidates.map((candidate) => candidate.label))];
    const details = labels.length
      ? ` Found: ${labels.join(", ")}.`
      : "";
    super(`The elementary menu for ${month} is not published yet.${details}`);
    this.name = "MenuNotPublishedError";
  }
}

export function resolveMonth(value = "current", now = new Date()) {
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return value;
  if (value !== "current" && value !== "next") {
    throw new Error("--month must be current, next, or YYYY-MM");
  }

  const year = now.getUTCFullYear();
  const monthIndex = now.getUTCMonth() + (value === "next" ? 1 : 0);
  const date = new Date(Date.UTC(year, monthIndex, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function decodeImageSizes(raw) {
  if (!raw) return [];
  let decoded = raw.replaceAll("&quot;", '"').replaceAll("&#34;", '"');
  // Finalsite currently percent-encodes the JSON quotes inside this attribute.
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // Keep the original value and let JSON.parse report an empty candidate list.
  }
  try {
    const values = JSON.parse(decoded);
    return values
      .filter((value) => value?.url)
      .sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
  } catch {
    return [];
  }
}

function assetKind(url) {
  const extension = extname(new URL(url).pathname).toLowerCase();
  if ([".jpg", ".jpeg", ".png", ".webp"].includes(extension)) return "image";
  return null;
}

function monthMatches(label, month) {
  const [year, monthNumber] = month.split("-");
  const name = MONTH_NAMES[Number(monthNumber) - 1];
  const shortName = name.slice(0, 3);
  const normalized = label.toLowerCase().replace(/[^a-z0-9]/g, "");
  const hasMonth = normalized.includes(name) || normalized.includes(shortName);
  return hasMonth && normalized.includes(year);
}

export function findElementaryMenuAsset(html, pageUrl, month) {
  const $ = cheerio.load(html);
  const panels = $("section.fsPanel").filter((_, element) => {
    const heading = $(element).children("header").first().text();
    return /elementary\s+school\s+lunch\s+menu/i.test(heading);
  });

  if (panels.length === 0) {
    throw new Error("Could not find the Elementary School Lunch Menu panel");
  }

  const candidates = [];
  panels.first().find("a[href], img").each((_, element) => {
    const node = $(element);
    const labels = [
      node.attr("data-resource-title"),
      node.attr("data-resource-filename"),
      node.attr("alt"),
    ].filter(Boolean);
    const urls = [];

    if (node.is("a") && node.attr("href")) urls.push(node.attr("href"));
    if (node.is("img")) {
      urls.push(...decodeImageSizes(node.attr("data-image-sizes")).map((item) => item.url));
      if (node.attr("src")) urls.push(node.attr("src"));
    }

    for (const rawUrl of urls) {
      let url;
      try {
        url = new URL(rawUrl, pageUrl).href;
      } catch {
        continue;
      }
      const kind = assetKind(url);
      if (!kind) continue;
      const label = labels[0] || basename(new URL(url).pathname);
      candidates.push({ url, kind, label });
    }
  });

  const unique = [...new Map(candidates.map((candidate) => [candidate.url, candidate])).values()];
  const match = unique.find((candidate) =>
    monthMatches(`${candidate.label} ${candidate.url}`, month),
  );
  if (!match) throw new MenuNotPublishedError(month, unique);
  return match;
}

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function weekdayDateGuide(month) {
  const [year, monthNumber] = month.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const dates = new Map([1, 2, 3, 4, 5].map((weekday) => [weekday, []]));
  for (let day = 1; day <= lastDay; day += 1) {
    const weekday = new Date(Date.UTC(year, monthNumber - 1, day)).getUTCDay();
    if (dates.has(weekday)) dates.get(weekday).push(day);
  }
  return [...dates]
    .map(([weekday, days]) => `${WEEKDAY_NAMES[weekday]} dates: ${days.join(", ")}`)
    .join("\n");
}

export async function ocrMenuImages(
  images,
  { createWorkerImpl = createWorker, month } = {},
) {
  const worker = await createWorkerImpl("eng");
  const pages = [];
  try {
    for (let pageIndex = 0; pageIndex < images.length; pageIndex += 1) {
      const image = images[pageIndex].buffer;
      const { data: fullPage } = await worker.recognize(
        image,
        {},
        { blocks: true, tsv: true },
      );
      const bounds = fullPage.blocks?.[0]?.bbox;
      if (!bounds?.x1 || !bounds?.y1) {
        pages.push(`PAGE ${pageIndex + 1}\n${fullPage.text}`);
        continue;
      }

      // The district's Aramark calendar reserves the left 16.5% for global
      // boilerplate and lays out five weekday columns across the remaining area.
      const width = bounds.x1;
      const height = bounds.y1;
      const left = Math.round(width * 0.165);
      const gridWidth = width - left;
      const columnWidth = Math.floor(gridWidth / 5);
      const words = fullPage.tsv
        .split("\n")
        .slice(1)
        .map((line) => line.split("\t"))
        .filter((fields) => fields.length >= 12 && fields[0] === "5")
        .map((fields) => ({
          left: Number(fields[6]),
          top: Number(fields[7]),
          width: Number(fields[8]),
          height: Number(fields[9]),
          confidence: Number(fields[10]),
          text: fields.slice(11).join("\t").trim(),
        }));

      const dateCandidates = words
        .map((word) => {
          const column = Math.floor((word.left - left) / columnWidth);
          const relativeX = word.left - (left + column * columnWidth);
          return { ...word, column, relativeX, day: Number(word.text) };
        })
        .filter(
          (word) =>
            word.column >= 0 &&
            word.column < 5 &&
            word.relativeX > columnWidth * 0.78 &&
            word.top > height * 0.14 &&
            word.top < height * 0.72 &&
            word.width < columnWidth * 0.16 &&
            word.height < height * 0.03 &&
            word.confidence > 20 &&
            /^\d{1,2}$/.test(word.text) &&
            word.day >= 1 &&
            word.day <= 31,
        );

      const [year, monthNumber] = month
        ? month.split("-").map(Number)
        : monthFromOcrContext(fullPage.text);
      const calendarCandidates = dateCandidates.filter((candidate) =>
        new Date(Date.UTC(year, monthNumber - 1, candidate.day)).getUTCDay() ===
          candidate.column + 1,
      );
      if (calendarCandidates.length < 2) {
        throw new Error("Local OCR could not anchor weekly rows to calendar dates");
      }

      const baseDay = Math.min(
        ...calendarCandidates.map((candidate) => candidate.day - candidate.column),
      );
      const anchorsByRow = new Map();
      for (const candidate of calendarCandidates) {
        const row = (candidate.day - candidate.column - baseDay) / 7;
        if (!Number.isInteger(row) || row < 0) continue;
        const values = anchorsByRow.get(row) ?? [];
        values.push(candidate.top);
        anchorsByRow.set(row, values);
      }
      const knownAnchors = [...anchorsByRow]
        .map(([row, values]) => ({
          row,
          top: values.reduce((sum, value) => sum + value, 0) / values.length,
        }))
        .sort((a, b) => a.row - b.row);
      const slopes = [];
      for (let index = 1; index < knownAnchors.length; index += 1) {
        slopes.push(
          (knownAnchors[index].top - knownAnchors[index - 1].top) /
            (knownAnchors[index].row - knownAnchors[index - 1].row),
        );
      }
      if (!slopes.length) throw new Error("Local OCR could not determine calendar row spacing");
      const spacing = Math.round(slopes.reduce((sum, value) => sum + value, 0) / slopes.length);
      const origin = Math.round(
        knownAnchors.reduce((sum, anchor) => sum + anchor.top - anchor.row * spacing, 0) /
          knownAnchors.length,
      );
      const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
      const rowCount = Math.floor((lastDay - baseDay) / 7) + 1;
      const rowAnchors = Array.from({ length: rowCount }, (_, row) => origin + row * spacing);
      if (process.env.DEBUG_OCR) {
        console.error("OCR calendar geometry", {
          width,
          height,
          left,
          rowAnchors,
          dateCandidates: dateCandidates.map(({ top, column, day, text }) => ({ top, column, day, text })),
          baseDay,
          spacing,
        });
      }
      const rowTopOffset = Math.round(spacing * 0.08);
      await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK });

      const cells = [];
      for (let row = 0; row < rowAnchors.length; row += 1) {
        // Date numbers sit at the top of each calendar row. Cut just above an
        // anchor and just above the next anchor so lower lines stay with their
        // own date instead of leaking into the following week.
        const top = Math.max(0, rowAnchors[row] - rowTopOffset);
        const bottom = row === rowAnchors.length - 1
          ? Math.min(height, rowAnchors[row] + spacing - rowTopOffset)
          : rowAnchors[row + 1] - rowTopOffset;
        for (let column = 0; column < 5; column += 1) {
          const date = new Date(Date.UTC(year, monthNumber - 1, baseDay + row * 7 + column));
          if (date.getUTCFullYear() !== year || date.getUTCMonth() !== monthNumber - 1) continue;
          const rectangle = {
            left: left + column * columnWidth,
            top,
            width: column === 4 ? width - (left + column * columnWidth) : columnWidth,
            height: bottom - top,
          };
          await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK });
          const { data } = await worker.recognize(image, { rectangle });
          const isoDate = date.toISOString().slice(0, 10);
          let footer = "";
          if (column === 4) {
            // Piazza rotation is printed in a tiny line at the very bottom of
            // each Friday cell. A dedicated single-line pass reads it far more
            // reliably than the general cell OCR.
            await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE });
            const footerTopOffset = Math.round(spacing * 0.13);
            const footerHeight = Math.round(spacing * 0.19);
            const footerResult = await worker.recognize(image, {
              rectangle: {
                left: rectangle.left,
                top: bottom - footerTopOffset,
                width: rectangle.width,
                height: footerHeight,
              },
            });
            footer = `\nPIZZA FOOTER: ${footerResult.data.text.trim()}`;
          }
          cells.push(
            `CELL ${isoDate} (${WEEKDAY_NAMES[column + 1]})\n${data.text.trim()}${footer}`,
          );
        }
      }
      pages.push(`PAGE ${pageIndex + 1}\n${cells.join("\n\n")}`);
    }
  } finally {
    await worker.terminate();
  }
  return pages.join("\n\n");
}

function monthFromOcrContext(text) {
  const monthIndex = MONTH_NAMES.findIndex((name) => new RegExp(name, "i").test(text));
  const year = Number(text.match(/\b20\d{2}\b/)?.[0]);
  if (monthIndex < 0 || !year) throw new Error("Local OCR could not read the menu month and year");
  return [year, monthIndex + 1];
}

export const MENU_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["month", "days"],
  properties: {
    month: { type: "string", pattern: "^\\d{4}-(0[1-9]|1[0-2])$" },
    days: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["date", "title", "sides", "alt", "notes"],
        properties: {
          date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          title: { type: "string" },
          sides: { type: "array", items: { type: "string" } },
          alt: { type: "string" },
          notes: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

function menuPrompt(month, school) {
  return `Extract the Rye elementary school LUNCH menu for ${month}.

Return one entry per school day that has a main lunch. Omit weekends, blank days, and days marked no school. For each date:
- title: the complete main entree, including its important sauce, bread, filling, or pizza type; do not use a generic heading when the specific food is shown
- sides: only sides tied to that day's entree
- alt: a day-specific alternate, or an empty string
- notes: only dietary accommodations tied to that date, not promotions, farm labels, school reminders, or parent invitations

Always omit "100% Fruit Juice" and "Hormone Free Milk" even when they appear inside every date cell. Ignore breakfast, prices, payment instructions, USDA text, nutrition slogans, repeating global alternatives, local-farm labels, and kindergarten parent reminders. Treat "Mini Bagel Butter/Cream Cheese" as an alternate rather than a note or side. Use ISO dates in ${month}. Do not invent unclear text.

Pizza Friday rule for ${school}: read the small "Piazza Pizza at [school]" line in each Friday cell. If it says "Piazza Pizza at ${school}", set title to exactly "Piazza Pizza Day". For every other pizza Friday, set title to exactly "Cafeteria Pizza Day". Do not include "Cheese or Pepperoni" in the title, sides, alt, or notes. Do not copy the Piazza school line into notes.

The OCR is grouped into Monday-Friday columns. Never shift food into an adjacent date when a school-closure cell is blank or graphical. A fuzzy digit must be resolved using this authoritative calendar:
${weekdayDateGuide(month)}

Return JSON only in exactly this shape:
{"month":"${month}","days":[{"date":"${month}-DD","title":"...","sides":["..."],"alt":"","notes":["..."]}]}
Every day object must contain all five fields. Use an empty string or empty array when a field has no value.`;
}

function parseStructuredContent(content) {
  if (typeof content !== "string") {
    if (Array.isArray(content)) {
      content = content.map((part) => part?.text ?? "").join("");
    } else {
      throw new Error("OpenRouter returned no structured menu data");
    }
  }
  try {
    return JSON.parse(content);
  } catch (error) {
    const fenced = content.match(/^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i);
    if (fenced) return JSON.parse(fenced[1]);
    throw new Error(`OpenRouter returned invalid JSON: ${error.message}`);
  }
}

export async function structureMenu({
  apiKey,
  model,
  month,
  school = DEFAULT_SCHOOL,
  text,
  fetchImpl = fetch,
  baseUrl = "https://openrouter.ai/api/v1",
  requestTimeoutMs = 60_000,
  maxAttempts = 3,
}) {
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is required");
  const content = [{ type: "text", text: menuPrompt(month, school) }];
  if (text) {
    content.push({ type: "text", text: `\nExtracted menu OCR text:\n${text}` });
  }

  const body = JSON.stringify({
    model,
    messages: [
      {
        role: "system",
        content:
          "You convert school lunch calendars into exact structured data. Follow the schema and extract only supported facts.",
      },
      { role: "user", content },
    ],
      response_format: { type: "json_object" },
    provider: {
      require_parameters: true,
    },
  });

  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          "x-title": "Lunchfeed",
        },
        body,
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      if (!response.ok) {
        const details = (await response.text()).trim();
        const error = new Error(
          `OpenRouter request failed (${response.status})${details ? `: ${details}` : ""}`,
        );
        error.retryable = response.status >= 500 || [408, 409, 429].includes(response.status);
        throw error;
      }
      const completion = await response.json();
      const message = completion.choices?.[0]?.message;
      if (!message?.content) {
        throw new Error(message?.refusal || "OpenRouter returned no structured menu data");
      }
      const data = parseStructuredContent(message.content);
      validateMenu(data, month, school, text);
      return {
        data,
        model: completion.model || model,
      };
    } catch (error) {
      lastError = error;
      if (error.retryable === false || attempt === maxAttempts) break;
    }
  }
  throw new Error(`OpenRouter failed after ${maxAttempts} attempts: ${lastError.message}`);
}

function piazzaDatesForSchool(sourceText, school) {
  const dates = new Set();
  const schoolPattern = school.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const piazzaPattern = new RegExp(`\\bpiazza?\\s+pizza\\s+at\\s+${schoolPattern}\\b`, "i");
  let currentDate = null;
  for (const line of String(sourceText).split("\n")) {
    const cell = line.match(/^CELL (\d{4}-\d{2}-\d{2})\b/);
    if (cell) currentDate = cell[1];
    else if (currentDate && piazzaPattern.test(line)) dates.add(currentDate);
  }
  return dates;
}

export function validateMenu(data, month, school = DEFAULT_SCHOOL, sourceText = "") {
  if (data?.month !== month || !Array.isArray(data.days)) {
    throw new Error(`Model output does not describe ${month}`);
  }
  const piazzaDates = piazzaDatesForSchool(sourceText, school);
  const sorted = {};
  for (const entry of [...data.days].sort((a, b) => a.date.localeCompare(b.date))) {
    const { date } = entry;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !date.startsWith(`${month}-`)) {
      throw new Error(`Invalid menu date: ${date}`);
    }
    const parsed = new Date(`${date}T12:00:00Z`);
    if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== date) {
      throw new Error(`Invalid calendar date: ${date}`);
    }
    if ([0, 6].includes(parsed.getUTCDay())) throw new Error(`Weekend menu date: ${date}`);
    const hasDetails = [entry?.alt, ...(entry?.sides ?? []), ...(entry?.notes ?? [])]
      .some((value) => typeof value === "string" && value.trim());
    // Free models sometimes preserve an explicitly labeled closure as an empty
    // object. Treat a completely empty day as omitted, but reject partial meals.
    if (!entry?.title?.trim() && !hasDetails) continue;
    if (!entry?.title?.trim()) throw new Error(`Missing lunch title for ${date}`);
    if (sorted[date]) throw new Error(`Duplicate menu date: ${date}`);
    let title = entry.title.trim();
    let sides = (entry.sides ?? []).map((value) => value.trim()).filter(Boolean);
    let alt = (entry.alt ?? "").trim();
    let notes = (entry.notes ?? []).map((value) => value.trim()).filter(Boolean);

    const pizzaContext = [title, ...sides, alt, ...notes].join(" ");
    if (parsed.getUTCDay() === 5 && /\bpizza\b/i.test(pizzaContext)) {
      const schoolPattern = school.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const isPiazzaDay =
        piazzaDates.has(date) ||
        /^piazza pizza day$/i.test(title) ||
        new RegExp(`\\bpiazza pizza at\\s+${schoolPattern}\\b`, "i").test(pizzaContext);
      title = isPiazzaDay ? "Piazza Pizza Day" : "Cafeteria Pizza Day";
      const isPizzaChoice = (value) =>
        /^(?:cheese\s*(?:or|\/|&)\s*pepperoni|pepperoni\s*(?:or|\/|&)\s*cheese)(?:\s+pizza)?$/i.test(value);
      sides = sides.filter((value) => !isPizzaChoice(value));
      notes = notes.filter((value) => !isPizzaChoice(value));
      if (isPizzaChoice(alt)) alt = "";
    }

    const isDailyBoilerplate = (value) =>
      /^(?:100%\s*)?fruit juice$/i.test(value) || /^hormone free milk$/i.test(value);
    sides = sides.filter((value) => !isDailyBoilerplate(value));
    notes = notes.filter(
      (value) =>
        !isDailyBoilerplate(value) &&
        !/^piazza? pizza at\b/i.test(value) &&
        !/\blocal (?:jersey|ny) farm\b/i.test(value) &&
        !/\bkindergarten\b|\bbring a parent\b/i.test(value),
    );

    const miniBagel = [...sides, ...notes].find((value) =>
      /^mini bagel (?:with )?butter\/?cream ?cheese$/i.test(value),
    );
    if (!alt && miniBagel) alt = miniBagel;
    if (miniBagel) {
      sides = sides.filter((value) => value !== miniBagel);
      notes = notes.filter((value) => value !== miniBagel);
    }

    sorted[date] = { title, sides, alt, notes };
  }
  if (Object.keys(sorted).length === 0) throw new Error("Model returned no lunch days");
  return { month, days: sorted };
}

function escapeIcs(value) {
  return String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll(";", "\\;")
    .replaceAll(",", "\\,");
}

function foldIcsLine(line) {
  const chunks = [];
  let current = "";
  let bytes = 0;
  const limit = 73;
  for (const character of line) {
    const size = Buffer.byteLength(character);
    if (bytes + size > limit && current) {
      chunks.push(current);
      current = character;
      bytes = size;
    } else {
      current += character;
      bytes += size;
    }
  }
  chunks.push(current);
  return chunks.join("\r\n ");
}

function nextDate(date) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

export function menuToIcs(data, generatedAt = new Date()) {
  const stamp = generatedAt.toISOString().replaceAll(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Lunchfeed//Rye Elementary Lunch//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Rye Elementary Lunch",
  ];

  for (const [date, entry] of Object.entries(data.days)) {
    const description = [];
    if (entry.sides.length) description.push(`Sides: ${entry.sides.join(", ")}`);
    if (entry.alt) description.push(`Alternate: ${entry.alt}`);
    description.push(...entry.notes);
    lines.push(
      "BEGIN:VEVENT",
      `UID:${date}@lunchfeed.ryeschools`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${date.replaceAll("-", "")}`,
      `DTEND;VALUE=DATE:${nextDate(date).replaceAll("-", "")}`,
      `SUMMARY:${escapeIcs(`Lunch: ${entry.title}`)}`,
    );
    if (description.length) lines.push(`DESCRIPTION:${escapeIcs(description.join("\n"))}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR", "");
  return lines.map(foldIcsLine).join("\r\n");
}
