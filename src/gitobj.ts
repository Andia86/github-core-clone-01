// The git object layer: sha1 objects, pack read/write, history walks,
// three-way tree merges and line diffs. Pure Node stdlib (zlib + crypto).

import { createInflate, inflateSync, deflateSync, constants as zlibConstants } from 'node:zlib';
import { createHash } from 'node:crypto';
import { sha1Hex, ZERO_OID } from './util.ts';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObj {
  type: ObjType;
  data: Buffer;
}

const TYPE_IDS: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const ID_TYPES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function hashObject(type: ObjType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([head, data]));
}

export class ObjectStore {
  readonly map = new Map<string, GitObj>();

  has(oid: string): boolean {
    return this.map.has(oid);
  }

  get(oid: string): GitObj | undefined {
    return this.map.get(oid);
  }

  put(type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.map.has(oid)) this.map.set(oid, { type, data: Buffer.from(data) });
    return oid;
  }

  putKnown(oid: string, type: ObjType, data: Buffer): void {
    if (!this.map.has(oid)) this.map.set(oid, { type, data: Buffer.from(data) });
  }

  get size(): number {
    return this.map.size;
  }
}

// --- commits ---------------------------------------------------------------

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  time: number;
  message: string;
}

const commitCache = new Map<string, CommitInfo>();

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  let time = 0;
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) {
      committer = line.slice(10);
      const m = / (\d+) [+-]\d{4}$/.exec(committer);
      if (m) time = Number(m[1]);
    }
  }
  return { tree, parents, author, committer, time, message };
}

export function commitInfo(store: ObjectStore, oid: string): CommitInfo | null {
  const cached = commitCache.get(oid);
  if (cached) return cached;
  const obj = store.get(oid);
  if (!obj || obj.type !== 'commit') return null;
  const info = parseCommit(obj.data);
  if (commitCache.size > 20000) commitCache.clear();
  commitCache.set(oid, info);
  return info;
}

export function serializeCommit(info: {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  let head = `tree ${info.tree}\n`;
  for (const p of info.parents) head += `parent ${p}\n`;
  head += `author ${info.author}\ncommitter ${info.committer}\n\n`;
  return Buffer.from(head + info.message, 'utf8');
}

/** The ident line the forge itself authors with (contents commits, merges). */
export function forgeIdent(epoch: number): string {
  return `Forge <forge@example.invalid> ${epoch} +0000`;
}

// --- trees -----------------------------------------------------------------

export interface TreeEntry {
  mode: string; // e.g. '100644', '40000' or '040000' as stored
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    if (sp < 0) break;
    const mode = data.subarray(off, sp).toString('ascii');
    const nul = data.indexOf(0x00, sp + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    out.push({ mode, name, oid });
    off = nul + 21;
  }
  return out;
}

/**
 * Parsed-tree memo, per store: tree objects are content-addressed and
 * immutable, so a parse result never goes stale. Closures and tree
 * flattening re-walk the same trees on every fetch; without the memo each
 * walk re-parses every tree buffer from scratch.
 */
const treeEntriesMemo = new WeakMap<ObjectStore, Map<string, TreeEntry[]>>();

export function treeEntries(store: ObjectStore, treeOid: string): TreeEntry[] {
  let memo = treeEntriesMemo.get(store);
  if (!memo) {
    memo = new Map();
    treeEntriesMemo.set(store, memo);
  }
  const hit = memo.get(treeOid);
  if (hit) return hit;
  const obj = store.get(treeOid);
  const entries = obj && obj.type === 'tree' ? parseTree(obj.data) : [];
  if (memo.size > 20000) memo.clear();
  memo.set(treeOid, entries);
  return entries;
}

export function serializeTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode.startsWith('04') || a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode.startsWith('04') || b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function isTreeMode(mode: string): boolean {
  return mode === '40000' || mode === '040000';
}

/** Flatten a tree recursively into path -> {oid, mode} for blobs. */
export function flattenTree(store: ObjectStore, treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
  const obj = store.get(treeOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const e of treeEntries(store, treeOid)) {
    const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
    if (isTreeMode(e.mode)) flattenTree(store, e.oid, path, out);
    else out.set(path, { oid: e.oid, mode: e.mode });
  }
  return out;
}

/** Build nested trees from a flat path -> blob oid map; returns the root tree oid. */
export function buildTree(store: ObjectStore, files: Map<string, { oid: string; mode: string }>): string {
  interface Node {
    dirs: Map<string, Node>;
    files: Map<string, { oid: string; mode: string }>;
  }
  const root: Node = { dirs: new Map(), files: new Map() };
  for (const [path, info] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i] as string;
      if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: new Map() });
      node = node.dirs.get(part) as Node;
    }
    node.files.set(parts[parts.length - 1] as string, info);
  }
  const emit = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, info] of node.files) entries.push({ mode: info.mode, name, oid: info.oid });
    for (const [name, dir] of node.dirs) entries.push({ mode: '40000', name, oid: emit(dir) });
    return store.put('tree', serializeTree(entries));
  };
  return emit(root);
}

