#!/usr/bin/env node

/**
 * cleanup-inpost-duplicate-offers.js
 *
 * Usuwa albo zamyka zduplikowane oferty InPost Buy.
 *
 * Logika:
 * 1. Pobiera wszystkie oferty z InPost.
 * 2. Grupuje po externalId.
 * 3. Dla każdego externalId zostawia jedną najlepszą ofertę.
 * 4. Pozostałe duplikaty próbuje:
 *    - najpierw DELETE,
 *    - jeśli DELETE się nie uda, POST /close.
 *
 * Domyślnie działa w trybie raportu i niczego nie zmienia.
 *
 * Test / raport bez zmian w InPost:
 *   node cleanup-inpost-duplicate-offers.js dist
 *
 * Właściwe wykonanie:
 *   node cleanup-inpost-duplicate-offers.js dist --execute
 *
 * Tylko zamykanie, bez próby DELETE:
 *   node cleanup-inpost-duplicate-offers.js dist --execute --close-only
 *
 * Wymagane:
 *   npm install axios dotenv
 */

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const crypto = require("crypto");

const OUTPUT_DIR = process.argv[2] && !process.argv[2].startsWith("--")
  ? process.argv[2]
  : "dist";

const EXECUTE = process.argv.includes("--execute");
const CLOSE_ONLY = process.argv.includes("--close-only");

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

const CLOSED_STATUSES = new Set([
  "CLOSED",
  "CLOSE",
  "ENDED",
  "ARCHIVED",
  "DELETED",
  "REMOVED",
  "INACTIVE"
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

function getRequestId() {
  return crypto.randomUUID();
}

function isClosedStatus(status) {
  return CLOSED_STATUSES.has(normalizeText(status).toUpperCase());
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

  if (!isClosedStatus(status)) {
    score += 1000;
  }

  if (validationCount === 0) {
    score += 500;
  } else {
    score -= Math.min(validationCount, 20) * 50;
  }

  if (!normalizedOffer.hasCategoryIncorrect) {
    score += 100;
  }

  if (normalizedOffer.categoryId) {
    score += 50;
  }

  if (normalizedOffer.ean) {
    score += 20;
  }

  if (normalizedOffer.sku) {
    score += 10;
  }

  /**
   * Mały bonus za nowszą ofertę.
   * Nie może przeważyć nad brakiem błędów albo statusem.
   */
  const updatedAtScore = Math.floor(toTimestamp(normalizedOffer.updatedAt) / 1000000000);
  score += updatedAtScore;

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
    hasCategoryIncorrect: hasCategoryIncorrect(validationErrors),
    raw: offer
  };

  normalized.score = getOfferScore(normalized);

  return normalized;
}

function chooseKeeper(offers) {
  const sorted = [...offers].sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }

    return toTimestamp(b.updatedAt) - toTimestamp(a.updatedAt);
  });

  return sorted[0];
}

function buildDuplicateGroups(items) {
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
      keeper: summarizeOffer(keeper),
      duplicatesToCleanup: duplicatesToCleanup.map(summarizeOffer),
      allOffers: offers
        .sort((a, b) => b.score - a.score)
        .map(summarizeOffer)
    });

    for (const duplicate of duplicatesToCleanup) {
      plannedActions.push({
        externalId,
        action: CLOSE_ONLY ? "CLOSE" : "DELETE_THEN_CLOSE_FALLBACK",
        offerToKeep: summarizeOffer(keeper),
        offerToCleanup: summarizeOffer(duplicate)
      });
    }
  }

  return {
    duplicateGroups,
    plannedActions,
    skippedWithoutExternalId
  };
}

function summarizeOffer(offer) {
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

async function executeCleanup(plannedActions) {
  const success = [];
  const errors = [];
  const skippedAlreadyClosed = [];

  for (let i = 0; i < plannedActions.length; i++) {
    const action = plannedActions[i];
    const offer = action.offerToCleanup;
    const offerId = offer.offerId;

    console.log(
      `[${i + 1}/${plannedActions.length}] externalId=${action.externalId}, duplicateOfferId=${offerId}`
    );

    if (isClosedStatus(offer.status)) {
      if (CLOSE_ONLY) {
        skippedAlreadyClosed.push({
          ...action,
          result: "SKIPPED_ALREADY_CLOSED"
        });

        console.log("  Pominięto: oferta już zamknięta/nieaktywna.");
        continue;
      }
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
        `  DELETE nieudany, status=${deleteResult.status}. Próba zamknięcia...`
      );

      await sleep(REQUEST_DELAY_MS);
    }

    if (isClosedStatus(offer.status)) {
      skippedAlreadyClosed.push({
        ...action,
        result: "DELETE_FAILED_BUT_ALREADY_CLOSED",
        deleteStatus: deleteResult?.status || null,
        deleteError: deleteResult?.data || null,
        requestId: deleteResult?.requestId || null
      });

      console.log("  Oferta już zamknięta. Nie wykonuję /close.");
      continue;
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

      console.log(`  BŁĄD CLOSE, status=${closeResult.status}`);
    }

    await sleep(REQUEST_DELAY_MS);
  }

  return {
    success,
    errors,
    skippedAlreadyClosed
  };
}

