# Fuzzy Matching Guide

This project intentionally keeps the automatic match conservative. A bad BAG match is worse than a missing floor area because the UI presents area as the main signal.

## Default Pipeline

Run the strict path first:

```sh
npm run fetch:ah
npm run resolve:bag
npm run attach:area
```

The strict resolver should only mark a store as `resolved` when:

- OSM has enough address data.
- Street and house number match the PDOK Locatieserver candidate.
- Postcode matches when OSM provides one.
- No close competing candidate exists.

The area join then rejects:

- unconfirmed address matches,
- BAG objects outside the default `100..10000 m2` range,
- BAG objects whose status is not an active/in-use status.

Rejected records keep `bag_raw_area_m2`, `bag_object_status`, and `bag_usage` for review, but `floor_area_m2` remains `null`.

## BAG-aware disambiguation

The PDOK Locatieserver resolver scores candidates on address fields only
(postcode, street, house number, city, letter/addition). It cannot see the BAG
`gebruiksdoel`, `status`, or `oppervlakte`. That breaks down whenever several
addressable objects share one street + house number + postcode, which is common:

- a supermarket on the ground floor with flats above it at the same number
  (e.g. `Postjesweg 65-H` winkel vs `65-1/2/3` woonfunctie), or
- an in-use object plus its not-yet-in-use (`Verblijfsobject gevormd`)
  replacement at the same address (e.g. two `Frederik Hendrikstraat 81` units).

All of these tie on the address-only score, so the correct object is demoted to
`ambiguous`, or the literal best is a small back-office/secondary-address unit.

To handle this, `resolve-bag-addresses.js` now persists every candidate it
considered as `bag_candidates` (id, scores, and an `address_matches` flag), and
`attach-bag-area.js` re-ranks those candidates with the BAG signals the resolver
never saw. A candidate is treated as the store unit when it is:

- `gebruiksdoel` containing `winkel`,
- in an allowed/in-use `status`, and
- within the `100..10000 m2` area range.

The largest such unit at the matched address wins, and the feature is tagged
`bag_disambiguated=true`. Rules:

- `resolved`: keep the resolver's pick when it passes the filters; only fall
  back to a sibling winkelfunctie unit when the pick itself fails (e.g. it is a
  tiny back-office object).
- `ambiguous`: never trust the best blindly (a flat can pass the area filter
  too). Attach only when a single in-use winkelfunctie unit confirms the store;
  otherwise leave it `area_skipped_unconfirmed_match` for review.

Some stores still cannot be resolved this way because BAG has no single
supermarket-sized winkel object for them (e.g. `Overtoom 454-H`, where the store
spans many small units and its primary BAG object is an 88 m2
`bijeenkomstfunctie`). Those correctly stay rejected and flow to the nearby
candidate step below rather than getting a fabricated area.

## Generate Nearby BAG Candidates

After the strict run, collect nearby BAG addresses for everything unresolved, ambiguous, or area-rejected:

```sh
npm run collect:fuzzy
```

This writes:

```txt
data/processed/fuzzy-candidates.json
```

The candidate generator:

- reads supermarket point coordinates,
- converts WGS84 coordinates to Rijksdriehoek coordinates,
- queries the BAG `verblijfsobject` RTree within a default `120 m` radius,
- lists nearby BAG addresses with distance, BAG area, status, usage, and a simple fuzzy score.

Useful options:

```sh
node scripts/collect-nearby-bag-candidates.js --radius 200 --limit 50
node scripts/collect-nearby-bag-candidates.js --all
```

## Review Heuristics

Prefer candidates that satisfy most of these:

- close to the OSM supermarket point, normally within `30..80 m`,
- same or nearby street name,
- same house number or a plausible mall/complex address,
- `gebruiksdoel` includes `winkelfunctie`, or the area otherwise looks store-like,
- `status` is `Verblijfsobject in gebruik`,
- area is plausible for the chain format.

Be careful around:

- malls and shopping streets with many addressable units,
- stations and airports,
- stores inside a larger building object,
- AH to go / small city stores,
- stores with OSM points placed at entrances rather than unit centroids.

## Manual Override Step

Some stores cannot be matched automatically from OSM + BAG alone:

- the OSM address is simply wrong and the real store is at a different house
  number on a busy street, where a spatial guess is ambiguous (e.g. AH #1594
  is tagged `Stadhouderskade 101` but is really `Stadhouderskade 111-H`, a
  402 m2 winkel — yet there is a larger 512 m2 winkel two doors down), or
- BAG models the store in a way no address/area rule can match (e.g. Overtoom
  454-H, whose object is a tiny `bijeenkomstfunctie` unit).

These are handled by `scripts/apply-bag-overrides.js`, which reads the strict
resolved GeoJSON and a tracked override table:

```txt
data/manual/bag-overrides.csv
```

```csv
osm_type,osm_id,bag_addressable_object_id,decision,notes
node,2507164270,0363010001014967,accept,"AH #1594: OSM addr 101 wrong; store is 111-H"
way,456,,reject,no plausible BAG object found
```

Run it after `resolve:bag` and before `attach:area`:

```sh
npm run overrides:apply
```

It:

1. matches each row to a feature by `osm_type` + `osm_id`,
2. for `decision=accept`, replaces `bag_addressable_object_id`, sets
   `bag_match_status=manual`, and records `manual_match_notes`,
3. for `decision=reject`, sets `bag_match_status=manual_reject`.

`attach-bag-area.js` then trusts a `manual` pin and attaches its BAG area
(`area_status=area_manual`) **without** applying the range/status filters — the
reviewer has already vouched for the object — while `manual_reject` blocks any
area (`area_manual_reject`). Re-running `resolve:bag` overwrites the resolver
output, so re-run `overrides:apply` after it.

Do not auto-accept fuzzy candidates solely by score until a sample has been manually checked.
