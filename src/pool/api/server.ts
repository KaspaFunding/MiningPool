import type { Server as HttpServer } from 'bun';

export type Mappings = Record<string, (params: Record<string, any>) => any>;

export default class Server {
  server: HttpServer;
  private mappings: Mappings;

  constructor(mappings: Mappings, port: number) {
    this.mappings = mappings;
    this.server = Bun.serve({
      port,
      fetch: this.serve.bind(this),
    });
  }

  private async serve(request: Request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // Handle OPTIONS preflight requests
    if (method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    // Set CORS headers for all responses
    const headers = new Headers({
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'application/json',
    });

    const route = this.mappings[path];
    if (!route) {
      return new Response(JSON.stringify({ error: 'Not Found' }), {
        status: 404,
        headers,
      });
    }

    try {
      if (method === 'GET') {
        const params = Object.fromEntries(url.searchParams);
        const result = await route(params);
        return new Response(JSON.stringify(result), { headers });
      }

      return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
        status: 405,
        headers,
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      headers.set('Content-Type', 'text/plain');
      return new Response(`Error: ${errorMessage}`, {
        status: 400,
        headers,
      });
    }
  }
}
