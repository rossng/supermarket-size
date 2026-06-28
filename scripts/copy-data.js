import { parseArgs, readJson, writeJson } from "./lib.js";

const args = parseArgs(process.argv.slice(2));
const input = args.input || "data/processed/supermarkets-bag-ids.geojson";
const out = args.out || "public/data/supermarkets.geojson";
const collection = await readJson(input);

await writeJson(out, {
  ...collection,
  metadata: {
    ...(collection.metadata ?? {}),
    publishedAt: new Date().toISOString(),
    note: "Published before BAG GeoPackage area join; floor_area_m2 may be null."
  }
});

console.log(`Copied ${collection.features.length} features to ${out}`);
