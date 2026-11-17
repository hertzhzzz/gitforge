// Git 对象层：commit / tree / blob / tag 解析与构造、delta、packfile、
// pkt-line 与 sideband。只用 Node 标准库（node:crypto、node:zlib）。
// 参考 isomorphic-git 理解格式后独立实现，未复制其代码。

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

/** 全零 oid，表示“无祖先”，创建分支时总允许。 */
const ZERO_OID = '0000000000000000000000000000000000000000';

/** 对象类型名到 pack 类型码的映射（与 readPack 一致）。 */
const TYPE_CODES: Record<string, number> = {
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
};

/** pack 类型码到对象类型名的映射。 */
const CODE_TYPES: Record<number, string> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
};

/** 计算 git 对象 id：SHA-1("<type> <size>\0" + data)，小写 40 位 hex。 */
export function sha1(type: string, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** 解析 commit 字节，保留原始 author/committer 行（含时间戳）。 */
export function parseCommit(data: Buffer): {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
} {
  const sep = data.indexOf('\n\n');
  const headerPart = sep >= 0 ? data.subarray(0, sep) : data;
  const message = sep >= 0 ? data.subarray(sep + 2).toString('utf8') : '';
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerPart.toString('utf8').split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5);
    else if (line.startsWith('parent ')) parents.push(line.slice(7));
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** 按 git 格式构造 commit 字节。 */
export function buildCommit(
  tree: string,
  parents: string[],
  author: string,
  committer: string,
  message: string,
): Buffer {
  let header = `tree ${tree}\n`;
  for (const parent of parents) header += `parent ${parent}\n`;
  header += `author ${author}\n`;
  header += `committer ${committer}\n`;
  return Buffer.concat([
    Buffer.from(header + '\n', 'utf8'),
    Buffer.from(message, 'utf8'),
  ]);
}

/** 解析 tree 字节为条目列表，mode 为八进制字符串。 */
export function parseTree(
  data: Buffer,
): Array<{ mode: string; name: string; oid: string }> {
  const entries: Array<{ mode: string; name: string; oid: string }> = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('malformed tree: missing space after mode');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('malformed tree: missing NUL after name');
    if (nul + 21 > data.length) {
      throw new Error('malformed tree: truncated oid');
    }
    entries.push({
      mode: data.subarray(offset, space).toString('utf8'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** git tree 排序键：目录按 name + "/" 比较。 */
function treeSortKey(entry: { mode: string; name: string }): Buffer {
  const key = entry.mode === '40000' ? `${entry.name}/` : entry.name;
  return Buffer.from(key, 'utf8');
}

/** 按 git 排序构造 tree 字节。 */
export function buildTree(
  entries: Array<{ mode: string; name: string; oid: string }>,
): Buffer {
  const sorted = [...entries].sort((a, b) =>
    Buffer.compare(treeSortKey(a), treeSortKey(b)),
  );
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    const oid = Buffer.from(entry.oid, 'hex');
    if (oid.length !== 20) throw new Error(`invalid oid: ${entry.oid}`);
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(oid);
  }
  return Buffer.concat(parts);
}

/** 解析 annotated tag 字节。 */
export function parseTag(data: Buffer): {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
} {
  const sep = data.indexOf('\n\n');
  const headerPart = sep >= 0 ? data.subarray(0, sep) : data;
  const message = sep >= 0 ? data.subarray(sep + 2).toString('utf8') : '';
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of headerPart.toString('utf8').split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7);
    else if (line.startsWith('type ')) type = line.slice(5);
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

/** 从 delta 开头读取一个小端 varint（每字节低 7 位，最高位为续位）。 */
function readDeltaVarint(delta: Buffer, offset: number): {
  value: number;
  next: number;
} {
  let value = 0;
  let shift = 0;
  let pos = offset;
  for (;;) {
    if (pos >= delta.length) throw new Error('truncated delta varint');
    const byte = delta[pos] as number;
    pos += 1;
    value |= (byte & 0x7f) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  return { value, next: pos };
}

/** 把 git delta 应用到基对象上，校验源大小与目标大小。 */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const sourceSize = readDeltaVarint(delta, 0);
  if (sourceSize.value !== base.length) {
    throw new Error(
      `delta source size ${sourceSize.value} does not match base length ${base.length}`,
    );
  }
  const targetSize = readDeltaVarint(delta, sourceSize.next);
  const chunks: Buffer[] = [];
  let produced = 0;
  let pos = targetSize.next;
  while (pos < delta.length) {
    const opcode = delta[pos] as number;
    pos += 1;
    if ((opcode & 0x80) !== 0) {
      // copy：低 4 位是 offset 位掩码，5-7 位是 size 位掩码。
      let offset = 0;
      let size = 0;
      let shift = 0;
      for (let i = 0; i < 4; i += 1) {
        if ((opcode & (1 << i)) !== 0) {
          if (pos >= delta.length) throw new Error('truncated delta copy');
          offset |= (delta[pos] as number) << shift;
          pos += 1;
        }
        shift += 8;
      }
      shift = 0;
      for (let i = 0; i < 3; i += 1) {
        if ((opcode & (0x10 << i)) !== 0) {
          if (pos >= delta.length) throw new Error('truncated delta copy');
          size |= (delta[pos] as number) << shift;
          pos += 1;
        }
        shift += 8;
      }
      if (size === 0) size = 0x10000;
      if (offset + size > base.length) {
        throw new Error('delta copy exceeds base bounds');
      }
      const piece = base.subarray(offset, offset + size);
      chunks.push(piece);
      produced += piece.length;
    } else {
      // insert：opcode 本身就是字面量长度（0 在此非法）。
      if (opcode === 0) throw new Error('delta insert of length 0');
      if (pos + opcode > delta.length) {
        throw new Error('truncated delta insert');
      }
      chunks.push(delta.subarray(pos, pos + opcode));
      produced += opcode;
      pos += opcode;
    }
  }
  if (produced !== targetSize.value) {
    throw new Error(
      `delta target size ${targetSize.value} does not match produced ${produced} bytes`,
    );
  }
  return Buffer.concat(chunks, targetSize.value);
}

/** 用二分查找确定从 start 开始的 zlib 流长度（inflateSync 忽略尾部字节）。 */
function inflateAt(buf: Buffer, start: number): { data: Buffer; consumed: number } {
  const remaining = buf.length - start;
  // 最小成功前缀即流的真实结尾：更短的前缀必因截断而抛错。
  let lo = 1;
  let hi = remaining;
  let data: Buffer | undefined;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    try {
      data = inflateSync(buf.subarray(start, start + mid));
      hi = mid - 1;
    } catch {
      lo = mid + 1;
    }
  }
  if (data === undefined) {
    throw new Error('invalid zlib stream in packfile');
  }
  return { data, consumed: lo };
}

/** pack 对象头 varint：首字节含 3 位类型与 4 位长度低位，后续每字节 7 位长度。 */
function readObjectHeader(
  buf: Buffer,
  offset: number,
): { typeCode: number; size: number; next: number } {
  let pos = offset;
  const first = buf[pos] as number;
  pos += 1;
  const typeCode = (first >> 4) & 0x07;
  let size = first & 0x0f;
  let shift = 4;
  while ((buf[pos - 1] as number) & 0x80) {
    if (pos >= buf.length) throw new Error('truncated pack object header');
    const byte = buf[pos] as number;
    pos += 1;
    size |= (byte & 0x7f) << shift;
    shift += 7;
  }
  return { typeCode, size, next: pos };
}

/** OFS_DELTA 的负偏移编码：每字节低 7 位，带 +1 进位。 */
function readOfsDeltaOffset(buf: Buffer, offset: number): {
  value: number;
  next: number;
} {
  let pos = offset;
  let byte = buf[pos] as number;
  pos += 1;
  let value = byte & 0x7f;
  while ((byte & 0x80) !== 0) {
    if (pos >= buf.length) throw new Error('truncated OFS_DELTA offset');
    byte = buf[pos] as number;
    pos += 1;
    value = ((value + 1) << 7) | (byte & 0x7f);
  }
  return { value, next: pos };
}

interface RawPackEntry {
  offset: number;
  typeCode: number;
  size: number;
  /** 非 delta 对象的原始内容；delta 对象为 delta 字节。 */
  data: Buffer;
  /** OFS_DELTA：基对象在本包内的起始偏移。 */
  baseOffset?: number;
  /** REF_DELTA：基对象的 sha。 */
  baseSha?: string;
}

/** 解析 packfile，含 OFS/REF delta 与 thin-pack 外部基对象，校验 trailer。 */
export function readPack(
  buf: Buffer,
  getBase: (sha: string) => { type: string; data: Buffer } | undefined,
): Map<string, { type: string; data: Buffer }> {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile: bad magic');
  }
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) {
    throw new Error(`unsupported pack version ${version}`);
  }
  const count = buf.readUInt32BE(8);
  const trailer = buf.subarray(buf.length - 20);
  const expectedTrailer = createHash('sha1')
    .update(buf.subarray(0, buf.length - 20))
    .digest();
  if (!trailer.equals(expectedTrailer)) {
    throw new Error('packfile trailer checksum mismatch');
  }

  // 第一遍：按顺序解析每条记录的头与 zlib 流，不解 delta。
  const entries: RawPackEntry[] = [];
  let pos = 12;
  const bodyEnd = buf.length - 20;
  for (let i = 0; i < count; i += 1) {
    if (pos >= bodyEnd) throw new Error('packfile truncated: missing object');
    const entryOffset = pos;
    const header = readObjectHeader(buf, pos);
    pos = header.next;
    let baseOffset: number | undefined;
    let baseSha: string | undefined;
    if (header.typeCode === 6) {
      const ofs = readOfsDeltaOffset(buf, pos);
      baseOffset = entryOffset - ofs.value;
      if (baseOffset < 12) throw new Error('OFS_DELTA base offset out of range');
      pos = ofs.next;
    } else if (header.typeCode === 7) {
      if (pos + 20 > bodyEnd) throw new Error('truncated REF_DELTA base sha');
      baseSha = buf.subarray(pos, pos + 20).toString('hex');
      pos += 20;
    } else if (CODE_TYPES[header.typeCode] === undefined) {
      throw new Error(`unknown pack object type ${header.typeCode}`);
    }
    const inflated = inflateAt(buf, pos);
    pos += inflated.consumed;
    if (inflated.data.length !== header.size) {
      throw new Error(
        `pack object size mismatch: header says ${header.size}, got ${inflated.data.length}`,
      );
    }
    entries.push({
      offset: entryOffset,
      typeCode: header.typeCode,
      size: header.size,
      data: inflated.data,
      baseOffset,
      baseSha,
    });
  }
  if (pos !== bodyEnd) {
    throw new Error('packfile has trailing bytes before trailer');
  }

  // 第二遍：解 delta（递归，带记忆化），生成 sha -> 对象映射。
  const byOffset = new Map<number, RawPackEntry>();
  for (const entry of entries) byOffset.set(entry.offset, entry);
  const resolvedByOffset = new Map<
    number,
    { type: string; data: Buffer; sha: string }
  >();
  const result = new Map<string, { type: string; data: Buffer }>();

  const resolve = (
    entry: RawPackEntry,
    resolving: Set<number>,
  ): { type: string; data: Buffer; sha: string } => {
    const cached = resolvedByOffset.get(entry.offset);
    if (cached) return cached;
    if (resolving.has(entry.offset)) {
      throw new Error('delta cycle in packfile');
    }
    resolving.add(entry.offset);
    let resolved: { type: string; data: Buffer; sha: string };
    if (entry.typeCode === 6 || entry.typeCode === 7) {
      let base: { type: string; data: Buffer } | undefined;
      if (entry.baseOffset !== undefined) {
        const baseEntry = byOffset.get(entry.baseOffset);
        if (!baseEntry) throw new Error('OFS_DELTA base not found in pack');
        base = resolve(baseEntry, resolving);
      } else if (entry.baseSha !== undefined) {
        // 先找包内已解出的对象，再找包内未解的 delta，最后问外部。
        for (const candidate of entries) {
          const done = resolvedByOffset.get(candidate.offset);
          if (done && done.sha === entry.baseSha) {
            base = done;
            break;
          }
        }
        if (!base) {
          for (const candidate of entries) {
            if (candidate.offset === entry.offset) continue;
            if (candidate.typeCode === 6 || candidate.typeCode === 7) {
              const done = resolve(candidate, new Set(resolving));
              if (done.sha === entry.baseSha) {
                base = done;
                break;
              }
            }
          }
        }
        if (!base) base = getBase(entry.baseSha);
        if (!base) throw new Error(`REF_DELTA base ${entry.baseSha} not found`);
      } else {
        throw new Error('delta entry without base');
      }
      const data = applyDelta(base.data, entry.data);
      const sha = sha1(base.type, data);
      resolved = { type: base.type, data, sha };
    } else {
      const type = CODE_TYPES[entry.typeCode] as string;
      resolved = { type, data: entry.data, sha: sha1(type, entry.data) };
    }
    resolving.delete(entry.offset);
    resolvedByOffset.set(entry.offset, resolved);
    result.set(resolved.sha, { type: resolved.type, data: resolved.data });
    return resolved;
  };

  for (const entry of entries) resolve(entry, new Set());
  return result;
}

/** 写对象头 varint：3 位类型 + 长度（首字节低 4 位，后续每字节 7 位）。 */
function writeObjectHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let remaining = size;
  bytes.push(((typeCode & 0x07) << 4) | (remaining & 0x0f));
  remaining >>= 4;
  while (remaining > 0) {
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] as number) | 0x80;
    bytes.push(remaining & 0x7f);
    remaining >>= 7;
  }
  return Buffer.from(bytes);
}

