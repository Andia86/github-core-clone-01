// MCP over streamable HTTP: JSON-RPC 2.0 at POST /mcp. Tools delegate to
// the same forge state as REST, so MCP-created data reads back identically
// over REST (and vice versa). tools/list output is a build-time constant,
// byte-identical across calls.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Forge, RepoRec, IssueRec, PullRec } from './store.ts';
import { repoJson, issueJson, pullJson, branchTip } from './store.ts';
import { performMerge, pullView } from './rest.ts';
import { nextTimestamp } from './util.ts';
import { sendJson, readBody } from './http.ts';

const PROTOCOL_VERSIONS = ['2025-03-26', '2025-06-18', '2024-11-05'];
const SERVER_INFO = { name: 'forge-mcp', version: '1.0.0' };

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function schema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: 'object', properties, additionalProperties: true, required };
}
const STR = { type: 'string' };
const NUM = { type: 'number' };
const BOOL = { type: 'boolean' };

const TOOLS: ToolDef[] = [
  {
    name: 'create_repository',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: schema({ name: STR, description: STR, private: BOOL }, ['name']),
  },
  {
    name: 'get_repository',
    description: 'Get a repository by owner and name.',
    inputSchema: schema({ owner: STR, repo: STR }, ['owner', 'repo']),
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: schema({ owner: STR, repo: STR }, ['owner', 'repo']),
  },
  {
    name: 'search_repositories',
    description: 'Search for repositories by name.',
    inputSchema: schema({ query: STR }, ['query']),
  },
  {
    name: 'create_issue',
    description: 'Create a new issue in a repository.',
    inputSchema: schema({ owner: STR, repo: STR, title: STR, body: STR, labels: { type: 'array', items: STR } }, ['owner', 'repo', 'title']),
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: schema({ owner: STR, repo: STR, state: STR }, ['owner', 'repo']),
  },
  {
    name: 'get_issue',
    description: 'Get a single issue by number.',
    inputSchema: schema({ owner: STR, repo: STR, issue_number: NUM }, ['owner', 'repo', 'issue_number']),
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch to a base branch.',
    inputSchema: schema({ owner: STR, repo: STR, title: STR, body: STR, head: STR, base: STR }, ['owner', 'repo', 'title', 'head', 'base']),
  },
  {
    name: 'get_pull_request',
    description: 'Get a single pull request by number.',
    inputSchema: schema({ owner: STR, repo: STR, pull_number: NUM }, ['owner', 'repo', 'pull_number']),
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (merge or squash).',
    inputSchema: schema({ owner: STR, repo: STR, pull_number: NUM, merge_method: STR }, ['owner', 'repo', 'pull_number']),
  },
];
const TOOLS_LIST_JSON = JSON.stringify({ tools: TOOLS });

function textResult(value: unknown, isError = false): Record<string, unknown> {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text', text }], isError };
}

