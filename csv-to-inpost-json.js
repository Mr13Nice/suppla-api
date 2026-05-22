#!/usr/bin/env node

/**
 * CSV WooCommerce -> JSON ofert InPost Buy + mapa zdjęć
 *
 * Użycie:
 *   node csv-to-inpost-json.js suppla-oferta.csv category-map.json dist category-overrides.json
 *
 * Wyniki:
 *   dist/inpost-offers.json
 *   dist/inpost-offers-wrapped.json
 *   dist/offer-images.json
 *   dist/skipped-products.json
 *   dist/products-without-images.json
 *   dist/unresolved-categories.json
 *   dist/category-resolution-report.json
 *
 * Instalacja zależności:
 *   npm install csv-parse he
 */

const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");
const he = require("he");

const INPUT_CSV = process.argv[2] || "produkty.csv";
const CATEGORY_MAP_FILE = process.argv[3] || "category-map.json";
const OUTPUT_DIR = process.argv[4] || "dist";
const CATEGORY_OVERRIDES_FILE = process.argv[5] || "category-overrides.json";

const DEFAULT_TAX_RATE = "23%";
const DEFAULT_CURRENCY = "PLN";
const DEFAULT_STOCK_UNIT = "UNIT";
const DEFAULT_BRAND = "Inna marka";

const MAX_DESCRIPTION_LENGTH = 4000;

/**
 * false = produkty ze stanem 0 też będą eksportowane.
 * true = produkty ze stanem 0 zostaną pominięte.
 */
const SKIP_OUT_OF_STOCK = false;

/**
 * true = eksportuje tylko produkty z kolumną Opublikowano = 1.
 */
const ONLY_PUBLISHED = true;

/**
 * true = gdy opis jest pusty, używa nazwy produktu jako opisu.
 */
const USE_NAME_AS_FALLBACK_DESCRIPTION = true;

/**
 * true = produkt bez zdjęcia nie zostanie dodany do inpost-offers.json.
 * To jest zalecane, skoro InPost wymaga zdjęcia dla każdej oferty.
 */
const REQUIRE_IMAGE = true;

/**
 * false = nie dodaje zdjęć do JSON-a oferty.
 * Zdjęcia są zapisywane osobno w dist/offer-images.json
 * i później wysyłane przez send-inpost-offers.js jako załącznik IMAGE.
 */
const INCLUDE_IMAGES_IN_OFFER_JSON = false;

/**
 * false = nie dodaje pola diagnostycznego _meta do oferty.
 * To bezpieczniejsze przy wysyłce do InPost.
 */
const INCLUDE_META_IN_OFFERS = false;

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

function normalizeText(value) {
  return String(value ?? "")
    .replace(/\r/g, "")
    .replace(/\\n/g, "\n")
    .replace(/\s+/g, " ")
    .trim();
}

