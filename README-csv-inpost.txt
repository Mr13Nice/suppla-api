# CSV WooCommerce -> InPost Buy

Ostatnia aktualizacja: 2026-06-08.

Ten dokument opisuje aktualny proces pracy z eksportem WooCommerce i ofertami
InPost Buy w tym repozytorium. Obejmuje:

- generowanie `category-hints.json` na podstawie EAN,
- generowanie plikow ofert z CSV,
- wysylke nowych ofert,
- aktualizacje istniejacych ofert przez PATCH,
- naprawe samych kategorii istniejacych ofert,
- wykrywanie i sprzatanie duplikatow `externalId`,
- zamykanie ofert blednych.

Wazne: `localhost` jest tylko lokalnym posrednikiem. Jezeli w `.env` masz
`INPOST_BUY_API_BASE=https://api.inpost-group.com/inpsa`, operacje trafiaja do
produkcyjnego API InPost.

---

## 1. Najwazniejsze pliki

W katalogu projektu:

```text
.env
package.json
server.js
csv-to-inpost-json.js
generate-category-hints.js
send-inpost-offers.js
patch-inpost-offers.js
patch-inpost-categories-from-csv.js
cleanup-inpost-duplicate-offers.js
close-inpost-offers.js
suppla-oferta.csv
category-map.json
category-overrides.json
```

### `suppla-oferta.csv`

Eksport produktow z WooCommerce. Skrypty czytaja z niego m.in. `Identyfikator`,
`SKU`, `Nazwa`, `Opis`, `Kategorie`, `Obrazki`, `Stan magazynowy`,
`GTIN, UPC, EAN lub ISBN`.

### `category-map.json`

Mapa kategorii InPost. Sluzy glownie do walidacji, czy uzywane `categoryId`
nalezy do znanych kategorii InPost. Najbezpieczniej trzymac tu tylko kategorie
koncowe, czyli `leaf: true`.

### `category-overrides.json`

Reczne mapowanie kategorii WooCommerce na `categoryId` InPost.

Przyklad:

```json
{
  "Dermokosmetyki > do Twarzy > Kremy na dzien": "c061bf7e-8005-5e33-a58b-1105183a66cf",
  "Dermokosmetyki > do Ciala > Kremy, balsamy i masla": "c8093ba7-6846-59c6-afb9-3cc9364b3d16"
}
```

### `dist/category-hints.json`

Mapowanie EAN -> sugerowane `categoryId` InPost pobrane z endpointu hintow.
Generator ofert i skrypt naprawy kategorii uzywaja tego pliku w pierwszej
kolejnosci.

---

## 2. Instalacja

