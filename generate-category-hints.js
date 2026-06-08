#!/usr/bin/env node

/**
 * generate-category-hints.js
 *
 * Generuje category-hints.json na podstawie EAN-ów z CSV WooCommerce.
 *
 * Schemat działania:
 * 1. Wczytuje CSV.
 * 2. Wyciąga unikalne EAN-y.
 * 3. Dla każdego EAN odpytuje InPost:
 *    GET /v1/organizations/{organizationId}/offers/hint?ean=<EAN>
 * 4. Zapisuje:
 *    - dist/category-hints.json
 *    - dist/category-hints-report.json
 *
 * Użycie:
 *   node generate-category-hints.js suppla-oferta.csv dist/category-hints.json
 *
 * Opcjonalnie, z walidacją względem category-map.json:
 *   node generate-category-hints.js suppla-oferta.csv dist/category-hints.json category-map.json
 *
 * Wymagane paczki:
 *   npm install axios dotenv csv-parse
 */

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { parse } = require("csv-parse/sync");

const INPUT_CSV = process.argv[2] || "suppla-oferta.csv";
const OUTPUT_HINTS_FILE = process.argv[3] || path.join("dist", "category-hints.json");
const CATEGORY_MAP_FILE = process.argv[4] || "";

const REQUIRED_ENV = [
  "CLIENT_ID",
  "CLIENT_SECRET",
  "INPOST_SCOPE",
  "INPOST_TOKEN_URL",
  "INPOST_BUY_API_BASE",
  "ORGANIZATION_ID"
];

const REQUEST_DELAY_MS = 150;
const MAX_RETRIES = 3;
const EXAMPLES_LIMIT = 5;

