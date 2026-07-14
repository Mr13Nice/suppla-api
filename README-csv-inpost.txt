# CSV WooCommerce -> InPost Buy

Ostatnia aktualizacja: 2026-07-13.

Ten dokument opisuje aktualny proces pracy z eksportem WooCommerce i ofertami
InPost Buy w tym repozytorium.

Glowne zasady:

- `csv-to-inpost-json.js` generuje oferty z CSV, pilnuje kategorii, opisow i
  duplikatow.
- `send-inpost-offers.js --sync` pobiera aktualne oferty z InPost i wysyla
  tylko roznice z pliku wygenerowanego z CSV.
- Kategorie sa wybierane tylko w kolejnosci: hint po EAN zwrocony przez InPost,
  override po kategorii WooCommerce dla EAN-ow bez hintu, a potem pominiecie
  produktu.
- Generator domyslnie sprawdza istniejace oferty w InPost i nie tworzy ponownie
  ofert o juz istniejacym `externalId`. Do synchronizacji uzyj
  `--include-existing`, zeby wygenerowac pelny obraz CSV.
- Opis produktu jest automatycznie wydluzany do minimum 100 znakow, bo tego
  wymaga InPost.
- Przy synchronizacji istniejacych ofert kategoria referencyjna z bledu
  `CATEGORY_INCORRECT` w InPost ma najwyzszy priorytet. Jezeli InPost nie podaje
  referencji, sync uzywa kategorii z CSV: najpierw poprawnego hintu po EAN,
  potem recznego override'u. Zachowanie aktualnej kategorii z InPost wymaga
  flagi awaryjnej `--preserve-existing-categories`.
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
1. dist/category-hints.json po EAN z endpointu InPost /offers/hint
2. category-overrides.json po kategorii WooCommerce tylko gdy InPost nie zwrocil hintu
3. brak dopasowania -> produkt trafia do raportu i nie jest wysylany
```

Dla istniejacych ofert w `--sync` obowiazuje bezpieczniejsza zasada:

```text
1. jezeli InPost podaje kategorie referencyjna przy CATEGORY_INCORRECT -> uzyj jej
2. jezeli nie ma referencji -> uzyj kategorii z CSV: poprawny hint po EAN, potem override
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

Hint po EAN z InPost jest traktowany jako zrodlo nadrzedne. Lokalna walidacja
drzewa kategorii sluzy do ostrzezen i diagnostyki, ale nie odrzuca hintu tylko
dlatego, ze lokalny plik drzewa nie zna zwroconego `categoryId`.

Aktualne drzewo kategorii mozna pobrac z InPost:

```bash
npm run inpost:categories
```

Ta komenda pobiera `GET /v1/categories?depth=<n>` i zapisuje:

```text
dist/category-tree.json
dist/category-tree-report.json
```

Domyslna glebokosc to `4`; API InPost dopuszcza zakres `0-4`. Mozna ja zmienic
przez `INPOST_CATEGORIES_DEPTH`.
Generator automatycznie laczy dostepne drzewa z plikow:

```text
dist/category-tree.json
inpost-health-categories.txt
inpost.txt
```

Inny plik mozna wskazac przez `INPOST_CATEGORY_TREE_FILE`. Jezeli lokalne drzewo
nie zna hintu albo ma sprzeczne `leaf`, generator zapisuje szczegoly w:

```text
csv-generation-report.json -> totals.hintCategoryWarnings
csv-generation-report.json -> categoryResolution.hintWarningReasons
csv-generation-errors.json -> hintCategoryWarnings
```

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

Pelny proces po podmianie `suppla-oferta.csv`:

```bash
npm run inpost:update-after-csv
```

Ta komenda wykonuje po kolei:

```text
1. npm run inpost:generate-sync
2. npm run inpost:enrich-brands:offline
3. npm run inpost:sync
4. npm run inpost:rescue-overrides
5. npm run inpost:rescue-overrides:sync
```

`inpost:generate-sync` zaczyna od `npm run inpost:categories`, czyli odswiezenia
`dist/category-tree.json` z API InPost.

Wariant kontrolny bez realnej wysylki do InPost:

```bash
npm run inpost:update-after-csv:dry-run
```

Etapy mozna nadal uruchamiac osobno:

```bash
npm run inpost:prepare-after-csv
npm run inpost:publish-after-csv
npm run inpost:rescue-after-csv
```

`inpost:prepare-after-csv` generuje pliki sync i aplikuje lokalna mape marek w
trybie offline. `inpost:publish-after-csv` wysyla glowny sync. `inpost:rescue-after-csv`
generuje i wysyla pliki ratunkowe oparte o override'y kategorii.

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

Opcjonalny krok przed wysylka synca: ponowne otwarcie zamknietych ofert, ktore
w aktualnym CSV maja stan magazynowy wiekszy niz 0. Skrypt porownuje zamkniete
oferty InPost z aktualnym `suppla-oferta.csv` po `externalId`, EAN i SKU.
Domyslnie robi tylko dry-run:

```bash
npm run inpost:reopen-closed-instock
```

Pliki diagnostyczne:

```text
dist/reopen-closed-instock-report.json
dist/reopen-closed-instock-candidates.json
dist/reopen-closed-instock-skipped.json
dist/reopen-closed-instock-errors.json
```

