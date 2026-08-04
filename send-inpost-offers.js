const fs = require("fs");
const path = require("path");
const axios = require("axios");

const nonFlagArgs = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const INPUT_FILE = nonFlagArgs[0] || "dist/inpost-offers.json";
const IMAGES_FILE = nonFlagArgs[1] || "dist/offer-images.json";
const API_URL = nonFlagArgs[2] || "http://127.0.0.1:3000/api/inpost/offers";

const SYNC_MODE = process.argv.includes("--sync");
const DRY_RUN = process.argv.includes("--dry-run");
const PATCH_ONLY = process.argv.includes("--patch-only");
const CREATE_ONLY = process.argv.includes("--create-only");
const PRESERVE_EXISTING_CATEGORY =
  process.argv.includes("--preserve-existing-categories");

const DELAY_MS = 700;
const MAX_BYTES_PER_OFFER = 240000;
const PAGE_LIMIT = Number(process.env.INPOST_OFFERS_PAGE_LIMIT || 100);
const POST_WRITE_VALIDATION_DELAY_MS = Number(
  process.env.INPOST_POST_WRITE_VALIDATION_DELAY_MS || 1000
);
const COMPARED_TOP_LEVEL_FIELDS = [
  "product",
  "stock",
  "price",
  "affiliationProductUrl"
];
const FULL_PATCH_TOP_LEVEL_FIELDS = new Set(["product", "stock", "price"]);
const TERMINAL_OFFER_STATUSES = new Set([
  "CLOSED",
  "CLOSE",
  "ENDED",
  "ARCHIVED",
  "DELETED",
  "REMOVED"
]);
const PATCH_STATUS_PRIORITY = new Map([
  ["PUBLISHED", 1000],
  ["ACTIVE", 1000],
  ["SOLDOUT", 900],
  ["PENDING", 800],
  ["DRAFT", 700],
  ["INACTIVE", 500],
  ["REJECTED", 100]
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function getByteSize(object) {
  return Buffer.byteLength(JSON.stringify(object), "utf8");
}

function readJson(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) {
    if (fallback !== null) return fallback;
    throw new Error(`Nie znaleziono pliku: ${filePath}`);
  }

  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function normalizeText(value) {
  return String(value ?? "").replace(/\r/g, "").replace(/\s+/g, " ").trim();
}

function normalizeStatus(value) {
  return normalizeText(value).toUpperCase();
}

function isTerminalOfferStatus(status) {
  return TERMINAL_OFFER_STATUSES.has(normalizeStatus(status));
}

function getPatchStatusPriority(status) {
  const normalized = normalizeStatus(status);

  if (PATCH_STATUS_PRIORITY.has(normalized)) {
    return PATCH_STATUS_PRIORITY.get(normalized);
  }

  return 400;
}

function getMatchTimestamp(match) {
  const time = Date.parse(
    match?.rawOffer?.updatedAt ||
    match?.rawOffer?.createdAt ||
    ""
  );

  return Number.isFinite(time) ? time : 0;
}

function summarizeMatch(match) {
  return {
    offerId: match.offerId,
    externalId: match.externalId,
    status: match.status || null,
    name: normalizeText(match.rawOffer?.product?.name),
    ean: normalizeText(match.rawOffer?.product?.ean),
    sku: normalizeText(match.rawOffer?.product?.sku),
    categoryId: normalizeText(match.rawOffer?.product?.categoryId),
    updatedAt: match.rawOffer?.updatedAt || null,
    createdAt: match.rawOffer?.createdAt || null
  };
}

function chooseCanonicalPatchMatch(matches) {
  const patchableMatches = matches.filter(
    (match) => !isTerminalOfferStatus(match.status)
  );

  const selected = [...patchableMatches].sort((left, right) => {
    const priorityDiff =
      getPatchStatusPriority(right.status) - getPatchStatusPriority(left.status);

    if (priorityDiff !== 0) {
      return priorityDiff;
    }

    const timestampDiff = getMatchTimestamp(right) - getMatchTimestamp(left);

    if (timestampDiff !== 0) {
      return timestampDiff;
    }

    return String(left.offerId).localeCompare(String(right.offerId));
  })[0] || null;

  const skipped = matches
    .filter((match) => !selected || match.offerId !== selected.offerId)
    .map((match) => ({
      match,
      reason: isTerminalOfferStatus(match.status)
        ? "terminal-status"
        : "non-canonical-duplicate"
    }));

  return {
    selected,
    skipped
  };
}

function buildSkippedMatchResult(externalId, skipped, selected) {
  return {
    ok: true,
    action: skipped.reason === "terminal-status"
      ? "SKIP_TERMINAL_DUPLICATE"
      : "SKIP_DUPLICATE_NON_CANONICAL",
    externalId,
    offerId: skipped.match.offerId,
    status: skipped.match.status || null,
    skipReason: skipped.reason,
    selectedOfferId: selected?.offerId || null,
    selectedStatus: selected?.status || null,
    changedFields: [],
    changedSubfields: {},
    patchBody: null,
    skippedOffer: summarizeMatch(skipped.match),
    selectedOffer: selected ? summarizeMatch(selected) : null
  };
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function valuesEqual(left, right) {
  return stableJson(left) === stableJson(right);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function compactObject(value) {
  if (!isPlainObject(value)) {
    return value;
  }

  const result = {};

  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) {
      result[key] = compactObject(item);
    }
  }

  return result;
}

function buildDiff(desired, current) {
  if (valuesEqual(desired, current)) {
    return undefined;
  }

  if (!isPlainObject(desired) || !isPlainObject(current)) {
    return desired;
  }

  const diff = {};

  for (const [key, desiredValue] of Object.entries(desired)) {
    const childDiff = buildDiff(desiredValue, current[key]);

    if (childDiff !== undefined) {
      diff[key] = childDiff;
    }
  }

  return Object.keys(diff).length ? diff : undefined;
}

function buildOfferDiff(desiredOffer, currentOffer) {
  const patchBody = {};
  const changedFields = [];
  const changedSubfields = {};

  for (const field of COMPARED_TOP_LEVEL_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(desiredOffer, field)) {
      continue;
    }

    const diff = buildDiff(desiredOffer[field], currentOffer?.[field]);

    if (diff !== undefined) {
      patchBody[field] = FULL_PATCH_TOP_LEVEL_FIELDS.has(field)
        ? compactObject(desiredOffer[field])
        : compactObject(diff);
      changedFields.push(field);
      changedSubfields[field] = diff;
    }
  }

  return {
    patchBody,
    changedFields,
    changedSubfields
  };
}

function validatePatchBody(patchBody) {
  if (patchBody.product && !normalizeText(patchBody.product.name)) {
    throw new Error(
      "PATCH product wymaga product.name, ale payload go nie zawiera. Wygeneruj ponownie dist/inpost-offers.json i uruchom sync jeszcze raz."
    );
  }

  if (
    patchBody.price &&
    (!patchBody.price.grossPrice ||
      patchBody.price.grossPrice.amount === undefined ||
      !patchBody.price.grossPrice.currency)
  ) {
    throw new Error(
      "PATCH price wymaga pelnego price.grossPrice.amount i price.grossPrice.currency."
    );
  }

  if (
    patchBody.stock &&
    (patchBody.stock.quantity === undefined || !patchBody.stock.unit)
  ) {
    throw new Error("PATCH stock wymaga pelnego stock.quantity i stock.unit.");
  }
}

function getOfferId(responseData) {
  return (
    responseData?.offerId ||
    responseData?.data?.offerId ||
    responseData?.data?.id ||
    responseData?.data?.offer?.id ||
    responseData?.id ||
    responseData?.offer?.id ||
    null
  );
}

function shortenOfferIfNeeded(offer) {
  const copy = JSON.parse(JSON.stringify(offer));

  let size = getByteSize(copy);

  if (size <= MAX_BYTES_PER_OFFER) {
    return copy;
  }

  if (copy.product?.description) {
    copy.product.description = copy.product.description.slice(0, 4000).trim();
  }

  size = getByteSize(copy);

  if (size <= MAX_BYTES_PER_OFFER) {
    return copy;
  }

  if (copy.product?.description) {
    copy.product.description = copy.product.description.slice(0, 2000).trim();
  }

  size = getByteSize(copy);

  if (size <= MAX_BYTES_PER_OFFER) {
    return copy;
  }

  if (copy.product?.description) {
    copy.product.description = copy.product.description.slice(0, 1000).trim();
  }

  return copy;
}

async function createOffer(offer) {
  const response = await axios.post(API_URL, offer, {
    headers: {
      "Content-Type": "application/json"
    },
    timeout: 120000,
    maxBodyLength: Infinity,
    maxContentLength: Infinity
  });

  return response.data;
}

async function patchOffer(offerId, patchBody) {
  const response = await axios.patch(
    `${API_URL}/${encodeURIComponent(offerId)}`,
    patchBody,
    {
      headers: {
        "Content-Type": "application/json"
      },
      timeout: 120000,
      maxBodyLength: Infinity,
      maxContentLength: Infinity
    }
  );

  return response.data;
}

async function getOfferDetails(offerId) {
  const response = await axios.get(`${API_URL}/${encodeURIComponent(offerId)}`, {
    timeout: 120000
  });

  return response.data;
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

function getTotalFromResponse(responseData, fallback) {
  const data = responseData?.data || responseData;

  if (data?.page?.total !== undefined) {
    return Number(data.page.total);
  }

  if (data?.data?.page?.total !== undefined) {
    return Number(data.data.page.total);
  }

  return fallback;
}

function extractOfferFromListItem(item) {
  return item?.offer || item;
}

function extractOfferFromDetails(data) {
  if (data?.data?.offer) return data.data.offer;
  if (data?.offer) return data.offer;
  if (data?.data?.data?.offer) return data.data.data.offer;
  if (data?.data?.data?.product) return data.data.data;
  if (data?.data?.product) return data.data;

  return data;
}

function extractMetadataFromDetails(data) {
  if (data?.data?.metadata) return data.data.metadata;
  if (data?.metadata) return data.metadata;
  if (data?.data?.data?.metadata) return data.data.data.metadata;
  if (data?.data?.offer?.metadata) return data.data.offer.metadata;
  if (data?.offer?.metadata) return data.offer.metadata;
  if (data?.data?.data?.offer?.metadata) return data.data.data.offer.metadata;

  return {};
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

function getValidationErrorMessage(error) {
  return normalizeText(
    error?.validationMessage ||
    error?.errorMessage ||
    error?.message ||
    ""
  );
}

function buildValidationState(detailsResponse) {
  const currentOffer = extractOfferFromDetails(detailsResponse);
  const metadata = extractMetadataFromDetails(detailsResponse);
  const validationErrors = extractValidationErrors(metadata);

  return {
    status: currentOffer?.status || null,
    categoryId: currentOffer?.product?.categoryId || null,
    validationErrors,
    referenceCategory:
      extractReferenceCategoryFromValidationErrors(validationErrors)
  };
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

    if (match?.[1]) {
      return {
        categoryId: normalizeText(match[1]),
        validationMessage: message
      };
    }
  }

  return null;
}

function buildReferenceCategoryPatchBody(desiredOffer, categoryId) {
  return {
    product: {
      ...(desiredOffer?.product || {}),
      categoryId
    }
  };
}

function buildValidationErrorPayload(validationState) {
  return {
    message: "InPost zwrocil bledy walidacji po synchronizacji oferty.",
    status: validationState.status,
    categoryId: validationState.categoryId,
    validationErrors: validationState.validationErrors
  };
}

function getFinalValidationState(result) {
  return result.postWriteValidationAfterRepair || result.postWriteValidation || null;
}

function hasFinalValidationErrors(result) {
  return Boolean(getFinalValidationState(result)?.validationErrors?.length);
}

async function getPostWriteValidationState(offerId) {
  if (POST_WRITE_VALIDATION_DELAY_MS > 0) {
    await sleep(POST_WRITE_VALIDATION_DELAY_MS);
  }

  const detailsResponse = await getOfferDetails(offerId);

  return buildValidationState(detailsResponse);
}

async function validateAndRepairAfterWrite(result, desiredOffer, stage) {
  const validationState = await getPostWriteValidationState(result.offerId);

  result.postWriteValidation = validationState;

  const referenceCategory = validationState.referenceCategory;
  const desiredCategoryId = normalizeText(desiredOffer?.product?.categoryId);

  if (
    referenceCategory?.categoryId &&
    referenceCategory.categoryId !== desiredCategoryId
  ) {
    const patchBody = buildReferenceCategoryPatchBody(
      desiredOffer,
      referenceCategory.categoryId
    );

    validatePatchBody(patchBody);

    console.log(
      `Korekta kategorii referencyjnej po ${stage} externalId=${result.externalId}, offerId=${result.offerId}`
    );

    const patchResponse = await patchOffer(result.offerId, patchBody);

    result.postWriteReferenceCategoryOverride = {
      csvCategoryId: desiredCategoryId || null,
      inpostReferenceCategoryId: referenceCategory.categoryId,
      validationMessage: referenceCategory.validationMessage,
      stage
    };
    result.postWriteCategoryPatchBody = patchBody;
    result.postWriteCategoryPatchResponse = patchResponse;
    result.changedFields = Array.from(new Set([
      ...(result.changedFields || []),
      "product"
    ]));

    const validationAfterRepair =
      await getPostWriteValidationState(result.offerId);

    result.postWriteValidationAfterRepair = validationAfterRepair;

    if (validationAfterRepair.validationErrors.length) {
      result.ok = false;
      result.error = buildValidationErrorPayload(validationAfterRepair);
    }

    return;
  }

  if (validationState.validationErrors.length) {
    result.ok = false;
    result.error = buildValidationErrorPayload(validationState);
  }
}

function applyInpostReferenceCategory(desiredOffer, detailsResponse) {
  const metadata = extractMetadataFromDetails(detailsResponse);
  const validationErrors = extractValidationErrors(metadata);
  const referenceCategory =
    extractReferenceCategoryFromValidationErrors(validationErrors);

  if (
    !referenceCategory?.categoryId ||
    desiredOffer?.product?.categoryId === referenceCategory.categoryId
  ) {
    return {
      offer: desiredOffer,
      referenceCategory: null
    };
  }

  const adjustedOffer = JSON.parse(JSON.stringify(desiredOffer));

  adjustedOffer.product = {
    ...(adjustedOffer.product || {}),
    categoryId: referenceCategory.categoryId
  };

  return {
    offer: adjustedOffer,
    referenceCategory
  };
}

function applyExistingCategoryPolicy(desiredOffer, currentOffer, detailsResponse) {
  const {
    offer: referenceAdjustedOffer,
    referenceCategory
  } = applyInpostReferenceCategory(desiredOffer, detailsResponse);

  if (referenceCategory || !PRESERVE_EXISTING_CATEGORY) {
    return {
      offer: referenceAdjustedOffer,
      referenceCategory,
      preservedCategory: null
    };
  }

  const currentCategoryId = normalizeText(currentOffer?.product?.categoryId);
  const desiredCategoryId = normalizeText(referenceAdjustedOffer?.product?.categoryId);

  if (!currentCategoryId || currentCategoryId === desiredCategoryId) {
    return {
      offer: referenceAdjustedOffer,
      referenceCategory: null,
      preservedCategory: null
    };
  }

  const adjustedOffer = JSON.parse(JSON.stringify(referenceAdjustedOffer));

  adjustedOffer.product = {
    ...(adjustedOffer.product || {}),
    categoryId: currentCategoryId
  };

  return {
    offer: adjustedOffer,
    referenceCategory: null,
    preservedCategory: {
      csvCategoryId: desiredCategoryId || null,
      preservedInpostCategoryId: currentCategoryId
    }
  };
}

async function fetchAllExistingOffers() {
  const allItems = [];
  let offset = 0;
  let total = null;

  while (true) {
    const response = await axios.get(API_URL, {
      params: {
        limit: PAGE_LIMIT,
        offset
      },
      timeout: 120000
    });

    const items = getListItems(response.data);
    allItems.push(...items);
    total = getTotalFromResponse(response.data, allItems.length);

    console.log(
      `Pobrano oferty z InPost: ${allItems.length}${total !== null ? ` / ${total}` : ""}`
    );

    if (!items.length) break;

    offset += PAGE_LIMIT;

    if (total !== null && allItems.length >= total) break;

    await sleep(DELAY_MS);
  }

  return allItems;
}

function buildExistingOffersByExternalId(items) {
  const map = new Map();
  const duplicates = [];

  for (const item of items) {
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
      rawOffer: offer
    });
  }

  for (const [externalId, offers] of map.entries()) {
    if (offers.length > 1) {
      const { selected, skipped } = chooseCanonicalPatchMatch(offers);

      duplicates.push({
        externalId,
        count: offers.length,
        offerIds: offers.map((offer) => offer.offerId),
        statuses: offers.map((offer) => offer.status),
        selectedPatchOfferId: selected?.offerId || null,
        selectedPatchStatus: selected?.status || null,
        skippedBySync: skipped.map((item) => ({
          reason: item.reason,
          ...summarizeMatch(item.match)
        }))
      });
    }
  }

  return {
    map,
    duplicates
  };
}

