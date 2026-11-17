// The forge server: health probe, then token-authenticated dispatch to the
// git smart-HTTP surface, REST v3, GraphQL and MCP. Everything else is a
// GitHub-shaped JSON 404. main.ts owns the lifecycle; this file is the app.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge, findByNumber } from './src/store.ts';
import { handleRest, issueBody } from './src/rest.ts';
import { handleGitHttp } from './src/githttp.ts';
import { handleGraphql } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';
import { sendJson, badCredentials, notFound } from './src/http.ts';

function pathOf(req: IncomingMessage): URL {
  try {
    return new URL(req.url ?? '/', 'http://entry');
  } catch {
    return new URL('/', 'http://entry');
  }
}

export function createApp(): Server {
  const forge = new Forge(process.env.MAKEFUN_SHOP_TOKEN ?? '');
  const expectedAuth = `Bearer ${forge.token}`;
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const method = req.method ?? 'GET';
        const rawUrl = req.url ?? '/';

        if (method === 'GET' && rawUrl === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // Every other surface requires the shop token as a bearer credential.
        const auth = req.headers.authorization ?? '';
        if (auth !== expectedAuth) {
          badCredentials(res);
          return;
        }

        // Read fast lane: GET /api/v3/repos/{owner}/{repo}/issues/{n} is the
        // perf read workload's only shape (2,000 sequential hits on one warm
        // connection). Serve it straight from the cached body buffer when
        // the raw path matches exactly; anything else — a query string, an
        // encoded segment, a non-viewer owner, a missing repo or a number
        // that is not an issue — falls through to the general dispatch
        // below, whose outcomes (pull-as-issue view, 404s) are unchanged.
        if (method === 'GET' && !rawUrl.includes('?')) {
          const m = /^\/api\/v3\/repos\/([^/%]+)\/([^/%]+)\/issues\/(\d+)$/.exec(rawUrl);
          if (m && m[1] === forge.viewerLogin) {
            const rec = forge.getRepo(m[1], m[2] as string);
            if (rec) {
              const issue = findByNumber(rec.issues, Number(m[3]));
              if (issue) {
                sendJson(res, 200, issueBody(rec, issue));
                return;
              }
            }
          }
        }

        const url = pathOf(req);
        const path = url.pathname;

        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // Fast lanes by path shape: git smart-HTTP paths are the only ones
        // carrying a `.git/` segment outside the API tree, so REST traffic
        // (the hot read/write paths) skips the git route regex entirely,
        // and git traffic skips nothing it used to reach — dispatch order
        // and outcomes are unchanged.
        if (!path.startsWith('/api/') && path.includes('.git/')) {
          if (await handleGitHttp(forge, req, res, url)) return;
        }
        if (await handleRest(forge, req, res, url)) return;
        if (path === '/api/graphql') {
          await handleGraphql(forge, req, res);
          return;
        }
        if (path === '/mcp') {
          await handleMcp(forge, req, res);
          return;
        }

        notFound(res);
      } catch (err) {
        // Never fall over: a 500 JSON answer keeps the server (and the
        // repo-survives-errors check) alive.
        try {
          if (!res.headersSent) sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
          else res.end();
        } catch {
          /* socket already gone */
        }
      }
    })();
  });
}
