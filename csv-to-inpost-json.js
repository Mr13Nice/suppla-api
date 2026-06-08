#!/usr/bin/env node

/**
 * csv-to-inpost-json.js
 *
 * CSV WooCommerce -> JSON ofert InPost Buy + osobna mapa zdjęć.
 *
 * Uproszczone mapowanie kategorii:
 *   1. category-hints.json po EAN
 *   2. category-overrides.json po kategorii WooCommerce
 *   3. brak przypisania -> produkt pomijany
 *
 * Użycie:
 *   node csv-to-inpost-json.js suppla-oferta.csv category-map.json dist category-overrides.json dist/category-hints.json
 *
 * Domyslnie skrypt pobiera istniejace oferty z InPost i nie generuje nowych
 * ofert dla externalId, ktore juz istnieja. Uzyj --offline, aby pominac ten
 * krok i wygenerowac pliki bez sprawdzania InPost.
 *
 * Raporty:
 *   dist/csv-generation-report.json
 *   dist/csv-generation-errors.json
 *
 * Wymagane paczki:
 *   npm install axios dotenv csv-parse he
 */

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const crypto = require("crypto");
const { parse } = require("csv-parse/sync");
const he = require("he");

const INPUT_CSV = process.argv[2] || "suppla-oferta.csv";
const CATEGORY_MAP_FILE = process.argv[3] || "category-map.json";
const OUTPUT_DIR = process.argv[4] || "dist";
const CATEGORY_OVERRIDES_FILE = process.argv[5] || "category-overrides.json";
const CATEGORY_HINTS_FILE = process.argv[6] || path.join(OUTPUT_DIR, "category-hints.json");

const STRICT_MODE = false;

const REQUIRE_IMAGE = true;
const ONLY_PUBLISHED = true;
const SKIP_OUT_OF_STOCK = false;

const INCLUDE_IMAGES_IN_OFFER_JSON = false;
const INCLUDE_META_IN_OFFERS = false;

const USE_NAME_AS_FALLBACK_DESCRIPTION = false;
const MIN_DESCRIPTION_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 4000;

const DEFAULT_TAX_RATE = "23%";
const DEFAULT_CURRENCY = "PLN";
const DEFAULT_STOCK_UNIT = "UNIT";
const DEFAULT_BRAND = "Inna marka";

const CHECK_EXISTING_INPOST = !process.argv.includes("--offline");
const CLEANUP_DUPLICATES = process.argv.includes("--cleanup-duplicates");
const EXECUTE_CLEANUP =
  process.argv.includes("--execute-cleanup") || process.argv.includes("--execute");
const CLOSE_ONLY = process.argv.includes("--close-only");

const REQUEST_DELAY_MS = Number(process.env.INPOST_REQUEST_DELAY_MS || 150);
const PAGE_LIMIT = Number(process.env.INPOST_OFFERS_PAGE_LIMIT || 100);

const REQUIRED_ENV_FOR_INPOST = [
  "CLIENT_ID",
  "CLIENT_SECRET",
  "INPOST_SCOPE",
  "INPOST_TOKEN_URL",
  "INPOST_BUY_API_BASE",
  "ORGANIZATION_ID"
];

const CLOSED_STATUSES = new Set([
  "CLOSED",
  "CLOSE",
  "ENDED",
  "ARCHIVED",
  "DELETED",
  "REMOVED",
  "INACTIVE"
]);

const OBSOLETE_GENERATION_FILES = [
  "inpost-offers-wrapped.json",
  "skipped-products.json",
  "blocking-skipped-products.json",
  "products-without-images.json",
  "short-descriptions.json",
  "unresolved-categories.json",
  "category-resolution-report.json",
  "invalid-category-overrides.json",
  "duplicate-offers-report.json",
  "duplicate-offers-groups.json",
  "duplicate-offers-planned-actions.json",
  "duplicate-offers-without-external-id.json",
  "duplicate-offers-success.json",
  "duplicate-offers-errors.json",
  "duplicate-offers-skipped-already-closed.json"
];

