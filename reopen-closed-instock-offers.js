#!/usr/bin/env node

/**
 * Reopen CLOSED InPost offers when the current WooCommerce CSV says the item
 * is back in stock. Default mode is a dry run; use --execute to call /reopen.
 */

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { parse } = require("csv-parse/sync");

const args = process.argv.slice(2);

function hasFlag(flag) {
  return args.includes(flag);
}

function getArgValue(name, fallback = null) {
  const index = args.indexOf(name);

  if (index === -1) {
    return fallback;
  }

  return args[index + 1] || fallback;
}

const CSV_FILE = getArgValue("--csv", "suppla-oferta.csv");
const OUTPUT_DIR = getArgValue("--out", "dist");
const LIMIT = Number(getArgValue("--limit", process.env.INPOST_OFFERS_PAGE_LIMIT || "100"));
const EXECUTE = hasFlag("--execute");
const ALLOW_ACTIVE_DUPLICATES = hasFlag("--allow-active-duplicates");
const REQUEST_DELAY_MS = Number(process.env.INPOST_REQUEST_DELAY_MS || 150);

const REPORT_FILE = path.join(OUTPUT_DIR, "reopen-closed-instock-report.json");
const CANDIDATES_FILE = path.join(OUTPUT_DIR, "reopen-closed-instock-candidates.json");
const SKIPPED_FILE = path.join(OUTPUT_DIR, "reopen-closed-instock-skipped.json");
const ERRORS_FILE = path.join(OUTPUT_DIR, "reopen-closed-instock-errors.json");

const REQUIRED_ENV = [
  "CLIENT_ID",
  "CLIENT_SECRET",
  "INPOST_SCOPE",
  "INPOST_TOKEN_URL",
  "INPOST_BUY_API_BASE",
  "ORGANIZATION_ID"
];

const REOPENABLE_STATUSES = new Set(["CLOSED"]);
const NON_BLOCKING_DUPLICATE_STATUSES = new Set([
  "CLOSED",
  "CLOSE",
  "ENDED",
  "ARCHIVED",
  "DELETED",
  "REMOVED",
  "REJECTED"
]);

