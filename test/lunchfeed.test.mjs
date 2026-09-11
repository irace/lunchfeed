import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import {
  MenuNotPublishedError,
  findElementaryMenuAsset,
  isFreeOpenRouterModel,
  menuToIcs,
  requireImageMimeType,
  resolveMonth,
  structureMenu,
  validateMenu,
  weekdayDateGuide,
} from "../src/lunchfeed.mjs";

const page = `
<section class="fsElement fsPanel">
  <header><h2>Elementary School Lunch Menu</h2></header>
  <img data-resource-title="ElementarySeptemberMenu2026.jpg"
       data-image-sizes='[{%22url%22:%22https://cdn.example/small.jpg%22,%22width%22:256},{%22url%22:%22https://cdn.example/ElementarySeptemberMenu2026.jpg%22,%22width%22:1056}]'>
</section>
<section class="fsElement fsPanel">
  <header><h2>High School Lunch Menu</h2></header>
  <img src="https://cdn.example/SeptemberHighSchool2026.jpg" alt="High school menu">
</section>`;

const finalsiteDocumentPreview = `
<section class="fsElement fsPanel">
  <header><h2>Elementary School Lunch Menu</h2></header>
  <article class="fsResourceTypePdf">
    <a data-resource-title="UpdatedSeptemberElementaryMenu26pptx.pdf"
       href="https://cdn.example/raw/UpdatedSeptemberElementaryMenu26pptx.pdf">
      <img alt="UpdatedSeptemberElementaryMenu26pptx (PDF)"
           data-image-sizes='[{%22url%22:%22https://cdn.example/images/f_auto,q_auto,t_small/UpdatedSeptemberElementaryMenu26pptx.pdf%22,%22width%22:256},{%22url%22:%22https://cdn.example/images/f_auto,q_auto/UpdatedSeptemberElementaryMenu26pptx.pdf%22,%22width%22:792}]'>
    </a>
  </article>
</section>`;

test("resolves named months in UTC", () => {
  const now = new Date("2026-12-20T23:00:00Z");
  assert.equal(resolveMonth("current", now), "2026-12");
  assert.equal(resolveMonth("next", now), "2027-01");
  assert.equal(resolveMonth("2026-09", now), "2026-09");
});

test("discovers the target elementary image and ignores other panels", () => {
  assert.deepEqual(
    findElementaryMenuAsset(page, "https://school.example/food", "2026-09"),
    {
      url: "https://cdn.example/ElementarySeptemberMenu2026.jpg",
      kind: "image",
      label: "ElementarySeptemberMenu2026.jpg",
    },
  );
});

test("discovers Finalsite's rendered image preview for a document resource", () => {
  assert.deepEqual(
    findElementaryMenuAsset(finalsiteDocumentPreview, "https://school.example/food", "2026-09"),
    {
      url: "https://cdn.example/images/f_auto,q_auto/UpdatedSeptemberElementaryMenu26pptx.pdf",
      kind: "image",
      label: "UpdatedSeptemberElementaryMenu26pptx (PDF)",
    },
  );
});

test("accepts rendered image responses and rejects raw documents", () => {
  assert.equal(
    requireImageMimeType(new Response("image", { headers: { "content-type": "image/webp" } })),
    "image/webp",
  );
  assert.throws(
    () => requireImageMimeType(new Response("document", { headers: { "content-type": "application/pdf" } })),
    /unsupported content type: application\/pdf/,
  );
});

test("does not substitute the currently published month", () => {
  assert.throws(
    () => findElementaryMenuAsset(page, "https://school.example/food", "2026-10"),
    MenuNotPublishedError,
  );
});

test("provides authoritative weekday dates for fuzzy OCR", () => {
  assert.equal(
    weekdayDateGuide("2026-09"),
    "Monday dates: 7, 14, 21, 28\nTuesday dates: 1, 8, 15, 22, 29\nWednesday dates: 2, 9, 16, 23, 30\nThursday dates: 3, 10, 17, 24\nFriday dates: 4, 11, 18, 25",
  );
});

test("recognizes only OpenRouter's free model routes", () => {
  assert.equal(isFreeOpenRouterModel("openrouter/free"), true);
  assert.equal(isFreeOpenRouterModel("qwen/example:free"), true);
  assert.equal(isFreeOpenRouterModel("openai/gpt-5-mini"), false);
});