let tokenCache = {
  accessToken: null,
  expiresAt: 0
};

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

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function removeFileIfExists(filePath) {
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function cleanupObsoleteGenerationFiles(outputDir) {
  for (const fileName of OBSOLETE_GENERATION_FILES) {
    removeFileIfExists(path.join(outputDir, fileName));
  }
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

function mask(value) {
  if (!value) return "";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function validateInpostEnv() {
  for (const key of REQUIRED_ENV_FOR_INPOST) {
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

function getRequestId() {
  return crypto.randomUUID();
}

function isClosedStatus(status) {
  return CLOSED_STATUSES.has(normalizeText(status).toUpperCase());
}

function normalizeCategoryPath(categoryPath) {
  return normalizeText(categoryPath)
    .replace(/\s*>\s*/g, " > ")
    .replace(/\s*\/\s*/g, " / ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeForCompare(value) {
  return normalizeText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s*>\s*/g, " > ")
    .replace(/\s*\/\s*/g, " / ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function limitText(value, maxLength = MAX_DESCRIPTION_LENGTH) {
  const text = normalizeText(value);

  if (text.length <= maxLength) {
    return text;
  }

  return text.slice(0, maxLength).trim();
}

function cleanHtmlToText(value) {
  const decoded = he.decode(String(value ?? ""));

  return decoded
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<\/h[1-6]>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseNumber(value) {
  if (value === undefined || value === null) {
    return null;
  }

  const normalized = String(value)
    .replace(/\s/g, "")
    .replace(",", ".")
    .trim();

  if (!normalized) {
    return null;
  }

  const number = Number(normalized);

  return Number.isFinite(number) ? number : null;
}

function parseInteger(value) {
  const number = parseNumber(value);

  if (number === null) {
    return null;
  }

  return Math.max(0, Math.floor(number));
}

function roundMoney(value) {
  return Math.round(value * 100) / 100;
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

function detectDelimiter(csvContent) {
  const firstLine = csvContent.split(/\r?\n/).find((line) => line.trim());

  if (!firstLine) {
    return ",";
  }

  const commaCount = (firstLine.match(/,/g) || []).length;
  const semicolonCount = (firstLine.match(/;/g) || []).length;

  return semicolonCount > commaCount ? ";" : ",";
}

function splitEscapedCommaList(value) {
  const raw = normalizeText(value);

  if (!raw) {
    return [];
  }

  const result = [];
  let current = "";
  let escaped = false;

  for (const char of raw) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === ",") {
      const item = current.trim();

      if (item) {
        result.push(item);
      }

      current = "";
      continue;
    }

    current += char;
  }

  const lastItem = current.trim();

  if (lastItem) {
    result.push(lastItem);
  }

  return result;
}

function splitWooCategories(value) {
  return splitEscapedCommaList(value)
    .map((item) => normalizeCategoryPath(item))
    .filter(Boolean);
}

function categoryDepth(categoryPath) {
  return normalizeCategoryPath(categoryPath)
    .split(">")
    .map((part) => part.trim())
    .filter(Boolean).length;
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

function buildNormalizedCategoryMap(categoryMap) {
  const normalizedMap = {};

  for (const [categoryPath, rawCategoryValue] of Object.entries(categoryMap || {})) {
    const categoryId = extractCategoryId(rawCategoryValue);

    if (!categoryId) {
      continue;
    }

    normalizedMap[normalizeForCompare(categoryPath)] = {
      originalPath: categoryPath,
      categoryId
    };
  }

  return normalizedMap;
}

function buildNormalizedOverridesMap(categoryOverrides) {
  const normalizedMap = {};
  const duplicates = [];

  for (const [wooCategoryPath, inpostCategoryValue] of Object.entries(categoryOverrides || {})) {
    const normalizedKey = normalizeForCompare(wooCategoryPath);

    if (normalizedMap[normalizedKey]) {
      duplicates.push({
        normalizedKey,
        firstOriginalPath: normalizedMap[normalizedKey].originalPath,
        duplicatedOriginalPath: wooCategoryPath
      });
    }

    normalizedMap[normalizedKey] = {
      originalPath: wooCategoryPath,
      value: inpostCategoryValue
    };
  }

  return {
    normalizedMap,
    duplicates
  };
}

function resolveOverrideValue(value, categoryMap, normalizedCategoryMap) {
  const cleanValue = normalizeText(value);

  if (!cleanValue) {
    return null;
  }

  if (categoryMap[cleanValue]) {
    return {
      categoryId: extractCategoryId(categoryMap[cleanValue]),
      resolvedFrom: cleanValue,
      resolvedBy: "category-map-path"
    };
  }

  const normalizedValue = normalizeForCompare(cleanValue);

  if (normalizedCategoryMap[normalizedValue]) {
    return {
      categoryId: normalizedCategoryMap[normalizedValue].categoryId,
      resolvedFrom: normalizedCategoryMap[normalizedValue].originalPath,
      resolvedBy: "category-map-normalized-path"
    };
  }

  return {
    categoryId: cleanValue,
    resolvedFrom: "direct-id",
    resolvedBy: "direct-id"
  };
}

function validateCategoryOverrides(categoryOverrides, categoryMap) {
  const normalizedCategoryMap = buildNormalizedCategoryMap(categoryMap);
  const { duplicates } = buildNormalizedOverridesMap(categoryOverrides);
  const validCategoryIds = buildCategoryIdSet(categoryMap);
  const shouldValidateIds = validCategoryIds.size > 0;
  const invalidOverrides = [];

  for (const duplicate of duplicates) {
    invalidOverrides.push({
      error: "Zdublowana kategoria WooCommerce po normalizacji",
      ...duplicate
    });
  }

  for (const [wooCategory, inpostCategoryValue] of Object.entries(categoryOverrides || {})) {
    const cleanWooCategory = normalizeCategoryPath(wooCategory);
    const cleanValue = normalizeText(inpostCategoryValue);

    if (!cleanWooCategory) {
      invalidOverrides.push({
        wooCategory,
        inpostCategoryValue,
        error: "Pusta kategoria WooCommerce"
      });

      continue;
    }

    if (!cleanValue) {
      invalidOverrides.push({
        wooCategory,
        inpostCategoryValue,
        error: "Puste ID albo pusta ścieżka kategorii InPost"
      });

      continue;
    }

    const resolved = resolveOverrideValue(cleanValue, categoryMap, normalizedCategoryMap);

    if (!resolved?.categoryId) {
      invalidOverrides.push({
        wooCategory,
        inpostCategoryValue,
        error: "Nie udało się rozwiązać wartości mapowania"
      });

      continue;
    }

    if (shouldValidateIds && !validCategoryIds.has(resolved.categoryId)) {
      invalidOverrides.push({
        wooCategory,
        inpostCategoryValue,
        resolvedCategoryId: resolved.categoryId,
        error: "ID kategorii InPost nie występuje w category-map.json"
      });
    }
  }

  return invalidOverrides;
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

function getHintCategoryId(row, categoryHints) {
  const ean = getEan(row);

  if (!ean) {
    return null;
  }

  const hint = categoryHints[ean];

  if (!hint) {
    return null;
  }

  const categoryId = typeof hint === "string"
    ? normalizeText(hint)
    : normalizeText(hint.categoryId || hint.id || "");

  if (!categoryId) {
    return null;
  }

  return {
    ean,
    categoryId
  };
}

function resolveCategoryId(row, categoryMap, categoryOverrides, categoryHints) {
  const normalizedCategoryMap = buildNormalizedCategoryMap(categoryMap);
  const { normalizedMap: normalizedOverridesMap } = buildNormalizedOverridesMap(categoryOverrides);

  const categories = splitWooCategories(row["Kategorie"]);

  const sortedCategories = [...categories].sort((a, b) => {
    const depthDiff = categoryDepth(b) - categoryDepth(a);

    if (depthDiff !== 0) {
      return depthDiff;
    }

    return b.length - a.length;
  });

  const hint = getHintCategoryId(row, categoryHints);

  if (hint) {
    return {
      categoryId: hint.categoryId,
      matchedBy: "inpost-hint-ean",
      matchedWooCategory: null,
      matchedInpostCategory: `EAN hint: ${hint.ean}`,
      allWooCategories: categories
    };
  }

  for (const wooCategory of sortedCategories) {
    if (Object.prototype.hasOwnProperty.call(categoryOverrides, wooCategory)) {
      const resolved = resolveOverrideValue(
        categoryOverrides[wooCategory],
        categoryMap,
        normalizedCategoryMap
      );

      if (resolved?.categoryId) {
        return {
          categoryId: resolved.categoryId,
          matchedBy: "override-exact",
          matchedWooCategory: wooCategory,
          matchedInpostCategory: resolved.resolvedFrom,
          allWooCategories: categories
        };
      }
    }
  }

  for (const wooCategory of sortedCategories) {
    const normalizedWooCategory = normalizeForCompare(wooCategory);

    if (normalizedOverridesMap[normalizedWooCategory]) {
      const resolved = resolveOverrideValue(
        normalizedOverridesMap[normalizedWooCategory].value,
        categoryMap,
        normalizedCategoryMap
      );

      if (resolved?.categoryId) {
        return {
          categoryId: resolved.categoryId,
          matchedBy: "override-normalized",
          matchedWooCategory: wooCategory,
          matchedInpostCategory: resolved.resolvedFrom,
          allWooCategories: categories
        };
      }
    }
  }

  return {
    categoryId: null,
    matchedBy: null,
    matchedWooCategory: null,
    matchedInpostCategory: null,
    allWooCategories: categories
  };
}

function extractOfferFromListItem(item) {
  return item?.offer || item;
}

function extractMetadataFromListItem(item) {
  return item?.metadata || item?.offer?.metadata || {};
}

function extractValidationErrors(metadata) {
  if (Array.isArray(metadata?.validationErrors)) {
    return metadata.validationErrors;
  }

  if (Array.isArray(metadata?.errors)) {
    return metadata.errors;
  }

  return [];
}

function hasCategoryIncorrect(validationErrors) {
  return validationErrors.some((error) => {
    const code = normalizeText(
      error.validationCode ||
      error.errorCode ||
      error.code ||
      ""
    );

    const message = normalizeText(
      error.validationMessage ||
      error.errorMessage ||
      error.message ||
      ""
    ).toLowerCase();

    return (
      code === "CATEGORY_INCORRECT" ||
      message.includes("kategoria") ||
      message.includes("category")
    );
  });
}

function toTimestamp(value) {
  const time = Date.parse(value || "");

  return Number.isFinite(time) ? time : 0;
}

function getOfferScore(normalizedOffer) {
  let score = 0;
  const status = normalizeText(normalizedOffer.status).toUpperCase();
  const validationCount = normalizedOffer.validationErrors.length;

  if (!isClosedStatus(status)) score += 1000;
  if (validationCount === 0) {
    score += 500;
  } else {
    score -= Math.min(validationCount, 20) * 50;
  }
  if (!normalizedOffer.hasCategoryIncorrect) score += 100;
  if (normalizedOffer.categoryId) score += 50;
  if (normalizedOffer.ean) score += 20;
  if (normalizedOffer.sku) score += 10;

  score += Math.floor(toTimestamp(normalizedOffer.updatedAt) / 1000000000);

  return score;
}

function normalizeOfferListItem(item) {
  const offer = extractOfferFromListItem(item);
  const metadata = extractMetadataFromListItem(item);
  const validationErrors = extractValidationErrors(metadata);

  const normalized = {
    offerId: normalizeText(offer?.id),
    externalId: normalizeText(offer?.externalId),
    status: normalizeText(offer?.status),
    name: normalizeText(offer?.product?.name),
    sku: normalizeText(offer?.product?.sku),
    ean: normalizeText(offer?.product?.ean),
    categoryId: normalizeText(offer?.product?.categoryId),
    createdAt: offer?.createdAt || null,
    updatedAt: offer?.updatedAt || null,
    validationErrors,
    hasCategoryIncorrect: hasCategoryIncorrect(validationErrors)
  };

  normalized.score = getOfferScore(normalized);

  return normalized;
}

function summarizeExistingOffer(offer) {
  return {
    offerId: offer.offerId,
    externalId: offer.externalId,
    status: offer.status,
    name: offer.name,
    sku: offer.sku,
    ean: offer.ean,
    categoryId: offer.categoryId,
    createdAt: offer.createdAt,
    updatedAt: offer.updatedAt,
    validationErrorsCount: offer.validationErrors.length,
    hasCategoryIncorrect: offer.hasCategoryIncorrect,
    score: offer.score
  };
}

function chooseKeeper(offers) {
  return [...offers].sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }

    return toTimestamp(b.updatedAt) - toTimestamp(a.updatedAt);
  })[0];
}

function buildExistingOffersState(items) {
  const byExternalId = new Map();
  const skippedWithoutExternalId = [];

  for (const item of items) {
    const normalized = normalizeOfferListItem(item);

    if (!normalized.offerId) {
      continue;
    }

    if (!normalized.externalId) {
      skippedWithoutExternalId.push(normalized);
      continue;
    }

    if (!byExternalId.has(normalized.externalId)) {
      byExternalId.set(normalized.externalId, []);
    }

    byExternalId.get(normalized.externalId).push(normalized);
  }

  const duplicateGroups = [];
  const plannedActions = [];

  for (const [externalId, offers] of byExternalId.entries()) {
    if (offers.length <= 1) {
      continue;
    }

    const keeper = chooseKeeper(offers);
    const duplicatesToCleanup = offers.filter(
      (offer) => offer.offerId !== keeper.offerId
    );

    duplicateGroups.push({
      externalId,
      count: offers.length,
      keeper: summarizeExistingOffer(keeper),
      duplicatesToCleanup: duplicatesToCleanup.map(summarizeExistingOffer),
      allOffers: offers
        .sort((a, b) => b.score - a.score)
        .map(summarizeExistingOffer)
    });

    for (const duplicate of duplicatesToCleanup) {
      plannedActions.push({
        externalId,
        action: CLOSE_ONLY ? "CLOSE" : "DELETE_THEN_CLOSE_FALLBACK",
        offerToKeep: summarizeExistingOffer(keeper),
        offerToCleanup: summarizeExistingOffer(duplicate)
      });
    }
  }

  return {
    byExternalId,
    duplicateGroups,
    plannedActions,
    skippedWithoutExternalId
  };
}

function getListItems(responseData) {
  if (Array.isArray(responseData)) {
    return responseData;
  }

  if (responseData && Array.isArray(responseData.data)) {
    return responseData.data;
  }

  if (responseData?.data && Array.isArray(responseData.data.data)) {
    return responseData.data.data;
  }

  return [];
}

function getTotalFromResponse(responseData, fallback) {
  if (responseData?.page?.total !== undefined) {
    return Number(responseData.page.total);
  }

  if (responseData?.data?.page?.total !== undefined) {
    return Number(responseData.data.page.total);
  }

  return fallback;
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

async function inpostRequest(method, pathUrl, options = {}) {
  const token = await getAccessToken();
  const requestId = getRequestId();

  const response = await axios({
    method,
    url: `${getBaseUrl()}${pathUrl}`,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Accept-Language": "pl",
      "X-Request-Id": requestId,
      ...(options.contentType
        ? { "Content-Type": options.contentType }
        : {})
    },
    params: options.params,
    data: options.data,
    validateStatus: () => true
  });

  return {
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    data: response.data,
    requestId: response.headers?.["x-request-id"] || requestId
  };
}

async function fetchAllExistingOffers() {
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
          limit: PAGE_LIMIT,
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
    total = getTotalFromResponse(result.data, allItems.length);

    console.log(
      `Pobrano oferty z InPost: ${allItems.length}${total !== null ? ` / ${total}` : ""}`
    );

    if (!items.length) break;

    offset += PAGE_LIMIT;

    if (total !== null && allItems.length >= total) break;

    await sleep(REQUEST_DELAY_MS);
  }

  return allItems;
}

async function deleteOffer(offerId) {
  const organizationId = getOrganizationId();

  return inpostRequest(
    "DELETE",
    `/v1/organizations/${encodeURIComponent(organizationId)}/offers/${encodeURIComponent(offerId)}`
  );
}

async function closeOffer(offerId) {
  const organizationId = getOrganizationId();

  return inpostRequest(
    "POST",
    `/v1/organizations/${encodeURIComponent(organizationId)}/offers/${encodeURIComponent(offerId)}/close`,
    {
      contentType: "application/json",
      data: {}
    }
  );
}

async function executeDuplicateCleanup(plannedActions) {
  const success = [];
  const errors = [];
  const skippedAlreadyClosed = [];

  for (let i = 0; i < plannedActions.length; i++) {
    const action = plannedActions[i];
    const offer = action.offerToCleanup;
    const offerId = offer.offerId;

    console.log(
      `[cleanup ${i + 1}/${plannedActions.length}] externalId=${action.externalId}, offerId=${offerId}`
    );

    if (isClosedStatus(offer.status)) {
      skippedAlreadyClosed.push({
        ...action,
        result: "SKIPPED_ALREADY_CLOSED"
      });
      console.log("  Pomijam: oferta juz zamknieta/nieaktywna.");
      continue;
    }

    let deleteResult = null;

    if (!CLOSE_ONLY) {
      deleteResult = await deleteOffer(offerId);

      if (deleteResult.ok) {
        success.push({
          ...action,
          result: "DELETED",
          deleteStatus: deleteResult.status,
          deleteResponse: deleteResult.data,
          requestId: deleteResult.requestId
        });
        console.log(`  OK DELETE, status=${deleteResult.status}`);
        await sleep(REQUEST_DELAY_MS);
        continue;
      }

      console.log(
        `  DELETE nieudany, status=${deleteResult.status}. Proba zamkniecia...`
      );
      await sleep(REQUEST_DELAY_MS);
    }

    const closeResult = await closeOffer(offerId);

    if (closeResult.ok) {
      success.push({
        ...action,
        result: "CLOSED",
        deleteStatus: deleteResult?.status || null,
        deleteError: deleteResult?.data || null,
        closeStatus: closeResult.status,
        closeResponse: closeResult.data,
        requestId: closeResult.requestId
      });
      console.log(`  OK CLOSE, status=${closeResult.status}`);
    } else {
      errors.push({
        ...action,
        result: "FAILED",
        deleteStatus: deleteResult?.status || null,
        deleteError: deleteResult?.data || null,
        deleteRequestId: deleteResult?.requestId || null,
        closeStatus: closeResult.status,
        closeError: closeResult.data,
        closeRequestId: closeResult.requestId
      });
      console.log(`  BLAD CLOSE, status=${closeResult.status}`);
    }

    await sleep(REQUEST_DELAY_MS);
  }

  return {
    success,
    errors,
    skippedAlreadyClosed
  };
}

function getPrice(row) {
  const price = parseNumber(
    getFirstNonEmpty(
      row["Cena promocyjna"],
      row["Cena"],
      row["Cena regularna"]
    )
  );

  return price === null ? null : roundMoney(price);
}

function getTaxRate(row) {
  const taxRate = getFirstNonEmpty(
    row["Stawka podatku"],
    row["VAT"],
    row["Podatek"],
    row["Tax rate"]
  );

  return taxRate || DEFAULT_TAX_RATE;
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

function getSku(row) {
  return getFirstNonEmpty(row["SKU"], row["Identyfikator"]);
}

function getBrand(row) {
  const brandFromColumn = normalizeText(row["Marki"]);

  if (brandFromColumn) {
    return splitEscapedCommaList(brandFromColumn)[0] || brandFromColumn;
  }

  const name = normalizeText(row["Nazwa"]);
  const firstWord = name.split(" ")[0];

  return firstWord || DEFAULT_BRAND;
}

function getManufacturerProductNumber(row) {
  return getFirstNonEmpty(
    row["Kod producenta"],
    row["MPN"],
    row["Numer katalogowy"]
  );
}

function getDimensions(row) {
  const dimension = {};

  const weightKg = parseNumber(row["Waga (kg)"]);
  const lengthCm = parseNumber(row["Długość (cm)"]);
  const widthCm = parseNumber(row["Szerokość (cm)"]);
  const heightCm = parseNumber(row["Wysokość (cm)"]);

  if (weightKg !== null) {
    dimension.weight = Math.round(weightKg * 1000);
  }

  if (lengthCm !== null) {
    dimension.length = Math.round(lengthCm * 10);
  }

  if (widthCm !== null) {
    dimension.width = Math.round(widthCm * 10);
  }

  if (heightCm !== null) {
    dimension.height = Math.round(heightCm * 10);
  }

  return Object.keys(dimension).length ? dimension : undefined;
}

function getProductImages(row) {
  const images = normalizeText(row["Obrazki"]);

  if (!images) {
    return [];
  }

  return splitEscapedCommaList(images)
    .map((url) => normalizeText(url))
    .filter(Boolean)
    .filter((url) => /^https?:\/\//i.test(url));
}

function getProductUrl(row) {
  return getFirstNonEmpty(
    row["Adres URL"],
    row["URL"],
    row["Permalink"],
    row["Zewnętrzny adres URL"]
  );
}

function buildInpostAttributes(row) {
  return [];
}

function buildDescriptionSupplement(row, context) {
  const categories = splitWooCategories(row["Kategorie"]);
  const leafCategory = categories
    .map((categoryPath) => normalizeCategoryPath(categoryPath))
    .sort((a, b) => categoryDepth(b) - categoryDepth(a))[0];

  const facts = [];

  if (context.brand) {
    facts.push(`Marka: ${context.brand}.`);
  }

  if (leafCategory) {
    facts.push(`Kategoria produktu: ${leafCategory}.`);
  }

  if (context.ean) {
    facts.push(`Kod EAN: ${context.ean}.`);
  }

  if (context.sku) {
    facts.push(`SKU produktu: ${context.sku}.`);
  }

  facts.push(
    "Opis uzupelniony automatycznie na podstawie danych katalogowych produktu z eksportu WooCommerce."
  );

  return facts.join(" ");
}

function ensureMinimumDescriptionLength(description, row, context) {
  let result = normalizeText(description);
  const originalLength = result.length;

  if (result.length < MIN_DESCRIPTION_LENGTH) {
    const supplement = buildDescriptionSupplement(row, context);
    result = normalizeText([result, supplement].filter(Boolean).join(" "));

    while (result.length < MIN_DESCRIPTION_LENGTH) {
      result = normalizeText(
        `${result} Produkt opisany na podstawie nazwy, marki, kategorii oraz kodow identyfikacyjnych.`
      );
    }
  }

  result = limitText(result, MAX_DESCRIPTION_LENGTH);

  return {
    description: result,
    generated: originalLength < MIN_DESCRIPTION_LENGTH,
    originalLength,
    finalLength: result.length
  };
}

function getProductDescription(row, context) {
  const descriptionFromHtml = cleanHtmlToText(
    getFirstNonEmpty(row["Opis"], row["Krótki opis"])
  );

  const fallbackDescription = USE_NAME_AS_FALLBACK_DESCRIPTION
    ? context.name
    : "";

  return ensureMinimumDescriptionLength(
    descriptionFromHtml || fallbackDescription,
    row,
    context
  );
}

function buildOffer(row, categoryMap, categoryOverrides, categoryHints) {
  const externalId = normalizeText(row["Identyfikator"]);
  const name = normalizeText(row["Nazwa"]);
  const price = getPrice(row);
  const quantity = getStockQuantity(row);
  const sku = getSku(row);
  const ean = getEan(row);
  const brand = getBrand(row);
  const descriptionResult = getProductDescription(row, {
    name,
    brand,
    sku,
    ean
  });
  const description = descriptionResult.description;
  const manufacturerProductNumber = getManufacturerProductNumber(row);
  const dimensions = getDimensions(row);
  const images = getProductImages(row);
  const productUrl = getProductUrl(row);
  const taxRate = getTaxRate(row);

  const categoryResult = resolveCategoryId(
    row,
    categoryMap,
    categoryOverrides,
    categoryHints
  );

  const errors = [];

  if (!externalId) errors.push("Brak Identyfikator");
  if (!name) errors.push("Brak Nazwa");

  if (!description) {
    errors.push("Brak Opis");
  } else if (description.length < MIN_DESCRIPTION_LENGTH) {
    errors.push(`Opis krótszy niż ${MIN_DESCRIPTION_LENGTH} znaków`);
  }

  if (price === null) errors.push("Brak Cena / Cena promocyjna");
  if (price !== null && price <= 0) errors.push("Cena musi być większa od 0");

  if (!categoryResult.categoryId) {
    errors.push("Brak mapowania kategorii w category-hints.json albo category-overrides.json");
  }

  if (REQUIRE_IMAGE && images.length === 0) {
    errors.push("Brak zdjęcia w kolumnie Obrazki");
  }

  if (errors.length) {
    return {
      offer: null,
      images,
      skipped: {
        externalId,
        name,
        sku,
        ean,
        price,
        stock: quantity,
        images,
        descriptionLength: description.length,
        descriptionOriginalLength: descriptionResult.originalLength,
        descriptionGenerated: descriptionResult.generated,
        categories: categoryResult.allWooCategories || splitWooCategories(row["Kategorie"]),
        categoryResolution: {
          categoryId: categoryResult.categoryId,
          matchedBy: categoryResult.matchedBy,
          matchedWooCategory: categoryResult.matchedWooCategory,
          matchedInpostCategory: categoryResult.matchedInpostCategory
        },
        errors
      },
      categoryResolution: categoryResult,
      descriptionGenerated: descriptionResult.generated,
      descriptionOriginalLength: descriptionResult.originalLength,
      descriptionFinalLength: descriptionResult.finalLength
    };
  }

  const product = {
    name,
    description,
    brand,
    categoryId: categoryResult.categoryId,
    sku
  };

  if (ean) {
    product.ean = ean;
  }

  if (manufacturerProductNumber) {
    product.manufacturerProductNumber = manufacturerProductNumber;
  }

  const attributes = buildInpostAttributes(row);

  if (attributes.length) {
    product.attributes = attributes;
  }

  if (dimensions) {
    product.dimension = dimensions;
  }

  if (INCLUDE_IMAGES_IN_OFFER_JSON && images.length) {
    product.images = images.map((url) => ({ url }));
  }

  const offer = {
    externalId,
    product,
    stock: {
      quantity,
      unit: DEFAULT_STOCK_UNIT
    },
    price: {
      grossPrice: {
        amount: price,
        currency: DEFAULT_CURRENCY
      },
      taxRateInfo: taxRate
    }
  };

  if (productUrl) {
    offer.affiliationProductUrl = productUrl;
  }

  if (INCLUDE_META_IN_OFFERS) {
    offer._meta = {
      wooCategory: categoryResult.matchedWooCategory,
      inpostCategory: categoryResult.matchedInpostCategory,
      matchedBy: categoryResult.matchedBy
    };
  }

  return {
    offer,
    images,
    skipped: null,
    categoryResolution: categoryResult,
    descriptionGenerated: descriptionResult.generated,
    descriptionOriginalLength: descriptionResult.originalLength,
    descriptionFinalLength: descriptionResult.finalLength
  };
}

function isBlockingSkippedProduct(skippedProduct) {
  const ignoredErrors = new Set([
    "Produkt nieopublikowany",
    "Pominięto wariant/produkt nadrzędny",
    "Pominięto produkt ze stanem 0"
  ]);

  return skippedProduct.errors.some((error) => !ignoredErrors.has(error));
}

function updateCategoryReport(report, categoryResolution) {
  const key = categoryResolution.matchedBy || "unresolved";

  if (!report.byMethod[key]) {
    report.byMethod[key] = 0;
  }

  report.byMethod[key]++;

  if (categoryResolution.categoryId) {
    report.resolved.push({
      categoryId: categoryResolution.categoryId,
      matchedBy: categoryResolution.matchedBy,
      matchedWooCategory: categoryResolution.matchedWooCategory,
      matchedInpostCategory: categoryResolution.matchedInpostCategory
    });
  } else {
    report.unresolved.push({
      categories: categoryResolution.allWooCategories || []
    });
  }
}

function logObjectCounts(title, object) {
  console.log(title);

  const entries = Object.entries(object);

  if (!entries.length) {
    console.log("- brak");
    return;
  }

  for (const [key, count] of entries) {
    console.log(`- ${key}: ${count}`);
  }
}

function isPublished(row) {
  return normalizeText(row["Opublikowano"]) === "1";
}

function shouldSkipByProductType(row) {
  const productType = normalizeText(row["Rodzaj"]);

  if (!productType || productType === "simple") {
    return null;
  }

  return {
    type: productType,
    reason: "Pominięto wariant/produkt nadrzędny"
  };
}

async function main() {
  ensureDir(OUTPUT_DIR);
  cleanupObsoleteGenerationFiles(OUTPUT_DIR);

  const csvContent = readFileUtf8(INPUT_CSV);
  const categoryMap = readJsonIfExists(CATEGORY_MAP_FILE, {});
  const categoryOverrides = readJsonIfExists(CATEGORY_OVERRIDES_FILE, {});
  const categoryHints = readJsonIfExists(CATEGORY_HINTS_FILE, {});

  const invalidOverrides = validateCategoryOverrides(categoryOverrides, categoryMap);

  if (invalidOverrides.length) {
    writeJson(
      path.join(OUTPUT_DIR, "csv-generation-errors.json"),
      {
        summary: {
          invalidCategoryOverrides: invalidOverrides.length
        },
        invalidCategoryOverrides: invalidOverrides
      }
    );

    throw new Error(
      `category-overrides.json zawiera błędne mapowania: ${invalidOverrides.length}. ` +
      `Sprawdz ${path.join(OUTPUT_DIR, "csv-generation-errors.json")}`
    );
  }

  const delimiter = detectDelimiter(csvContent);

  const rows = parse(csvContent, {
    columns: true,
    skip_empty_lines: true,
    relax_quotes: true,
    relax_column_count: true,
    trim: false,
    delimiter
  });

  let existingItems = [];
  let existingOffersState = {
    byExternalId: new Map(),
    duplicateGroups: [],
    plannedActions: [],
    skippedWithoutExternalId: []
  };
  let duplicateCleanupResult = null;

  if (CHECK_EXISTING_INPOST) {
    validateInpostEnv();
    console.log("Sprawdzam istniejace oferty w InPost, aby nie generowac duplikatow.");
    console.log(`Client ID: ${mask(process.env.CLIENT_ID)}`);
    console.log(`Organization ID: ${getOrganizationId()}`);
    existingItems = await fetchAllExistingOffers();
    existingOffersState = buildExistingOffersState(existingItems);

    if (CLEANUP_DUPLICATES && EXECUTE_CLEANUP) {
      duplicateCleanupResult = await executeDuplicateCleanup(
        existingOffersState.plannedActions
      );
    }
  }

  const offers = [];
  const offerImages = {};
  const skippedProducts = [];
  const blockingSkippedProducts = [];
  const productsWithoutImages = [];
  const unresolvedCategories = new Map();
  const generatedDescriptions = [];
  const existingInPostSkipped = [];
  const duplicateExternalIdsInCsv = [];
  const acceptedExternalIds = new Set();

  const categoryReport = {
    inputCsv: INPUT_CSV,
    categoryMapFile: CATEGORY_MAP_FILE,
    categoryOverridesFile: CATEGORY_OVERRIDES_FILE,
    categoryHintsFile: CATEGORY_HINTS_FILE,
    delimiter,
    settings: {
      STRICT_MODE,
      REQUIRE_IMAGE,
      ONLY_PUBLISHED,
      SKIP_OUT_OF_STOCK,
      INCLUDE_IMAGES_IN_OFFER_JSON,
      INCLUDE_META_IN_OFFERS,
      USE_NAME_AS_FALLBACK_DESCRIPTION,
      MIN_DESCRIPTION_LENGTH,
      CHECK_EXISTING_INPOST,
      CLEANUP_DUPLICATES,
      EXECUTE_CLEANUP,
      CLOSE_ONLY,
      mappingOrder: [
        "category-hints.json by EAN",
        "category-overrides.json by WooCommerce category",
        "skip"
      ]
    },
    byMethod: {},
    resolved: [],
    unresolved: []
  };

  for (const row of rows) {
    const externalId = normalizeText(row["Identyfikator"]);
    const name = normalizeText(row["Nazwa"]);

    const typeSkip = shouldSkipByProductType(row);

    if (typeSkip) {
      skippedProducts.push({
        externalId,
        name,
        type: typeSkip.type,
        errors: [typeSkip.reason]
      });
      continue;
    }

    if (ONLY_PUBLISHED && !isPublished(row)) {
      skippedProducts.push({
        externalId,
        name,
        errors: ["Produkt nieopublikowany"]
      });
      continue;
    }

    if (SKIP_OUT_OF_STOCK && getStockQuantity(row) <= 0) {
      skippedProducts.push({
        externalId,
        name,
        stock: getStockQuantity(row),
        errors: ["Pominięto produkt ze stanem 0"]
      });
      continue;
    }

    const {
      offer,
      images,
      skipped,
      categoryResolution,
      descriptionGenerated,
      descriptionOriginalLength,
      descriptionFinalLength
    } = buildOffer(
      row,
      categoryMap,
      categoryOverrides,
      categoryHints
    );

    updateCategoryReport(categoryReport, categoryResolution);

    if (descriptionGenerated) {
      generatedDescriptions.push({
        externalId,
        name,
        originalLength: descriptionOriginalLength,
        finalLength: descriptionFinalLength
      });
    }

    if (skipped?.errors?.includes("Brak zdjęcia w kolumnie Obrazki")) {
      productsWithoutImages.push({
        externalId,
        name,
        categories: splitWooCategories(row["Kategorie"])
      });
    }

    if (offer) {
      if (externalId && acceptedExternalIds.has(externalId)) {
        const duplicateRecord = {
          externalId,
          name,
          rowAction: "SKIPPED_DUPLICATE_EXTERNAL_ID_IN_CSV"
        };

        duplicateExternalIdsInCsv.push(duplicateRecord);
        skippedProducts.push({
          ...duplicateRecord,
          errors: ["Zdublowany externalId w CSV"]
        });
        continue;
      }

      if (externalId) {
        acceptedExternalIds.add(externalId);
      }

      const existingOffers = existingOffersState.byExternalId.get(externalId);

      if (existingOffers?.length) {
        existingInPostSkipped.push({
          externalId,
          name,
          ean: getEan(row),
          categoryId: offer.product?.categoryId || null,
          reason: "Oferta o tym externalId juz istnieje w InPost",
          existingOffers: existingOffers.map(summarizeExistingOffer)
        });
        continue;
      }

      offers.push(offer);

      if (externalId && images.length) {
        offerImages[externalId] = images;
      }
    }

    if (skipped) {
      skippedProducts.push(skipped);

      if (isBlockingSkippedProduct(skipped)) {
        blockingSkippedProducts.push(skipped);
      }

      if (!categoryResolution.categoryId) {
        for (const categoryPath of categoryResolution.allWooCategories || []) {
          unresolvedCategories.set(categoryPath, categoryPath);
        }
      }
    }
  }

  const cleanOffers = offers.map((offer) => JSON.parse(JSON.stringify(offer)));

  const generationReport = {
    inputCsv: INPUT_CSV,
    categoryMapFile: CATEGORY_MAP_FILE,
    categoryOverridesFile: CATEGORY_OVERRIDES_FILE,
    categoryHintsFile: CATEGORY_HINTS_FILE,
    outputDir: OUTPUT_DIR,
    delimiter,
    settings: categoryReport.settings,
    totals: {
      csvRows: rows.length,
      offersToCreate: cleanOffers.length,
      skippedProducts: skippedProducts.length,
      blockingSkippedProducts: blockingSkippedProducts.length,
      productsWithoutImages: productsWithoutImages.length,
      generatedDescriptions: generatedDescriptions.length,
      unresolvedCategories: unresolvedCategories.size,
      duplicateExternalIdsInCsv: duplicateExternalIdsInCsv.length,
      existingInPostSkipped: existingInPostSkipped.length,
      existingInPostItemsFetched: existingItems.length,
      existingDuplicateExternalIdGroups:
        existingOffersState.duplicateGroups.length,
      existingDuplicateCleanupPlanned:
        existingOffersState.plannedActions.length,
      duplicateCleanupSuccess:
        duplicateCleanupResult?.success?.length || 0,
      duplicateCleanupErrors:
        duplicateCleanupResult?.errors?.length || 0
    },
    categoryResolution: {
      byMethod: categoryReport.byMethod
    }
  };

  const generationErrors = {
    summary: generationReport.totals,
    skippedProducts,
    blockingSkippedProducts,
    productsWithoutImages,
    generatedDescriptions,
    unresolvedCategories: [...unresolvedCategories.keys()].sort(),
    duplicateExternalIdsInCsv,
    existingInPostSkipped,
    existingDuplicateGroups: existingOffersState.duplicateGroups,
    existingDuplicatePlannedActions: existingOffersState.plannedActions,
    existingOffersWithoutExternalId:
      existingOffersState.skippedWithoutExternalId.map(summarizeExistingOffer),
    duplicateCleanupResult
  };

  writeJson(path.join(OUTPUT_DIR, "inpost-offers.json"), cleanOffers);
  writeJson(path.join(OUTPUT_DIR, "offer-images.json"), offerImages);
  writeJson(path.join(OUTPUT_DIR, "csv-generation-report.json"), generationReport);
  writeJson(path.join(OUTPUT_DIR, "csv-generation-errors.json"), generationErrors);

  console.log("Generowanie plików zakończone.");
  console.log(`Wczytano produktów z CSV: ${rows.length}`);
  console.log(`Utworzono ofert: ${cleanOffers.length}`);
  console.log(`Pominięto produktów łącznie: ${skippedProducts.length}`);
  console.log(`Pominięto produktów z błędami krytycznymi: ${blockingSkippedProducts.length}`);
  console.log(`Produkty bez zdjęć: ${productsWithoutImages.length}`);
  console.log(`Opisy uzupelnione do minimum ${MIN_DESCRIPTION_LENGTH} znakow: ${generatedDescriptions.length}`);
  console.log(`Kategorie bez mapowania: ${unresolvedCategories.size}`);
  console.log("");

  logObjectCounts("Dopasowanie kategorii:", categoryReport.byMethod);

  console.log("");
  console.log(`Pliki wynikowe zapisano w katalogu: ${OUTPUT_DIR}`);
  console.log(`- ${path.join(OUTPUT_DIR, "inpost-offers.json")}`);
  console.log(`- ${path.join(OUTPUT_DIR, "offer-images.json")}`);
  console.log(`- ${path.join(OUTPUT_DIR, "csv-generation-report.json")}`);
  console.log(`- ${path.join(OUTPUT_DIR, "csv-generation-errors.json")}`);

  const criticalErrors = [];

  if (unresolvedCategories.size > 0) {
    criticalErrors.push(`Kategorie bez mapowania: ${unresolvedCategories.size}`);
  }

  if (blockingSkippedProducts.length > 0) {
    criticalErrors.push(`Produkty z błędami krytycznymi: ${blockingSkippedProducts.length}`);
  }

  if (STRICT_MODE && criticalErrors.length > 0) {
    console.log("");
    console.log("STRICT_MODE: wykryto błędy krytyczne. Nie wysyłaj jeszcze ofert do InPost.");

    for (const error of criticalErrors) {
      console.log(`- ${error}`);
    }

    console.log("");
    console.log("Najpierw sprawdź:");
    console.log(`- ${path.join(OUTPUT_DIR, "csv-generation-errors.json")}`);

    process.exit(1);
  }

  console.log("");
  console.log("OK: poprawne oferty są gotowe do wysyłki przez send-inpost-offers.js.");
}

main().catch((error) => {
  console.error("");
  console.error("Blad krytyczny:");
  console.error(error.response?.data || error.message);
  process.exit(1);
});
