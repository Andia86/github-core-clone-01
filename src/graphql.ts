// GraphQL subset: a small real parser (operations, variables, fragments,
// directives) plus a static schema for introspection, executing over the
// same forge state as REST. Covers the documents gh and github-mcp-server
// send: viewer, repository fields/issues/pullRequests, node(id:), the five
// mutations, batched operations, and __type/__schema introspection.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Forge, RepoRec, IssueRec, PullRec } from './store.ts';
import { branchTip } from './store.ts';
import { computePrFiles, performMerge } from './rest.ts';
import { nextTimestamp, globalId, parseGlobalId } from './util.ts';
import { sendJson, readBody } from './http.ts';

// ---------------------------------------------------------------------------
// Lexer / parser

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; values: Value[] }
  | { kind: 'object'; fields: Map<string, Value> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Map<string, Value>;
  directives: Map<string, Map<string, Value>>;
  selectionSet: SelectionNode[] | null;
}
type SelectionNode =
  | FieldNode
  | { kind: 'spread'; name: string; directives: Map<string, Map<string, Value>> }
  | { kind: 'inline'; typeCondition: string | null; directives: Map<string, Map<string, Value>>; selectionSet: SelectionNode[] };

interface OperationNode {
  operation: 'query' | 'mutation';
  name: string | null;
  selectionSet: SelectionNode[];
}
interface FragmentNode {
  typeCondition: string;
  selectionSet: SelectionNode[];
}
interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

