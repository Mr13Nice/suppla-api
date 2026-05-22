require("dotenv").config();

const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const FormData = require("form-data");
const mime = require("mime-types");

const app = express();

app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true, limit: "5mb" }));

const PORT = process.env.PORT || 3000;

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

let tokenCache = {
  accessToken: null,
  expiresAt: 0
};

function mask(value) {
  if (!value) return "";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function safeFileName(value) {
  return String(value || "")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 120);
}

function getExtensionFromUrlOrContentType(imageUrl, contentType) {
  try {
    const parsed = new URL(imageUrl);
    const ext = path.extname(parsed.pathname);

    if (ext && ext.length <= 8) {
      return ext;
    }
  } catch {
    // ignorujemy
  }

  const extFromMime = mime.extension(contentType || "");

  if (extFromMime) {
    return `.${extFromMime}`;
  }

  return ".jpg";
}

async function getAccessToken() {
  const now = Date.now();

  if (tokenCache.accessToken && now < tokenCache.expiresAt) {
    return tokenCache.accessToken;
  }

  try {
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
        },
        timeout: 60000
      }
    );

    const { access_token, expires_in, token_type, scope } = response.data;

    tokenCache.accessToken = access_token;
    tokenCache.expiresAt = Date.now() + (expires_in - 30) * 1000;

    console.log("Token pobrany poprawnie");
    console.log("Token type:", token_type);
    console.log("Scope:", scope || process.env.INPOST_SCOPE);
    console.log("Ważny do:", new Date(tokenCache.expiresAt).toISOString());

    return access_token;
  } catch (error) {
    console.error("Błąd pobierania tokenu InPost");
    console.error("CLIENT_ID:", mask(process.env.CLIENT_ID));
    console.error("TOKEN_URL:", process.env.INPOST_TOKEN_URL);
    console.error("SCOPE:", process.env.INPOST_SCOPE);

    if (error.response) {
      console.error("Status:", error.response.status);
      console.error("Odpowiedź:", error.response.data);
    } else {
      console.error(error.message);
    }

    throw error;
  }
}

async function inpostRequest(method, apiPath, options = {}) {
  const token = await getAccessToken();

  try {
    const response = await axios({
      method,
      url: `${process.env.INPOST_BUY_API_BASE}${apiPath}`,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": options.contentType || "application/json",
        "Accept-Language": "pl"
      },
      params: options.params,
      data: options.data,
      timeout: options.timeout || 120000,
      maxBodyLength: Infinity,
      maxContentLength: Infinity
    });

    return response.data;
  } catch (error) {
    console.error(`Błąd InPost API: ${method} ${apiPath}`);

    if (error.response) {
      console.error("Status:", error.response.status);
      console.error("Odpowiedź:", error.response.data);
    } else {
      console.error(error.message);
    }

    throw error;
  }
}

async function inpostMultipartRequest(method, apiPath, filePath, fileName, options = {}) {
  const token = await getAccessToken();

  const form = new FormData();

  /**
   * Jeśli InPost zwróci błąd, że nazwa pola pliku jest inna,
   * najpierw zmień "file" na nazwę wymaganą w portalu API.
   * W wielu implementacjach multipart pole nazywa się właśnie "file".
   */
  form.append("file", fs.createReadStream(filePath), {
    filename: fileName,
    contentType: mime.lookup(fileName) || "application/octet-stream"
  });

  try {
    const response = await axios({
      method,
      url: `${process.env.INPOST_BUY_API_BASE}${apiPath}`,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Accept-Language": "pl",
        ...form.getHeaders()
      },
      params: options.params,
      data: form,
      timeout: options.timeout || 120000,
      maxBodyLength: Infinity,
      maxContentLength: Infinity
    });

    return response.data;
  } catch (error) {
    console.error(`Błąd InPost multipart API: ${method} ${apiPath}`);

    if (error.response) {
      console.error("Status:", error.response.status);
      console.error("Odpowiedź:", error.response.data);
    } else {
      console.error(error.message);
    }

    throw error;
  }
}

