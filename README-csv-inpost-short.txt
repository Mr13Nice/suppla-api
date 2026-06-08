# Szybka instrukcja: CSV WooCommerce -> InPost Buy

Ostatnia aktualizacja: 2026-06-08.

To jest skrocona checklista do codziennej pracy. Pelny opis jest w
`README-csv-inpost.txt`.

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

## 2. Kolejnosc kategorii

Aktualna logika:

```text
1. dist/category-hints.json po EAN
2. category-overrides.json po kategorii WooCommerce
3. brak dopasowania -> raport i pominiecie
```

EAN/SKU nie przypisuje kategorii automatycznie. `categoryId` musi byc jawnie
ustawione i najlepiej wskazywac kategorie koncowa InPost.

---

## 3. Wygeneruj hinty kategorii

Jezeli zaczynasz od pustego `dist`, zrob najpierw:

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

## 4. Wygeneruj oferty z CSV

```bash
node csv-to-inpost-json.js suppla-oferta.csv category-map.json dist category-overrides.json dist/category-hints.json
```

Sprawdz:

```text
dist/inpost-offers.json
dist/offer-images.json
dist/blocking-skipped-products.json
dist/unresolved-categories.json
dist/products-without-images.json
dist/category-resolution-report.json
```

Do wysylki ida:

```text
dist/inpost-offers.json
dist/offer-images.json
```

---

## 5. Wyslij nowe oferty

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

## 6. Zaktualizuj istniejace oferty

Pelny PATCH z `dist/inpost-offers.json`:

```bash
node patch-inpost-offers.js dist/inpost-offers.json dist --dry-run
node patch-inpost-offers.js dist/inpost-offers.json dist
```

Najwazniejsze raporty:

```text
dist/patch-offers-report.json
dist/patch-offers-success.json
dist/patch-offers-errors.json
dist/patch-offers-missing-existing.json
dist/patch-offers-duplicates-in-inpost.json
```

---

## 7. Napraw tylko kategorie istniejacych ofert

Dry run:

```bash
node patch-inpost-categories-from-csv.js suppla-oferta.csv dist/category-hints.json category-overrides.json dist --dry-run
```

Wykonanie:

```bash
node patch-inpost-categories-from-csv.js suppla-oferta.csv dist/category-hints.json category-overrides.json dist
```

Najwazniejsze raporty:

```text
dist/category-repair-from-csv-report.json
dist/category-repair-patched.json
dist/category-repair-already-correct.json
dist/category-repair-stale-category-errors.json
dist/category-repair-unchanged-after-patch.json
dist/category-repair-errors.json
dist/category-repair-missing-existing.json
dist/category-repair-no-category-mapping.json
dist/category-repair-duplicates-in-inpost.json
```

Ostatni wynik raportu:

```text
CSV: 2128 wierszy
Wyliczone categoryId: 2017
Brak mapowania: 111
Pobrane oferty InPost: 1280
Duplikaty externalId w InPost: 384
PATCH + verify: 21
Juz poprawne: 667
Stale CATEGORY_INCORRECT: 136
PATCH przyjety, ale kategoria niezmieniona: 590
Bledy: 0
Brak oferty w InPost po externalId: 1173
```

Po takim wyniku sprawdz najpierw:

```text
dist/category-repair-unchanged-after-patch.json
dist/category-repair-stale-category-errors.json
dist/category-repair-duplicates-in-inpost.json
dist/category-repair-no-category-mapping.json
```

---

## 8. Sprzatanie duplikatow `externalId`

Tylko raport:

```bash
node cleanup-inpost-duplicate-offers.js dist
```

Wykonanie:

```bash
node cleanup-inpost-duplicate-offers.js dist --execute
```

Tylko zamykanie, bez DELETE:

```bash
node cleanup-inpost-duplicate-offers.js dist --execute --close-only
```

Raporty:

```text
dist/duplicate-offers-report.json
dist/duplicate-offers-groups.json
dist/duplicate-offers-planned-actions.json
dist/duplicate-offers-success.json
dist/duplicate-offers-errors.json
```

---

## 9. Zamykanie ofert blednych

Symulacja ofert z `validationErrors`:

```bash
node close-inpost-offers.js --mode invalid --out dist
```

Wykonanie:

```bash
node close-inpost-offers.js --mode invalid --out dist --execute
```

Raporty:

```text
dist/offers-to-close.json
dist/offers-not-closed.json
dist/closed-offers-report.json
```

---

## 10. Najkrotszy workflow

Nowe oferty:

```bash
npm install
mkdir dist
node generate-category-hints.js suppla-oferta.csv dist/category-hints.json category-map.json
node csv-to-inpost-json.js suppla-oferta.csv category-map.json dist category-overrides.json dist/category-hints.json
node server.js
```

Drugi terminal:

```bash
node send-inpost-offers.js dist/inpost-offers.json dist/offer-images.json
```

Naprawa kategorii juz istniejacych ofert:

```bash
node patch-inpost-categories-from-csv.js suppla-oferta.csv dist/category-hints.json category-overrides.json dist --dry-run
node patch-inpost-categories-from-csv.js suppla-oferta.csv dist/category-hints.json category-overrides.json dist
```

---

## 11. Najwazniejsze zasady

- Najpierw uruchamiaj `--dry-run`, jezeli skrypt go obsluguje.
- Nie usuwaj `dist/category-hints.json`, jezeli nie chcesz pobierac hintow ponownie.
- Produkty bez zdjec nie przejda do wysylki.
- Brak kategorii poprawiaj w `category-overrides.json` albo przez nowe hinty.
- Przy duplikatach `externalId` najpierw generuj raport, potem dopiero `--execute`.
- Po kazdej operacji sprawdz raporty w `dist`.