test("uses a free OpenRouter model with JSON output and OCR text", async () => {
  let url;
  let request;
  const fetchImpl = async (value, options) => {
    url = value;
    request = options;
    return new Response(
      JSON.stringify({
        model: "qwen/example:free",
        choices: [{
          message: {
            content: '{"month":"2026-09","days":[{"date":"2026-09-01","title":"Tacos","sides":[],"alt":"","notes":[]}]}',
          },
        }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const result = await structureMenu({
    apiKey: "test-key",
    model: "openrouter/free",
    month: "2026-09",
    text: "CELL 2026-09-01 (Tuesday)\nTacos",
    fetchImpl,
  });
  const body = JSON.parse(request.body);
  assert.equal(result.data.month, "2026-09");
  assert.equal(result.model, "qwen/example:free");
  assert.equal(url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(request.headers.authorization, "Bearer test-key");
  assert.equal(body.model, "openrouter/free");
  assert.equal(body.provider.require_parameters, true);
  assert.equal(body.response_format.type, "json_object");
  assert.equal(body.messages[1].content.at(-1).type, "text");
  assert.match(body.messages[1].content.at(-1).text, /Extracted menu OCR text/);
});

test("retries a transient OpenRouter failure", async () => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    if (attempts === 1) return new Response("busy", { status: 503 });
    return new Response(
      JSON.stringify({
        model: "qwen/example:free",
        choices: [{
          message: {
            content: '{"month":"2026-09","days":[{"date":"2026-09-01","title":"Tacos","sides":[],"alt":"","notes":[]}]}',
          },
        }],
      }),
      { status: 200 },
    );
  };
  await structureMenu({
    apiKey: "test-key",
    model: "openrouter/free",
    month: "2026-09",
    fetchImpl,
    maxAttempts: 2,
  });
  assert.equal(attempts, 2);
});

test("validates, trims, and sorts model output", () => {
  const result = validateMenu(
    {
      month: "2026-09",
      days: [
        { date: "2026-09-02", title: " Pizza ", sides: [" Salad "], alt: "", notes: [] },
        { date: "2026-09-01", title: " Tacos ", sides: [], alt: " PBJ ", notes: [] },
      ],
    },
    "2026-09",
  );
  assert.deepEqual(Object.keys(result.days), ["2026-09-01", "2026-09-02"]);
  assert.equal(result.days["2026-09-01"].title, "Tacos");
});

test("omits completely empty closure days", () => {
  const result = validateMenu(
    {
      month: "2026-09",
      days: [
        { date: "2026-09-07", title: "", sides: [], alt: "", notes: [] },
        { date: "2026-09-08", title: "Chicken Tenders", sides: [], alt: "", notes: [] },
      ],
    },
    "2026-09",
  );
  assert.deepEqual(Object.keys(result.days), ["2026-09-08"]);
});

test("rejects model output that omits a populated OCR cell", () => {
  assert.throws(
    () => validateMenu(
      {
        month: "2026-09",
        days: [
          { date: "2026-09-15", title: "Pasta", sides: [], alt: "", notes: [] },
        ],
      },
      "2026-09",
      "Osborn",
      `CELL 2026-09-14 (Monday)
Grilled Chicken
Quinoa Salad
Roasted Zucchini
Honeydew
CELL 2026-09-15 (Tuesday)
Pasta`,
    ),
    /omitted populated lunch dates: 2026-09-14/,
  );
});

test("classifies pizza Fridays for the selected school and removes the usual choice", () => {
  const result = validateMenu(
    {
      month: "2026-09",
      days: [
        {
          date: "2026-09-11",
          title: "Pizza Day",
          sides: ["Cheese or Pepperoni", "Garden Salad", "100% Fruit Juice", "Hormone Free Milk"],
          alt: "",
          notes: ["Piazza Pizza at Milton", "Local Jersey Farm produce"],
        },
        {
          date: "2026-09-18",
          title: "Pizza Day",
          sides: ["Cheese or Pepperoni", "Caesar Salad"],
          alt: "",
          notes: [],
        },
      ],
    },
    "2026-09",
    "Osborn",
    `CELL 2026-09-11 (Friday)
Piazza Pizza at Milton
CELL 2026-09-18 (Friday)
Piazza Pizza at Osborn`,
  );
  assert.deepEqual(result.days["2026-09-11"], {
    title: "Cafeteria Pizza Day",
    sides: ["Garden Salad"],
    alt: "",
    notes: [],
  });
  assert.deepEqual(result.days["2026-09-18"], {
    title: "Piazza Pizza Day",
    sides: ["Caesar Salad"],
    alt: "",
    notes: [],
  });
});

test("emits valid all-day calendar boundaries and escaped content", () => {
  const ics = menuToIcs(
    {
      month: "2026-09",
      days: {
        "2026-09-01": {
          title: "Tacos, Chicken",
          sides: ["Corn"],
          alt: "PBJ",
          notes: ["Welcome; back"],
        },
      },
    },
    new Date("2026-09-01T12:00:00Z"),
  );
  assert.match(ics, /DTSTART;VALUE=DATE:20260901/);
  assert.match(ics, /DTEND;VALUE=DATE:20260902/);
  assert.match(ics, /SUMMARY:Tacos\\, Chicken/);
  assert.match(ics, /DESCRIPTION:Sides: Corn\\nAlternate: PBJ\\nWelcome\\; back/);
  assert.ok(ics.endsWith("END:VCALENDAR\r\n"));
});

test("landing page overlays the Osborn cycle day from ICS", async () => {
  const html = readFileSync(new URL("../docs/index.html", import.meta.url), "utf8");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, "expected an inline landing-page script");

  const menu = JSON.parse(
    readFileSync(new URL("../docs/rye-lunch-latest.json", import.meta.url), "utf8"),
  );
  const daySchedule = readFileSync(
    new URL("../docs/osborn-day-schedule.ics", import.meta.url),
    "utf8",
  );
  const elements = new Map(
    ["#calendar", "#month", "#last-updated", "#source-link"].map((selector) => [
      selector,
      { href: "", innerHTML: "", textContent: "" },
    ]),
  );
  class FixedDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : ["2026-09-11T12:00:00-04:00"]));
    }
  }

  vm.runInNewContext(script, {
    console,
    Date: FixedDate,
    document: { title: "", querySelector: (selector) => elements.get(selector) },
    fetch: async (url) => ({
      ok: true,
      json: async () => menu,
      text: async () => (url === "osborn-day-schedule.ics" ? daySchedule : ""),
    }),
    Intl,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.match(elements.get("#calendar").innerHTML, /cycle-day">Day 4</);
  assert.match(elements.get("#calendar").innerHTML, /Friday, September 11, Day 4/);
});
