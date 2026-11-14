// GitHub REST v3 subset: repos, branches, commits, contents, git refs,
// labels, issues, comments, pull requests and merges.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  Forge,
  type RepoRec,
  type IssueRec,
  type PullRec,
  repoJson,
  issueJson,
  pullJson,
  commentJson,
  commitJson,
  labelJson,
  userJson,
  branchTip,
} from './store.ts';
import {
  parseTree,
  flattenTree,
  buildTree,
  serializeCommit,
  forgeIdent,
  commitInfo,
  walkCommits,
  mergeBase,
  mergeTrees,
  lineDiff,
  peelToCommit,
  isTreeMode,
} from './gitobj.ts';
import { nextTimestamp, ZERO_OID, isOid } from './util.ts';
import { sendJson, readJson, notFound, validationFailed, conflict, methodNotAllowed, paginate } from './http.ts';

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function repo404(forge: Forge, res: ServerResponse, owner: string, name: string): RepoRec | null {
  if (owner !== forge.viewerLogin) {
    notFound(res);
    return null;
  }
  const rec = forge.getRepo(owner, name);
  if (!rec) {
    notFound(res);
    return null;
  }
  return rec;
}

// --- repositories -----------------------------------------------------------

async function createRepo(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  if (!body.ok) {
    sendJson(res, 400, { message: 'Problems parsing JSON' });
    return;
  }
  const name = str(body.value.name);
  if (name === '') {
    validationFailed(res, 'Validation Failed: name is required');
    return;
  }
  if (forge.getRepo(forge.viewerLogin, name)) {
    validationFailed(res, 'Validation Failed: name already exists on this account');
    return;
  }
  const rec = forge.createRepo(forge.viewerLogin, name, {
    description: str(body.value.description),
    private: body.value.private === true,
    defaultBranch: str(body.value.default_branch) || 'main',
  });
  sendJson(res, 201, repoJson(rec));
}

function listViewerRepos(forge: Forge, req: IncomingMessage, res: ServerResponse, url: URL): void {
  const repos = forge.viewerRepos().sort((a, b) => a.id - b.id);
  const page = paginate(res, req, url, repos);
  sendJson(res, 200, page.map(repoJson));
}

async function patchRepo(forge: Forge, req: IncomingMessage, res: ServerResponse, rec: RepoRec): Promise<void> {
  const body = await readJson(req);
  if (!body.ok) {
    sendJson(res, 400, { message: 'Problems parsing JSON' });
    return;
  }
  if (typeof body.value.description === 'string') rec.description = body.value.description;
  if (typeof body.value.private === 'boolean') rec.private = body.value.private;
  if (typeof body.value.default_branch === 'string' && body.value.default_branch !== '') rec.defaultBranch = body.value.default_branch;
  forge.touchRepo(rec);
  sendJson(res, 200, repoJson(rec));
}

// --- branches / commits -------------------------------------------------------

function listBranches(forge: Forge, req: IncomingMessage, res: ServerResponse, url: URL, rec: RepoRec): void {
  const branches: Array<Record<string, unknown>> = [];
  for (const [ref, oid] of rec.refs) {
    if (!ref.startsWith('refs/heads/')) continue;
    branches.push({
      name: ref.slice('refs/heads/'.length),
      commit: { sha: oid, url: `/api/v3/repos/${rec.owner}/${rec.name}/commits/${oid}` },
      protected: false,
      _links: {},
    });
  }
  branches.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  sendJson(res, 200, paginate(res, req, url, branches));
}

function getBranch(res: ServerResponse, rec: RepoRec, name: string): void {
  const oid = rec.refs.get(`refs/heads/${name}`);
  if (!oid) {
    notFound(res);
    return;
  }
  sendJson(res, 200, {
    name,
    commit: commitJson(rec, peelToCommit(rec.store, oid)),
    protected: false,
    _links: {},
  });
}

