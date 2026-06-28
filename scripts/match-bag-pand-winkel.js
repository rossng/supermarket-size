import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { parseArgs, readJson, writeJson } from "./lib.js";

// Spatial rescue pass. Some stores never resolve by address: the OSM address is
// wrong/imprecise, but the shop is registered at a neighbouring house number in
// the SAME building (e.g. Dirk "Tweede Hugo de Grootstraat 45", whose shop is
// the 1315 m2 winkel at #43 in the same pand). For each store still without a
// floor area, we find the BAG pand polygon that contains the OSM point and look
// at its in-use winkelfunctie units. We only accept a match when the building is
// unambiguous: exactly one shop unit, OR one shop clearly dominant in size (the
// largest is >= `dominance` x the next). Buildings with several comparable shops
// (malls, shopping streets, e.g. Stadhouderskade) are left alone.

function sqliteJson(dbPath, sql) {
  const result = spawnSync("sqlite3", ["-readonly", "-json", dbPath, sql], { encoding: "utf8", maxBuffer: 1 << 28 });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `sqlite3 exited ${result.status}`);
  }
  return result.stdout.trim() ? JSON.parse(result.stdout) : [];
}

function quoteValue(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function wgs84ToRd(lat, lon) {
  const dLat = 0.36 * (lat - 52.1551744);
  const dLon = 0.36 * (lon - 5.38720621);
  const x =
    155000 + 190094.945 * dLon - 11832.228 * dLat * dLon - 114.221 * dLat ** 2 * dLon - 32.391 * dLon ** 3 -
    0.705 * dLat - 2.34 * dLat ** 3 * dLon - 0.608 * dLat * dLon ** 3 - 0.008 * dLon ** 2 + 0.148 * dLat ** 2 * dLon ** 3;
  const y =
    463000 + 309056.544 * dLat + 3638.893 * dLon ** 2 + 73.077 * dLat ** 2 - 157.984 * dLat * dLon ** 2 +
    59.788 * dLat ** 3 + 0.433 * dLon - 6.439 * dLat ** 2 * dLon ** 2 - 0.032 * dLat * dLon + 0.092 * dLon ** 4 - 0.054 * dLat * dLon ** 4;
  return { x, y };
}

// Parse a GeoPackage geometry blob into outer rings in RD coordinates.
function parseOuterRings(hex) {
  const buf = Buffer.from(hex, "hex");
  const flags = buf.readUInt8(3);
  const envelopeType = (flags >> 1) & 7;
  let offset = 8 + ([0, 32, 48, 48, 64, 64, 80, 80][envelopeType] ?? 0);
  const le = buf.readUInt8(offset) === 1;
  const readU32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const readF64 = (o) => (le ? buf.readDoubleLE(o) : buf.readDoubleBE(o));
  const type = readU32(offset + 1);
  let cursor = offset + 5;
  const rings = [];
  const readPolygon = () => {
    const ringCount = readU32(cursor);
    cursor += 4;
    for (let r = 0; r < ringCount; r += 1) {
      const pointCount = readU32(cursor);
      cursor += 4;
      const ring = [];
      for (let p = 0; p < pointCount; p += 1) {
        ring.push([readF64(cursor), readF64(cursor + 8)]);
        cursor += 16;
      }
      if (r === 0) rings.push(ring); // outer ring only; holes are negligible for panden
    }
  };
  if (type === 3) {
    readPolygon();
  } else if (type === 6) {
    const polygonCount = readU32(cursor);
    cursor += 4;
    for (let i = 0; i < polygonCount; i += 1) {
      cursor += 5; // each sub-polygon has its own byte-order + type header
      readPolygon();
    }
  }
  return rings;
}

function pointInRings(px, py, rings) {
  for (const ring of rings) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
    }
    if (inside) return true;
  }
  return false;
}

