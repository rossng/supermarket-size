# Supermarket Size

A small static MapLibre site for exploring Dutch supermarkets by BAG floor area.

The first data path is:

1. Fetch the current BAG GeoPackage metadata from PDOK Atom.
2. Fetch supermarket locations from OpenStreetMap/Overpass.
3. Resolve OSM addresses to BAG object IDs through PDOK Locatieserver.
4. Join those BAG object IDs to `verblijfsobject.oppervlakte` in the BAG GeoPackage.
5. Publish the enriched GeoJSON into `public/data/supermarkets.geojson`.

This avoids scraping supermarket websites for the first pass. OSM gives broad coverage and PDOK gives BAG-normalized address IDs. Chain store locators can still be added later as supplemental sources when OSM coverage is incomplete.

## Run the Site

```sh
npm run serve
```

Open http://localhost:4173.

The site is static and can be served from `public/` by GitHub Pages.

## Data Commands

Fetch current BAG GeoPackage metadata:

```sh
npm run fetch:bag
```

Download the full BAG GeoPackage:

```sh
npm run download:bag
```

The file is large. On 2026-06-27, PDOK reported `bag-light.gpkg` as about 7.8 GB.

Fetch the combined multi-chain dataset from OSM:

```sh
npm run fetch:chains
```

This uses the curated `nl` chain preset (`--preset nl` in `scripts/fetch-supermarkets.js`): Albert Heijn, Jumbo, PLUS, Coop, SPAR, Dirk, Vomar, Hoogvliet, DekaMarkt, Deen, Nettorama, Poiesz, Boni, Jan Linders, MCD, Dagwinkel, Boon's, Troefmarkt, Attent, Lidl, ALDI, Ekoplaza, Marqt, Odin, Natuurwinkel, and Amazing Oriental. Each name is matched as a case-insensitive substring of OSM `brand`/`name`/`operator`, so chain sub-formats (e.g. `Albert Heijn XL`, `Jumbo Foodmarkt`, `Gewoon Coop Compact`) are included; border/ethnic one-offs are excluded. It captures ~4,000 of the ~5,200 NL `shop=supermarket` (the rest are independents).

This is the default input for the rest of the pipeline. To scope to Albert Heijn only, use `npm run fetch:ah`. For an ad-hoc list use `--chains "Albert Heijn,Jumbo,..."`, or `npm run fetch:supermarkets` for every `shop=supermarket` with no chain filter.

Resolve OSM addresses to BAG IDs:

```sh
npm run resolve:bag
```

Apply manual BAG overrides from `data/manual/bag-overrides.csv` (re-run after every `resolve:bag`, before `attach:area`):

```sh
npm run overrides:apply
```

Attach BAG floor area after `data/raw/bag-light.gpkg` exists:

```sh
npm run attach:area
```

Spatially rescue stores the address match missed, when the building is unambiguous:

```sh
npm run match:pand
```

Some stores have a wrong/imprecise OSM address but their shop is registered at a neighbouring house number in the same building (e.g. Dirk `Tweede Hugo de Grootstraat 45`, whose shop is the winkel at `43`). For every store still without a floor area, this finds the BAG pand polygon containing the OSM point and accepts its in-use `winkelfunctie` unit **only when the building is unambiguous** — exactly one shop unit, or one shop at least `2×` the next-largest (`--dominance`). Malls and shopping streets with several comparable shops are left unmatched. Matches are tagged `area_status=area_pand_match` and `bag_pand_match`.

Export matched BAG building polygons for the map overlay:

```sh
npm run export:buildings
```

This also writes static polygon chunks under `public/data/building-chunks/` so the map can load building outlines for the current view on demand.

Collect nearby BAG address candidates for unresolved, ambiguous, or area-rejected stores:

```sh
npm run collect:fuzzy
```

For UI work before the BAG download finishes, publish the resolved data with unknown areas:

```sh
npm run publish:resolved
```

## Sources

- BAG GeoPackage: https://service.pdok.nl/kadaster/bag/atom/bag.xml
- BAG GeoPackage product page: https://www.kadaster.nl/zakelijk/producten/adressen-en-gebouwen/bag-geopackage
- PDOK Locatieserver: https://api.pdok.nl/bzk/locatieserver/search/v3_1/
- OpenStreetMap Overpass API: https://overpass-api.de/api/interpreter

## Notes

`oppervlakte` is BAG `verblijfsobject` area. It is a useful proxy for likely supermarket choice, but not a guarantee: some stores share buildings, have storage/back-office space, or occupy multiple BAG objects.

The automatic matcher is deliberately conservative. See `docs/fuzzy-matching.md` before accepting fuzzy matches or manual overrides.

The building footprint overlay uses BAG pand geometry, not per-shop unit geometry. When one BAG pand contains multiple supermarkets, the exporter still draws the shared pand geometry, but the map keeps each store circle at its OSM point.
