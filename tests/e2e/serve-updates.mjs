import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

// Dedicated static fixture: distinguishable shells using the generated worker
// and real public assets. It does not simulate account or application data.
const dist = resolve("apps/web/dist");
let version = "a";
const mime = {
  ".js": "text/javascript",
  ".html": "text/html",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
};
createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1:4191");
  if (url.pathname === "/__test/next-build") {
    version = "b";
    response.end("updated");
    return;
  }
  if (url.pathname === "/__test/reset") {
    version = "a";
    response.end("reset");
    return;
  }
  const path = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const file = resolve(dist, path);
  if (!file.startsWith(`${dist}/`)) {
    response.writeHead(404).end();
    return;
  }
  try {
    let body = await readFile(file);
    if (path === "index.html") {
      body = Buffer.from(
        body.toString().replace(
          "</head>",
          `<meta name="shell-fixture-build" content="${version}"></head>`,
        ),
      );
    }
    if (path === "sw.js") {
      body = Buffer.from(
        body.toString().replace(
          /const VERSION = "[a-f0-9]+";/,
          `const VERSION = "fixture-${version}";`,
        ),
      );
    }
    response.setHeader(
      "Content-Type",
      mime[file.slice(file.lastIndexOf("."))] ?? "application/octet-stream",
    );
    response.setHeader("Cache-Control", "no-store");
    response.end(body);
  } catch {
    response.writeHead(404).end();
  }
}).listen(
  4191,
  "127.0.0.1",
  () => console.log("Static shell-update fixture ready on localhost:4191."),
);
