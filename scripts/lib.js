import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";

export async function ensureParent(filePath) {
  await mkdir(dirname(filePath), { recursive: true });
}

export async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

export async function writeJson(filePath, data) {
  await ensureParent(filePath);
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

export function fetchText(url, { method = "GET", body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === "http:" ? httpRequest : httpsRequest;
    const req = transport(
      parsed,
      {
        method,
        headers: {
          "user-agent": "supermarket-size/0.1 (+https://github.com/)",
          ...headers
        }
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const redirect = new URL(res.headers.location, parsed).toString();
          resolve(fetchText(redirect, { method, body, headers }));
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`${method} ${url} failed with HTTP ${res.statusCode}`));
          res.resume();
          return;
        }
        res.setEncoding("utf8");
        let text = "";
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () => resolve(text));
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

export function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function normalizePostcode(value) {
  return String(value ?? "").toUpperCase().replace(/\s+/g, "");
}

export function parseHouseNumber(value) {
  const match = String(value ?? "").match(/^(\d+)\s*([A-Za-z])?\s*[-/]?\s*(.*)?$/);
  if (!match) return {};
  return {
    houseNumber: Number(match[1]),
    houseLetter: match[2] ? match[2].toUpperCase() : "",
    houseAddition: match[3] ? match[3].trim().toUpperCase() : ""
  };
}

export function featureAddress(feature) {
  const props = feature.properties ?? {};
  const tags = props.osm_tags ?? {};
  const street = props.street ?? tags["addr:street"] ?? "";
  const housenumber = props.housenumber ?? tags["addr:housenumber"] ?? "";
  const postcode = props.postcode ?? tags["addr:postcode"] ?? "";
  const city = props.city ?? tags["addr:city"] ?? tags["addr:place"] ?? "";
  return {
    street: String(street).trim(),
    housenumber: String(housenumber).trim(),
    postcode: normalizePostcode(postcode),
    city: String(city).trim()
  };
}
