# Szybka instrukcja: CSV WooCommerce -> InPost Buy

Ostatnia aktualizacja: 2026-07-13.

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
1. hint po EAN z InPost: /v1/organizations/{organizationId}/offers/hint?ean=<EAN>
2. category-overrides.json po kategorii WooCommerce tylko gdy nie ma hintu po EAN
3. brak dopasowania -> raport i pominiecie
```

Override'y musza wskazywac kategorie-liscie InPost (`leaf: true`).
Generator najpierw odswieza `dist/category-tree.json` z `GET /v1/categories`,
a potem laczy dostepne drzewa kategorii z `dist/category-tree.json`,
`inpost-health-categories.txt` i `inpost.txt`. Inny plik mozna wskazac przez
`INPOST_CATEGORY_TREE_FILE`. Glebokosc pobierania drzewa ustawia
`INPOST_CATEGORIES_DEPTH`, domyslnie `4`.

Hint po EAN z InPost jest zrodlem nadrzednym. Jezeli lokalne drzewo nie zna
jego `categoryId` albo ma sprzeczne `leaf`, generator zapisze ostrzezenie, ale
uzyje kategorii z hintu:

```text
csv-generation-report.json -> totals.hintCategoryWarnings
csv-generation-report.json -> categoryResolution.hintWarningReasons
csv-generation-errors.json -> hintCategoryWarnings
```

Dla istniejacych ofert w sync:

```text
1. jezeli InPost podal kategorie referencyjna przy CATEGORY_INCORRECT -> uzyj jej
2. jezeli nie ma referencji -> uzyj kategorii z CSV: poprawny hint po EAN, potem override
3. aktualna kategorie z InPost zachowuj tylko flaga --preserve-existing-categories
```

Po zmianach w CSV wystarczy zaczac od ponownego wygenerowania synca. Ta komenda
odswieza `dist/category-hints.json` z InPost, a potem buduje pelny plik ofert:

```bash
npm run inpost:generate-sync
```

---

## 3. Aktualizacja po zmianie CSV

Pelny proces po podmianie `suppla-oferta.csv`, z uzyciem istniejacej mapy marek
offline, wysylka glownego synca i rescue na koncu:

```bash
npm run inpost:update-after-csv
```

Wariant kontrolny bez realnej wysylki do InPost:

```bash
npm run inpost:update-after-csv:dry-run
```

Ten sam proces rozbity na etapy:

```bash
npm run inpost:prepare-after-csv
npm run inpost:publish-after-csv
npm run inpost:rescue-after-csv
```

`npm run inpost:generate-sync` robi dwa kroki:

```text
1. odswieza dist/category-tree.json z InPost
2. odswieza dist/category-hints.json po EAN z InPost
3. generuje dist/inpost-offers.json oraz dist/offer-images.json
```

Opcjonalnie po wygenerowaniu ofert mozna uzupelnic prefiksy marek w nazwach.
Ten krok nie zmienia `suppla-oferta.csv` ani `csv-to-inpost-json.js`; aktualizuje
tylko `dist/inpost-offers.json`, `brand-map.json` i raport.

```bash
npm run inpost:enrich-brands
```

Skrypt pokazuje postep w konsoli, odswieza raport w trakcie pracy i zapisuje
`brand-map.json` przyrostowo. Plik `dist/inpost-offers.json` jest zapisywany
dopiero po zakonczeniu przebiegu.

Przed zapisem mozna sprawdzic wynik:

```bash
npm run inpost:enrich-brands:dry-run
```

Bez internetu, tylko z juz zapisanej mapy:

```bash
npm run inpost:enrich-brands:offline
```

Diagnostyka jednego EAN:

```bash
node enrich-inpost-brands.js suppla-oferta.csv dist/inpost-offers.json brand-map.json dist/brand-enrichment-report.json --dry-run --only-code=3264680003561 --lookup-limit=1
```

Pelny krok generowania i marek:

```bash
npm run inpost:generate-sync-brands
```

Opcjonalnie, przed wysylka synca mozna sprawdzic zamkniete oferty, ktore w
aktualnym CSV maja stan magazynowy wiekszy niz 0. Domyslnie to tylko dry-run:

```bash
npm run inpost:reopen-closed-instock
```

Raporty:

```text
dist/reopen-closed-instock-report.json
dist/reopen-closed-instock-candidates.json
dist/reopen-closed-instock-skipped.json
```

Po sprawdzeniu kandydatow mozna wykonac realne otwarcie:

```bash
npm run inpost:reopen-closed-instock:execute
```

Skrypt pomija zamknieta oferte, jezeli dla tego samego `externalId`, EAN albo
SKU istnieje juz aktywny duplikat w InPost.

---

## 4. Wygeneruj pelny plik ofert do sync

Po aktualizacji CSV uzyj pelnego eksportu, zeby istniejace oferty tez trafily
do `dist/inpost-offers.json` i mogly zostac porownane z InPost.

```bash
npm run inpost:generate-sync
```

Bez skrotu npm:

```bash
node generate-category-hints.js suppla-oferta.csv dist/category-hints.json category-map.json
node csv-to-inpost-json.js suppla-oferta.csv category-map.json dist category-overrides.json dist/category-hints.json --include-existing
```

Wyniki:

```text
dist/inpost-offers.json
dist/offer-images.json
dist/csv-generation-report.json
dist/csv-generation-errors.json
```

---

## 5. Rescue przez override'y

Jezeli glowny generator odrzucil hint po EAN albo sync zwrocil
`CATEGORY_INCORRECT`, mozna przygotowac osobny plik ratunkowy tylko z recznych
override'ow:

```bash
npm run inpost:rescue-overrides
npm run inpost:rescue-overrides:dry-run
npm run inpost:rescue-overrides:sync
```

Rescue zapisuje osobne pliki i nie nadpisuje glownego synca:

```text
dist/inpost-offers-rescue-overrides.json
dist/offer-images-rescue-overrides.json
dist/rescue-overrides-report.json
dist/rescue-overrides-errors.json
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

