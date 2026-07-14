#!/usr/bin/env node

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const axios = require("axios");

const OUTPUT_TREE_FILE = process.argv[2] || path.join("dist", "category-tree.json");
const OUTPUT_REPORT_FILE =
  process.argv[3] || path.join(path.dirname(OUTPUT_TREE_FILE), "category-tree-report.json");
const DEPTH = Number(process.env.INPOST_CATEGORIES_DEPTH || process.argv[4] || 4);

const REQUIRED_ENV = [
  "CLIENT_ID",
  "CLIENT_SECRET",
  "INPOST_SCOPE",
  "INPOST_TOKEN_URL",
  "INPOST_BUY_API_BASE"
];

let tokenCache = {
  accessToken: null,
  expiresAt: 0
};

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function validateEnv() {
  for (const key of REQUIRED_ENV) {
    if (!process.env[key]) {
      throw new Error(`Brakuje zmiennej srodowiskowej: ${key}`);
    }
  }
}

function getBaseUrl() {
  return String(process.env.INPOST_BUY_API_BASE || "").replace(/\/+$/, "");
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

  const response = await axios.post(process.env.INPOST_TOKEN_URL, body.toString(), {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    }
  });

  const { access_token, expires_in } = response.data;
  tokenCache.accessToken = access_token;
  tokenCache.expiresAt = Date.now() + (Number(expires_in || 3600) - 30) * 1000;

  return tokenCache.accessToken;
}

function getCategoryRoots(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(getCategoryRoots);
  if (value.data) return getCategoryRoots(value.data);

  if (
    typeof value === "object" &&
    (value.id || value.categoryId || Array.isArray(value.children))
  ) {
    return [value];
  }

  return [];
}

function summarizeCategories(value) {
  const summary = {
    totalCategories: 0,
    leafCategories: 0,
    nonLeafCategories: 0,
    categoriesWithoutLeafFlag: 0
  };

  function visit(node) {
    if (!node || typeof node !== "object" || Array.isArray(node)) return;
    if (node.id || node.categoryId) {
      summary.totalCategories++;
      if (node.leaf === true) summary.leafCategories++;
      else if (node.leaf === false) summary.nonLeafCategories++;
      else summary.categoriesWithoutLeafFlag++;
    }

    for (const child of node.children || []) {
      visit(child);
    }
  }

  for (const root of getCategoryRoots(value)) {
    visit(root);
  }

  return summary;
}

async function fetchCategories() {
  const token = await getAccessToken();
  const response = await axios.get(`${getBaseUrl()}/v1/categories`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Accept-Language": "pl"
    },
    params: {
      depth: Number.isFinite(DEPTH) && DEPTH >= 0 && DEPTH <= 4 ? DEPTH : 4
    }
  });

  return response.data;
}

async function main() {
  validateEnv();

  console.log("Pobieram aktualne drzewo kategorii InPost");
  console.log(`Endpoint: ${getBaseUrl()}/v1/categories`);
  console.log(`Depth: ${Number.isFinite(DEPTH) && DEPTH >= 0 && DEPTH <= 4 ? DEPTH : 4}`);

  const categories = await fetchCategories();
  const summary = summarizeCategories(categories);
  const report = {
    generatedAt: new Date().toISOString(),
    outputTreeFile: OUTPUT_TREE_FILE,
    depth: Number.isFinite(DEPTH) && DEPTH >= 0 && DEPTH <= 4 ? DEPTH : 4,
    summary
  };

  writeJson(OUTPUT_TREE_FILE, categories);
  writeJson(OUTPUT_REPORT_FILE, report);

  console.log(`Zapisano: ${OUTPUT_TREE_FILE}`);
  console.log(`Raport: ${OUTPUT_REPORT_FILE}`);
  console.log(`Kategorie: ${summary.totalCategories}`);
  console.log(`Kategorie-liscie: ${summary.leafCategories}`);
}

main().catch((error) => {
  console.error("");
  console.error("Blad pobierania drzewa kategorii:");
  console.error(error.response?.data || error.message);
  process.exit(1);
});