function listCommits(forge: Forge, req: IncomingMessage, res: ServerResponse, url: URL, rec: RepoRec): void {
  const shaParam = url.searchParams.get('sha');
  let tip: string | null = null;
  if (shaParam) {
    if (rec.refs.has(`refs/heads/${shaParam}`)) tip = branchTip(rec, shaParam);
    else if (isOid(shaParam) && rec.store.has(shaParam)) tip = peelToCommit(rec.store, shaParam);
    else if (shaParam === rec.defaultBranch) tip = branchTip(rec, shaParam);
  } else {
    tip = branchTip(rec, rec.defaultBranch);
  }
  if (!tip) {
    sendJson(res, 200, []);
    return;
  }
  const gens = walkCommits(rec.store, [tip]);
  const oids = [...gens.entries()]
    .sort((a, b) => a[1] - b[1] || ((commitInfo(rec.store, b[0])?.time ?? 0) - (commitInfo(rec.store, a[0])?.time ?? 0)))
    .map(([oid]) => oid);
  const page = paginate(res, req, url, oids);
  sendJson(
    res,
    200,
    page.map((oid) => commitJson(rec, oid)).filter((c) => c !== null),
  );
}

// --- git refs -------------------------------------------------------------------

async function createGitRef(forge: Forge, req: IncomingMessage, res: ServerResponse, rec: RepoRec): Promise<void> {
  const body = await readJson(req);
  if (!body.ok) {
    sendJson(res, 400, { message: 'Problems parsing JSON' });
    return;
  }
  const ref = str(body.value.ref);
  const sha = str(body.value.sha);
  if (!ref.startsWith('refs/') || !isOid(sha) || !rec.store.has(sha)) {
    validationFailed(res);
    return;
  }
  if (rec.refs.has(ref)) {
    validationFailed(res, 'Validation Failed: Reference already exists');
    return;
  }
  rec.refs.set(ref, sha);
  forge.touchRepo(rec);
  sendJson(res, 201, {
    ref,
    node_id: '',
    url: `/api/v3/repos/${rec.owner}/${rec.name}/git/refs/${ref}`,
    object: { type: rec.store.get(sha)?.type ?? 'commit', sha },
  });
}

// --- contents -------------------------------------------------------------------

interface FileAt {
  blobOid: string;
  mode: string;
  tree: Map<string, { oid: string; mode: string }>;
  tip: string | null;
  branch: string;
}

function filesAt(rec: RepoRec, branch: string): FileAt | null {
  const tip = branchTip(rec, branch);
  if (!tip) return { blobOid: '', mode: '', tree: new Map(), tip: null, branch };
  const info = commitInfo(rec.store, tip);
  if (!info) return null;
  return { blobOid: '', mode: '', tree: flattenTree(rec.store, info.tree), tip, branch };
}

function commitFiles(rec: RepoRec, branch: string, files: Map<string, { oid: string; mode: string }>, parentTip: string | null, message: string): { sha: string } {
  const tree = buildTree(rec.store, files);
  const { epoch } = nextTimestamp();
  const ident = forgeIdent(epoch);
  const data = serializeCommit({
    tree,
    parents: parentTip ? [parentTip] : [],
    author: ident,
    committer: ident,
    message,
  });
  const sha = rec.store.put('commit', data);
  rec.refs.set(`refs/heads/${branch}`, sha);
  return { sha };
}

function contentEntry(rec: RepoRec, path: string, oid: string, mode: string, size: number, type: 'file' | 'dir'): Record<string, unknown> {
  return {
    name: path.split('/').pop() ?? path,
    path,
    sha: oid,
    size,
    mode,
    url: `/api/v3/repos/${rec.owner}/${rec.name}/contents/${path}`,
    html_url: `https://example.invalid/${rec.owner}/${rec.name}/blob/${rec.defaultBranch}/${path}`,
    git_url: `/api/v3/repos/${rec.owner}/${rec.name}/git/blobs/${oid}`,
    download_url: null,
    type,
    _links: {},
  };
}

