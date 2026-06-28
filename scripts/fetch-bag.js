import { createWriteStream } from "node:fs";
import { rename } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { basename, join } from "node:path";
import { ensureParent, fetchText, parseArgs, writeJson } from "./lib.js";

const FEED_URL = "https://service.pdok.nl/kadaster/bag/atom/bag.xml";
const DEFAULT_DIR = "data/raw";

function attr(text, name) {
  const match = text.match(new RegExp(`${name}="([^"]*)"`, "i"));
  return match ? match[1] : "";
}

function firstTag(text, tag) {
  const match = text.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return match ? match[1].trim() : "";
}

function parseFeed(xml) {
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((match) => {
    const entry = match[1];
    const link = entry.match(/<link[^>]+application\/geopackage\+sqlite3[^>]+>/i)?.[0] ?? "";
    return {
      id: firstTag(entry, "id"),
      title: firstTag(entry, "title"),
      content: firstTag(entry, "content").replace(/\s+/g, " "),
      href: attr(link, "href"),
      length: Number(attr(link, "length")) || null,
      linkTitle: attr(link, "title"),
      rights: firstTag(entry, "rights"),
      updated: firstTag(entry, "updated")
    };
  });
  return entries.find((entry) => entry.href && /geopackage/i.test(entry.title));
}

async function download(url, outPath) {
  await ensureParent(outPath);
  const partPath = `${outPath}.part`;
  await new Promise((resolve, reject) => {
    const req = httpsRequest(url, { headers: { "user-agent": "supermarket-size/0.1" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        download(new URL(res.headers.location, url).toString(), outPath).then(resolve, reject);
        return;
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        reject(new Error(`Download failed with HTTP ${res.statusCode}`));
        res.resume();
        return;
      }
      const total = Number(res.headers["content-length"]) || 0;
      let done = 0;
      const file = createWriteStream(partPath);
      res.on("data", (chunk) => {
        done += chunk.length;
        if (total) {
          const pct = ((done / total) * 100).toFixed(1);
          process.stderr.write(`\rDownloading ${pct}%`);
        }
      });
      res.pipe(file);
      file.on("finish", () => {
        process.stderr.write("\n");
        file.close(resolve);
      });
      file.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
  await rename(partPath, outPath);
}

const args = parseArgs(process.argv.slice(2));
const outDir = args.dir || DEFAULT_DIR;
const xml = await fetchText(FEED_URL);
const entry = parseFeed(xml);

if (!entry) {
  throw new Error("Could not find BAG GeoPackage entry in Atom feed");
}

const manifest = {
  source: FEED_URL,
  fetchedAt: new Date().toISOString(),
  ...entry
};

await writeJson(join(outDir, "bag-manifest.json"), manifest);
console.log(`BAG GeoPackage: ${entry.href}`);
console.log(`Updated: ${entry.updated}`);
console.log(`Size: ${entry.length ? `${(entry.length / 1_000_000_000).toFixed(2)} GB` : "unknown"}`);

if (args.download) {
  const outPath = join(outDir, basename(new URL(entry.href).pathname));
  await download(entry.href, outPath);
  console.log(`Saved ${outPath}`);
}
