import { createApi, type ApiConfig } from './app.ts';

/** Dedicated capability entry point: never exposes human commands without gateway JWT validation. */
export function createResultsCollector(config: ApiConfig): (request: Request) => Promise<Response> {
  const app = createApi({ ...config, allowedOrigins: [] });
  return async request => {
    const url = new URL(request.url);
    if (!['/results-collector/v1/run', '/functions/v1/results-collector/v1/run'].includes(url.pathname)) {
      return Response.json({ code: 'not_found' }, { status: 404 });
    }
    if (request.method !== 'POST') return Response.json({ code: 'method_not_allowed' }, { status: 405 });
    url.pathname = '/api/v1/jobs/results_collect_due';
    return await app.fetch(new Request(url, request));
  };
}