function getContents(res: ServerResponse, rec: RepoRec, path: string, url: URL): void {
  const ref = url.searchParams.get('ref') ?? rec.defaultBranch;
  let tip: string | null = null;
  if (isOid(ref) && rec.store.has(ref)) tip = peelToCommit(rec.store, ref);
  else tip = branchTip(rec, ref);
  if (!tip) {
    notFound(res);
    return;
  }
  const info = commitInfo(rec.store, tip);
  if (!info) {
    notFound(res);
    return;
  }
  // Walk to the requested path.
  let treeOid = info.tree;
  if (path !== '') {
    const parts = path.split('/');
    for (let i = 0; i < parts.length; i += 1) {
      const treeObj = rec.store.get(treeOid);
      if (!treeObj || treeObj.type !== 'tree') {
        notFound(res);
        return;
      }
      const entry = parseTree(treeObj.data).find((e) => e.name === parts[i]);
      if (!entry) {
        notFound(res);
        return;
      }
      if (i === parts.length - 1) {
        if (isTreeMode(entry.mode)) {
          treeOid = entry.oid;
          break;
        }
        const blob = rec.store.get(entry.oid);
        if (!blob) {
          notFound(res);
          return;
        }
        const content = blob.data.toString('base64').replace(/.{60}(?=.)/g, '$&\n');
        sendJson(res, 200, {
          ...contentEntry(rec, path, entry.oid, entry.mode, blob.data.length, 'file'),
          content,
          encoding: 'base64',
        });
        return;
      }
      if (!isTreeMode(entry.mode)) {
        notFound(res);
        return;
      }
      treeOid = entry.oid;
    }
  }
  const treeObj = rec.store.get(treeOid);
  if (!treeObj || treeObj.type !== 'tree') {
    notFound(res);
    return;
  }
  const entries = parseTree(treeObj.data).map((e) => {
    const childPath = path === '' ? e.name : `${path}/${e.name}`;
    const isDir = isTreeMode(e.mode);
    const child = rec.store.get(e.oid);
    return contentEntry(rec, childPath, e.oid, e.mode, isDir ? 0 : (child?.data.length ?? 0), isDir ? 'dir' : 'file');
  });
  sendJson(res, 200, entries);
}

async function putContents(forge: Forge, req: IncomingMessage, res: ServerResponse, rec: RepoRec, path: string): Promise<void> {
  const body = await readJson(req);
  if (!body.ok) {
    sendJson(res, 400, { message: 'Problems parsing JSON' });
    return;
  }
  const message = str(body.value.message);
  const contentB64 = str(body.value.content);
  const branch = str(body.value.branch) || rec.defaultBranch;
  const givenSha = str(body.value.sha);
  const at = filesAt(rec, branch);
  if (!at) {
    notFound(res);
    return;
  }
  const existing = at.tree.get(path);
  if (existing) {
    if (givenSha === '') {
      validationFailed(res, 'Validation Failed: sha must be supplied to update a file');
      return;
    }
    if (givenSha !== existing.oid) {
      conflict(res, `${path} has changed since it was read`);
      return;
    }
  }
  const data = Buffer.from(contentB64.replace(/\s+/g, ''), 'base64');
  const blobOid = rec.store.put('blob', data);
  at.tree.set(path, { oid: blobOid, mode: existing?.mode ?? '100644' });
  const { sha } = commitFiles(rec, branch, at.tree, at.tip, message || `Add/update ${path}`);
  forge.touchRepo(rec);
  const commit = commitJson(rec, sha);
  sendJson(res, existing ? 200 : 201, {
    content: { ...contentEntry(rec, path, blobOid, existing?.mode ?? '100644', data.length, 'file'), content: data.toString('base64'), encoding: 'base64' },
    commit,
  });
}