async function uploadImageFromUrl(offerId, externalId, imageUrl) {
  const url = `${API_URL}/${encodeURIComponent(offerId)}/attachments/from-url`;

  const response = await axios.post(
    url,
    {
      imageUrl,
      externalId,
      attachmentType: "IMAGE"
    },
    {
      headers: {
        "Content-Type": "application/json"
      },
      timeout: 180000,
      maxBodyLength: Infinity,
      maxContentLength: Infinity
    }
  );

  return response.data;
}

function shouldSkipExisting(results, externalId) {
  return results.some((item) => item.externalId === externalId && item.ok === true);
}

async function createOfferWithImage(originalOffer, imageMap, index, total) {
  const externalId = String(originalOffer.externalId || "").trim();
  const imageUrls = imageMap[externalId] || [];
  const firstImageUrl = imageUrls[0];
  const result = {
    ok: false,
    action: "CREATE",
    externalId,
    offerId: null,
    size: null,
    imageUrl: null,
    offerResponse: null,
    imageResponse: null,
    postWriteValidation: null,
    postWriteReferenceCategoryOverride: null,
    postWriteValidationAfterRepair: null,
    error: null
  };

  if (!externalId) {
    throw new Error("Oferta nie ma externalId.");
  }

  if (!firstImageUrl) {
    throw new Error("Brak zdjecia w dist/offer-images.json dla tej oferty.");
  }

  const offer = shortenOfferIfNeeded(originalOffer);
  const size = getByteSize(offer);

  result.size = size;
  result.imageUrl = firstImageUrl;

  console.log(`[${index + 1}/${total}] Tworze oferte externalId=${externalId}, size=${size} B`);

  if (size > MAX_BYTES_PER_OFFER) {
    throw new Error(`Oferta nadal jest za duza: ${size} B. Trzeba skrocic opis lub usunac dodatkowe pola.`);
  }

  const offerResponse = await createOffer(offer);
  result.offerResponse = offerResponse;

  const offerId = getOfferId(offerResponse);

  if (!offerId) {
    throw new Error(`Nie udalo sie odczytac offerId z odpowiedzi: ${JSON.stringify(offerResponse)}`);
  }

  result.offerId = offerId;

  console.log(`OK oferta externalId=${externalId}, offerId=${offerId}`);
  console.log(`Dodaje zdjecie: ${firstImageUrl}`);

  const imageResponse = await uploadImageFromUrl(offerId, externalId, firstImageUrl);

  result.imageResponse = imageResponse;
  result.ok = true;

  console.log(`OK zdjecie externalId=${externalId}`);

  await validateAndRepairAfterWrite(result, offer, "CREATE");

  return result;
}