// --- tags ------------------------------------------------------------------

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split >= 0 ? text.slice(0, split) : text;
  const info: TagInfo = { object: '', type: '', tag: '', tagger: '', message: split >= 0 ? text.slice(split + 2) : '' };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) info.object = line.slice(7).trim();
    else if (line.startsWith('type ')) info.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) info.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) info.tagger = line.slice(7);
  }
  return info;
}

/** Peel an oid through tag objects to the underlying commit (or return the oid). */
export function peelToCommit(store: ObjectStore, oid: string): string {
  let cur = oid;
  for (let i = 0; i < 10; i += 1) {
    const obj = store.get(cur);
    if (!obj) return cur;
    if (obj.type === 'commit') return cur;
    if (obj.type === 'tag') {
      cur = parseTag(obj.data).object;
      continue;
    }
    return cur;
  }
  return cur;
}

/** Peel one level: tag -> its target oid (for ^\{ } advertisement lines). */
export function peelOne(store: ObjectStore, oid: string): string | null {
  const obj = store.get(oid);
  if (!obj || obj.type !== 'tag') return null;
  return parseTag(obj.data).object;
}

// --- pack read ---------------------------------------------------------------

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const b = delta[off] as number;
      off += 1;
      value |= (b & 0x7f) << shift;
      shift += 7;
      if ((b & 0x80) === 0) break;
    }
    return value;
  };
  const srcSize = readVarint();
  const dstSize = readVarint();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const parts: Buffer[] = [];
  let produced = 0;
  while (off < delta.length) {
    const op = delta[off] as number;
    off += 1;
    if (op & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      for (let i = 0; i < 4; i += 1) {
        if (op & (1 << i)) {
          cpOff |= (delta[off] as number) << (8 * i);
          off += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if (op & (0x10 << i)) {
          cpSize |= (delta[off] as number) << (8 * i);
          off += 1;
        }
      }
      if (cpSize === 0) cpSize = 0x10000;
      parts.push(base.subarray(cpOff, cpOff + cpSize));
      produced += cpSize;
    } else if (op !== 0) {
      parts.push(delta.subarray(off, off + op));
      produced += op;
      off += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const out = Buffer.concat(parts);
  if (out.length !== dstSize || produced !== dstSize) throw new Error('delta result size mismatch');
  return out;
}

export interface PackReadResult {
  objects: Map<string, GitObj>;
  count: number;
}

/**
 * Read a pack into `into` (resolving bases from the pack itself or from
 * `resolveExternal`). Verifies the trailer sha1. Throws on any corruption.
 */
export function readPack(pack: Buffer, resolveExternal?: (oid: string) => GitObj | undefined): PackReadResult {
  if (pack.length < 12 + 20) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack magic');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`bad pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const bodyEnd = pack.length - 20;
  const trailer = pack.subarray(bodyEnd).toString('hex');
  const expect = sha1Hex(pack.subarray(0, bodyEnd));
  if (trailer !== expect) throw new Error('pack trailer checksum mismatch');

  interface Pending {
    type: ObjType;
    data: Buffer;
  }
  const found = new Map<string, GitObj>();
  const pending: Array<{ baseOid?: string; baseOffset?: number; delta: Buffer; offset: number }> = [];
  const byOffset = new Map<number, string>();

  let off = 12;
  for (let i = 0; i < count; i += 1) {
    const start = off;
    let b = pack[off] as number;
    off += 1;
    const typeId = (b >> 4) & 7;
    let size = b & 0x0f;
    let shift = 4;
    while (b & 0x80) {
      b = pack[off] as number;
      off += 1;
      size |= (b & 0x7f) << shift;
      shift += 7;
    }
    if (typeId === 6) {
      // OFS_DELTA
      b = pack[off] as number;
      off += 1;
      let back = b & 0x7f;
      while (b & 0x80) {
        b = pack[off] as number;
        off += 1;
        back = ((back + 1) << 7) | (b & 0x7f);
      }
      const baseOffset = start - back;
      const got = inflateStreamAt(pack, off, bodyEnd, size);
      off += got.consumed;
      pending.push({ baseOffset, delta: got.raw, offset: start });
    } else if (typeId === 7) {
      // REF_DELTA
      const baseOid = pack.subarray(off, off + 20).toString('hex');
      off += 20;
      const got = inflateStreamAt(pack, off, bodyEnd, size);
      off += got.consumed;
      pending.push({ baseOid, delta: got.raw, offset: start });
    } else {
      const type = ID_TYPES[typeId];
      if (!type) throw new Error(`bad pack object type ${typeId}`);
      const got = inflateStreamAt(pack, off, bodyEnd, size);
      const raw = got.raw;
      off += got.consumed;
      if (raw.length !== size) throw new Error('pack object size mismatch');
      const oid = hashObject(type, raw);
      found.set(oid, { type, data: Buffer.from(raw) });
      byOffset.set(start, oid);
    }
  }

  // Resolve deltas (possibly chained).
  const resolveOne = (p: (typeof pending)[number]): GitObj => {
    let base: GitObj | undefined;
    if (p.baseOid !== undefined) {
      base = found.get(p.baseOid) ?? resolveExternal?.(p.baseOid);
    } else if (p.baseOffset !== undefined) {
      const baseOid = byOffset.get(p.baseOffset);
      if (baseOid) base = found.get(baseOid);
    }
    if (!base) throw new Error('delta base not found');
    const data = applyDelta(base.data, p.delta);
    const obj: GitObj = { type: base.type, data };
    const oid = hashObject(base.type, data);
    found.set(oid, obj);
    byOffset.set(p.offset, oid);
    return obj;
  };
  let guard = pending.length * pending.length + 10;
  const queue = [...pending];
  while (queue.length > 0 && guard > 0) {
    guard -= 1;
    const p = queue.shift() as (typeof pending)[number];
    try {
      resolveOne(p);
    } catch {
      queue.push(p);
    }
  }
  if (queue.length > 0) throw new Error('unresolvable delta chain');
  return { objects: found, count };
}

/**
 * Inflate the zlib stream starting at `off` and report how many compressed
 * bytes it occupied. The fast path decodes in ONE pass through the stream's
 * own synchronous write path — the same machinery inflateSync runs — which
 * reports what probing cannot: after each writeSync, `_writeState[1]` holds
 * the input bytes the decoder left unconsumed, so consumed = fed − leftover
 * and no byte is decoded twice. (The public `bytesRead` does not exist on
 * Node's zlib streams; `_writeState` is the counter processChunkSync itself
 * reads.) Integrity is unchanged: the caller still checks the inflated size,
 * every object is re-hashed, and the pack trailer sha1 was verified before
 * parsing began. When the internals are unavailable (other Node builds) the
 * probing decoder below is used instead: an exponential search brackets the
 * stream end, then a bisect pins the first length that inflates.
 */
interface ZlibSyncHandle {
  writeSync: (flush: number, inBuf: Buffer, inOff: number, inLen: number, outBuf: Buffer, outOff: number, outLen: number) => void;
}
interface InflateInternals {
  _handle?: ZlibSyncHandle;
  _writeState?: Uint32Array;
  on: (event: 'error', cb: (err: Error) => void) => void;
  destroy: () => void;
}

let exactInflateOk: boolean | null = null;

function inflateExactOnce(input: Buffer, expectedSize: number): { raw: Buffer; consumed: number } {
  const inf = createInflate() as unknown as InflateInternals;
  const handle = inf._handle;
  const state = inf._writeState;
  if (!handle || !state) throw new Error('zlib sync internals unavailable');
  let streamError: Error | null = null;
  inf.on('error', (err: Error) => {
    streamError = err;
  });
  let out = Buffer.alloc(Math.min(Math.max(16384, expectedSize), 1 << 22));
  let inOff = 0;
  let availIn = input.length;
  let consumed = 0;
  let produced = 0;
  let outOff = 0;
  try {
    for (let iter = 0; iter < 128; iter += 1) {
      const availOutBefore = out.length - outOff;
      handle.writeSync(zlibConstants.Z_NO_FLUSH, input, inOff, availIn, out, outOff, availOutBefore);
      if (streamError) throw streamError;
      const availOutAfter = state[0] as number;
      const availInAfter = state[1] as number;
      const inDelta = availIn - availInAfter;
      consumed += inDelta;
      produced += availOutBefore - availOutAfter;
      outOff += availOutBefore - availOutAfter;
      if (produced > expectedSize) throw new Error('pack object size mismatch');
      // Stop when the input ran out, or the decoder stopped with input and
      // output room to spare (stream end), or the object is complete.
      if (availInAfter === 0 || availOutAfter > 0 || produced >= expectedSize) break;
      // Output buffer filled before the object ended: grow and continue
      // with the input the decoder has not consumed yet.
      const bigger = Buffer.alloc(out.length * 2);
      out.copy(bigger);
      out = bigger;
      inOff += inDelta;
      availIn = availInAfter;
    }
  } finally {
    inf.destroy();
  }
  if (produced !== expectedSize) throw new Error('pack object size mismatch');
  return { raw: Buffer.from(out.subarray(0, produced)), consumed };
}

function inflateStreamAt(pack: Buffer, off: number, bodyEnd: number, expectedSize: number): { raw: Buffer; consumed: number } {
  if (exactInflateOk === null) {
    try {
      const sample = deflateSync(Buffer.from('forge', 'utf8'));
      const got = inflateExactOnce(Buffer.concat([sample, Buffer.from('TAIL', 'utf8')]), 5);
      exactInflateOk = got.consumed === sample.length && got.raw.toString('utf8') === 'forge';
    } catch {
      exactInflateOk = false;
    }
  }
  if (exactInflateOk) return inflateExactOnce(pack.subarray(off, bodyEnd), expectedSize);
  return inflateStreamAtProbe(pack, off, bodyEnd);
}

function inflateStreamAtProbe(pack: Buffer, off: number, bodyEnd: number): { raw: Buffer; consumed: number } {
  const max = bodyEnd - off;
  const ok = (len: number): boolean => {
    try {
      inflateSync(pack.subarray(off, off + len));
      return true;
    } catch {
      return false;
    }
  };
  let tooShort = 0;
  let good = -1;
  let probe = 128;
  while (good < 0) {
    const len = Math.min(probe, max);
    if (ok(len)) {
      good = len;
    } else {
      tooShort = len;
      if (len >= max) throw new Error('corrupt zlib stream in pack');
      probe *= 2;
    }
  }
  let lo = tooShort + 1;
  let hi = good;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ok(mid)) hi = mid;
    else lo = mid + 1;
  }
  return { raw: inflateSync(pack.subarray(off, off + lo)), consumed: lo };
}

