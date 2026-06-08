#!/usr/bin/env node

/**
 * patch-inpost-categories-from-csv.js
 *
 * Naprawia kategorie istniejących ofert InPost Buy na podstawie pełnego CSV WooCommerce.
 *
 * Logika:
 * 1. Pobierz EAN z CSV.
 * 2. Jeśli EAN istnieje w category-hints.json → użyj categoryId z hintu.
 * 3. Jeśli nie ma hintu → sprawdź category-overrides.json po kategorii WooCommerce.
 * 4. Jeśli nie ma żadnego przypisania → skip.
 * 5. Pobierz oferty z InPost i dopasuj po externalId.
 * 6. Jeśli categoryId w InPost różni się od wyliczonego → PATCH.
 * 7. Jeśli categoryId jest już taki sam → zapisz jako alreadyCorrect.
 * 8. Jeśli oferta ma validationErrors CATEGORY_INCORRECT mimo poprawnej kategorii
 *    → zapisz do stale-category-errors.
 *
 * Użycie:
 *   node patch-inpost-categories-from-csv.js suppla-oferta.csv dist/category-hints.json category-overrides.json dist
 *
 * Tryb testowy:
 *   node patch-inpost-categories-from-csv.js suppla-oferta.csv dist/category-hints.json category-overrides.json dist --dry-run
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
const CATEGORY_HINTS_FILE = process.argv[3] || path.join("dist", "category-hints.json");
const CATEGORY_OVERRIDES_FILE = process.argv[4] || "category-overrides.json";
const OUTPUT_DIR = process.argv[5] || "dist";

const DRY_RUN = process.argv.includes("--dry-run");

const PATCH_CONTENT_TYPE =
  process.env.INPOST_PATCH_CONTENT_TYPE || "application/merge-patch+json";

const REQUEST_DELAY_MS = Number(process.env.INPOST_REQUEST_DELAY_MS || 150);
const PAGE_LIMIT = Number(process.env.INPOST_OFFERS_PAGE_LIMIT || 100);

const OBSOLETE_CATEGORY_REPAIR_REPORTS = [
  "category-repair-patched.json",
  "category-repair-already-correct.json",
  "category-repair-stale-category-errors.json",
  "category-repair-unchanged-after-patch.json",
  "category-repair-missing-existing.json",
  "category-repair-no-category-mapping.json",
  "category-repair-invalid-rows.json",
  "category-repair-duplicate-external-ids-in-csv.json",
  "category-repair-category-conflicts.json",
  "category-repair-duplicates-in-inpost.json",
  "category-repair-dry-run.json"
];

const REQUIRED_ENV = [
  "CLIENT_ID",
  "CLIENT_SECRET",
  "INPOST_SCOPE",
  "INPOST_TOKEN_URL",
  "INPOST_BUY_API_BASE",
  "ORGANIZATION_ID"
];

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

function removeFileIfExists(filePath) {
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function cleanupObsoleteReports(outputDir) {
  for (const fileName of OBSOLETE_CATEGORY_REPAIR_REPORTS) {
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

function isUuidLike(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    normalizeText(value)
  );
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

function getExternalId(row) {
  return normalizeText(row["Identyfikator"]);
}

function getName(row) {
  return normalizeText(row["Nazwa"]);
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

function sortCategoriesBySpecificity(categories) {
  return [...categories].sort((a, b) => {
    const depthDiff = categoryDepth(b) - categoryDepth(a);

    if (depthDiff !== 0) {
      return depthDiff;
    }

    return b.length - a.length;
  });
}

function extractCategoryId(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return normalizeText(value.categoryId || value.id || value.value || "");
  }

  return normalizeText(value);
}

function buildNormalizedOverridesMap(categoryOverrides) {
  const normalizedMap = {};

  for (const [wooCategoryPath, inpostCategoryValue] of Object.entries(categoryOverrides || {})) {
    normalizedMap[normalizeForCompare(wooCategoryPath)] = {
      originalPath: wooCategoryPath,
      categoryId: extractCategoryId(inpostCategoryValue)
    };
  }

  return normalizedMap;
}

function getHintCategory(row, categoryHints) {
  const ean = getEan(row);

  if (!ean) {
    return null;
  }

  const hint = categoryHints[ean];

  if (!hint) {
    return null;
  }

  const categoryId = extractCategoryId(hint);

  if (!categoryId || !isUuidLike(categoryId)) {
    return null;
  }

  return {
    categoryId,
    source: "category-hints",
    sourceDetail: `EAN: ${ean}`,
    ean
  };
}

function getOverrideCategory(row, categoryOverrides) {
  const categories = sortCategoriesBySpecificity(
    splitWooCategories(row["Kategorie"])
  );

  const normalizedOverridesMap = buildNormalizedOverridesMap(categoryOverrides);

  for (const wooCategory of categories) {
    if (Object.prototype.hasOwnProperty.call(categoryOverrides, wooCategory)) {
      const categoryId = extractCategoryId(categoryOverrides[wooCategory]);

      if (categoryId && isUuidLike(categoryId)) {
        return {
          categoryId,
          source: "category-overrides-exact",
          sourceDetail: wooCategory,
          matchedWooCategory: wooCategory,
          allWooCategories: categories
        };
      }
    }
  }

  for (const wooCategory of categories) {
    const normalizedWooCategory = normalizeForCompare(wooCategory);
    const match = normalizedOverridesMap[normalizedWooCategory];

    if (match?.categoryId && isUuidLike(match.categoryId)) {
      return {
        categoryId: match.categoryId,
        source: "category-overrides-normalized",
        sourceDetail: match.originalPath,
        matchedWooCategory: wooCategory,
        allWooCategories: categories
      };
    }
  }

  return null;
}

function resolveCategoryForRow(row, categoryHints, categoryOverrides) {
  const categories = splitWooCategories(row["Kategorie"]);

  const hintCategory = getHintCategory(row, categoryHints);

  if (hintCategory) {
    return {
      ...hintCategory,
      matchedWooCategory: null,
      allWooCategories: categories
    };
  }

  const overrideCategory = getOverrideCategory(row, categoryOverrides);

  if (overrideCategory) {
    return overrideCategory;
  }

  return {
    categoryId: null,
    source: null,
    sourceDetail: null,
    matchedWooCategory: null,
    allWooCategories: categories,
    ean: getEan(row)
  };
}

function getCategoryPriority(source) {
  if (source === "category-hints") return 2;
  if (source === "category-overrides-exact") return 1;
  if (source === "category-overrides-normalized") return 1;
  return 0;
}

function buildDesiredCategoriesFromCsv(rows, categoryHints, categoryOverrides) {
  const desiredByExternalId = new Map();

  const noCategoryMapping = [];
  const invalidRows = [];
  const duplicateExternalIdsInCsv = [];
  const categoryConflicts = [];

  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];

    const externalId = getExternalId(row);
    const name = getName(row);
    const ean = getEan(row);

    if (!externalId) {
      invalidRows.push({
        rowIndex: index,
        reason: "Brak Identyfikator w CSV",
        name,
        ean
      });

      continue;
    }

    const categoryResolution = resolveCategoryForRow(
      row,
      categoryHints,
      categoryOverrides
    );

    if (!categoryResolution.categoryId) {
      noCategoryMapping.push({
        rowIndex: index,
        externalId,
        name,
        ean,
        categories: categoryResolution.allWooCategories,
        reason: "Brak categoryId w category-hints.json i category-overrides.json"
      });

      continue;
    }

    const record = {
      externalId,
      name,
      ean,
      expectedCategoryId: categoryResolution.categoryId,
      source: categoryResolution.source,
      sourceDetail: categoryResolution.sourceDetail,
      matchedWooCategory: categoryResolution.matchedWooCategory,
      allWooCategories: categoryResolution.allWooCategories,
      rowIndexes: [index]
    };

    if (!desiredByExternalId.has(externalId)) {
      desiredByExternalId.set(externalId, record);
      continue;
    }

    const existing = desiredByExternalId.get(externalId);

    duplicateExternalIdsInCsv.push({
      externalId,
      existingCategoryId: existing.expectedCategoryId,
      newCategoryId: record.expectedCategoryId,
      existingSource: existing.source,
      newSource: record.source,
      existingName: existing.name,
      newName: record.name,
      rowIndex: index
    });

    existing.rowIndexes.push(index);

    if (existing.expectedCategoryId === record.expectedCategoryId) {
      continue;
    }

    categoryConflicts.push({
      externalId,
      existingCategoryId: existing.expectedCategoryId,
      newCategoryId: record.expectedCategoryId,
      existingSource: existing.source,
      newSource: record.source,
      existingSourceDetail: existing.sourceDetail,
      newSourceDetail: record.sourceDetail,
      rowIndex: index,
      action: "Wybrano kategorię z wyższym priorytetem; przy tym samym priorytecie pozostawiono pierwszą"
    });

    const existingPriority = getCategoryPriority(existing.source);
    const newPriority = getCategoryPriority(record.source);

    if (newPriority > existingPriority) {
      desiredByExternalId.set(externalId, record);
    }
  }

  return {
    desiredByExternalId,
    noCategoryMapping,
    invalidRows,
    duplicateExternalIdsInCsv,
    categoryConflicts
  };
}

function mask(value) {
  if (!value) return "";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function validateEnv() {
  for (const key of REQUIRED_ENV) {
    if (!process.env[key]) {
      throw new Error(`Brakuje zmiennej środowiskowej: ${key}`);
    }
  }
}

function getBaseUrl() {
  return process.env.INPOST_BUY_API_BASE.replace(/\/$/, "");
}

function getOrganizationId() {
  return process.env.ORGANIZATION_ID;
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

  const response = await axios({
    method,
    url: `${getBaseUrl()}${pathUrl}`,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Accept-Language": "pl",
      ...(options.contentType
        ? { "Content-Type": options.contentType }
        : {})
    },
    params: options.params,
    data: options.data,
    validateStatus: () => true
  });

  if (response.status >= 200 && response.status < 300) {
    return {
      ok: true,
      status: response.status,
      data: response.data
    };
  }

  return {
    ok: false,
    status: response.status,
    data: response.data
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

function extractOfferFromListItem(item) {
  return item?.offer || item;
}

function extractMetadataFromListItem(item) {
  return item?.metadata || item?.offer?.metadata || {};
}

function extractValidationErrorsFromMetadata(metadata) {
  if (Array.isArray(metadata?.validationErrors)) {
    return metadata.validationErrors;
  }

  if (Array.isArray(metadata?.errors)) {
    return metadata.errors;
  }

  return [];
}

function hasCategoryIncorrectValidationError(validationErrors) {
  return validationErrors.some((error) => {
    const code = normalizeText(
      error.validationCode ||
      error.errorCode ||
      error.code ||
      error.type ||
      ""
    );

    const message = normalizeText(
      error.validationMessage ||
      error.errorMessage ||
      error.message ||
      ""
    );

    return (
      code === "CATEGORY_INCORRECT" ||
      message.toLowerCase().includes("kategoria") ||
      message.toLowerCase().includes("category")
    );
  });
}

function getValidationErrorMessage(error) {
  return normalizeText(
    error?.validationMessage ||
    error?.errorMessage ||
    error?.message ||
    ""
  );
}

function extractReferenceCategoryFromValidationErrors(validationErrors) {
  for (const error of validationErrors || []) {
    const message = getValidationErrorMessage(error);

    if (!/(referencyj|reference categor)/i.test(message)) {
      continue;
    }

    const match = message.match(
      /(?:referencyj\w*|reference categor\w*)[\s\S]*?\(id:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/i
    );

    if (match?.[1] && isUuidLike(match[1])) {
      return {
        categoryId: normalizeText(match[1]),
        validationMessage: message
      };
    }
  }

  return null;
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
        `Nie udało się pobrać ofert z InPost. Status ${result.status}: ` +
        JSON.stringify(result.data)
      );
    }

    const items = getListItems(result.data);
    allItems.push(...items);

    total = getTotalFromResponse(result.data, allItems.length);

    console.log(
      `Pobrano oferty z InPost: ${allItems.length}${total !== null ? ` / ${total}` : ""}`
    );

    if (!items.length) {
      break;
    }

    offset += PAGE_LIMIT;

    if (total !== null && allItems.length >= total) {
      break;
    }

    await sleep(REQUEST_DELAY_MS);
  }

  return allItems;
}

function buildExistingOffersMap(existingItems) {
  const map = new Map();
  const duplicates = [];

  for (const item of existingItems) {
    const offer = extractOfferFromListItem(item);
    const metadata = extractMetadataFromListItem(item);
    const validationErrors = extractValidationErrorsFromMetadata(metadata);

    const externalId = normalizeText(offer?.externalId);
    const offerId = normalizeText(offer?.id);

    if (!externalId || !offerId) {
      continue;
    }

    if (!map.has(externalId)) {
      map.set(externalId, []);
    }

    map.get(externalId).push({
      offerId,
      externalId,
      status: offer.status || null,
      currentCategoryId: normalizeText(offer?.product?.categoryId),
      validationErrors,
      hasCategoryIncorrect: hasCategoryIncorrectValidationError(validationErrors),
      createdAt: offer.createdAt || null,
      updatedAt: offer.updatedAt || null,
      rawOffer: offer
    });
  }

  for (const [externalId, offers] of map.entries()) {
    if (offers.length > 1) {
      duplicates.push({
        externalId,
        count: offers.length,
        offerIds: offers.map((offer) => offer.offerId),
        statuses: offers.map((offer) => offer.status),
        categoryIds: offers.map((offer) => offer.currentCategoryId)
      });
    }
  }

  return {
    map,
    duplicates
  };
}

async function patchCategory(existingOffer, expectedCategoryId) {
  const organizationId = getOrganizationId();

  let productForPatch = existingOffer.rawOffer?.product || {};

  /**
   * Jeżeli lista ofert nie zwróciła pełnego product,
   * pobieramy szczegóły konkretnej oferty.
   */
  if (!normalizeText(productForPatch.name)) {
    const detailResult = await getOfferById(existingOffer.offerId);

    if (!detailResult.ok) {
      return {
        ok: false,
        status: detailResult.status,
        data: {
          errorCode: "LOCAL_CANNOT_FETCH_OFFER_DETAILS",
          errorMessage: "Nie udało się pobrać szczegółów oferty przed PATCH.",
          details: detailResult.data
        }
      };
    }

    const detailedOffer = extractOfferFromDetails(detailResult.data);
    productForPatch = detailedOffer?.product || {};
  }

  if (!normalizeText(productForPatch.name)) {
    return {
      ok: false,
      status: 0,
      data: {
        errorCode: "LOCAL_MISSING_PRODUCT_NAME",
        errorMessage:
          "Nie można wykonać PATCH, bo aktualna oferta nie zawiera product.name."
      }
    };
  }

  const patchBody = {
    product: {
      ...productForPatch,
      categoryId: expectedCategoryId
    }
  };

  return inpostRequest(
    "PATCH",
    `/v1/organizations/${encodeURIComponent(organizationId)}/offers/${encodeURIComponent(existingOffer.offerId)}`,
    {
      contentType: PATCH_CONTENT_TYPE,
      data: patchBody
    }
  );
}

