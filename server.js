require("dotenv").config();

const express = require("express");
const axios = require("axios");
const crypto = require("crypto");

const app = express();
app.use(express.json());

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
        }
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

async function inpostRequest(method, path, options = {}) {
  const token = await getAccessToken();

  try {
    const response = await axios({
      method,
      url: `${process.env.INPOST_BUY_API_BASE}${path}`,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        "Accept-Language": "pl",
        "X-Request-Id": crypto.randomUUID()
      },
      params: options.params,
      data: options.data
    });

    return response.data;
  } catch (error) {
    console.error(`Błąd InPost API: ${method} ${path}`);

    if (error.response) {
      console.error("Status:", error.response.status);
      console.error("Odpowiedź:", error.response.data);
    } else {
      console.error(error.message);
    }

    throw error;
  }
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

/**
 * Test działania lokalnego API.
 */
app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "Lokalne API integracji InPost Buy działa",
    clientId: mask(process.env.CLIENT_ID),
    scope: process.env.INPOST_SCOPE
  });
});

/**
 * Tylko do testów.
 * W produkcji nie pokazuj tokenu w przeglądarce.
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
 * Kategorie produktów.
 * Scope: api:categories:read
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
 * Atrybuty konkretnej kategorii.
 * Potrzebne przed wystawieniem oferty.
 * Scope: api:categories:read
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
 * Lista ofert.
 * Scope: api:offers:read
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
 * Szczegóły jednej oferty.
 * Scope: api:offers:read
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
 * Utworzenie jednej oferty.
 * Scope: api:offers:write
 */
app.post("/api/inpost/offers", async (req, res) => {
  try {
    const organizationId = process.env.ORGANIZATION_ID;

    const data = await inpostRequest(
      "POST",
      `/v1/organizations/${encodeURIComponent(organizationId)}/offers`,
      {
        data: req.body
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
 * Aktualizacja oferty.
 * Scope: api:offers:write
 */
app.patch("/api/inpost/offers/:offerId", async (req, res) => {
  try {
    const organizationId = process.env.ORGANIZATION_ID;
    const { offerId } = req.params;

    const data = await inpostRequest(
      "PATCH",
      `/v1/organizations/${encodeURIComponent(organizationId)}/offers/${encodeURIComponent(offerId)}`,
      {
        data: req.body
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
 * Zamknięcie oferty.
 * Scope: api:offers:write
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
 * Scope: api:offers:write
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

/**
 * Lista zamówień.
 * Scope: api:orders:read
 */
app.get("/api/inpost/orders", async (req, res) => {
  try {
    const organizationId = process.env.ORGANIZATION_ID;

    const data = await inpostRequest(
      "GET",
      `/v1/organizations/${encodeURIComponent(organizationId)}/orders`,
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
 * Szczegóły jednego zamówienia.
 * Scope: api:orders:read
 */
app.get("/api/inpost/orders/:orderId", async (req, res) => {
  try {
    const organizationId = process.env.ORGANIZATION_ID;
    const { orderId } = req.params;

    const data = await inpostRequest(
      "GET",
      `/v1/organizations/${encodeURIComponent(organizationId)}/orders/${encodeURIComponent(orderId)}`
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
 * Akceptacja zamówienia.
 * Scope: api:orders:write
 */
app.post("/api/inpost/orders/:orderId/accept", async (req, res) => {
  try {
    const organizationId = process.env.ORGANIZATION_ID;
    const { orderId } = req.params;

    const data = await inpostRequest(
      "POST",
      `/v1/organizations/${encodeURIComponent(organizationId)}/orders/${encodeURIComponent(orderId)}/accept`,
      {
        data: req.body
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
 * Odrzucenie zamówienia.
 * Scope: api:orders:write
 */
app.post("/api/inpost/orders/:orderId/refuse", async (req, res) => {
  try {
    const organizationId = process.env.ORGANIZATION_ID;
    const { orderId } = req.params;

    const data = await inpostRequest(
      "POST",
      `/v1/organizations/${encodeURIComponent(organizationId)}/orders/${encodeURIComponent(orderId)}/refuse`,
      {
        data: req.body
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

app.listen(PORT, () => {
  console.log(`Serwer działa na porcie ${PORT}`);
  console.log(`Client ID: ${mask(process.env.CLIENT_ID)}`);
  console.log(`Scope: ${process.env.INPOST_SCOPE}`);
});