// --- pack write --------------------------------------------------------------

export function writePack(objects: Array<{ type: ObjType; data: Buffer }>, level = 6): Buffer {
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [head];
  for (const obj of objects) {
    let size = obj.data.length;
    const typeId = TYPE_IDS[obj.type];
    const bytes: number[] = [];
    let first = (typeId << 4) | (size & 0x0f);
    size >>= 4;
    if (size > 0) first |= 0x80;
    bytes.push(first);
    while (size > 0) {
      let byte = size & 0x7f;
      size >>= 7;
      if (size > 0) byte |= 0x80;
      bytes.push(byte);
    }
    parts.push(Buffer.from(bytes));
    parts.push(deflateSync(obj.data, { level }));
  }
  // The trailer hash feeds on the parts incrementally and the pack bytes
  // are assembled in a single concat: the previous shape concatenated the
  // parts into a body buffer, hashed that, then concatenated AGAIN to
  // append the trailer — two full copies of every pack on the clone path.
  const hash = createHash('sha1');
  for (const part of parts) hash.update(part);
  const trailer = Buffer.from(hash.digest('hex'), 'hex');
  parts.push(trailer);
  return Buffer.concat(parts);
}

// --- history walks -----------------------------------------------------------

/** All commits reachable from `tips` (inclusive), with min generation from the tips. */
export function walkCommits(store: ObjectStore, tips: string[]): Map<string, number> {
  const gen = new Map<string, number>();
  let frontier: Array<{ oid: string; g: number }> = [];
  for (const t of tips) {
    const c = peelToCommit(store, t);
    if (!gen.has(c)) frontier.push({ oid: c, g: 0 });
  }
  for (const f of frontier) gen.set(f.oid, f.g);
  while (frontier.length > 0) {
    const next: Array<{ oid: string; g: number }> = [];
    for (const { oid, g } of frontier) {
      const info = commitInfo(store, oid);
      if (!info) continue;
      for (const p of info.parents) {
        const pc = peelToCommit(store, p);
        if (!gen.has(pc)) {
          gen.set(pc, g + 1);
          next.push({ oid: pc, g: g + 1 });
        }
      }
    }
    frontier = next;
  }
  return gen;
}