/** 生成 packfile（版本 2，无 delta，纯对象 + SHA-1 trailer）。 */
export function writePack(objects: Array<{ type: string; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    const typeCode = TYPE_CODES[object.type];
    if (typeCode === undefined) throw new Error(`unknown object type ${object.type}`);
    parts.push(writeObjectHeader(typeCode, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** 从 tip commits 出发，返回全部可达对象的 sha 集合（含 tip 本身）。 */
export function reachable(
  objects: Map<string, { type: string; data: Buffer }>,
  tips: string[],
): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const object = objects.get(sha);
    if (!object) continue;
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree);
      for (const parent of commit.parents) stack.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return seen;
}

/** 判断 descendant 是否为 ancestor 的后代（沿 parent 链可达即成立）。 */
export function isAncestor(
  objects: Map<string, { type: string; data: Buffer }>,
  ancestor: string,
  descendant: string,
): boolean {
  if (ancestor === descendant) return true;
  if (ancestor === ZERO_OID) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const object = objects.get(sha);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      stack.push(parent);
    }
  }
  return false;
}

/** 编码一条 pkt-line：4 位 hex 长度（含自身 4 字节）+ 内容；长度 0 为 flush。 */
export function pktlineEncode(payload: string | Buffer): Buffer {
  if (
    (typeof payload === 'string' && payload.length === 0) ||
    (Buffer.isBuffer(payload) && payload.length === 0)
  ) {
    return Buffer.from('0000', 'utf8');
  }
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  const header = length.toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(header, 'utf8'), data]);
}