async function getOfferById(offerId) {
  const organizationId = getOrganizationId();

  return inpostRequest(
    "GET",
    `/v1/organizations/${encodeURIComponent(organizationId)}/offers/${encodeURIComponent(offerId)}`
  );
}

function extractOfferFromDetails(data) {
  if (data?.offer) {
    return data.offer;
  }

  if (data?.data?.offer) {
    return data.data.offer;
  }

  if (data?.data && data.data.product) {
    return data.data;
  }

  return data;
}

function extractMetadataFromDetails(data) {
  if (data?.metadata) {
    return data.metadata;
  }

  if (data?.data?.metadata) {
    return data.data.metadata;
  }

  if (data?.offer?.metadata) {
    return data.offer.metadata;
  }

  if (data?.data?.offer?.metadata) {
    return data.data.offer.metadata;
  }

  return {};
}

function buildEffectiveDesiredRecord(desiredRecord, existingOffer) {
  const referenceCategory = extractReferenceCategoryFromValidationErrors(
    existingOffer.validationErrors
  );

  if (!referenceCategory?.categoryId) {
    return desiredRecord;
  }

  return {
    ...desiredRecord,
    csvExpectedCategoryId: desiredRecord.expectedCategoryId,
    csvCategorySource: desiredRecord.source,
    csvCategorySourceDetail: desiredRecord.sourceDetail,
    expectedCategoryId: referenceCategory.categoryId,
    source: "inpost-validation-reference",
    sourceDetail: "CATEGORY_INCORRECT reference category",
    inpostReferenceCategoryId: referenceCategory.categoryId,
    inpostReferenceValidationMessage: referenceCategory.validationMessage
  };
}