export function isAncestor(store: ObjectStore, ancestor: string, descendant: string): boolean {
  const a = peelToCommit(store, ancestor);
  const d = peelToCommit(store, descendant);
  if (a === d) return true;
  const seen = new Set<string>([d]);
  const queue = [d];
  while (queue.length > 0) {
    const cur = queue.pop() as string;
    const info = commitInfo(store, cur);
    if (!info) continue;
    for (const p of info.parents) {
      const pc = peelToCommit(store, p);
      if (pc === a) return true;
      if (!seen.has(pc)) {
        seen.add(pc);
        queue.push(pc);
      }
    }
  }
  return false;
}

/** Merge-base of two commits (the common ancestor with the smallest generation from both). */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  const ga = walkCommits(store, [a]);
  const gb = walkCommits(store, [b]);
  let best: string | null = null;
  let bestScore = Infinity;
  for (const [oid, g] of ga) {
    const other = gb.get(oid);
    if (other !== undefined) {
      const score = g + other;
      if (score < bestScore) {
        bestScore = score;
        best = oid;
      }
    }
  }
  return best;
}

/**
 * Closure memo, per store: a closure is fully determined by the commit set,
 * the exclusion set and the store's contents — and the store only ever grows
 * (objects are content-addressed and immutable), so its size fingerprints the
 * contents. Callers mutate the returned set, so the memo hands out copies.
 */
