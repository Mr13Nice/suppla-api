require("dotenv").config();

const fs = require("fs");
const path = require("path");
const axios = require("axios");

const REQUIRED_ENV = [
  "CLIENT_ID",
  "CLIENT_SECRET",
  "INPOST_SCOPE",
  "INPOST_TOKEN_URL",
  "INPOST_BUY_API_BASE",
  "ORGANIZATION_ID"
];

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    throw new Error(`Brakuje zmiennej środowiskowej: ${key}`);
  }
}

const args = process.argv.slice(2);

function hasFlag(flag) {
  return args.includes(flag);
}

function getArgValue(name, fallback = null) {
  const index = args.indexOf(name);

  if (index === -1) {
    return fallback;
  }

  return args[index + 1] || fallback;
}

const EXECUTE = hasFlag("--execute");
const MODE = getArgValue("--mode", "invalid");
const KEEP_FILE = getArgValue("--keep", "keep-external-ids.json");
const BAD_FILE = getArgValue("--bad", "bad-external-ids.json");
const OUTPUT_DIR = getArgValue("--out", "dist");
const LIMIT = Number(getArgValue("--limit", "50"));

let tokenCache = {
  accessToken: null,
  expiresAt: 0
};

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJsonIfExists(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }

  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function normalizeIdList(value) {
  if (Array.isArray(value)) {
    return value.map(String);
  }

  if (value && Array.isArray(value.externalIds)) {
    return value.externalIds.map(String);
  }

  return [];
}

function mask(value) {
  if (!value) return "";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
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
  tokenCache.expiresAt = Date.now() + (expires_in - 30) * 1000;

  return access_token;
}

async function inpostRequest(method, pathUrl, options = {}) {
  const token = await getAccessToken();

  const response = await axios({
    method,
    url: `${process.env.INPOST_BUY_API_BASE}${pathUrl}`,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "Accept-Language": "pl"
    },
    params: options.params,
    data: options.data
  });

  return response.data;
}

async function getAllOffers() {
  const organizationId = process.env.ORGANIZATION_ID;
  const all = [];

  let offset = 0;
  let total = null;

  while (total === null || offset < total) {
    const data = await inpostRequest(
      "GET",
      `/v1/organizations/${encodeURIComponent(organizationId)}/offers`,
      {
        params: {
          limit: LIMIT,
          offset
        }
      }
    );

    const page = data.page || {};
    const items = data.data || [];

    all.push(...items);

    total = Number(page.total ?? all.length);
    offset += Number(page.limit ?? LIMIT);

    if (!items.length) {
      break;
    }
  }

  return all;
}

function getOfferObject(item) {
  return item.offer || item;
}

function getValidationErrors(item) {
  return item.metadata?.validationErrors || [];
}

function shouldCloseOffer(item, keepExternalIds, badExternalIds) {
  const offer = getOfferObject(item);
  const externalId = String(offer.externalId || "");
  const validationErrors = getValidationErrors(item);

  if (!offer.id) {
    return {
      close: false,
      reason: "Brak offer.id"
    };
  }

  if (MODE === "invalid") {
    return {
      close: validationErrors.length > 0,
      reason: validationErrors.length > 0
        ? "Oferta ma validationErrors"
        : "Oferta bez validationErrors"
    };
  }

  if (MODE === "all-except-keep") {
    return {
      close: !keepExternalIds.has(externalId),
      reason: keepExternalIds.has(externalId)
        ? "externalId jest na liście poprawnych ofert"
        : "externalId nie jest na liście poprawnych ofert"
    };
  }

  if (MODE === "external-ids") {
    return {
      close: badExternalIds.has(externalId),
      reason: badExternalIds.has(externalId)
        ? "externalId jest na liście błędnych ofert"
        : "externalId nie jest na liście błędnych ofert"
    };
  }

  throw new Error(
    `Nieznany tryb: ${MODE}. Użyj: invalid, all-except-keep albo external-ids`
  );
}

