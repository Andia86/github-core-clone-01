// The forge server: health probe, then token-authenticated dispatch to the
// git smart-HTTP surface, REST v3, GraphQL and MCP. Everything else is a
// GitHub-shaped JSON 404. main.ts owns the lifecycle; this file is the app.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './src/store.ts';
import { handleRest } from './src/rest.ts';
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
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const url = pathOf(req);
        const method = req.method ?? 'GET';

        if (method === 'GET' && url.pathname === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // Every other surface requires the shop token as a bearer credential.
        const auth = req.headers.authorization ?? '';
        if (auth !== `Bearer ${forge.token}`) {
          badCredentials(res);
          return;
        }

        if (await handleGitHttp(forge, req, res, url)) return;
        if (await handleRest(forge, req, res, url)) return;
        if (url.pathname === '/api/graphql') {
          await handleGraphql(forge, req, res);
          return;
        }
        if (url.pathname === '/mcp') {
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
