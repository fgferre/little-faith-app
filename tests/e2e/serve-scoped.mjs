import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// A plain static subdirectory, like a Pages repository URL; no SPA fallback.
const root = fileURLToPath(new URL("../../apps/web/dist/", import.meta.url));
const prefix = "/little-faith-app/";
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
};
createServer(async (request, response) => {
  try {
    const path = decodeURIComponent(
      new URL(request.url, "http://127.0.0.1:4181").pathname,
    );
    if (path === "/") {
      response.end("Static subpath test server");
      return;
    }
    if (!path.startsWith(prefix)) {
      response.writeHead(404);
      response.end();
      return;
    }
    const file = resolve(root, path.slice(prefix.length) || "index.html");
    if (!file.startsWith(resolve(root) + sep)) {
      response.writeHead(404);
      response.end();
      return;
    }
    const body = await readFile(file);
    response.writeHead(200, {
      "Content-Type": types[extname(file)] ?? "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end();
  }
}).listen(4181, "127.0.0.1");
