// Static server for the two demo deliverables (local dev). In production host them on https.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.DEMO_SITES_PORT ?? 5174);
http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const m = /^\/(broken|fixed)\/?(index\.html)?$/.exec(p);
  if (!m) { res.writeHead(404).end("not found"); return; }
  if (!p.endsWith("/") && !p.endsWith(".html")) { res.writeHead(301, { location: p + "/" }).end(); return; }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  fs.createReadStream(path.join(root, m[1], "index.html")).pipe(res);
}).listen(port, () => console.log(`demo sites on http://localhost:${port}/broken/ and /fixed/`));