Najprosciej:

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
```

Opcjonalne ustawienia uzywane przez skrypty PATCH:

```env
INPOST_PATCH_CONTENT_TYPE=application/merge-patch+json
INPOST_REQUEST_DELAY_MS=150
INPOST_OFFERS_PAGE_LIMIT=100
```

Do generowania, pobierania hintow, PATCH i zamykania ofert potrzebne sa przede
wszystkim:

```text
api:categories:read
api:offers:read
api:offers:write
```

Nie commituj `.env`.

---

## 4. Jak dziala mapowanie kategorii

Aktualna kolejnosc jest wspolna dla generatora ofert i naprawy kategorii:

```text
1. category-hints.json po EAN
2. category-overrides.json po kategorii WooCommerce
3. brak przypisania -> produkt/oferta trafia do raportu
```

Skrypty nie zgaduja kategorii po samej nazwie ostatniego segmentu. EAN i SKU
nie zastepuja `product.categoryId`.

`product.categoryId` powinien wskazywac kategorie koncowa InPost. Jezeli ID nie
jest lisciem albo InPost uwaza, ze produkt nalezy do innej kategorii
referencyjnej, w metadanych oferty moze pojawic sie `CATEGORY_INCORRECT`.

---

## 5. Ustawienia generatora

Aktualne kluczowe stale w `csv-to-inpost-json.js`:

```js
const STRICT_MODE = false;
const REQUIRE_IMAGE = true;
const ONLY_PUBLISHED = true;
const SKIP_OUT_OF_STOCK = false;
const INCLUDE_IMAGES_IN_OFFER_JSON = false;
const INCLUDE_META_IN_OFFERS = false;
const USE_NAME_AS_FALLBACK_DESCRIPTION = false;
```

Znaczenie:

- `STRICT_MODE = false`: bledne produkty trafiaja do raportow, a poprawne do JSON.
- `REQUIRE_IMAGE = true`: produkty bez zdjec sa pomijane.
- `ONLY_PUBLISHED = true`: brane sa tylko produkty opublikowane w WooCommerce.
- `SKIP_OUT_OF_STOCK = false`: produkty ze stanem `0` moga trafic do JSON.
- `INCLUDE_IMAGES_IN_OFFER_JSON = false`: zdjecia sa w `dist/offer-images.json`.
- `INCLUDE_META_IN_OFFERS = false`: techniczne `_meta` nie trafia do oferty.
- `USE_NAME_AS_FALLBACK_DESCRIPTION = false`: brak opisu nie jest uzupelniany nazwa.

---

## 6. Bezpieczny workflow od CSV do nowych ofert

### Krok 1: wyczysc `dist`

PowerShell:

```powershell
Remove-Item -Recurse -Force dist
New-Item -ItemType Directory dist
```

CMD:

```bash
rmdir /s /q dist
mkdir dist
```

Uwaga: jezeli masz w `dist/category-hints.json` aktualne hinty i nie chcesz ich
pobierac ponownie, nie usuwaj `dist` albo zachowaj ten plik.

### Krok 2: wygeneruj hinty kategorii po EAN

```bash
node generate-category-hints.js suppla-oferta.csv dist/category-hints.json category-map.json
```

Pliki wynikowe:

```text
dist/category-hints.json
dist/category-hints-report.json
```

### Krok 3: wygeneruj JSON ofert

```bash
node csv-to-inpost-json.js suppla-oferta.csv category-map.json dist category-overrides.json dist/category-hints.json
```

Najwazniejsze pliki wynikowe:

```text
dist/inpost-offers.json
dist/inpost-offers-wrapped.json
dist/offer-images.json
dist/skipped-products.json
dist/blocking-skipped-products.json
dist/products-without-images.json
dist/short-descriptions.json
dist/unresolved-categories.json
dist/category-resolution-report.json
```

Jezeli `category-overrides.json` zawiera bledne ID kategorii, generator moze
dopisac:

```text
dist/invalid-category-overrides.json
```

### Krok 4: sprawdz raporty

Przed wysylka sprawdz szczegolnie:

```text
dist/inpost-offers.json
dist/offer-images.json
dist/blocking-skipped-products.json
dist/unresolved-categories.json
dist/products-without-images.json
dist/category-resolution-report.json
```

Do wysylki sluza:

```text
dist/inpost-offers.json
dist/offer-images.json
```

---

## 7. Wysylka nowych ofert

`send-inpost-offers.js` wysyla oferty przez lokalny `server.js`, dlatego najpierw
uruchom serwer.

Terminal 1:

```bash
node server.js
```

Kontrola:

```text
http://localhost:3000/
http://localhost:3000/api/inpost/token-test
```

Terminal 2, utworzenie testowych 3 ofert:

```bash
node -e "const fs=require('fs'); const offers=require('./dist/inpost-offers.json'); const test=offers.slice(0,3); fs.writeFileSync('./dist/inpost-offers-test.json', JSON.stringify(test,null,2)); const images=require('./dist/offer-images.json'); const ids=new Set(test.map(o=>String(o.externalId))); const testImages=Object.fromEntries(Object.entries(images).filter(([id])=>ids.has(String(id)))); fs.writeFileSync('./dist/offer-images-test.json', JSON.stringify(testImages,null,2)); console.log('Utworzono pliki testowe:', test.length);"
```

Wysylka testu:

```bash
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

Skrypt omija `externalId`, ktore maja juz `ok: true` w `send-results.json`, wiec
mozna wznowic wysylke po bledzie.

---

## 8. Aktualizacja istniejacych ofert pelnym payloadem

Uzyj tego, gdy oferta juz istnieje w InPost i chcesz zaktualizowac ja na
podstawie `dist/inpost-offers.json`.

Najpierw dry run:

```bash
node patch-inpost-offers.js dist/inpost-offers.json dist --dry-run
```

Wlasciwe wykonanie:

```bash
node patch-inpost-offers.js dist/inpost-offers.json dist
```

Raporty:

```text
dist/patch-offers-report.json
dist/patch-offers-success.json
dist/patch-offers-errors.json
dist/patch-offers-missing-existing.json
dist/patch-offers-invalid-input.json
dist/patch-offers-duplicates-in-inpost.json
dist/patch-offers-dry-run.json
```

