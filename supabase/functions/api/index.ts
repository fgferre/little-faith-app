import { createApi } from './app.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL');
const publishableKey = Deno.env.get('SUPABASE_PUBLISHABLE_KEY') ?? Deno.env.get('SUPABASE_ANON_KEY');
const allowedOrigins = (Deno.env.get('API_ALLOWED_ORIGINS') ?? '').split(',').map(origin => origin.trim()).filter(Boolean);
if (!supabaseUrl || !publishableKey || allowedOrigins.length === 0 || allowedOrigins.some(origin => origin === '*' || new URL(origin).origin !== origin)) {
  throw new Error('Configure SUPABASE_URL, a publishable/anon key and an explicit API_ALLOWED_ORIGINS allowlist.');
}
const app = createApi({ supabaseUrl, publishableKey, allowedOrigins, serviceRoleKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'), resultsJobSecret: Deno.env.get('RESULTS_JOB_SECRET') });
Deno.serve(app.fetch);