function buildBaseResultInfo(desiredRecord, existingOffer) {
  return {
    externalId: desiredRecord.externalId,
    name: desiredRecord.name,
    ean: desiredRecord.ean,
    offerId: existingOffer.offerId,
    status: existingOffer.status,
    categoryIdBefore: existingOffer.currentCategoryId,
    expectedCategoryId: desiredRecord.expectedCategoryId,
    csvExpectedCategoryId:
      desiredRecord.csvExpectedCategoryId || desiredRecord.expectedCategoryId,
    categorySource: desiredRecord.source,
    categorySourceDetail: desiredRecord.sourceDetail,
    csvCategorySource: desiredRecord.csvCategorySource || desiredRecord.source,
    csvCategorySourceDetail:
      desiredRecord.csvCategorySourceDetail || desiredRecord.sourceDetail,
    inpostReferenceCategoryId: desiredRecord.inpostReferenceCategoryId || null,
    inpostReferenceValidationMessage:
      desiredRecord.inpostReferenceValidationMessage || null,
    matchedWooCategory: desiredRecord.matchedWooCategory,
    allWooCategories: desiredRecord.allWooCategories,
    validationErrorsBefore: existingOffer.validationErrors,
    hadCategoryIncorrectBefore: existingOffer.hasCategoryIncorrect
  };
}

