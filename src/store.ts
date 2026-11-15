// Forge state: users, repositories (objects + refs), issues, pull requests.
// Everything in memory; one RepoRec per repository, keyed "owner/name".

import { ObjectStore, commitInfo, peelToCommit } from './gitobj.ts';
import { nextTimestamp, globalId } from './util.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;

export const DEFAULT_LABELS = ['bug', 'enhancement', 'documentation', 'question', 'good first issue', 'help wanted'];
const LABEL_COLORS: Record<string, string> = {
  bug: 'd73a4a',
  enhancement: 'a2eeef',
  documentation: '0075ca',
  question: 'd876e3',
  'good first issue': '7057ff',
  'help wanted': '008672',
};

export interface LabelRec {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface CommentRec {
  id: number;
  body: string;
  user: string;
  createdAt: string;
  updatedAt: string;
}

export interface IssueRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  user: string;
  createdAt: string;
  updatedAt: string;
  comments: CommentRec[];
}

export interface PullRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  user: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdAt: string;
  updatedAt: string;
  comments: CommentRec[];
}

export interface RepoRec {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  store: ObjectStore;
  refs: Map<string, string>;
  issues: IssueRec[];
  pulls: PullRec[];
  nextNumber: number;
  labels: Map<string, LabelRec>;
  createdAt: string;
  updatedAt: string;
  packCache: Map<string, Buffer>;
  fetchCache: Map<string, Promise<Buffer>>;
  jsonCache: Map<string, string>;
  bodyCache: Map<string, Buffer>;
}

export class Forge {
  readonly token: string;
  viewerLogin = VIEWER_LOGIN;
  repos = new Map<string, RepoRec>();
  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextCommentId = 1;
  private nextLabelId = 1;

  constructor(token: string) {
    this.token = token;
  }

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(owner: string, name: string, opts: { description?: string; private?: boolean; defaultBranch?: string }): RepoRec {
    const ts = nextTimestamp().iso;
    const rec: RepoRec = {
      id: this.nextRepoId++,
      owner,
      name,
      description: opts.description ?? '',
      private: opts.private ?? false,
      defaultBranch: opts.defaultBranch ?? 'main',
      store: new ObjectStore(),
      refs: new Map(),
      issues: [],
      pulls: [],
      nextNumber: 1,
      labels: new Map(),
      createdAt: ts,
      updatedAt: ts,
      packCache: new Map(),
      fetchCache: new Map(),
      jsonCache: new Map(),
      bodyCache: new Map(),
    };
    for (const label of DEFAULT_LABELS) {
      rec.labels.set(label, { id: this.nextLabelId++, name: label, color: LABEL_COLORS[label] ?? 'ededed', description: '' });
    }
    this.repos.set(this.key(owner, name), rec);
    return rec;
  }

