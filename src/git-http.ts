// Git smart HTTP 层：info/refs、git-upload-pack、git-receive-pack。
// 只用 Node 标准库 + ./store.ts + ./git.ts。所有对象字节原样存储与返回，
// 不重写 commit/tree/blob/tag 的任何字节。
// 协议参考 git Documentation/technical/http-protocol.txt 与 protocol-v2.txt。

import type { Store } from './store.ts';
import {
  isAncestor,
  parseCommit,
  parseTag,
  parseTree,
  pktlineDecode,
  pktlineEncode,
  readPack,
  reachable,
  sidebandWrap,
  writePack,
} from './git.ts';

/** 全零 oid。 */
const ZERO_OID = '0000000000000000000000000000000000000000';
/** owner / repo 名合法字符：首字符字母数字，其余字母数字 . _ -，最长 100。 */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
/** pkt-line delim（0001）与 flush（0000）的原始字节。 */
const DELIM = Buffer.from('0001', 'utf8');
const FLUSH = Buffer.from('0000', 'utf8');
/** pack 缓存上限条目数，超限时删最早写入的一条。 */
const PACK_CACHE_MAX = 128;

/** handleGit 的请求形状（由 app.ts 传入）。 */
export interface GitRequest {
  method: string;
  pathname: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: Buffer;
}

/** handleGit 的响应形状。 */
export interface GitResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

/** 同一 tip + depth + haves 的 pack 字节缓存，避免重复压缩。 */
const packCache = new Map<string, Buffer>();

/** 不区分大小写取请求头。 */
function getHeader(headers: Record<string, string>, name: string): string {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key] as string;
  }
  return '';
}

/** 解析 pathname：/<owner>/<repo>.git/<suffix>，名字不合法返回 null。 */
function parseRoute(pathname: string): { owner: string; repo: string; suffix: string } | null {
  const m = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(pathname);
  if (m === null) return null;
  const owner = m[1] as string;
  const repoWithGit = m[2] as string;
  const repo = repoWithGit;
  if (!NAME_RE.test(owner) || !NAME_RE.test(repo)) return null;
  return { owner, repo, suffix: m[3] ?? '' };
}

/** 404 响应。 */
function notFound(): GitResponse {
  return { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: Buffer.from('Not Found\n', 'utf8') };
}

/** 400 响应（非法体等），服务端不挂。 */
function badRequest(message: string): GitResponse {
  return { status: 400, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: Buffer.from(`error: ${message}\n`, 'utf8') };
}

/** 库的默认分支全名，如 refs/heads/main。 */
function headRefName(repo: { default_branch: string }): string {
  return `refs/heads/${repo.default_branch || 'main'}`;
}

/** 排序后的 [ref, oid] 列表。 */
function sortedRefs(repo: { git: { refs: Map<string, string> } }): Array<[string, string]> {
  return [...repo.git.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** HEAD 指向的 oid：默认分支优先，否则第一个分支，否则第一个 ref，否则零。 */
function headOid(repo: { default_branch: string; git: { refs: Map<string, string> } }): string {
  const direct = repo.git.refs.get(headRefName(repo));
  if (direct !== undefined) return direct;
  const refs = sortedRefs(repo);
  const branch = refs.find(([ref]) => ref.startsWith('refs/heads/'));
  if (branch !== undefined) return branch[1];
  if (refs.length > 0) return (refs[0] as [string, string])[1];
  return ZERO_OID;
}

/**
 * annotated tag 链解到最终对象 oid（commit 或其他对象）。
 * 非 tag 对象直接返回自身 oid。
 */
function peelOid(
  objects: Map<string, { type: string; data: Buffer }>,
  oid: string,
): string {
  let current = oid;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current)) return current;
    seen.add(current);
    const obj = objects.get(current);
    if (obj === undefined || obj.type !== 'tag') return current;
    current = parseTag(obj.data).object;
  }
}