async function syncOffer(originalOffer, imageMap, existingOffersByExternalId, index, total) {
  const externalId = String(originalOffer.externalId || "").trim();
  const matches = existingOffersByExternalId.get(externalId) || [];
  const results = [];

  if (!externalId) {
    throw new Error("Oferta nie ma externalId.");
  }

  if (!matches.length) {
    if (DRY_RUN) {
      return [{
        ok: true,
        action: "DRY_RUN_CREATE",
        externalId,
        offerId: null,
        changedFields: ["create"],
        patchBody: originalOffer
      }];
    }

    if (PATCH_ONLY) {
      return [{
        ok: true,
        action: "SKIP_MISSING_PATCH_ONLY",
        externalId,
        offerId: null,
        changedFields: [],
        patchBody: null
      }];
    }

    return [await createOfferWithImage(originalOffer, imageMap, index, total)];
  }

  if (CREATE_ONLY) {
    return [{
      ok: true,
      action: "SKIP_EXISTING_CREATE_ONLY",
      externalId,
      offerId: matches[0]?.offerId || null,
      changedFields: [],
      patchBody: null,
      existingOffers: matches.map(summarizeMatch)
    }];
  }

  const { selected, skipped } = chooseCanonicalPatchMatch(matches);

  for (const skippedMatch of skipped) {
    const skipResult = buildSkippedMatchResult(
      externalId,
      skippedMatch,
      selected
    );

    results.push(skipResult);

    console.log(
      `[${index + 1}/${total}] Pomijam duplikat externalId=${externalId}, offerId=${skippedMatch.match.offerId}, status=${skippedMatch.match.status || ""}, reason=${skippedMatch.reason}`
    );
  }

  if (!selected) {
    results.push({
      ok: true,
      action: "SKIP_ONLY_TERMINAL_MATCHES",
      externalId,
      offerId: null,
      changedFields: [],
      changedSubfields: {},
      patchBody: null,
      skippedOffers: matches.map(summarizeMatch),
      skipReason: "only-terminal-matches"
    });

    console.log(
      `[${index + 1}/${total}] Pomijam externalId=${externalId}, bo wszystkie dopasowane oferty sa zamkniete/terminalne`
    );

    return results;
  }

  for (const match of [selected]) {
    const result = {
      ok: false,
      action: "PATCH",
      externalId,
      offerId: match.offerId,
      changedFields: [],
      changedSubfields: {},
      patchBody: null,
      inpostReferenceCategoryOverride: null,
      inpostCurrentCategoryPreserved: null,
      patchResponse: null,
      postWriteValidation: null,
      postWriteReferenceCategoryOverride: null,
      postWriteValidationAfterRepair: null,
      error: null
    };

    const detailsResponse = await getOfferDetails(match.offerId);
    const currentOffer = extractOfferFromDetails(detailsResponse);
    const {
      offer: desiredOffer,
      referenceCategory,
      preservedCategory
    } = applyExistingCategoryPolicy(
      originalOffer,
      currentOffer,
      detailsResponse
    );
    result.inpostReferenceCategoryOverride = referenceCategory
      ? {
          csvCategoryId: originalOffer?.product?.categoryId || null,
          inpostReferenceCategoryId: referenceCategory.categoryId,
          validationMessage: referenceCategory.validationMessage
        }
      : null;
    result.inpostCurrentCategoryPreserved = preservedCategory;

    const {
      patchBody,
      changedFields,
      changedSubfields
    } = buildOfferDiff(desiredOffer, currentOffer);

    result.changedFields = changedFields;
    result.changedSubfields = changedSubfields;
    result.patchBody = patchBody;

    if (!changedFields.length) {
      result.ok = true;
      result.action = "NO_CHANGES";
      console.log(`[${index + 1}/${total}] Bez zmian externalId=${externalId}, offerId=${match.offerId}`);
      results.push(result);
      continue;
    }

    console.log(
      `[${index + 1}/${total}] PATCH externalId=${externalId}, offerId=${match.offerId}, fields=${changedFields.join(",")}`
    );

    validatePatchBody(patchBody);

    if (DRY_RUN) {
      result.ok = true;
      result.action = "DRY_RUN_PATCH";
      results.push(result);
      continue;
    }

    const patchResponse = await patchOffer(match.offerId, patchBody);

    result.patchResponse = patchResponse;
    result.ok = true;

    await validateAndRepairAfterWrite(result, desiredOffer, "PATCH");

    results.push(result);
  }

  return results;
}

