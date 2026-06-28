import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { featureAddress, normalizePostcode, normalizeText, parseArgs, parseHouseNumber, readJson, writeJson } from "./lib.js";

function sqliteJson(dbPath, sql) {
  const result = spawnSync("sqlite3", ["-readonly", "-json", dbPath, sql], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `sqlite3 exited ${result.status}`);
  }
  return result.stdout.trim() ? JSON.parse(result.stdout) : [];
}

function quoteIdent(name) {
  return `"${String(name).replaceAll('"', '""')}"`;
}

function chooseSchema(dbPath) {
  const tables = sqliteJson(
    dbPath,
    "SELECT table_name FROM gpkg_contents UNION SELECT name AS table_name FROM sqlite_master WHERE type='table';"
  ).map((row) => row.table_name);
  const vboTable =
    tables.find((name) => name.toLowerCase() === "verblijfsobject") ??
    tables.find((name) => name.toLowerCase().includes("verblijfsobject"));
  if (!vboTable) throw new Error("Could not find verblijfsobject table");
  const rtreeTable =
    tables.find((name) => name.toLowerCase() === "rtree_verblijfsobject_geom") ??
    tables.find((name) => name.toLowerCase().includes("rtree_verblijfsobject"));
  if (!rtreeTable) throw new Error("Could not find verblijfsobject RTree table");
  return { vboTable, rtreeTable };
}

function wgs84ToRd(lat, lon) {
  const dLat = 0.36 * (lat - 52.1551744);
  const dLon = 0.36 * (lon - 5.38720621);
  const x =
    155000 +
    190094.945 * dLon -
    11832.228 * dLat * dLon -
    114.221 * dLat ** 2 * dLon -
    32.391 * dLon ** 3 -
    0.705 * dLat -
    2.34 * dLat ** 3 * dLon -
    0.608 * dLat * dLon ** 3 -
    0.008 * dLon ** 2 +
    0.148 * dLat ** 2 * dLon ** 3;
  const y =
    463000 +
    309056.544 * dLat +
    3638.893 * dLon ** 2 +
    73.077 * dLat ** 2 -
    157.984 * dLat * dLon ** 2 +
    59.788 * dLat ** 3 +
    0.433 * dLon -
    6.439 * dLat ** 2 * dLon ** 2 -
    0.032 * dLat * dLon +
    0.092 * dLon ** 4 -
    0.054 * dLat * dLon ** 4;
  return { x, y };
}

function addressScore(address, candidate) {
  const requestedHouse = parseHouseNumber(address.housenumber);
  let score = 0;
  if (normalizePostcode(address.postcode) && normalizePostcode(address.postcode) === normalizePostcode(candidate.postcode)) {
    score += 8;
  }
  if (Number(candidate.huisnummer) === Number(requestedHouse.houseNumber)) score += 6;
  if (normalizeText(candidate.openbare_ruimte_naam) === normalizeText(address.street)) score += 5;
  if (address.city && normalizeText(candidate.woonplaats_naam) === normalizeText(address.city)) score += 3;
  if (candidate.oppervlakte >= 100 && candidate.oppervlakte <= 10000) score += 2;
  if (String(candidate.status).includes("in gebruik")) score += 2;
  // winkelfunctie is the strongest single signal that a unit is the store
  // rather than a flat/back-office at the same address; weight it decisively so
  // the shop unit out-ranks the apartments above it in the review list.
  if (String(candidate.gebruiksdoel).includes("winkel")) score += 4;
  return score;
}

function targetReason(feature) {
  const props = feature.properties ?? {};
  const statuses = [
    props.bag_match_status,
    props.area_status
  ].filter(Boolean);
  if (!statuses.length) return "unknown";
  return statuses.join(",");
}

function shouldCollect(feature, includeAll) {
  if (includeAll) return true;
  const props = feature.properties ?? {};
  return (
    props.bag_match_status !== "resolved" ||
    props.area_status !== "area_attached" ||
    !Number.isFinite(props.floor_area_m2)
  );
}

