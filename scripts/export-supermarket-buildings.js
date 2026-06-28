import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { parseArgs, readJson, writeJson } from "./lib.js";

function sqliteJson(dbPath, sql) {
  const result = spawnSync("sqlite3", ["-readonly", "-json", dbPath, sql], { encoding: "utf8", maxBuffer: 1024 * 1024 * 256 });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `sqlite3 exited ${result.status}`);
  }
  return result.stdout.trim() ? JSON.parse(result.stdout) : [];
}

function quoteValue(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function rdToWgs84(x, y) {
  const dx = (x - 155000) * 1e-5;
  const dy = (y - 463000) * 1e-5;
  const latSeconds =
    3235.65389 * dy -
    32.58297 * dx ** 2 -
    0.2475 * dy ** 2 -
    0.84978 * dx ** 2 * dy -
    0.0655 * dy ** 3 -
    0.01709 * dx ** 2 * dy ** 2 -
    0.00738 * dx +
    0.0053 * dx ** 4 -
    0.00039 * dx ** 2 * dy ** 3 +
    0.00033 * dx ** 4 * dy -
    0.00012 * dx * dy;
  const lonSeconds =
    5260.52916 * dx +
    105.94684 * dx * dy +
    2.45656 * dx * dy ** 2 -
    0.81885 * dx ** 3 +
    0.05594 * dx * dy ** 3 -
    0.05607 * dx ** 3 * dy +
    0.01199 * dy -
    0.00256 * dx ** 3 * dy ** 2 +
    0.00128 * dx * dy ** 4 +
    0.00022 * dy ** 2 -
    0.00022 * dx ** 2 -
    0.00026 * dx ** 5;
  return [5.38720621 + lonSeconds / 3600, 52.1551744 + latSeconds / 3600];
}

function parseGpkgGeometry(hex) {
  const buffer = Buffer.from(hex, "hex");
  if (buffer.toString("ascii", 0, 2) !== "GP") {
    throw new Error("Geometry is not a GeoPackage geometry blob");
  }
  const flags = buffer.readUInt8(3);
  const littleEndianHeader = Boolean(flags & 1);
  const envelopeType = (flags >> 1) & 7;
  let offset = 8;
  if (littleEndianHeader) {
    buffer.readInt32LE(4);
  } else {
    buffer.readInt32BE(4);
  }
  const envelopeBytes = [0, 32, 48, 48, 64, 64, 80, 80][envelopeType] ?? 0;
  offset += envelopeBytes;
  return parseWkb(buffer, offset);
}

function readUInt32(buffer, offset, littleEndian) {
  return littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
}

function readDouble(buffer, offset, littleEndian) {
  return littleEndian ? buffer.readDoubleLE(offset) : buffer.readDoubleBE(offset);
}

function parseWkb(buffer, offset) {
  const littleEndian = buffer.readUInt8(offset) === 1;
  const type = readUInt32(buffer, offset + 1, littleEndian);
  let cursor = offset + 5;

  if (type === 3) {
    const parsed = parsePolygon(buffer, cursor, littleEndian);
    return { type: "Polygon", coordinates: parsed.coordinates };
  }

  if (type === 6) {
    const polygonCount = readUInt32(buffer, cursor, littleEndian);
    cursor += 4;
    const polygons = [];
    for (let i = 0; i < polygonCount; i += 1) {
      const parsed = parseWkb(buffer, cursor);
      if (parsed.type !== "Polygon") throw new Error("Expected polygon inside multipolygon");
      polygons.push(parsed.coordinates);
      cursor = parsed.cursor;
    }
    return { type: "MultiPolygon", coordinates: polygons, cursor };
  }

  throw new Error(`Unsupported WKB geometry type ${type}`);
}

function parsePolygon(buffer, offset, littleEndian) {
  let cursor = offset;
  const ringCount = readUInt32(buffer, cursor, littleEndian);
  cursor += 4;
  const rings = [];
  for (let ringIndex = 0; ringIndex < ringCount; ringIndex += 1) {
    const pointCount = readUInt32(buffer, cursor, littleEndian);
    cursor += 4;
    const ring = [];
    for (let pointIndex = 0; pointIndex < pointCount; pointIndex += 1) {
      const x = readDouble(buffer, cursor, littleEndian);
      const y = readDouble(buffer, cursor + 8, littleEndian);
      cursor += 16;
      ring.push(rdToWgs84(x, y));
    }
    rings.push(ring);
  }
  return { coordinates: rings, cursor };
}

const args = parseArgs(process.argv.slice(2));
const input = args.input || "public/data/supermarkets.geojson";
const bag = args.bag || "data/raw/bag-light.gpkg";
const out = args.out || "public/data/supermarket-buildings.geojson";
const pointsOut = args["points-out"] || "public/data/supermarket-building-points.geojson";

if (!existsSync(bag)) {
  throw new Error(`BAG GeoPackage not found at ${bag}`);
}

// Export a polygon for every confidently-located store, even when no sensible
// floor area could be attached. Some stores resolve to a real BAG object/pand
// but the area is rejected (e.g. Overtoom 454-H, whose primary object is a
// small bijeenkomstfunctie unit) — we still want to draw the building outline,
// just without a size. Ambiguous/unmatched stores are excluded: we do not trust
// which building they belong to.
function hasTrustedBuilding(feature) {
  const props = feature.properties ?? {};
  if (!props.bag_addressable_object_id) return false;
  return (
    Boolean(props.floor_area_m2) ||
    props.bag_match_status === "resolved" ||
    props.bag_match_status === "manual" ||
    props.bag_disambiguated === true
  );
}

const collection = await readJson(input);
const supermarkets = collection.features.filter(hasTrustedBuilding);
const vboIds = supermarkets.map((feature) => feature.properties.bag_addressable_object_id).filter(Boolean);
const vboById = new Map();

for (let i = 0; i < vboIds.length; i += 900) {
  const ids = vboIds.slice(i, i + 900);
  const rows = sqliteJson(
    bag,
    `
      SELECT identificatie, pand_identificatie
      FROM verblijfsobject
      WHERE identificatie IN (${ids.map(quoteValue).join(",")});
    `
  );
  for (const row of rows) {
    vboById.set(String(row.identificatie), String(row.pand_identificatie));
  }
}

const pandIds = [...new Set([...vboById.values()].filter(Boolean))];
const pandById = new Map();

for (let i = 0; i < pandIds.length; i += 500) {
  const ids = pandIds.slice(i, i + 500);
  const rows = sqliteJson(
    bag,
    `
      SELECT identificatie, status, bouwjaar, hex(geom) AS geom
      FROM pand
      WHERE identificatie IN (${ids.map(quoteValue).join(",")});
    `
  );
  for (const row of rows) {
    pandById.set(String(row.identificatie), {
      status: row.status,
      bouwjaar: row.bouwjaar,
      geometry: parseGpkgGeometry(row.geom)
    });
  }
}

const features = [];
const pointFeatures = [];
const seen = new Set();
const exportItems = [];

function geometryCenter(geometry) {
  const points = [];
  const collect = (coords) => {
    if (Array.isArray(coords[0]) && typeof coords[0][0] === "number") {
      points.push(...coords);
      return;
    }
    coords.forEach(collect);
  };
  collect(geometry.coordinates);
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const [lon, lat] of points) {
    minLon = Math.min(minLon, lon);
    minLat = Math.min(minLat, lat);
    maxLon = Math.max(maxLon, lon);
    maxLat = Math.max(maxLat, lat);
  }
  return [(minLon + maxLon) / 2, (minLat + maxLat) / 2];
}