async function main() {
  validateEnv();
  ensureDir(OUTPUT_DIR);

  console.log("Start porządkowania zduplikowanych ofert InPost.");
  console.log(`Katalog raportów: ${OUTPUT_DIR}`);
  console.log(`Tryb wykonania zmian: ${EXECUTE ? "TAK" : "NIE, tylko raport"}`);
  console.log(`Tryb tylko zamykania --close-only: ${CLOSE_ONLY ? "TAK" : "NIE"}`);
  console.log(`Client ID: ${mask(process.env.CLIENT_ID)}`);
  console.log(`Organization ID: ${getOrganizationId()}`);
  console.log("");

  const allItems = await fetchAllOffers();

  const {
    duplicateGroups,
    plannedActions,
    skippedWithoutExternalId
  } = buildDuplicateGroups(allItems);

  writeJson(path.join(OUTPUT_DIR, "duplicate-offers-groups.json"), duplicateGroups);
  writeJson(path.join(OUTPUT_DIR, "duplicate-offers-planned-actions.json"), plannedActions);
  writeJson(path.join(OUTPUT_DIR, "duplicate-offers-without-external-id.json"), skippedWithoutExternalId);

  const baseReport = {
    outputDir: OUTPUT_DIR,
    execute: EXECUTE,
    closeOnly: CLOSE_ONLY,
    totals: {
      allFetchedItems: allItems.length,
      duplicateExternalIdGroups: duplicateGroups.length,
      plannedDuplicateActions: plannedActions.length,
      skippedWithoutExternalId: skippedWithoutExternalId.length
    },
    rules: {
      grouping: "externalId",
      cleanup: CLOSE_ONLY ? "POST /close only" : "DELETE first, fallback POST /close",
      keeperSelection:
        "Keep highest score: active/non-closed status, no validation errors, no CATEGORY_INCORRECT, has categoryId/EAN/SKU, newest updatedAt"
    }
  };

  if (!EXECUTE) {
    writeJson(path.join(OUTPUT_DIR, "duplicate-offers-report.json"), {
      ...baseReport,
      mode: "DRY_RUN_REPORT_ONLY"
    });

    console.log("");
    console.log("Raport gotowy. Nic nie zostało zmienione w InPost.");
    console.log(`Grupy duplikatów externalId: ${duplicateGroups.length}`);
    console.log(`Planowane oferty do usunięcia/zamknięcia: ${plannedActions.length}`);
    console.log("");
    console.log("Sprawdź pliki:");
    console.log(`- ${path.join(OUTPUT_DIR, "duplicate-offers-groups.json")}`);
    console.log(`- ${path.join(OUTPUT_DIR, "duplicate-offers-planned-actions.json")}`);
    console.log("");
    console.log("Jeżeli plan wygląda poprawnie, uruchom:");
    console.log(`node cleanup-inpost-duplicate-offers.js ${OUTPUT_DIR} --execute`);

    return;
  }

  const {
    success,
    errors,
    skippedAlreadyClosed
  } = await executeCleanup(plannedActions);

  const finalReport = {
    ...baseReport,
    mode: "EXECUTED",
    results: {
      success: success.length,
      errors: errors.length,
      skippedAlreadyClosed: skippedAlreadyClosed.length
    }
  };

  writeJson(path.join(OUTPUT_DIR, "duplicate-offers-report.json"), finalReport);
  writeJson(path.join(OUTPUT_DIR, "duplicate-offers-success.json"), success);
  writeJson(path.join(OUTPUT_DIR, "duplicate-offers-errors.json"), errors);
  writeJson(path.join(OUTPUT_DIR, "duplicate-offers-skipped-already-closed.json"), skippedAlreadyClosed);

  console.log("");
  console.log("Zakończono porządkowanie duplikatów.");
  console.log(`Sukces: ${success.length}`);
  console.log(`Błędy: ${errors.length}`);
  console.log(`Pominięte jako już zamknięte: ${skippedAlreadyClosed.length}`);
  console.log("");
  console.log("Raporty:");
  console.log(`- ${path.join(OUTPUT_DIR, "duplicate-offers-report.json")}`);
  console.log(`- ${path.join(OUTPUT_DIR, "duplicate-offers-success.json")}`);
  console.log(`- ${path.join(OUTPUT_DIR, "duplicate-offers-errors.json")}`);
  console.log(`- ${path.join(OUTPUT_DIR, "duplicate-offers-skipped-already-closed.json")}`);

  if (errors.length > 0) {
    console.log("");
    console.log("Część ofert nie została usunięta ani zamknięta. Sprawdź duplicate-offers-errors.json.");
  }
}

main().catch((error) => {
  console.error("");
  console.error("Błąd krytyczny:");
  console.error(error.response?.data || error.message);
  process.exit(1);
});