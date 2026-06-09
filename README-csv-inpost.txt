# CSV WooCommerce -> InPost Buy

Ostatnia aktualizacja: 2026-06-09.

Ten dokument opisuje aktualny proces pracy z eksportem WooCommerce i ofertami
InPost Buy w tym repozytorium.

Glowne zasady:

- `csv-to-inpost-json.js` generuje oferty z CSV, pilnuje kategorii, opisow i
  duplikatow.
- `send-inpost-offers.js --sync` pobiera aktualne oferty z InPost i wysyla
  tylko roznice z pliku wygenerowanego z CSV.
- Kategorie sa wybierane tylko w kolejnosci: hint po EAN, override po kategorii
  WooCommerce, a potem pominiecie produktu.
- Generator domyslnie sprawdza istniejace oferty w InPost i nie tworzy ponownie
  ofert o juz istniejacym `externalId`. Do synchronizacji uzyj
  `--include-existing`, zeby wygenerowac pelny obraz CSV.
- Opis produktu jest automatycznie wydluzany do minimum 100 znakow, bo tego
  wymaga InPost.
- Przy synchronizacji istniejacych ofert kategoria referencyjna z bledu
  `CATEGORY_INCORRECT` w InPost ma najwyzszy priorytet. Jezeli InPost nie podaje
  referencji, sync uzywa kategorii z CSV: najpierw hintu po EAN, potem recznego
  override'u. Zachowanie aktualnej kategorii z InPost wymaga flagi awaryjnej
  `--preserve-existing-categories`.
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

Aktualna kolejnosc przypisania kategorii dla nowych ofert:

```text
1. dist/category-hints.json po EAN
2. category-overrides.json po kategorii WooCommerce
3. brak dopasowania -> produkt trafia do raportu i nie jest wysylany
```

Dla istniejacych ofert w `--sync` obowiazuje bezpieczniejsza zasada:

```text
1. jezeli InPost podaje kategorie referencyjna przy CATEGORY_INCORRECT -> uzyj jej
2. jezeli nie ma referencji -> uzyj kategorii z CSV: hint po EAN, potem override
3. zachowanie aktualnej kategorii z InPost tylko przez --preserve-existing-categories
```

Skrypty nie zgaduja kategorii po nazwie produktu ani po ostatnim segmencie
kategorii WooCommerce. `product.categoryId` musi byc jawnie wyliczone z hintu
albo override'u i najlepiej powinno wskazywac kategorie koncowa InPost.

InPost pozwala publikowac oferty tylko w kategoriach-lisciach (`leaf: true`).
Dlatego wpisy w `category-overrides.json` musza byc wybrane recznie z drzewa
kategorii jako leaf. Jezeli `category-map.json` zawiera bogatsze obiekty z
`leaf: false`, generator zablokuje taki override. Obecny prosty format
`"sciezka": "categoryId"` nie niesie informacji o `leaf`, wiec nie da sie tego
potwierdzic automatycznie bez pelnego drzewa kategorii.

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

Pelny plik ofert do synchronizacji roznic z InPost:

```bash
node csv-to-inpost-json.js suppla-oferta.csv category-map.json dist category-overrides.json dist/category-hints.json --include-existing
```

Skrot npm:

```bash
npm run inpost:generate-sync
```

W trybie `--include-existing` generator pobiera aktualne oferty z InPost. Jezeli
istniejaca oferta ma blad `CATEGORY_INCORRECT` z kategoria referencyjna, generator
nadpisuje `product.categoryId` w `dist/inpost-offers.json` ta referencja. Jezeli
referencji nie ma, generator uzywa kategorii wyliczonej z CSV: hintu po EAN,
a dopiero potem recznego override'u.

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
inpostReferenceCategoryOverrides
inpostCurrentCategoryPreserved
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

## 9. Publikacja zmian z nowego CSV

Najkrotszy bezpieczny flow po aktualizacji CSV:

1. Wygeneruj pelny plik ofert z CSV:

```bash
npm run inpost:generate-sync
```

2. Uruchom lokalny serwer w osobnym terminalu:


```bash
node server.js
```

3. Sprawdz plan roznic bez zapisu w InPost:

```bash
npm run inpost:sync:dry-run
```

4. Jezeli raport wyglada dobrze, wyslij roznice:

```bash
npm run inpost:sync
```

Co robi `send-inpost-offers.js --sync`:

- pobiera aktualne oferty z InPost przez lokalny endpoint,
- dopasowuje je po `externalId`,
- dla istniejacych ofert pobiera szczegoly i porownuje pola generowane z CSV:
  `product`, `stock`, `price`, `affiliationProductUrl`,
- jezeli szczegoly istniejacej oferty zawieraja `CATEGORY_INCORRECT` z kategoria
  referencyjna, uzywa tej kategorii zamiast kategorii wyliczonej z CSV,
- jezeli referencji nie ma, uzywa kategorii wyliczonej z CSV,
- wysyla PATCH tylko dla roznic,
- jezeli oferty nie ma w InPost, tworzy ja jak w starym trybie i dodaje pierwsze
  zdjecie z `dist/offer-images.json`,
- w trybie `--dry-run` nie tworzy i nie patchuje niczego, tylko zapisuje plan.

Najwazniejsze raporty sync:

```text
dist/send-sync-report.json
dist/send-sync-errors.json
```

Stary tryb tylko tworzenia nowych ofert nadal dziala:

```bash
node send-inpost-offers.js dist/inpost-offers.json dist/offer-images.json
```

Raport starego trybu create-only:

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
npm run inpost:generate-sync
node server.js
npm run inpost:sync:dry-run
npm run inpost:sync
```

Przed wysylka sprawdz przede wszystkim:

```text
dist/csv-generation-report.json
dist/csv-generation-errors.json
dist/send-sync-report.json
dist/send-sync-errors.json
dist/inpost-offers.json
dist/offer-images.json
```
