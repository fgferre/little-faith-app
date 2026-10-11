import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

// Run the actual pure validators/parser in the Node fixture, without a second implementation.
export async function loadCore() {
  const directory = await mkdtemp(
    resolve(tmpdir(), "little-faith-browser-core-"),
  );
  process.once(
    "exit",
    () => rmSync(directory, { recursive: true, force: true }),
  );
  await writeFile(resolve(directory, "package.json"), '{"type":"module"}');
  const sourceDirectory = new URL("../../packages/core/src/", import.meta.url);
  for (
    const name of (await readdir(sourceDirectory)).filter((name) =>
      name.endsWith(".ts") && !name.endsWith(".test.ts")
    )
  ) {
    const source = await readFile(new URL(name, sourceDirectory), "utf8");
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
      fileName: name,
    });
    const output = outputText.replace(
      /(from\s+['"])(\.\.?\/[^'"]+)(['"])/g,
      (_, prefix, specifier, suffix) =>
        `${prefix}${
          specifier.endsWith(".js") ? specifier : `${specifier}.js`
        }${suffix}`,
    );
    await writeFile(resolve(directory, name.replace(/\.ts$/, ".js")), output);
  }
  const modules = await Promise.all(["evidence", "caixa-results", "results", "registration"].map(name => import(pathToFileURL(resolve(directory, `${name}.js`)).href)));
  return Object.assign({}, ...modules);
}