Realne otwarcie ofert:

```bash
npm run inpost:reopen-closed-instock:execute
```

Dla bezpieczenstwa skrypt pomija zamknieta oferte, jezeli dla tego samego
`externalId`, EAN albo SKU istnieje juz aktywny duplikat w InPost. Wymuszenie
tego zachowania jest mozliwe flaga `--allow-active-duplicates`, ale nie powinno
byc domyslnym trybem pracy, bo moze ponownie wywolac `OFFER_UNIQUENESS`.

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

## 7. Uzupelnianie marek w nazwach

Marki w nazwach produktow sa uzupelniane osobnym skryptem, a nie w
`csv-to-inpost-json.js`. Skrypt czyta EAN/SKU z `dist/inpost-offers.json` oraz
z `suppla-oferta.csv`, sprawdza trwala mape `brand-map.json`, a dla brakow
probuje pobrac marke z publicznych katalogow:

```text
Open Beauty Facts
Open Food Facts
Open Products Facts
```

Jezeli marka zostanie znaleziona i nie wystepuje jeszcze w nazwie produktu,
skrypt dopisuje ja jako prefiks oraz aktualizuje `product.brand`. Zrodlo CSV
nie jest modyfikowane.

```bash
npm run inpost:enrich-brands
```

Wyniki:

```text
brand-map.json
dist/inpost-offers.json
dist/brand-enrichment-report.json
```

Podczas pracy skrypt wypisuje postep w konsoli. `dist/brand-enrichment-report.json`
jest odswiezany okresowo ze statusem `running`, a `brand-map.json` jest
zapisywany przyrostowo po znalezieniu marek oraz co pewna liczbe produktow.
`dist/inpost-offers.json` jest zapisywany dopiero na koncu, zeby nie zostawiac
polowicznie zmienionego pliku ofert. Czestotliwosc mozna ustawic flagami
`--progress-every=10` i `--save-every=25`.

Tryb testowy bez zapisu `dist/inpost-offers.json` i `brand-map.json`:

```bash
npm run inpost:enrich-brands:dry-run
```

Tryb offline, tylko z juz zapisanej mapy:

```bash
npm run inpost:enrich-brands:offline
```

Do diagnostyki pojedynczych produktow mozna uruchomic skrypt bezposrednio:

```bash
node enrich-inpost-brands.js suppla-oferta.csv dist/inpost-offers.json brand-map.json dist/brand-enrichment-report.json --dry-run --only-code=3264680003561 --lookup-limit=1
```

Pelne wygenerowanie ofert i natychmiastowe uzupelnienie marek:

```bash
npm run inpost:generate-sync-brands
```

`brand-map.json` ma trzy poziomy:

```text
manual.exact    - reczne dopasowania dokladnego EAN/SKU
manual.prefixes - reczne dopasowania prefiksu kodu, tylko gdy naprawde pewne
codes           - automatycznie zapamietane dopasowania po dokladnym EAN/SKU
```

Najbezpieczniejsze sa wpisy po dokladnym EAN/SKU. Prefiksy powinny byc uzywane
ostroznie, bo sam prefiks EAN nie zawsze jednoznacznie wskazuje marke produktu.

---

## 8. Rescue przez override'y

Rescue to osobny, kontrolowany przebieg dla produktow, ktore:

- zostaly pominiete, bo hint po EAN wskazywal nie-lisc albo ID spoza drzewa,
- albo w ostatnim syncu dostaly z InPost blad `CATEGORY_INCORRECT`.

Ten tryb ignoruje hinty EAN i probuje zbudowac oferty tylko przez reczne
`category-overrides.json`. Jezeli override wskazuje te sama kategorie, ktora
InPost juz odrzucil, produkt jest pomijany i trafia do raportu.

```bash
npm run inpost:rescue-overrides
npm run inpost:rescue-overrides:dry-run
npm run inpost:rescue-overrides:sync
```

Pliki rescue sa osobne i nie nadpisuja glownego synca:

```text
dist/inpost-offers-rescue-overrides.json
dist/offer-images-rescue-overrides.json
dist/rescue-overrides-report.json
dist/rescue-overrides-errors.json
```

`npm run inpost:rescue-overrides` czyta domyslnie:

```text
dist/csv-generation-errors.json
dist/send-sync-errors.json
```

Inne pliki raportow mozna wskazac przez:

```env
INPOST_RESCUE_GENERATION_ERRORS_FILE=...
INPOST_RESCUE_SYNC_ERRORS_FILE=...
```

---

## 8. Ochrona przed duplikatami

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

## 9. Hinty kategorii po EAN

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

## 10. Publikacja zmian z nowego CSV

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
- przy duplikatach `externalId` wybiera jeden kanoniczny rekord do PATCH wedlug
  priorytetu statusu: `PUBLISHED`/`ACTIVE`, `SOLDOUT`, `PENDING`, `DRAFT`, potem
  pozostale niezamkniete; statusy zamkniete/terminalne sa pomijane,
- pominiete duplikaty zapisuje w `send-sync-report.json` oraz
  `send-sync-errors.json -> skippedDuplicates`,
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

## 11. Naprawa istniejacych ofert

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

## 12. Szybka checklista

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