function repoOf(forge: Forge, args: Record<string, unknown>): RepoRec | null {
  const owner = String(args.owner ?? forge.viewerLogin);
  const repo = String(args.repo ?? '');
  if (owner !== forge.viewerLogin) return null;
  return forge.getRepo(owner, repo) ?? null;
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> | 'unknown' {
  switch (name) {
    case 'get_repository':
    case 'get_repo': {
      const rec = repoOf(forge, args);
      if (!rec) return textResult('error: repository not found', true);
      return textResult(repoJson(rec));
    }
    case 'create_repository': {
      const repoName = String(args.name ?? '');
      if (repoName === '') return textResult('error: name is required', true);
      if (forge.getRepo(forge.viewerLogin, repoName)) return textResult(`error: repository ${repoName} already exists`, true);
      const rec = forge.createRepo(forge.viewerLogin, repoName, {
        description: String(args.description ?? ''),
        private: args.private === true,
      });
      return textResult(repoJson(rec));
    }
    case 'search_repositories': {
      const query = String(args.query ?? '').toLowerCase();
      const hits = forge.viewerRepos().filter((r) => query === '' || r.name.toLowerCase().includes(query));
      return textResult({ total_count: hits.length, items: hits.map(repoJson) });
    }
    case 'create_issue': {
      const rec = repoOf(forge, args);
      if (!rec) return textResult('error: repository not found', true);
      const title = String(args.title ?? '');
      if (title === '') return textResult('error: title is required', true);
      const labels = Array.isArray(args.labels) ? args.labels.map(String) : [];
      for (const label of labels) {
        if (!rec.labels.has(label)) return textResult(`error: label "${label}" does not exist`, true);
      }
      const ts = nextTimestamp().iso;
      const issue: IssueRec = {
        id: forge.allocIssueId(),
        number: rec.nextNumber++,
        title,
        body: String(args.body ?? ''),
        state: 'open',
        labels,
        user: forge.viewerLogin,
        createdAt: ts,
        updatedAt: ts,
        comments: [],
      };
      rec.issues.push(issue);
      forge.touchRepo(rec);
      return textResult(issueJson(rec, issue));
    }
    case 'list_issues': {
      const rec = repoOf(forge, args);
      if (!rec) return textResult('error: repository not found', true);
      const state = String(args.state ?? 'open');
      const items = rec.issues.filter((i) => state === 'all' || i.state === state);
      return textResult(items.map((i) => issueJson(rec, i)));
    }
    case 'get_issue': {
      const rec = repoOf(forge, args);
      if (!rec) return textResult('error: repository not found', true);
      const issue = rec.issues.find((i) => i.number === Number(args.issue_number));
      if (!issue) return textResult('error: issue not found', true);
      return textResult(issueJson(rec, issue));
    }
    case 'create_pull_request': {
      const rec = repoOf(forge, args);
      if (!rec) return textResult('error: repository not found', true);
      const head = String(args.head ?? '');
      const base = String(args.base ?? '');
      const headSha = branchTip(rec, head);
      const baseSha = branchTip(rec, base);
      if (!headSha || !baseSha) return textResult('error: head or base branch does not exist', true);
      const ts = nextTimestamp().iso;
      const pull: PullRec = {
        id: forge.allocIssueId(),
        number: rec.nextNumber++,
        title: String(args.title ?? ''),
        body: String(args.body ?? ''),
        state: 'open',
        headRef: head,
        headSha,
        baseRef: base,
        baseSha,
        user: forge.viewerLogin,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        createdAt: ts,
        updatedAt: ts,
        comments: [],
      };
      rec.pulls.push(pull);
      forge.touchRepo(rec);
      return textResult(pullView(rec, pull));
    }
    case 'get_pull_request': {
      const rec = repoOf(forge, args);
      if (!rec) return textResult('error: repository not found', true);
      const pull = rec.pulls.find((p) => p.number === Number(args.pull_number));
      if (!pull) return textResult('error: pull request not found', true);
      return textResult(pullView(rec, pull));
    }
    case 'merge_pull_request': {
      const rec = repoOf(forge, args);
      if (!rec) return textResult('error: repository not found', true);
      const pull = rec.pulls.find((p) => p.number === Number(args.pull_number));
      if (!pull) return textResult('error: pull request not found', true);
      const method = String(args.merge_method ?? 'merge').toLowerCase() === 'squash' ? 'squash' : 'merge';
      const sha = performMerge(rec, pull, method);
      if (sha === null) return textResult('error: pull request is not mergeable', true);
      forge.touchRepo(rec);
      return textResult({ sha, merged: true, message: 'Pull Request successfully merged', pull_request: pullView(rec, pull) });
    }
    default:
      return 'unknown';
  }
}

interface RpcMessage {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
}

function handleMessage(forge: Forge, msg: RpcMessage): { status: number; body?: unknown } {
  const hasId = msg.id !== undefined && msg.id !== null;
  const method = String(msg.method ?? '');
  const ok = (result: unknown) => ({ status: 200, body: { jsonrpc: '2.0', id: msg.id, result } });
  const fail = (code: number, message: string) => ({ status: 200, body: { jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } } });

  if (!hasId) {
    // Notification: accept silently.
    return { status: 202 };
  }

  switch (method) {
    case 'initialize': {
      const requested = String((msg.params?.protocolVersion as string) ?? '');
      const protocolVersion = PROTOCOL_VERSIONS.includes(requested) ? requested : '2025-03-26';
      return ok({ protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO });
    }
    case 'server/discover':
      return ok({
        protocolVersion: '2025-03-26',
        supportedVersions: PROTOCOL_VERSIONS,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });
    case 'ping':
      return ok({});
    case 'tools/list':
      return { status: 200, body: { jsonrpc: '2.0', id: msg.id, result: JSON.parse(TOOLS_LIST_JSON) as unknown } };
    case 'tools/call': {
      const name = String(msg.params?.name ?? '');
      const rawArgs = msg.params?.arguments;
      const args = rawArgs !== null && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? (rawArgs as Record<string, unknown>) : {};
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return fail(-32602, `unknown tool: ${name}`);
      // Missing required arguments surface as an isError tool result.
      const required = (tool.inputSchema.required as string[]) ?? [];
      for (const key of required) {
        if (args[key] === undefined || args[key] === null || args[key] === '') {
          return ok(textResult(`error: missing required argument: ${key}`, true));
        }
      }
      const result = callTool(forge, name, args);
      if (result === 'unknown') return fail(-32602, `unknown tool: ${name}`);
      return ok(result);
    }
    default:
      return fail(-32601, `method not found: ${method}`);
  }
}

export async function handleMcp(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  if (method === 'GET' || method === 'DELETE') {
    res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': 'F00000MCP' });
    res.end(JSON.stringify({ message: 'Method Not Allowed' }));
    return;
  }
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (Array.isArray(parsed)) {
    const answers: unknown[] = [];
    for (const item of parsed) {
      const answer = handleMessage(forge, (item ?? {}) as RpcMessage);
      if (answer.body !== undefined) answers.push(answer.body);
    }
    sendJson(res, 200, answers);
    return;
  }
  const answer = handleMessage(forge, (parsed ?? {}) as RpcMessage);
  if (answer.body === undefined) {
    res.writeHead(202, { 'x-github-request-id': 'F00000MCP' });
    res.end();
    return;
  }
  sendJson(res, answer.status, answer.body);
}
