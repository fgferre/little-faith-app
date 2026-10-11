import { build, preview } from "vite";

// Freeze the authenticated fixture's production shell so parallel source edits
// cannot hot-reload a page while it is reviewing a persisted human decision.
const options = {
  root: "apps/web",
  configFile: "apps/web/vite.config.ts",
  build: { outDir: "../../.tmp/e2e-configured-build", emptyOutDir: true },
};
await build(options);
await preview({
  ...options,
  preview: { host: "127.0.0.1", port: 4182, strictPort: true },
});