function limitText(value, maxLength = MAX_DESCRIPTION_LENGTH) {
  const text = normalizeText(value);

  if (text.length <= maxLength) {
    return text;
  }

  return text.slice(0, maxLength).trim();
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

function normalizeCategoryPath(categoryPath) {
  return normalizeText(categoryPath)
    .replace(/\s*>\s*/g, " > ")
    .replace(/\s*\/\s*/g, " / ")
    .replace(/\s+/g, " ")
    .trim();
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
  if (value === undefined || value === null) return null;

  const normalized = String(value)
    .replace(/\s/g, "")
    .replace(",", ".")
    .trim();

  if (!normalized) return null;

  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function parseInteger(value) {
  const number = parseNumber(value);
  return number === null ? null : Math.max(0, Math.floor(number));
}

function isLikelyEan(value) {
  const text = String(value ?? "").trim();

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

function detectDelimiter(csvContent) {
  const firstLine = csvContent.split(/\r?\n/).find((line) => line.trim());

  if (!firstLine) {
    return ",";
  }

  const commaCount = (firstLine.match(/,/g) || []).length;
  const semicolonCount = (firstLine.match(/;/g) || []).length;

  return semicolonCount > commaCount ? ";" : ",";
}

function categoryDepth(categoryPath) {
  return normalizeCategoryPath(categoryPath)
    .split(">")
    .map((part) => part.trim())
    .filter(Boolean).length;
}

function splitWooCategories(value) {
  const raw = normalizeText(value);

  if (!raw) {
    return [];
  }

  return raw
    .split(/(?<!\\),\s*/g)
    .map((item) => item.replace(/\\,/g, ","))
    .map((item) => normalizeCategoryPath(item))
    .filter(Boolean);
}

function buildNormalizedCategoryMap(categoryMap) {
  const normalizedMap = {};

  for (const [categoryPath, categoryId] of Object.entries(categoryMap || {})) {
    normalizedMap[normalizeForCompare(categoryPath)] = {
      originalPath: categoryPath,
      categoryId
    };
  }

  return normalizedMap;
}

function buildNormalizedOverridesMap(categoryOverrides) {
  const normalizedMap = {};

  for (const [wooCategoryPath, inpostCategoryValue] of Object.entries(categoryOverrides || {})) {
    normalizedMap[normalizeForCompare(wooCategoryPath)] = {
      originalPath: wooCategoryPath,
      value: inpostCategoryValue
    };
  }

  return normalizedMap;
}

/**
 * category-overrides.json może mieć jako wartość:
 *
 * 1. Bezpośrednie ID kategorii InPost:
 *    "Dermokosmetyki > do Twarzy > Ochrona przeciwsłoneczna": "68f5ca30..."
 *
 * 2. Ścieżkę z category-map.json:
 *    "Dermokosmetyki > do Twarzy > Ochrona przeciwsłoneczna": "Dermokosmetyki > Dermokosmetyki do opalania"
 */
function resolveCategoryValue(value, categoryMap, normalizedCategoryMap) {
  const cleanValue = normalizeText(value);

  if (!cleanValue) {
    return null;
  }

  if (categoryMap[cleanValue]) {
    return {
      categoryId: categoryMap[cleanValue],
      resolvedFrom: cleanValue
    };
  }

  const normalizedValue = normalizeForCompare(cleanValue);

  if (normalizedCategoryMap[normalizedValue]) {
    return {
      categoryId: normalizedCategoryMap[normalizedValue].categoryId,
      resolvedFrom: normalizedCategoryMap[normalizedValue].originalPath
    };
  }

  return {
    categoryId: cleanValue,
    resolvedFrom: "direct-id"
  };
}

function getLastCategoryPart(categoryPath) {
  const parts = normalizeCategoryPath(categoryPath)
    .split(">")
    .map((part) => part.trim())
    .filter(Boolean);

  return parts[parts.length - 1] || "";
}

function findByLastCategoryName(wooCategoryPath, categoryMap) {
  const wooLastPart = normalizeForCompare(getLastCategoryPart(wooCategoryPath));

  if (!wooLastPart) {
    return null;
  }

  const candidates = Object.entries(categoryMap)
    .map(([inpostPath, categoryId]) => ({
      inpostPath,
      categoryId,
      lastPart: normalizeForCompare(getLastCategoryPart(inpostPath))
    }))
    .filter((item) => item.lastPart === wooLastPart);

  if (candidates.length === 1) {
    return {
      categoryId: candidates[0].categoryId,
      matchedCategory: candidates[0].inpostPath
    };
  }

  return null;
}

function getFallbackRules() {
  return [
    {
      test: /ochrona przeciwsloneczna|przeciwslonecz|spf|opal/,
      inpostPath: "Dermokosmetyki > Dermokosmetyki do opalania"
    },
    {
      test: /antyperspir|dezodorant/,
      inpostPath: "Dermokosmetyki > Dermokosmetyki do ciała > Antyperspiranty"
    },
    {
      test: /krem.*rak|krem.*dlon|dloni|dłoni|stop|stóp/,
      inpostPath: "Dermokosmetyki > Dermokosmetyki do ciała > Kremy do rąk i stóp"
    },
    {
      test: /olejek.*wlos|olej.*wlos|olejek.*włos|olej.*włos/,
      inpostPath: "Dermokosmetyki > Dermokosmetyki do włosów > Olejki do włosów"
    },
    {
      test: /olejek|olejki|olej do masażu|olej do masazu/,
      inpostPath: "Dermokosmetyki > Dermokosmetyki do ciała > Olejki do ciała"
    },
    {
      test: /kapiel|kąpiel|prysznic|mydlo|mydło|zel myjacy|żel myjący|zel pod prysznic|żel pod prysznic|olejek myjacy|olejek myjący/,
      inpostPath: "Dermokosmetyki > Dermokosmetyki do ciała > Kąpiel i prysznic"
    },
    {
      test: /peeling|scrub/,
      inpostPath: "Dermokosmetyki > Dermokosmetyki do ciała > Peelingi i scruby do ciała"
    },
    {
      test: /mgielka|mgiełka/,
      inpostPath: "Dermokosmetyki > Dermokosmetyki do ciała > Mgiełki do ciała"
    },
    {
      test: /balsam|maslo|masło|mleczko|emulsja|krem.*cial|krem.*ciał/,
      inpostPath: "Dermokosmetyki > Dermokosmetyki do ciała > Balsamy, masła, kremy do ciała"
    },
    {
      test: /szampon/,
      inpostPath: "Dermokosmetyki > Dermokosmetyki do włosów > Szampony"
    },
    {
      test: /odzywk|odżywk|maska.*wlos|maska.*włos|balsam.*wlos|balsam.*włos|rozczes/,
      inpostPath: "Dermokosmetyki > Dermokosmetyki do włosów > Odżywki, maski, balsamy do włosów"
    },
    {
      test: /kuracj|wcierk|ampulk|ampułk|serum.*wlos|serum.*włos/,
      inpostPath: "Dermokosmetyki > Dermokosmetyki do włosów > Kuracje do włosów"
    },
    {
      test: /tonik|hydrolat|woda termalna/,
      inpostPath: "Dermokosmetyki > Dermokosmetyki do twarzy > Toniki, hydrolaty, wody termalne"
    },
    {
      test: /oczyszcz|demakijaz|demakijaż|plyn micelarn|płyn micelarn|zel do mycia twarzy|żel do mycia twarzy/,
      inpostPath: "Dermokosmetyki > Dermokosmetyki do twarzy > Oczyszczanie i demakijaż"
    },
    {
      test: /maseczk|maska do twarzy/,
      inpostPath: "Dermokosmetyki > Dermokosmetyki do twarzy > Maseczki do twarzy"
    },
    {
      test: /serum/,
      inpostPath: "Dermokosmetyki > Dermokosmetyki do twarzy > Serum"
    },
    {
      test: /krem.*pod oczy|okolice oczu|pod oczy/,
      inpostPath: "Dermokosmetyki > Dermokosmetyki do twarzy > Kremy pod oczy"
    },
    {
      test: /krem|twarz/,
      inpostPath: "Dermokosmetyki > Dermokosmetyki do twarzy > Kremy do twarzy"
    },
    {
      test: /wlos|włos/,
      inpostPath: "Dermokosmetyki > Dermokosmetyki do włosów > Szampony"
    },
    {
      test: /zestaw/,
      inpostPath: "Dermokosmetyki > Zestawy dermokosmetyków"
    },

    {
      test: /zapar/,
      inpostPath: "Domowa apteczka > Leki bez recepty > Układ pokarmowy > Zaparcia"
    },
    {
      test: /biegun/,
      inpostPath: "Domowa apteczka > Leki bez recepty > Układ pokarmowy > Biegunka"
    },
    {
      test: /zgaga|nadkwas/,
      inpostPath: "Domowa apteczka > Leki bez recepty > Układ pokarmowy > Zgaga, nadkwaśność"
    },
    {
      test: /watrob|wątrob/,
      inpostPath: "Domowa apteczka > Leki bez recepty > Układ pokarmowy > Wątroba"
    },
    {
      test: /wzdec|wzdęc|nudnos|nudnoś|wymiot/,
      inpostPath: "Domowa apteczka > Leki bez recepty > Układ pokarmowy > Wzdęcia, nudności, wymioty"
    },
    {
      test: /probiot|flora bakteryjna/,
      inpostPath: "Domowa apteczka > Leki bez recepty > Układ pokarmowy > Odbudowa flory bakteryjnej"
    },
    {
      test: /bol gardla|ból gardła|chryp/,
      inpostPath: "Domowa apteczka > Leki bez recepty > Przeziębienie, grypa > Ból gardła, chrypa"
    },
    {
      test: /kaszel/,
      inpostPath: "Domowa apteczka > Leki bez recepty > Przeziębienie, grypa > Kaszel"
    },
    {
      test: /katar/,
      inpostPath: "Domowa apteczka > Leki bez recepty > Przeziębienie, grypa > Katar"
    },
    {
      test: /goracz|gorącz/,
      inpostPath: "Domowa apteczka > Leki bez recepty > Przeziębienie, grypa > Gorączka"
    },
    {
      test: /alerg/,
      inpostPath: "Domowa apteczka > Leki bez recepty > Alergia"
    },
    {
      test: /bol|ból|przeciwbol|przeciwból/,
      inpostPath: "Domowa apteczka > Leki bez recepty > Przeciwbólowe"
    },
    {
      test: /odporn/,
      inpostPath: "Domowa apteczka > Leki bez recepty > Odporność"
    },

    {
      test: /suplement.*dziec|dla dzieci/,
      inpostPath: "Domowa apteczka > Suplementy diety > Dla dzieci"
    },
    {
      test: /ciaz|ciąż|karmi/,
      inpostPath: "Domowa apteczka > Suplementy diety > Dla kobiet w ciąży i mam karmiących"
    },
    {
      test: /witamin|mineral/,
      inpostPath: "Domowa apteczka > Suplementy diety > Preparaty witaminowo-mineralne"
    },
    {
      test: /skora.*wlos.*paznok|skóra.*włos.*paznok/,
      inpostPath: "Domowa apteczka > Suplementy diety > Skóra, włosy, paznokcie"
    },
    {
      test: /uklad pokarm|układ pokarm|trawien/,
      inpostPath: "Domowa apteczka > Suplementy diety > Układ pokarmowy"
    },
    {
      test: /pamiec|pamięc|pamięć|koncentrac|nerwow/,
      inpostPath: "Domowa apteczka > Suplementy diety > Pamięć, koncentracja i układ nerwowy"
    },
    {
      test: /staw|miesn|mięsn|kosci|kości/,
      inpostPath: "Domowa apteczka > Suplementy diety > Mięśnie, kości i stawy"
    },
    {
      test: /uklad mocz|układ mocz/,
      inpostPath: "Domowa apteczka > Suplementy diety > Układ moczowy"
    },
    {
      test: /krazen|krążen|serce/,
      inpostPath: "Domowa apteczka > Suplementy diety > Układ krążenia"
    }
  ];
}

function resolveCategoryId(row, categoryMap, categoryOverrides) {
  const normalizedCategoryMap = buildNormalizedCategoryMap(categoryMap);
  const normalizedOverridesMap = buildNormalizedOverridesMap(categoryOverrides);

  const categories = splitWooCategories(row["Kategorie"]);

  const sortedCategories = [...categories].sort((a, b) => {
    const depthDiff = categoryDepth(b) - categoryDepth(a);

    if (depthDiff !== 0) {
      return depthDiff;
    }

    return b.length - a.length;
  });

  for (const wooCategory of sortedCategories) {
    if (Object.prototype.hasOwnProperty.call(categoryOverrides, wooCategory)) {
      const resolved = resolveCategoryValue(
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
      const resolved = resolveCategoryValue(
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

  for (const wooCategory of sortedCategories) {
    if (categoryMap[wooCategory]) {
      return {
        categoryId: categoryMap[wooCategory],
        matchedBy: "category-map-exact",
        matchedWooCategory: wooCategory,
        matchedInpostCategory: wooCategory,
        allWooCategories: categories
      };
    }
  }

  for (const wooCategory of sortedCategories) {
    const normalizedWooCategory = normalizeForCompare(wooCategory);

    if (normalizedCategoryMap[normalizedWooCategory]) {
      return {
        categoryId: normalizedCategoryMap[normalizedWooCategory].categoryId,
        matchedBy: "category-map-normalized",
        matchedWooCategory: wooCategory,
        matchedInpostCategory: normalizedCategoryMap[normalizedWooCategory].originalPath,
        allWooCategories: categories
      };
    }
  }

  for (const wooCategory of sortedCategories) {
    const result = findByLastCategoryName(wooCategory, categoryMap);

    if (result?.categoryId) {
      return {
        categoryId: result.categoryId,
        matchedBy: "last-category-name",
        matchedWooCategory: wooCategory,
        matchedInpostCategory: result.matchedCategory,
        allWooCategories: categories
      };
    }
  }

  const context = normalizeForCompare(
    [
      ...sortedCategories,
      row["Nazwa"],
      row["Krótki opis"],
      row["Opis"]
    ].join(" | ")
  );

  for (const rule of getFallbackRules()) {
    if (!rule.test.test(context)) {
      continue;
    }

    const resolved = resolveCategoryValue(rule.inpostPath, categoryMap, normalizedCategoryMap);

    if (resolved?.categoryId) {
      return {
        categoryId: resolved.categoryId,
        matchedBy: "fallback-rule",
        matchedWooCategory: sortedCategories[0] || "",
        matchedInpostCategory: rule.inpostPath,
        allWooCategories: categories
      };
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
  return parseNumber(
    getFirstNonEmpty(
      row["Cena promocyjna"],
      row["Cena"],
      row["Cena regularna"]
    )
  );
}

function getStockQuantity(row) {
  const stock = parseInteger(row["Stan magazynowy"]);

  if (stock !== null) {
    return stock;
  }

  const inStock = normalizeText(row["W magazynie?"]).toLowerCase();

  if (inStock === "1" || inStock === "yes" || inStock === "tak") {
    return 1;
  }

  return 0;
}

function getEan(row) {
  const gtin = normalizeText(row["GTIN, UPC, EAN lub ISBN"]);
  const ean = normalizeText(row["EAN"]);
  const sku = normalizeText(row["SKU"]);

  if (isLikelyEan(gtin)) return gtin;
  if (isLikelyEan(ean)) return ean;
  if (isLikelyEan(sku)) return sku;

  return "";
}

function getSku(row) {
  return getFirstNonEmpty(row["SKU"], row["Identyfikator"]);
}

function getBrand(row) {
  const brandFromColumn = normalizeText(row["Marki"]);

  if (brandFromColumn) {
    return brandFromColumn.split(",")[0].trim();
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

  if (widthCm !== null) {
    dimension.width = Math.round(widthCm * 10);
  }

  if (heightCm !== null) {
    dimension.height = Math.round(heightCm * 10);
  }

  if (lengthCm !== null) {
    dimension.length = Math.round(lengthCm * 10);
  }

  return Object.keys(dimension).length ? dimension : undefined;
}

function getProductImages(row) {
  const images = normalizeText(row["Obrazki"]);

  if (!images) {
    return [];
  }

  return images
    .split(",")
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

function buildOffer(row, categoryMap, categoryOverrides) {
  const externalId = normalizeText(row["Identyfikator"]);
  const name = normalizeText(row["Nazwa"]);

  const descriptionFromHtml = cleanHtmlToText(
    getFirstNonEmpty(row["Opis"], row["Krótki opis"])
  );

  const description = limitText(
    descriptionFromHtml ||
      (USE_NAME_AS_FALLBACK_DESCRIPTION ? name : ""),
    MAX_DESCRIPTION_LENGTH
  );

  const price = getPrice(row);
  const quantity = getStockQuantity(row);
  const sku = getSku(row);
  const ean = getEan(row);
  const brand = getBrand(row);
  const manufacturerProductNumber = getManufacturerProductNumber(row);
  const dimensions = getDimensions(row);
  const images = getProductImages(row);
  const productUrl = getProductUrl(row);

  const categoryResult = resolveCategoryId(row, categoryMap, categoryOverrides);

  const errors = [];

  if (!externalId) errors.push("Brak Identyfikator");
  if (!name) errors.push("Brak Nazwa");
  if (!description) errors.push("Brak Opis");
  if (price === null) errors.push("Brak Cena / Cena promocyjna");

  if (!categoryResult.categoryId) {
    errors.push("Brak mapowania kategorii w category-map.json lub category-overrides.json");
  }

  if (REQUIRE_IMAGE && images.length === 0) {
    errors.push("Brak zdjęcia w kolumnie Obrazki");
  }

  if (ONLY_PUBLISHED && normalizeText(row["Opublikowano"]) !== "1") {
    errors.push("Produkt nieopublikowany");
  }

  if (SKIP_OUT_OF_STOCK && quantity <= 0) {
    errors.push("Brak stanu magazynowego");
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
      taxRateInfo: DEFAULT_TAX_RATE
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

function main() {
  const csvContent = readFileUtf8(INPUT_CSV);
  const categoryMap = readJsonIfExists(CATEGORY_MAP_FILE, {});
  const categoryOverrides = readJsonIfExists(CATEGORY_OVERRIDES_FILE, {});

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
  const productsWithoutImages = [];
  const unresolvedCategories = new Map();

  const categoryReport = {
    inputCsv: INPUT_CSV,
    categoryMapFile: CATEGORY_MAP_FILE,
    categoryOverridesFile: fs.existsSync(CATEGORY_OVERRIDES_FILE)
      ? CATEGORY_OVERRIDES_FILE
      : null,
    delimiter,
    byMethod: {},
    resolved: [],
    unresolved: []
  };

  for (const row of rows) {
    const productType = normalizeText(row["Rodzaj"]);

    if (productType && productType !== "simple") {
      skippedProducts.push({
        externalId: normalizeText(row["Identyfikator"]),
        name: normalizeText(row["Nazwa"]),
        type: productType,
        errors: [`Pominięto typ produktu: ${productType}`]
      });
      continue;
    }

    const { offer, images, skipped, categoryResolution } = buildOffer(
      row,
      categoryMap,
      categoryOverrides
    );

    updateCategoryReport(categoryReport, categoryResolution);

    const externalId = normalizeText(row["Identyfikator"]);
    const name = normalizeText(row["Nazwa"]);

    if (!images.length) {
      productsWithoutImages.push({
        externalId,
        name,
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

      if (!categoryResolution.categoryId) {
        for (const categoryPath of categoryResolution.allWooCategories || []) {
          unresolvedCategories.set(categoryPath, categoryPath);
        }
      }
    }
  }

  ensureDir(OUTPUT_DIR);

  const cleanOffers = offers.map((offer) => JSON.parse(JSON.stringify(offer)));

  fs.writeFileSync(
    path.join(OUTPUT_DIR, "inpost-offers.json"),
    JSON.stringify(cleanOffers, null, 2),
    "utf8"
  );

  fs.writeFileSync(
    path.join(OUTPUT_DIR, "inpost-offers-wrapped.json"),
    JSON.stringify({ offers: cleanOffers }, null, 2),
    "utf8"
  );

  fs.writeFileSync(
    path.join(OUTPUT_DIR, "offer-images.json"),
    JSON.stringify(offerImages, null, 2),
    "utf8"
  );

  fs.writeFileSync(
    path.join(OUTPUT_DIR, "skipped-products.json"),
    JSON.stringify(skippedProducts, null, 2),
    "utf8"
  );

  fs.writeFileSync(
    path.join(OUTPUT_DIR, "products-without-images.json"),
    JSON.stringify(productsWithoutImages, null, 2),
    "utf8"
  );

  fs.writeFileSync(
    path.join(OUTPUT_DIR, "unresolved-categories.json"),
    JSON.stringify([...unresolvedCategories.keys()].sort(), null, 2),
    "utf8"
  );

  fs.writeFileSync(
    path.join(OUTPUT_DIR, "category-resolution-report.json"),
    JSON.stringify(categoryReport, null, 2),
    "utf8"
  );

  console.log("Gotowe.");
  console.log(`Wczytano produktów z CSV: ${rows.length}`);
  console.log(`Utworzono ofert: ${cleanOffers.length}`);
  console.log(`Pominięto produktów: ${skippedProducts.length}`);
  console.log(`Produkty bez zdjęć: ${productsWithoutImages.length}`);
  console.log(`Kategorie bez mapowania: ${unresolvedCategories.size}`);
  console.log("");

  console.log("Dopasowanie kategorii:");
  for (const [method, count] of Object.entries(categoryReport.byMethod)) {
    console.log(`- ${method}: ${count}`);
  }

  console.log("");
  console.log(`Pliki wynikowe zapisano w katalogu: ${OUTPUT_DIR}`);
  console.log(`- ${path.join(OUTPUT_DIR, "inpost-offers.json")}`);
  console.log(`- ${path.join(OUTPUT_DIR, "inpost-offers-wrapped.json")}`);
  console.log(`- ${path.join(OUTPUT_DIR, "offer-images.json")}`);
  console.log(`- ${path.join(OUTPUT_DIR, "skipped-products.json")}`);
  console.log(`- ${path.join(OUTPUT_DIR, "products-without-images.json")}`);
  console.log(`- ${path.join(OUTPUT_DIR, "unresolved-categories.json")}`);
  console.log(`- ${path.join(OUTPUT_DIR, "category-resolution-report.json")}`);
}

main();