/** 是否为 annotated tag（对象存在且类型为 tag）。 */
function isTag(objects: Map<string, { type: string; data: Buffer }>, oid: string): boolean {
  return objects.get(oid)?.type === 'tag';
}

/** 上传广告（v0）能力串。 */
const UPLOAD_CAPS =
  'symref=HEAD:refs/heads/main multi_ack thin-pack side-band side-band-64k ofs-delta shallow no-progress';
/** 接收广告（v0）能力串。 */
const RECEIVE_CAPS =
  'report-status side-band-64k delete-refs symref=HEAD:refs/heads/main ofs-delta';

/**
 * v0 上传广告：首行 "# service=..." + flush + HEAD 行（带能力）+ 各 ref 行 + 剥离行 + flush。
 * 空库用零 oid 的 capabilities^{} 伪 ref 行。
 */
function uploadAdvertisementV0(repo: { default_branch: string; git: { refs: Map<string, string>; objects: Map<string, { type: string; data: Buffer }> } }): Buffer {
  const parts: Buffer[] = [
    pktlineEncode('# service=git-upload-pack\n'),
    FLUSH,
  ];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktlineEncode(`${ZERO_OID} capabilities^{}\0${UPLOAD_CAPS}\n`));
  } else {
    parts.push(pktlineEncode(`${headOid(repo)} HEAD\0${UPLOAD_CAPS}\n`));
    for (const [ref, oid] of refs) {
      parts.push(pktlineEncode(`${oid} ${ref}\n`));
      if (isTag(repo.git.objects, oid)) {
        const peeled = peelOid(repo.git.objects, oid);
        if (peeled !== oid) parts.push(pktlineEncode(`${peeled} ${ref}^{}\n`));
      }
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/**
 * v2 上传广告："# service=..." + flush + "version 2" + 能力行 + flush。
 * 能力含 fetch=shallow wait-for-done 与 ls-refs=unborn，object-format 为 sha1。
 */
function uploadAdvertisementV2(): Buffer {
  const caps = ['fetch=shallow wait-for-done', 'ls-refs=unborn', 'object-format=sha1'];
  const parts: Buffer[] = [
    pktlineEncode('# service=git-upload-pack\n'),
    FLUSH,
    pktlineEncode('version 2\n'),
  ];
  for (const cap of caps) parts.push(pktlineEncode(`${cap}\n`));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/**
 * v0 接收广告：首行 "# service=..." + flush + 第一 ref 行（带能力）+ 其余 ref 行 + 剥离行 + flush。
 * 空库用零 oid 的 capabilities^{} 伪 ref 行。
 */
function receiveAdvertisementV0(repo: { default_branch: string; git: { refs: Map<string, string>; objects: Map<string, { type: string; data: Buffer }> } }): Buffer {
  const parts: Buffer[] = [
    pktlineEncode('# service=git-receive-pack\n'),
    FLUSH,
  ];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktlineEncode(`${ZERO_OID} capabilities^{}\0${RECEIVE_CAPS}\n`));
  } else {
    refs.forEach(([ref, oid], index) => {
      if (index === 0) {
        parts.push(pktlineEncode(`${oid} ${ref}\0${RECEIVE_CAPS}\n`));
      } else {
        parts.push(pktlineEncode(`${oid} ${ref}\n`));
      }
      if (isTag(repo.git.objects, oid)) {
        const peeled = peelOid(repo.git.objects, oid);
        if (peeled !== oid) parts.push(pktlineEncode(`${peeled} ${ref}^{}\n`));
      }
    });
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** 深度受限的可达对象集：从 wants 出发，commit 只取 depth 层以内（depth 为空则全取）。 */
function depthLimitedSet(
  objects: Map<string, { type: string; data: Buffer }>,
  wants: string[],
  depth: number | undefined,
): Set<string> {
  // 先算 commit 的 BFS 距离（tag 的目标 commit 距离为 0）。
  const includedCommits = new Set<string>();
  if (depth === undefined) {
    for (const sha of reachable(objects, wants)) {
      if (objects.get(sha)?.type === 'commit') includedCommits.add(sha);
    }
  } else {
    const dist = new Map<string, number>();
    const queue: string[] = [];
    const seedCommit = (oid: string): void => {
      const target = peelOid(objects, oid);
      if (objects.get(target)?.type === 'commit' && !dist.has(target)) {
        dist.set(target, 0);
        queue.push(target);
      }
    };
    for (const want of wants) {
      if (objects.get(want)?.type === 'commit') {
        if (!dist.has(want)) {
          dist.set(want, 0);
          queue.push(want);
        }
      } else {
        seedCommit(want);
      }
    }
    let head = 0;
    while (head < queue.length) {
      const sha = queue[head] as string;
      head += 1;
      const d = dist.get(sha) as number;
      if (d >= depth) continue;
      includedCommits.add(sha);
      const obj = objects.get(sha);
      if (obj === undefined || obj.type !== 'commit') continue;
      for (const parent of parseCommit(obj.data).parents) {
        if (!dist.has(parent) && objects.get(parent)?.type === 'commit') {
          dist.set(parent, d + 1);
          queue.push(parent);
        }
      }
    }
  }

  // 再从 wants 遍历对象图，commit 只在 includedCommits 内才展开。
  const sent = new Set<string>();
  const stack = [...wants];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (sent.has(sha)) continue;
    const obj = objects.get(sha);
    if (obj === undefined) continue;
    if (obj.type === 'commit' && !includedCommits.has(sha)) continue;
    sent.add(sha);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      stack.push(commit.tree);
      for (const parent of commit.parents) stack.push(parent);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) stack.push(entry.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return sent;
}

/** fetch 要发的对象、shallow 边界与 unshallow 列表。 */
function computeFetch(
  objects: Map<string, { type: string; data: Buffer }>,
  wants: string[],
  haves: string[],
  clientShallows: string[],
  depth: number | undefined,
): { packObjects: Array<{ type: string; data: Buffer }>; sent: Set<string>; shallow: string[]; unshallow: string[] } {
  const haveReachable = reachable(objects, haves);
  const limited = depthLimitedSet(objects, wants, depth);
  const sent = new Set<string>();
  for (const sha of limited) {
    if (!haveReachable.has(sha)) sent.add(sha);
  }
  // shallow 边界：已发 commit 中父提交存在于库里、但既没发也没在客户端已有集合里。
  const shallow: string[] = [];
  for (const sha of [...sent].sort()) {
    const obj = objects.get(sha);
    if (obj === undefined || obj.type !== 'commit') continue;
    const hasMissingParent = parseCommit(obj.data).parents.some(
      (parent) => objects.has(parent) && !sent.has(parent) && !haveReachable.has(parent),
    );
    if (hasMissingParent) shallow.push(sha);
  }
  const shallowSet = new Set(shallow);
  // unshallow：客户端旧 shallow 点如今已完整（其父提交都在已发或客户端已有集合里）。
  const unshallow: string[] = [];
  for (const sha of [...new Set(clientShallows)].sort()) {
    if (shallowSet.has(sha)) continue;
    if (!sent.has(sha) && !haveReachable.has(sha)) continue;
    const obj = objects.get(sha);
    if (obj === undefined || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    const complete = parents.every((p) => sent.has(p) || haveReachable.has(p) || !objects.has(p));
    if (complete) unshallow.push(sha);
  }
  const packObjects = [...sent]
    .sort()
    .map((sha) => {
      const obj = objects.get(sha) as { type: string; data: Buffer };
      return { type: obj.type, data: obj.data };
    });
  return { packObjects, sent, shallow, unshallow };
}

/** 取 pack 字节：同一 tip + depth + haves 摘要命中缓存则复用。 */
function cachedPack(
  repoKey: string,
  wants: string[],
  haves: string[],
  depth: number | undefined,
  packObjects: Array<{ type: string; data: Buffer }>,
): Buffer {
  const key = [
    repoKey,
    [...wants].sort().join(','),
    depth === undefined ? '' : String(depth),
    [...haves].sort().join(','),
  ].join('|');
  const hit = packCache.get(key);
  if (hit !== undefined) return hit;
  const pack = writePack(packObjects);
  if (packCache.size >= PACK_CACHE_MAX) {
    const oldest = packCache.keys().next().value as string | undefined;
    if (oldest !== undefined) packCache.delete(oldest);
  }
  packCache.set(key, pack);
  return pack;
}

/** v2 ls-refs 的响应体（每行 pkt-line，最后 flush）。 */
function lsRefsResponse(
  repo: { default_branch: string; git: { refs: Map<string, string>; objects: Map<string, { type: string; data: Buffer }> } },
  args: string[],
): Buffer {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const parts: Buffer[] = [];
  const headRef = headRefName(repo);
  const head = repo.git.refs.get(headRef);
  if (head !== undefined) {
    if (matches('HEAD')) {
      parts.push(
        pktlineEncode(`${head} HEAD${symrefs ? ` symref-target:${headRef}` : ''}\n`),
      );
    }
  } else if (unborn) {
    if (matches('HEAD')) {
      parts.push(
        pktlineEncode(`unborn HEAD${symrefs ? ` symref-target:${headRef}` : ''}\n`),
      );
    }
    if (matches(headRef)) {
      parts.push(pktlineEncode(`unborn ${headRef}\n`));
    }
  }
  for (const [ref, oid] of sortedRefs(repo)) {
    if (!matches(ref)) continue;
    let line = `${oid} ${ref}`;
    if (peel && isTag(repo.git.objects, oid)) {
      const peeled = peelOid(repo.git.objects, oid);
      if (peeled !== oid) line += ` peeled:${peeled}`;
    }
    parts.push(pktlineEncode(`${line}\n`));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** v2 fetch 的响应体：各 section 只在相关时出现（与真实 git upload-pack 一致），每个出现的 section 由头 pkt-line 引入、DELIM 结束：
 * - acknowledgments：仅当客户端发了 have 且未发 done（多轮协商）时出现；
 * - shallow-info：仅当 shallow/unshallow 行非空时出现；
 * - wanted-refs：真实 git 从不发送，本实现省略（kit 解析器把 section 当可选）；
 * - packfile：恒有，头 + sideband 包 + FLUSH。
 * 全量发四个头会让真实 git 在 plain fetch 时报 expected 'packfile'；而裸写 NAK/shallow 行（无头）会让 kit 解析器在 section=='' 时抛 unexpected v2 fetch section。 */
function fetchResponseV2(
  repo: { full_name: string; default_branch: string; git: { refs: Map<string, string>; objects: Map<string, { type: string; data: Buffer }> } },
  args: string[],
): GitResponse {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallows: string[] = [];
  let depth: number | undefined;
  let done = false;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallows.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) {
      const n = Number.parseInt(arg.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) depth = n;
    } else if (arg === 'done') done = true;
  }
  for (const want of wants) {
    if (!repo.git.objects.has(want)) return badRequest(`want ${want} not found`);
  }
  const wantReachable = reachable(repo.git.objects, wants);
  const common = haves.filter((have) => wantReachable.has(have));
  const { packObjects, shallow, unshallow } = computeFetch(
    repo.git.objects,
    wants,
    haves,
    shallows,
    depth,
  );
  const pack = cachedPack(repo.full_name, wants, haves, depth, packObjects);

  const ackParts: Buffer[] = [];
  if (common.length > 0) {
    for (const oid of common) ackParts.push(pktlineEncode(`ACK ${oid}\n`));
  } else {
    ackParts.push(pktlineEncode('NAK\n'));
  }
  if (done) ackParts.push(pktlineEncode('ready\n'));

  const shallowParts: Buffer[] = [];
  for (const oid of shallow) shallowParts.push(pktlineEncode(`shallow ${oid}\n`));
  for (const oid of unshallow) shallowParts.push(pktlineEncode(`unshallow ${oid}\n`));

  const body = Buffer.concat([
    // acknowledgments：仅多轮协商（have 且无 done）时出现；发了 done 的单轮请求直接进 packfile。
    ...(haves.length > 0 && !done
      ? [pktlineEncode('acknowledgments\n'), Buffer.concat(ackParts), DELIM]
      : []),
    // shallow-info：仅 shallow/unshallow 行非空时出现。
    ...(shallowParts.length > 0
      ? [pktlineEncode('shallow-info\n'), Buffer.concat(shallowParts), DELIM]
      : []),
    pktlineEncode('packfile\n'),
    sidebandWrap(pack),
    FLUSH,
  ]);
  return {
    status: 200,
    headers: { 'content-type': 'application/x-git-upload-pack-result' },
    body,
  };
}

/** v0 上传的响应体：ACK/NAK + shallow 行 + sideband pack（协商时）或原始 pack。 */
function fetchResponseV0(
  repo: { full_name: string; git: { refs: Map<string, string>; objects: Map<string, { type: string; data: Buffer }> } },
  lines: string[],
): GitResponse {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallows: string[] = [];
  let depth: number | undefined;
  let sideband = false;
  for (const line of lines) {
    if (line.startsWith('want ')) {
      const rest = line.slice(5).trim();
      const tokens = rest.split(/\s+/);
      const oid = tokens[0] as string;
      wants.push(oid);
      for (const cap of tokens.slice(1)) {
        if (cap === 'side-band-64k' || cap === 'side-band') sideband = true;
      }
    } else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallows.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) depth = n;
    }
  }
  for (const want of wants) {
    if (!repo.git.objects.has(want)) return badRequest(`want ${want} not found`);
  }
  const wantReachable = reachable(repo.git.objects, wants);
  const common = haves.filter((have) => wantReachable.has(have));
  const { packObjects, shallow, unshallow } = computeFetch(
    repo.git.objects,
    wants,
    haves,
    shallows,
    depth,
  );
  const pack = cachedPack(repo.full_name, wants, haves, depth, packObjects);

  const headParts: Buffer[] = [];
  if (common.length > 0) {
    for (const oid of common) headParts.push(pktlineEncode(`ACK ${oid}\n`));
  } else {
    headParts.push(pktlineEncode('NAK\n'));
  }
  for (const oid of shallow) headParts.push(pktlineEncode(`shallow ${oid}\n`));
  for (const oid of unshallow) headParts.push(pktlineEncode(`unshallow ${oid}\n`));

  const body = sideband
    ? Buffer.concat([Buffer.concat(headParts), sidebandWrap(pack), FLUSH])
    : Buffer.concat([Buffer.concat(headParts), pack]);
  return {
    status: 200,
    headers: { 'content-type': 'application/x-git-upload-pack-result' },
    body,
  };
}

/** POST git-upload-pack：v2（命令式）或 v0（want/have 式）。 */
function handleUploadPack(
  repo: { full_name: string; default_branch: string; git: { refs: Map<string, string>; objects: Map<string, { type: string; data: Buffer }> } },
  req: GitRequest,
): GitResponse {
  const contentType = getHeader(req.headers, 'content-type');
  const protocol = getHeader(req.headers, 'git-protocol');
  const isV2Request =
    contentType.startsWith('application/x-git-upload-pack-request') &&
    protocol.includes('version=2');
  let decoded: Array<{ kind: 'data' | 'flush' | 'delim'; data: Buffer }>;
  try {
    decoded = pktlineDecode(req.body);
  } catch (err) {
    return badRequest(err instanceof Error ? err.message : 'invalid pkt-line');
  }
  const dataLines = decoded
    .filter((entry) => entry.kind === 'data')
    .map((entry) => entry.data.toString('utf8'));
  const first = dataLines[0] ?? '';
  if (isV2Request && first.startsWith('command=')) {
    const command = first.slice('command='.length).trim();
    const args = dataLines.slice(1).map((line) => line.replace(/\n$/, ''));
    if (command === 'ls-refs') {
      return {
        status: 200,
        headers: { 'content-type': 'application/x-git-upload-pack-result' },
        body: lsRefsResponse(repo, args),
      };
    }
    if (command === 'fetch') return fetchResponseV2(repo, args);
    return badRequest(`unsupported command ${command}`);
  }
  // v0 回退：首行 want（或无 Git-Protocol 头）按 v0 处理。
  const lines = dataLines.map((line) => line.replace(/\n$/, ''));
  return fetchResponseV0(repo, lines);
}

/** 手动解析 receive-pack 的 pkt-line 命令段，返回命令与命令后的 pack 字节。 */
function parseReceiveCommands(
  body: Buffer,
): { commands: Array<{ old: string; next: string; ref: string; caps: string }>; pack: Buffer } {
  const rawLines: string[] = [];
  let pos = 0;
  for (;;) {
    if (pos + 4 > body.length) throw new Error('truncated pkt-line header');
    const hex = body.subarray(pos, pos + 4).toString('utf8');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`invalid pkt-line length: ${hex}`);
    const length = Number.parseInt(hex, 16);
    pos += 4;
    if (length === 0) break;
    if (length === 1) continue;
    if (length < 4) throw new Error(`invalid pkt-line length: ${hex}`);
    if (pos + length - 4 > body.length) throw new Error('truncated pkt-line payload');
    rawLines.push(body.subarray(pos, pos + length - 4).toString('utf8'));
    pos += length - 4;
  }
  const pack = body.subarray(pos);
  const commands: Array<{ old: string; next: string; ref: string; caps: string }> = [];
  rawLines.forEach((raw, index) => {
    const nul = raw.indexOf('\0');
    const left = (nul >= 0 ? raw.slice(0, nul) : raw).replace(/\n$/, '');
    const caps = nul >= 0 ? raw.slice(nul + 1).replace(/\n$/, '') : '';
    const tokens = left.split(' ');
    if (tokens.length !== 3) throw new Error(`invalid receive-pack command: ${left}`);
    const [old, next, ref] = tokens as [string, string, string];
    if (!/^[0-9a-f]{40}$/.test(old) || !/^[0-9a-f]{40}$/.test(next)) {
      throw new Error(`invalid oid in receive-pack command: ${left}`);
    }
    if (!ref.startsWith('refs/')) throw new Error(`invalid ref in receive-pack command: ${ref}`);
    void index;
    commands.push({ old, next, ref, caps });
  });
  if (commands.length === 0) throw new Error('no receive-pack commands');
  return { commands, pack };
}

/** report-status 响应体；协商 side-band-64k 时包进 band 1，外层再加 flush。 */
function reportStatusResponse(
  lines: string[],
  useSideband: boolean,
): GitResponse {
  const parts = lines.map((line) => pktlineEncode(line));
  parts.push(FLUSH);
  const inner = Buffer.concat(parts);
  const body = useSideband ? Buffer.concat([sidebandWrap(inner), FLUSH]) : inner;
  return {
    status: 200,
    headers: { 'content-type': 'application/x-git-receive-pack-result' },
    body,
  };
}

/** POST git-receive-pack：逐 ref 判定，部分生效，非 FF 精确报 non-fast-forward。 */
function handleReceivePack(
  repo: { git: { refs: Map<string, string>; objects: Map<string, { type: string; data: Buffer }> } },
  req: GitRequest,
): GitResponse {
  let parsed: ReturnType<typeof parseReceiveCommands>;
  try {
    parsed = parseReceiveCommands(req.body);
  } catch (err) {
    return badRequest(err instanceof Error ? err.message : 'invalid pkt-line');
  }
  const { commands, pack } = parsed;
  const caps = commands[0]?.caps ?? '';
  const useSideband = caps.split(/\s+/).includes('side-band-64k') || caps.split(/\s+/).includes('side-band');

  // 先读 pack、存对象。空 pack（无新对象）也算 unpack ok。
  if (pack.length > 0) {
    let received: Map<string, { type: string; data: Buffer }>;
    try {
      received = readPack(pack, (sha) => repo.git.objects.get(sha));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unpack failed';
      return reportStatusResponse(
        [`unpack ${message}\n`, ...commands.map((cmd) => `ng ${cmd.ref} unpack failed\n`)],
        useSideband,
      );
    }
    for (const [sha, obj] of received) {
      if (!repo.git.objects.has(sha)) repo.git.objects.set(sha, { type: obj.type, data: obj.data });
    }
  }

  const results: string[] = ['unpack ok\n'];
  for (const cmd of commands) {
    const current = repo.git.refs.get(cmd.ref) ?? ZERO_OID;
    if (cmd.old !== current) {
      results.push(`ng ${cmd.ref} old value mismatch\n`);
      continue;
    }
    if (cmd.next === ZERO_OID) {
      if (current === ZERO_OID) {
        results.push(`ng ${cmd.ref} ref does not exist\n`);
        continue;
      }
      repo.git.refs.delete(cmd.ref);
      results.push(`ok ${cmd.ref}\n`);
      continue;
    }
    if (!repo.git.objects.has(cmd.next)) {
      results.push(`ng ${cmd.ref} object not found\n`);
      continue;
    }
    if (cmd.old === ZERO_OID || cmd.next === current) {
      repo.git.refs.set(cmd.ref, cmd.next);
      results.push(`ok ${cmd.ref}\n`);
      continue;
    }
    if (isAncestor(repo.git.objects, cmd.old, cmd.next)) {
      repo.git.refs.set(cmd.ref, cmd.next);
      results.push(`ok ${cmd.ref}\n`);
    } else {
      results.push(`ng ${cmd.ref} non-fast-forward\n`);
    }
  }
  return reportStatusResponse(results, useSideband);
}

/**
 * Git smart HTTP 入口。
 *
 * 路由：/<owner>/<repo>.git/info/refs、git-upload-pack、git-receive-pack。
 * 库不存在返回 404；私有库且 owner 与 viewer 不一致时也返回 404，不泄露存在性。
 * viewerLogin 为空时按匿名处理。
 */
export async function handleGit(
  req: GitRequest,
  store: Store,
  viewerLogin: string,
): Promise<GitResponse> {
  const route = parseRoute(req.pathname);
  if (route === null) return notFound();
  const repo = store.getRepo(route.owner, route.repo);
  if (repo === undefined) return notFound();
  if (repo.private && viewerLogin !== '' && route.owner !== viewerLogin) return notFound();
  if (repo.private && viewerLogin === '') return notFound();

  try {
    if (req.method === 'GET' && route.suffix === '/info/refs') {
      const service = req.query.get('service') ?? '';
      if (service === 'git-upload-pack') {
        const protocol = getHeader(req.headers, 'git-protocol');
        const body = protocol.includes('version=2')
          ? uploadAdvertisementV2()
          : uploadAdvertisementV0(repo);
        return {
          status: 200,
          headers: { 'content-type': 'application/x-git-upload-pack-advertisement' },
          body,
        };
      }
      if (service === 'git-receive-pack') {
        return {
          status: 200,
          headers: { 'content-type': 'application/x-git-receive-pack-advertisement' },
          body: receiveAdvertisementV0(repo),
        };
      }
      return notFound();
    }

    if (req.method === 'POST' && route.suffix === '/git-upload-pack') {
      return handleUploadPack(repo, req);
    }

    if (req.method === 'POST' && route.suffix === '/git-receive-pack') {
      return handleReceivePack(repo, req);
    }
  } catch (err) {
    // 任何未预料的解析失败都不让服务端崩溃，只返回错误响应。
    return badRequest(err instanceof Error ? err.message : 'internal error');
  }
  return notFound();
}