function containingPand(bag, rd) {
  const candidates = sqliteJson(
    bag,
    `SELECT p.identificatie AS id, hex(p.geom) AS geom
     FROM pand p JOIN rtree_pand_geom r ON r.id = p.feature_id
     WHERE r.minx <= ${rd.x} AND r.maxx >= ${rd.x} AND r.miny <= ${rd.y} AND r.maxy >= ${rd.y};`
  );
  for (const candidate of candidates) {
    try {
      if (pointInRings(rd.x, rd.y, parseOuterRings(candidate.geom))) return candidate.id;
    } catch {
      // skip unparseable geometry
    }
  }
  return null;
}

function shopUnits(bag, pandId, filters) {
  return sqliteJson(
    bag,
    `SELECT identificatie AS id, oppervlakte AS area, status, gebruiksdoel AS usage
     FROM verblijfsobject
     WHERE pand_identificatie = ${quoteValue(pandId)}
       AND gebruiksdoel LIKE '%winkel%'
       AND status LIKE '%in gebruik%'
       AND oppervlakte >= ${filters.minArea} AND oppervlakte <= ${filters.maxArea}
     ORDER BY oppervlakte DESC;`
  );
}

// Pick the store unit only when the building is unambiguous.
function pickPandShop(bag, rd, filters) {
  const pandId = containingPand(bag, rd);
  if (!pandId) return { reason: "no_pand" };
  const units = shopUnits(bag, pandId, filters);
  if (units.length === 0) return { reason: "no_winkel", pandId };
  if (units.length === 1) return { reason: "unique", pandId, unit: units[0] };
  if (units[0].area >= filters.dominance * units[1].area) {
    return { reason: "dominant", pandId, unit: units[0], runnerUp: units[1].area };
  }
  return { reason: "ambiguous_multi", pandId, units: units.map((u) => u.area) };
}

const args = parseArgs(process.argv.slice(2));
const input = args.input || "public/data/supermarkets.geojson";
const bag = args.bag || "data/raw/bag-light.gpkg";
const out = args.out || input;
const filters = {
  minArea: Number(args["min-area"] || 100),
  maxArea: Number(args["max-area"] || 10000),
  dominance: Number(args.dominance || 2)
};

if (!existsSync(bag)) {
  throw new Error(`BAG GeoPackage not found at ${bag}`);
}

const collection = await readJson(input);
const counts = {};
let rescued = 0;

const features = collection.features.map((feature) => {
  const props = feature.properties ?? {};
  const hasArea = Number.isFinite(props.floor_area_m2) && props.floor_area_m2 > 0;
  const point = feature.geometry?.coordinates;
  // Only rescue stores with no area yet; never override a vetoed match or a real one.
  if (hasArea || props.bag_match_status === "manual_reject" || !Array.isArray(point)) {
    return feature;
  }
  const [lon, lat] = point;
  const pick = pickPandShop(bag, wgs84ToRd(lat, lon), filters);
  counts[pick.reason] = (counts[pick.reason] || 0) + 1;
  if (pick.reason !== "unique" && pick.reason !== "dominant") return feature;

  rescued += 1;
  return {
    ...feature,
    properties: {
      ...props,
      bag_addressable_object_id: pick.unit.id,
      floor_area_m2: pick.unit.area,
      bag_raw_area_m2: pick.unit.area,
      bag_object_status: pick.unit.status,
      bag_usage: pick.unit.usage,
      bag_pand_id: pick.pandId,
      bag_pand_match: pick.reason, // "unique" | "dominant"
      area_status: "area_pand_match"
    }
  };
});

await writeJson(out, {
  ...collection,
  metadata: {
    ...(collection.metadata ?? {}),
    pandWinkelMatch: { matchedAt: new Date().toISOString(), filters, rescued, verdicts: counts }
  },
  features
});

console.log(`Pand-winkel rescue: matched ${rescued} previously size-unknown stores.`);
console.log(JSON.stringify(counts, null, 2));
