# Szybka instrukcja: CSV WooCommerce -> InPost Buy

Ostatnia aktualizacja: 2026-06-08.

Pelny opis jest w `README-csv-inpost.txt`.

---

## 1. Instalacja i `.env`

```bash
npm install
```

Minimalny `.env`:

```env
CLIENT_ID=...
CLIENT_SECRET=...
INPOST_SCOPE=api:categories:read api:offers:read api:offers:write api:orders:read api:orders:write
INPOST_TOKEN_URL=https://api.inpost-group.com/oauth2/token
INPOST_BUY_API_BASE=https://api.inpost-group.com/inpsa
ORGANIZATION_ID=...
PORT=3000
INPOST_PATCH_CONTENT_TYPE=application/merge-patch+json
```

---

## 2. Kategorie

Kolejnosc przypisania:

```text
1. dist/category-hints.json po EAN
2. category-overrides.json po kategorii WooCommerce
3. brak dopasowania -> raport i pominiecie
```

---

## 3. Hinty kategorii

```bash
mkdir dist
node generate-category-hints.js suppla-oferta.csv dist/category-hints.json category-map.json
```

Wyniki:

```text
dist/category-hints.json
dist/category-hints-report.json
```

---

## 4. Wygeneruj oferty

Tryb domyslny sprawdza InPost i pomija oferty, ktore juz maja ten sam
`externalId`.

```bash
node csv-to-inpost-json.js suppla-oferta.csv category-map.json dist category-overrides.json dist/category-hints.json
```

Bez sprawdzania InPost:

```bash
node csv-to-inpost-json.js suppla-oferta.csv category-map.json dist category-overrides.json dist/category-hints.json --offline
```

Wyniki:

```text
dist/inpost-offers.json
dist/offer-images.json
dist/csv-generation-report.json
dist/csv-generation-errors.json
```

Generator automatycznie wydluza opisy do minimum 100 znakow. Zmienione opisy sa
w `csv-generation-errors.json -> generatedDescriptions`.

Sprawdz przed wysylka:

```text
csv-generation-report.json -> totals
csv-generation-errors.json -> blockingSkippedProducts
csv-generation-errors.json -> unresolvedCategories
csv-generation-errors.json -> duplicateExternalIdsInCsv
csv-generation-errors.json -> existingInPostSkipped
csv-generation-errors.json -> existingDuplicateGroups
```

---

## 5. Sprzatanie duplikatow w InPost

Plan duplikatow pojawia sie w raporcie generatora. Wykonanie zmian:

```bash
node csv-to-inpost-json.js suppla-oferta.csv category-map.json dist category-overrides.json dist/category-hints.json --cleanup-duplicates --execute
```

Tylko zamykanie, bez proby `DELETE`:

```bash
node csv-to-inpost-json.js suppla-oferta.csv category-map.json dist category-overrides.json dist/category-hints.json --cleanup-duplicates --execute --close-only
```

---

## 6. Wyslij nowe oferty

Terminal 1:

```bash
node server.js
```

Terminal 2, test 3 ofert:

```bash
node -e "const fs=require('fs'); const offers=require('./dist/inpost-offers.json'); const test=offers.slice(0,3); fs.writeFileSync('./dist/inpost-offers-test.json', JSON.stringify(test,null,2)); const images=require('./dist/offer-images.json'); const ids=new Set(test.map(o=>String(o.externalId))); const testImages=Object.fromEntries(Object.entries(images).filter(([id])=>ids.has(String(id)))); fs.writeFileSync('./dist/offer-images-test.json', JSON.stringify(testImages,null,2)); console.log('Utworzono pliki testowe:', test.length);"
node send-inpost-offers.js dist/inpost-offers-test.json dist/offer-images-test.json
```

Pelna wysylka:

```bash
node send-inpost-offers.js dist/inpost-offers.json dist/offer-images.json
```

Raport:

```text
dist/send-results.json
```

---

## 7. Napraw istniejace oferty

Dry run:

```bash
node patch-inpost-offers-from-csv.js suppla-oferta.csv dist/category-hints.json category-overrides.json dist --dry-run
```

Wykonanie:

```bash
node patch-inpost-offers-from-csv.js suppla-oferta.csv dist/category-hints.json category-overrides.json dist
```

Skrypt naprawia kategorie oraz opisy krotsze niz 100 znakow.

Raporty:

```text
dist/offer-repair-from-csv-report.json
dist/offer-repair-errors.json
```
