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
 * Wymagane paczki:
 *   npm install csv-parse he
 */

const fs = require("fs");
const path = require("path");
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

function getProductDescription(row, name) {
  const descriptionFromHtml = cleanHtmlToText(
    getFirstNonEmpty(row["Opis"], row["Krótki opis"])
  );

  const fallbackDescription = USE_NAME_AS_FALLBACK_DESCRIPTION ? name : "";

  return limitText(
    descriptionFromHtml || fallbackDescription,
    MAX_DESCRIPTION_LENGTH
  );
}

function buildOffer(row, categoryMap, categoryOverrides, categoryHints) {
  const externalId = normalizeText(row["Identyfikator"]);
  const name = normalizeText(row["Nazwa"]);
  const description = getProductDescription(row, name);
  const price = getPrice(row);
  const quantity = getStockQuantity(row);
  const sku = getSku(row);
  const ean = getEan(row);
  const brand = getBrand(row);
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
        categories: categoryResult.allWooCategories || splitWooCategories(row["Kategorie"]),
        categoryResolution: {
          categoryId: categoryResult.categoryId,
          matchedBy: categoryResult.matchedBy,
          matchedWooCategory: categoryResult.matchedWooCategory,
          matchedInpostCategory: categoryResult.matchedInpostCategory
        },
        errors
      },
      categoryResolution: categoryResult
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
    categoryResolution: categoryResult
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

function main() {
  ensureDir(OUTPUT_DIR);

  const csvContent = readFileUtf8(INPUT_CSV);
  const categoryMap = readJsonIfExists(CATEGORY_MAP_FILE, {});
  const categoryOverrides = readJsonIfExists(CATEGORY_OVERRIDES_FILE, {});
  const categoryHints = readJsonIfExists(CATEGORY_HINTS_FILE, {});

  const invalidOverrides = validateCategoryOverrides(categoryOverrides, categoryMap);

  if (invalidOverrides.length) {
    writeJson(
      path.join(OUTPUT_DIR, "invalid-category-overrides.json"),
      invalidOverrides
    );

    throw new Error(
      `category-overrides.json zawiera błędne mapowania: ${invalidOverrides.length}. ` +
      `Sprawdź ${path.join(OUTPUT_DIR, "invalid-category-overrides.json")}`
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

  const offers = [];
  const offerImages = {};
  const skippedProducts = [];
  const blockingSkippedProducts = [];
  const productsWithoutImages = [];
  const unresolvedCategories = new Map();
  const shortDescriptions = [];

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

    const { offer, images, skipped, categoryResolution } = buildOffer(
      row,
      categoryMap,
      categoryOverrides,
      categoryHints
    );

    updateCategoryReport(categoryReport, categoryResolution);

    if (skipped?.errors?.includes("Brak zdjęcia w kolumnie Obrazki")) {
      productsWithoutImages.push({
        externalId,
        name,
        categories: splitWooCategories(row["Kategorie"])
      });
    }

    if (skipped?.errors?.some((error) => error.startsWith("Opis krótszy niż"))) {
      shortDescriptions.push({
        externalId,
        name,
        descriptionLength: skipped.descriptionLength,
        categories: splitWooCategories(row["Kategorie"])
      });
    }

    if (offer) {
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

  writeJson(path.join(OUTPUT_DIR, "inpost-offers.json"), cleanOffers);
  writeJson(path.join(OUTPUT_DIR, "inpost-offers-wrapped.json"), { offers: cleanOffers });
  writeJson(path.join(OUTPUT_DIR, "offer-images.json"), offerImages);
  writeJson(path.join(OUTPUT_DIR, "skipped-products.json"), skippedProducts);
  writeJson(path.join(OUTPUT_DIR, "blocking-skipped-products.json"), blockingSkippedProducts);
  writeJson(path.join(OUTPUT_DIR, "products-without-images.json"), productsWithoutImages);
  writeJson(path.join(OUTPUT_DIR, "short-descriptions.json"), shortDescriptions);
  writeJson(path.join(OUTPUT_DIR, "unresolved-categories.json"), [...unresolvedCategories.keys()].sort());
  writeJson(path.join(OUTPUT_DIR, "category-resolution-report.json"), categoryReport);

  console.log("Generowanie plików zakończone.");
  console.log(`Wczytano produktów z CSV: ${rows.length}`);
  console.log(`Utworzono ofert: ${cleanOffers.length}`);
  console.log(`Pominięto produktów łącznie: ${skippedProducts.length}`);
  console.log(`Pominięto produktów z błędami krytycznymi: ${blockingSkippedProducts.length}`);
  console.log(`Produkty bez zdjęć: ${productsWithoutImages.length}`);
  console.log(`Produkty z opisem krótszym niż ${MIN_DESCRIPTION_LENGTH} znaków: ${shortDescriptions.length}`);
  console.log(`Kategorie bez mapowania: ${unresolvedCategories.size}`);
  console.log("");

  logObjectCounts("Dopasowanie kategorii:", categoryReport.byMethod);

  console.log("");
  console.log(`Pliki wynikowe zapisano w katalogu: ${OUTPUT_DIR}`);
  console.log(`- ${path.join(OUTPUT_DIR, "inpost-offers.json")}`);
  console.log(`- ${path.join(OUTPUT_DIR, "inpost-offers-wrapped.json")}`);
  console.log(`- ${path.join(OUTPUT_DIR, "offer-images.json")}`);
  console.log(`- ${path.join(OUTPUT_DIR, "skipped-products.json")}`);
  console.log(`- ${path.join(OUTPUT_DIR, "blocking-skipped-products.json")}`);
  console.log(`- ${path.join(OUTPUT_DIR, "products-without-images.json")}`);
  console.log(`- ${path.join(OUTPUT_DIR, "short-descriptions.json")}`);
  console.log(`- ${path.join(OUTPUT_DIR, "unresolved-categories.json")}`);
  console.log(`- ${path.join(OUTPUT_DIR, "category-resolution-report.json")}`);

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
    console.log(`- ${path.join(OUTPUT_DIR, "blocking-skipped-products.json")}`);
    console.log(`- ${path.join(OUTPUT_DIR, "unresolved-categories.json")}`);
    console.log(`- ${path.join(OUTPUT_DIR, "products-without-images.json")}`);
    console.log(`- ${path.join(OUTPUT_DIR, "short-descriptions.json")}`);

    process.exit(1);
  }

  console.log("");
  console.log("OK: poprawne oferty są gotowe do wysyłki przez send-inpost-offers.js.");
}

main();