#!/usr/bin/env node

/**
 * patch-inpost-offers.js
 *
 * Aktualizuje istniejące oferty InPost Buy na podstawie pliku:
 *   dist/inpost-offers.json
 *
 * Schemat działania:
 * 1. Pobiera wszystkie istniejące oferty z InPost.
 * 2. Buduje mapę: externalId -> offer.id.
 * 3. Dla każdej oferty z inpost-offers.json:
 *    - jeśli externalId istnieje w InPost -> PATCH istniejącej oferty,
 *    - jeśli externalId nie istnieje -> zapisuje do raportu missing.
 *
 * Skrypt NIE waliduje ofert.
 * Jeśli InPost odrzuci ofertę, błąd trafi do raportu.
 *
 * Użycie:
 *   node patch-inpost-offers.js dist/inpost-offers.json dist
 *
 * Tryb testowy bez wysyłki:
 *   node patch-inpost-offers.js dist/inpost-offers.json dist --dry-run
 *
 * Wymagane paczki:
 *   npm install axios dotenv
 */

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const axios = require("axios");

const INPUT_OFFERS_FILE = process.argv[2] || path.join("dist", "inpost-offers.json");
const OUTPUT_DIR = process.argv[3] || "dist";
const DRY_RUN = process.argv.includes("--dry-run");

/**
 * Ważne:
 * Przy wcześniejszym PATCH dostałeś błąd:
 *   Content type 'application/json' not supported
 *
 * Dlatego domyślnie używamy:
 *   application/merge-patch+json
 *
 * Jeśli InPost zaleci Ci inny Content-Type, możesz go ustawić w .env:
 *   INPOST_PATCH_CONTENT_TYPE=application/merge-patch+json
 */
const PATCH_CONTENT_TYPE =
  process.env.INPOST_PATCH_CONTENT_TYPE || "application/merge-patch+json";

const REQUEST_DELAY_MS = Number(process.env.INPOST_REQUEST_DELAY_MS || 150);
const PAGE_LIMIT = Number(process.env.INPOST_OFFERS_PAGE_LIMIT || 100);

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

function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function normalizeText(value) {
  return String(value ?? "")
    .replace(/\r/g, "")
    .replace(/\s+/g, " ")
    .trim();
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

function loadOffers(filePath) {
  const raw = JSON.parse(readFileUtf8(filePath));

  if (Array.isArray(raw)) {
    return raw;
  }

  if (raw && Array.isArray(raw.offers)) {
    return raw.offers;
  }

  throw new Error(
    `Nieprawidłowy format pliku ${filePath}. Oczekuję tablicy ofert albo obiektu { offers: [...] }.`
  );
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

function extractOfferFromListItem(item) {
  /**
   * Wcześniej Twoje GET /offers zwracało strukturę:
   * {
   *   metadata: {...},
   *   offer: {
   *     id,
   *     externalId,
   *     ...
   *   }
   * }
   *
   * Ale zostawiamy też obsługę formatu płaskiego.
   */
  if (item && item.offer) {
    return item.offer;
  }

  return item;
}

function getListItems(responseData) {
  if (Array.isArray(responseData)) {
    return responseData;
  }

  if (responseData && Array.isArray(responseData.data)) {
    return responseData.data;
  }

  if (responseData && responseData.data && Array.isArray(responseData.data.data)) {
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
      updatedAt: offer.updatedAt || null,
      createdAt: offer.createdAt || null,
      raw: offer
    });
  }

  for (const [externalId, offers] of map.entries()) {
    if (offers.length > 1) {
      duplicates.push({
        externalId,
        count: offers.length,
        offerIds: offers.map((offer) => offer.offerId)
      });
    }
  }

  return {
    map,
    duplicates
  };
}

function cleanOfferForPatch(offer) {
  /**
   * Nie walidujemy oferty i nie usuwamy pól biznesowych.
   * Usuwamy tylko pola techniczne, gdyby przypadkiem były w pliku.
   */
  const clean = JSON.parse(JSON.stringify(offer));

  delete clean._meta;
  delete clean.id;
  delete clean.createdAt;
  delete clean.updatedAt;
  delete clean.status;
  delete clean.metadata;

  if (clean.product) {
    delete clean.product._meta;
  }

  return clean;
}

function getExternalIdFromInputOffer(offer) {
  return normalizeText(offer?.externalId);
}

async function patchOffer(offerId, patchPayload) {
  const organizationId = getOrganizationId();

  return inpostRequest(
    "PATCH",
    `/v1/organizations/${encodeURIComponent(organizationId)}/offers/${encodeURIComponent(offerId)}`,
    {
      contentType: PATCH_CONTENT_TYPE,
      data: patchPayload
    }
  );
}

