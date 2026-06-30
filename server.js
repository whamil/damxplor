import { createReadStream, promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { handleNasApi } from "./server/nas.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, "dist");
const port = Number(process.env.PORT) || 4173;
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

const server = http.createServer(async (request, response) => {
  if (
    request.url?.startsWith("/api/nas")
    || request.url?.startsWith("/api/mux")
    || request.url?.startsWith("/api/google-drive")
  ) return handleNasApi(request, response);

  try {
    const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    const requested = path.resolve(dist, `.${pathname}`);
    const safePath = requested === dist || requested.startsWith(`${dist}${path.sep}`)
      ? requested
      : path.join(dist, "index.html");
    const stats = await fs.stat(safePath).catch(() => null);
    const file = stats?.isFile() ? safePath : path.join(dist, "index.html");
    response.writeHead(200, { "Content-Type": contentTypes[path.extname(file)] || "application/octet-stream" });
    if (request.method === "HEAD") return response.end();
    createReadStream(file).pipe(response);
  } catch {
    response.writeHead(500);
    response.end("Application is not built. Run npm run build first.");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`DAMXPLOR running at http://127.0.0.1:${port}`);
});
