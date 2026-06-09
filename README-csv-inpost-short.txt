# Szybka instrukcja: CSV WooCommerce -> InPost Buy

Ostatnia aktualizacja: 2026-06-09.

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

Kolejnosc dla nowych ofert:

```text
1. dist/category-hints.json po EAN
2. category-overrides.json po kategorii WooCommerce
3. brak dopasowania -> raport i pominiecie
```

Override'y musza wskazywac kategorie-liscie InPost (`leaf: true`).

Dla istniejacych ofert w sync:

```text
1. jezeli InPost podal kategorie referencyjna przy CATEGORY_INCORRECT -> uzyj jej
2. jezeli nie ma referencji -> uzyj kategorii z CSV: hint po EAN, potem override
3. aktualna kategorie z InPost zachowuj tylko flaga --preserve-existing-categories
```

Dlatego po zmianach w CSV albo po blednych kategoriach zawsze zacznij od
ponownego wygenerowania pliku:

```bash
npm run inpost:generate-sync
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

## 4. Wygeneruj pelny plik ofert do sync

Po aktualizacji CSV uzyj pelnego eksportu, zeby istniejace oferty tez trafily
do `dist/inpost-offers.json` i mogly zostac porownane z InPost.

```bash
npm run inpost:generate-sync
```

Bez skrotu npm:

```bash
node csv-to-inpost-json.js suppla-oferta.csv category-map.json dist category-overrides.json dist/category-hints.json --include-existing
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

Korekty kategorii z referencji InPost sa w:

```text
csv-generation-errors.json -> inpostReferenceCategoryOverrides
csv-generation-errors.json -> inpostCurrentCategoryPreserved
```

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

## 6. Opublikuj tylko roznice

Terminal 1:

```bash
node server.js
```

Terminal 2, najpierw dry-run:

```bash
npm run inpost:sync:dry-run
```

Jezeli plan jest OK:

```bash
npm run inpost:sync
```

`send-inpost-offers.js --sync` pobiera aktualne oferty z InPost, porownuje
`product`, `stock`, `price` i `affiliationProductUrl`, robi PATCH tylko dla
roznic, a brakujace oferty tworzy i dodaje im pierwsze zdjecie.
Jesli InPost zwraca kategorie referencyjna przy `CATEGORY_INCORRECT`, sync uzyje
jej zamiast kategorii wyliczonej z CSV. W przeciwnym razie uzyje kategorii z
CSV, czyli najpierw hintu po EAN, a dopiero potem recznego override'u.

Raporty:

```text
dist/send-sync-report.json
dist/send-sync-errors.json
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
