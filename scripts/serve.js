import { createReadStream, existsSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

const root = join(process.cwd(), "public");
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "127.0.0.1";
const types = {
  ".css": "text/css; charset=utf-8",
  ".geojson": "application/geo+json; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const safePath = normalize(url.pathname).replace(/^(\.\.[/\\])+/, "");
  let filePath = join(root, safePath);
  if (url.pathname === "/" || !extname(filePath)) filePath = join(filePath, "index.html");
  if (!filePath.startsWith(root) || !existsSync(filePath)) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }
  res.writeHead(200, {
    "cache-control": "no-store",
    "content-type": types[extname(filePath)] || "application/octet-stream"
  });
  createReadStream(filePath).pipe(res);
}).listen(port, host, () => {
  console.log(`Serving public/ at http://${host}:${port}`);
});
