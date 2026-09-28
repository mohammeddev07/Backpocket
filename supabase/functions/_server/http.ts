// Server-only helpers for the Edge Functions (Deno). Kept out of _shared/,
// which the browser app also imports.

const DEFAULT_ORIGINS = 'https://mohammeddev07.github.io,http://localhost:5173,http://localhost:4173';

function allowedOrigins(): string[] {
  return (Deno.env.get('ALLOWED_ORIGINS') || DEFAULT_ORIGINS).split(',').map((s) => s.trim()).filter(Boolean);
}

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin') || '';
  const allowed = allowedOrigins();
  return {
    'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Expose-Headers': 'Retry-After',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

/** Answers CORS preflight; returns null for real requests. */
export function preflight(req: Request): Response | null {
  return req.method === 'OPTIONS' ? new Response(null, { status: 204, headers: corsHeaders(req) }) : null;
}

export function json(req: Request, body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra },
  });
}

/** Reads a JSON body, refusing anything over `maxBytes`. */
export async function readJson(req: Request, maxBytes: number): Promise<unknown> {
  const len = Number(req.headers.get('Content-Length') || '0');
  if (len > maxBytes) throw new HttpError(413, 'too_large', 'Request body too large.');
  const text = await req.text();
  if (new TextEncoder().encode(text).length > maxBytes) throw new HttpError(413, 'too_large', 'Request body too large.');
  try { return JSON.parse(text || '{}'); } catch { throw new HttpError(400, 'bad_json', 'Body must be JSON.'); }
}

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public headers: Record<string, string> = {}, public extra: Record<string, unknown> = {}) {
    super(message);
  }
}