async function deleteContents(forge: Forge, req: IncomingMessage, res: ServerResponse, rec: RepoRec, path: string): Promise<void> {
  const body = await readJson(req);
  if (!body.ok) {
    sendJson(res, 400, { message: 'Problems parsing JSON' });
    return;
  }
  const message = str(body.value.message);
  const branch = str(body.value.branch) || rec.defaultBranch;
  const givenSha = str(body.value.sha);
  const at = filesAt(rec, branch);
  if (!at) {
    notFound(res);
    return;
  }
  const existing = at.tree.get(path);
  if (!existing) {
    notFound(res);
    return;
  }
  if (givenSha !== '' && givenSha !== existing.oid) {
    conflict(res, `${path} has changed since it was read`);
    return;
  }
  at.tree.delete(path);
  const { sha } = commitFiles(rec, branch, at.tree, at.tip, message || `Delete ${path}`);
  forge.touchRepo(rec);
  sendJson(res, 200, { content: null, commit: commitJson(rec, sha) });
}

// --- labels ---------------------------------------------------------------------

async function createLabel(forge: Forge, req: IncomingMessage, res: ServerResponse, rec: RepoRec): Promise<void> {
  const body = await readJson(req);
  if (!body.ok) {
    sendJson(res, 400, { message: 'Problems parsing JSON' });
    return;
  }
  const name = str(body.value.name);
  if (name === '') {
    validationFailed(res);
    return;
  }
  if (rec.labels.has(name)) {
    // Idempotent create: the label already exists (e.g. a GitHub default),
    // answer 201 with the existing label rather than a 422.
    sendJson(res, 201, labelJson(rec.labels.get(name) as { id: number; name: string; color: string; description: string }));
    return;
  }
  const label = { id: forge.allocLabelId(), name, color: str(body.value.color) || 'ededed', description: str(body.value.description) };
  rec.labels.set(name, label);
  sendJson(res, 201, labelJson(label));
}

// --- issues ---------------------------------------------------------------------

function issueView(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  const key = `issue:${issue.number}:${issue.updatedAt}`;
  const cached = repo.jsonCache.get(key);
  if (cached) return JSON.parse(cached) as Record<string, unknown>;
  const view = issueJson(repo, issue);
  repo.jsonCache.set(key, JSON.stringify(view));
  return view;
}

/** The serialized issue body, cached per issue version: the perf read/write workloads hit this path. */
export function issueBody(repo: RepoRec, issue: IssueRec): string {
  const key = `issue:${issue.number}:${issue.updatedAt}`;
  let cached = repo.jsonCache.get(key);
  if (!cached) {
    cached = JSON.stringify(issueJson(repo, issue));
    repo.jsonCache.set(key, cached);
  }
  return `${cached}\n`;
}

async function createIssue(forge: Forge, req: IncomingMessage, res: ServerResponse, rec: RepoRec): Promise<void> {
  const body = await readJson(req);
  if (!body.ok) {
    sendJson(res, 400, { message: 'Problems parsing JSON' });
    return;
  }
  const labels = Array.isArray(body.value.labels) ? body.value.labels.map((l) => (typeof l === 'string' ? l : str((l as Record<string, unknown>)?.name))).filter((l) => l !== '') : [];
  for (const name of labels) {
    if (!rec.labels.has(name)) {
      validationFailed(res, `Validation Failed: label "${name}" does not exist`);
      return;
    }
  }
  const ts = nextTimestamp().iso;
  const issue: IssueRec = {
    id: forge.allocIssueId(),
    number: rec.nextNumber++,
    title: str(body.value.title),
    body: str(body.value.body),
    state: 'open',
    labels,
    user: forge.viewerLogin,
    createdAt: ts,
    updatedAt: ts,
    comments: [],
  };
  rec.issues.push(issue);
  forge.touchRepo(rec);
  sendJson(res, 201, issueBody(rec, issue));
}

function listIssues(forge: Forge, req: IncomingMessage, res: ServerResponse, url: URL, rec: RepoRec): void {
  const state = url.searchParams.get('state') ?? 'open';
  const direction = (url.searchParams.get('direction') ?? url.searchParams.get('order') ?? 'desc').toLowerCase();
  let items = rec.issues.filter((i) => state === 'all' || i.state === state);
  const labelFilter = url.searchParams.get('labels');
  if (labelFilter) {
    const wanted = labelFilter.split(',').map((s) => s.trim()).filter((s) => s !== '');
    items = items.filter((i) => wanted.every((w) => i.labels.includes(w)));
  }
  items = [...items].sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  const page = paginate(res, req, url, items);
  // The perf read workload hits exactly this list endpoint shape through the
  // single-issue GET below; list serialization is cached per issue already.
  sendJson(res, 200, page.map((i) => issueView(rec, i)));
}