let tokenCache = {
  accessToken: null,
  expiresAt: 0
};

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readFileUtf8(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Nie znaleziono pliku: ${filePath}`);
  }

  return fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
}

function readJsonIfExists(filePath, fallback = {}) {
  if (!filePath || !fs.existsSync(filePath)) {
    return fallback;
  }

  return JSON.parse(readFileUtf8(filePath));
}

function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
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

function isLikelyEan(value) {
  const text = normalizeDigits(value);

  return /^[0-9]{8}$|^[0-9]{12}$|^[0-9]{13}$|^[0-9]{14}$/.test(text);
}

function getFirstNonEmpty(...values) {
  for (const value of values) {
    const text = normalizeText(value);

    if (text) {
      return text;
    }
  }

  return "";
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

function detectDelimiter(csvContent) {
  const firstLine = csvContent.split(/\r?\n/).find((line) => line.trim());

  if (!firstLine) {
    return ",";
  }

  const commaCount = (firstLine.match(/,/g) || []).length;
  const semicolonCount = (firstLine.match(/;/g) || []).length;

  return semicolonCount > commaCount ? ";" : ",";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mask(value) {
  if (!value) return "";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function extractCategoryId(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return normalizeText(value.id || value.categoryId || value.value || "");
  }

  return normalizeText(value);
}

function buildCategoryIdSet(categoryMap) {
  const ids = new Set();

  for (const value of Object.values(categoryMap || {})) {
    const categoryId = extractCategoryId(value);

    if (categoryId) {
      ids.add(categoryId);
    }
  }

  return ids;
}

function isUuidLike(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    normalizeText(value)
  );
}

/**
 * Próbuje wyciągnąć categoryId z różnych możliwych struktur odpowiedzi.
 *
 * Obsługiwane przykłady:
 * { "categoryId": "..." }
 * { "category": { "id": "..." } }
 * { "data": { "categoryId": "..." } }
 * { "data": { "category": { "id": "..." } } }
 */
function findCategoryIdDeep(data) {
  if (!data) {
    return "";
  }

  if (Array.isArray(data)) {
    for (const item of data) {
      const result = findCategoryIdDeep(item);

      if (result) {
        return result;
      }
    }

    return "";
  }

  if (typeof data !== "object") {
    return "";
  }

  if (isUuidLike(data.categoryId)) {
    return normalizeText(data.categoryId);
  }

  if (data.category && typeof data.category === "object" && isUuidLike(data.category.id)) {
    return normalizeText(data.category.id);
  }

  /**
   * Jeżeli obiekt wygląda jak kategoria.
   */
  if (
    isUuidLike(data.id) &&
    (
      Object.prototype.hasOwnProperty.call(data, "leaf") ||
      Object.prototype.hasOwnProperty.call(data, "name") ||
      Object.prototype.hasOwnProperty.call(data, "description")
    )
  ) {
    return normalizeText(data.id);
  }

  for (const value of Object.values(data)) {
    const result = findCategoryIdDeep(value);

    if (result) {
      return result;
    }
  }

  return "";
}

function getProductExample(row) {
  return {
    externalId: normalizeText(row["Identyfikator"]),
    name: normalizeText(row["Nazwa"]),
    sku: normalizeText(row["SKU"]),
    categories: normalizeText(row["Kategorie"])
  };
}

function buildProductsByEan(rows) {
  const productsByEan = new Map();
  const rowsWithoutEan = [];

  for (const row of rows) {
    const ean = getEan(row);

    if (!ean) {
      rowsWithoutEan.push({
        externalId: normalizeText(row["Identyfikator"]),
        name: normalizeText(row["Nazwa"]),
        sku: normalizeText(row["SKU"])
      });

      continue;
    }

    if (!productsByEan.has(ean)) {
      productsByEan.set(ean, []);
    }

    productsByEan.get(ean).push(getProductExample(row));
  }

  return {
    productsByEan,
    rowsWithoutEan
  };
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
      }
    }
  );

  const { access_token, expires_in } = response.data;

  tokenCache.accessToken = access_token;
  tokenCache.expiresAt = Date.now() + (Number(expires_in || 3600) - 30) * 1000;

  return tokenCache.accessToken;
}

async function getCategoryHintByEan(ean) {
  const token = await getAccessToken();

  const organizationId = process.env.ORGANIZATION_ID;

  const url =
    `${process.env.INPOST_BUY_API_BASE}` +
    `/v1/organizations/${encodeURIComponent(organizationId)}/offers/hint`;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await axios.get(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "Accept-Language": "pl"
        },
        params: {
          ean
        }
      });

      const categoryId = findCategoryIdDeep(response.data);

      if (!categoryId) {
        return {
          ok: false,
          status: response.status,
          reason: "NO_CATEGORY_ID_IN_RESPONSE",
          raw: response.data
        };
      }

      return {
        ok: true,
        status: response.status,
        categoryId,
        raw: response.data
      };
    } catch (error) {
      const status = error.response?.status;

      /**
       * 404 oznacza: InPost nie znalazł podpowiedzi po tym EAN.
       * To nie jest błąd krytyczny.
       */
      if (status === 404) {
        return {
          ok: false,
          status,
          reason: "HINT_NOT_FOUND_404",
          raw: error.response?.data || null
        };
      }

      /**
       * Przy 429 / 5xx próbujemy ponownie.
       */
      if ((status === 429 || status >= 500) && attempt < MAX_RETRIES) {
        const retryDelay = REQUEST_DELAY_MS * attempt * 5;
        await sleep(retryDelay);
        continue;
      }

      return {
        ok: false,
        status: status || null,
        reason: "REQUEST_ERROR",
        error: error.response?.data || error.message
      };
    }
  }

  return {
    ok: false,
    status: null,
    reason: "MAX_RETRIES_EXCEEDED"
  };
}

function validateEnv() {
  for (const key of REQUIRED_ENV) {
    if (!process.env[key]) {
      throw new Error(`Brakuje zmiennej środowiskowej: ${key}`);
    }
  }
}

async function main() {
  validateEnv();

  ensureDir(path.dirname(OUTPUT_HINTS_FILE));

  const reportFile = path.join(
    path.dirname(OUTPUT_HINTS_FILE),
    "category-hints-report.json"
  );

  const csvContent = readFileUtf8(INPUT_CSV);
  const delimiter = detectDelimiter(csvContent);

  const rows = parse(csvContent, {
    columns: true,
    skip_empty_lines: true,
    relax_quotes: true,
    relax_column_count: true,
    trim: false,
    delimiter
  });

  const categoryMap = readJsonIfExists(CATEGORY_MAP_FILE, {});
  const validCategoryIds = buildCategoryIdSet(categoryMap);
  const shouldValidateCategoryMap = Boolean(CATEGORY_MAP_FILE && fs.existsSync(CATEGORY_MAP_FILE));

  const { productsByEan, rowsWithoutEan } = buildProductsByEan(rows);

  const eans = [...productsByEan.keys()];

  const hints = {};
  const report = {
    inputCsv: INPUT_CSV,
    outputHintsFile: OUTPUT_HINTS_FILE,
    categoryMapFile: shouldValidateCategoryMap ? CATEGORY_MAP_FILE : null,
    delimiter,
    totals: {
      csvRows: rows.length,
      uniqueEans: eans.length,
      rowsWithoutEan: rowsWithoutEan.length,
      hintsFound: 0,
      hintsNotFound: 0,
      requestErrors: 0,
      hintsWithCategoryNotInCategoryMap: 0
    },
    rowsWithoutEan,
    found: [],
    notFound: [],
    errors: [],
    categoryNotInCategoryMap: []
  };

  console.log("Start generowania category-hints.json");
  console.log(`CSV: ${INPUT_CSV}`);
  console.log(`Output: ${OUTPUT_HINTS_FILE}`);
  console.log(`Client ID: ${mask(process.env.CLIENT_ID)}`);
  console.log(`Organization ID: ${process.env.ORGANIZATION_ID}`);
  console.log(`Wiersze CSV: ${rows.length}`);
  console.log(`Unikalne EAN-y: ${eans.length}`);
  console.log("");

  for (let index = 0; index < eans.length; index++) {
    const ean = eans[index];
    const products = productsByEan.get(ean) || [];
    const examples = products.slice(0, EXAMPLES_LIMIT);

    console.log(`[${index + 1}/${eans.length}] EAN ${ean}`);

    const result = await getCategoryHintByEan(ean);

    if (result.ok) {
      const categoryId = result.categoryId;

      const hintRecord = {
        categoryId,
        source: "inpost-hint",
        ean,
        productCount: products.length,
        examples
      };

      if (shouldValidateCategoryMap) {
        hintRecord.validInCategoryMap = validCategoryIds.has(categoryId);
      }

      hints[ean] = hintRecord;

      report.totals.hintsFound++;

      report.found.push({
        ean,
        categoryId,
        productCount: products.length,
        examples,
        validInCategoryMap: shouldValidateCategoryMap
          ? validCategoryIds.has(categoryId)
          : null
      });

      if (shouldValidateCategoryMap && !validCategoryIds.has(categoryId)) {
        report.totals.hintsWithCategoryNotInCategoryMap++;

        report.categoryNotInCategoryMap.push({
          ean,
          categoryId,
          productCount: products.length,
          examples
        });
      }
    } else if (result.status === 404 || result.reason === "HINT_NOT_FOUND_404") {
      report.totals.hintsNotFound++;

      report.notFound.push({
        ean,
        reason: result.reason,
        status: result.status,
        productCount: products.length,
        examples
      });
    } else {
      report.totals.requestErrors++;

      report.errors.push({
        ean,
        reason: result.reason,
        status: result.status,
        error: result.error || result.raw || null,
        productCount: products.length,
        examples
      });
    }

    await sleep(REQUEST_DELAY_MS);
  }

  writeJson(OUTPUT_HINTS_FILE, hints);
  writeJson(reportFile, report);

  console.log("");
  console.log("Gotowe.");
  console.log(`Znaleziono hintów: ${report.totals.hintsFound}`);
  console.log(`Brak hintu 404: ${report.totals.hintsNotFound}`);
  console.log(`Błędy zapytań: ${report.totals.requestErrors}`);
  console.log(`Wiersze bez EAN: ${report.totals.rowsWithoutEan}`);

  if (shouldValidateCategoryMap) {
    console.log(
      `Hinty z categoryId spoza category-map.json: ${report.totals.hintsWithCategoryNotInCategoryMap}`
    );
  }

  console.log("");
  console.log(`Zapisano: ${OUTPUT_HINTS_FILE}`);
  console.log(`Raport: ${reportFile}`);

  if (report.totals.requestErrors > 0) {
    console.log("");
    console.log("Uwaga: wystąpiły błędy zapytań. Sprawdź category-hints-report.json.");
  }

  if (report.totals.hintsWithCategoryNotInCategoryMap > 0) {
    console.log("");
    console.log(
      "Uwaga: część categoryId z hintów nie występuje w category-map.json. " +
      "Możliwe, że category-map.json jest nieaktualny."
    );
  }
}

main().catch((error) => {
  console.error("");
  console.error("Błąd krytyczny:");
  console.error(error.response?.data || error.message);
  process.exit(1);
});