async function closeOffer(offerId) {
  const organizationId = process.env.ORGANIZATION_ID;

  return inpostRequest(
    "POST",
    `/v1/organizations/${encodeURIComponent(organizationId)}/offers/${encodeURIComponent(offerId)}/close`
  );
}

async function main() {
  ensureDir(OUTPUT_DIR);

  console.log("Tryb:", MODE);
  console.log(EXECUTE ? "UWAGA: tryb wykonania --execute" : "Tryb testowy: bez --execute nic nie zamykam");
  console.log("Client ID:", mask(process.env.CLIENT_ID));
  console.log("Organization ID:", process.env.ORGANIZATION_ID);
  console.log("");

  const keepExternalIds = new Set(
    normalizeIdList(readJsonIfExists(KEEP_FILE, []))
  );

  const badExternalIds = new Set(
    normalizeIdList(readJsonIfExists(BAD_FILE, []))
  );

  const offers = await getAllOffers();

  const candidates = [];
  const skipped = [];

  for (const item of offers) {
    const offer = getOfferObject(item);
    const validationErrors = getValidationErrors(item);
    const decision = shouldCloseOffer(item, keepExternalIds, badExternalIds);

    const record = {
      offerId: offer.id,
      externalId: offer.externalId,
      status: offer.status,
      name: offer.product?.name,
      categoryId: offer.product?.categoryId,
      validationErrors,
      decisionReason: decision.reason
    };

    if (decision.close) {
      candidates.push(record);
    } else {
      skipped.push(record);
    }
  }

  fs.writeFileSync(
    path.join(OUTPUT_DIR, "offers-to-close.json"),
    JSON.stringify(candidates, null, 2),
    "utf8"
  );

  fs.writeFileSync(
    path.join(OUTPUT_DIR, "offers-not-closed.json"),
    JSON.stringify(skipped, null, 2),
    "utf8"
  );

  console.log(`Pobrano ofert: ${offers.length}`);
  console.log(`Do zamknięcia: ${candidates.length}`);
  console.log(`Pozostawione bez zmian: ${skipped.length}`);
  console.log("");
  console.log(`Raport do zamknięcia: ${path.join(OUTPUT_DIR, "offers-to-close.json")}`);
  console.log(`Raport pozostawionych: ${path.join(OUTPUT_DIR, "offers-not-closed.json")}`);
  console.log("");

  if (!EXECUTE) {
    console.log("To była tylko symulacja.");
    console.log("Sprawdź dist/offers-to-close.json.");
    console.log("Jeżeli lista jest poprawna, uruchom ponownie z --execute.");
    return;
  }

  const results = [];

  for (const candidate of candidates) {
    try {
      console.log(`Zamykam ofertę: ${candidate.externalId} | ${candidate.offerId} | ${candidate.name}`);

      const response = await closeOffer(candidate.offerId);

      results.push({
        ...candidate,
        ok: true,
        response
      });
    } catch (error) {
      results.push({
        ...candidate,
        ok: false,
        error: error.response?.data || error.message
      });

      console.error("Błąd zamykania:", candidate.offerId);
      console.error(error.response?.data || error.message);
    }
  }

  fs.writeFileSync(
    path.join(OUTPUT_DIR, "closed-offers-report.json"),
    JSON.stringify(results, null, 2),
    "utf8"
  );

  const successCount = results.filter((item) => item.ok).length;
  const errorCount = results.filter((item) => !item.ok).length;

  console.log("");
  console.log("Gotowe.");
  console.log(`Zamknięto poprawnie: ${successCount}`);
  console.log(`Błędy: ${errorCount}`);
  console.log(`Raport: ${path.join(OUTPUT_DIR, "closed-offers-report.json")}`);
}

main().catch((error) => {
  console.error("Błąd krytyczny:");
  console.error(error.response?.data || error.message);
  process.exit(1);
});