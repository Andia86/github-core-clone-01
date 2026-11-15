// HTTP plumbing shared by every surface: JSON answers, body reading, errors.

import type { IncomingMessage, ServerResponse } from 'node:http';

export const JSON_TYPE = 'application/json; charset=utf-8';
let requestSeq = 0;

export function nextRequestId(): string {
  requestSeq += 1;
  return `F${requestSeq.toString(16).padStart(8, '0')}`;
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  // A Buffer body is sent as-is (the read hot path caches whole bodies);
  // strings go out untouched and anything else is JSON with a trailing \n.
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : `${JSON.stringify(body)}\n`, 'utf8');
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': buf.length,
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(buf);
}

export function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string, headers: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(body);
}

export function notFound(res: ServerResponse): void {
  sendJson(res, 404, { message: 'Not Found', documentation_url: 'https://docs.github.com/rest' });
}

export function badCredentials(res: ServerResponse): void {
  sendJson(res, 401, { message: 'Bad credentials', documentation_url: 'https://docs.github.com/rest' });
}

export function validationFailed(res: ServerResponse, detail = 'Validation Failed'): void {
  sendJson(res, 422, { message: detail, errors: [] });
}

export function methodNotAllowed(res: ServerResponse, message = 'Method Not Allowed'): void {
  sendJson(res, 405, { message });
}

export function conflict(res: ServerResponse, message: string): void {
  sendJson(res, 409, { message });
}

export async function readBody(req: IncomingMessage, limit = 64 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > limit) throw new Error('request body too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/** Parse a JSON body; returns {ok} so handlers can answer 400 on malformed input. */
export async function readJson(req: IncomingMessage): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false }> {
  const raw = await readBody(req);
  if (raw.length === 0) return { ok: true, value: {} };
  try {
    const value = JSON.parse(raw.toString('utf8')) as unknown;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ok: true, value: {} };
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

export function pageParams(url: URL): { page: number; perPage: number } {
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
  const perPage = Math.min(100, Math.max(1, Number(url.searchParams.get('per_page') ?? '30') || 30));
  return { page, perPage };
}

/** Slice a list for the page and set GitHub-style Link headers when more pages exist. */
export function paginate<T>(res: ServerResponse, req: IncomingMessage, url: URL, items: T[]): T[] {
  const { page, perPage } = pageParams(url);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  if (page < totalPages) {
    const host = req.headers.host ?? 'localhost';
    const next = new URL(url.pathname, `http://${host}`);
    for (const [k, v] of url.searchParams) next.searchParams.set(k, v);
    next.searchParams.set('page', String(page + 1));
    next.searchParams.set('per_page', String(perPage));
    const last = new URL(url.pathname, `http://${host}`);
    for (const [k, v] of url.searchParams) last.searchParams.set(k, v);
    last.searchParams.set('page', String(totalPages));
    last.searchParams.set('per_page', String(perPage));
    res.setHeader('link', `<${next.toString()}>; rel="next", <${last.toString()}>; rel="last"`);
  }
  return items.slice((page - 1) * perPage, page * perPage);
}
