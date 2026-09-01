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
 * ofert dla externalId, ktore juz istnieja. Uzyj --include-existing, aby
 * wygenerowac pelny plik do synchronizacji roznic przez send-inpost-offers.js
 * --sync. Uzyj --offline, aby pominac sprawdzanie InPost.
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

const RESCUE_OVERRIDES = process.argv.includes("--rescue-overrides");
const VARIATIONS_ONLY = process.argv.includes("--variations-only");
const CHECK_EXISTING_INPOST =
  !process.argv.includes("--offline") && !RESCUE_OVERRIDES;
const INCLUDE_EXISTING_IN_OUTPUT =
  process.argv.includes("--include-existing") ||
  process.argv.includes("--sync-output") ||
  process.argv.includes("--full-sync");
const PRESERVE_EXISTING_CATEGORY =
  process.argv.includes("--preserve-existing-categories");
const CLEANUP_DUPLICATES = process.argv.includes("--cleanup-duplicates");
const EXECUTE_CLEANUP =
  process.argv.includes("--execute-cleanup") || process.argv.includes("--execute");
const CLOSE_ONLY = process.argv.includes("--close-only");

const REQUEST_DELAY_MS = Number(process.env.INPOST_REQUEST_DELAY_MS || 150);
const PAGE_LIMIT = Number(process.env.INPOST_OFFERS_PAGE_LIMIT || 100);
const OUTPUT_OFFERS_FILE = RESCUE_OVERRIDES
  ? "inpost-offers-rescue-overrides.json"
  : "inpost-offers.json";
const OUTPUT_IMAGES_FILE = RESCUE_OVERRIDES
  ? "offer-images-rescue-overrides.json"
  : "offer-images.json";
const OUTPUT_REPORT_FILE = RESCUE_OVERRIDES
  ? "rescue-overrides-report.json"
  : "csv-generation-report.json";
const OUTPUT_ERRORS_FILE = RESCUE_OVERRIDES
  ? "rescue-overrides-errors.json"
  : "csv-generation-errors.json";
const RESCUE_GENERATION_ERRORS_FILE =
  process.env.INPOST_RESCUE_GENERATION_ERRORS_FILE ||
  path.join(OUTPUT_DIR, "csv-generation-errors.json");
const RESCUE_SYNC_ERRORS_FILE =
  process.env.INPOST_RESCUE_SYNC_ERRORS_FILE ||
  path.join(OUTPUT_DIR, "send-sync-errors.json");
const DEFAULT_CATEGORY_TREE_FILES = [
  path.join(OUTPUT_DIR, "category-tree.json"),
  "inpost-health-categories.txt",
  "inpost.txt"
];

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

function getCategoryTreeFiles() {
  const configuredFile = normalizeText(process.env.INPOST_CATEGORY_TREE_FILE);

  if (configuredFile) {
    return [configuredFile];
  }

  return DEFAULT_CATEGORY_TREE_FILES.filter((filePath) => fs.existsSync(filePath));
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

function isUuidLike(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    normalizeText(value)
  );
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

function buildNonLeafCategoryIdSet(categoryMap) {
  const ids = new Set();

  for (const value of Object.values(categoryMap || {})) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      value.leaf === false
    ) {
      const categoryId = extractCategoryId(value);

      if (categoryId) {
        ids.add(categoryId);
      }
    }
  }

  return ids;
}

function addCategoryToIndex(node, parentPath, index) {
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    return;
  }

  const id = normalizeText(node.id || node.categoryId || node.value || "");
  const name = normalizeText(node.name || node.description || "");
  const categoryPath = [...parentPath, name].filter(Boolean).join(" > ");

  if (id) {
    index.set(id, {
      id,
      name,
      path: categoryPath,
      leaf: node.leaf === true,
      hasLeafFlag: typeof node.leaf === "boolean",
      childrenCount: Array.isArray(node.children) ? node.children.length : 0
    });
  }

  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      addCategoryToIndex(child, [...parentPath, name].filter(Boolean), index);
    }
  }
}

function getCategoryTreeRoots(categoryTree) {
  if (!categoryTree) {
    return [];
  }

  if (Array.isArray(categoryTree)) {
    return categoryTree.flatMap(getCategoryTreeRoots);
  }

  if (categoryTree.data) {
    return getCategoryTreeRoots(categoryTree.data);
  }

  if (
    typeof categoryTree === "object" &&
    (
      categoryTree.id ||
      categoryTree.categoryId ||
      Array.isArray(categoryTree.children)
    )
  ) {
    return [categoryTree];
  }

  return [];
}

