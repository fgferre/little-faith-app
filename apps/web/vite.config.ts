import { defineConfig } from "vite";
import type { ResolvedConfig } from "vite";
import react from "@vitejs/plugin-react";
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

function offlineShell() {
  let dist = fileURLToPath(new URL("./dist/", import.meta.url));
  return {
    name: "little-faith-offline-shell",
    configResolved(config: ResolvedConfig) {
      dist = `${resolve(config.root, config.build.outDir)}/`;
    },
    async closeBundle() {
      const assets = await readdir(`${dist}assets`);
      const paths = [
        "index.html",
        "laco.svg",
        "manifest.webmanifest",
        ...assets.map((file) => `assets/${file}`),
      ];
      const contents = await Promise.all(
        paths.map((path) => readFile(`${dist}${path}`)),
      );
      const version = createHash("sha256").update(Buffer.concat(contents))
        .digest("hex").slice(0, 16);
      // Precache only this build's public shell. Auth/API responses and private data are never cached.
      await writeFile(
        `${dist}sw.js`,
        `
const VERSION = ${JSON.stringify(version)};
const SCOPE = new URL(self.registration.scope);
const PREFIX = 'little-faith-shell:' + encodeURIComponent(SCOPE.pathname) + ':';
const CACHE = PREFIX + VERSION;
const URLS = ${JSON.stringify(paths)}.map(path => new URL(path, SCOPE).href);
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(URLS))));
self.addEventListener('activate', event => event.waitUntil((async () => {
  const names = await caches.keys();
  await Promise.all(names.filter(name => name.startsWith(PREFIX) && name !== CACHE).map(name => caches.delete(name)));
  await self.clients.claim();
})()));
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== SCOPE.origin || !url.pathname.startsWith(SCOPE.pathname)) return;
  if (request.mode === 'navigate') {
    // Keep HTML and hashed assets on the active build while an update waits.
    // Newer HTML could upgrade IndexedDB and leave an incompatible old shell offline.
    event.respondWith(caches.open(CACHE).then(cache => cache.match(new URL('index.html', SCOPE).href, { ignoreVary: true })).then(cached => cached || fetch(request)));
  } else if (URLS.includes(url.href)) {
    // Public hashed assets are identical for every visitor, regardless of a server's Vary: Origin header.
    event.respondWith(caches.open(CACHE).then(cache => cache.match(url.href, { ignoreVary: true })).then(cached => cached || fetch(request)));
  }
});
`,
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), offlineShell()],
  base: "./",
  build: {
    target: "es2022",
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("/node_modules/")) return;
          if (id.includes("/@supabase/")) return "supabase";
          if (id.includes("/motion") || id.includes("/framer-motion/")) {
            return "motion";
          }
          if (
            id.includes("/react/") || id.includes("/react-dom/") ||
            id.includes("/scheduler/")
          ) return "react";
        },
      },
    },
  },
  envDir: "../..",
});
