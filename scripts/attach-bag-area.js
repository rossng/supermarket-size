import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { parseArgs, readJson, writeJson } from "./lib.js";

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

function quoteValue(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function tableColumns(dbPath, tableName) {
  return sqliteJson(dbPath, `PRAGMA table_info(${quoteIdent(tableName)});`);
}

function chooseSchema(dbPath) {
  const tables = sqliteJson(
    dbPath,
    "SELECT table_name FROM gpkg_contents UNION SELECT name AS table_name FROM sqlite_master WHERE type='table';"
  ).map((row) => row.table_name);
  const vboTable =
    tables.find((name) => name.toLowerCase() === "verblijfsobject") ??
    tables.find((name) => name.toLowerCase().includes("verblijfsobject"));
  if (!vboTable) {
    throw new Error(`Could not find verblijfsobject table. Tables: ${tables.join(", ")}`);
  }

  const columns = tableColumns(dbPath, vboTable).map((row) => row.name);
  const idColumn =
    columns.find((name) => name.toLowerCase() === "identificatie") ??
    columns.find((name) => name.toLowerCase().includes("identificatie"));
  const areaColumn =
    columns.find((name) => name.toLowerCase() === "oppervlakte") ??
    columns.find((name) => name.toLowerCase().includes("oppervlakte"));
  const statusColumn = columns.find((name) => name.toLowerCase().includes("status"));
  const usageColumn = columns.find((name) => name.toLowerCase() === "gebruiksdoel");

  if (!idColumn || !areaColumn) {
    throw new Error(`Could not detect ID/area columns in ${vboTable}. Columns: ${columns.join(", ")}`);
  }

  return { vboTable, idColumn, areaColumn, statusColumn, usageColumn };
}

function evaluateArea(hit, filters) {
  if (!hit) return { area: null, status: "area_missing" };
  if (!filters.allowedStatuses.includes(hit.status)) {
    return { area: null, status: "area_rejected_status" };
  }
  if (!Number.isFinite(hit.area)) {
    return { area: null, status: "area_missing" };
  }
  if (hit.area < filters.minArea) {
    return { area: null, status: "area_rejected_too_small" };
  }
  if (hit.area > filters.maxArea) {
    return { area: null, status: "area_rejected_too_large" };
  }
  return { area: hit.area, status: "area_attached" };
}

// Candidates that share an address (a shop plus the flats above it, or an
// in-use object plus its not-yet-in-use replacement) tie on the address-only
// resolver score, so the right BAG object is often demoted to `ambiguous` or
// the literal best is a tiny back-office unit. Re-rank the address-matching
// candidates with the BAG signals the resolver never saw: a supermarket unit
// is winkelfunctie, in an active status, and in the plausible area range.
function candidateIds(feature) {
  const candidates = feature.properties?.bag_candidates ?? [];
  return candidates
    .filter((candidate) => candidate.address_matches && candidate.bag_addressable_object_id)
    .map((candidate) => String(candidate.bag_addressable_object_id));
}

function pickShopCandidate(feature, areaById, filters) {
  const seen = new Set();
  const qualified = [];
  for (const id of candidateIds(feature)) {
    if (seen.has(id)) continue;
    seen.add(id);
    const hit = areaById.get(id);
    if (!hit) continue;
    if (!filters.allowedStatuses.includes(hit.status)) continue;
    if (!Number.isFinite(hit.area) || hit.area < filters.minArea || hit.area > filters.maxArea) continue;
    if (!String(hit.usage ?? "").includes("winkel")) continue;
    qualified.push({ id, hit });
  }
  // Prefer the largest qualifying unit: the supermarket, not a small adjacent shop.
  qualified.sort((a, b) => b.hit.area - a.hit.area);
  return qualified[0] ?? null;
}

const args = parseArgs(process.argv.slice(2));
const input = args.input || "data/processed/supermarkets-bag-ids.geojson";
const bag = args.bag || "data/raw/bag-light.gpkg";
const out = args.out || "public/data/supermarkets.geojson";
const areaFilters = {
  minArea: Number(args["min-area"] || 100),
  maxArea: Number(args["max-area"] || 10000),
  allowedStatuses: String(
    args["allowed-statuses"] || "Verblijfsobject in gebruik,Verblijfsobject in gebruik (niet ingemeten)"
  )
    .split(",")
    .map((status) => status.trim())
    .filter(Boolean)
};

if (!existsSync(bag)) {
  throw new Error(`BAG GeoPackage not found at ${bag}. Run npm run download:bag first.`);
}

const collection = await readJson(input);
const schema = chooseSchema(bag);
// Load the resolver's chosen object plus every address-matching candidate for
// resolved/ambiguous features, so disambiguation can compare them by BAG usage.
const ids = [
  ...new Set(
    collection.features
      .filter((feature) => {
        const status = feature.properties?.bag_match_status;
        return status === "resolved" || status === "ambiguous" || status === "manual";
      })
      .flatMap((feature) => [feature.properties?.bag_addressable_object_id, ...candidateIds(feature)])
      .filter(Boolean)
      .map(String)
  )
];

const areaById = new Map();
for (let i = 0; i < ids.length; i += 900) {
  const chunk = ids.slice(i, i + 900);
  const statusExpr = schema.statusColumn ? `${quoteIdent(schema.statusColumn)} AS status` : "NULL AS status";
  const usageExpr = schema.usageColumn ? `${quoteIdent(schema.usageColumn)} AS usage` : "NULL AS usage";
  const rows = sqliteJson(
    bag,
    `
      SELECT
        ${quoteIdent(schema.idColumn)} AS id,
        ${quoteIdent(schema.areaColumn)} AS area,
        ${statusExpr},
        ${usageExpr}
      FROM ${quoteIdent(schema.vboTable)}
      WHERE ${quoteIdent(schema.idColumn)} IN (${chunk.map(quoteValue).join(",")});
    `
  );
  for (const row of rows) {
    areaById.set(String(row.id), { area: Number(row.area), status: row.status, usage: row.usage });
  }
}

const features = collection.features.map((feature) => {
  const status = feature.properties?.bag_match_status;
  const bestId = feature.properties?.bag_addressable_object_id;
  const bestHit = bestId ? areaById.get(String(bestId)) : null;
  const bestEvaluated = bestId ? evaluateArea(bestHit, areaFilters) : { area: null, status: "area_missing" };

  let id = bestId;
  let hit = bestHit;
  let evaluated = bestEvaluated;
  let disambiguated = false;
  const shop = () => pickShopCandidate(feature, areaById, areaFilters);

  if (status === "manual_reject") {
    // A reviewer vetoed this match: never attach an area for it.
    hit = null;
    evaluated = { area: null, status: "area_manual_reject" };
  } else if (status === "manual") {
    // A reviewer pinned this exact BAG object. Trust it: attach its area
    // regardless of the range/status filters that the automatic path applies.
    evaluated = Number.isFinite(bestHit?.area)
      ? { area: bestHit.area, status: "area_manual" }
      : { area: null, status: "area_missing" };
  } else if (status === "resolved") {
    // Trust the resolver's pick when it passes the BAG filters. If it fails
    // (e.g. resolves to a tiny back-office or not-yet-in-use object), try to
    // rescue it with a sibling winkelfunctie unit at the same address.
    if (evaluated.status !== "area_attached") {
      const pick = shop();
      if (pick) {
        id = pick.id;
        hit = pick.hit;
        evaluated = evaluateArea(pick.hit, areaFilters);
        disambiguated = true;
      }
    }
  } else if (status === "ambiguous") {
    // Never trust an ambiguous best blindly: a flat at the same number can pass
    // the area filter too. Only attach when a single in-use winkelfunctie unit
    // in range confirms which object is the store.
    const pick = shop();
    if (pick) {
      id = pick.id;
      hit = pick.hit;
      evaluated = evaluateArea(pick.hit, areaFilters);
      disambiguated = true;
    } else if (args["include-ambiguous"]) {
      evaluated = bestEvaluated;
    } else {
      hit = null;
      evaluated = { area: null, status: "area_skipped_unconfirmed_match" };
    }
  } else {
    hit = null;
    evaluated = { area: null, status: "area_skipped_unconfirmed_match" };
  }

  return {
    ...feature,
    properties: {
      ...feature.properties,
      bag_addressable_object_id: id ?? null,
      floor_area_m2: evaluated.area,
      bag_raw_area_m2: hit?.area ?? null,
      bag_object_status: hit?.status ?? null,
      bag_usage: hit?.usage ?? null,
      bag_disambiguated: disambiguated,
      area_status: evaluated.status
    }
  };
});

const counts = features.reduce((acc, feature) => {
  const status = feature.properties.area_status;
  acc[status] = (acc[status] ?? 0) + 1;
  return acc;
}, {});

await writeJson(out, {
  ...collection,
  metadata: {
    ...(collection.metadata ?? {}),
    areaAttachedAt: new Date().toISOString(),
    bagGeoPackage: bag,
    bagSchema: schema,
    areaFilters,
    areaCounts: counts
  },
  features
});

console.log(`Wrote ${features.length} features to ${out}`);
console.log(JSON.stringify(counts, null, 2));