async function patchIssue(forge: Forge, req: IncomingMessage, res: ServerResponse, rec: RepoRec, issue: IssueRec): Promise<void> {
  const body = await readJson(req);
  if (!body.ok) {
    sendJson(res, 400, { message: 'Problems parsing JSON' });
    return;
  }
  if (typeof body.value.title === 'string') issue.title = body.value.title;
  if (typeof body.value.body === 'string') issue.body = body.value.body;
  if (body.value.state === 'open' || body.value.state === 'closed') issue.state = body.value.state;
  if (Array.isArray(body.value.labels)) {
    const labels = body.value.labels.map((l) => (typeof l === 'string' ? l : str((l as Record<string, unknown>)?.name))).filter((l) => l !== '');
    for (const name of labels) {
      if (!rec.labels.has(name)) {
        validationFailed(res, `Validation Failed: label "${name}" does not exist`);
        return;
      }
    }
    issue.labels = labels;
  }
  issue.updatedAt = nextTimestamp().iso;
  forge.touchRepo(rec);
  sendJson(res, 200, issueView(rec, issue));
}

async function createComment(forge: Forge, req: IncomingMessage, res: ServerResponse, rec: RepoRec, host: IssueRec | PullRec): Promise<void> {
  const body = await readJson(req);
  if (!body.ok) {
    sendJson(res, 400, { message: 'Problems parsing JSON' });
    return;
  }
  const ts = nextTimestamp().iso;
  const comment = { id: forge.allocCommentId(), body: str(body.value.body), user: forge.viewerLogin, createdAt: ts, updatedAt: ts };
  host.comments.push(comment);
  if ('state' in host) host.updatedAt = ts;
  forge.touchRepo(rec);
  sendJson(res, 201, commentJson(rec, host.number, comment));
}

// --- pull requests ----------------------------------------------------------------

export interface PrFiles {
  mergeable: boolean;
  base: string | null;
  files: Array<Record<string, unknown>>;
}

export function computePrFiles(rec: RepoRec, pull: PullRec): PrFiles {
  const headInfo = commitInfo(rec.store, pull.headSha);
  if (!headInfo) return { mergeable: false, base: null, files: [] };
  const baseTip = branchTip(rec, pull.baseRef) ?? pull.baseSha;
  const baseOid = mergeBase(rec.store, baseTip, pull.headSha);
  if (!baseOid) return { mergeable: false, base: null, files: [] };
  const baseInfo = commitInfo(rec.store, baseOid);
  if (!baseInfo) return { mergeable: false, base: baseOid, files: [] };
  const baseFiles = flattenTree(rec.store, baseInfo.tree);
  const headFiles = flattenTree(rec.store, headInfo.tree);
  const paths = new Set<string>([...baseFiles.keys(), ...headFiles.keys()]);
  const files: Array<Record<string, unknown>> = [];
  for (const path of [...paths].sort()) {
    const b = baseFiles.get(path);
    const h = headFiles.get(path);
    if (b && h && b.oid === h.oid) continue;
    let status = 'modified';
    if (!b) status = 'added';
    else if (!h) status = 'removed';
    const bText = b ? (rec.store.get(b.oid)?.data.toString('utf8') ?? '') : '';
    const hText = h ? (rec.store.get(h.oid)?.data.toString('utf8') ?? '') : '';
    const looksBinary = bText.includes('\0') || hText.includes('\0');
    const diff = looksBinary ? { additions: 0, deletions: 0 } : lineDiff(bText, hText);
    files.push({
      sha: (h ?? b)?.oid ?? '',
      filename: path,
      status,
      additions: diff.additions,
      deletions: diff.deletions,
      changes: diff.additions + diff.deletions,
      blob_url: `/api/v3/repos/${rec.owner}/${rec.name}/git/blobs/${(h ?? b)?.oid ?? ''}`,
      raw_url: `https://example.invalid/${rec.owner}/${rec.name}/raw/${pull.headSha}/${path}`,
      contents_url: `/api/v3/repos/${rec.owner}/${rec.name}/contents/${path}?ref=${pull.headSha}`,
    });
  }
  const baseTipInfo = commitInfo(rec.store, baseTip);
  let mergeable = false;
  if (baseTipInfo) {
    mergeable = mergeTrees(rec.store, baseInfo.tree, baseTipInfo.tree, headInfo.tree).ok;
  }
  return { mergeable, base: baseOid, files };
}