const closureMemo = new WeakMap<ObjectStore, Map<string, Set<string>>>();

/** Object closure (commits + trees + blobs + tags) for the given commits, restricted to the commit predicate. */
export function objectClosure(
  store: ObjectStore,
  commitOids: Iterable<string>,
  exclude: Set<string>,
): Set<string> {
  const commits = [...commitOids];
  let memo = closureMemo.get(store);
  if (!memo) {
    memo = new Map();
    closureMemo.set(store, memo);
  }
  const memoKey = `${store.size}|${commits.sort().join(',')}|${[...exclude].sort().join(',')}`;
  const cached = memo.get(memoKey);
  if (cached) return new Set(cached);
  const out = computeObjectClosure(store, commits, exclude);
  if (memo.size > 128) memo.clear();
  memo.set(memoKey, out);
  return new Set(out);
}

function computeObjectClosure(
  store: ObjectStore,
  commitOids: Iterable<string>,
  exclude: Set<string>,
): Set<string> {
  const out = new Set<string>();
  const addTree = (treeOid: string): void => {
    if (out.has(treeOid) || exclude.has(treeOid)) return;
    const obj = store.get(treeOid);
    if (!obj || obj.type !== 'tree') return;
    out.add(treeOid);
    for (const e of treeEntries(store, treeOid)) {
      if (exclude.has(e.oid) || out.has(e.oid)) continue;
      if (isTreeMode(e.mode)) addTree(e.oid);
      else out.add(e.oid);
    }
  };
  for (const c of commitOids) {
    if (exclude.has(c) || out.has(c)) continue;
    out.add(c);
    const info = commitInfo(store, c);
    if (info) addTree(info.tree);
  }
  return out;
}