PATCH uzywa domyslnie:

```text
application/merge-patch+json
```

---

## 9. Naprawa kategorii istniejacych ofert z CSV

`patch-inpost-categories-from-csv.js` naprawia tylko `product.categoryId`
istniejacych ofert. Dopasowuje oferty po `externalId` z CSV.

Kolejnosc wyboru kategorii:

```text
1. EAN z CSV -> dist/category-hints.json
2. Kategorie WooCommerce -> category-overrides.json
3. brak dopasowania -> raport no-category-mapping
```

Dry run:

```bash
node patch-inpost-categories-from-csv.js suppla-oferta.csv dist/category-hints.json category-overrides.json dist --dry-run
```

Wlasciwe wykonanie:

```bash
node patch-inpost-categories-from-csv.js suppla-oferta.csv dist/category-hints.json category-overrides.json dist
```

Raporty:

```text
dist/category-repair-from-csv-report.json
dist/category-repair-patched.json
dist/category-repair-already-correct.json
dist/category-repair-stale-category-errors.json
dist/category-repair-unchanged-after-patch.json
dist/category-repair-errors.json
dist/category-repair-missing-existing.json
dist/category-repair-no-category-mapping.json
dist/category-repair-invalid-rows.json
dist/category-repair-duplicate-external-ids-in-csv.json
dist/category-repair-category-conflicts.json
dist/category-repair-duplicates-in-inpost.json
dist/category-repair-dry-run.json
```

Co oznaczaja najwazniejsze raporty:

- `category-repair-patched.json`: kategoria zmieniona i zweryfikowana.
- `category-repair-already-correct.json`: oferta miala juz oczekiwany `categoryId`.
- `category-repair-stale-category-errors.json`: oferta miala albo nadal ma problem
  `CATEGORY_INCORRECT`; sprawdz `validationErrorsBefore` i `validationErrorsAfter`.
- `category-repair-unchanged-after-patch.json`: InPost przyjal PATCH, ale po
  weryfikacji `categoryId` nie zmienil sie.
- `category-repair-missing-existing.json`: produkt jest w CSV, ale nie znaleziono
  oferty w InPost po `externalId`.
- `category-repair-duplicates-in-inpost.json`: w InPost istnieje wiecej niz jedna
  oferta z tym samym `externalId`.

Aktualny wynik z `dist/category-repair-from-csv-report.json`:

```text
Wiersze CSV: 2128
Produkty z wyliczonym categoryId: 2017
Brak mapowania kategorii: 111
Oferty pobrane z InPost: 1280
Unikalne externalId w InPost: 845
Duplikaty externalId w InPost: 384
Zmienione i zweryfikowane: 21
Juz poprawne: 667
Stale CATEGORY_INCORRECT: 136
PATCH przyjety, ale kategoria niezmieniona: 590
Bledy: 0
Nie znaleziono istniejacej oferty: 1173
Zrodla kategorii: category-hints 1412, category-overrides-exact 605
```

Po takim wyniku nastepne miejsca do sprawdzenia to:

```text
dist/category-repair-unchanged-after-patch.json
dist/category-repair-stale-category-errors.json
dist/category-repair-duplicates-in-inpost.json
dist/category-repair-no-category-mapping.json
```

---

## 10. Duplikaty `externalId`

Do automatycznego planowania sprzatania duplikatow sluzy:

```bash
node cleanup-inpost-duplicate-offers.js dist
```

Domyslnie skrypt tylko tworzy raport i niczego nie zmienia.

Raporty z symulacji:

```text
dist/duplicate-offers-report.json
dist/duplicate-offers-groups.json
dist/duplicate-offers-planned-actions.json
dist/duplicate-offers-without-external-id.json
```

Wykonanie planu:

```bash
node cleanup-inpost-duplicate-offers.js dist --execute
```

Tylko zamykanie, bez proby DELETE:

```bash
node cleanup-inpost-duplicate-offers.js dist --execute --close-only
```

Raporty po wykonaniu:

```text
dist/duplicate-offers-report.json
dist/duplicate-offers-success.json
dist/duplicate-offers-errors.json
dist/duplicate-offers-skipped-already-closed.json
```

---

## 11. Zamykanie ofert

`close-inpost-offers.js` jest narzedziem pomocniczym. Bez `--execute` tworzy
tylko raporty:

```text
dist/offers-to-close.json
dist/offers-not-closed.json
```

Tryb zamykania ofert z `validationErrors`:

