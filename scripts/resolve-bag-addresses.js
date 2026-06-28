import {
  featureAddress,
  fetchText,
  normalizePostcode,
  normalizeText,
  parseArgs,
  parseHouseNumber,
  readJson,
  sleep,
  writeJson
} from "./lib.js";

const LOCATIESERVER_URL = "https://api.pdok.nl/bzk/locatieserver/search/v3_1/free";
const MIN_CONFIDENT_SCORE = 17;
const MIN_SCORE_GAP = 3;

function addressQuery(address) {
  return [address.street, address.housenumber, address.postcode, address.city]
    .filter(Boolean)
    .join(" ");
}

function normalizedBagAddition(doc) {
  return String(doc.huisnummertoevoeging ?? "").trim().toUpperCase();
}

function evaluateCandidate(address, doc) {
  const requestedHouse = parseHouseNumber(address.housenumber);
  const candidatePostcode = normalizePostcode(doc.postcode);
  const requestedPostcode = normalizePostcode(address.postcode);
  const streetMatches = normalizeText(doc.straatnaam) === normalizeText(address.street);
  const cityMatches = !address.city || normalizeText(doc.woonplaatsnaam) === normalizeText(address.city);
  const postcodeMatches = !requestedPostcode || candidatePostcode === requestedPostcode;
  const houseNumberMatches = Number(doc.huisnummer) === Number(requestedHouse.houseNumber);
  const houseLetterMatches =
    !requestedHouse.houseLetter ||
    String(doc.huisletter ?? "").toUpperCase() === requestedHouse.houseLetter ||
    normalizedBagAddition(doc) === requestedHouse.houseLetter;
  const additionMatches =
    !requestedHouse.houseAddition ||
    normalizedBagAddition(doc) === requestedHouse.houseAddition ||
    String(doc.huisletter ?? "").toUpperCase() === requestedHouse.houseAddition;

  let score = 0;
  if (postcodeMatches && requestedPostcode) score += 8;
  if (houseNumberMatches) score += 6;
  if (streetMatches) score += 5;
  if (cityMatches && address.city) score += 3;
  if (houseLetterMatches && requestedHouse.houseLetter) score += 2;
  if (additionMatches && requestedHouse.houseAddition) score += 2;

  if (requestedPostcode && !postcodeMatches) score -= 10;
  if (!houseNumberMatches) score -= 10;
  if (!streetMatches) score -= 6;
  if (address.city && !cityMatches) score -= 3;
  if (requestedHouse.houseLetter && !houseLetterMatches) score -= 2;
  if (requestedHouse.houseAddition && !additionMatches) score -= 2;

  return {
    score,
    checks: {
      postcodeMatches,
      houseNumberMatches,
      streetMatches,
      cityMatches,
      houseLetterMatches,
      additionMatches,
      requestedPostcode: Boolean(requestedPostcode),
      requestedCity: Boolean(address.city)
    }
  };
}

function isConfident(address, evaluated) {
  const checks = evaluated.matchChecks ?? evaluated.checks;
  if (!checks) return false;
  if (evaluated.localScore < MIN_CONFIDENT_SCORE) return false;
  if (!checks.houseNumberMatches || !checks.streetMatches) return false;
  if (checks.requestedPostcode && !checks.postcodeMatches) return false;
  if (!checks.requestedPostcode && checks.requestedCity && !checks.cityMatches) return false;
  return true;
}

async function resolveAddress(address) {
  const query = addressQuery(address);
  if (!address.street || !address.housenumber || (!address.postcode && !address.city)) {
    return { status: "missing_address", query, candidates: [] };
  }

  const params = new URLSearchParams({
    q: query,
    fq: "type:adres",
    rows: "5",
    fl: [
      "weergavenaam",
      "straatnaam",
      "huisnummer",
      "huisletter",
      "huisnummertoevoeging",
      "postcode",
      "woonplaatsnaam",
      "adresseerbaarobject_id",
      "nummeraanduiding_id",
      "score"
    ].join(",")
  });
  const payload = JSON.parse(await fetchText(`${LOCATIESERVER_URL}?${params}`));
  const candidates = (payload.response?.docs ?? [])
    .map((doc) => {
      const evaluated = evaluateCandidate(address, doc);
      return { ...doc, localScore: evaluated.score, matchChecks: evaluated.checks };
    })
    .sort((a, b) => b.localScore - a.localScore || b.score - a.score);
  const best = candidates[0];
  if (!best || !isConfident(address, best)) {
    return { status: "unmatched", query, candidates };
  }
  const second = candidates[1];
  const closeSecond = second && best.localScore - second.localScore < MIN_SCORE_GAP;
  return {
    status: closeSecond ? "ambiguous" : "resolved",
    query,
    best,
    candidates
  };
}

// Keep a compact, serializable view of every candidate the resolver considered.
// The BAG area step re-examines these to disambiguate shop-vs-flat ties using
// gebruiksdoel/status/oppervlakte, which the address-only resolver cannot see.
function candidateSummary(candidate) {
  const checks = candidate.matchChecks ?? {};
  return {
    bag_addressable_object_id: candidate.adresseerbaarobject_id ?? null,
    bag_number_designation_id: candidate.nummeraanduiding_id ?? null,
    bag_display_name: candidate.weergavenaam ?? null,
    bag_resolver_score: candidate.score ?? null,
    bag_local_score: candidate.localScore ?? null,
    address_matches: Boolean(
      checks.houseNumberMatches &&
        checks.streetMatches &&
        (!checks.requestedPostcode || checks.postcodeMatches)
    )
  };
}

const args = parseArgs(process.argv.slice(2));
const input = args.input || "data/raw/supermarkets-osm.geojson";
const out = args.out || "data/processed/supermarkets-bag-ids.geojson";
const delayMs = Number(args.delay || 175);
const collection = await readJson(input);
const features = [];

for (let i = 0; i < collection.features.length; i += 1) {
  const feature = collection.features[i];
  const address = featureAddress(feature);
  const resolved = await resolveAddress(address);
  const props = feature.properties ?? {};
  const best = resolved.best;
  features.push({
    ...feature,
    properties: {
      ...props,
      bag_match_status: resolved.status,
      bag_query: resolved.query,
      bag_addressable_object_id: best?.adresseerbaarobject_id ?? null,
      bag_number_designation_id: best?.nummeraanduiding_id ?? null,
      bag_display_name: best?.weergavenaam ?? null,
      bag_resolver_score: best?.score ?? null,
      bag_local_score: best?.localScore ?? null,
      bag_candidate_count: resolved.candidates.length,
      bag_match_checks: best?.matchChecks ?? null,
      bag_candidates: (resolved.candidates ?? []).map(candidateSummary)
    }
  });
  if ((i + 1) % 25 === 0 || i + 1 === collection.features.length) {
    console.log(`Resolved ${i + 1}/${collection.features.length}`);
  }
  if (i + 1 < collection.features.length) await sleep(delayMs);
}

const counts = features.reduce((acc, feature) => {
  const status = feature.properties.bag_match_status;
  acc[status] = (acc[status] ?? 0) + 1;
  return acc;
}, {});

await writeJson(out, {
  ...collection,
  metadata: {
    ...(collection.metadata ?? {}),
    bagResolver: "PDOK Locatieserver",
    resolvedAt: new Date().toISOString(),
    matchCounts: counts
  },
  features
});

console.log(`Wrote ${features.length} resolved features to ${out}`);
console.log(JSON.stringify(counts, null, 2));