async function downloadImageToTemp(imageUrl, externalIdOrOfferId) {
  const tmpDir = path.join(__dirname, "tmp-images");
  ensureDir(tmpDir);

  const response = await axios.get(imageUrl, {
    responseType: "arraybuffer",
    timeout: 120000,
    maxContentLength: 15 * 1024 * 1024,
    headers: {
      "User-Agent": "Mozilla/5.0"
    }
  });

  const contentType = response.headers["content-type"] || "";

  if (!contentType.startsWith("image/")) {
    throw new Error(`URL nie zwrócił obrazu. Content-Type: ${contentType}`);
  }

  const ext = getExtensionFromUrlOrContentType(imageUrl, contentType);
  const random = crypto.randomBytes(6).toString("hex");
  const baseName = safeFileName(externalIdOrOfferId || "image");
  const fileName = `${baseName}-${random}${ext}`;
  const filePath = path.join(tmpDir, fileName);

  fs.writeFileSync(filePath, response.data);

  return {
    filePath,
    fileName,
    contentType,
    size: response.data.length
  };
}

function handleError(error, res) {
  const status = error.response?.status || 500;
  const data = error.response?.data || {
    message: error.message || "Wewnętrzny błąd serwera"
  };

  res.status(status).json({
    ok: false,
    error: data
  });
}

function getOfferIdFromInpostCreateResponse(data) {
  return (
    data?.offerId ||
    data?.id ||
    data?.offer?.id ||
    data?.data?.offerId ||
    data?.data?.id ||
    data?.data?.offer?.id ||
    null
  );
}

/**
 * Test działania lokalnego API.
 */
app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "Lokalne API integracji InPost Buy działa",
    clientId: mask(process.env.CLIENT_ID),
    apiBase: process.env.INPOST_BUY_API_BASE,
    scope: process.env.INPOST_SCOPE
  });
});

/**
 * Test tokenu.
 * W produkcji nie pokazuj pełnego tokenu.
 */
app.get("/api/inpost/token-test", async (req, res) => {
  try {
    const token = await getAccessToken();

    res.json({
      ok: true,
      tokenPreview: `${token.slice(0, 20)}...`,
      expiresAt: new Date(tokenCache.expiresAt).toISOString()
    });
  } catch (error) {
    handleError(error, res);
  }
});

/**
 * Kategorie główne.
 */
app.get("/api/inpost/categories", async (req, res) => {
  try {
    const data = await inpostRequest("GET", "/v1/categories", {
      params: req.query
    });

    res.json({
      ok: true,
      data
    });
  } catch (error) {
    handleError(error, res);
  }
});

/**
 * Atrybuty kategorii.
 * Ten endpoint musi być przed /api/inpost/categories/:categoryId.
 */
app.get("/api/inpost/categories/:categoryId/attributes", async (req, res) => {
  try {
    const { categoryId } = req.params;

    const data = await inpostRequest(
      "GET",
      `/v1/categories/${encodeURIComponent(categoryId)}/attributes`
    );

    res.json({
      ok: true,
      data
    });
  } catch (error) {
    handleError(error, res);
  }
});

/**
 * Szczegóły kategorii / drzewo kategorii.
 */
app.get("/api/inpost/categories/:categoryId", async (req, res) => {
  try {
    const { categoryId } = req.params;

    const data = await inpostRequest(
      "GET",
      `/v1/categories/${encodeURIComponent(categoryId)}`,
      {
        params: req.query
      }
    );

    res.json({
      ok: true,
      data
    });
  } catch (error) {
    handleError(error, res);
  }
});

/**
 * Lista ofert.
 */
app.get("/api/inpost/offers", async (req, res) => {
  try {
    const organizationId = process.env.ORGANIZATION_ID;

    const data = await inpostRequest(
      "GET",
      `/v1/organizations/${encodeURIComponent(organizationId)}/offers`,
      {
        params: req.query
      }
    );

    res.json({
      ok: true,
      data
    });
  } catch (error) {
    handleError(error, res);
  }
});

/**
 * Utworzenie jednej oferty.
 */
app.post("/api/inpost/offers", async (req, res) => {
  try {
    const organizationId = process.env.ORGANIZATION_ID;

    if (Array.isArray(req.body)) {
      return res.status(400).json({
        ok: false,
        error: "Ten endpoint przyjmuje jedną ofertę, nie tablicę. Do masowej wysyłki użyj send-inpost-offers.js."
      });
    }

    const data = await inpostRequest(
      "POST",
      `/v1/organizations/${encodeURIComponent(organizationId)}/offers`,
      {
        data: req.body
      }
    );

    res.json({
      ok: true,
      offerId: getOfferIdFromInpostCreateResponse(data),
      data
    });
  } catch (error) {
    handleError(error, res);
  }
});