function nearbyCandidates(dbPath, schema, rd, radius, limit, address) {
  const sql = `
    SELECT
      v.identificatie,
      v.oppervlakte,
      v.status,
      v.gebruiksdoel,
      v.openbare_ruimte_naam,
      v.huisnummer,
      v.huisletter,
      v.toevoeging,
      v.postcode,
      v.woonplaats_naam,
      v.pand_identificatie,
      r.minx,
      r.maxx,
      r.miny,
      r.maxy,
      (((r.minx + r.maxx) / 2.0 - ${rd.x}) * ((r.minx + r.maxx) / 2.0 - ${rd.x}) +
       ((r.miny + r.maxy) / 2.0 - ${rd.y}) * ((r.miny + r.maxy) / 2.0 - ${rd.y})) AS distance2
    FROM ${quoteIdent(schema.vboTable)} v
    JOIN ${quoteIdent(schema.rtreeTable)} r ON r.id = v.feature_id
    WHERE r.maxx >= ${rd.x - radius}
      AND r.minx <= ${rd.x + radius}
      AND r.maxy >= ${rd.y - radius}
      AND r.miny <= ${rd.y + radius}
    ORDER BY distance2 ASC
    LIMIT ${limit * 4};
  `;
  return sqliteJson(dbPath, sql)
    .map((candidate) => ({
      ...candidate,
      distance_m: Math.round(Math.sqrt(candidate.distance2)),
      fuzzy_score: addressScore(address, candidate),
      address: [
        candidate.openbare_ruimte_naam,
        [candidate.huisnummer, candidate.huisletter, candidate.toevoeging].filter(Boolean).join("")
      ].filter(Boolean).join(" "),
      bbox_rd: {
        minx: candidate.minx,
        maxx: candidate.maxx,
        miny: candidate.miny,
        maxy: candidate.maxy
      },
      distance2: undefined,
      minx: undefined,
      maxx: undefined,
      miny: undefined,
      maxy: undefined
    }))
    .sort((a, b) => b.fuzzy_score - a.fuzzy_score || a.distance_m - b.distance_m)
    .slice(0, limit);
}

const args = parseArgs(process.argv.slice(2));
const input = args.input || "public/data/supermarkets.geojson";
const bag = args.bag || "data/raw/bag-light.gpkg";
const out = args.out || "data/processed/fuzzy-candidates.json";
const radius = Number(args.radius || 120);
const limit = Number(args.limit || 25);

if (!existsSync(bag)) {
  throw new Error(`BAG GeoPackage not found at ${bag}`);
}

const collection = await readJson(input);
const schema = chooseSchema(bag);
const targets = collection.features.filter((feature) => shouldCollect(feature, args.all));
const reviews = [];

for (let i = 0; i < targets.length; i += 1) {
  const feature = targets[i];
  const [lon, lat] = feature.geometry.coordinates;
  const rd = wgs84ToRd(lat, lon);
  const address = featureAddress(feature);
  reviews.push({
    osm_type: feature.properties.osm_type,
    osm_id: feature.properties.osm_id,
    name: feature.properties.name,
    reason: targetReason(feature),
    osm_address: address,
    coordinates: { lat, lon },
    rd,
    current_bag_addressable_object_id: feature.properties.bag_addressable_object_id ?? null,
    current_bag_display_name: feature.properties.bag_display_name ?? null,
    candidates: nearbyCandidates(bag, schema, rd, radius, limit, address)
  });
  if ((i + 1) % 25 === 0 || i + 1 === targets.length) {
    console.log(`Collected ${i + 1}/${targets.length}`);
  }
}

await writeJson(out, {
  metadata: {
    input,
    bag,
    generatedAt: new Date().toISOString(),
    radius,
    limit,
    targetCount: targets.length,
    note: "Candidates are nearby BAG verblijfsobject addresses for manual or fuzzy review; they are not accepted automatically."
  },
  reviews
});

console.log(`Wrote ${reviews.length} review targets to ${out}`);