## 6. Sprzatanie duplikatow w InPost

Plan duplikatow pojawia sie w raporcie generatora. Wykonanie zmian:

```bash
node csv-to-inpost-json.js suppla-oferta.csv category-map.json dist category-overrides.json dist/category-hints.json --cleanup-duplicates --execute
```

Tylko zamykanie, bez proby `DELETE`:

```bash
node csv-to-inpost-json.js suppla-oferta.csv category-map.json dist category-overrides.json dist/category-hints.json --cleanup-duplicates --execute --close-only
```

---

## 7. Opublikuj tylko roznice

Terminal 1:

```bash
node server.js
```

Terminal 2, opcjonalny dry-run:

```bash
npm run inpost:sync:dry-run
```

Wlasciwy sync:

```bash
npm run inpost:sync
```

`send-inpost-offers.js --sync` pobiera aktualne oferty z InPost, porownuje
`product`, `stock`, `price` i `affiliationProductUrl`, robi PATCH tylko dla
roznic, a brakujace oferty tworzy i dodaje im pierwsze zdjecie.
Przy duplikatach `externalId` sync wybiera tylko jeden rekord do PATCH: najpierw
aktywny/opublikowany, potem `SOLDOUT`, `PENDING`, `DRAFT`, a zamkniete rekordy
pomija. Pominiecia sa widoczne w `send-sync-report.json` i
`send-sync-errors.json -> skippedDuplicates`.
Po CREATE/PATCH pobiera szczegoly oferty i sprawdza walidacje InPost.
Jesli InPost zwraca kategorie referencyjna przy `CATEGORY_INCORRECT`, sync robi
dodatkowy PATCH tej kategorii i zapisuje to w raporcie. Jezeli po korekcie
zostaja bledy walidacji, trafiaja do `dist/send-sync-errors.json`.

Raporty:

```text
dist/send-sync-report.json
dist/send-sync-errors.json
```

---

## 8. Napraw istniejace oferty

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

