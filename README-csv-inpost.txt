# CSV WooCommerce -> JSON InPost Buy

## Instalacja

npm install csv-parse he

## Pliki

- csv-to-inpost-json.js — skrypt konwertujący CSV na JSON ofert
- category-map.example.json — przykładowa mapa kategorii WooCommerce -> categoryId InPost

Skopiuj mapę:

copy category-map.example.json category-map.json

albo na macOS/Linux:

cp category-map.example.json category-map.json

## Uruchomienie

node csv-to-inpost-json.js produkty.csv

Opcjonalnie:

node csv-to-inpost-json.js produkty.csv category-map.json dist

## Wyniki

- dist/inpost-offers.json — tablica ofert
- dist/inpost-offers-wrapped.json — format { "offers": [...] }
- dist/skipped-products.json — produkty pominięte
- dist/unresolved-categories.json — kategorie bez mapowania

## Ważne

Do category-map.json wpisuj tylko końcowe kategorie InPost, czyli takie z leaf: true.