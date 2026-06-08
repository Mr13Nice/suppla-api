# CSV WooCommerce -> InPost Buy

Ostatnia aktualizacja: 2026-06-08.

Ten dokument opisuje aktualny proces pracy z eksportem WooCommerce i ofertami
InPost Buy w tym repozytorium.

Glowne zasady:

- `csv-to-inpost-json.js` generuje oferty z CSV, pilnuje kategorii, opisow i
  duplikatow.
- Kategorie sa wybierane tylko w kolejnosci: hint po EAN, override po kategorii
  WooCommerce, a potem pominiecie produktu.
- Generator domyslnie sprawdza istniejace oferty w InPost i nie tworzy ponownie
  ofert o juz istniejacym `externalId`.
- Opis produktu jest automatycznie wydluzany do minimum 100 znakow, bo tego
  wymaga InPost.
- Raporty generatora sa zwijane do dwoch plikow: `csv-generation-report.json`
  oraz `csv-generation-errors.json`.

Jezeli w `.env` masz `INPOST_BUY_API_BASE=https://api.inpost-group.com/inpsa`,
operacje online trafiaja do produkcyjnego API InPost.

---

## 1. Najwazniejsze pliki

```text
.env
package.json
server.js
csv-to-inpost-json.js
generate-category-hints.js
send-inpost-offers.js
patch-inpost-offers-from-csv.js
close-inpost-offers.js
suppla-oferta.csv
category-map.json
category-overrides.json
dist/category-hints.json
```

`cleanup-inpost-duplicate-offers.js`, `patch-inpost-offers.js` i
`patch-inpost-categories-from-csv.js` nie sa juz potrzebne. Deduplikacja zostala
przeniesiona do `csv-to-inpost-json.js`, a naprawa kategorii i zbyt krotkich
opisow do `patch-inpost-offers-from-csv.js`.

---

## 2. Instalacja

```bash
npm install
```

Gdy instalujesz zaleznosci od zera:

```bash
npm install express axios dotenv csv-parse he form-data multer mime-types
```

---

## 3. Plik `.env`

Minimalny zestaw:

```env
CLIENT_ID=...
CLIENT_SECRET=...
INPOST_SCOPE=api:categories:read api:offers:read api:offers:write api:orders:read api:orders:write
INPOST_TOKEN_URL=https://api.inpost-group.com/oauth2/token
INPOST_BUY_API_BASE=https://api.inpost-group.com/inpsa
ORGANIZATION_ID=...
PORT=3000
INPOST_PATCH_CONTENT_TYPE=application/merge-patch+json
INPOST_REQUEST_DELAY_MS=150
INPOST_OFFERS_PAGE_LIMIT=100
```

Generator w trybie domyslnym potrzebuje dostepu do InPost, bo sprawdza
istniejace oferty po `externalId`. Do pracy bez polaczenia uzyj `--offline`.

---

## 4. Kategorie

Aktualna kolejnosc przypisania kategorii:

```text
1. dist/category-hints.json po EAN
2. category-overrides.json po kategorii WooCommerce
3. brak dopasowania -> produkt trafia do raportu i nie jest wysylany
```

Skrypty nie zgaduja kategorii po nazwie produktu ani po ostatnim segmencie
kategorii WooCommerce. `product.categoryId` musi byc jawnie wyliczone z hintu
albo override'u i najlepiej powinno wskazywac kategorie koncowa InPost.

---

## 5. Opisy 100+ znakow

InPost wymaga minimum 100 znakow w opisie produktu. Generator robi to teraz
automatycznie:

1. Czyta `Opis`, a gdy jest pusty, `Krotki opis`.
2. Czysci HTML do zwyklego tekstu.
3. Jezeli opis ma mniej niz 100 znakow, dopisuje neutralne dane katalogowe:
   marka, kategoria WooCommerce, EAN, SKU i informacje z eksportu WooCommerce.
4. Jezeli nadal brakuje znakow, dopelnia opis neutralnym zdaniem katalogowym.
5. Maksymalna dlugosc jest nadal ograniczona przez `MAX_DESCRIPTION_LENGTH`.

Produkty nie powinny juz odpadac tylko dlatego, ze opis byl za krotki.
Automatycznie wydluzone opisy sa widoczne w:

```text
dist/csv-generation-errors.json -> generatedDescriptions
```

---

## 6. Generator ofert

Podstawowe uruchomienie:

```bash
node csv-to-inpost-json.js suppla-oferta.csv category-map.json dist category-overrides.json dist/category-hints.json
```

Tryb offline, bez sprawdzania istniejacych ofert w InPost:

```bash
node csv-to-inpost-json.js suppla-oferta.csv category-map.json dist category-overrides.json dist/category-hints.json --offline
```

Pliki wynikowe generatora:

```text
dist/inpost-offers.json
dist/offer-images.json
dist/csv-generation-report.json
dist/csv-generation-errors.json
```