for (const supermarket of supermarkets) {
  const props = supermarket.properties;
  const pandId = vboById.get(String(props.bag_addressable_object_id));
  const pand = pandById.get(String(pandId));
  if (!pand) continue;
  const key = `${props.osm_type}-${props.osm_id}-${pandId}`;
  if (seen.has(key)) continue;
  seen.add(key);
  exportItems.push({ supermarket, props, pandId, pand });
}

const itemsByPandId = new Map();
for (const item of exportItems) {
  const items = itemsByPandId.get(item.pandId) ?? [];
  items.push(item);
  itemsByPandId.set(item.pandId, items);
}
const sharedPandIds = new Set(
  [...itemsByPandId.entries()]
    .filter(([, items]) => items.length > 1)
    .map(([pandId]) => pandId)
);

for (const { props, pandId, pand } of exportItems) {
  const properties = {
    osm_type: props.osm_type,
    osm_id: props.osm_id,
    name: props.name,
    brand: props.brand,
    bag_addressable_object_id: props.bag_addressable_object_id,
    bag_pand_id: pandId,
    bag_pand_status: pand.status,
    bag_pand_bouwjaar: pand.bouwjaar,
    floor_area_m2: props.floor_area_m2,
    bag_raw_area_m2: props.bag_raw_area_m2,
    bag_display_name: props.bag_display_name,
    bag_match_status: props.bag_match_status,
    area_status: props.area_status,
    has_area: Boolean(props.floor_area_m2),
    is_shared_pand: sharedPandIds.has(pandId)
  };
  features.push({
    type: "Feature",
    geometry: pand.geometry,
    properties
  });
  if (sharedPandIds.has(pandId)) continue;
  pointFeatures.push({
    type: "Feature",
    geometry: {
      type: "Point",
      coordinates: geometryCenter(pand.geometry)
    },
    properties
  });
}

await writeJson(out, {
  type: "FeatureCollection",
  metadata: {
    source: bag,
    generatedAt: new Date().toISOString(),
    input,
    featureCount: features.length,
    sharedPandCount: sharedPandIds.size,
    sharedPandStoreCount: exportItems.filter((item) => sharedPandIds.has(item.pandId)).length,
    note: "BAG pand polygons for confidently-located supermarkets. Panden with multiple supermarkets are still drawn as shared building geometry, but omitted from center points because BAG pand geometry cannot identify each store footprint. has_area=false means the building is drawn without a sensible floor area."
  },
  features
});

await writeJson(pointsOut, {
  type: "FeatureCollection",
  metadata: {
    source: out,
    generatedAt: new Date().toISOString(),
    input,
    featureCount: pointFeatures.length,
    skippedSharedPandCount: sharedPandIds.size,
    skippedSharedPandStoreCount: exportItems.filter((item) => sharedPandIds.has(item.pandId)).length,
    note: "Point features centered on exported BAG pand polygon bounds. Panden with multiple supermarkets are omitted so store circles fall back to the original store point."
  },
  features: pointFeatures
});

console.log(`Wrote ${features.length} BAG building polygons to ${out}`);
console.log(`Wrote ${pointFeatures.length} BAG building center points to ${pointsOut}`);
console.log(`Skipped ${sharedPandIds.size} shared BAG panden covering ${exportItems.filter((item) => sharedPandIds.has(item.pandId)).length} supermarkets`);