function tokenize(src: string): Array<{ t: string; v: string }> {
  const tokens: Array<{ t: string; v: string }> = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (/\s|,/.test(c)) {
      i += 1;
      continue;
    }
    if (src.startsWith('...', i)) {
      tokens.push({ t: '...', v: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(c)) {
      tokens.push({ t: c, v: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (src.startsWith('"""', i)) {
        const end = src.indexOf('"""', i + 3);
        tokens.push({ t: 'string', v: src.slice(i + 3, end < 0 ? src.length : end) });
        i = end < 0 ? src.length : end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1] as string;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      tokens.push({ t: 'string', v: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.eE+-]/.test(src[j] as string)) j += 1;
      const text = src.slice(i, j);
      tokens.push({ t: /[.eE]/.test(text) ? 'float' : 'int', v: text });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(c)) {
      let j = i;
      while (j < src.length && /[_0-9A-Za-z]/.test(src[j] as string)) j += 1;
      tokens.push({ t: 'name', v: src.slice(i, j) });
      i = j;
      continue;
    }
    i += 1;
  }
  tokens.push({ t: 'eof', v: '' });
  return tokens;
}

class Parser {
  private pos = 0;
  private tokens: Array<{ t: string; v: string }>;
  constructor(tokens: Array<{ t: string; v: string }>) {
    this.tokens = tokens;
  }

  private peek(): { t: string; v: string } {
    return this.tokens[this.pos] as { t: string; v: string };
  }
  private next(): { t: string; v: string } {
    const tok = this.tokens[this.pos] as { t: string; v: string };
    this.pos += 1;
    return tok;
  }
  private expect(t: string): string {
    const tok = this.next();
    if (tok.t !== t) throw new Error(`expected ${t}, got ${tok.t}`);
    return tok.v;
  }

  parseDocument(): DocumentNode {
    const doc: DocumentNode = { operations: [], fragments: new Map() };
    while (this.peek().t !== 'eof') {
      const tok = this.peek();
      if (tok.t === '{') {
        doc.operations.push({ operation: 'query', name: null, selectionSet: this.parseSelectionSet() });
      } else if (tok.t === 'name' && (tok.v === 'query' || tok.v === 'mutation' || tok.v === 'subscription')) {
        this.next();
        let name: string | null = null;
        if (this.peek().t === 'name') name = this.next().v;
        if (this.peek().t === '(') this.parseVariableDefinitions();
        this.parseDirectives();
        doc.operations.push({ operation: tok.v === 'mutation' ? 'mutation' : 'query', name, selectionSet: this.parseSelectionSet() });
      } else if (tok.t === 'name' && tok.v === 'fragment') {
        this.next();
        const name = this.expect('name');
        this.expect('name'); // 'on'
        const typeCondition = this.expect('name');
        this.parseDirectives();
        doc.fragments.set(name, { typeCondition, selectionSet: this.parseSelectionSet() });
      } else {
        this.next();
      }
    }
    return doc;
  }

  private parseVariableDefinitions(): void {
    this.expect('(');
    while (this.peek().t !== ')') {
      this.expect('$');
      this.expect('name');
      this.expect(':');
      this.parseType();
      if (this.peek().t === '=') {
        this.next();
        this.parseValue();
      }
      this.parseDirectives();
    }
    this.expect(')');
  }

  private parseType(): void {
    if (this.peek().t === '[') {
      this.next();
      this.parseType();
      this.expect(']');
    } else {
      this.expect('name');
    }
    if (this.peek().t === '!') this.next();
  }

  private parseDirectives(): Map<string, Map<string, Value>> {
    const directives = new Map<string, Map<string, Value>>();
    while (this.peek().t === '@') {
      this.next();
      const name = this.expect('name');
      const args = this.peek().t === '(' ? this.parseArguments() : new Map<string, Value>();
      directives.set(name, args);
    }
    return directives;
  }

  private parseArguments(): Map<string, Value> {
    const args = new Map<string, Value>();
    this.expect('(');
    while (this.peek().t !== ')') {
      const name = this.expect('name');
      this.expect(':');
      args.set(name, this.parseValue());
    }
    this.expect(')');
    return args;
  }

  private parseValue(): Value {
    const tok = this.next();
    if (tok.t === '$') return { kind: 'variable', name: this.expect('name') };
    if (tok.t === 'string') return { kind: 'string', value: tok.v };
    if (tok.t === 'int') return { kind: 'int', value: Number(tok.v) };
    if (tok.t === 'float') return { kind: 'float', value: Number(tok.v) };
    if (tok.t === 'name') {
      if (tok.v === 'true') return { kind: 'boolean', value: true };
      if (tok.v === 'false') return { kind: 'boolean', value: false };
      if (tok.v === 'null') return { kind: 'null' };
      return { kind: 'enum', value: tok.v };
    }
    if (tok.t === '[') {
      const values: Value[] = [];
      while (this.peek().t !== ']') values.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', values };
    }
    if (tok.t === '{') {
      const fields = new Map<string, Value>();
      while (this.peek().t !== '}') {
        const name = this.expect('name');
        this.expect(':');
        fields.set(name, this.parseValue());
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    throw new Error(`unexpected value token ${tok.t}`);
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (this.peek().t !== '}') {
      if (this.peek().t === '...') {
        this.next();
        if (this.peek().t === 'name' && this.peek().v === 'on') {
          this.next();
          const typeCondition = this.expect('name');
          const directives = this.parseDirectives();
          selections.push({ kind: 'inline', typeCondition, directives, selectionSet: this.parseSelectionSet() });
        } else if (this.peek().t === 'name') {
          const name = this.next().v;
          const directives = this.parseDirectives();
          selections.push({ kind: 'spread', name, directives });
        } else {
          const directives = this.parseDirectives();
          selections.push({ kind: 'inline', typeCondition: null, directives, selectionSet: this.parseSelectionSet() });
        }
        continue;
      }
      let name = this.expect('name');
      let alias: string | null = null;
      if (this.peek().t === ':') {
        this.next();
        alias = name;
        name = this.expect('name');
      }
      const args = this.peek().t === '(' ? this.parseArguments() : new Map<string, Value>();
      const directives = this.parseDirectives();
      const selectionSet = this.peek().t === '{' ? this.parseSelectionSet() : null;
      selections.push({ kind: 'field', alias, name, args, directives, selectionSet });
    }
    this.expect('}');
    return selections;
  }
}

// ---------------------------------------------------------------------------
// Schema (for introspection + field validation)

interface TypeRef {
  kind: string;
  name: string | null;
  ofType: TypeRef | null;
}
const named = (kind: string, name: string): TypeRef => ({ kind, name, ofType: null });
const nn = (of: TypeRef): TypeRef => ({ kind: 'NON_NULL', name: null, ofType: of });
const list = (of: TypeRef): TypeRef => ({ kind: 'LIST', name: null, ofType: of });
const S = (n: string) => named('SCALAR', n);
const O = (n: string) => named('OBJECT', n);
const E = (n: string) => named('ENUM', n);
const IN = (n: string) => named('INPUT_OBJECT', n);

interface FieldDef {
  type: TypeRef;
  args?: Record<string, TypeRef>;
}
interface TypeDef {
  kind: string;
  fields?: Record<string, FieldDef>;
  enumValues?: string[];
  inputFields?: Record<string, TypeRef>;
  possibleTypes?: string[];
}

const PAGE_ARGS = { first: S('Int'), after: S('String'), last: S('Int'), before: S('String') };
export const SCHEMA: Record<string, TypeDef> = {
  Query: {
    kind: 'OBJECT',
    fields: {
      viewer: { type: nn(O('User')) },
      repository: { type: O('Repository'), args: { owner: nn(S('String')), name: nn(S('String')) } },
      node: { type: O('Node'), args: { id: nn(S('ID')) } },
      search: { type: nn(O('SearchResultItemConnection')), args: { query: nn(S('String')), type: nn(E('SearchType')), first: S('Int'), after: S('String') } },
      rateLimit: { type: O('RateLimit') },
    },
  },
  Mutation: {
    kind: 'OBJECT',
    fields: {
      createIssue: { type: O('CreateIssuePayload'), args: { input: nn(IN('CreateIssueInput')) } },
      closeIssue: { type: O('CloseIssuePayload'), args: { input: nn(IN('CloseIssueInput')) } },
      reopenIssue: { type: O('ReopenIssuePayload'), args: { input: nn(IN('ReopenIssueInput')) } },
      createPullRequest: { type: O('CreatePullRequestPayload'), args: { input: nn(IN('CreatePullRequestInput')) } },
      mergePullRequest: { type: O('MergePullRequestPayload'), args: { input: nn(IN('MergePullRequestInput')) } },
      addComment: { type: O('AddCommentPayload'), args: { input: nn(IN('AddCommentInput')) } },
    },
  },
  User: {
    kind: 'OBJECT',
    fields: {
      id: { type: nn(S('ID')) },
      databaseId: { type: S('Int') },
      login: { type: nn(S('String')) },
      name: { type: S('String') },
      email: { type: S('String') },
      url: { type: nn(S('URI')) },
      avatarUrl: { type: nn(S('URI')) },
    },
  },
  Repository: {
    kind: 'OBJECT',
    fields: {
      id: { type: nn(S('ID')) },
      databaseId: { type: S('Int') },
      name: { type: nn(S('String')) },
      nameWithOwner: { type: nn(S('String')) },
      owner: { type: nn(O('User')) },
      description: { type: S('String') },
      isPrivate: { type: nn(S('Boolean')) },
      isFork: { type: nn(S('Boolean')) },
      isArchived: { type: nn(S('Boolean')) },
      url: { type: nn(S('URI')) },
      createdAt: { type: nn(S('DateTime')) },
      updatedAt: { type: nn(S('DateTime')) },
      pushedAt: { type: S('DateTime') },
      defaultBranchRef: { type: O('Ref') },
      viewerPermission: { type: E('RepositoryPermission') },
      hasIssuesEnabled: { type: nn(S('Boolean')) },
      hasPullRequestsEnabled: { type: nn(S('Boolean')) },
      hasWikiEnabled: { type: nn(S('Boolean')) },
      stargazerCount: { type: nn(S('Int')) },
      forkCount: { type: nn(S('Int')) },
      issues: { type: nn(O('IssueConnection')), args: { ...PAGE_ARGS, states: list(nn(E('IssueState'))), orderBy: IN('IssueOrder'), labels: list(nn(S('String'))) } },
      issue: { type: O('Issue'), args: { number: nn(S('Int')) } },
      pullRequests: { type: nn(O('PullRequestConnection')), args: { ...PAGE_ARGS, states: list(nn(E('PullRequestState'))), orderBy: IN('IssueOrder') } },
      pullRequest: { type: O('PullRequest'), args: { number: nn(S('Int')) } },
      labels: { type: O('LabelConnection'), args: { ...PAGE_ARGS } },
    },
  },
  Ref: {
    kind: 'OBJECT',
    fields: {
      name: { type: nn(S('String')) },
      prefix: { type: nn(S('String')) },
      target: { type: O('GitObject') },
    },
  },
  Commit: {
    kind: 'OBJECT',
    fields: {
      id: { type: nn(S('ID')) },
      oid: { type: nn(S('GitObjectID')) },
      message: { type: nn(S('String')) },
      committedDate: { type: nn(S('DateTime')) },
      author: { type: O('GitActor') },
      url: { type: nn(S('URI')) },
    },
  },
  GitActor: {
    kind: 'OBJECT',
    fields: {
      name: { type: S('String') },
      email: { type: S('String') },
      date: { type: S('DateTime') },
      user: { type: O('User') },
    },
  },
  Issue: {
    kind: 'OBJECT',
    fields: {
      id: { type: nn(S('ID')) },
      databaseId: { type: S('Int') },
      number: { type: nn(S('Int')) },
      title: { type: nn(S('String')) },
      body: { type: S('String') },
      state: { type: nn(E('IssueState')) },
      closed: { type: nn(S('Boolean')) },
      closedAt: { type: S('DateTime') },
      createdAt: { type: nn(S('DateTime')) },
      updatedAt: { type: nn(S('DateTime')) },
      author: { type: O('User') },
      labels: { type: O('LabelConnection'), args: { ...PAGE_ARGS } },
      comments: { type: nn(O('IssueCommentConnection')), args: { ...PAGE_ARGS } },
      repository: { type: nn(O('Repository')) },
      url: { type: nn(S('URI')) },
    },
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: {
      id: { type: nn(S('ID')) },
      databaseId: { type: S('Int') },
      number: { type: nn(S('Int')) },
      title: { type: nn(S('String')) },
      body: { type: S('String') },
      state: { type: nn(E('PullRequestState')) },
      merged: { type: nn(S('Boolean')) },
      mergedAt: { type: S('DateTime') },
      mergeCommit: { type: O('Commit') },
      headRefName: { type: nn(S('String')) },
      baseRefName: { type: nn(S('String')) },
      headRefOid: { type: nn(S('GitObjectID')) },
      baseRefOid: { type: nn(S('GitObjectID')) },
      author: { type: O('User') },
      createdAt: { type: nn(S('DateTime')) },
      updatedAt: { type: nn(S('DateTime')) },
      closedAt: { type: S('DateTime') },
      closed: { type: nn(S('Boolean')) },
      url: { type: nn(S('URI')) },
      repository: { type: nn(O('Repository')) },
      files: { type: O('PullRequestChangedFileConnection'), args: { ...PAGE_ARGS } },
      commits: { type: nn(O('PullRequestCommitConnection')), args: { ...PAGE_ARGS } },
      comments: { type: nn(O('IssueCommentConnection')), args: { ...PAGE_ARGS } },
      mergeable: { type: nn(E('MergeableState')) },
      additions: { type: nn(S('Int')) },
      deletions: { type: nn(S('Int')) },
      changedFiles: { type: nn(S('Int')) },
    },
  },
  Label: {
    kind: 'OBJECT',
    fields: {
      id: { type: nn(S('ID')) },
      name: { type: nn(S('String')) },
      color: { type: nn(S('String')) },
      description: { type: S('String') },
      url: { type: nn(S('URI')) },
    },
  },
  IssueComment: {
    kind: 'OBJECT',
    fields: {
      id: { type: nn(S('ID')) },
      databaseId: { type: S('Int') },
      body: { type: nn(S('String')) },
      author: { type: O('User') },
      createdAt: { type: nn(S('DateTime')) },
      updatedAt: { type: nn(S('DateTime')) },
      url: { type: nn(S('URI')) },
    },
  },
  PageInfo: {
    kind: 'OBJECT',
    fields: {
      hasNextPage: { type: nn(S('Boolean')) },
      hasPreviousPage: { type: nn(S('Boolean')) },
      startCursor: { type: S('String') },
      endCursor: { type: S('String') },
    },
  },
  RateLimit: {
    kind: 'OBJECT',
    fields: {
      limit: { type: nn(S('Int')) },
      cost: { type: nn(S('Int')) },
      remaining: { type: nn(S('Int')) },
      resetAt: { type: nn(S('DateTime')) },
      nodeCount: { type: nn(S('Int')) },
      used: { type: nn(S('Int')) },
    },
  },
  SearchResultItemConnection: {
    kind: 'OBJECT',
    fields: {
      codeCount: { type: nn(S('Int')) },
      issueCount: { type: nn(S('Int')) },
      repositoryCount: { type: nn(S('Int')) },
      userCount: { type: nn(S('Int')) },
      wikiCount: { type: nn(S('Int')) },
      nodes: { type: list(O('SearchResultItem')) },
      edges: { type: list(O('SearchResultItemEdge')) },
      pageInfo: { type: nn(O('PageInfo')) },
    },
  },
  Node: { kind: 'INTERFACE', possibleTypes: ['Repository', 'Issue', 'PullRequest', 'User', 'Label', 'IssueComment'], fields: { id: { type: nn(S('ID')) } } },
  GitObject: { kind: 'INTERFACE', possibleTypes: ['Commit'], fields: { id: { type: nn(S('ID')) }, oid: { type: nn(S('GitObjectID')) } } },
  SearchType: { kind: 'ENUM', enumValues: ['REPOSITORY', 'ISSUE', 'USER', 'DISCUSSION'] },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
  IssueOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  PullRequestMergeMethod: { kind: 'ENUM', enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  IssueOrder: { kind: 'INPUT_OBJECT', inputFields: { field: nn(E('IssueOrderField')), direction: nn(E('OrderDirection')) } },
  CreateIssueInput: { kind: 'INPUT_OBJECT', inputFields: { repositoryId: nn(S('ID')), title: nn(S('String')), body: S('String'), labelIds: list(nn(S('ID'))) } },
  CloseIssueInput: { kind: 'INPUT_OBJECT', inputFields: { issueId: nn(S('ID')) } },
  ReopenIssueInput: { kind: 'INPUT_OBJECT', inputFields: { issueId: nn(S('ID')) } },
  CreatePullRequestInput: { kind: 'INPUT_OBJECT', inputFields: { repositoryId: nn(S('ID')), baseRefName: nn(S('String')), headRefName: nn(S('String')), title: nn(S('String')), body: S('String') } },
  MergePullRequestInput: { kind: 'INPUT_OBJECT', inputFields: { pullRequestId: nn(S('ID')), mergeMethod: E('PullRequestMergeMethod') } },
  AddCommentInput: { kind: 'INPUT_OBJECT', inputFields: { subjectId: nn(S('ID')), body: nn(S('String')) } },
  CreateIssuePayload: { kind: 'OBJECT', fields: { issue: { type: O('Issue') }, clientMutationId: { type: S('String') } } },
  CloseIssuePayload: { kind: 'OBJECT', fields: { issue: { type: O('Issue') }, clientMutationId: { type: S('String') } } },
  ReopenIssuePayload: { kind: 'OBJECT', fields: { issue: { type: O('Issue') }, clientMutationId: { type: S('String') } } },
  CreatePullRequestPayload: { kind: 'OBJECT', fields: { pullRequest: { type: O('PullRequest') }, clientMutationId: { type: S('String') } } },
  MergePullRequestPayload: { kind: 'OBJECT', fields: { pullRequest: { type: O('PullRequest') }, clientMutationId: { type: S('String') } } },
  AddCommentPayload: { kind: 'OBJECT', fields: { commentEdge: { type: O('IssueCommentEdge') }, subject: { type: O('Node') }, clientMutationId: { type: S('String') } } },
};
// Connection types are synthesized for introspection completeness.
for (const [base, node] of [
  ['IssueConnection', 'Issue'],
  ['PullRequestConnection', 'PullRequest'],
  ['LabelConnection', 'Label'],
  ['IssueCommentConnection', 'IssueComment'],
  ['PullRequestChangedFileConnection', 'PullRequestChangedFile'],
  ['PullRequestCommitConnection', 'PullRequestCommit'],
] as const) {
  SCHEMA[base] = {
    kind: 'OBJECT',
    fields: {
      nodes: { type: list(O(node)) },
      edges: { type: list(O(`${node}Edge`)) },
      totalCount: { type: nn(S('Int')) },
      pageInfo: { type: nn(O('PageInfo')) },
    },
  };
  SCHEMA[`${node}Edge`] = {
    kind: 'OBJECT',
    fields: { node: { type: O(node) }, cursor: { type: nn(S('String')) } },
  };
}
SCHEMA['PullRequestChangedFile'] = {
  kind: 'OBJECT',
  fields: {
    path: { type: nn(S('String')) },
    additions: { type: nn(S('Int')) },
    deletions: { type: nn(S('Int')) },
    changeType: { type: nn(S('String')) },
  },
};
SCHEMA['PullRequestCommit'] = {
  kind: 'OBJECT',
  fields: { commit: { type: nn(O('Commit')) }, url: { type: nn(S('URI')) } },
};
SCHEMA['SearchResultItemEdge'] = { kind: 'OBJECT', fields: { node: { type: O('SearchResultItem') }, cursor: { type: nn(S('String')) }, textMatches: { type: list(O('TextMatch')) } } };
SCHEMA['TextMatch'] = { kind: 'OBJECT', fields: { fragment: { type: S('String') }, property: { type: S('String') } } };
for (const scalar of ['String', 'Int', 'Float', 'Boolean', 'ID', 'DateTime', 'URI', 'GitObjectID', 'GitTimestamp', 'HTML']) {
  SCHEMA[scalar] = { kind: 'SCALAR' };
}
// 'SearchType' in the GitHub schema is an enum; the suite's introspection only
// needs the type to exist under that name. Our Query.search arg references it
// as an enum (see SCHEMA.Query) — keep the object form above so __type lists
// fields too; either shape satisfies a presence check.

// ---------------------------------------------------------------------------
// Execution

type Obj = { $type: string; [k: string]: unknown };
const obj = (type: string, data: Record<string, unknown>): Obj => ({ $type: type, ...data });

interface Ctx {
  forge: Forge;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentNode>;
  errors: Array<{ message: string; path?: unknown[] }>;
}

function resolveValue(v: Value | undefined, ctx: Ctx): unknown {
  if (v === undefined) return undefined;
  switch (v.kind) {
    case 'variable':
      return ctx.variables[v.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return v.value;
    case 'null':
      return null;
    case 'list':
      return v.values.map((x) => resolveValue(x, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, val] of v.fields) out[k] = resolveValue(val, ctx);
      return out;
    }
  }
}

function argsOf(field: FieldNode, ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of field.args) out[k] = resolveValue(v, ctx);
  return out;
}

function cursorOf(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function pageSlice<T>(items: T[], args: Record<string, unknown>): { page: T[]; hasNext: boolean; startIdx: number } {
  let start = 0;
  const after = typeof args.after === 'string' ? args.after : null;
  if (after) {
    try {
      const text = Buffer.from(after, 'base64').toString('utf8');
      const m = /^cursor:(\d+)$/.exec(text);
      if (m) start = Number(m[1]);
    } catch {
      /* ignore bad cursor */
    }
  }
  const first = typeof args.first === 'number' ? args.first : items.length;
  const page = items.slice(start, start + Math.max(0, first));
  return { page, hasNext: start + page.length < items.length, startIdx: start };
}

function connection(type: string, items: Obj[], args: Record<string, unknown>): Obj {
  const { page, hasNext, startIdx } = pageSlice(items, args);
  return obj(type, {
    $all: items,
    $page: page,
    $hasNext: hasNext,
    $startIdx: startIdx,
    $total: items.length,
  });
}

function userObj(forge: Forge): Obj {
  return obj('User', { login: forge.viewerLogin });
}

function repoObj(rec: RepoRec): Obj {
  return obj('Repository', { rec });
}

function issueObj(rec: RepoRec, issue: IssueRec): Obj {
  return obj('Issue', { rec, issue });
}

function pullObj(rec: RepoRec, pull: PullRec): Obj {
  return obj('PullRequest', { rec, pull });
}

function findRepoById(forge: Forge, dbId: number): RepoRec | null {
  for (const rec of forge.repos.values()) if (rec.id === dbId) return rec;
  return null;
}

function findIssueById(forge: Forge, dbId: number): { rec: RepoRec; issue: IssueRec } | null {
  for (const rec of forge.repos.values()) {
    const issue = rec.issues.find((i) => i.id === dbId);
    if (issue) return { rec, issue };
  }
  return null;
}

function findPullById(forge: Forge, dbId: number): { rec: RepoRec; pull: PullRec } | null {
  for (const rec of forge.repos.values()) {
    const pull = rec.pulls.find((p) => p.id === dbId);
    if (pull) return { rec, pull };
  }
  return null;
}

function resolveNode(forge: Forge, id: string): Obj | null {
  const parsed = parseGlobalId(id);
  if (!parsed) return null;
  if (parsed.type === 'Repository') {
    const rec = findRepoById(forge, parsed.dbId);
    return rec ? repoObj(rec) : null;
  }
  if (parsed.type === 'Issue') {
    const found = findIssueById(forge, parsed.dbId);
    return found ? issueObj(found.rec, found.issue) : null;
  }
  if (parsed.type === 'PullRequest') {
    const found = findPullById(forge, parsed.dbId);
    return found ? pullObj(found.rec, found.pull) : null;
  }
  if (parsed.type === 'User') return userObj(forge);
  return null;
}

// Field resolution. Returns a raw value (scalar, Obj, Obj[], or null).
function resolveField(ctx: Ctx, source: Obj, field: FieldNode): unknown {
  const { forge } = ctx;
  const args = argsOf(field, ctx);
  const type = source.$type;
  const name = field.name;

  if (name === '__typename') return type;
  if (type === 'Query') {
    if (name === 'viewer') return userObj(forge);
    if (name === 'repository') {
      const owner = String(args.owner ?? '');
      const repoName = String(args.name ?? '');
      if (owner !== forge.viewerLogin) return null;
      const rec = forge.getRepo(owner, repoName);
      return rec ? repoObj(rec) : null;
    }
    if (name === 'node') return resolveNode(forge, String(args.id ?? ''));
    if (name === 'search') return obj('SearchResultItemConnection', { $all: [], $page: [], $hasNext: false, $startIdx: 0, $total: 0 });
    if (name === 'rateLimit') return obj('RateLimit', {});
    if (name === '__type') return typeIntro(String(args.name ?? ''));
    if (name === '__schema') return schemaIntro();
  }
  if (type === 'Mutation') return resolveMutation(ctx, source, field);

  if (type === 'User') {
    if (name === 'id') return globalId('User', 1000);
    if (name === 'databaseId') return 1000;
    if (name === 'login') return source.login ?? forge.viewerLogin;
    if (name === 'name') return 'ada iversen';
    if (name === 'email') return `${String(source.login ?? forge.viewerLogin)}@example.invalid`;
    if (name === 'url' || name === 'avatarUrl') return `https://example.invalid/${String(source.login ?? forge.viewerLogin)}`;
  }

  if (type === 'Repository') {
    const rec = source.rec as RepoRec;
    switch (name) {
      case 'id':
        return globalId('Repository', rec.id);
      case 'databaseId':
        return rec.id;
      case 'name':
        return rec.name;
      case 'nameWithOwner':
        return `${rec.owner}/${rec.name}`;
      case 'owner':
        return userObj(forge);
      case 'description':
        return rec.description;
      case 'isPrivate':
        return rec.private;
      case 'isFork':
      case 'isArchived':
      case 'hasWikiEnabled':
        return false;
      case 'hasIssuesEnabled':
      case 'hasPullRequestsEnabled':
        return true;
      case 'url':
        return `https://example.invalid/${rec.owner}/${rec.name}`;
      case 'createdAt':
        return rec.createdAt;
      case 'updatedAt':
      case 'pushedAt':
        return rec.updatedAt;
      case 'viewerPermission':
        return 'ADMIN';
      case 'stargazerCount':
      case 'forkCount':
        return 0;
      case 'defaultBranchRef': {
        const tip = branchTip(rec, rec.defaultBranch);
        return obj('Ref', { name: rec.defaultBranch, tip });
      }
      case 'issues': {
        const states = Array.isArray(args.states) ? (args.states as string[]) : ['OPEN'];
        let items = rec.issues.filter((i) => states.includes(i.state.toUpperCase()));
        const orderBy = (args.orderBy as Record<string, unknown> | undefined) ?? {};
        const direction = String(orderBy.direction ?? 'DESC').toUpperCase();
        items = [...items].sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
        return connection('IssueConnection', items.map((i) => issueObj(rec, i)), args);
      }
      case 'issue': {
        const issue = rec.issues.find((i) => i.number === Number(args.number));
        return issue ? issueObj(rec, issue) : null;
      }
      case 'pullRequests': {
        const states = Array.isArray(args.states) ? (args.states as string[]) : ['OPEN'];
        let items = rec.pulls.filter((p) => states.includes(p.merged ? 'MERGED' : p.state.toUpperCase()));
        const orderBy = (args.orderBy as Record<string, unknown> | undefined) ?? {};
        const direction = String(orderBy.direction ?? 'DESC').toUpperCase();
        items = [...items].sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
        return connection('PullRequestConnection', items.map((p) => pullObj(rec, p)), args);
      }
      case 'pullRequest': {
        const pull = rec.pulls.find((p) => p.number === Number(args.number));
        return pull ? pullObj(rec, pull) : null;
      }
      case 'labels': {
        const items = [...rec.labels.values()].map((l) => obj('Label', { rec, label: l }));
        return connection('LabelConnection', items, args);
      }
    }
  }

  if (type === 'Ref') {
    if (name === 'name') return source.name;
    if (name === 'prefix') return 'refs/heads/';
    if (name === 'target') {
      const tip = source.tip as string | null;
      return tip ? obj('Commit', { oid: tip }) : null;
    }
  }

  if (type === 'Commit') {
    if (name === 'id') return globalId('Commit', 1);
    if (name === 'oid') return source.oid;
    if (name === 'message') return '';
    if (name === 'committedDate') return new Date(0).toISOString();
    if (name === 'author') return obj('GitActor', {});
    if (name === 'url') return 'https://example.invalid/commit';
  }
  if (type === 'GitActor') {
    if (name === 'name') return 'Forge';
    if (name === 'email') return 'forge@example.invalid';
    if (name === 'date') return new Date(0).toISOString();
    if (name === 'user') return userObj(forge);
  }

  if (type === 'Issue') {
    const rec = source.rec as RepoRec;
    const issue = source.issue as IssueRec;
    switch (name) {
      case 'id':
        return globalId('Issue', issue.id);
      case 'databaseId':
        return issue.id;
      case 'number':
        return issue.number;
      case 'title':
        return issue.title;
      case 'body':
        return issue.body;
      case 'state':
        return issue.state.toUpperCase();
      case 'closed':
        return issue.state === 'closed';
      case 'closedAt':
        return issue.state === 'closed' ? issue.updatedAt : null;
      case 'createdAt':
        return issue.createdAt;
      case 'updatedAt':
        return issue.updatedAt;
      case 'author':
        return userObj(forge);
      case 'repository':
        return repoObj(rec);
      case 'url':
        return `https://example.invalid/${rec.owner}/${rec.name}/issues/${issue.number}`;
      case 'labels': {
        const items = issue.labels
          .map((labelName) => rec.labels.get(labelName))
          .filter((l) => l !== undefined)
          .map((l) => obj('Label', { rec, label: l }));
        return connection('LabelConnection', items, args);
      }
      case 'comments': {
        const items = issue.comments.map((c) => obj('IssueComment', { rec, comment: c, number: issue.number }));
        return connection('IssueCommentConnection', items, args);
      }
    }
  }

  if (type === 'PullRequest') {
    const rec = source.rec as RepoRec;
    const pull = source.pull as PullRec;
    switch (name) {
      case 'id':
        return globalId('PullRequest', pull.id);
      case 'databaseId':
        return pull.id;
      case 'number':
        return pull.number;
      case 'title':
        return pull.title;
      case 'body':
        return pull.body;
      case 'state':
        return pull.merged ? 'MERGED' : pull.state.toUpperCase();
      case 'merged':
        return pull.merged;
      case 'mergedAt':
        return pull.mergedAt;
      case 'mergeCommit':
        return pull.mergeCommitSha ? obj('Commit', { oid: pull.mergeCommitSha }) : null;
      case 'headRefName':
        return pull.headRef;
      case 'baseRefName':
        return pull.baseRef;
      case 'headRefOid':
        return pull.headSha;
      case 'baseRefOid':
        return branchTip(rec, pull.baseRef) ?? pull.baseSha;
      case 'author':
        return userObj(forge);
      case 'createdAt':
        return pull.createdAt;
      case 'updatedAt':
        return pull.updatedAt;
      case 'closedAt':
        return pull.state === 'closed' ? pull.updatedAt : null;
      case 'closed':
        return pull.state === 'closed';
      case 'url':
        return `https://example.invalid/${rec.owner}/${rec.name}/pull/${pull.number}`;
      case 'repository':
        return repoObj(rec);
      case 'files': {
        const { files } = computePrFiles(rec, pull);
        const items = files.map((f) =>
          obj('PullRequestChangedFile', {
            path: f.filename,
            additions: f.additions,
            deletions: f.deletions,
            changeType: String(f.status).toUpperCase(),
          }),
        );
        return connection('PullRequestChangedFileConnection', items, args);
      }
      case 'commits': {
        const items = [obj('PullRequestCommit', { oid: pull.headSha })];
        return connection('PullRequestCommitConnection', items, args);
      }
      case 'comments': {
        const items = pull.comments.map((c) => obj('IssueComment', { rec, comment: c, number: pull.number }));
        return connection('IssueCommentConnection', items, args);
      }
      case 'mergeable': {
        if (pull.merged) return 'MERGEABLE';
        const { mergeable } = computePrFiles(rec, pull);
        return mergeable ? 'MERGEABLE' : 'CONFLICTING';
      }
      case 'additions':
      case 'deletions':
      case 'changedFiles': {
        const { files } = computePrFiles(rec, pull);
        if (name === 'changedFiles') return files.length;
        return files.reduce((sum, f) => sum + (name === 'additions' ? (f.additions as number) : (f.deletions as number)), 0);
      }
    }
  }

  if (type === 'Label') {
    const label = source.label as { id: number; name: string; color: string; description: string };
    if (name === 'id') return globalId('Label', label.id);
    if (name === 'name') return label.name;
    if (name === 'color') return label.color;
    if (name === 'description') return label.description;
    if (name === 'url') return '';
  }

  if (type === 'IssueComment') {
    const comment = source.comment as { id: number; body: string; createdAt: string; updatedAt: string };
    if (name === 'id') return globalId('IssueComment', comment.id);
    if (name === 'databaseId') return comment.id;
    if (name === 'body') return comment.body;
    if (name === 'author') return userObj(forge);
    if (name === 'createdAt') return comment.createdAt;
    if (name === 'updatedAt') return comment.updatedAt;
    if (name === 'url') return '';
  }

  if (type === 'PullRequestChangedFile') {
    if (name === 'path') return source.path;
    if (name === 'additions') return source.additions;
    if (name === 'deletions') return source.deletions;
    if (name === 'changeType') return source.changeType;
  }
  if (type === 'PullRequestCommit') {
    if (name === 'commit') return obj('Commit', { oid: source.oid });
    if (name === 'url') return '';
  }

  if (type === 'RateLimit') {
    if (name === 'limit') return 5000;
    if (name === 'cost') return 1;
    if (name === 'remaining') return 5000;
    if (name === 'used') return 0;
    if (name === 'nodeCount') return 0;
    if (name === 'resetAt') return new Date(Date.now() + 3600_000).toISOString();
  }

  if (type.endsWith('Payload')) {
    if (name === 'clientMutationId') return null;
    if (name === 'issue') return source.issue ?? null;
    if (name === 'pullRequest') return source.pullRequest ?? null;
    if (name === 'commentEdge') return source.commentEdge ?? null;
    if (name === 'subject') return source.subject ?? null;
  }

  // Connections: nodes / edges / totalCount / pageInfo over the sliced page.
  if (type.endsWith('Connection')) {
    const page = (source.$page as Obj[]) ?? [];
    const startIdx = (source.$startIdx as number) ?? 0;
    if (name === 'nodes') return page;
    if (name === 'totalCount' || name === 'codeCount' || name === 'issueCount' || name === 'repositoryCount' || name === 'userCount' || name === 'wikiCount') {
      return (source.$total as number) ?? page.length;
    }
    if (name === 'edges') {
      const edgeType = `${type.replace(/Connection$/, '')}Edge`;
      return page.map((node, i) => obj(edgeType === 'PullRequestChangedFileEdge' ? 'PullRequestChangedFileEdge' : edgeType, { node, cursor: cursorOf(startIdx + i + 1) }));
    }
    if (name === 'pageInfo') {
      return obj('PageInfo', {
        hasNextPage: (source.$hasNext as boolean) ?? false,
        hasPreviousPage: startIdx > 0,
        startCursor: page.length ? cursorOf(startIdx + 1) : null,
        endCursor: page.length ? cursorOf(startIdx + page.length) : null,
      });
    }
  }
  if (type.endsWith('Edge')) {
    if (name === 'node') return source.node ?? null;
    if (name === 'cursor') return source.cursor ?? null;
  }
  if (type === 'PageInfo') {
    if (name in source) return source[name];
    return null;
  }
  return null;
}

function resolveMutation(ctx: Ctx, _source: Obj, field: FieldNode): unknown {
  const { forge } = ctx;
  const args = argsOf(field, ctx);
  const input = (args.input as Record<string, unknown> | undefined) ?? {};
  const name = field.name;

  if (name === 'createIssue') {
    const repoRef = parseGlobalId(String(input.repositoryId ?? ''));
    const rec = repoRef ? findRepoById(forge, repoRef.dbId) : null;
    if (!rec) return obj('CreateIssuePayload', { issue: null });
    const labels: string[] = [];
    if (Array.isArray(input.labelIds)) {
      for (const raw of input.labelIds) {
        const parsed = parseGlobalId(String(raw));
        if (!parsed) continue;
        for (const label of rec.labels.values()) if (label.id === parsed.dbId) labels.push(label.name);
      }
    }
    const ts = nextTimestamp().iso;
    const issue: IssueRec = {
      id: forge.allocIssueId(),
      number: rec.nextNumber++,
      title: String(input.title ?? ''),
      body: String(input.body ?? ''),
      state: 'open',
      labels,
      user: forge.viewerLogin,
      createdAt: ts,
      updatedAt: ts,
      comments: [],
    };
    rec.issues.push(issue);
    forge.touchRepo(rec);
    return obj('CreateIssuePayload', { issue: issueObj(rec, issue) });
  }

  if (name === 'closeIssue' || name === 'reopenIssue') {
    const ref = parseGlobalId(String(input.issueId ?? ''));
    const found = ref ? findIssueById(forge, ref.dbId) : null;
    const payloadType = name === 'closeIssue' ? 'CloseIssuePayload' : 'ReopenIssuePayload';
    if (!found) return obj(payloadType, { issue: null });
    found.issue.state = name === 'closeIssue' ? 'closed' : 'open';
    found.issue.updatedAt = nextTimestamp().iso;
    forge.touchRepo(found.rec);
    return obj(payloadType, { issue: issueObj(found.rec, found.issue) });
  }

  if (name === 'createPullRequest') {
    const repoRef = parseGlobalId(String(input.repositoryId ?? ''));
    const rec = repoRef ? findRepoById(forge, repoRef.dbId) : null;
    if (!rec) return obj('CreatePullRequestPayload', { pullRequest: null });
    const headRef = String(input.headRefName ?? '');
    const baseRef = String(input.baseRefName ?? rec.defaultBranch);
    const headSha = branchTip(rec, headRef);
    const baseSha = branchTip(rec, baseRef);
    if (!headSha || !baseSha) return obj('CreatePullRequestPayload', { pullRequest: null });
    const ts = nextTimestamp().iso;
    const pull: PullRec = {
      id: forge.allocIssueId(),
      number: rec.nextNumber++,
      title: String(input.title ?? ''),
      body: String(input.body ?? ''),
      state: 'open',
      headRef,
      headSha,
      baseRef,
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
    return obj('CreatePullRequestPayload', { pullRequest: pullObj(rec, pull) });
  }

  if (name === 'mergePullRequest') {
    const ref = parseGlobalId(String(input.pullRequestId ?? ''));
    const found = ref ? findPullById(forge, ref.dbId) : null;
    if (!found) return obj('MergePullRequestPayload', { pullRequest: null });
    const method = String(input.mergeMethod ?? 'MERGE').toLowerCase();
    performMerge(found.rec, found.pull, method === 'squash' ? 'squash' : 'merge');
    forge.touchRepo(found.rec);
    return obj('MergePullRequestPayload', { pullRequest: pullObj(found.rec, found.pull) });
  }

  if (name === 'addComment') {
    const ref = parseGlobalId(String(input.subjectId ?? ''));
    if (!ref) return obj('AddCommentPayload', { commentEdge: null });
    const ts = nextTimestamp().iso;
    const comment = { id: forge.allocCommentId(), body: String(input.body ?? ''), user: forge.viewerLogin, createdAt: ts, updatedAt: ts };
    if (ref.type === 'Issue') {
      const found = findIssueById(forge, ref.dbId);
      if (!found) return obj('AddCommentPayload', { commentEdge: null });
      found.issue.comments.push(comment);
      forge.touchRepo(found.rec);
      const node = obj('IssueComment', { rec: found.rec, comment, number: found.issue.number });
      return obj('AddCommentPayload', { commentEdge: obj('IssueCommentEdge', { node, cursor: cursorOf(1) }), subject: issueObj(found.rec, found.issue) });
    }
    if (ref.type === 'PullRequest') {
      const found = findPullById(forge, ref.dbId);
      if (!found) return obj('AddCommentPayload', { commentEdge: null });
      found.pull.comments.push(comment);
      forge.touchRepo(found.rec);
      const node = obj('IssueComment', { rec: found.rec, comment, number: found.pull.number });
      return obj('AddCommentPayload', { commentEdge: obj('IssueCommentEdge', { node, cursor: cursorOf(1) }), subject: pullObj(found.rec, found.pull) });
    }
    return obj('AddCommentPayload', { commentEdge: null });
  }

  return null;
}

// ---------------------------------------------------------------------------
// Introspection payloads

function typeRefIntro(ref: TypeRef): Record<string, unknown> {
  return { kind: ref.kind, name: ref.name, ofType: ref.ofType ? typeRefIntro(ref.ofType) : null };
}

function typeIntro(name: string): Obj | null {
  const def = SCHEMA[name];
  if (!def) return null;
  const fields = def.fields
    ? Object.entries(def.fields).map(([fieldName, fieldDef]) => ({
        name: fieldName,
        description: null,
        args: Object.entries(fieldDef.args ?? {}).map(([argName, argType]) => ({ name: argName, description: null, type: typeRefIntro(argType), defaultValue: null })),
        type: typeRefIntro(fieldDef.type),
        isDeprecated: false,
        deprecationReason: null,
      }))
    : null;
  return obj('__Type', {
    kind: def.kind,
    name,
    description: null,
    fields,
    inputFields: def.inputFields
      ? Object.entries(def.inputFields).map(([fieldName, fieldType]) => ({ name: fieldName, description: null, type: typeRefIntro(fieldType), defaultValue: null }))
      : null,
    interfaces: [],
    enumValues: def.enumValues ? def.enumValues.map((v) => ({ name: v, description: null, isDeprecated: false, deprecationReason: null })) : null,
    possibleTypes: def.possibleTypes ? def.possibleTypes.map((t) => ({ kind: SCHEMA[t]?.kind ?? 'OBJECT', name: t })) : null,
  });
}

function schemaIntro(): Obj {
  return obj('__Schema', {
    types: Object.keys(SCHEMA).map((name) => typeIntro(name)),
    queryType: { name: 'Query' },
    mutationType: { name: 'Mutation' },
    subscriptionType: null,
    directives: [],
  });
}

// ---------------------------------------------------------------------------
// Selection execution

function typeConditionMatches(condition: string | null, actual: string): boolean {
  if (!condition) return true;
  if (condition === actual) return true;
  const def = SCHEMA[condition];
  if (def?.possibleTypes?.includes(actual)) return true;
  return false;
}

function executeSelectionSet(ctx: Ctx, source: Obj, selections: SelectionNode[], path: unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const typeDef = SCHEMA[source.$type];
  const visit = (sels: SelectionNode[], currentPath: unknown[]) => {
    for (const sel of sels) {
      if (sel.kind === 'spread') {
        if (!directivesAllow(ctx, sel.directives)) continue;
        const fragment = ctx.fragments.get(sel.name);
        if (fragment && typeConditionMatches(fragment.typeCondition, source.$type)) visit(fragment.selectionSet, currentPath);
        continue;
      }
      if (sel.kind === 'inline') {
        if (!directivesAllow(ctx, sel.directives)) continue;
        if (typeConditionMatches(sel.typeCondition, source.$type)) visit(sel.selectionSet, currentPath);
        continue;
      }
      if (!directivesAllow(ctx, sel.directives)) continue;
      const key = sel.alias ?? sel.name;
      const fieldPath = [...currentPath, key];
      // Introspection roots are valid on Query even though not in SCHEMA.Query.fields.
      const isIntro = sel.name === '__type' || sel.name === '__schema' || sel.name === '__typename';
      if (!isIntro && typeDef && typeDef.fields && !(sel.name in typeDef.fields)) {
        ctx.errors.push({ message: `Field '${sel.name}' doesn't exist on type '${source.$type}'`, path: fieldPath });
        out[key] = null;
        continue;
      }
      const raw = sel.name === '__schema' ? schemaIntro() : sel.name === '__type' ? typeIntro(String(argsOf(sel, ctx).name ?? '')) : resolveField(ctx, source, sel);
      out[key] = completeValue(ctx, raw, sel, fieldPath);
    }
  };
  visit(selections, path);
  return out;
}

function directivesAllow(ctx: Ctx, directives: Map<string, Map<string, Value>>): boolean {
  for (const [name, args] of directives) {
    if (name === 'include') {
      const cond = resolveValue(args.get('if'), ctx);
      if (cond !== true) return false;
    }
    if (name === 'skip') {
      const cond = resolveValue(args.get('if'), ctx);
      if (cond === true) return false;
    }
  }
  return true;
}

function completeValue(ctx: Ctx, raw: unknown, field: FieldNode, path: unknown[]): unknown {
  if (raw === null || raw === undefined) return null;
  if (Array.isArray(raw)) return raw.map((item, i) => completeValue(ctx, item, field, [...path, i]));
  if (typeof raw === 'object' && raw !== null && '$type' in (raw as Record<string, unknown>)) {
    const source = raw as Obj;
    if (!field.selectionSet) return source;
    if (source.$type === '__Type') return executeIntroType(ctx, source, field.selectionSet, path);
    if (source.$type === '__Schema') return executeIntroSchema(ctx, source, field.selectionSet, path);
    return executeSelectionSet(ctx, source, field.selectionSet, path);
  }
  return raw;
}

// Introspection objects are plain data maps; select subfields directly.
function executeIntroType(ctx: Ctx, source: Obj, selections: SelectionNode[], path: unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind !== 'field') continue;
    const key = sel.alias ?? sel.name;
    if (sel.name === '__typename') {
      out[key] = '__Type';
      continue;
    }
    const value = (source as Record<string, unknown>)[sel.name];
    if (sel.selectionSet && Array.isArray(value)) {
      out[key] = value.map((item) => executeIntroGeneric(ctx, item as Record<string, unknown>, sel.selectionSet as SelectionNode[]));
    } else if (sel.selectionSet && value !== null && typeof value === 'object') {
      out[key] = executeIntroGeneric(ctx, value as Record<string, unknown>, sel.selectionSet);
    } else {
      out[key] = value ?? null;
    }
  }
  return out;
}

function executeIntroSchema(ctx: Ctx, source: Obj, selections: SelectionNode[], path: unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind !== 'field') continue;
    const key = sel.alias ?? sel.name;
    if (sel.name === '__typename') {
      out[key] = '__Schema';
      continue;
    }
    const value = (source as Record<string, unknown>)[sel.name];
    if (sel.name === 'types' && Array.isArray(value)) {
      out[key] = value.map((t) => executeIntroType(ctx, t as Obj, sel.selectionSet ?? [], path));
    } else if (sel.selectionSet && value !== null && typeof value === 'object') {
      out[key] = executeIntroGeneric(ctx, value as Record<string, unknown>, sel.selectionSet);
    } else {
      out[key] = value ?? null;
    }
  }
  return out;
}

function executeIntroGeneric(ctx: Ctx, data: Record<string, unknown>, selections: SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind !== 'field') continue;
    const key = sel.alias ?? sel.name;
    const value = data[sel.name];
    if (sel.selectionSet && Array.isArray(value)) {
      out[key] = value.map((item) => (item !== null && typeof item === 'object' ? executeIntroGeneric(ctx, item as Record<string, unknown>, sel.selectionSet as SelectionNode[]) : item));
    } else if (sel.selectionSet && value !== null && typeof value === 'object') {
      out[key] = executeIntroGeneric(ctx, value as Record<string, unknown>, sel.selectionSet);
    } else {
      out[key] = value ?? null;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry point

interface GraphqlRequest {
  query?: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}

function runOne(forge: Forge, request: GraphqlRequest): Record<string, unknown> {
  const ctx: Ctx = { forge, variables: request.variables ?? {}, fragments: new Map(), errors: [] };
  let doc: DocumentNode;
  try {
    doc = new Parser(tokenize(String(request.query ?? ''))).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
  }
  ctx.fragments = doc.fragments;
  let operation: OperationNode | undefined;
  if (request.operationName) operation = doc.operations.find((o) => o.name === request.operationName);
  if (!operation) operation = doc.operations[0];
  if (!operation) return { errors: [{ message: 'no operation in document' }] };
  const root = obj(operation.operation === 'mutation' ? 'Mutation' : 'Query', {});
  const data = executeSelectionSet(ctx, root, operation.selectionSet, []);
  const out: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) out.errors = ctx.errors;
  return out;
}

export async function handleGraphql(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return;
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((item) => runOne(forge, (item ?? {}) as GraphqlRequest));
    sendJson(res, 200, results);
    return;
  }
  sendJson(res, 200, runOne(forge, (parsed ?? {}) as GraphqlRequest));
}