```bash
node close-inpost-offers.js --mode invalid --out dist
node close-inpost-offers.js --mode invalid --out dist --execute
```

Tryb zamykania tylko wskazanych `externalId`:

```bash
node close-inpost-offers.js --mode external-ids --bad bad-external-ids.json --out dist
node close-inpost-offers.js --mode external-ids --bad bad-external-ids.json --out dist --execute
```

Tryb zamykania wszystkiego poza lista poprawnych `externalId`:

```bash
node close-inpost-offers.js --mode all-except-keep --keep keep-external-ids.json --out dist
node close-inpost-offers.js --mode all-except-keep --keep keep-external-ids.json --out dist --execute
```

Raport wykonania:

```text
dist/closed-offers-report.json
```

---

## 12. Status ofert

Przez lokalny serwer:

```http
GET http://localhost:3000/api/inpost/offers
GET http://localhost:3000/api/inpost/offers/{offerId}
POST http://localhost:3000/api/inpost/offers/{offerId}/close
```

`offerId` to ID nadane przez InPost, nie `externalId` z WooCommerce.

---

## 13. Najczestsze problemy

### `CATEGORY_INCORRECT`

Mozliwe przyczyny:

- `categoryId` nie jest kategoria koncowa,
- InPost ma inna kategorie referencyjna dla EAN,
- w InPost sa duplikaty tego samego `externalId`,
- walidacja oferty nie odswiezyla sie po zmianie kategorii.

Sprawdz:

```text
dist/category-repair-stale-category-errors.json
dist/category-repair-unchanged-after-patch.json
dist/category-repair-duplicates-in-inpost.json
dist/category-resolution-report.json
```

### Brak mapowania kategorii

Sprawdz:

```text
dist/unresolved-categories.json
dist/category-repair-no-category-mapping.json
```

Uzupelnij `category-overrides.json` albo wygeneruj aktualne `category-hints.json`.

### Brak zdjecia

Sprawdz:

```text
dist/products-without-images.json
dist/offer-images.json
```

`send-inpost-offers.js` wymaga zdjecia w `offer-images.json`.

### Oferta juz istnieje

Gdy `POST` zwraca blad duplikatu `externalId`, uzyj:

```bash
node patch-inpost-offers.js dist/inpost-offers.json dist --dry-run
node patch-inpost-offers.js dist/inpost-offers.json dist
```

albo napraw tylko kategorie:

```bash
node patch-inpost-categories-from-csv.js suppla-oferta.csv dist/category-hints.json category-overrides.json dist --dry-run
```

### Za duzy payload

Nie wklejaj calego `inpost-offers.json` do Postmana. Uzywaj skryptow:

```bash
node send-inpost-offers.js dist/inpost-offers.json dist/offer-images.json
node patch-inpost-offers.js dist/inpost-offers.json dist
```

### `ECONNREFUSED`

Lokalny serwer nie dziala. Uruchom:

```bash
node server.js
```

### `unauthorized_client`

Sprawdz:

- `CLIENT_ID`,
- `CLIENT_SECRET`,
- `INPOST_SCOPE`,
- `INPOST_TOKEN_URL`,
- przypisanie aplikacji do `ORGANIZATION_ID`.

---

## 14. Najkrotsza mapa decyzyjna

```text
Chcesz utworzyc nowe oferty:
  csv-to-inpost-json.js -> server.js -> send-inpost-offers.js

Oferta juz istnieje i chcesz zaktualizowac calosc:
  csv-to-inpost-json.js -> patch-inpost-offers.js

Oferta juz istnieje i chcesz naprawic tylko kategorie:
  generate-category-hints.js -> patch-inpost-categories-from-csv.js

Masz duplikaty externalId:
  cleanup-inpost-duplicate-offers.js

Chcesz zamknac oferty z bledami:
  close-inpost-offers.js --mode invalid
```

---

## 15. Dobre praktyki

- Najpierw rob `--dry-run`, gdy skrypt go obsluguje.
- Nie usuwaj `dist/category-hints.json`, jezeli nie chcesz ponownie odpytywac
  InPost o hinty.
- Nie wysylaj od razu calego katalogu: najpierw test 2-3 ofert.
- Po kazdej duzej operacji sprawdz raport w `dist`.
- Przy duplikatach `externalId` najpierw wygeneruj raport, potem dopiero
  uruchamiaj `--execute`.
- Traktuj `category-overrides.json` jako reczne, kontrolowane mapowanie sklepu na
  kategorie InPost.