async function main() {
  validateEnv();
  ensureDir(OUTPUT_DIR);
  cleanupObsoleteReports(OUTPUT_DIR);

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

  const categoryHints = readJsonIfExists(CATEGORY_HINTS_FILE, {});
  const categoryOverrides = readJsonIfExists(CATEGORY_OVERRIDES_FILE, {});

  console.log("Start naprawy kategorii z pełnego CSV.");
  console.log(`CSV: ${INPUT_CSV}`);
  console.log(`category-hints: ${CATEGORY_HINTS_FILE}`);
  console.log(`category-overrides: ${CATEGORY_OVERRIDES_FILE}`);
  console.log(`Katalog raportów: ${OUTPUT_DIR}`);
  console.log(`Tryb testowy --dry-run: ${DRY_RUN ? "TAK" : "NIE"}`);
  console.log(`PATCH Content-Type: ${PATCH_CONTENT_TYPE}`);
  console.log(`Client ID: ${mask(process.env.CLIENT_ID)}`);
  console.log(`Organization ID: ${getOrganizationId()}`);
  console.log(`Wiersze CSV: ${rows.length}`);
  console.log("");

  const {
    desiredByExternalId,
    noCategoryMapping,
    invalidRows,
    duplicateExternalIdsInCsv,
    categoryConflicts
  } = buildDesiredCategoriesFromCsv(rows, categoryHints, categoryOverrides);

  console.log(`Produktów z wyliczonym categoryId: ${desiredByExternalId.size}`);
  console.log(`Produktów bez mapowania kategorii: ${noCategoryMapping.length}`);
  console.log(`Nieprawidłowe wiersze CSV: ${invalidRows.length}`);
  console.log(`Duplikaty externalId w CSV: ${duplicateExternalIdsInCsv.length}`);
  console.log(`Konflikty kategorii w CSV: ${categoryConflicts.length}`);
  console.log("");

  const existingItems = await fetchAllExistingOffers();

  const {
    map: existingOffersByExternalId,
    duplicates: duplicateExternalIdsInInPost
  } = buildExistingOffersMap(existingItems);

  console.log("");
  console.log(`Istniejące oferty pobrane z InPost: ${existingItems.length}`);
  console.log(`Unikalne externalId w InPost: ${existingOffersByExternalId.size}`);
  console.log(`Duplikaty externalId w InPost: ${duplicateExternalIdsInInPost.length}`);
  console.log("");

  const patched = [];
  const alreadyCorrect = [];
  const staleCategoryErrors = [];
  const unchangedAfterPatch = [];
  const readModelStaleAfterPatch = [];
  const inpostReferenceCategoryOverrides = [];
  const errors = [];
  const missingExistingOffers = [];
  const dryRunItems = [];

  const desiredRecords = [...desiredByExternalId.values()];

  for (let index = 0; index < desiredRecords.length; index++) {
    const desiredRecord = desiredRecords[index];

    console.log(
      `[${index + 1}/${desiredRecords.length}] externalId=${desiredRecord.externalId} expectedCategoryId=${desiredRecord.expectedCategoryId}`
    );

    const matches = existingOffersByExternalId.get(desiredRecord.externalId);

    if (!matches || matches.length === 0) {
      missingExistingOffers.push({
        externalId: desiredRecord.externalId,
        name: desiredRecord.name,
        ean: desiredRecord.ean,
        expectedCategoryId: desiredRecord.expectedCategoryId,
        categorySource: desiredRecord.source,
        reason: "Nie znaleziono istniejącej oferty w InPost po externalId"
      });

      continue;
    }

    for (const existingOffer of matches) {
      const baseInfo = buildBaseResultInfo(desiredRecord, existingOffer);

      if (existingOffer.currentCategoryId === desiredRecord.expectedCategoryId) {
        alreadyCorrect.push({
          ...baseInfo,
          result: "ALREADY_CORRECT"
        });

        if (existingOffer.hasCategoryIncorrect) {
          staleCategoryErrors.push({
            ...baseInfo,
            result: "STALE_CATEGORY_INCORRECT_ON_ALREADY_CORRECT",
            explanation:
              "Oferta ma już oczekiwany categoryId, ale nadal posiada validationErrors CATEGORY_INCORRECT."
          });
        }

        console.log(`  Już poprawna kategoria: offerId=${existingOffer.offerId}`);
        continue;
      }

      if (DRY_RUN) {
        dryRunItems.push({
          ...baseInfo,
          result: "DRY_RUN_WOULD_PATCH",
          patchBody: {
            product: {
           ...(existingOffer.rawOffer?.product || {}),
            categoryId: desiredRecord.expectedCategoryId
            }
          }
        });

        console.log(`  DRY RUN: PATCH offerId=${existingOffer.offerId}`);
        continue;
      }

      const patchResult = await patchCategory(
        existingOffer,
        desiredRecord.expectedCategoryId
      );

      if (!patchResult.ok) {
        errors.push({
          ...baseInfo,
          stage: "PATCH",
          status: patchResult.status,
          error: patchResult.data
        });

        console.log(`  BŁĄD PATCH: offerId=${existingOffer.offerId}, status=${patchResult.status}`);
        await sleep(REQUEST_DELAY_MS);
        continue;
      }

      await sleep(REQUEST_DELAY_MS);

      const verifyResult = await getOfferById(existingOffer.offerId);

      if (!verifyResult.ok) {
        errors.push({
          ...baseInfo,
          stage: "VERIFY_GET",
          patchStatus: patchResult.status,
          status: verifyResult.status,
          error: verifyResult.data
        });

        console.log(`  BŁĄD VERIFY GET: offerId=${existingOffer.offerId}, status=${verifyResult.status}`);
        await sleep(REQUEST_DELAY_MS);
        continue;
      }

      const verifiedOffer = extractOfferFromDetails(verifyResult.data);
      const verifiedMetadata = extractMetadataFromDetails(verifyResult.data);
      const validationErrorsAfter = extractValidationErrorsFromMetadata(verifiedMetadata);
      const hasCategoryIncorrectAfter =
        hasCategoryIncorrectValidationError(validationErrorsAfter);

      const categoryIdAfter = normalizeText(verifiedOffer?.product?.categoryId);
      const statusAfter = verifiedOffer?.status || null;

      if (categoryIdAfter === desiredRecord.expectedCategoryId) {
        const patchedRecord = {
          ...baseInfo,
          patchStatus: patchResult.status,
          categoryIdAfter,
          statusAfter,
          validationErrorsAfter,
          hasCategoryIncorrectAfter,
          result: "PATCHED_AND_VERIFIED"
        };

        patched.push(patchedRecord);

        if (existingOffer.hasCategoryIncorrect || hasCategoryIncorrectAfter) {
          staleCategoryErrors.push({
            ...patchedRecord,
            result: "STALE_CATEGORY_INCORRECT_AFTER_PATCH",
            explanation:
              "Kategoria została ustawiona na oczekiwaną, ale oferta miała lub nadal ma CATEGORY_INCORRECT."
          });
        }

        console.log(`  OK PATCH + VERIFY: offerId=${existingOffer.offerId}`);
      } else {
        unchangedAfterPatch.push({
          ...baseInfo,
          patchStatus: patchResult.status,
          categoryIdAfter,
          statusAfter,
          validationErrorsAfter,
          hasCategoryIncorrectAfter,
          patchResponse: patchResult.data,
          result: "PATCH_ACCEPTED_BUT_CATEGORY_NOT_CHANGED"
        });

        console.log(`  UWAGA: PATCH przyjęty, ale kategoria nie zmieniła się: offerId=${existingOffer.offerId}`);
      }

      await sleep(REQUEST_DELAY_MS);
    }
  }

  const byCategorySource = {};

  for (const record of desiredRecords) {
    const key = record.source || "unknown";

    byCategorySource[key] = (byCategorySource[key] || 0) + 1;
  }

  const report = {
    inputCsv: INPUT_CSV,
    categoryHintsFile: CATEGORY_HINTS_FILE,
    categoryOverridesFile: CATEGORY_OVERRIDES_FILE,
    dryRun: DRY_RUN,
    patchContentType: PATCH_CONTENT_TYPE,
    delimiter,
    totals: {
      csvRows: rows.length,
      desiredExternalIdsWithCategory: desiredByExternalId.size,
      noCategoryMapping: noCategoryMapping.length,
      invalidRows: invalidRows.length,
      duplicateExternalIdsInCsv: duplicateExternalIdsInCsv.length,
      categoryConflicts: categoryConflicts.length,
      existingItemsFetched: existingItems.length,
      uniqueExistingExternalIds: existingOffersByExternalId.size,
      duplicateExternalIdsInInPost: duplicateExternalIdsInInPost.length,
      patchedAndVerified: patched.length,
      alreadyCorrect: alreadyCorrect.length,
      staleCategoryErrors: staleCategoryErrors.length,
      unchangedAfterPatch: unchangedAfterPatch.length,
      errors: errors.length,
      missingExistingOffers: missingExistingOffers.length,
      dryRunItems: dryRunItems.length
    },
    byCategorySource
  };

  writeJson(path.join(OUTPUT_DIR, "category-repair-from-csv-report.json"), report);
  writeJson(path.join(OUTPUT_DIR, "category-repair-patched.json"), patched);
  writeJson(path.join(OUTPUT_DIR, "category-repair-already-correct.json"), alreadyCorrect);
  writeJson(path.join(OUTPUT_DIR, "category-repair-stale-category-errors.json"), staleCategoryErrors);
  writeJson(path.join(OUTPUT_DIR, "category-repair-unchanged-after-patch.json"), unchangedAfterPatch);
  writeJson(path.join(OUTPUT_DIR, "category-repair-errors.json"), errors);
  writeJson(path.join(OUTPUT_DIR, "category-repair-missing-existing.json"), missingExistingOffers);
  writeJson(path.join(OUTPUT_DIR, "category-repair-no-category-mapping.json"), noCategoryMapping);
  writeJson(path.join(OUTPUT_DIR, "category-repair-invalid-rows.json"), invalidRows);
  writeJson(path.join(OUTPUT_DIR, "category-repair-duplicate-external-ids-in-csv.json"), duplicateExternalIdsInCsv);
  writeJson(path.join(OUTPUT_DIR, "category-repair-category-conflicts.json"), categoryConflicts);
  writeJson(path.join(OUTPUT_DIR, "category-repair-duplicates-in-inpost.json"), duplicateExternalIdsInInPost);

  if (DRY_RUN) {
    writeJson(path.join(OUTPUT_DIR, "category-repair-dry-run.json"), dryRunItems);
  }

  console.log("");
  console.log("Zakończono naprawę kategorii z CSV.");
  console.log(`Wyliczone categoryId dla externalId: ${desiredByExternalId.size}`);
  console.log(`Brak mapowania kategorii: ${noCategoryMapping.length}`);
  console.log(`Zmienione i zweryfikowane: ${patched.length}`);
  console.log(`Już poprawne: ${alreadyCorrect.length}`);
  console.log(`Stale CATEGORY_INCORRECT mimo poprawnej kategorii: ${staleCategoryErrors.length}`);
  console.log(`PATCH przyjęty, ale kategoria niezmieniona: ${unchangedAfterPatch.length}`);
  console.log(`Błędy: ${errors.length}`);
  console.log(`Nie znaleziono istniejącej oferty: ${missingExistingOffers.length}`);
  console.log(`Duplikaty externalId w InPost: ${duplicateExternalIdsInInPost.length}`);
  console.log("");

  console.log("Raporty:");
  console.log(`- ${path.join(OUTPUT_DIR, "category-repair-from-csv-report.json")}`);
  console.log(`- ${path.join(OUTPUT_DIR, "category-repair-patched.json")}`);
  console.log(`- ${path.join(OUTPUT_DIR, "category-repair-already-correct.json")}`);
  console.log(`- ${path.join(OUTPUT_DIR, "category-repair-stale-category-errors.json")}`);
  console.log(`- ${path.join(OUTPUT_DIR, "category-repair-unchanged-after-patch.json")}`);
  console.log(`- ${path.join(OUTPUT_DIR, "category-repair-errors.json")}`);
  console.log(`- ${path.join(OUTPUT_DIR, "category-repair-no-category-mapping.json")}`);

  if (staleCategoryErrors.length > 0) {
    console.log("");
    console.log(
      "Ważne: część ofert ma poprawny categoryId, ale nadal posiada błąd CATEGORY_INCORRECT. " +
      "To może oznaczać, że walidacja InPost nie została odświeżona albo problem dotyczy duplikatu oferty."
    );
  }

  if (duplicateExternalIdsInInPost.length > 0) {
    console.log("");
    console.log(
      "Uwaga: w InPost są duplikaty externalId. Skrypt aktualizuje wszystkie znalezione oferty dla danego externalId."
    );
  }
}

main().catch((error) => {
  console.error("");
  console.error("Błąd krytyczny:");
  console.error(error.response?.data || error.message);
  process.exit(1);
});