function buildCategoryTreeIndex(categoryTrees) {
  const index = new Map();

  for (const root of getCategoryTreeRoots(categoryTrees)) {
    addCategoryToIndex(root, [], index);
  }

  return index;
}

function summarizeCategoryTreeIndex(categoryTreeIndex) {
  let leafCategories = 0;
  let nonLeafCategories = 0;

  for (const category of categoryTreeIndex.values()) {
    if (category.leaf) {
      leafCategories++;
    } else {
      nonLeafCategories++;
    }
  }

  return {
    totalCategories: categoryTreeIndex.size,
    leafCategories,
    nonLeafCategories
  };
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

const RESERVED_CATEGORY_OVERRIDE_KEYS = new Set(["byExternalId", "byEan"]);

function getCategoryPathOverrides(categoryOverrides) {
  return Object.fromEntries(
    Object.entries(categoryOverrides || {}).filter(
      ([key]) => !RESERVED_CATEGORY_OVERRIDE_KEYS.has(key)
    )
  );
}

function buildNormalizedOverridesMap(categoryOverrides) {
  const normalizedMap = {};
  const duplicates = [];

  for (const [wooCategoryPath, inpostCategoryValue] of Object.entries(
    getCategoryPathOverrides(categoryOverrides)
  )) {
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

function getProductCategoryOverride(row, categoryOverrides, categoryMap, normalizedCategoryMap) {
  const externalId = normalizeText(row["Identyfikator"]);
  const ean = getEan(row);
  const byExternalId = categoryOverrides?.byExternalId || {};
  const byEan = categoryOverrides?.byEan || {};
  let value = null;
  let matchedBy = null;

  if (externalId && Object.prototype.hasOwnProperty.call(byExternalId, externalId)) {
    value = byExternalId[externalId];
    matchedBy = "override-product-external-id";
  } else if (ean && Object.prototype.hasOwnProperty.call(byEan, ean)) {
    value = byEan[ean];
    matchedBy = "override-product-ean";
  }

  if (value === null) return null;

  const resolved = resolveOverrideValue(value, categoryMap, normalizedCategoryMap);
  return resolved?.categoryId ? { ...resolved, matchedBy } : null;
}

function validateCategoryOverrides(categoryOverrides, categoryMap) {
  const normalizedCategoryMap = buildNormalizedCategoryMap(categoryMap);
  const { duplicates } = buildNormalizedOverridesMap(categoryOverrides);
  const validCategoryIds = buildCategoryIdSet(categoryMap);
  const nonLeafCategoryIds = buildNonLeafCategoryIdSet(categoryMap);
  const shouldValidateIds = validCategoryIds.size > 0;
  const invalidOverrides = [];

  for (const duplicate of duplicates) {
    invalidOverrides.push({
      error: "Zdublowana kategoria WooCommerce po normalizacji",
      ...duplicate
    });
  }

  for (const [wooCategory, inpostCategoryValue] of Object.entries(
    getCategoryPathOverrides(categoryOverrides)
  )) {
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
    if (nonLeafCategoryIds.has(resolved.categoryId)) {
      invalidOverrides.push({
        wooCategory,
        inpostCategoryValue,
        resolvedCategoryId: resolved.categoryId,
        error: "ID kategorii InPost wskazuje kategorie niebedaca lisciem (leaf: false)"
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

function getHintCategoryDecision(row, categoryHints, categoryTreeIndex = new Map()) {
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

  const warnings = [];
  const category = categoryTreeIndex.get(categoryId) || null;

  if (categoryTreeIndex.size > 0) {
    if (!category) {
      warnings.push("hint-category-id-not-in-category-tree");
    } else if (!category.leaf) {
      warnings.push("hint-category-is-not-leaf");
    }
  }

  return {
    ean,
    categoryId,
    valid: true,
    warnings,
    categoryPath: category?.path || null,
    categoryName: category?.name || null,
    categoryLeaf: category?.leaf ?? null,
    validatedWithCategoryTree: categoryTreeIndex.size > 0
  };
}

function buildHintWarning(row, hint, categories) {
  return {
    externalId: normalizeText(row["Identyfikator"]),
    name: normalizeText(row["Nazwa"]),
    ean: hint.ean,
    categoryId: hint.categoryId,
    categoryPath: hint.categoryPath,
    categoryName: hint.categoryName,
    categoryLeaf: hint.categoryLeaf,
    wooCategories: categories,
    warnings: hint.warnings
  };
}

function resolveCategoryId(
  row,
  categoryMap,
  categoryOverrides,
  categoryHints,
  categoryTreeIndex = new Map(),
  referenceCategoryDecision = null
) {
  const normalizedCategoryMap = buildNormalizedCategoryMap(categoryMap);
  const { normalizedMap: normalizedOverridesMap } = buildNormalizedOverridesMap(categoryOverrides);

  const categories = splitWooCategories(row["Kategorie"]);
  const productOverride = getProductCategoryOverride(
    row,
    categoryOverrides,
    categoryMap,
    normalizedCategoryMap
  );

  if (productOverride?.categoryId) {
    return {
      categoryId: productOverride.categoryId,
      matchedBy: productOverride.matchedBy,
      matchedWooCategory: null,
      matchedInpostCategory: productOverride.resolvedFrom,
      allWooCategories: categories,
      rejectedHints: [],
      hintWarnings: []
    };
  }

  const sortedCategories = [...categories].sort((a, b) => {
    const depthDiff = categoryDepth(b) - categoryDepth(a);

    if (depthDiff !== 0) {
      return depthDiff;
    }

    return b.length - a.length;
  });

  if (referenceCategoryDecision?.categoryId) {
    return {
      categoryId: referenceCategoryDecision.categoryId,
      matchedBy: "inpost-validation-reference",
      matchedWooCategory: null,
      matchedInpostCategory: referenceCategoryDecision.validationMessage || "InPost validation reference",
      allWooCategories: categories,
      rejectedHints: []
    };
  }

  const hint = getHintCategoryDecision(row, categoryHints, categoryTreeIndex);

  if (hint?.categoryId) {
    return {
      categoryId: hint.categoryId,
      matchedBy: hint.warnings?.length
        ? "inpost-hint-ean-with-local-warning"
        : "inpost-hint-ean",
      matchedWooCategory: null,
      matchedInpostCategory: hint.categoryPath || `EAN hint: ${hint.ean}`,
      allWooCategories: categories,
      rejectedHints: [],
      hintWarnings: hint.warnings?.length
        ? [buildHintWarning(row, hint, categories)]
        : []
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
          allWooCategories: categories,
          rejectedHints: [],
          hintWarnings: []
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
          allWooCategories: categories,
          rejectedHints: [],
          hintWarnings: []
        };
      }
    }
  }

  return {
    categoryId: null,
    matchedBy: null,
    matchedWooCategory: null,
    matchedInpostCategory: null,
    allWooCategories: categories,
    rejectedHints: [],
    hintWarnings: []
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
  const referenceCategory = extractReferenceCategoryFromValidationErrors(
    validationErrors
  );

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
    hasCategoryIncorrect: hasCategoryIncorrect(validationErrors),
    referenceCategory
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
    referenceCategoryId: offer.referenceCategory?.categoryId || null,
    referenceCategoryMessage: offer.referenceCategory?.validationMessage || null,
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

function getReferenceCategoryDecision(existingOffers) {
  const offersWithReference = (existingOffers || [])
    .filter((offer) => offer.referenceCategory?.categoryId)
    .sort((a, b) => b.score - a.score);

  if (!offersWithReference.length) {
    return null;
  }

  const uniqueCategoryIds = [
    ...new Set(
      offersWithReference.map((offer) => offer.referenceCategory.categoryId)
    )
  ];
  const selectedOffer = offersWithReference[0];

  return {
    categoryId: selectedOffer.referenceCategory.categoryId,
    validationMessage: selectedOffer.referenceCategory.validationMessage,
    selectedOffer: summarizeExistingOffer(selectedOffer),
    conflictCategoryIds: uniqueCategoryIds.length > 1 ? uniqueCategoryIds : []
  };
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

function buildOffer(
  row,
  categoryMap,
  categoryOverrides,
  categoryHints,
  categoryTreeIndex,
  referenceCategoryDecision
) {
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
    categoryHints,
    categoryTreeIndex,
    referenceCategoryDecision
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
          matchedInpostCategory: categoryResult.matchedInpostCategory,
          rejectedHints: categoryResult.rejectedHints || []
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
    "Pominięto produkt nadrzędny wariantów",
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
      matchedInpostCategory: categoryResolution.matchedInpostCategory,
      rejectedHints: categoryResolution.rejectedHints || [],
      hintWarnings: categoryResolution.hintWarnings || []
    });
  } else {
    report.unresolved.push({
      categories: categoryResolution.allWooCategories || [],
      rejectedHints: categoryResolution.rejectedHints || [],
      hintWarnings: categoryResolution.hintWarnings || []
    });
  }

  for (const rejectedHint of categoryResolution.rejectedHints || []) {
    report.rejectedHints.push(rejectedHint);

    for (const reason of rejectedHint.reasons || []) {
      if (!report.rejectedHintReasons[reason]) {
        report.rejectedHintReasons[reason] = 0;
      }

      report.rejectedHintReasons[reason]++;
    }
  }

  for (const hintWarning of categoryResolution.hintWarnings || []) {
    report.hintWarnings.push(hintWarning);

    for (const warning of hintWarning.warnings || []) {
      if (!report.hintWarningReasons[warning]) {
        report.hintWarningReasons[warning] = 0;
      }

      report.hintWarningReasons[warning]++;
    }
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

const VARIATION_INHERITED_FIELDS = [
  "Krótki opis",
  "Opis",
  "Kategorie",
  "Marki",
  "Obrazki",
  "Status podatku",
  "Klasa podatkowa",
  "Stawka podatku",
  "VAT",
  "Podatek",
  "Tax rate",
  "Waga (kg)",
  "Długość (cm)",
  "Szerokość (cm)",
  "Wysokość (cm)",
  "Kod producenta",
  "MPN",
  "Numer katalogowy",
  "Adres URL",
  "URL",
  "Permalink",
  "Zewnętrzny adres URL"
];

function getProductType(row) {
  return normalizeText(row["Rodzaj"]).toLowerCase();
}

function buildRowsByExternalId(rows) {
  const rowsByExternalId = new Map();

  for (const row of rows) {
    const externalId = normalizeText(row["Identyfikator"]);

    if (externalId && !rowsByExternalId.has(externalId)) {
      rowsByExternalId.set(externalId, row);
    }
  }

  return rowsByExternalId;
}

function getVariationParentExternalId(row) {
  const parentReference = normalizeText(row["Nadrzędny"]);

  if (!parentReference) {
    return "";
  }

  return normalizeText(parentReference.replace(/^id\s*:/i, ""));
}

function buildEffectiveVariationRow(variationRow, parentRow) {
  const effectiveRow = { ...variationRow };

  for (const field of VARIATION_INHERITED_FIELDS) {
    if (!normalizeText(effectiveRow[field]) && normalizeText(parentRow[field])) {
      effectiveRow[field] = parentRow[field];
    }
  }

  return effectiveRow;
}

function shouldSkipByProductType(row) {
  const productType = getProductType(row);

  if (!productType || productType === "simple" || productType === "variation") {
    return null;
  }

  if (productType === "variable") {
    return {
      type: productType,
      reason: "Pominięto produkt nadrzędny wariantów"
    };
  }

  return {
    type: productType,
    reason: "Nieobsługiwany rodzaj produktu: " + productType
  };
}

function getOrCreateRescueCandidate(candidates, externalId) {
  const cleanExternalId = normalizeText(externalId);

  if (!cleanExternalId) {
    return null;
  }

  if (!candidates.has(cleanExternalId)) {
    candidates.set(cleanExternalId, {
      externalId: cleanExternalId,
      sources: [],
      rejectedCategoryIds: new Set(),
      rejectedHintCategoryIds: new Set(),
      rejectedSyncCategoryIds: new Set()
    });
  }

  return candidates.get(cleanExternalId);
}

function addRescueSource(candidate, source) {
  if (!candidate || !source) {
    return;
  }

  candidate.sources.push(source);

  for (const categoryId of source.rejectedCategoryIds || []) {
    const cleanCategoryId = normalizeText(categoryId);

    if (!cleanCategoryId) {
      continue;
    }

    candidate.rejectedCategoryIds.add(cleanCategoryId);

    if (source.type === "rejected-category-hint") {
      candidate.rejectedHintCategoryIds.add(cleanCategoryId);
    }

    if (source.type === "sync-category-incorrect") {
      candidate.rejectedSyncCategoryIds.add(cleanCategoryId);
    }
  }
}

function getSyncErrorValidationErrors(errorRecord) {
  return [
    ...(errorRecord?.error?.validationErrors || []),
    ...(errorRecord?.postWriteValidation?.validationErrors || []),
    ...(errorRecord?.postWriteValidationAfterRepair?.validationErrors || [])
  ];
}

function getSyncErrorCategoryId(errorRecord) {
  return getFirstNonEmpty(
    errorRecord?.postWriteValidation?.categoryId,
    errorRecord?.postWriteValidationAfterRepair?.categoryId,
    errorRecord?.patchBody?.product?.categoryId,
    errorRecord?.patchResponse?.data?.offer?.product?.categoryId,
    errorRecord?.error?.categoryId
  );
}

function collectRescueCandidates() {
  const candidates = new Map();
  const summary = {
    generationErrorsFile: RESCUE_GENERATION_ERRORS_FILE,
    syncErrorsFile: RESCUE_SYNC_ERRORS_FILE,
    rejectedHintProducts: 0,
    syncCategoryIncorrectProducts: 0
  };

  const generationErrors = readJsonIfExists(RESCUE_GENERATION_ERRORS_FILE, {});

  for (const rejectedHint of generationErrors.rejectedCategoryHints || []) {
    const candidate = getOrCreateRescueCandidate(
      candidates,
      rejectedHint.externalId
    );

    if (!candidate) {
      continue;
    }

    addRescueSource(candidate, {
      type: "rejected-category-hint",
      ean: rejectedHint.ean || null,
      rejectedCategoryIds: [rejectedHint.categoryId].filter(Boolean),
      reasons: rejectedHint.reasons || [],
      wooCategories: rejectedHint.wooCategories || []
    });
  }

  summary.rejectedHintProducts = candidates.size;

  const syncErrors = readJsonIfExists(RESCUE_SYNC_ERRORS_FILE, {});
  const categoryIncorrectExternalIds = new Set();

  for (const errorRecord of syncErrors.errors || []) {
    const validationErrors = getSyncErrorValidationErrors(errorRecord);

    if (!hasCategoryIncorrect(validationErrors)) {
      continue;
    }

    const candidate = getOrCreateRescueCandidate(
      candidates,
      errorRecord.externalId
    );

    if (!candidate) {
      continue;
    }

    categoryIncorrectExternalIds.add(candidate.externalId);
    addRescueSource(candidate, {
      type: "sync-category-incorrect",
      offerId: normalizeText(errorRecord.offerId) || null,
      rejectedCategoryIds: [getSyncErrorCategoryId(errorRecord)].filter(Boolean),
      validationErrors: validationErrors.map((error) => ({
        validationCode: normalizeText(error.validationCode || error.code || ""),
        validationMessage: getValidationErrorMessage(error)
      }))
    });
  }

  summary.syncCategoryIncorrectProducts = categoryIncorrectExternalIds.size;

  return {
    candidates,
    summary
  };
}

function serializeRescueCandidate(candidate) {
  if (!candidate) {
    return null;
  }

  return {
    externalId: candidate.externalId,
    sources: candidate.sources,
    rejectedCategoryIds: [...candidate.rejectedCategoryIds].sort(),
    rejectedHintCategoryIds: [...candidate.rejectedHintCategoryIds].sort(),
    rejectedSyncCategoryIds: [...candidate.rejectedSyncCategoryIds].sort()
  };
}

async function main() {
  ensureDir(OUTPUT_DIR);
  cleanupObsoleteGenerationFiles(OUTPUT_DIR);

  const csvContent = readFileUtf8(INPUT_CSV);
  const categoryMap = readJsonIfExists(CATEGORY_MAP_FILE, {});
  const categoryOverrides = readJsonIfExists(CATEGORY_OVERRIDES_FILE, {});
  const categoryHints = readJsonIfExists(CATEGORY_HINTS_FILE, {});
  const categoryTreeFiles = getCategoryTreeFiles();
  const categoryTrees = categoryTreeFiles.map((filePath) =>
    readJsonIfExists(filePath, null)
  );
  const categoryTreeIndex = buildCategoryTreeIndex(categoryTrees);
  const categoryTreeSummary = summarizeCategoryTreeIndex(categoryTreeIndex);

  const invalidOverrides = validateCategoryOverrides(categoryOverrides, categoryMap);

  if (invalidOverrides.length) {
    writeJson(
      path.join(OUTPUT_DIR, OUTPUT_ERRORS_FILE),
      {
        summary: {
          invalidCategoryOverrides: invalidOverrides.length
        },
        invalidCategoryOverrides: invalidOverrides
      }
    );

    throw new Error(
      `category-overrides.json zawiera błędne mapowania: ${invalidOverrides.length}. ` +
      `Sprawdz ${path.join(OUTPUT_DIR, OUTPUT_ERRORS_FILE)}`
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
  const rowsByExternalId = buildRowsByExternalId(rows);
  const rescue = RESCUE_OVERRIDES
    ? collectRescueCandidates()
    : {
        candidates: new Map(),
        summary: null
      };

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
  const inpostReferenceCategoryOverrides = [];
  const inpostCurrentCategoryPreserved = [];
  const duplicateExternalIdsInCsv = [];
  const acceptedExternalIds = new Set();
  const rescueSkippedSameRejectedCategory = [];
  const variationStats = {
    variationRows: 0,
    resolvedParentRows: 0,
    missingParentRows: 0,
    generatedOffers: 0,
    variableParentRowsSkipped: 0
  };

  const categoryReport = {
    inputCsv: INPUT_CSV,
    categoryMapFile: CATEGORY_MAP_FILE,
    categoryOverridesFile: CATEGORY_OVERRIDES_FILE,
    categoryHintsFile: CATEGORY_HINTS_FILE,
    categoryTreeFiles,
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
      INCLUDE_EXISTING_IN_OUTPUT,
      PRESERVE_EXISTING_CATEGORY,
      CLEANUP_DUPLICATES,
      EXECUTE_CLEANUP,
      CLOSE_ONLY,
      RESCUE_OVERRIDES,
      INCLUDE_VARIATIONS: true,
      VARIATIONS_ONLY,
      mappingOrder: RESCUE_OVERRIDES
        ? [
            "category-overrides.json by WooCommerce category for rescue candidates only",
            "skip"
          ]
        : [
            "category-hints.json by EAN from InPost /offers/hint",
            "category-overrides.json by WooCommerce category",
            "skip"
          ]
    },
    rescue: rescue.summary,
    categoryTree: categoryTreeSummary,
    byMethod: {},
    resolved: [],
    unresolved: [],
    rejectedHints: [],
    rejectedHintReasons: {},
    hintWarnings: [],
    hintWarningReasons: {}
  };

  for (const sourceRow of rows) {
    const sourceExternalId = normalizeText(sourceRow["Identyfikator"]);
    const sourceName = normalizeText(sourceRow["Nazwa"]);
    const productType = getProductType(sourceRow);

    if (VARIATIONS_ONLY && productType !== "variation") {
      continue;
    }

    const rescueCandidate = RESCUE_OVERRIDES
      ? rescue.candidates.get(sourceExternalId)
      : null;

    if (RESCUE_OVERRIDES && !rescueCandidate) {
      continue;
    }

    const typeSkip = shouldSkipByProductType(sourceRow);

    if (typeSkip) {
      if (typeSkip.type === "variable") {
        variationStats.variableParentRowsSkipped += 1;
      }

      skippedProducts.push({
        externalId: sourceExternalId,
        name: sourceName,
        type: typeSkip.type,
        errors: [typeSkip.reason]
      });
      continue;
    }

    let row = sourceRow;

    if (productType === "variation") {
      variationStats.variationRows += 1;
      const variationParentExternalId = getVariationParentExternalId(sourceRow);
      const parentRow = rowsByExternalId.get(variationParentExternalId);

      if (!parentRow || getProductType(parentRow) !== "variable") {
        const missingParentRecord = {
          externalId: sourceExternalId,
          name: sourceName,
          type: productType,
          parentExternalId: variationParentExternalId || null,
          errors: ["Nie znaleziono produktu nadrzędnego dla wariantu"]
        };

        variationStats.missingParentRows += 1;
        skippedProducts.push(missingParentRecord);
        blockingSkippedProducts.push(missingParentRecord);
        continue;
      }

      row = buildEffectiveVariationRow(sourceRow, parentRow);
      variationStats.resolvedParentRows += 1;
    }

    const externalId = normalizeText(row["Identyfikator"]);
    const name = normalizeText(row["Nazwa"]);

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

    const existingOffersForExternalId =
      existingOffersState.byExternalId.get(externalId);
    const referenceCategoryDecision = getReferenceCategoryDecision(
      existingOffersForExternalId
    );

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
      RESCUE_OVERRIDES ? {} : categoryHints,
      categoryTreeIndex,
      RESCUE_OVERRIDES ? null : referenceCategoryDecision
    );

    if (
      RESCUE_OVERRIDES &&
      categoryResolution.categoryId &&
      rescueCandidate?.rejectedCategoryIds.has(categoryResolution.categoryId)
    ) {
      const rescueSkipped = {
        externalId,
        name,
        sku: getSku(row),
        ean: getEan(row),
        categoryId: categoryResolution.categoryId,
        matchedBy: categoryResolution.matchedBy,
        matchedWooCategory: categoryResolution.matchedWooCategory,
        matchedInpostCategory: categoryResolution.matchedInpostCategory,
        rescueCandidate: serializeRescueCandidate(rescueCandidate),
        errors: [
          "Rescue override wskazuje te sama kategorie, ktora byla juz odrzucona"
        ]
      };

      rescueSkippedSameRejectedCategory.push(rescueSkipped);
      skippedProducts.push(rescueSkipped);
      continue;
    }

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

      const existingOffers = existingOffersForExternalId;

      if (existingOffers?.length) {
        if (
          referenceCategoryDecision?.categoryId &&
          offer.product?.categoryId !== referenceCategoryDecision.categoryId
        ) {
          inpostReferenceCategoryOverrides.push({
            externalId,
            name,
            ean: getEan(row),
            csvCategoryId: offer.product?.categoryId || null,
            inpostReferenceCategoryId: referenceCategoryDecision.categoryId,
            inpostReferenceValidationMessage:
              referenceCategoryDecision.validationMessage,
            selectedExistingOffer: referenceCategoryDecision.selectedOffer,
            conflictCategoryIds: referenceCategoryDecision.conflictCategoryIds
          });

          offer.product.categoryId = referenceCategoryDecision.categoryId;
        } else if (
          INCLUDE_EXISTING_IN_OUTPUT &&
          PRESERVE_EXISTING_CATEGORY
        ) {
          const currentCategoryOffer = chooseKeeper(existingOffers);
          const currentCategoryId = currentCategoryOffer?.categoryId;

          if (
            currentCategoryId &&
            offer.product?.categoryId !== currentCategoryId
          ) {
            inpostCurrentCategoryPreserved.push({
              externalId,
              name,
              ean: getEan(row),
              csvCategoryId: offer.product?.categoryId || null,
              preservedInpostCategoryId: currentCategoryId,
              selectedExistingOffer: summarizeExistingOffer(currentCategoryOffer)
            });

            offer.product.categoryId = currentCategoryId;
          }
        }

        existingInPostSkipped.push({
          externalId,
          name,
          ean: getEan(row),
          categoryId: offer.product?.categoryId || null,
          categorySource: referenceCategoryDecision?.categoryId
            ? "inpost-validation-reference"
            : categoryResolution.matchedBy,
          reason: INCLUDE_EXISTING_IN_OUTPUT
            ? "Oferta o tym externalId juz istnieje w InPost; zostala dodana do pliku sync"
            : "Oferta o tym externalId juz istnieje w InPost",
          existingOffers: existingOffers.map(summarizeExistingOffer)
        });

        if (!INCLUDE_EXISTING_IN_OUTPUT) {
          continue;
        }
      }

      offers.push(offer);

      if (productType === "variation") {
        variationStats.generatedOffers += 1;
      }

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
    categoryTreeFiles,
    outputDir: OUTPUT_DIR,
    delimiter,
    settings: categoryReport.settings,
    rescue: categoryReport.rescue,
    categoryTree: categoryReport.categoryTree,
    totals: {
      csvRows: rows.length,
      variationRows: variationStats.variationRows,
      variationParentRowsResolved: variationStats.resolvedParentRows,
      variationParentRowsMissing: variationStats.missingParentRows,
      variationOffersGenerated: variationStats.generatedOffers,
      variationRowsSkipped:
        variationStats.variationRows - variationStats.generatedOffers,
      variableParentRowsSkipped: variationStats.variableParentRowsSkipped,
      rescueCandidates: RESCUE_OVERRIDES ? rescue.candidates.size : 0,
      rescueSkippedSameRejectedCategory:
        rescueSkippedSameRejectedCategory.length,
      offersToCreate: cleanOffers.length,
      skippedProducts: skippedProducts.length,
      blockingSkippedProducts: blockingSkippedProducts.length,
      productsWithoutImages: productsWithoutImages.length,
      generatedDescriptions: generatedDescriptions.length,
      unresolvedCategories: unresolvedCategories.size,
      rejectedCategoryHints: categoryReport.rejectedHints.length,
      hintCategoryWarnings: categoryReport.hintWarnings.length,
      duplicateExternalIdsInCsv: duplicateExternalIdsInCsv.length,
      existingInPostSkipped: existingInPostSkipped.length,
      existingInPostIncludedInOutput: INCLUDE_EXISTING_IN_OUTPUT
        ? existingInPostSkipped.length
        : 0,
      inpostReferenceCategoryOverrides:
        inpostReferenceCategoryOverrides.length,
      inpostCurrentCategoryPreserved: inpostCurrentCategoryPreserved.length,
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
      byMethod: categoryReport.byMethod,
      rejectedHintReasons: categoryReport.rejectedHintReasons,
      hintWarningReasons: categoryReport.hintWarningReasons
    }
  };

  const generationErrors = {
    summary: generationReport.totals,
    skippedProducts,
    blockingSkippedProducts,
    productsWithoutImages,
    generatedDescriptions,
    unresolvedCategories: [...unresolvedCategories.keys()].sort(),
    rejectedCategoryHints: categoryReport.rejectedHints,
    hintCategoryWarnings: categoryReport.hintWarnings,
    duplicateExternalIdsInCsv,
    existingInPostSkipped,
    inpostReferenceCategoryOverrides,
    inpostCurrentCategoryPreserved,
    rescueSkippedSameRejectedCategory,
    existingDuplicateGroups: existingOffersState.duplicateGroups,
    existingDuplicatePlannedActions: existingOffersState.plannedActions,
    existingOffersWithoutExternalId:
      existingOffersState.skippedWithoutExternalId.map(summarizeExistingOffer),
    duplicateCleanupResult
  };

  writeJson(path.join(OUTPUT_DIR, OUTPUT_OFFERS_FILE), cleanOffers);
  writeJson(path.join(OUTPUT_DIR, OUTPUT_IMAGES_FILE), offerImages);
  writeJson(path.join(OUTPUT_DIR, OUTPUT_REPORT_FILE), generationReport);
  writeJson(path.join(OUTPUT_DIR, OUTPUT_ERRORS_FILE), generationErrors);

  console.log("Generowanie plików zakończone.");
  console.log(`Wczytano produktów z CSV: ${rows.length}`);
  console.log(`Utworzono ofert: ${cleanOffers.length}`);
  console.log(`Pominięto produktów łącznie: ${skippedProducts.length}`);
  console.log(`Pominięto produktów z błędami krytycznymi: ${blockingSkippedProducts.length}`);
  console.log(`Produkty bez zdjęć: ${productsWithoutImages.length}`);
  console.log(`Opisy uzupelnione do minimum ${MIN_DESCRIPTION_LENGTH} znakow: ${generatedDescriptions.length}`);
  console.log(`Kategorie bez mapowania: ${unresolvedCategories.size}`);
  console.log(`Odrzucone hinty kategorii po EAN: ${categoryReport.rejectedHints.length}`);
  console.log(`Hinty po EAN uzyte z ostrzezeniami lokalnego drzewa: ${categoryReport.hintWarnings.length}`);
  console.log("");

  logObjectCounts("Dopasowanie kategorii:", categoryReport.byMethod);

  if (categoryReport.rejectedHints.length) {
    console.log("");
    logObjectCounts("Powody odrzucenia hintow kategorii:", categoryReport.rejectedHintReasons);
  }

  if (categoryReport.hintWarnings.length) {
    console.log("");
    logObjectCounts("Ostrzezenia lokalnej walidacji hintow:", categoryReport.hintWarningReasons);
  }

  console.log("");
  console.log(`Pliki wynikowe zapisano w katalogu: ${OUTPUT_DIR}`);
  console.log(`- ${path.join(OUTPUT_DIR, OUTPUT_OFFERS_FILE)}`);
  console.log(`- ${path.join(OUTPUT_DIR, OUTPUT_IMAGES_FILE)}`);
  console.log(`- ${path.join(OUTPUT_DIR, OUTPUT_REPORT_FILE)}`);
  console.log(`- ${path.join(OUTPUT_DIR, OUTPUT_ERRORS_FILE)}`);

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
    console.log(`- ${path.join(OUTPUT_DIR, OUTPUT_ERRORS_FILE)}`);

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
