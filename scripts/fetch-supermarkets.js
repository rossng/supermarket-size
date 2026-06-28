import { fetchText, parseArgs, writeJson } from "./lib.js";

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const DEFAULT_OUT = "data/raw/supermarkets-osm.geojson";

// Curated Dutch supermarket chains, matched as case-insensitive substrings of
// OSM brand/name/operator. Derived from the actual brand distribution of
// shop=supermarket in NL. Each needle is broad enough to catch a chain's
// sub-formats (e.g. "Albert Heijn" -> "Albert Heijn XL"; "Jumbo" -> "Jumbo
// Foodmarkt"; "Coop" -> "Gewoon Coop Compact"; "SPAR" -> "SPAR university";
// "Boon's" -> "Boon's Dagmarkt"). Border/ethnic one-offs (Carrefour,
// POLOmarket, Polski Sklep, ...) are intentionally excluded.
const CHAIN_PRESETS = {
  nl: [
    // National full-service
    "Albert Heijn",
    "Jumbo",
    "PLUS",
    "Coop",
    "SPAR",
    "Dirk",
    "Vomar",
    "Hoogvliet",
    "DekaMarkt",
    "Deen",
    "Nettorama",
    "Poiesz",
    "Boni",
    "Jan Linders",
    "MCD",
    "Dagwinkel",
    "Boon's",
    "Troefmarkt",
    "Attent",
    // Discounters
    "Lidl",
    "ALDI",
    // Organic / specialty
    "Ekoplaza",
    "Marqt",
    "Odin",
    "Natuurwinkel",
    // Asian
    "Amazing Oriental"
  ]
};

function tagValue(tags, keys) {
  for (const key of keys) {
    if (tags[key]) return tags[key];
  }
  return "";
}

function matchesChain(tags, chain) {
  const needle = chain.toLowerCase();
  return [tags.brand, tags.name, tags.operator]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(needle));
}

// Keep any element matching at least one requested chain. An empty list keeps
// every shop=supermarket (the original behaviour).
function matchesAnyChain(tags, chains) {
  if (!chains.length) return true;
  return chains.some((chain) => matchesChain(tags, chain));
}

function elementPoint(element) {
  if (typeof element.lon === "number" && typeof element.lat === "number") {
    return [element.lon, element.lat];
  }
  if (element.center) return [element.center.lon, element.center.lat];
  return null;
}

function elementToFeature(element) {
  const tags = element.tags ?? {};
  const point = elementPoint(element);
  if (!point) return null;
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: point },
    properties: {
      osm_type: element.type,
      osm_id: element.id,
      name: tagValue(tags, ["name", "brand", "operator"]) || "Supermarket",
      brand: tagValue(tags, ["brand"]),
      operator: tagValue(tags, ["operator"]),
      street: tagValue(tags, ["addr:street"]),
      housenumber: tagValue(tags, ["addr:housenumber"]),
      postcode: tagValue(tags, ["addr:postcode"]),
      city: tagValue(tags, ["addr:city", "addr:place"]),
      floor_area_m2: null,
      area_status: "not_attached",
      osm_tags: tags
    }
  };
}

function overpassQuery() {
  return `
    [out:json][timeout:180];
    area["ISO3166-1"="NL"][admin_level=2]->.nl;
    (
      node["shop"="supermarket"](area.nl);
      way["shop"="supermarket"](area.nl);
      relation["shop"="supermarket"](area.nl);
    );
    out tags center;
  `;
}

const args = parseArgs(process.argv.slice(2));
const outPath = args.out || DEFAULT_OUT;
const body = new URLSearchParams({ data: overpassQuery() }).toString();
const response = JSON.parse(
  await fetchText(args.endpoint || OVERPASS_URL, {
    method: "POST",
    body,
    headers: { "content-type": "application/x-www-form-urlencoded" }
  })
);

// Accept a --preset (e.g. nl), a single --chain, and/or a comma-separated
// --chains list. They combine; an empty result keeps every shop=supermarket.
if (args.preset && !CHAIN_PRESETS[args.preset]) {
  throw new Error(`Unknown --preset "${args.preset}". Known presets: ${Object.keys(CHAIN_PRESETS).join(", ")}`);
}
const chains = [
  ...(args.preset ? CHAIN_PRESETS[args.preset] : []),
  ...(args.chain ? [String(args.chain)] : []),
  ...(args.chains ? String(args.chains).split(",") : [])
]
  .map((value) => value.trim())
  .filter(Boolean);

const features = (response.elements ?? [])
  .filter((element) => matchesAnyChain(element.tags ?? {}, chains))
  .map(elementToFeature)
  .filter(Boolean)
  .sort((a, b) => {
    const name = a.properties.name.localeCompare(b.properties.name);
    return name || a.properties.osm_id - b.properties.osm_id;
  });

await writeJson(outPath, {
  type: "FeatureCollection",
  metadata: {
    source: "OpenStreetMap Overpass",
    fetchedAt: new Date().toISOString(),
    query: chains.length ? `shop=supermarket, chain in [${chains.join(", ")}]` : "shop=supermarket",
    chains,
    license: "OpenStreetMap data is available under the Open Database License."
  },
  features
});

console.log(`Wrote ${features.length} supermarkets to ${outPath}`);