let tokenCache = {
  accessToken: null,
  expiresAt: 0
};

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function readFileUtf8(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Nie znaleziono pliku: ${filePath}`);
  }

  return fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
}

function normalizeText(value) {
  return String(value ?? "")
    .replace(/\r/g, "")
    .replace(/\\n/g, "\n")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeDigits(value) {
  return String(value ?? "").replace(/[^\d]/g, "");
}

function normalizeStatus(value) {
  return normalizeText(value).toUpperCase();
}

function parseNumber(value) {
  const raw = normalizeText(value)
    .replace(/\s/g, "")
    .replace(",", ".");

  if (!raw) {
    return null;
  }

  const number = Number(raw);

  return Number.isFinite(number) ? number : null;
}

function parseInteger(value) {
  const number = parseNumber(value);

  if (number === null) {
    return null;
  }

  return Math.max(0, Math.floor(number));
}

function detectDelimiter(csvContent) {
  const firstLine = csvContent.split(/\r?\n/).find((line) => line.trim());

  if (!firstLine) {
    return ",";
  }

  const commaCount = (firstLine.match(/,/g) || []).length;
  const semicolonCount = (firstLine.match(/;/g) || []).length;

  return semicolonCount > commaCount ? ";" : ",";
}

function isLikelyEan(value) {
  const text = normalizeDigits(value);

  return /^[0-9]{8}$|^[0-9]{12}$|^[0-9]{13}$|^[0-9]{14}$/.test(text);
}

function getEan(row) {
  const gtin = normalizeDigits(row["GTIN, UPC, EAN lub ISBN"]);
  const ean = normalizeDigits(row["EAN"]);
  const sku = normalizeDigits(row["SKU"]);

  if (isLikelyEan(gtin)) return gtin;
  if (isLikelyEan(ean)) return ean;
  if (isLikelyEan(sku)) return sku;

  return "";
}

function getSku(row) {
  return normalizeText(row["SKU"] || row["Identyfikator"]);
}

function getStockQuantity(row) {
  const stock = parseInteger(row["Stan magazynowy"]);

  if (stock !== null) {
    return stock;
  }

  const inStock = normalizeText(row["W magazynie?"]).toLowerCase();

  if (["1", "yes", "tak", "true"].includes(inStock)) {
    return 1;
  }

  return 0;
}

function summarizeCsvRecord(record) {
  return {
    rowNumber: record.rowNumber,
    externalId: record.externalId,
    ean: record.ean,
    sku: record.sku,
    name: record.name,
    stock: record.stock
  };
}

function addToIndex(index, key, record) {
  const cleanKey = normalizeText(key);

  if (!cleanKey) {
    return;
  }

  if (!index.has(cleanKey)) {
    index.set(cleanKey, []);
  }

  index.get(cleanKey).push(record);
}

function readCsvStockIndex(csvFile) {
  const csvContent = readFileUtf8(csvFile);
  const delimiter = detectDelimiter(csvContent);
  const rows = parse(csvContent, {
    columns: true,
    skip_empty_lines: true,
    relax_quotes: true,
    relax_column_count: true,
    trim: false,
    delimiter
  });

  const records = rows.map((row, index) => ({
    rowNumber: index + 2,
    externalId: normalizeText(row["Identyfikator"]),
    ean: getEan(row),
    sku: getSku(row),
    name: normalizeText(row["Nazwa"]),
    stock: getStockQuantity(row)
  }));

  const byExternalId = new Map();
  const byEan = new Map();
  const bySku = new Map();

  for (const record of records) {
    addToIndex(byExternalId, record.externalId, record);
    addToIndex(byEan, record.ean, record);
    addToIndex(bySku, record.sku, record);
  }

  return {
    delimiter,
    rows: records,
    byExternalId,
    byEan,
    bySku
  };
}

function validateEnv() {
  for (const key of REQUIRED_ENV) {
    if (!process.env[key]) {
      throw new Error(`Brakuje zmiennej srodowiskowej: ${key}`);
    }
  }
}

function getBaseUrl() {
  return process.env.INPOST_BUY_API_BASE.replace(/\/$/, "");
}

function getOrganizationId() {
  return process.env.ORGANIZATION_ID;
}

function mask(value) {
  if (!value) return "";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getAccessToken() {
  const now = Date.now();

  if (tokenCache.accessToken && now < tokenCache.expiresAt) {
    return tokenCache.accessToken;
  }

  const body = new URLSearchParams();

  body.set("grant_type", "client_credentials");
  body.set("scope", process.env.INPOST_SCOPE);
  body.set("client_id", process.env.CLIENT_ID);
  body.set("client_secret", process.env.CLIENT_SECRET);

  const response = await axios.post(
    process.env.INPOST_TOKEN_URL,
    body.toString(),
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      timeout: 60000
    }
  );

  const { access_token, expires_in } = response.data;

  tokenCache.accessToken = access_token;
  tokenCache.expiresAt = Date.now() + (expires_in - 30) * 1000;

  return access_token;
}

async function inpostRequest(method, apiPath, options = {}) {
  const token = await getAccessToken();

  const response = await axios({
    method,
    url: `${getBaseUrl()}${apiPath}`,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "Accept-Language": "pl"
    },
    params: options.params,
    data: options.data,
    timeout: options.timeout || 120000,
    validateStatus: () => true
  });

  return {
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    data: response.data
  };
}

function getListItems(responseData) {
  const data = responseData?.data || responseData;

  if (Array.isArray(data)) {
    return data;
  }

  if (Array.isArray(data?.data)) {
    return data.data;
  }

  if (Array.isArray(data?.data?.data)) {
    return data.data.data;
  }

  return [];
}

function getTotalFromResponse(responseData) {
  const data = responseData?.data || responseData;

  if (data?.page?.total !== undefined) {
    return Number(data.page.total);
  }

  if (data?.data?.page?.total !== undefined) {
    return Number(data.data.page.total);
  }

  return null;
}

function getOfferObject(item) {
  return item?.offer || item;
}

function normalizeOffer(item) {
  const offer = getOfferObject(item);

  return {
    offerId: normalizeText(offer?.id),
    externalId: normalizeText(offer?.externalId),
    status: normalizeStatus(offer?.status),
    rawStatus: offer?.status || null,
    name: normalizeText(offer?.product?.name),
    ean: normalizeDigits(offer?.product?.ean),
    sku: normalizeText(offer?.product?.sku),
    stock: offer?.stock?.quantity ?? null,
    createdAt: offer?.createdAt || null,
    updatedAt: offer?.updatedAt || null
  };
}

async function fetchAllOffers() {
  const organizationId = getOrganizationId();
  const allItems = [];
  let offset = 0;
  let total = null;

  while (true) {
    const result = await inpostRequest(
      "GET",
      `/v1/organizations/${encodeURIComponent(organizationId)}/offers`,
      {
        params: {
          limit: LIMIT,
          offset
        }
      }
    );

    if (!result.ok) {
      throw new Error(
        `Nie udalo sie pobrac ofert z InPost. Status ${result.status}: ` +
        JSON.stringify(result.data)
      );
    }

    const items = getListItems(result.data);
    allItems.push(...items);
    total = getTotalFromResponse(result.data);

    console.log(
      `Pobrano oferty z InPost: ${allItems.length}${total !== null ? ` / ${total}` : ""}`
    );

    if (!items.length) break;

    offset += LIMIT;

    if (total !== null && allItems.length >= total) break;
    if (total === null && items.length < LIMIT) break;

    await sleep(REQUEST_DELAY_MS);
  }

  return allItems.map(normalizeOffer);
}

function isReopenableStatus(status) {
  return REOPENABLE_STATUSES.has(normalizeStatus(status));
}

function isBlockingDuplicateStatus(status) {
  const normalized = normalizeStatus(status);

  if (!normalized) {
    return true;
  }

  return !NON_BLOCKING_DUPLICATE_STATUSES.has(normalized);
}

function addBlockingIndex(index, key, offer) {
  const cleanKey = normalizeText(key);

  if (!cleanKey) {
    return;
  }

  if (!index.has(cleanKey)) {
    index.set(cleanKey, []);
  }

  index.get(cleanKey).push(offer);
}

function buildBlockingOfferIndexes(offers) {
  const byExternalId = new Map();
  const byEan = new Map();
  const bySku = new Map();

  for (const offer of offers) {
    if (!offer.offerId || !isBlockingDuplicateStatus(offer.status)) {
      continue;
    }

    addBlockingIndex(byExternalId, offer.externalId, offer);
    addBlockingIndex(byEan, offer.ean, offer);
    addBlockingIndex(bySku, offer.sku, offer);
  }

  return {
    byExternalId,
    byEan,
    bySku
  };
}

function summarizeOffer(offer) {
  return {
    offerId: offer.offerId,
    externalId: offer.externalId,
    status: offer.rawStatus || offer.status,
    name: offer.name,
    ean: offer.ean,
    sku: offer.sku,
    stock: offer.stock,
    createdAt: offer.createdAt,
    updatedAt: offer.updatedAt
  };
}

function getBestRecord(records) {
  return [...records].sort((a, b) => {
    if (b.stock !== a.stock) {
      return b.stock - a.stock;
    }

    return a.rowNumber - b.rowNumber;
  })[0];
}

function matchCsvRecord(offer, csvIndex) {
  const groups = [
    {
      method: "externalId",
      key: offer.externalId,
      records: csvIndex.byExternalId.get(offer.externalId) || []
    },
    {
      method: "ean",
      key: offer.ean,
      records: csvIndex.byEan.get(offer.ean) || []
    },
    {
      method: "sku",
      key: offer.sku,
      records: csvIndex.bySku.get(offer.sku) || []
    }
  ];

  for (const group of groups) {
    if (!group.key || !group.records.length) {
      continue;
    }

    return {
      method: group.method,
      key: group.key,
      matchCount: group.records.length,
      selected: getBestRecord(group.records),
      matches: group.records.map(summarizeCsvRecord)
    };
  }

  return null;
}

function findBlockingDuplicates(offer, blockingIndexes) {
  const duplicatesById = new Map();
  const groups = [
    {
      method: "externalId",
      key: offer.externalId,
      records: blockingIndexes.byExternalId.get(offer.externalId) || []
    },
    {
      method: "ean",
      key: offer.ean,
      records: blockingIndexes.byEan.get(offer.ean) || []
    },
    {
      method: "sku",
      key: offer.sku,
      records: blockingIndexes.bySku.get(offer.sku) || []
    }
  ];

  for (const group of groups) {
    if (!group.key) {
      continue;
    }

    for (const duplicate of group.records) {
      if (duplicate.offerId === offer.offerId) {
        continue;
      }

      if (!duplicatesById.has(duplicate.offerId)) {
        duplicatesById.set(duplicate.offerId, {
          ...summarizeOffer(duplicate),
          matchedBy: []
        });
      }

      duplicatesById.get(duplicate.offerId).matchedBy.push({
        method: group.method,
        key: group.key
      });
    }
  }

  return [...duplicatesById.values()];
}

function skippedRecord(offer, reason, extra = {}) {
  return {
    ...summarizeOffer(offer),
    decision: "SKIP",
    reason,
    ...extra
  };
}

function collectCandidates(offers, csvIndex) {
  const blockingIndexes = buildBlockingOfferIndexes(offers);
  const candidates = [];
  const skipped = [];

  for (const offer of offers) {
    if (!offer.offerId) {
      skipped.push(skippedRecord(offer, "missing-offer-id"));
      continue;
    }

    if (!isReopenableStatus(offer.status)) {
      skipped.push(skippedRecord(offer, "status-is-not-closed"));
      continue;
    }

    const csvMatch = matchCsvRecord(offer, csvIndex);

    if (!csvMatch) {
      skipped.push(skippedRecord(offer, "not-found-in-current-csv"));
      continue;
    }

    const csvRecord = csvMatch.selected;

    if (csvRecord.stock <= 0) {
      skipped.push(skippedRecord(offer, "csv-stock-is-not-positive", {
        csvMatch: {
          method: csvMatch.method,
          key: csvMatch.key,
          matchCount: csvMatch.matchCount,
          selected: summarizeCsvRecord(csvRecord),
          matches: csvMatch.matches
        }
      }));
      continue;
    }

    const blockingDuplicates = findBlockingDuplicates(offer, blockingIndexes);

    if (blockingDuplicates.length && !ALLOW_ACTIVE_DUPLICATES) {
      skipped.push(skippedRecord(offer, "active-duplicate-exists", {
        csvMatch: {
          method: csvMatch.method,
          key: csvMatch.key,
          matchCount: csvMatch.matchCount,
          selected: summarizeCsvRecord(csvRecord),
          matches: csvMatch.matches
        },
        blockingDuplicates
      }));
      continue;
    }

    candidates.push({
      ...summarizeOffer(offer),
      decision: EXECUTE ? "REOPEN" : "DRY_RUN_REOPEN",
      csvMatch: {
        method: csvMatch.method,
        key: csvMatch.key,
        matchCount: csvMatch.matchCount,
        selected: summarizeCsvRecord(csvRecord),
        matches: csvMatch.matches
      },
      blockingDuplicates
    });
  }

  return {
    candidates,
    skipped
  };
}

async function reopenOffer(offerId) {
  const organizationId = getOrganizationId();

  return inpostRequest(
    "POST",
    `/v1/organizations/${encodeURIComponent(organizationId)}/offers/${encodeURIComponent(offerId)}/reopen`,
    {
      data: {}
    }
  );
}

function countBy(items, field) {
  const result = {};

  for (const item of items) {
    const key = item[field] || "unknown";
    result[key] = (result[key] || 0) + 1;
  }

  return result;
}

function buildReport(context) {
  const {
    csvIndex,
    offers,
    candidates,
    skipped,
    results,
    errors
  } = context;

  return {
    csvFile: CSV_FILE,
    outputDir: OUTPUT_DIR,
    generatedAt: new Date().toISOString(),
    execute: EXECUTE,
    allowActiveDuplicates: ALLOW_ACTIVE_DUPLICATES,
    limits: {
      pageLimit: LIMIT,
      requestDelayMs: REQUEST_DELAY_MS
    },
    totals: {
      csvRows: csvIndex.rows.length,
      csvRowsWithPositiveStock: csvIndex.rows.filter((row) => row.stock > 0).length,
      offersFetched: offers.length,
      closedOffersFetched: offers.filter((offer) => isReopenableStatus(offer.status)).length,
      candidates: candidates.length,
      skipped: skipped.length,
      reopened: results.filter((item) => item.ok).length,
      errors: errors.length
    },
    skippedByReason: countBy(skipped, "reason"),
    candidates,
    skipped,
    results,
    errors
  };
}

async function main() {
  ensureDir(OUTPUT_DIR);
  validateEnv();

  console.log("Tryb:", EXECUTE ? "EXECUTE - bede otwierac oferty" : "DRY RUN - nic nie otwieram");
  console.log("CSV:", CSV_FILE);
  console.log("Organization ID:", getOrganizationId());
  console.log("Client ID:", mask(process.env.CLIENT_ID));
  console.log("Pomijam aktywne duplikaty:", ALLOW_ACTIVE_DUPLICATES ? "nie" : "tak");
  console.log("");

  const csvIndex = readCsvStockIndex(CSV_FILE);
  console.log(`Wczytano CSV: ${csvIndex.rows.length} wierszy, delimiter "${csvIndex.delimiter}"`);

  const offers = await fetchAllOffers();
  const { candidates, skipped } = collectCandidates(offers, csvIndex);

  writeJson(CANDIDATES_FILE, candidates);
  writeJson(SKIPPED_FILE, skipped);

  console.log("");
  console.log(`Oferty CLOSED w InPost: ${offers.filter((offer) => isReopenableStatus(offer.status)).length}`);
  console.log(`Kandydaci do otwarcia: ${candidates.length}`);
  console.log(`Pominiete: ${skipped.length}`);
  console.log(`Raport kandydatow: ${CANDIDATES_FILE}`);
  console.log(`Raport pominietych: ${SKIPPED_FILE}`);

  const results = [];
  const errors = [];

  if (!EXECUTE) {
    console.log("");
    console.log("To byl dry-run. Jezeli lista kandydatow jest poprawna, uruchom:");
    console.log("npm run inpost:reopen-closed-instock:execute");
  } else {
    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index];

      console.log(
        `[${index + 1}/${candidates.length}] REOPEN externalId=${candidate.externalId}, offerId=${candidate.offerId}, stock=${candidate.csvMatch.selected.stock}`
      );

      const result = await reopenOffer(candidate.offerId);

      const record = {
        ...candidate,
        ok: result.ok,
        reopenStatus: result.status,
        reopenResponse: result.data
      };

      results.push(record);

      if (!result.ok) {
        errors.push(record);
        console.log(`  BLAD reopen, status=${result.status}`);
      } else {
        console.log(`  OK reopen, status=${result.status}`);
      }

      await sleep(REQUEST_DELAY_MS);
    }
  }

  const report = buildReport({
    csvIndex,
    offers,
    candidates,
    skipped,
    results,
    errors
  });

  writeJson(REPORT_FILE, report);
  writeJson(ERRORS_FILE, {
    summary: {
      errors: errors.length
    },
    errors
  });

  console.log("");
  console.log("Gotowe.");
  console.log(`Otworzono: ${report.totals.reopened}`);
  console.log(`Bledy: ${report.totals.errors}`);
  console.log(`Raport: ${REPORT_FILE}`);
}

main().catch((error) => {
  console.error("Blad krytyczny:");
  console.error(error.response?.data || error.message);
  process.exit(1);
});