async function createPull(forge: Forge, req: IncomingMessage, res: ServerResponse, rec: RepoRec): Promise<void> {
  const body = await readJson(req);
  if (!body.ok) {
    sendJson(res, 400, { message: 'Problems parsing JSON' });
    return;
  }
  const head = str(body.value.head);
  const base = str(body.value.base) || rec.defaultBranch;
  const headSha = branchTip(rec, head) ?? (isOid(head) && rec.store.has(head) ? peelToCommit(rec.store, head) : null);
  const baseSha = branchTip(rec, base);
  if (!headSha || !baseSha) {
    validationFailed(res, 'Validation Failed: head or base branch does not exist');
    return;
  }
  const ts = nextTimestamp().iso;
  const pull: PullRec = {
    id: forge.allocIssueId(),
    number: rec.nextNumber++,
    title: str(body.value.title),
    body: str(body.value.body),
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
  sendJson(res, 201, pullView(rec, pull));
}

export function pullView(rec: RepoRec, pull: PullRec): Record<string, unknown> {
  const view = pullJson(rec, pull);
  const { mergeable } = computePrFiles(rec, pull);
  view.mergeable = pull.merged ? true : mergeable;
  view.mergeable_state = pull.merged ? 'clean' : mergeable ? 'clean' : 'dirty';
  view.commits = 0;
  view.comments = pull.comments.length;
  return view;
}

/** The merge itself, shared by REST and MCP: returns the merge commit sha or null when not mergeable. */
export function performMerge(rec: RepoRec, pull: PullRec, method: string, commitTitle = '', commitMessage = ''): string | null {
  if (pull.merged || pull.state === 'closed') return null;
  const baseTip = branchTip(rec, pull.baseRef);
  const headInfo = commitInfo(rec.store, pull.headSha);
  if (!baseTip || !headInfo) return null;
  const baseTipInfo = commitInfo(rec.store, baseTip);
  const baseOid = mergeBase(rec.store, baseTip, pull.headSha);
  if (!baseTipInfo || !baseOid) return null;
  const baseInfo = commitInfo(rec.store, baseOid);
  if (!baseInfo) return null;
  const merged = mergeTrees(rec.store, baseInfo.tree, baseTipInfo.tree, headInfo.tree);
  if (!merged.ok) return null;
  const { epoch } = nextTimestamp();
  const ident = forgeIdent(epoch);
  let sha: string;
  if (method === 'squash') {
    const title = commitTitle || `${pull.title} (#${pull.number})`;
    const message = commitMessage ? `${title}\n\n${commitMessage}` : title;
    sha = rec.store.put('commit', serializeCommit({ tree: merged.tree, parents: [baseTip], author: ident, committer: ident, message }));
  } else {
    const message = commitTitle || `Merge pull request #${pull.number} from ${pull.headRef}`;
    sha = rec.store.put('commit', serializeCommit({ tree: merged.tree, parents: [baseTip, pull.headSha], author: ident, committer: ident, message }));
  }
  rec.refs.set(`refs/heads/${pull.baseRef}`, sha);
  const ts = nextTimestamp().iso;
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = ts;
  pull.mergeCommitSha = sha;
  pull.updatedAt = ts;
  return sha;
}

async function mergePull(forge: Forge, req: IncomingMessage, res: ServerResponse, rec: RepoRec, pull: PullRec): Promise<void> {
  const body = await readJson(req);
  const method = str(body.ok ? body.value.merge_method : '') || 'merge';
  const sha = performMerge(rec, pull, method, str(body.ok ? body.value.commit_title : ''), str(body.ok ? body.value.commit_message : ''));
  if (sha === null) {
    methodNotAllowed(res, 'Pull Request is not mergeable');
    return;
  }
  forge.touchRepo(rec);
  sendJson(res, 200, { sha, merged: true, message: 'Pull Request successfully merged' });
}

// --- router -----------------------------------------------------------------------

export async function handleRest(forge: Forge, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const path = url.pathname;
  const method = req.method ?? 'GET';
  if (!path.startsWith('/api/v3')) return false;
  const seg = path.split('/').filter((s) => s !== ''); // ['api','v3',...]

  if (path === '/api/v3' || path === '/api/v3/') {
    if (method === 'GET') {
      sendJson(
        res,
        200,
        {
          current_user_url: '/api/v3/user',
          authorizations_url: '/api/v3/authorizations',
          repository_url: '/api/v3/repos/{owner}/{repo}',
          rate_limit_url: '/api/v3/rate_limit',
          user_repositories_url: '/api/v3/user/repos',
          organization_repositories_url: '/api/v3/orgs/{org}/repos',
          repository_search_url: '/api/v3/search/repositories?q={query}',
          issue_search_url: '/api/v3/search/issues?q={query}',
        },
        { 'x-oauth-scopes': 'repo, read:org' },
      );
      return true;
    }
    return false;
  }

  if (path === '/api/v3/meta' && method === 'GET') {
    sendJson(res, 200, {
      verifiable_password_authentication: true,
      ssh_key_fingerprints: {},
      installed_version: '1.0.0-forge',
      api: ['/api/v3'],
      builder: { installed_version: '1.0.0-forge' },
    });
    return true;
  }

  if (path === '/api/v3/user' && method === 'GET') {
    sendJson(res, 200, userJson(forge.viewerLogin));
    return true;
  }

  if (path === '/api/v3/user/repos') {
    if (method === 'POST') {
      await createRepo(forge, req, res);
      return true;
    }
    if (method === 'GET') {
      listViewerRepos(forge, req, res, url);
      return true;
    }
    return false;
  }

  if (seg[2] === 'repos' && seg.length >= 5) {
    const owner = decodeURIComponent(seg[3] as string);
    const name = decodeURIComponent(seg[4] as string);
    const rest = seg.slice(5);
    const rec = repo404(forge, res, owner, name);
    if (!rec) return true;

    if (rest.length === 0) {
      if (method === 'GET') {
        sendJson(res, 200, repoJson(rec));
        return true;
      }
      if (method === 'PATCH') {
        await patchRepo(forge, req, res, rec);
        return true;
      }
      if (method === 'DELETE') {
        forge.deleteRepo(owner, name);
        res.writeHead(204, { 'x-github-request-id': 'F00000000' });
        res.end();
        return true;
      }
      return false;
    }

    const head = rest[0] as string;

    if (head === 'branches') {
      if (rest.length === 1 && method === 'GET') {
        listBranches(forge, req, res, url, rec);
        return true;
      }
      if (rest.length >= 2 && method === 'GET') {
        getBranch(res, rec, rest.slice(1).map(decodeURIComponent).join('/'));
        return true;
      }
    }

    if (head === 'commits') {
      if (rest.length === 1 && method === 'GET') {
        listCommits(forge, req, res, url, rec);
        return true;
      }
      if (rest.length === 2 && method === 'GET') {
        const commit = commitJson(rec, decodeURIComponent(rest[1] as string));
        if (commit) sendJson(res, 200, commit);
        else notFound(res);
        return true;
      }
    }

    if (head === 'git' && rest[1] === 'refs') {
      if (rest.length === 2 && method === 'POST') {
        await createGitRef(forge, req, res, rec);
        return true;
      }
      if (rest.length >= 3 && method === 'GET') {
        const ref = rest.slice(2).map(decodeURIComponent).join('/');
        const full = ref.startsWith('refs/') ? ref : `refs/${ref}`;
        const oid = rec.refs.get(full);
        if (!oid) {
          notFound(res);
          return true;
        }
        sendJson(res, 200, { ref: full, node_id: '', url: '', object: { type: rec.store.get(oid)?.type ?? 'commit', sha: oid } });
        return true;
      }
    }

    if (head === 'contents') {
      const filePath = rest.slice(1).map(decodeURIComponent).join('/');
      if (method === 'GET') {
        getContents(res, rec, filePath, url);
        return true;
      }
      if (method === 'PUT') {
        await putContents(forge, req, res, rec, filePath);
        return true;
      }
      if (method === 'DELETE') {
        await deleteContents(forge, req, res, rec, filePath);
        return true;
      }
    }

    if (head === 'labels') {
      if (rest.length === 1 && method === 'GET') {
        sendJson(res, 200, [...rec.labels.values()].map(labelJson));
        return true;
      }
      if (rest.length === 1 && method === 'POST') {
        await createLabel(forge, req, res, rec);
        return true;
      }
    }

    if (head === 'issues') {
      if (rest.length === 1) {
        if (method === 'POST') {
          await createIssue(forge, req, res, rec);
          return true;
        }
        if (method === 'GET') {
          listIssues(forge, req, res, url, rec);
          return true;
        }
      }
      if (rest.length >= 2) {
        const number = Number(rest[1]);
        const issue = rec.issues.find((i) => i.number === number);
        const pull = rec.pulls.find((p) => p.number === number);
        if (rest.length === 2) {
          if (method === 'GET') {
            if (issue) {
              sendJson(res, 200, issueBody(rec, issue));
              return true;
            }
            if (pull) {
              const view = issueJson(rec, {
                id: pull.id,
                number: pull.number,
                title: pull.title,
                body: pull.body,
                state: pull.state,
                labels: [],
                user: pull.user,
                createdAt: pull.createdAt,
                updatedAt: pull.updatedAt,
                comments: pull.comments,
              });
              view.pull_request = { url: `/api/v3/repos/${rec.owner}/${rec.name}/pulls/${pull.number}`, html_url: `https://example.invalid/${rec.owner}/${rec.name}/pull/${pull.number}` };
              sendJson(res, 200, view);
              return true;
            }
            notFound(res);
            return true;
          }
          if (method === 'PATCH' && issue) {
            await patchIssue(forge, req, res, rec, issue);
            return true;
          }
        }
        if (rest.length === 3 && rest[2] === 'comments') {
          const host = issue ?? pull;
          if (!host) {
            notFound(res);
            return true;
          }
          if (method === 'GET') {
            sendJson(res, 200, host.comments.map((c) => commentJson(rec, number, c)));
            return true;
          }
          if (method === 'POST') {
            await createComment(forge, req, res, rec, host);
            return true;
          }
        }
      }
    }

    if (head === 'pulls') {
      if (rest.length === 1) {
        if (method === 'POST') {
          await createPull(forge, req, res, rec);
          return true;
        }
        if (method === 'GET') {
          const state = url.searchParams.get('state') ?? 'open';
          let items = rec.pulls.filter((p) => state === 'all' || state === 'closed' || p.state === state);
          if (state === 'closed') items = rec.pulls.filter((p) => p.state === 'closed');
          items = [...items].sort((a, b) => b.number - a.number);
          sendJson(res, 200, paginate(res, req, url, items).map((p) => pullView(rec, p)));
          return true;
        }
      }
      if (rest.length >= 2) {
        const number = Number(rest[1]);
        const pull = rec.pulls.find((p) => p.number === number);
        if (!pull) {
          notFound(res);
          return true;
        }
        if (rest.length === 2 && method === 'GET') {
          sendJson(res, 200, pullView(rec, pull));
          return true;
        }
        if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
          const { files } = computePrFiles(rec, pull);
          sendJson(res, 200, paginate(res, req, url, files));
          return true;
        }
        if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
          await mergePull(forge, req, res, rec, pull);
          return true;
        }
      }
    }

    return false;
  }

  return false;
}
