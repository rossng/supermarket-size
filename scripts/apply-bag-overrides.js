import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { parseArgs, readJson, writeJson } from "./lib.js";

// Manual overrides encode human knowledge the automatic pipeline cannot recover:
// stores whose OSM address is wrong (the real shop is at a different house number
// on the same street), or stores BAG models in a way no address/area rule can
// match. Each row pins, or vetoes, the BAG object for one OSM feature. See
// docs/fuzzy-matching.md.

// Minimal CSV parser: supports double-quoted fields (for notes with commas) and
// doubled "" escapes. Good enough for a small, hand-edited override table.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

function loadOverrides(rows) {
  if (!rows.length) return new Map();
  const header = rows[0].map((cell) => cell.trim().toLowerCase());
  const idx = (name) => header.indexOf(name);
  const cols = {
    osmType: idx("osm_type"),
    osmId: idx("osm_id"),
    bagId: idx("bag_addressable_object_id"),
    decision: idx("decision"),
    notes: idx("notes")
  };
  if (cols.osmType < 0 || cols.osmId < 0 || cols.decision < 0) {
    throw new Error("Override CSV must have osm_type, osm_id, and decision columns");
  }
  const map = new Map();
  for (const row of rows.slice(1)) {
    const osmType = (row[cols.osmType] ?? "").trim();
    const osmId = (row[cols.osmId] ?? "").trim();
    if (!osmType || !osmId) continue;
    map.set(`${osmType}/${osmId}`, {
      bagId: (row[cols.bagId] ?? "").trim(),
      decision: (row[cols.decision] ?? "").trim().toLowerCase(),
      notes: cols.notes >= 0 ? (row[cols.notes] ?? "").trim() : ""
    });
  }
  return map;
}

const args = parseArgs(process.argv.slice(2));
const input = args.input || "data/processed/albert-heijn-bag-ids.geojson";
const overridesPath = args.overrides || "data/manual/bag-overrides.csv";
const out = args.out || input;

const collection = await readJson(input);

if (!existsSync(overridesPath)) {
  console.log(`No override file at ${overridesPath}; writing ${input} through unchanged.`);
  await writeJson(out, collection);
  process.exit(0);
}

const overrides = loadOverrides(parseCsv(await readFile(overridesPath, "utf8")));
let accepted = 0;
let rejected = 0;
const unseen = new Set(overrides.keys());

const features = collection.features.map((feature) => {
  const props = feature.properties ?? {};
  const key = `${props.osm_type}/${props.osm_id}`;
  const override = overrides.get(key);
  if (!override) return feature;
  unseen.delete(key);

  if (override.decision === "accept") {
    if (!override.bagId) {
      throw new Error(`Override for ${key} is accept but has no bag_addressable_object_id`);
    }
    accepted += 1;
    return {
      ...feature,
      properties: {
        ...props,
        bag_addressable_object_id: override.bagId,
        bag_match_status: "manual",
        bag_manual_override: true,
        manual_match_notes: override.notes || null
      }
    };
  }

  if (override.decision === "reject") {
    rejected += 1;
    return {
      ...feature,
      properties: {
        ...props,
        bag_match_status: "manual_reject",
        bag_manual_override: true,
        manual_match_notes: override.notes || null
      }
    };
  }

  throw new Error(`Override for ${key} has unknown decision "${override.decision}" (expected accept or reject)`);
});

await writeJson(out, {
  ...collection,
  metadata: {
    ...(collection.metadata ?? {}),
    overridesApplied: { source: overridesPath, accepted, rejected, appliedAt: new Date().toISOString() }
  },
  features
});

for (const key of unseen) {
  console.warn(`Override for ${key} did not match any feature in ${input}`);
}
console.log(`Applied ${accepted} accept and ${rejected} reject overrides to ${out}`);
