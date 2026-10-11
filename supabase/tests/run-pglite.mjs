import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Supplemental SQL verification only: real Supabase Auth/Storage services are not emulated.
const requireFromTest = createRequire(resolve(process.env.BACKEND_TEST_MODULE_ROOT ?? process.cwd(), 'package.json'));
const { PGlite } = requireFromTest('@electric-sql/pglite');
const ts = requireFromTest('typescript');
const db = new PGlite();
const compiledCore = await mkdtemp(resolve(tmpdir(), 'little-faith-sql-core-'));
try {
  // Compile the actual pure core into temporary ESM files. No maintained validator copy.
  const coreUrl = new URL('../../packages/core/src/', import.meta.url);
  await writeFile(resolve(compiledCore, 'package.json'), '{"type":"module"}');
  for (const name of (await readdir(coreUrl)).filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts'))) {
    const source = await readFile(new URL(name, coreUrl), 'utf8');
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      fileName: name,
    });
    const esm = outputText.replace(/(from\s+['"])(\.\.?\/[^'"]+)(['"])/g,
      (_, prefix, specifier, suffix) => `${prefix}${specifier.endsWith('.js') ? specifier : `${specifier}.js`}${suffix}`);
    await writeFile(resolve(compiledCore, name.replace(/\.ts$/, '.js')), esm);
  }
  const { validateFinancialReceipt, validateFinancialSnapshot } = await import(pathToFileURL(resolve(compiledCore, 'financial.js')).href);
  const { validatePlanningReceipt, validatePlanningSnapshot } = await import(pathToFileURL(resolve(compiledCore, 'planning.js')).href);
  const { PLANNING_CATALOG } = await import(pathToFileURL(resolve(compiledCore, 'planning-catalog.js')).href);
  const { canonicalJSON } = await import(pathToFileURL(resolve(compiledCore, 'canonical.js')).href);
  const { validateRegistrationReceipt, validateRegistrationSnapshot } = await import(pathToFileURL(resolve(compiledCore, 'registration.js')).href);
  const { validateEvidenceMetadata } = await import(pathToFileURL(resolve(compiledCore, 'evidence.js')).href);
  const { validateResultReceipt, validateResultSnapshot } = await import(pathToFileURL(resolve(compiledCore, 'results.js')).href);
  const { parseCaixaResult } = await import(pathToFileURL(resolve(compiledCore, 'caixa-results.js')).href);
  await db.exec(`
    create role authenticated nologin;
    create role anon nologin;
    create role service_role nologin;
    create schema auth;
    create schema storage;
    create table auth.users(id uuid primary key, email text, raw_app_meta_data jsonb, raw_user_meta_data jsonb);
    create function auth.uid() returns uuid language sql stable as $$
      select (nullif(current_setting('request.jwt.claims',true),'')::jsonb ->> 'sub')::uuid;
    $$;
    create function auth.jwt() returns jsonb language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb, '{}'::jsonb);
    $$;
    create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text);
    alter table storage.objects enable row level security;
    grant usage on schema public,auth,storage to authenticated,anon;
    grant select,insert,update,delete on storage.objects to authenticated;
  `);
  const migrationsUrl = new URL('../migrations/', import.meta.url);
  const migrations = (await readdir(migrationsUrl)).filter(name => name.endsWith('.sql')).sort();
  for (const name of migrations) await db.exec(await readFile(new URL(name,migrationsUrl), 'utf8'));
  for (const [lottery, catalog] of Object.entries(PLANNING_CATALOG)) {
    const { rows } = await db.query('select private.planning_catalog_json($1) as catalog', [lottery]);
    if (canonicalJSON(rows[0].catalog) !== canonicalJSON(catalog)) throw new Error(`SQL/core catalog differs: ${lottery}`);
  }
  await db.exec(await readFile(new URL('./foundation.sql', import.meta.url), 'utf8'));
  const financialResults = await db.exec(await readFile(new URL('./financial.sql', import.meta.url), 'utf8'));
  const samples = financialResults.flatMap(result => result.rows).filter(row => typeof row.label === 'string' && row.data && row.kind);
  if (samples.length === 0) throw new Error('Financial SQL must return contract samples.');
  for (const { label, kind, data } of samples) {
    try {
      if (kind === 'receipt') validateFinancialReceipt(data);
      else if (kind === 'snapshot') validateFinancialSnapshot(data);
      else throw new Error(`Unknown contract sample kind: ${kind}`);
    } catch (error) { throw new Error(`SQL/core financial contract mismatch: ${label}`, { cause: error }); }
  }
  const planningResults = await db.exec(await readFile(new URL('./planning.sql', import.meta.url), 'utf8'));
  const planningSamples = planningResults.flatMap(result => result.rows).filter(row => typeof row.label === 'string' && row.data && row.kind);
  if (planningSamples.length === 0) throw new Error('Planning SQL must return contract samples.');
  for (const { label, kind, data } of planningSamples) {
    try {
      const snapshot = kind === 'receipt' ? validatePlanningReceipt(data).snapshot : validatePlanningSnapshot(data);
      for (const manifest of snapshot?.manifests ?? []) {
        if (createHash('sha256').update(manifest.canonical, 'utf8').digest('hex') !== manifest.sha256) throw new Error('Independent Node SHA-256 differs.');
      }
    } catch (error) { throw new Error(`SQL/core planning contract mismatch: ${label}`, { cause: error }); }
  }
  const sourceFixtures = [['mega-sena','megasena',3000],['lotofacil','lotofacil',3600],['quina','quina',7000]];
  await db.exec('create table public.sql_official_fixtures(lottery text, parsed jsonb); grant select on public.sql_official_fixtures to authenticated,service_role;');
  for (const [lotteryId,path,contestNumber] of sourceFixtures) {
    const rawText = await readFile(new URL(`./fixtures/caixa-${path}-${contestNumber}.json`, import.meta.url),'utf8');
    const parsed = parseCaixaResult({ lotteryId,contestNumber,rawText,sourceUrl:`https://servicebus2.caixa.gov.br/portaldeloterias/api/${path}/${contestNumber}`,collectedAt:'2026-10-08T18:15:02.000Z' });
    if (parsed.sha256 !== createHash('sha256').update(rawText,'utf8').digest('hex')) throw new Error('Official raw source hash differs.');
    await db.query('insert into public.sql_official_fixtures values($1,$2::jsonb)',[lotteryId,JSON.stringify(parsed)]);
  }
  const stage5Results = await db.exec(await readFile(new URL('./registration_results.sql', import.meta.url), 'utf8'));
  const stage5Samples = stage5Results.flatMap(result => result.rows).filter(row => typeof row.label === 'string' && row.data && row.kind);
  if (stage5Samples.length === 0) throw new Error('Registration/result SQL must return contract samples.');
  for (const { label, kind, data } of stage5Samples) {
    try {
      if (kind === 'registration-receipt') validateRegistrationReceipt(data);
      else if (kind === 'registration-snapshot') validateRegistrationSnapshot(data);
      else if (kind === 'result-receipt') validateResultReceipt(data);
      else if (kind === 'result-snapshot') validateResultSnapshot(data);
      else if (kind === 'evidence') validateEvidenceMetadata(data);
      else throw new Error(`Unknown contract sample kind: ${kind}`);
    } catch (error) { throw new Error(`SQL/core registration/result contract mismatch: ${label}`, { cause: error }); }
  }
  console.log(`Foundation, finance, planning, registration and results SQL passed; ${samples.length} financial + ${planningSamples.length} planning + ${stage5Samples.length} registration/result responses validated by the real core; all 32 catalog rules match, manifests/raw sources independently hashed (Auth/Storage stubs; platform integration remains separate).`);
} catch (error) {
  for (let cause = error; cause; cause = cause.cause) console.error(cause.message, cause.where ?? '');
  process.exitCode = 1;
} finally {
  await db.close();
  await rm(compiledCore, { recursive: true, force: true });
}