/**
 * Szczegóły jednej oferty.
 */
app.get("/api/inpost/offers/:offerId", async (req, res) => {
  try {
    const organizationId = process.env.ORGANIZATION_ID;
    const { offerId } = req.params;

    const data = await inpostRequest(
      "GET",
      `/v1/organizations/${encodeURIComponent(organizationId)}/offers/${encodeURIComponent(offerId)}`
    );

    res.json({
      ok: true,
      data
    });
  } catch (error) {
    handleError(error, res);
  }
});

/**
 * Aktualizacja oferty.
 * Używa application/merge-patch+json, bo zwykłe application/json dawało wcześniej UNSUPPORTED_MEDIA_TYPE.
 */
app.patch("/api/inpost/offers/:offerId", async (req, res) => {
  try {
    const organizationId = process.env.ORGANIZATION_ID;
    const { offerId } = req.params;

    const data = await inpostRequest(
      "PATCH",
      `/v1/organizations/${encodeURIComponent(organizationId)}/offers/${encodeURIComponent(offerId)}`,
      {
        data: req.body,
        contentType: "application/merge-patch+json"
      }
    );

    res.json({
      ok: true,
      data
    });
  } catch (error) {
    handleError(error, res);
  }
});

/**
 * Dodanie zdjęcia do oferty na podstawie URL.
 *
 * Body:
 * {
 *   "imageUrl": "https://...",
 *   "externalId": "156"
 * }
 */
app.post("/api/inpost/offers/:offerId/attachments/from-url", async (req, res) => {
  let downloaded = null;

  try {
    const organizationId = process.env.ORGANIZATION_ID;
    const { offerId } = req.params;
    const attachmentType = req.query.attachmentType || req.body.attachmentType || "IMAGE";
    const imageUrl = req.body.imageUrl;
    const externalId = req.body.externalId || offerId;

    if (!imageUrl) {
      return res.status(400).json({
        ok: false,
        error: "Brakuje imageUrl w body."
      });
    }

    downloaded = await downloadImageToTemp(imageUrl, externalId);

    console.log("Pobrano obraz:");
    console.log("URL:", imageUrl);
    console.log("Plik:", downloaded.fileName);
    console.log("Rozmiar:", downloaded.size, "B");
    console.log("Content-Type:", downloaded.contentType);

    const data = await inpostMultipartRequest(
      "POST",
      `/v1/organizations/${encodeURIComponent(organizationId)}/offers/${encodeURIComponent(offerId)}/attachments`,
      downloaded.filePath,
      downloaded.fileName,
      {
        params: {
          attachmentType
        }
      }
    );

    res.json({
      ok: true,
      data
    });
  } catch (error) {
    handleError(error, res);
  } finally {
    if (downloaded?.filePath && fs.existsSync(downloaded.filePath)) {
      fs.unlinkSync(downloaded.filePath);
    }
  }
});

/**
 * Zamknięcie oferty.
 */
app.post("/api/inpost/offers/:offerId/close", async (req, res) => {
  try {
    const organizationId = process.env.ORGANIZATION_ID;
    const { offerId } = req.params;

    const data = await inpostRequest(
      "POST",
      `/v1/organizations/${encodeURIComponent(organizationId)}/offers/${encodeURIComponent(offerId)}/close`
    );

    res.json({
      ok: true,
      data
    });
  } catch (error) {
    handleError(error, res);
  }
});

/**
 * Ponowne otwarcie oferty.
 */
app.post("/api/inpost/offers/:offerId/reopen", async (req, res) => {
  try {
    const organizationId = process.env.ORGANIZATION_ID;
    const { offerId } = req.params;

    const data = await inpostRequest(
      "POST",
      `/v1/organizations/${encodeURIComponent(organizationId)}/offers/${encodeURIComponent(offerId)}/reopen`
    );

    res.json({
      ok: true,
      data
    });
  } catch (error) {
    handleError(error, res);
  }
});

app.listen(PORT, () => {
  console.log(`Serwer działa na porcie ${PORT}`);
  console.log(`Client ID: ${mask(process.env.CLIENT_ID)}`);
  console.log(`API base: ${process.env.INPOST_BUY_API_BASE}`);
  console.log(`Scope: ${process.env.INPOST_SCOPE}`);
});