// --- three-way tree merge ------------------------------------------------------

export type MergeOutcome = { ok: true; tree: string } | { ok: false };

/**
 * Merge `theirs` into `ours` relative to `base` (all tree oids). File-level:
 * a path changed on only one side takes that side; changed on both sides
 * differently (or deleted vs changed) conflicts. Subtrees recurse.
 */
export function mergeTrees(store: ObjectStore, base: string, ours: string, theirs: string): MergeOutcome {
  const entryMap = (treeOid: string): Map<string, TreeEntry> => {
    const obj = store.get(treeOid);
    const map = new Map<string, TreeEntry>();
    if (!obj || obj.type !== 'tree') return map;
    for (const e of parseTree(obj.data)) map.set(e.name, e);
    return map;
  };
  const rec = (b: string | null, o: string | null, t: string | null): string | null | 'conflict' => {
    if (o === t) return o;
    if (b === o) return t;
    if (b === t) return o;
    const bm = b ? entryMap(b) : new Map<string, TreeEntry>();
    const om = o ? entryMap(o) : new Map<string, TreeEntry>();
    const tm = t ? entryMap(t) : new Map<string, TreeEntry>();
    const names = new Set<string>([...bm.keys(), ...om.keys(), ...tm.keys()]);
    const entries: TreeEntry[] = [];
    for (const name of names) {
      const be = bm.get(name);
      const oe = om.get(name);
      const te = tm.get(name);
      const bOid = be?.oid ?? null;
      const oOid = oe?.oid ?? null;
      const tOid = te?.oid ?? null;
      if (oOid === tOid) {
        if (oe) entries.push(oe);
        continue;
      }
      if (bOid === oOid) {
        if (te) entries.push(te);
        continue;
      }
      if (bOid === tOid) {
        if (oe) entries.push(oe);
        continue;
      }
      // Both sides changed differently.
      const allTrees = [be, oe, te].every((e) => e === undefined || isTreeMode(e.mode));
      if (allTrees && oe && te) {
        const sub = rec(bOid, oOid, tOid);
        if (sub === 'conflict') return 'conflict';
        if (sub !== null) entries.push({ mode: '40000', name, oid: sub });
        continue;
      }
      return 'conflict';
    }
    if (entries.length === 0) return null;
    return store.put('tree', serializeTree(entries));
  };
  const result = rec(base, ours, theirs);
  if (result === 'conflict' || result === null) {
    if (result === null && (ours !== theirs)) return { ok: false };
    if (result === null) return { ok: true, tree: ours };
    return { ok: false };
  }
  return { ok: true, tree: result };
}

// --- line diff -----------------------------------------------------------------

/** Count added/deleted lines between two texts (LCS over lines; files here are small). */
export function lineDiff(a: string, b: string): { additions: number; deletions: number } {
  const al = a === '' ? [] : a.split('\n');
  const bl = b === '' ? [] : b.split('\n');
  // Drop a single trailing empty element caused by a final newline for fair counts.
  if (al.length && al[al.length - 1] === '') al.pop();
  if (bl.length && bl[bl.length - 1] === '') bl.pop();
  const n = al.length;
  const m = bl.length;
  if (n * m > 4_000_000) {
    // Fallback for oversized inputs: everything changed.
    return { additions: m, deletions: n };
  }
  const dp = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * (m + 1) + j] = al[i] === bl[j] ? (dp[(i + 1) * (m + 1) + j + 1] as number) + 1 : Math.max(dp[(i + 1) * (m + 1) + j] as number, dp[i * (m + 1) + j + 1] as number);
    }
  }
  const common = dp[0] as number;
  return { additions: m - common, deletions: n - common };
}

export { ZERO_OID };