function writeSyncReports(syncReportPath, syncErrorsPath, context) {
  const {
    offers,
    existingItems,
    existingOffersByExternalId,
    duplicates,
    syncResults
  } = context;

  const report = {
    inputFile: INPUT_FILE,
    imagesFile: IMAGES_FILE,
    apiUrl: API_URL,
    dryRun: DRY_RUN,
    patchOnly: PATCH_ONLY,
    createOnly: CREATE_ONLY,
    comparedTopLevelFields: COMPARED_TOP_LEVEL_FIELDS,
    totals: {
      offersInFile: offers.length,
      existingItemsFetched: existingItems.length,
      existingExternalIds: existingOffersByExternalId.size,
      duplicateExternalIdsInInPost: duplicates.length,
      created: syncResults.filter((item) => item.action === "CREATE" && item.ok).length,
      patched: syncResults.filter((item) => item.action === "PATCH" && item.ok).length,
      noChanges: syncResults.filter((item) => item.action === "NO_CHANGES").length,
      dryRunCreate: syncResults.filter((item) => item.action === "DRY_RUN_CREATE").length,
      dryRunPatch: syncResults.filter((item) => item.action === "DRY_RUN_PATCH").length,
      skippedExistingCreateOnly: syncResults.filter(
        (item) => item.action === "SKIP_EXISTING_CREATE_ONLY"
      ).length,
      skippedTerminalDuplicates: syncResults.filter(
        (item) => item.action === "SKIP_TERMINAL_DUPLICATE"
      ).length,
      skippedNonCanonicalDuplicates: syncResults.filter(
        (item) => item.action === "SKIP_DUPLICATE_NON_CANONICAL"
      ).length,
      skippedOnlyTerminalMatches: syncResults.filter(
        (item) => item.action === "SKIP_ONLY_TERMINAL_MATCHES"
      ).length,
      inpostReferenceCategoryOverrides: syncResults.filter(
        (item) =>
          item.inpostReferenceCategoryOverride ||
          item.postWriteReferenceCategoryOverride
      ).length,
      inpostCurrentCategoryPreserved: syncResults.filter(
        (item) => item.inpostCurrentCategoryPreserved
      ).length,
      postWriteValidationErrors: syncResults.filter(hasFinalValidationErrors).length,
      errors: syncResults.filter((item) => !item.ok).length
    },
    duplicateExternalIdsInInPost: duplicates,
    results: syncResults
  };

  writeJson(syncReportPath, report);
  writeJson(syncErrorsPath, {
    summary: {
      errors: report.totals.errors,
      duplicateExternalIdsInInPost: duplicates.length,
      skippedTerminalDuplicates: report.totals.skippedTerminalDuplicates,
      skippedNonCanonicalDuplicates: report.totals.skippedNonCanonicalDuplicates,
      skippedOnlyTerminalMatches: report.totals.skippedOnlyTerminalMatches
    },
    errors: syncResults.filter((item) => !item.ok),
    validationErrors: syncResults.filter(hasFinalValidationErrors),
    duplicateExternalIdsInInPost: duplicates,
    skippedDuplicates: syncResults.filter((item) =>
      [
        "SKIP_TERMINAL_DUPLICATE",
        "SKIP_DUPLICATE_NON_CANONICAL",
        "SKIP_ONLY_TERMINAL_MATCHES"
      ].includes(item.action)
    ),
    patchPlannedOrApplied: syncResults.filter((item) =>
      ["PATCH", "DRY_RUN_PATCH"].includes(item.action)
    )
  });
}