async function main() {
  validateEnv();
  ensureDir(OUTPUT_DIR);

  const inputOffers = loadOffers(INPUT_OFFERS_FILE);

  console.log("Start aktualizacji ofert przez PATCH.");
  console.log(`Plik ofert: ${INPUT_OFFERS_FILE}`);
  console.log(`Katalog raportów: ${OUTPUT_DIR}`);
  console.log(`Tryb testowy --dry-run: ${DRY_RUN ? "TAK" : "NIE"}`);
  console.log(`PATCH Content-Type: ${PATCH_CONTENT_TYPE}`);
  console.log(`Client ID: ${mask(process.env.CLIENT_ID)}`);
  console.log(`Organization ID: ${getOrganizationId()}`);
  console.log(`Oferty w pliku wejściowym: ${inputOffers.length}`);
  console.log("");

  const existingItems = await fetchAllExistingOffers();
  const { map: existingOffersByExternalId, duplicates } =
    buildExistingOffersMap(existingItems);

  console.log("");
  console.log(`Istniejące oferty pobrane z InPost: ${existingItems.length}`);
  console.log(`Unikalne externalId w InPost: ${existingOffersByExternalId.size}`);
  console.log(`Duplikaty externalId w InPost: ${duplicates.length}`);
  console.log("");

  const success = [];
  const errors = [];
  const missing = [];
  const invalidInput = [];
  const dryRunItems = [];

  for (let index = 0; index < inputOffers.length; index++) {
    const inputOffer = inputOffers[index];
    const externalId = getExternalIdFromInputOffer(inputOffer);

    console.log(`[${index + 1}/${inputOffers.length}] externalId=${externalId || "BRAK"}`);

    if (!externalId) {
      invalidInput.push({
        index,
        reason: "Brak externalId w ofercie wejściowej",
        offer: inputOffer
      });

      continue;
    }

    const existingMatches = existingOffersByExternalId.get(externalId);

    if (!existingMatches || existingMatches.length === 0) {
      missing.push({
        externalId,
        reason: "Nie znaleziono istniejącej oferty w InPost po externalId"
      });

      continue;
    }

    const patchPayload = cleanOfferForPatch(inputOffer);

    for (const existing of existingMatches) {
      const itemInfo = {
        externalId,
        offerId: existing.offerId,
        previousStatus: existing.status,
        previousUpdatedAt: existing.updatedAt
      };

      if (DRY_RUN) {
        dryRunItems.push({
          ...itemInfo,
          patchPayload
        });

        console.log(`  DRY RUN: patch offerId=${existing.offerId}`);
        continue;
      }

      const result = await patchOffer(existing.offerId, patchPayload);

      if (result.ok) {
        success.push({
          ...itemInfo,
          status: result.status,
          response: result.data
        });

        console.log(`  OK PATCH offerId=${existing.offerId}, status=${result.status}`);
      } else {
        errors.push({
          ...itemInfo,
          status: result.status,
          error: result.data,
          patchPayload
        });

        console.log(`  BŁĄD PATCH offerId=${existing.offerId}, status=${result.status}`);
      }

      await sleep(REQUEST_DELAY_MS);
    }
  }

  const report = {
    inputOffersFile: INPUT_OFFERS_FILE,
    outputDir: OUTPUT_DIR,
    dryRun: DRY_RUN,
    patchContentType: PATCH_CONTENT_TYPE,
    totals: {
      inputOffers: inputOffers.length,
      existingItemsFetched: existingItems.length,
      uniqueExistingExternalIds: existingOffersByExternalId.size,
      duplicateExternalIdsInInPost: duplicates.length,
      patchedSuccessfully: success.length,
      patchErrors: errors.length,
      missingExistingOffers: missing.length,
      invalidInputOffers: invalidInput.length,
      dryRunItems: dryRunItems.length
    }
  };

  writeJson(path.join(OUTPUT_DIR, "patch-offers-report.json"), report);
  writeJson(path.join(OUTPUT_DIR, "patch-offers-success.json"), success);
  writeJson(path.join(OUTPUT_DIR, "patch-offers-errors.json"), errors);
  writeJson(path.join(OUTPUT_DIR, "patch-offers-missing-existing.json"), missing);
  writeJson(path.join(OUTPUT_DIR, "patch-offers-invalid-input.json"), invalidInput);
  writeJson(path.join(OUTPUT_DIR, "patch-offers-duplicates-in-inpost.json"), duplicates);

  if (DRY_RUN) {
    writeJson(path.join(OUTPUT_DIR, "patch-offers-dry-run.json"), dryRunItems);
  }

  console.log("");
  console.log("Zakończono PATCH ofert.");
  console.log(`Poprawnie zaktualizowane: ${success.length}`);
  console.log(`Błędy PATCH: ${errors.length}`);
  console.log(`Nie znaleziono w InPost po externalId: ${missing.length}`);
  console.log(`Nieprawidłowe rekordy wejściowe: ${invalidInput.length}`);
  console.log(`Duplikaty externalId w InPost: ${duplicates.length}`);
  console.log("");

  console.log("Raporty:");
  console.log(`- ${path.join(OUTPUT_DIR, "patch-offers-report.json")}`);
  console.log(`- ${path.join(OUTPUT_DIR, "patch-offers-success.json")}`);
  console.log(`- ${path.join(OUTPUT_DIR, "patch-offers-errors.json")}`);
  console.log(`- ${path.join(OUTPUT_DIR, "patch-offers-missing-existing.json")}`);
  console.log(`- ${path.join(OUTPUT_DIR, "patch-offers-invalid-input.json")}`);
  console.log(`- ${path.join(OUTPUT_DIR, "patch-offers-duplicates-in-inpost.json")}`);

  if (DRY_RUN) {
    console.log(`- ${path.join(OUTPUT_DIR, "patch-offers-dry-run.json")}`);
  }

  if (errors.length > 0) {
    console.log("");
    console.log("Część ofert odrzucił InPost. Sprawdź patch-offers-errors.json.");
  }

  if (missing.length > 0) {
    console.log("");
    console.log(
      "Część ofert z pliku wejściowego nie istnieje jeszcze w InPost. " +
      "Ten skrypt ich nie tworzy — robi tylko PATCH istniejących ofert."
    );
  }
}

main().catch((error) => {
  console.error("");
  console.error("Błąd krytyczny:");
  console.error(error.response?.data || error.message);
  process.exit(1);
});