// Shared helpers: hashing, pkt-line codec, a logical clock for deterministic timestamps.

import { createHash } from 'node:crypto';

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export const ZERO_OID = '0000000000000000000000000000000000000000';

export function isOid(s: string): boolean {
  return /^[0-9a-f]{40}$/.test(s);
}

// --- logical clock -------------------------------------------------------
// One fixed epoch base plus a monotone counter: created_at/updated_at are
// stable per object, increasing in creation order, and identical across the
// REST / GraphQL / MCP views because they are stored once at creation.
const CLOCK_BASE = Date.UTC(2025, 0, 1, 0, 0, 0) / 1000;
let clockTick = 0;

export function nextTimestamp(): { epoch: number; iso: string } {
  clockTick += 1;
  const epoch = CLOCK_BASE + clockTick;
  return { epoch, iso: new Date(epoch * 1000).toISOString() };
}

// --- pkt-line ------------------------------------------------------------
export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export function pktText(text: string): Buffer {
  return pktLine(Buffer.from(text.endsWith('\n') ? text : `${text}\n`, 'utf8'));
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

export interface PktPacket {
  kind: 'data' | 'flush' | 'delim' | 'response-end';
  payload: Buffer;
}

/** Parse a whole buffer of pkt-lines (requests are small enough to buffer). */
export function parsePktLines(buf: Buffer): PktPacket[] {
  const out: PktPacket[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const lenText = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-f]{4}$/.test(lenText)) break;
    const len = parseInt(lenText, 16);
    if (len === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      off += 4;
      break; // a flush terminates the pkt-line stream for our purposes
    }
    if (len === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (len === 2) {
      out.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (len < 4 || off + len > buf.length) break;
    out.push({ kind: 'data', payload: Buffer.from(buf.subarray(off + 4, off + len)) });
    off += len;
  }
  return out;
}

/** The offset just past the pkt-line section of a receive-pack request (where the pack begins). */
export function pktSectionEnd(buf: Buffer): number {
  let off = 0;
  while (off + 4 <= buf.length) {
    const lenText = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-f]{4}$/.test(lenText)) return off;
    const len = parseInt(lenText, 16);
    if (len === 0) return off + 4;
    if (len < 4) return off + 4;
    off += len;
  }
  return off;
}

export function sidebandPacket(band: number, data: Buffer): Buffer {
  return pktLine(Buffer.concat([Buffer.from([band]), data]));
}

/** Split pack bytes into side-band-64k band-1 packets (max payload 65515 data bytes + band byte). */
export function sidebandPack(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65515 - 1;
  for (let off = 0; off < pack.length; off += CHUNK) {
    out.push(sidebandPacket(1, pack.subarray(off, Math.min(pack.length, off + CHUNK))));
  }
  return out;
}

export function b64encode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

export function b64decode(text: string): string {
  return Buffer.from(text, 'base64').toString('utf8');
}

/** base64url global ids, GitHub-style (their ids decode as "<prefix>:<Type><dbId>" variants; ours are self-consistent). */
export function globalId(type: string, dbId: number): string {
  return Buffer.from(`${type}:${dbId}`, 'utf8').toString('base64');
}

export function parseGlobalId(id: string): { type: string; dbId: number } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const m = /^([A-Za-z]+):(\d+)$/.exec(text);
    if (!m) return null;
    return { type: m[1] as string, dbId: Number(m[2]) };
  } catch {
    return null;
  }
}