async function main() {
  ensureDir("dist");

  const offers = readJson(INPUT_FILE);
  const imageMap = readJson(IMAGES_FILE, {});

  if (!Array.isArray(offers)) {
    throw new Error("Plik ofert musi zawierać tablicę, np. dist/inpost-offers.json");
  }

  const resultsPath = path.join("dist", "send-results.json");
  const results = fs.existsSync(resultsPath) ? readJson(resultsPath, []) : [];

  console.log(`Liczba ofert w pliku: ${offers.length}`);
  console.log(`Plik ofert: ${INPUT_FILE}`);
  console.log(`Plik zdjęć: ${IMAGES_FILE}`);
  console.log(`Endpoint lokalny: ${API_URL}`);
  console.log(`Tryb sync: ${SYNC_MODE ? "TAK" : "NIE"}`);
  console.log(`Dry run: ${DRY_RUN ? "TAK" : "NIE"}`);
  console.log("");

  if (SYNC_MODE) {
    const syncReportPath = path.join("dist", "send-sync-report.json");
    const syncErrorsPath = path.join("dist", "send-sync-errors.json");
    const existingItems = await fetchAllExistingOffers();
    const {
      map: existingOffersByExternalId,
      duplicates
    } = buildExistingOffersByExternalId(existingItems);
    const syncResults = [];

    for (let i = 0; i < offers.length; i++) {
      const originalOffer = offers[i];
      const externalId = String(originalOffer.externalId || "").trim();

      try {
        const offerResults = await syncOffer(
          originalOffer,
          imageMap,
          existingOffersByExternalId,
          i,
          offers.length
        );

        syncResults.push(...offerResults);

        for (const result of offerResults) {
          if (result.action === "CREATE" && result.ok && result.offerId) {
            if (!existingOffersByExternalId.has(result.externalId)) {
              existingOffersByExternalId.set(result.externalId, []);
            }

            existingOffersByExternalId.get(result.externalId).push({
              offerId: result.offerId,
              externalId: result.externalId,
              status: "CREATED_IN_THIS_RUN",
              rawOffer: originalOffer
            });
          }
        }
      } catch (error) {
        const errorData = error.response?.data || error.message;

        syncResults.push({
          ok: false,
          action: "SYNC_ERROR",
          externalId,
          offerId: null,
          changedFields: [],
          patchBody: null,
          error: errorData
        });

        console.log(`BLAD sync externalId=${externalId}`);
        console.log(JSON.stringify(errorData, null, 2));
      }

      writeSyncReports(syncReportPath, syncErrorsPath, {
        offers,
        existingItems,
        existingOffersByExternalId,
        duplicates,
        syncResults
      });

      const latestResult = syncResults[syncResults.length - 1];
      const skippedExistingInCreateOnly =
        CREATE_ONLY &&
        latestResult?.action === "SKIP_EXISTING_CREATE_ONLY";

      if (!skippedExistingInCreateOnly) {
        await sleep(DELAY_MS);
      }
    }

    const created = syncResults.filter((item) => item.action === "CREATE" && item.ok).length;
    const patched = syncResults.filter((item) => item.action === "PATCH" && item.ok).length;
    const noChanges = syncResults.filter((item) => item.action === "NO_CHANGES").length;
    const dryRunCreate = syncResults.filter((item) => item.action === "DRY_RUN_CREATE").length;
    const dryRunPatch = syncResults.filter((item) => item.action === "DRY_RUN_PATCH").length;
    const failed = syncResults.filter((item) => !item.ok).length;

    console.log("");
    console.log("Gotowe sync.");
    console.log(`Utworzone: ${created}`);
    console.log(`Zaktualizowane PATCH: ${patched}`);
    console.log(`Bez zmian: ${noChanges}`);
    console.log(`Dry-run create: ${dryRunCreate}`);
    console.log(`Dry-run PATCH: ${dryRunPatch}`);
    console.log(`Bledy: ${failed}`);
    console.log(`Raport: ${syncReportPath}`);
    console.log(`Bledy/plan: ${syncErrorsPath}`);
    return;
  }

  for (let i = 0; i < offers.length; i++) {
    const originalOffer = offers[i];
    const externalId = String(originalOffer.externalId || "").trim();

    const result = {
      ok: false,
      externalId,
      offerId: null,
      size: null,
      imageUrl: null,
      offerResponse: null,
      imageResponse: null,
      error: null
    };

    try {
      if (!externalId) {
        throw new Error("Oferta nie ma externalId.");
      }

      if (shouldSkipExisting(results, externalId)) {
        console.log(`[${i + 1}/${offers.length}] Pomijam externalId=${externalId}, bo już ma status OK w send-results.json`);
        continue;
      }

      const imageUrls = imageMap[externalId] || [];
      const firstImageUrl = imageUrls[0];

      if (!firstImageUrl) {
        throw new Error("Brak zdjęcia w dist/offer-images.json dla tej oferty.");
      }

      const offer = shortenOfferIfNeeded(originalOffer);
      const size = getByteSize(offer);

      result.size = size;
      result.imageUrl = firstImageUrl;

      console.log(`[${i + 1}/${offers.length}] Tworzę ofertę externalId=${externalId}, size=${size} B`);

      if (size > MAX_BYTES_PER_OFFER) {
        throw new Error(`Oferta nadal jest za duża: ${size} B. Trzeba skrócić opis lub usunąć dodatkowe pola.`);
      }

      const offerResponse = await createOffer(offer);
      result.offerResponse = offerResponse;

      const offerId = getOfferId(offerResponse);

      if (!offerId) {
        throw new Error(`Nie udało się odczytać offerId z odpowiedzi: ${JSON.stringify(offerResponse)}`);
      }

      result.offerId = offerId;

      console.log(`OK oferta externalId=${externalId}, offerId=${offerId}`);
      console.log(`Dodaję zdjęcie: ${firstImageUrl}`);

      const imageResponse = await uploadImageFromUrl(offerId, externalId, firstImageUrl);

      result.imageResponse = imageResponse;
      result.ok = true;

      console.log(`OK zdjęcie externalId=${externalId}`);
    } catch (error) {
      const errorData = error.response?.data || error.message;

      result.ok = false;
      result.error = errorData;

      console.log(`BŁĄD externalId=${externalId}`);
      console.log(JSON.stringify(errorData, null, 2));
    }

    results.push(result);

    fs.writeFileSync(
      resultsPath,
      JSON.stringify(results, null, 2),
      "utf8"
    );

    await sleep(DELAY_MS);
  }

  const success = results.filter((item) => item.ok).length;
  const failed = results.filter((item) => !item.ok).length;

  console.log("");
  console.log("Gotowe.");
  console.log(`Sukces: ${success}`);
  console.log(`Błędy: ${failed}`);
  console.log(`Raport: ${resultsPath}`);
}

main().catch((error) => {
  console.error("Błąd skryptu:");
  console.error(error.message);
});
