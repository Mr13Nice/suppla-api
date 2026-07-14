require("dotenv").config();

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { parse } = require("csv-parse/sync");

const DEFAULT_CSV_FILE = "suppla-oferta.csv";
const DEFAULT_OFFERS_FILE = path.join("dist", "inpost-offers.json");
const DEFAULT_MAP_FILE = "brand-map.json";
const DEFAULT_REPORT_FILE = path.join("dist", "brand-enrichment-report.json");

const SOURCE_APIS = [
  {
    id: "openbeautyfacts",
    name: "Open Beauty Facts",
    url: (code) =>
      `https://world.openbeautyfacts.org/api/v2/product/${encodeURIComponent(
        code
      )}.json?fields=brands,product_name,code`,
  },
  {
    id: "openfoodfacts",
    name: "Open Food Facts",
    url: (code) =>
      `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(
        code
      )}.json?fields=brands,product_name,code`,
  },
  {
    id: "openproductsfacts",
    name: "Open Products Facts",
    url: (code) =>
      `https://world.openproductsfacts.org/api/v2/product/${encodeURIComponent(
        code
      )}.json?fields=brands,product_name,code`,
  },
];

function parseArgs(argv) {
  const options = {
    dryRun: false,
    offline: false,
    refresh: false,
    onlyCode: "",
    lookupLimit:
      process.env.BRAND_LOOKUP_LIMIT === undefined
        ? Infinity
        : Number(process.env.BRAND_LOOKUP_LIMIT),
    timeoutMs: Number(process.env.BRAND_LOOKUP_TIMEOUT_MS || 10000),
    delayMs: Number(process.env.BRAND_LOOKUP_DELAY_MS || 150),
    progressEvery: Number(process.env.BRAND_PROGRESS_EVERY || 10),
    saveEvery: Number(process.env.BRAND_SAVE_EVERY || 25),
  };

  const positional = [];
  for (const arg of argv) {
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--offline") options.offline = true;
    else if (arg === "--refresh") options.refresh = true;
    else if (arg.startsWith("--only-code=")) {
      options.onlyCode = normalizeCode(arg.slice("--only-code=".length));
    }
    else if (arg.startsWith("--lookup-limit=")) {
      options.lookupLimit = Number(arg.slice("--lookup-limit=".length));
    } else if (arg.startsWith("--timeout-ms=")) {
      options.timeoutMs = Number(arg.slice("--timeout-ms=".length));
    } else if (arg.startsWith("--delay-ms=")) {
      options.delayMs = Number(arg.slice("--delay-ms=".length));
    } else if (arg.startsWith("--progress-every=")) {
      options.progressEvery = Number(arg.slice("--progress-every=".length));
    } else if (arg.startsWith("--save-every=")) {
      options.saveEvery = Number(arg.slice("--save-every=".length));
    } else {
      positional.push(arg);
    }
  }

  if (!Number.isFinite(options.lookupLimit) || options.lookupLimit < 0) {
    options.lookupLimit = Infinity;
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    options.timeoutMs = 10000;
  }
  if (!Number.isFinite(options.delayMs) || options.delayMs < 0) {
    options.delayMs = 150;
  }
  if (!Number.isFinite(options.progressEvery) || options.progressEvery <= 0) {
    options.progressEvery = 10;
  }
  if (!Number.isFinite(options.saveEvery) || options.saveEvery <= 0) {
    options.saveEvery = 25;
  }

  return {
    csvFile: positional[0] || DEFAULT_CSV_FILE,
    offersFile: positional[1] || DEFAULT_OFFERS_FILE,
    mapFile: positional[2] || DEFAULT_MAP_FILE,
    reportFile: positional[3] || DEFAULT_REPORT_FILE,
    options,
  };
}

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function normalizeMap(map) {
  return {
    version: 1,
    updatedAt: map.updatedAt || null,
    sources:
      map.sources ||
      SOURCE_APIS.map((source) => ({
        id: source.id,
        name: source.name,
      })),
    manual: {
      exact: (map.manual && map.manual.exact) || {},
      prefixes: (map.manual && map.manual.prefixes) || {},
    },
    codes: map.codes || {},
  };
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeCode(value) {
  const digits = String(value || "").replace(/\D+/g, "");
  return /^(?:\d{8}|\d{12}|\d{13}|\d{14})$/.test(digits) ? digits : "";
}

function normalizeForCompare(value) {
  return normalizeText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function nameContainsBrand(name, brand) {
  const normalizedName = normalizeForCompare(name);
  const normalizedBrand = normalizeForCompare(brand);
  if (!normalizedName || !normalizedBrand) return false;
  const pattern = new RegExp(`(^| )${escapeRegExp(normalizedBrand)}( |$)`);
  return pattern.test(normalizedName);
}

function makeRecord(brand, source, extra = {}) {
  const normalizedBrand = normalizeText(brand);
  if (!normalizedBrand) return null;
  return {
    brand: normalizedBrand,
    source,
    confidence: extra.confidence || "exact-code",
    productName: normalizeText(extra.productName),
    updatedAt: new Date().toISOString(),
  };
}

function readCsvRows(csvFile) {
  if (!fs.existsSync(csvFile)) return [];
  const csv = fs.readFileSync(csvFile, "utf8");
  return parse(csv, {
    columns: true,
    bom: true,
    skip_empty_lines: true,
    relax_column_count: true,
  });
}

function buildCsvCodeMap(csvFile) {
  const rows = readCsvRows(csvFile);
  const byExternalId = new Map();
  for (const row of rows) {
    const externalId = normalizeText(row["Identyfikator"]);
    if (!externalId) continue;
    const code =
      normalizeCode(row["GTIN, UPC, EAN lub ISBN"]) || normalizeCode(row.SKU);
    if (code) byExternalId.set(externalId, code);
  }
  return byExternalId;
}

function brandFromManual(value, source) {
  if (typeof value === "string") return makeRecord(value, source, { confidence: "manual" });
  if (value && typeof value === "object") {
    return makeRecord(value.brand, value.source || source, {
      confidence: value.confidence || "manual",
      productName: value.productName,
    });
  }
  return null;
}

function findManualRecord(code, map) {
  const exact = brandFromManual(map.manual.exact[code], "manual-exact");
  if (exact) return exact;

  let bestPrefix = "";
  let bestValue = null;
  for (const [prefix, value] of Object.entries(map.manual.prefixes || {})) {
    if (code.startsWith(prefix) && prefix.length > bestPrefix.length) {
      bestPrefix = prefix;
      bestValue = value;
    }
  }
  return bestValue ? brandFromManual(bestValue, `manual-prefix:${bestPrefix}`) : null;
}

function firstBrand(value) {
  return normalizeText(String(value || "").split(/[;,]/)[0]);
}

async function sleep(ms) {
  if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
}

async function lookupBrand(code, options) {
  const errors = [];
  for (const source of SOURCE_APIS) {
    try {
      const response = await axios.get(source.url(code), {
        timeout: options.timeoutMs,
        headers: {
          "User-Agent": "suppla-api-brand-enrichment/1.0",
          Accept: "application/json",
        },
      });
      const product = response.data && response.data.product;
      const brand = firstBrand(product && product.brands);
      if (response.data && response.data.status === 1 && brand) {
        return makeRecord(brand, source.id, {
          confidence: "exact-code",
          productName: product.product_name,
        });
      }
    } catch (error) {
      errors.push({
        source: source.id,
        message: error.response
          ? `HTTP ${error.response.status}`
          : error.message,
      });
    }
    await sleep(options.delayMs);
  }
  return { notFound: true, errors };
}

function offerCode(offer, csvCodeByExternalId) {
  const product = offer.product || {};
  return (
    normalizeCode(product.ean) ||
    normalizeCode(product.sku) ||
    normalizeCode(csvCodeByExternalId.get(normalizeText(offer.externalId)))
  );
}

function updateOfferName(offer, record) {
  const product = offer.product || {};
  const oldName = normalizeText(product.name);
  const brand = normalizeText(record.brand);
  if (!oldName || !brand || nameContainsBrand(oldName, brand)) {
    return null;
  }

  const oldBrand = normalizeText(product.brand);
  product.name = `${brand} ${oldName}`;
  product.brand = brand;
  offer.product = product;

  return {
    externalId: normalizeText(offer.externalId),
    code: normalizeCode(product.ean) || normalizeCode(product.sku),
    brand,
    source: record.source,
    oldName,
    newName: product.name,
    oldBrand,
    newBrand: product.brand,
  };
}

function sortedObject(object) {
  return Object.fromEntries(
    Object.entries(object || {}).sort(([left], [right]) => left.localeCompare(right))
  );
}

function sortMapInPlace(map) {
  map.codes = sortedObject(map.codes);
  return map;
}

function reportOptions(options) {
  return {
    ...options,
    lookupLimit: Number.isFinite(options.lookupLimit)
      ? options.lookupLimit
      : "unlimited",
  };
}

function logProgress(report, message) {
  const totals = report.totals;
  console.log(
    [
      `[brand] ${message}`,
      `offers ${totals.processedOffers}/${totals.offers}`,
      `codes ${totals.codes}`,
      `lookups ${totals.lookedUp}`,
      `map +${totals.addedToMap}`,
      `changed ${totals.changedNames}`,
      `present ${totals.alreadyHadBrandInName}`,
      `missing ${totals.missingBrand}`,
      `offline ${totals.skippedOffline}`,
      `limit ${totals.skippedLookupLimit}`,
    ].join(" | ")
  );
}

async function main() {
  const { csvFile, offersFile, mapFile, reportFile, options } = parseArgs(
    process.argv.slice(2)
  );

  const offers = readJson(offersFile, []);
  if (!Array.isArray(offers)) {
    throw new Error(`${offersFile} must contain a JSON array of offers`);
  }

  const map = normalizeMap(readJson(mapFile, {}));
  const csvCodeByExternalId = buildCsvCodeMap(csvFile);

  const report = {
    generatedAt: new Date().toISOString(),
    updatedAt: null,
    status: "running",
    files: { csvFile, offersFile, mapFile, reportFile },
    options: reportOptions(options),
    totals: {
      offers: offers.length,
      processedOffers: 0,
      codes: 0,
      knownBeforeLookup: 0,
      lookedUp: 0,
      addedToMap: 0,
      changedNames: 0,
      alreadyHadBrandInName: 0,
      missingBrand: 0,
      skippedOffline: 0,
      skippedLookupLimit: 0,
      skippedOtherCode: 0,
    },
    changed: [],
    alreadyPresent: [],
    missing: [],
    lookupErrors: [],
  };

  function persistProgress(reason) {
    report.updatedAt = new Date().toISOString();
    report.lastProgress = {
      reason,
      totals: { ...report.totals },
    };
    if (!options.dryRun) {
      map.updatedAt = report.updatedAt;
      writeJson(mapFile, sortMapInPlace(map));
    }
    writeJson(reportFile, report);
  }

  function checkpoint(reason) {
    if (report.totals.processedOffers % options.progressEvery === 0) {
      logProgress(report, reason);
    }
    if (report.totals.processedOffers % options.saveEvery === 0) {
      persistProgress(reason);
    }
  }

  console.log(
    [
      "[brand] Start brand enrichment",
      `offersFile=${offersFile}`,
      `mapFile=${mapFile}`,
      `dryRun=${options.dryRun}`,
      `offline=${options.offline}`,
      `lookupLimit=${report.options.lookupLimit}`,
      `progressEvery=${options.progressEvery}`,
      `saveEvery=${options.saveEvery}`,
    ].join(" | ")
  );
  persistProgress("start");

  for (const offer of offers) {
    report.totals.processedOffers += 1;
    const code = offerCode(offer, csvCodeByExternalId);
    if (!code) {
      checkpoint("no-code");
      continue;
    }
    if (options.onlyCode && code !== options.onlyCode) {
      report.totals.skippedOtherCode += 1;
      checkpoint("other-code");
      continue;
    }
    report.totals.codes += 1;

    let record = findManualRecord(code, map);
    if (!record && map.codes[code] && !options.refresh) {
      record = map.codes[code];
      report.totals.knownBeforeLookup += 1;
    }

    if (!record && options.offline) {
      report.totals.skippedOffline += 1;
      report.missing.push({
        externalId: normalizeText(offer.externalId),
        code,
        reason: "offline-no-map-entry",
      });
      checkpoint("offline-no-map-entry");
      continue;
    }

    if (!record) {
      if (report.totals.lookedUp >= options.lookupLimit) {
        report.totals.skippedLookupLimit += 1;
        report.missing.push({
          externalId: normalizeText(offer.externalId),
          code,
          reason: "lookup-limit",
        });
        checkpoint("lookup-limit");
        continue;
      }

      report.totals.lookedUp += 1;
      const externalId = normalizeText(offer.externalId);
      console.log(
        `[brand] Lookup ${report.totals.lookedUp}: externalId=${externalId || "-"} code=${code}`
      );
      const lookup = await lookupBrand(code, options);
      if (lookup && lookup.brand) {
        record = lookup;
        map.codes[code] = record;
        report.totals.addedToMap += 1;
        console.log(
          `[brand] Found: code=${code} brand="${record.brand}" source=${record.source}`
        );
        if (!options.dryRun) {
          persistProgress(`found-${code}`);
        }
      } else {
        report.totals.missingBrand += 1;
        console.log(`[brand] Not found: code=${code}`);
        report.missing.push({
          externalId: normalizeText(offer.externalId),
          code,
          reason: "not-found",
        });
        if (lookup && lookup.errors && lookup.errors.length) {
          report.lookupErrors.push({ code, errors: lookup.errors });
        }
        checkpoint("not-found");
        continue;
      }
    }

    const product = offer.product || {};
    if (nameContainsBrand(product.name, record.brand)) {
      report.totals.alreadyHadBrandInName += 1;
      report.alreadyPresent.push({
        externalId: normalizeText(offer.externalId),
        code,
        brand: record.brand,
        name: normalizeText(product.name),
        source: record.source,
      });
      checkpoint("already-present");
      continue;
    }

    const change = updateOfferName(offer, record);
    if (change) {
      change.code = code;
      report.totals.changedNames += 1;
      report.changed.push(change);
      console.log(
        `[brand] Name changed: externalId=${change.externalId || "-"} "${change.oldName}" -> "${change.newName}"`
      );
    }

    checkpoint("progress");
  }

  map.updatedAt = new Date().toISOString();
  report.updatedAt = map.updatedAt;
  report.status = "complete";

  if (!options.dryRun) {
    writeJson(offersFile, offers);
    writeJson(mapFile, sortMapInPlace(map));
  }
  writeJson(reportFile, report);

  console.log(
    [
      `Offers: ${report.totals.offers}`,
      `Codes: ${report.totals.codes}`,
      `Looked up: ${report.totals.lookedUp}`,
      `Added to map: ${report.totals.addedToMap}`,
      `Changed names: ${report.totals.changedNames}`,
      `Already present: ${report.totals.alreadyHadBrandInName}`,
      `Missing brand: ${report.totals.missingBrand}`,
      `Skipped offline: ${report.totals.skippedOffline}`,
      `Skipped lookup limit: ${report.totals.skippedLookupLimit}`,
      options.onlyCode ? `Only code: ${options.onlyCode}` : null,
      options.dryRun ? "Dry run: offers/map not written" : "Written: offers/map",
    ]
      .filter(Boolean)
      .join("\n")
  );
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
