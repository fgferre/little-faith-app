import { createResultsCollector } from '../api/collector.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL');
const publishableKey = Deno.env.get('SUPABASE_PUBLISHABLE_KEY') ?? Deno.env.get('SUPABASE_ANON_KEY');
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const resultsJobSecret = Deno.env.get('RESULTS_JOB_SECRET');
if (!supabaseUrl || !publishableKey || !serviceRoleKey || !resultsJobSecret || resultsJobSecret.length < 32) {
  throw new Error('Configure the private collector URL, project keys and RESULTS_JOB_SECRET (32+ characters).');
}
Deno.serve(createResultsCollector({ supabaseUrl, publishableKey, serviceRoleKey, resultsJobSecret, allowedOrigins: [] }));
