#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_SCHOOL,
  FOOD_SERVICE_URL,
  MenuNotPublishedError,
  findElementaryMenuAsset,
  isFreeOpenRouterModel,
  mergeMenus,
  menuToIcs,
  ocrMenuImages,
  requireImageMimeType,
  resolveMonth,
  structureMenuWithFallback,
  validateMenu,
} from "../src/lunchfeed.mjs";

function writeRollingArtifacts(outputDirectory, now = new Date()) {
  const monthNames = [resolveMonth("current", now), resolveMonth("next", now)];
  const menus = monthNames
    .map((month) => join(outputDirectory, `rye-lunch-${month}.json`))
    .filter((path) => existsSync(path))
    .map((path) => JSON.parse(readFileSync(path, "utf8")));
  if (menus.length === 0) {
    console.log("No current or upcoming monthly artifacts to publish.");
    return;
  }

  const rolling = mergeMenus(menus);
  const generatedAt = rolling.generated_at ? new Date(rolling.generated_at) : now;
  for (const [name, contents] of [
    ["rye-lunch-latest.json", `${JSON.stringify(rolling, null, 2)}\n`],
    ["rye-lunch-latest.ics", menuToIcs(rolling, generatedAt)],
  ]) {
    const path = join(outputDirectory, name);
    writeFileSync(path, contents, "utf8");
    console.log(`Wrote ${path}`);
  }
}

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

async function fetchOk(url, headers = {}) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "lunchfeed/1.0 (+monthly school menu calendar)",
      ...headers,
    },
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
    writeRollingArtifacts(options.outputDirectory);
    return;
  }

  const html = await (await fetchOk(options.sourceUrl)).text();
  let asset;
  try {
    asset = findElementaryMenuAsset(html, options.sourceUrl, month);
  } catch (error) {
    if (options.allowUnpublished && error instanceof MenuNotPublishedError) {
      console.log(error.message);
      writeRollingArtifacts(options.outputDirectory);
      return;
    }
    throw error;
  }
  console.log(`${month}: ${asset.url}`);
  if (options.discoverOnly) return;

  const assetResponse = await fetchOk(asset.url, {
    accept: "image/webp,image/png,image/jpeg,image/*;q=0.8",
  });
  const mimeType = requireImageMimeType(assetResponse);
  const assetBuffer = Buffer.from(await assetResponse.arrayBuffer());
  const extraction = "image-ocr";
  const text = await ocrMenuImages([{ buffer: assetBuffer, mimeType }], { month });

  if (!process.env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is required");
  const requestedModels = (process.env.OPENROUTER_MODELS || process.env.OPENROUTER_MODEL ||
    "google/gemma-4-26b-a4b-it:free,dots-studio/dots-3-note-preview:free,qwen/qwen3.8-27b:free")
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);
  for (const model of requestedModels) {
    if (!isFreeOpenRouterModel(model)) {
      throw new Error(
        `Refusing potentially paid OpenRouter model: ${model}. Use openrouter/free or a :free model.`,
      );
    }
  }
  const generatedAt = new Date();
  const school = process.env.SCHOOL_NAME || DEFAULT_SCHOOL;
  const result = await structureMenuWithFallback({
    apiKey: process.env.OPENROUTER_API_KEY,
    models: requestedModels,
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
      asset_mime_type: mimeType,
      extraction,
      requested_model: result.requestedModel,
      model: result.model,
      generated_at: generatedAt.toISOString(),
    },
    days: menu.days,
  };
  mkdirSync(options.outputDirectory, { recursive: true });
  for (const [name, contents] of [
    [`rye-lunch-${month}.json`, `${JSON.stringify(data, null, 2)}\n`],
    [`rye-lunch-${month}.ics`, menuToIcs(data, generatedAt)],
  ]) {
    const path = join(options.outputDirectory, name);
    writeFileSync(path, contents, "utf8");
    console.log(`Wrote ${path}`);
  }
  writeRollingArtifacts(options.outputDirectory);
}

try {
  await main();
} catch (error) {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
}