  getRepo(owner: string, name: string): RepoRec | undefined {
    return this.repos.get(this.key(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  viewerRepos(): RepoRec[] {
    return [...this.repos.values()].filter((r) => r.owner === this.viewerLogin);
  }

  allocIssueId(): number {
    return this.nextIssueId++;
  }

  allocCommentId(): number {
    return this.nextCommentId++;
  }

  allocLabelId(): number {
    return this.nextLabelId++;
  }

  touchRepo(rec: RepoRec): void {
    rec.updatedAt = nextTimestamp().iso;
    rec.jsonCache.clear();
    rec.bodyCache.clear();
  }
}

// --- JSON shapes -------------------------------------------------------------

export function userJson(login: string): Record<string, unknown> {
  return {
    login,
    id: login === VIEWER_LOGIN ? VIEWER_ID : 0,
    node_id: globalId('User', login === VIEWER_LOGIN ? VIEWER_ID : 0),
    type: 'User',
    site_admin: false,
    avatar_url: `https://example.invalid/avatars/${login}`,
    html_url: `https://example.invalid/${login}`,
    url: `/api/v3/users/${login}`,
  };
}

export function labelJson(rec: LabelRec): Record<string, unknown> {
  return {
    id: rec.id,
    node_id: globalId('Label', rec.id),
    name: rec.name,
    color: rec.color,
    default: DEFAULT_LABELS.includes(rec.name),
    description: rec.description,
    url: '',
  };
}

export function repoJson(rec: RepoRec): Record<string, unknown> {
  return {
    id: rec.id,
    node_id: globalId('Repository', rec.id),
    name: rec.name,
    full_name: `${rec.owner}/${rec.name}`,
    owner: userJson(rec.owner),
    private: rec.private,
    html_url: `https://example.invalid/${rec.owner}/${rec.name}`,
    description: rec.description,
    fork: false,
    url: `/api/v3/repos/${rec.owner}/${rec.name}`,
    created_at: rec.createdAt,
    updated_at: rec.updatedAt,
    pushed_at: rec.updatedAt,
    git_url: `git://example.invalid/${rec.owner}/${rec.name}.git`,
    ssh_url: `git@example.invalid:${rec.owner}/${rec.name}.git`,
    clone_url: `https://example.invalid/${rec.owner}/${rec.name}.git`,
    homepage: '',
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    forks_count: 0,
    mirror_url: null,
    archived: false,
    disabled: false,
    open_issues_count: rec.issues.filter((i) => i.state === 'open').length + rec.pulls.filter((p) => p.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: rec.private ? 'private' : 'public',
    forks: 0,
    open_issues: rec.issues.filter((i) => i.state === 'open').length,
    watchers: 0,
    default_branch: rec.defaultBranch,
  };
}

export function commentJson(repo: RepoRec, issueNumber: number, c: CommentRec): Record<string, unknown> {
  return {
    id: c.id,
    node_id: globalId('IssueComment', c.id),
    body: c.body,
    user: userJson(c.user),
    created_at: c.createdAt,
    updated_at: c.updatedAt,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issueNumber}#issuecomment-${c.id}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${c.id}`,
    issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issueNumber}`,
    author_association: 'OWNER',
  };
}

export function issueJson(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', issue.id),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    labels: issue.labels.map((name) => {
      const rec = repo.labels.get(name);
      return rec ? labelJson(rec) : { id: 0, node_id: '', name, color: 'ededed', default: false, description: '' };
    }),
    user: userJson(issue.user),
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    labels_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/labels{/name}`,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
    events_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/events`,
    author_association: 'OWNER',
  };
}

export function pullJson(repo: RepoRec, pull: PullRec): Record<string, unknown> {
  const refSide = (ref: string, sha: string) => ({
    label: `${repo.owner}:${ref}`,
    ref,
    sha,
    user: userJson(repo.owner),
    repo: repoJson(repo),
  });
  return {
    id: pull.id,
    node_id: globalId('PullRequest', pull.id),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    user: userJson(pull.user),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    merged: pull.merged,
    draft: false,
    head: refSide(pull.headRef, pull.headSha),
    base: refSide(pull.baseRef, pull.baseSha),
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${pull.number}`,
    commits_url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}/commits`,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${pull.number}/comments`,
    _links: {},
    author_association: 'OWNER',
  };
}

export function commitJson(repo: RepoRec, oid: string): Record<string, unknown> | null {
  const info = commitInfo(repo.store, oid);
  if (!info) return null;
  const ident = (line: string) => {
    const m = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(line);
    if (!m) return { name: line, email: '', date: new Date(info.time * 1000).toISOString() };
    return { name: m[1] as string, email: m[2] as string, date: new Date(Number(m[3]) * 1000).toISOString() };
  };
  return {
    sha: oid,
    node_id: globalId('Commit', Math.abs([...oid].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7))),
    commit: {
      author: ident(info.author),
      committer: ident(info.committer),
      message: info.message,
      tree: { sha: info.tree, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/trees/${info.tree}` },
      url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${oid}`,
      comment_count: 0,
    },
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${oid}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/commit/${oid}`,
    author: null,
    committer: null,
    parents: info.parents.map((p) => ({ sha: p, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${p}`, html_url: `https://example.invalid/${repo.owner}/${repo.name}/commit/${p}` })),
  };
}

export function branchTip(repo: RepoRec, branch: string): string | null {
  const oid = repo.refs.get(`refs/heads/${branch}`);
  return oid ? peelToCommit(repo.store, oid) : null;
}

export { peelToCommit };
