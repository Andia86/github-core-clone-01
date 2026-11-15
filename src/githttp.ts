// Git smart HTTP: info/refs advertisement (v2 for upload-pack, v0 for
// receive-pack), protocol v2 ls-refs/fetch, protocol v0 receive-pack.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Forge, RepoRec } from './store.ts';
import {
  commitInfo,
  walkCommits,
  objectClosure,
  writePack,
  readPack,
  peelToCommit,
  peelOne,
  parseTag,
  isAncestor,
  type GitObj,
} from './gitobj.ts';
import { pktText, pktLine, PKT_FLUSH, PKT_DELIM, parsePktLines, pktSectionEnd, sidebandPack, sidebandPacket, ZERO_OID, isOid, sha1Hex } from './util.ts';
import { sendBuffer, readBody, notFound } from './http.ts';

const UPLOAD_TYPE = 'application/x-git-upload-pack-advertisement';
const RECEIVE_TYPE = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';
const RECEIVE_CAPS = 'report-status delete-refs side-band-64k ofs-delta agent=forge/1.0';

function sortedRefs(rec: RepoRec): Array<[string, string]> {
  return [...rec.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

function headOid(rec: RepoRec): string {
  const oid = rec.refs.get(`refs/heads/${rec.defaultBranch}`);
  return oid ?? ZERO_OID;
}

/** v0-style ref advertisement lines (used for receive-pack and for upload-pack without v2). */
function v0Advertisement(rec: RepoRec, capabilities: string): Buffer {
  const parts: Buffer[] = [];
  const refs = sortedRefs(rec);
  let first = true;
  const line = (oid: string, name: string) => {
    if (first) {
      parts.push(pktLine(Buffer.from(`${oid} ${name}\0${capabilities}\n`, 'utf8')));
      first = false;
    } else {
      parts.push(pktText(`${oid} ${name}`));
    }
  };
  line(headOid(rec), 'HEAD');
  for (const [name, oid] of refs) {
    line(oid, name);
    const peeled = peelOne(rec.store, oid);
    if (peeled) line(peeled, `${name}^{}`);
  }
  if (first) {
    // No HEAD line was emitted (cannot happen: HEAD is always emitted).
    parts.push(pktLine(Buffer.from(`${ZERO_OID} capabilities^{}\0${capabilities}\n`, 'utf8')));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  const parts: Buffer[] = [
    pktText('version 2'),
    pktText('agent=forge/1.0'),
    pktText('ls-refs=unborn'),
    pktText('fetch=shallow wait-for-done'),
    pktText('object-format=sha1'),
    PKT_FLUSH,
  ];
  return Buffer.concat(parts);
}

function infoRefs(forge: Forge, req: IncomingMessage, res: ServerResponse, rec: RepoRec, service: string): void {
  if (service === 'git-upload-pack') {
    const wantsV2 = (req.headers['git-protocol'] ?? '').toString().includes('version=2');
    const preamble = Buffer.concat([pktText('# service=git-upload-pack'), PKT_FLUSH]);
    const body = wantsV2 ? v2Advertisement() : v0Advertisement(rec, 'multi_ack_detailed no-done side-band-64k thin-pack ofs-delta deepen-since deepen-not');
    sendBuffer(res, 200, Buffer.concat([preamble, body]), UPLOAD_TYPE);
    return;
  }
  if (service === 'git-receive-pack') {
    const preamble = Buffer.concat([pktText('# service=git-receive-pack'), PKT_FLUSH]);
    sendBuffer(res, 200, Buffer.concat([preamble, v0Advertisement(rec, RECEIVE_CAPS)]), RECEIVE_TYPE);
    return;
  }
  notFound(res);
}

// --- ls-refs -------------------------------------------------------------------

function lsRefs(rec: RepoRec, packets: ReturnType<typeof parsePktLines>): Buffer {
  let peel = false;
  let symrefs = false;
  const prefixes: string[] = [];
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((pre) => name.startsWith(pre));
  const parts: Buffer[] = [];
  const head = headOid(rec);
  if (matches('HEAD')) {
    let line = `${head} HEAD`;
    if (symrefs) line += ` symref-target:refs/heads/${rec.defaultBranch}`;
    if (head === ZERO_OID && symrefs) line += ' unborn';
    parts.push(pktText(line));
  }
  for (const [name, oid] of sortedRefs(rec)) {
    if (!matches(name)) continue;
    let line = `${oid} ${name}`;
    if (peel) {
      const peeled = peelOne(rec.store, oid);
      if (peeled) line += ` peeled:${peeled}`;
    }
    parts.push(pktText(line));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// --- fetch -----------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  wantRefs: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
  deepenSince: number | null;
  deepenNot: string[];
  done: boolean;
  waitForDone: boolean;
}

function parseFetchArgs(packets: ReturnType<typeof parsePktLines>): FetchArgs {
  const args: FetchArgs = { wants: [], wantRefs: [], haves: [], shallow: [], deepen: null, deepenSince: null, deepenNot: [], done: false, waitForDone: false };
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('want-ref ')) args.wantRefs.push(line.slice(9).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.deepen = Number(line.slice(7).trim());
    else if (line.startsWith('deepen-since ')) args.deepenSince = Number(line.slice(13).trim());
    else if (line.startsWith('deepen-not ')) args.deepenNot.push(line.slice(11).trim());
    else if (line === 'done') args.done = true;
    else if (line === 'wait-for-done') args.waitForDone = true;
  }
  return args;
}

/**
 * Memo key for a fetch negotiation: the arguments plus a fingerprint of the
 * repository's git state. Object contents are content-addressed and the
 * store only grows; every mutation lands inside a single request together
 * with a ref move or store growth, so a changed state always changes the
 * fingerprint and recomputes instead of serving stale bytes.
 */
function fetchMemoKey(rec: RepoRec, args: FetchArgs): string {
  const refs = [...rec.refs.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join(';');
  const fingerprint = sha1Hex(Buffer.from(`${refs}|${rec.store.size}`, 'utf8'));
  const argsJson = JSON.stringify([args.wants, args.wantRefs, args.haves, args.shallow, args.deepen, args.deepenSince, args.deepenNot]);
  return sha1Hex(Buffer.from(`${fingerprint}|${argsJson}`, 'utf8'));
}

/**
 * Fetch responses are cached as in-flight promises: the first request for a
 * given negotiation starts the computation and every concurrent twin awaits
 * the same promise, so walkCommits/objectClosure/writePack run once per
 * distinct fetch no matter how many clones arrive together. The computed
 * bytes are identical to a solo computation — the promise only shares them.
 */
function fetchResponse(rec: RepoRec, args: FetchArgs): Promise<Buffer> {
  if (!args.done && args.waitForDone) {
    return Promise.resolve(Buffer.concat([pktText('acknowledgments'), pktText('ready'), PKT_FLUSH]));
  }
  const key = fetchMemoKey(rec, args);
  const hit = rec.fetchCache.get(key);
  if (hit) return hit;
  const pending = Promise.resolve().then(() => computeFetchResponse(rec, args));
  if (rec.fetchCache.size > 64) rec.fetchCache.clear();
  rec.fetchCache.set(key, pending);
  return pending;
}

function computeFetchResponse(rec: RepoRec, args: FetchArgs): Buffer {
  const store = rec.store;
  // Resolve wants (oids, tag objects, want-refs).
  const wantOids: string[] = [];
  for (const w of args.wants) if (isOid(w) && store.has(w)) wantOids.push(w);
  for (const ref of args.wantRefs) {
    const oid = rec.refs.get(ref);
    if (oid) wantOids.push(oid);
  }
  // Tag wants expand to their target commits for the walk; tag objects ship too.
  const extraObjects = new Set<string>();
  const wantCommits: string[] = [];
  for (const oid of wantOids) {
    let cur = oid;
    for (let i = 0; i < 10; i += 1) {
      const obj = store.get(cur);
      if (!obj) break;
      if (obj.type === 'tag') {
        extraObjects.add(cur);
        cur = parseTag(obj.data).object;
        continue;
      }
      break;
    }
    if (store.get(cur)?.type === 'commit') wantCommits.push(cur);
    else if (store.has(cur)) extraObjects.add(cur);
  }

  const haveCommits = args.haves.filter((h) => store.get(h)?.type === 'commit');
  // In a shallow exchange a `have` names a commit the client holds (with its
  // tree) but NOT its history — the exclusion is just those commits. In a
  // full exchange a have implies its whole ancestry.
  const shallowExchange = args.shallow.length > 0 || args.deepen !== null || args.deepenSince !== null;
  const haveCommitSet = shallowExchange ? new Set(haveCommits) : new Set(walkCommits(store, haveCommits).keys());
  const exclude = objectClosure(store, haveCommitSet, new Set());
  for (const oid of extraObjects) exclude.delete(oid);

  const gens = walkCommits(store, wantCommits);
  let included: Set<string>;
  const shallowLines: string[] = [];
  const clientShallow = new Set(args.shallow);
  if (args.deepen !== null || args.deepenSince !== null || args.deepenNot.length > 0) {
    included = new Set<string>();
    const notAncestors = args.deepenNot.length > 0 ? new Set(walkCommits(store, args.deepenNot.map((r) => rec.refs.get(r) ?? r).filter((o) => store.has(o))).keys()) : new Set<string>();
    for (const [oid, g] of gens) {
      if (notAncestors.has(oid)) continue;
      if (args.deepen !== null && g >= args.deepen) continue;
      if (args.deepenSince !== null) {
        const info = commitInfo(store, oid);
        if (!info || info.time <= args.deepenSince) continue;
      }
      included.add(oid);
    }
    // Boundary: included commits with at least one parent not included.
    for (const oid of included) {
      const info = commitInfo(store, oid);
      if (!info) continue;
      const isBoundary = info.parents.some((p) => !included.has(peelToCommit(store, p)));
      if (isBoundary) shallowLines.push(`shallow ${oid}`);
    }
    for (const oid of clientShallow) {
      if (included.has(oid) && !shallowLines.includes(`shallow ${oid}`)) shallowLines.push(`unshallow ${oid}`);
    }
  } else {
    included = new Set(gens.keys());
    for (const oid of clientShallow) {
      if (included.has(oid)) shallowLines.push(`unshallow ${oid}`);
    }
  }

  const packOids = objectClosure(store, included, exclude);
  for (const oid of extraObjects) packOids.add(oid);
  for (const oid of [...packOids]) {
    if (!store.has(oid)) packOids.delete(oid);
  }

  const cacheKey = sha1Hex(Buffer.from([...packOids].sort().join(','), 'utf8'));
  let pack = rec.packCache.get(cacheKey);
  if (!pack) {
    const objects: GitObj[] = [];
    // Commits first (generation order), then trees, blobs, tags.
    const byType = (t: string) => [...packOids].filter((oid) => store.get(oid)?.type === t);
    const commits = byType('commit').sort((a, b) => (gens.get(a) ?? 0) - (gens.get(b) ?? 0));
    for (const oid of [...commits, ...byType('tree'), ...byType('blob'), ...byType('tag')]) {
      const obj = store.get(oid);
      if (obj) objects.push(obj);
    }
    pack = writePack(objects, 0);
    if (rec.packCache.size > 64) rec.packCache.clear();
    rec.packCache.set(cacheKey, pack);
  }

  const parts: Buffer[] = [];
  if (shallowLines.length > 0) {
    parts.push(pktText('shallow-info'));
    for (const line of shallowLines) parts.push(pktText(line));
    parts.push(PKT_DELIM);
  }
  parts.push(pktText('packfile'));
  for (const packet of sidebandPack(pack)) parts.push(packet);
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

async function uploadPack(forge: Forge, req: IncomingMessage, res: ServerResponse, rec: RepoRec): Promise<void> {
  const body = await readBody(req);
  const packets = parsePktLines(body);
  const firstData = packets.find((p) => p.kind === 'data');
  const commandLine = firstData?.payload.toString('utf8').replace(/\n$/, '') ?? '';
  if (commandLine === 'command=ls-refs') {
    sendBuffer(res, 200, lsRefs(rec, packets), UPLOAD_RESULT);
    return;
  }
  if (commandLine === 'command=fetch') {
    const args = parseFetchArgs(packets);
    sendBuffer(res, 200, await fetchResponse(rec, args), UPLOAD_RESULT);
    return;
  }
  sendBuffer(res, 400, pktText('error: unknown command'), UPLOAD_RESULT);
}

// --- receive-pack ------------------------------------------------------------------

interface RefCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

async function receivePack(forge: Forge, req: IncomingMessage, res: ServerResponse, rec: RepoRec): Promise<void> {
  const body = await readBody(req);
  const end = pktSectionEnd(body);
  const packets = parsePktLines(body.subarray(0, end));
  const commands: RefCommand[] = [];
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    let line = p.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul);
    const parts = line.split(' ');
    if (parts.length >= 3 && isOid(parts[0] as string) && isOid(parts[1] as string)) {
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts.slice(2).join(' ') });
    }
  }
  const packBytes = body.subarray(end);
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  let unpackLine = 'unpack ok';
  let staged: Map<string, GitObj> | null = null;
  const hasPack = packBytes.length > 0;
  if (hasPack) {
    try {
      const read = readPack(packBytes, (oid) => rec.store.get(oid));
      staged = read.objects;
    } catch (err) {
      unpackLine = `unpack ${err instanceof Error ? err.message : 'error'}`;
    }
  }
  const unpackOk = unpackLine === 'unpack ok';
  if (staged) {
    for (const [oid, obj] of staged) rec.store.putKnown(oid, obj.type, obj.data);
  }

  for (const cmd of commands) {
    const fail = (reason: string) => results.push({ ref: cmd.ref, ok: false, reason });
    const succeed = () => results.push({ ref: cmd.ref, ok: true, reason: '' });
    if (!unpackOk) {
      fail('unpack failed');
      continue;
    }
    const current = rec.refs.get(cmd.ref) ?? ZERO_OID;
    if (cmd.newOid === ZERO_OID) {
      // Delete.
      if (cmd.ref === `refs/heads/${rec.defaultBranch}` && current !== ZERO_OID) {
        fail('deletion of the current branch prohibited');
        continue;
      }
      if (current === ZERO_OID) {
        fail('remote ref does not exist');
        continue;
      }
      if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) {
        fail('stale info');
        continue;
      }
      rec.refs.delete(cmd.ref);
      succeed();
      continue;
    }
    // Create or update: the new object must be known now.
    if (!rec.store.has(cmd.newOid)) {
      fail('new object not found');
      continue;
    }
    if (current !== ZERO_OID && cmd.oldOid !== current) {
      fail('stale info');
      continue;
    }
    if (current !== ZERO_OID && current !== cmd.newOid) {
      const oldCommit = peelToCommit(rec.store, current);
      const newCommit = peelToCommit(rec.store, cmd.newOid);
      if (oldCommit !== newCommit && !isAncestor(rec.store, oldCommit, newCommit)) {
        fail('non-fast-forward');
        continue;
      }
    }
    rec.refs.set(cmd.ref, cmd.newOid);
    succeed();
  }

  forge.touchRepo(rec);

  // report-status: a pkt-line stream inside side-band-64k band 1.
  const reportParts: Buffer[] = [pktText(unpackLine)];
  for (const r of results) {
    reportParts.push(r.ok ? pktText(`ok ${r.ref}`) : pktText(`ng ${r.ref} ${r.reason}`));
  }
  reportParts.push(PKT_FLUSH);
  const reportStream = Buffer.concat(reportParts);
  const out: Buffer[] = [];
  const CHUNK = 65515 - 1;
  for (let off = 0; off < reportStream.length; off += CHUNK) {
    out.push(sidebandPacket(1, reportStream.subarray(off, Math.min(reportStream.length, off + CHUNK))));
  }
  out.push(PKT_FLUSH);
  sendBuffer(res, 200, Buffer.concat(out), RECEIVE_RESULT);
}

// --- router ---------------------------------------------------------------------------

export async function handleGitHttp(forge: Forge, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const m = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(url.pathname);
  if (!m) return false;
  const owner = decodeURIComponent(m[1] as string);
  const name = decodeURIComponent(m[2] as string);
  const route = m[3] as string;
  if (owner !== forge.viewerLogin) {
    notFound(res);
    return true;
  }
  const rec = forge.getRepo(owner, name);
  if (!rec) {
    notFound(res);
    return true;
  }
  if (route === 'info/refs' && (req.method ?? 'GET') === 'GET') {
    infoRefs(forge, req, res, rec, url.searchParams.get('service') ?? '');
    return true;
  }
  if (route === 'git-upload-pack' && req.method === 'POST') {
    await uploadPack(forge, req, res, rec);
    return true;
  }
  if (route === 'git-receive-pack' && req.method === 'POST') {
    await receivePack(forge, req, res, rec);
    return true;
  }
  return false;
}