Nowe uruchomienie nadpisuje te pliki. Generator usuwa tez stare raporty z
poprzedniej wersji, np. `skipped-products.json`, `blocking-skipped-products.json`,
`unresolved-categories.json`, `category-resolution-report.json` i raporty
`duplicate-offers-*`.

`csv-generation-report.json` zawiera podsumowanie liczbowe i licznik sposobow
dopasowania kategorii.

`csv-generation-errors.json` zawiera szczegoly:

```text
skippedProducts
blockingSkippedProducts
productsWithoutImages
generatedDescriptions
unresolvedCategories
duplicateExternalIdsInCsv
existingInPostSkipped
existingDuplicateGroups
existingDuplicatePlannedActions
existingOffersWithoutExternalId
duplicateCleanupResult
```

---

## 7. Ochrona przed duplikatami

Generator chroni przed dwoma typami duplikatow.

Duplikaty w CSV:

- jezeli dwa poprawne wiersze maja ten sam `externalId`, pierwszy kandydat
  zostaje, a kolejny trafia do `duplicateExternalIdsInCsv`;
- wiersz odrzucony wczesniej, np. za brak zdjecia albo kategorii, nie blokuje
  pozniejszego poprawnego wiersza z tym samym `externalId`.

Duplikaty wobec InPost:

- w trybie domyslnym generator pobiera istniejace oferty z InPost;
- jezeli `externalId` juz istnieje w InPost, oferta nie trafia do
  `dist/inpost-offers.json`;
- pominiete rekordy sa widoczne w `existingInPostSkipped`;
- istniejace duplikaty `externalId` w InPost sa grupowane w
  `existingDuplicateGroups`, a proponowane akcje w `existingDuplicatePlannedActions`.

Sprzatanie duplikatow w InPost jest teraz opcja generatora:

```bash
node csv-to-inpost-json.js suppla-oferta.csv category-map.json dist category-overrides.json dist/category-hints.json --cleanup-duplicates --execute
```

Domyslnie skrypt probuje `DELETE`, a gdy InPost nie pozwala usunac oferty,
probuje `POST /close`. Tryb tylko zamykania:

```bash
node csv-to-inpost-json.js suppla-oferta.csv category-map.json dist category-overrides.json dist/category-hints.json --cleanup-duplicates --execute --close-only
```

Alias `--execute-cleanup` dziala tak samo jak `--execute`.

---

## 8. Hinty kategorii po EAN

Jezeli `dist/category-hints.json` jest pusty albo nieaktualny:

```bash
node generate-category-hints.js suppla-oferta.csv dist/category-hints.json category-map.json
```

Wyniki:

```text
dist/category-hints.json
dist/category-hints-report.json
```

Po aktualizacji hintow uruchom ponownie generator ofert.

---

## 9. Wysylka nowych ofert

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

Raport wysylki:

```text
dist/send-results.json
```

---

## 10. Naprawa istniejacych ofert

`patch-inpost-offers-from-csv.js` naprawia istniejace oferty po `externalId`.
Robi dwie rzeczy w jednym przebiegu:

- aktualizuje `product.categoryId` ta sama logika co generator CSV,
- jezeli aktualny opis w InPost ma mniej niz 100 znakow, generuje opis z CSV ta
  sama logika co `csv-to-inpost-json.js` i wysyla go przez PATCH.

Dry run:

```bash
node patch-inpost-offers-from-csv.js suppla-oferta.csv dist/category-hints.json category-overrides.json dist --dry-run
```

Wykonanie:

```bash
node patch-inpost-offers-from-csv.js suppla-oferta.csv dist/category-hints.json category-overrides.json dist
```

Najwazniejsze raporty:

```text
dist/offer-repair-from-csv-report.json
dist/offer-repair-errors.json
```

`offer-repair-errors.json` grupuje m.in. naprawione kategorie, naprawione opisy,
brak mapowania, duplikaty `externalId` w InPost, oferty bez odpowiednika w InPost
oraz przypadki, w ktorych PATCH przeszedl, ale szybki odczyt nadal pokazuje
stary stan.

---

## 11. Szybka checklista

```bash
node generate-category-hints.js suppla-oferta.csv dist/category-hints.json category-map.json
node csv-to-inpost-json.js suppla-oferta.csv category-map.json dist category-overrides.json dist/category-hints.json
node server.js
node send-inpost-offers.js dist/inpost-offers.json dist/offer-images.json
node patch-inpost-offers-from-csv.js suppla-oferta.csv dist/category-hints.json category-overrides.json dist
```

Przed wysylka sprawdz przede wszystkim:

```text
dist/csv-generation-report.json
dist/csv-generation-errors.json
dist/offer-repair-from-csv-report.json
dist/offer-repair-errors.json
dist/inpost-offers.json
dist/offer-images.json
```
