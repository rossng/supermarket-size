import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs, readJson, writeJson } from "./lib.js";

const args = parseArgs(process.argv.slice(2));
const input = args.input || "public/data/supermarket-buildings.geojson";
const outDir = args.out || "public/data/building-chunks";
const zoom = Number(args.zoom || 10);

function lonToTileX(lon, z) {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}

function latToTileY(lat, z) {
  const latRad = (lat * Math.PI) / 180;
  return Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) *
      2 ** z
  );
}

function clampTile(value, z) {
  return Math.max(0, Math.min(2 ** z - 1, value));
}

function geometryBbox(geometry) {
  const bbox = [Infinity, Infinity, -Infinity, -Infinity];
  const visit = (coordinates) => {
    if (typeof coordinates?.[0] === "number") {
      const [lon, lat] = coordinates;
      bbox[0] = Math.min(bbox[0], lon);
      bbox[1] = Math.min(bbox[1], lat);
      bbox[2] = Math.max(bbox[2], lon);
      bbox[3] = Math.max(bbox[3], lat);
      return;
    }
    for (const coordinate of coordinates ?? []) visit(coordinate);
  };
  visit(geometry?.coordinates);
  return bbox;
}

function mergeBbox(a, b) {
  if (!a) return [...b];
  a[0] = Math.min(a[0], b[0]);
  a[1] = Math.min(a[1], b[1]);
  a[2] = Math.max(a[2], b[2]);
  a[3] = Math.max(a[3], b[3]);
  return a;
}

function featureTileKey(feature) {
  const bbox = geometryBbox(feature.geometry);
  const lon = (bbox[0] + bbox[2]) / 2;
  const lat = (bbox[1] + bbox[3]) / 2;
  const x = clampTile(lonToTileX(lon, zoom), zoom);
  const y = clampTile(latToTileY(lat, zoom), zoom);
  return { key: `${zoom}-${x}-${y}`, x, y, bbox };
}

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const source = await readJson(input);
const chunks = new Map();

for (const feature of source.features ?? []) {
  const tile = featureTileKey(feature);
  const chunk = chunks.get(tile.key) ?? {
    key: tile.key,
    x: tile.x,
    y: tile.y,
    bbox: null,
    features: []
  };
  chunk.bbox = mergeBbox(chunk.bbox, tile.bbox);
  chunk.features.push(feature);
  chunks.set(tile.key, chunk);
}

const manifestChunks = [];
for (const chunk of [...chunks.values()].sort((a, b) => a.key.localeCompare(b.key))) {
  const href = `./${chunk.key}.geojson`;
  await writeJson(join(outDir, `${chunk.key}.geojson`), {
    type: "FeatureCollection",
    metadata: {
      source: input,
      tile: { z: zoom, x: chunk.x, y: chunk.y },
      featureCount: chunk.features.length
    },
    features: chunk.features
  });
  manifestChunks.push({
    key: chunk.key,
    href,
    bbox: chunk.bbox,
    featureCount: chunk.features.length
  });
}

await writeJson(join(outDir, "manifest.json"), {
  type: "building-chunk-manifest",
  source: input,
  generatedAt: new Date().toISOString(),
  zoom,
  featureCount: source.features?.length ?? 0,
  chunkCount: manifestChunks.length,
  chunks: manifestChunks
});

console.log(`Wrote ${manifestChunks.length} building chunks to ${outDir}`);
