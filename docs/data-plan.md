# Data Plan

## Current Scope

Started with one chain (`Albert Heijn`) from OpenStreetMap to validate the BAG join, now widened to the curated `nl` chain preset in `scripts/fetch-supermarkets.js` (`npm run fetch:chains`): the national chains (Albert Heijn, Jumbo, PLUS, Coop, SPAR, Dirk), regional chains (Vomar, Hoogvliet, DekaMarkt, Deen, Nettorama, Poiesz, Boni, Jan Linders, MCD, Dagwinkel, Boon's, Troefmarkt, Attent), discounters (Lidl, ALDI), organic/specialty (Ekoplaza, Marqt, Odin, Natuurwinkel), and Amazing Oriental. The preset was derived from the actual OSM `brand` distribution of NL `shop=supermarket` (~5,200 total; the preset captures ~4,000). Each entry is a case-insensitive substring matched against `brand`/`name`/`operator`; the rest of the pipeline is chain-agnostic. Next step is widening to all `shop=supermarket` independents.

## Acquisition

### BAG

Use the PDOK Atom feed to find the current BAG GeoPackage download. The feed is monthly and includes:

- `BAG (EPSG:28992) Geopackage`
- `bag-light.gpkg`
- current BAG records without history
- public-domain licensing metadata

The full BAG 2.0 XML extract is not needed for the first pass.

### Supermarkets

Use OSM `shop=supermarket` from Overpass as the baseline source. This is preferable to scraping individual chains for the first pass because it is open, broad, and includes coordinates. Where OSM lacks addresses, later chain-specific connectors can fill gaps.

## Matching

1. Normalize supermarket address tags from OSM.
2. Query PDOK Locatieserver with `fq=type:adres`.
3. Score candidates by postcode, street, house number, and city.
4. Store `adresseerbaarobject_id` and `nummeraanduiding_id`.
5. Look up `adresseerbaarobject_id` in BAG GeoPackage table `verblijfsobject`.
6. Attach `oppervlakte` as `floor_area_m2` only when the area and status pass sanity filters.
7. Generate nearby BAG candidates for unresolved or suspicious matches before any fuzzy/manual override pass.

## Quality Checks

- Track match status per feature: `missing_address`, `resolved`, `ambiguous`, `unmatched`, `area_attached`, `area_missing`, `area_rejected_too_small`, `area_rejected_too_large`, `area_rejected_status`.
- Inspect large and small outliers manually.
- Expect false matches around malls, train stations, and multi-address buildings.
- Prefer BAG object ID joins over fuzzy area/name matching once the address is resolved.
- See `docs/fuzzy-matching.md` before broadening fuzzy matching.