/** 解析 pkt-line 流：0000=flush，0001=delim，其余为 data（保留原始字节）。 */
export function pktlineDecode(
  buf: Buffer,
): Array<{ kind: 'data' | 'flush' | 'delim'; data: Buffer }> {
  const out: Array<{ kind: 'data' | 'flush' | 'delim'; data: Buffer }> = [];
  let pos = 0;
  while (pos < buf.length) {
    if (pos + 4 > buf.length) {
      throw new Error('truncated pkt-line header');
    }
    const hex = buf.subarray(pos, pos + 4).toString('utf8');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
      throw new Error(`invalid pkt-line length: ${hex}`);
    }
    const length = parseInt(hex, 16);
    pos += 4;
    if (length === 0) {
      out.push({ kind: 'flush', data: Buffer.alloc(0) });
    } else if (length === 1) {
      out.push({ kind: 'delim', data: Buffer.alloc(0) });
    } else if (length < 4) {
      throw new Error(`invalid pkt-line length: ${hex}`);
    } else {
      if (pos + length - 4 > buf.length) {
        throw new Error('truncated pkt-line payload');
      }
      out.push({ kind: 'data', data: buf.subarray(pos, pos + length - 4) });
      pos += length - 4;
    }
  }
  return out;
}

/** 把 pack 字节包进 sideband band 1，progress 有则包进 band 2（每包不超 65520 字节）。 */
export function sidebandWrap(pack: Buffer, progress?: string): Buffer {
  // 每条 pkt-line 总长上限 65520：4 字节头 + 1 字节 band + 最多 65515 字节数据。
  const MAX_DATA = 65515;
  const parts: Buffer[] = [];
  const wrap = (band: number, data: Buffer): void => {
    for (let offset = 0; offset < data.length; offset += MAX_DATA) {
      const chunk = data.subarray(offset, offset + MAX_DATA);
      parts.push(pktlineEncode(Buffer.concat([Buffer.from([band]), chunk])));
    }
  };
  if (progress !== undefined && progress.length > 0) {
    wrap(2, Buffer.from(progress, 'utf8'));
  }
  wrap(1, pack);
  return Buffer.concat(parts);
}
