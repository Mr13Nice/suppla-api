const fs = require("fs");
const path = require("path");
const axios = require("axios");

const INPUT_FILE = process.argv[2] || "dist/inpost-offers.json";
const IMAGES_FILE = process.argv[3] || "dist/offer-images.json";
const API_URL = process.argv[4] || "http://127.0.0.1:3000/api/inpost/offers";

const DELAY_MS = 700;
const MAX_BYTES_PER_OFFER = 240000;

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
  console.log("");

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