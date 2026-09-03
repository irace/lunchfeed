# Lunchfeed

Lunchfeed fetches the public Rye City School District elementary lunch menu,
uses a pinned free OpenRouter vision model once to turn the calendar into
structured data, and publishes static JSON and iCalendar files for Home Assistant.

The district currently publishes either an image or a PDF. Lunchfeed handles
both: it extracts PDF text when available and otherwise runs local Tesseract OCR
on separately labeled weekday columns. Only the resulting text goes to the free
model, which prevents blank calendar cells from shifting neighboring dates.

## Local setup

Requirements:

- Node.js 20 or newer
- An `OPENROUTER_API_KEY`
- Poppler (`pdftotext` and `pdftoppm`) when the district publishes a PDF

```sh
npm install
cp .env.example .env
# Add your OpenRouter key to .env. Never commit this file.
npm run discover -- --month current
npm run build -- --month current
```

The default model is `minimax/minimax-m3:free`, a pinned free vision endpoint.
Set `OPENROUTER_MODEL` to use another model ending in `:free`. Lunchfeed refuses
any model identifier that could incur inference charges. Generated files land
in `docs/`:

- `rye-lunch-YYYY-MM.json` and `.ics` for history
- `rye-lunch-latest.json` and `.ics` for stable consumers

Useful options:

```sh
npm run build -- --month 2026-09
npm run build -- --month next --if-missing --allow-unpublished
npm run build -- --out-dir /tmp/lunchfeed-output
```

`--allow-unpublished` makes an early scheduled check succeed without output;
`--if-missing` prevents repeat model calls after a month's artifact exists.

## GitHub Actions and Pages

1. Create a public GitHub repository from this directory so Actions and Pages
   stay within GitHub's free public-repository offering.
2. Create an OpenRouter API key and add it as the `OPENROUTER_API_KEY` Actions
   repository secret. No paid fallback is configured.
3. In **Settings > Pages**, choose **GitHub Actions** as the source.
4. Run **Build lunch calendar** manually once, or wait for its late-month check.

The workflow checks for next month's menu each day from the 20th through the
31st. It calls the free router only after the correctly dated asset appears,
commits the generated artifacts, and deploys `docs/` to Pages. A transient free
model failure causes the run to fail and the next scheduled check retries it;
each run makes at most three one-minute attempts and there is no paid fallback.
A manual run rebuilds the selected month even when an artifact already exists.

## Home Assistant

Add the published URL ending in `rye-lunch-latest.ics` to Home Assistant's
iCalendar/ICS calendar integration. If its entity is `calendar.rye_lunch`, a
morning automation can fetch today's event like this:

```yaml
- action: calendar.get_events
  target:
    entity_id: calendar.rye_lunch
  data:
    start_date_time: "{{ today_at() }}"
    duration:
      days: 1
  response_variable: lunch_agenda

- variables:
    lunch_events: >-
      {{ lunch_agenda.get('calendar.rye_lunch', {}).get('events', []) }}
    lunch_event: "{{ lunch_events[0] if lunch_events else {} }}"
    lunch_title: >-
      {{ lunch_event.get('summary', '') | replace('Lunch: ', '') }}
    lunch_line: "{{ lunch_title if lunch_title else 'Not available' }}"
```

Use `lunch_line` in the existing announcement prompt.
