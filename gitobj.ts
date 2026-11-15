// gitobj.ts — the git object model in pure Node stdlib: object ids, trees, commits, tags,
// pkt-lines and packfiles. No git binary anywhere: everything the forge stores or serves
// passes through here. Objects are content-addressed by SHA-1 over "<type> <size>\0" + data,
// exactly as git computes them, so ids the suite builds match ids the forge builds.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export const TYPE_CODES: Readonly<Record<ObjectType, number>> = Object.freeze({
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
});

export const CODE_TYPES: Readonly<Record<number, ObjectType | 'ofs-delta' | 'ref-delta'>> = Object.freeze({
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
  6: 'ofs-delta',
  7: 'ref-delta',
});

export const ZERO_OID = '0000000000000000000000000000000000000000';

/** SHA-1 of a buffer, lowercase hex. */
export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The git object id of a typed payload. */
export function hashObject(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

/** Whether a string looks like a full lowercase/uppercase hex object id. */
export function isOid(text: string): boolean {
  return /^[0-9a-f]{40}$/i.test(text);
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  /** Octal mode as stored, e.g. '100644' for a file, '40000' for a directory. */
  mode: string;
  name: string;
  oid: string;
}

/** Parse a raw tree object into its entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const mode = data.toString('utf8', offset, space);
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** The sort key git uses for a tree entry: directories compare as if named "name/". */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Serialize entries into a raw tree object, sorted the way git sorts them. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- commits and tags

export interface CommitInfo {
  tree: string;
  parents: string[];
  /** The full "Name <email> ts tz" author line. */
  author: string;
  committer: string;
  message: string;
}

/** Parse a raw commit object. Unknown headers are skipped; the message is kept byte-exact. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = ZERO_OID;
  let author = '';
  let committer = '';
  const parents: string[] = [];
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** Serialize a commit object from its parts. */
export function buildCommit(info: CommitInfo): Buffer {
  const lines = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.author}`);
  lines.push(`committer ${info.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${info.message}`, 'utf8');
}

/** The timestamp (epoch seconds) inside an ident line "Name <email> 1700000000 +0000". */
export function identTimestamp(ident: string): number {
  const match = / (\d+) [+-]\d{4}$/.exec(ident.trim());
  return match ? Number(match[1]) : 0;
}

/** Split an ident line into name, email and epoch seconds. */
export function parseIdent(ident: string): { name: string; email: string; epochSec: number } {
  const match = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(ident.trim());
  if (match === null) return { name: ident.trim(), email: '', epochSec: 0 };
  return { name: match[1] ?? '', email: match[2] ?? '', epochSec: Number(match[3]) };
}

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  message: string;
}

/** Parse a raw annotated tag object. */
export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = ZERO_OID;
  let type = 'commit';
  let tag = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
  }
  return { object, type, tag, message };
}

// ---------------------------------------------------------------- pkt-lines

/** One pkt-line: a 4-hex-digit length (counting itself) plus the payload. */
export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

/** The flush packet that ends a pkt-line stream. */
export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

/** The delimiter packet (0001) protocol v2 uses between request sections. */
export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export interface PktRead {
  /** Payload lines, in order, without their length prefixes. */
  lines: Buffer[];
  /** True when a flush packet ended the stream. */
  flushed: boolean;
  /** True when a delimiter packet ended the section. */
  delimited: boolean;
  /** Bytes consumed, including the terminating flush/delimiter when present. */
  consumed: number;
}

/**
 * Read pkt-lines from `buf` starting at `offset` until a flush or delimiter packet (or the
 * buffer runs out). Malformed lengths stop the read without throwing: the forge answers a
 * garbled request by closing the exchange, never by crashing.
 */
export function readPktLines(buf: Buffer, offset = 0): PktRead {
  const lines: Buffer[] = [];
  let at = offset;
  while (at + 4 <= buf.length) {
    const header = buf.toString('ascii', at, at + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = parseInt(header, 16);
    if (length === 0) return { lines, flushed: true, delimited: false, consumed: at + 4 - offset };
    if (length === 1) return { lines, flushed: false, delimited: true, consumed: at + 4 - offset };
    if (length < 4 || at + length > buf.length) break;
    lines.push(buf.subarray(at + 4, at + length));
    at += length;
  }
  return { lines, flushed: false, delimited: false, consumed: at - offset };
}

// ---------------------------------------------------------------- packfiles

export interface PackObjectInput {
  type: ObjectType;
  data: Buffer;
}

/** The varint object header a packfile stores before each object's deflated bytes. */
function packObjectHeader(type: ObjectType, size: number): Buffer {
  const code = TYPE_CODES[type];
  const bytes: number[] = [];
  let first = (code << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size = Math.floor(size / 128);
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/**
 * Write a complete packfile (version 2, no deltas) over the given objects and return it.
 * The trailer is the SHA-1 of everything before it, as the protocol requires.
 */
export function writePack(objects: readonly PackObjectInput[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [header];
  for (const object of objects) {
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/**
 * The exact end (byte count) of the deflate stream starting at `start`, found by binary
 * search: inflateSync succeeds on the stream's exact bytes and on any longer prefix (it
 * stops at the stream's end), and fails on every shorter one. Returns -1 when no prefix
 * inflates, i.e. the bytes are not a deflate stream at all.
 */
function deflateLength(buf: Buffer, start: number): number {
  const max = buf.length - start;
  if (max <= 0) return -1;
  // Grow a window until the stream inflates (most objects deflate to a few hundred
  // bytes, so this takes a couple of probes), then binary-search the exact end inside
  // the last window: success is monotonic in the prefix length.
  let lo = 1;
  let hi = Math.min(max, 128);
  for (;;) {
    try {
      inflateSync(buf.subarray(start, start + hi));
      break;
    } catch {
      if (hi >= max) return -1;
      lo = hi + 1;
      hi = Math.min(max, hi * 4);
    }
  }
  let best = hi;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    try {
      inflateSync(buf.subarray(start, start + mid));
      best = mid;
      hi = mid - 1;
    } catch {
      lo = mid + 1;
    }
  }
  return best;
}

/** Apply a git delta payload to a base object, producing the result bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let at = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[at] ?? 0;
      at += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error(`delta base size mismatch: ${sourceSize} vs ${base.length}`);
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (at < delta.length) {
    const op = delta[at] ?? 0;
    at += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      if (op & 0x01) { copyOffset = delta[at] ?? 0; at += 1; }
      if (op & 0x02) { copyOffset += (delta[at] ?? 0) * 256; at += 1; }
      if (op & 0x04) { copyOffset += (delta[at] ?? 0) * 65_536; at += 1; }
      if (op & 0x08) { copyOffset += (delta[at] ?? 0) * 16_777_216; at += 1; }
      if (op & 0x10) { copySize = delta[at] ?? 0; at += 1; }
      if (op & 0x20) { copySize += (delta[at] ?? 0) * 256; at += 1; }
      if (op & 0x40) { copySize += (delta[at] ?? 0) * 65_536; at += 1; }
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op > 0) {
      out.push(delta.subarray(at, at + op));
      at += op;
      produced += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize || produced !== targetSize) {
    throw new Error(`delta produced ${result.length} bytes, expected ${targetSize}`);
  }
  return result;
}

export interface ParsedPack {
  /** Every object in the pack, resolved (deltas applied), keyed by object id. */
  objects: Map<string, PackObjectInput>;
  /** How many objects the pack header declared. */
  declared: number;
}

/**
 * Parse a packfile starting at `offset` in `buf`. Delta bases may come from earlier in the
 * same pack or from `external` (the forge's own store, for thin packs). Throws on any
 * structural problem; callers turn that into a protocol-level refusal.
 */
export function readPack(
  buf: Buffer,
  offset = 0,
  external?: (oid: string) => PackObjectInput | undefined,
): ParsedPack {
  if (buf.length - offset < 12 || buf.toString('ascii', offset, offset + 4) !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = buf.readUInt32BE(offset + 4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declared = buf.readUInt32BE(offset + 8);
  let at = offset + 12;
  const raw: Array<{ type: ObjectType; data: Buffer }> = [];
  const pending: Array<{ index: number; baseOid?: string; baseOffset?: number; delta: Buffer }> = [];
  const offsets: number[] = [];
  for (let i = 0; i < declared; i += 1) {
    offsets.push(at);
    let byte = buf[at] ?? 0;
    at += 1;
    const code = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = buf[at] ?? 0;
      at += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    const kind = CODE_TYPES[code];
    if (kind === undefined) throw new Error(`unknown pack object type code ${code}`);
    let baseOid: string | undefined;
    let baseOffset: number | undefined;
    if (kind === 'ofs-delta') {
      let back = buf[at] ?? 0;
      at += 1;
      let distance = back & 0x7f;
      while (back & 0x80) {
        back = buf[at] ?? 0;
        at += 1;
        distance = ((distance + 1) << 7) | (back & 0x7f);
      }
      baseOffset = (offsets[i] ?? 0) - distance;
    } else if (kind === 'ref-delta') {
      baseOid = buf.toString('hex', at, at + 20);
      at += 20;
    }
    const length = deflateLength(buf, at);
    if (length < 0) throw new Error('pack object does not inflate');
    const inflated = inflateSync(buf.subarray(at, at + length));
    if (inflated.length !== size) throw new Error(`pack object size mismatch: header ${size}, inflated ${inflated.length}`);
    at += length;
    if (kind === 'ofs-delta' || kind === 'ref-delta') {
      raw.push({ type: 'blob', data: Buffer.alloc(0) });
      pending.push({ index: i, baseOid, baseOffset, delta: inflated });
    } else {
      raw.push({ type: kind, data: inflated });
    }
  }
  // Resolve deltas in dependency order: a delta's base may itself be a delta.
  const byOffset = new Map<number, number>();
  offsets.forEach((objectOffset, index) => byOffset.set(objectOffset, index));
  const resolved = new Array<boolean>(raw.length).fill(false);
  for (let i = 0; i < raw.length; i += 1) {
    if (pending.every((entry) => entry.index !== i)) resolved[i] = true;
  }
  let guard = 0;
  while (pending.length > 0 && guard < declared + 2) {
    guard += 1;
    for (let p = pending.length - 1; p >= 0; p -= 1) {
      const entry = pending[p];
      if (entry === undefined) continue;
      let base: PackObjectInput | undefined;
      if (entry.baseOid !== undefined) {
        const localIndex = raw.findIndex((candidate, index) => resolved[index] && hashObject(candidate.type, candidate.data) === entry.baseOid);
        if (localIndex >= 0) base = raw[localIndex];
        else base = external?.(entry.baseOid);
      } else if (entry.baseOffset !== undefined) {
        const baseIndex = byOffset.get(entry.baseOffset);
        if (baseIndex !== undefined && resolved[baseIndex]) base = raw[baseIndex];
      }
      if (base === undefined) continue;
      const data = applyDelta(base.data, entry.delta);
      raw[entry.index] = { type: base.type, data };
      resolved[entry.index] = true;
      pending.splice(p, 1);
    }
  }
  if (pending.length > 0) throw new Error('pack delta base is missing');
  const objects = new Map<string, PackObjectInput>();
  for (const entry of raw) objects.set(hashObject(entry.type, entry.data), entry);
  return { objects, declared };
}
