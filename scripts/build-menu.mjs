#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import {
  DEFAULT_SCHOOL,
  FOOD_SERVICE_URL,
  MenuNotPublishedError,
  findElementaryMenuAsset,
  isFreeOpenRouterModel,
  menuToIcs,
  ocrMenuImages,
  resolveMonth,
  structureMenu,
  validateMenu,
} from "../src/lunchfeed.mjs";

function parseArgs(argv) {
  const options = {
    month: "current",
    outputDirectory: "docs",
    sourceUrl: FOOD_SERVICE_URL,
    discoverOnly: false,
    ifMissing: false,
    allowUnpublished: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--month") options.month = argv[++index];
    else if (argument === "--out-dir") options.outputDirectory = argv[++index];
    else if (argument === "--source-url") options.sourceUrl = argv[++index];
    else if (argument === "--discover-only") options.discoverOnly = true;
    else if (argument === "--if-missing") options.ifMissing = true;
    else if (argument === "--allow-unpublished") options.allowUnpublished = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

async function fetchOk(url) {
  const response = await fetch(url, {
    headers: { "user-agent": "lunchfeed/1.0 (+monthly school menu calendar)" },
  });
  if (!response.ok) throw new Error(`GET ${url} failed: ${response.status}`);
  return response;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const month = resolveMonth(options.month);
  const historicalJson = join(options.outputDirectory, `rye-lunch-${month}.json`);
  if (options.ifMissing && existsSync(historicalJson)) {
    console.log(`${historicalJson} already exists; nothing to do.`);
    return;
  }

  const html = await (await fetchOk(options.sourceUrl)).text();
  let asset;
  try {
    asset = findElementaryMenuAsset(html, options.sourceUrl, month);
  } catch (error) {
    if (options.allowUnpublished && error instanceof MenuNotPublishedError) {
      console.log(error.message);
      return;
    }
    throw error;
  }
  console.log(`${month}: ${asset.url}`);
  if (options.discoverOnly) return;

  const assetResponse = await fetchOk(asset.url);
  const assetBuffer = Buffer.from(await assetResponse.arrayBuffer());
  const extension = extname(new URL(asset.url).pathname).toLowerCase();
  const mimeTypes = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
  };
  const mimeType = mimeTypes[extension];
  if (!mimeType) throw new Error(`Unsupported menu image type: ${extension || "unknown"}`);
  const extraction = "image-ocr";
  const text = await ocrMenuImages([{ buffer: assetBuffer, mimeType }], { month });

  if (!process.env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is required");
  const requestedModel = process.env.OPENROUTER_MODEL || "minimax/minimax-m3:free";
  if (!isFreeOpenRouterModel(requestedModel)) {
    throw new Error(
      `Refusing potentially paid OpenRouter model: ${requestedModel}. Use openrouter/free or a :free model.`,
    );
  }
  const generatedAt = new Date();
  const school = process.env.SCHOOL_NAME || DEFAULT_SCHOOL;
  const result = await structureMenu({
    apiKey: process.env.OPENROUTER_API_KEY,
    model: requestedModel,
    month,
    school,
    text,
  });
  const menu = validateMenu(result.data, month, school, text);
  const data = {
    month,
    school,
    source: {
      page_url: options.sourceUrl,
      asset_url: asset.url,
      asset_type: asset.kind,
      extraction,
      requested_model: requestedModel,
      model: result.model,
      generated_at: generatedAt.toISOString(),
    },
    days: menu.days,
  };
  const json = `${JSON.stringify(data, null, 2)}\n`;
  const ics = menuToIcs(data, generatedAt);

  mkdirSync(options.outputDirectory, { recursive: true });
  for (const [name, contents] of [
    [`rye-lunch-${month}.json`, json],
    [`rye-lunch-${month}.ics`, ics],
    ["rye-lunch-latest.json", json],
    ["rye-lunch-latest.ics", ics],
  ]) {
    const path = join(options.outputDirectory, name);
    writeFileSync(path, contents, "utf8");
    console.log(`Wrote ${path}`);
  }
}

try {
  await main();
} catch (error) {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
}
