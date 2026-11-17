// REST v3 API 层：只用 Node 标准库 + store / git / scenario 的相对 import。
// 所有时间戳走 store.now()（逻辑时钟），不碰 Date.now() / Math.random()。

import { buildCommit, buildTree, parseCommit, parseTree, sha1 } from './git.ts';
import { Store, type Repo, type Issue, type Pull } from './store.ts';

/** handleRest 的请求入参（调用方已做认证，viewerLogin 即 token 命名的用户）。 */
export interface RestRequest {
  method: string;
  pathname: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: Buffer;
}

/** handleRest 的返回值；null 表示该路由不归 REST 管。 */
export interface RestResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

const EPOCH_MS = Date.UTC(2025, 0, 1, 0, 0, 0);

/** 请求 id 计数器：确定性递增，不用随机数。 */
let requestSeq = 0;

function nextRequestId(): string {
  requestSeq += 1;
  return `req-${requestSeq.toString(16).padStart(8, '0')}`;
}

/** ISO 时间戳换算为逻辑时钟秒数（自 2025-01-01 起）。 */
function epochSeconds(iso: string): number {
  return Math.floor((Date.parse(iso) - EPOCH_MS) / 1000);
}

/** viewer 的邮箱：与 scenario 的生成规则一致（login@example.invalid）。 */
function viewerEmail(login: string): string {
  return `${login}@example.invalid`;
}

function json(status: number, body: unknown, extraHeaders: Record<string, string> = {}): RestResponse {
  return {
    status,
    headers: {
      'content-type': 'application/json',
      'x-github-request-id': nextRequestId(),
      ...extraHeaders,
    },
    body: Buffer.from(`${JSON.stringify(body)}\n`, 'utf8'),
  };
}

function noContent(extraHeaders: Record<string, string> = {}): RestResponse {
  return {
    status: 204,
    headers: { 'x-github-request-id': nextRequestId(), ...extraHeaders },
    body: Buffer.alloc(0),
  };
}

function err(status: number, message: string): RestResponse {
  return json(status, { message });
}

const NOT_FOUND = (): RestResponse => err(404, 'Not Found');

/** 解析 JSON body：空体视为 {}；畸形 JSON 返回 400；非对象返回 400。 */
function parseBody(req: RestRequest): { ok: true; value: Record<string, unknown> } | { ok: false; res: RestResponse } {
  if (req.body.length === 0) return { ok: true, value: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(req.body.toString('utf8'));
  } catch {
    return { ok: false, res: err(400, 'Invalid JSON body') };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, res: err(400, 'Invalid JSON body') };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (value.some((item) => typeof item !== 'string')) return undefined;
  return value as string[];
}

/** 仓库对外形状。 */
function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.full_name,
    owner: { login: repo.owner },
    description: repo.description,
    private: repo.private,
    default_branch: repo.default_branch,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
  };
}

function issueJson(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    created_at: issue.created_at,
    updated_at: issue.updated_at,
  };
}

function pullJson(pull: Pull): Record<string, unknown> {
  return {
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.head.ref, sha: pull.head.sha },
    base: { ref: pull.base.ref, sha: pull.base.sha },
    merged: pull.merged,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    created_at: pull.created_at,
    updated_at: pull.updated_at,
  };
}

/** 分页参数：per_page 默认 30（1..100），page 默认 1。 */
function pagination(query: URLSearchParams): { perPage: number; page: number } {
  const rawPerPage = Number.parseInt(query.get('per_page') ?? '30', 10);
  const perPage = Number.isFinite(rawPerPage) && rawPerPage >= 1 ? Math.min(rawPerPage, 100) : 30;
  const rawPage = Number.parseInt(query.get('page') ?? '1', 10);
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1;
  return { perPage, page };
}

/**
 * 对已排好序的列表分页，并按需拼 Link 头（只在有下一页时给）。
 * 绝对 URL 用请求 Host 头拼，保留除 page/per_page 外的原查询参数。
 */
function paginate<T>(
  req: RestRequest,
  items: readonly T[],
  query: URLSearchParams,
): { pageItems: T[]; link?: string } {
  const { perPage, page } = pagination(query);
  const start = (page - 1) * perPage;
  const pageItems = items.slice(start, start + perPage);
  if (start + perPage >= items.length) return { pageItems };
  const host = req.headers['host'] ?? req.headers['Host'] ?? 'localhost';
  const params = new URLSearchParams(query);
  params.set('per_page', String(perPage));
  params.set('page', String(page + 1));
  const url = `http://${host}${req.pathname}?${params.toString()}`;
  return { pageItems, link: `<${url}>; rel="next"` };
}

function linkHeaders(link: string | undefined): Record<string, string> {
  return link === undefined ? {} : { link };
}

/** 把对象存入仓库 git.objects（已存在则不动），返回 sha。 */
function storeObject(repo: Repo, type: 'commit' | 'tree' | 'blob' | 'tag', data: Buffer): string {
  const sha = sha1(type, data);
  if (!repo.git.objects.has(sha)) repo.git.objects.set(sha, { type, data });
  return sha;
}

/** 生成一个 commit 并存入 git.objects；返回新 commit sha。 */
function createCommit(
  store: Store,
  repo: Repo,
  treeSha: string,
  parents: string[],
  message: string,
  viewerLogin: string,
): string {
  const ts = store.now();
  const epoch = epochSeconds(ts);
  const ident = `${viewerLogin} <${viewerEmail(viewerLogin)}> ${epoch} +0000`;
  const text = message.endsWith('\n') ? message : `${message}\n`;
  const data = buildCommit(treeSha, parents, ident, ident, text);
  return storeObject(repo, 'commit', data);
}

/** commit 的 API 形状：message 去掉末尾换行，author/committer 为 git 原始行。 */
function commitJson(repo: Repo, sha: string): Record<string, unknown> | null {
  const object = repo.git.objects.get(sha);
  if (!object || object.type !== 'commit') return null;
  const parsed = parseCommit(object.data);
  return {
    sha,
    commit: {
      message: parsed.message.replace(/\n$/, ''),
      author: parsed.author,
      committer: parsed.committer,
    },
    parents: parsed.parents,
  };
}

/** 从 tip 沿第一 parent 链取历史（最新在前）。 */
function commitHistory(repo: Repo, tipSha: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let current: string | undefined = tipSha;
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    const object = repo.git.objects.get(current);
    if (!object || object.type !== 'commit') break;
    out.push(current);
    current = parseCommit(object.data).parents[0];
  }
  return out;
}

/** 某 commit 全部祖先（含自身）。 */
function ancestors(repo: Repo, tipSha: string): Set<string> {
  const seen = new Set<string>();
  const stack = [tipSha];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const object = repo.git.objects.get(sha);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return seen;
}

/** 分支 tip 的 commit sha；分支不存在返回 undefined。 */
function branchTip(repo: Repo, branch: string): string | undefined {
  return repo.git.refs.get(`refs/heads/${branch}`);
}

/** 递归把 tree 拍平成 path -> {sha, mode}。 */
function flattenTree(
  repo: Repo,
  treeSha: string,
  prefix: string,
  out: Map<string, { sha: string; mode: string }>,
): void {
  const object = repo.git.objects.get(treeSha);
  if (!object || object.type !== 'tree') return;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(repo, entry.oid, path, out);
    else out.set(path, { sha: entry.oid, mode: entry.mode });
  }
}

/** 在指定 tree 里找路径对应的条目；找不到返回 null。 */
function findPathEntry(
  repo: Repo,
  treeSha: string,
  segments: readonly string[],
): { mode: string; name: string; oid: string } | null {
  let currentTree = treeSha;
  for (let i = 0; i < segments.length; i += 1) {
    const object = repo.git.objects.get(currentTree);
    if (!object || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((item) => item.name === segments[i]);
    if (!entry) return null;
    if (i === segments.length - 1) return entry;
    if (entry.mode !== '40000') return null;
    currentTree = entry.oid;
  }
  return null;
}

/**
 * 在 tree 里设置/删除一条路径，递归重建父 tree。
 * 返回 {sha, empty}：empty 表示结果是空 tree（删除后目录变空时父级据此删条目）。
 */
function setPathInTree(
  repo: Repo,
  treeSha: string | null,
  segments: readonly string[],
  blobSha: string | null,
): { sha: string; empty: boolean } {
  const entries =
    treeSha === null
      ? []
      : (() => {
          const object = repo.git.objects.get(treeSha);
          if (!object || object.type !== 'tree') return [];
          return parseTree(object.data);
        })();
  const [head, ...rest] = segments as [string, ...string[]];
  const idx = entries.findIndex((item) => item.name === head);
  if (rest.length === 0) {
    if (blobSha === null) {
      if (idx >= 0) entries.splice(idx, 1);
    } else if (idx >= 0) {
      entries[idx] = { mode: '100644', name: head, oid: blobSha };
    } else {
      entries.push({ mode: '100644', name: head, oid: blobSha });
    }
  } else {
    const existing = idx >= 0 ? entries[idx] : undefined;
    const childTree = existing !== undefined && existing.mode === '40000' ? existing.oid : null;
    const child = setPathInTree(repo, childTree, rest, blobSha);
    if (blobSha === null && child.empty) {
      if (idx >= 0) entries.splice(idx, 1);
    } else if (idx >= 0) {
      entries[idx] = { mode: '40000', name: head, oid: child.sha };
    } else {
      entries.push({ mode: '40000', name: head, oid: child.sha });
    }
  }
  if (entries.length === 0) {
    return { sha: storeObject(repo, 'tree', Buffer.alloc(0)), empty: true };
  }
  return { sha: storeObject(repo, 'tree', buildTree(entries)), empty: false };
}

/** 文本按行切分（末尾换行不产生空行；空串为 0 行）。 */
function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** 两段文本的行级 diff：additions/deletions 由 LCS 长度算出。 */
function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const n = oldLines.length;
  const m = newLines.length;
  if (n * m > 100_000) {
    // 大文件退化为多重集比较，避免 O(n*m) 爆炸。
    const oldCounts = new Map<string, number>();
    for (const line of oldLines) oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
    let common = 0;
    for (const line of newLines) {
      const count = oldCounts.get(line) ?? 0;
      if (count > 0) {
        oldCounts.set(line, count - 1);
        common += 1;
      }
    }
    return { additions: m - common, deletions: n - common };
  }
  let prev = new Array<number>(m + 1).fill(0);
  let curr = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      curr[j] =
        oldLines[i - 1] === newLines[j - 1]
          ? (prev[j - 1] as number) + 1
          : Math.max(prev[j] as number, curr[j - 1] as number);
    }
    [prev, curr] = [curr, prev];
    curr.fill(0);
  }
  const lcs = prev[m] as number;
  return { additions: m - lcs, deletions: n - lcs };
}

/** 路由段：去掉首尾斜杠后按 "/" 切分并逐段解码。 */
function segmentsOf(pathname: string): string[] {
  const trimmed = pathname.replace(/^\/+|\/+$/g, '');
  if (trimmed === '') return [];
  return trimmed.split('/').map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  });
}

function isDigits(text: string): boolean {
  return /^\d+$/.test(text);
}

/**
 * REST v3 入口。返回 null 表示该路由不归 REST 管（调用方按 404 处理）。
 * owner 不是 viewer 时一律 404，绝不 403。
 */
export async function handleRest(
  req: RestRequest,
  store: Store,
  viewerLogin: string,
): Promise<RestResponse | null> {
  const segments = segmentsOf(req.pathname);
  if (segments[0] !== 'api' || segments[1] !== 'v3') return null;
  const rest = segments.slice(2);
  const method = req.method.toUpperCase();

  // GET /api/v3/ — API 根，带 OAuth scopes。
  if (rest.length === 0) {
    if (method !== 'GET') return null;
    return json(
      200,
      { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  }

  // GET /api/v3/meta
  if (rest.length === 1 && rest[0] === 'meta') {
    if (method !== 'GET') return null;
    return json(200, { installed_version: '1.0.0' });
  }

  // GET /api/v3/user
  if (rest.length === 1 && rest[0] === 'user') {
    if (method !== 'GET') return null;
    return json(200, { login: viewerLogin, id: 1000, type: 'User' });
  }

  // /api/v3/user/repos
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'GET') {
      const owned = [...store.repos.values()]
        .filter((repo) => repo.owner === viewerLogin)
        .map(repoJson);
      const { pageItems, link } = paginate(req, owned, req.query);
      return json(200, pageItems, linkHeaders(link));
    }
    if (method === 'POST') {
      const parsed = parseBody(req);
      if (!parsed.ok) return parsed.res;
      const body = parsed.value;
      const name = asString(body['name']);
      if (name === undefined || name === '') return err(422, 'name is required');
      if (store.getRepo(viewerLogin, name) !== undefined) {
        return err(422, 'Repository already exists');
      }
      const repo = store.createRepo(
        viewerLogin,
        name,
        asString(body['description']) ?? '',
        asBool(body['private']) ?? false,
      );
      return json(201, repoJson(repo));
    }
    return null;
  }

  // 以下均为 /api/v3/repos/{owner}/{repo}[...]
  if (rest.length < 3 || rest[0] !== 'repos') return null;
  const owner = rest[1] as string;
  const repoName = rest[2] as string;
  const tail = rest.slice(3);

  // owner 不是 viewer：一律 404（绝不 403），且不透露库是否存在。
  if (owner !== viewerLogin) return NOT_FOUND();
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return NOT_FOUND();
  const repoKey = Store.repoKey(owner, repoName);

  // GET/PATCH/DELETE /api/v3/repos/{owner}/{repo}
  if (tail.length === 0) {
    if (method === 'GET') return json(200, repoJson(repo));
    if (method === 'PATCH') {
      const parsed = parseBody(req);
      if (!parsed.ok) return parsed.res;
      const description = asString(parsed.value['description']);
      if (description !== undefined) {
        repo.description = description;
        repo.updated_at = store.nowPeek();
      }
      return json(200, repoJson(repo));
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, repoName);
      return noContent();
    }
    return null;
  }

  // GET /api/v3/repos/{owner}/{repo}/branches
  if (tail.length === 1 && tail[0] === 'branches') {
    if (method !== 'GET') return null;
    const branches = [...repo.git.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/heads/'))
      .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha } }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return json(200, branches);
  }

  // GET /api/v3/repos/{owner}/{repo}/branches/{branch}
  if (tail.length >= 2 && tail[0] === 'branches') {
    if (method !== 'GET') return null;
    const branch = tail.slice(1).join('/');
    const tip = branchTip(repo, branch);
    if (tip === undefined) return NOT_FOUND();
    return json(200, { name: branch, commit: { sha: tip } });
  }

  // POST /api/v3/repos/{owner}/{repo}/git/refs
  if (tail.length === 2 && tail[0] === 'git' && tail[1] === 'refs') {
    if (method !== 'POST') return null;
    const parsed = parseBody(req);
    if (!parsed.ok) return parsed.res;
    const ref = asString(parsed.value['ref']);
    const sha = asString(parsed.value['sha']);
    if (ref === undefined || !ref.startsWith('refs/heads/') || ref === 'refs/heads/') {
      return err(422, 'ref must be refs/heads/<branch>');
    }
    if (sha === undefined || sha === '') return err(422, 'sha is required');
    const object = repo.git.objects.get(sha);
    if (!object || object.type !== 'commit') return err(422, 'sha is not an existing commit');
    if (repo.git.refs.has(ref)) return err(422, 'Reference already exists');
    repo.git.refs.set(ref, sha);
    return json(201, { ref, object: { sha } });
  }

  // GET /api/v3/repos/{owner}/{repo}/git/refs/heads/{branch}
  if (tail.length >= 4 && tail[0] === 'git' && tail[1] === 'refs' && tail[2] === 'heads') {
    if (method !== 'GET') return null;
    const branch = tail.slice(3).join('/');
    const tip = branchTip(repo, branch);
    if (tip === undefined) return NOT_FOUND();
    return json(200, { ref: `refs/heads/${branch}`, object: { sha: tip } });
  }

  // GET /api/v3/repos/{owner}/{repo}/commits （列表）
  if (tail.length === 1 && tail[0] === 'commits') {
    if (method !== 'GET') return null;
    const branch = req.query.get('sha') ?? repo.default_branch;
    const tip = branchTip(repo, branch);
    if (tip === undefined) return NOT_FOUND();
    const list = commitHistory(repo, tip)
      .map((sha) => commitJson(repo, sha))
      .filter((item): item is Record<string, unknown> => item !== null);
    return json(200, list);
  }

  // GET /api/v3/repos/{owner}/{repo}/commits/{sha}
  if (tail.length === 2 && tail[0] === 'commits') {
    if (method !== 'GET') return null;
    const sha = tail[1] as string;
    let found = commitJson(repo, sha);
    if (found === null) {
      const tip = branchTip(repo, sha);
      if (tip !== undefined) found = commitJson(repo, tip);
    }
    if (found === null) return NOT_FOUND();
    return json(200, found);
  }

  // /api/v3/repos/{owner}/{repo}/contents/{path...}
  if (tail.length >= 1 && tail[0] === 'contents') {
    const pathSegments = tail.slice(1);
    const path = pathSegments.join('/');
    if (method === 'GET') {
      const refName = req.query.get('ref') ?? repo.default_branch;
      const tip = branchTip(repo, refName);
      if (tip === undefined) return NOT_FOUND();
      const tipObject = repo.git.objects.get(tip);
      if (!tipObject || tipObject.type !== 'commit') return NOT_FOUND();
      const treeSha = parseCommit(tipObject.data).tree;
      if (pathSegments.length === 0) {
        const object = repo.git.objects.get(treeSha);
        if (!object || object.type !== 'tree') return NOT_FOUND();
        const items = parseTree(object.data).map((entry) => ({
          type: entry.mode === '40000' ? 'dir' : 'file',
          name: entry.name,
          path: entry.name,
          sha: entry.oid,
        }));
        return json(200, items);
      }
      const entry = findPathEntry(repo, treeSha, pathSegments);
      if (entry === null) return NOT_FOUND();
      if (entry.mode === '40000') {
        const object = repo.git.objects.get(entry.oid);
        if (!object || object.type !== 'tree') return NOT_FOUND();
        const items = parseTree(object.data).map((child) => ({
          type: child.mode === '40000' ? 'dir' : 'file',
          name: child.name,
          path: `${path}/${child.name}`,
          sha: child.oid,
        }));
        return json(200, items);
      }
      const blob = repo.git.objects.get(entry.oid);
      if (!blob || blob.type !== 'blob') return NOT_FOUND();
      return json(200, {
        type: 'file',
        encoding: 'base64',
        content: blob.data.toString('base64'),
        sha: entry.oid,
        size: blob.data.length,
        name: pathSegments[pathSegments.length - 1],
        path,
      });
    }
    if (method === 'PUT') {
      const parsed = parseBody(req);
      if (!parsed.ok) return parsed.res;
      const body = parsed.value;
      const message = asString(body['message']);
      const contentB64 = asString(body['content']);
      if (message === undefined || message === '') return err(422, 'message is required');
      if (contentB64 === undefined) return err(422, 'content is required');
      const contentBytes = Buffer.from(contentB64.replace(/\s/g, ''), 'base64');
      const branch = asString(body['branch']) ?? repo.default_branch;
      const givenSha = asString(body['sha']);
      let tip = branchTip(repo, branch);
      if (tip === undefined) {
        // 空库：允许在尚无任何 ref 时创建首个 commit；已有其他分支时该分支不存在。
        if (repo.git.refs.size !== 0) return NOT_FOUND();
      }
      let currentTreeSha: string | null = null;
      let currentBlobSha: string | undefined;
      let existed = false;
      if (tip !== undefined) {
        const tipObject = repo.git.objects.get(tip);
        if (!tipObject || tipObject.type !== 'commit') return NOT_FOUND();
        currentTreeSha = parseCommit(tipObject.data).tree;
        const entry = findPathEntry(repo, currentTreeSha, pathSegments);
        if (entry !== null && entry.mode !== '40000') {
          existed = true;
          currentBlobSha = entry.oid;
        }
      }
      if (givenSha !== undefined && givenSha !== currentBlobSha) {
        return err(409, 'sha does not match the current file');
      }
      const blobSha = storeObject(repo, 'blob', contentBytes);
      const newTree = setPathInTree(repo, currentTreeSha, pathSegments, blobSha);
      const parents = tip !== undefined ? [tip] : [];
      const commitSha = createCommit(store, repo, newTree.sha, parents, message, viewerLogin);
      repo.git.refs.set(`refs/heads/${branch}`, commitSha);
      repo.updated_at = store.nowPeek();
      return json(existed ? 200 : 201, {
        content: {
          name: pathSegments[pathSegments.length - 1],
          path,
          sha: blobSha,
          size: contentBytes.length,
          type: 'file',
          encoding: 'base64',
        },
        commit: { sha: commitSha },
      });
    }
    if (method === 'DELETE') {
      const parsed = parseBody(req);
      if (!parsed.ok) return parsed.res;
      const body = parsed.value;
      const message = asString(body['message']) ?? `Delete ${path}`;
      const givenSha = asString(body['sha']);
      if (givenSha === undefined || givenSha === '') return err(422, 'sha is required');
      const branch = asString(body['branch']) ?? repo.default_branch;
      const tip = branchTip(repo, branch);
      if (tip === undefined) return NOT_FOUND();
      const tipObject = repo.git.objects.get(tip);
      if (!tipObject || tipObject.type !== 'commit') return NOT_FOUND();
      const treeSha = parseCommit(tipObject.data).tree;
      const entry = findPathEntry(repo, treeSha, pathSegments);
      if (entry === null || entry.mode === '40000') return NOT_FOUND();
      if (entry.oid !== givenSha) return err(409, 'sha does not match the current file');
      const newTree = setPathInTree(repo, treeSha, pathSegments, null);
      const commitSha = createCommit(store, repo, newTree.sha, [tip], message, viewerLogin);
      repo.git.refs.set(`refs/heads/${branch}`, commitSha);
      repo.updated_at = store.nowPeek();
      return json(200, { commit: { sha: commitSha } });
    }
    return null;
  }

  // POST /api/v3/repos/{owner}/{repo}/labels
  if (tail.length === 1 && tail[0] === 'labels') {
    if (method !== 'POST') return null;
    const parsed = parseBody(req);
    if (!parsed.ok) return parsed.res;
    const name = asString(parsed.value['name']);
    if (name === undefined || name === '') return err(422, 'name is required');
    const color = asString(parsed.value['color']) ?? 'ffffff';
    let labelMap = store.labels.get(repoKey);
    if (labelMap === undefined) {
      labelMap = new Map();
      store.labels.set(repoKey, labelMap);
    }
    labelMap.set(name, { name, color });
    return json(201, { name, color });
  }

  // GET/POST /api/v3/repos/{owner}/{repo}/issues
  if (tail.length === 2 && tail[0] === 'issues' && isDigits(tail[1] as string)) {
    // 由下方的 issues/{number} 分支处理；此处不匹配。
  } else if (tail.length === 1 && tail[0] === 'issues') {
    if (method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      const sort = req.query.get('sort') ?? 'created';
      const direction = req.query.get('direction') ?? 'desc';
      const issueMap = store.issues.get(repoKey);
      let list = issueMap === undefined ? [] : [...issueMap.values()];
      if (state === 'open' || state === 'closed') {
        list = list.filter((issue) => issue.state === state);
      } else if (state !== 'all') {
        return err(422, 'state must be open, closed or all');
      }
      if (sort === 'created') {
        const dir = direction === 'asc' ? 1 : -1;
        list.sort((a, b) => {
          if (a.created_at !== b.created_at) {
            return a.created_at < b.created_at ? -dir : dir;
          }
          return (a.number - b.number) * dir;
        });
      }
      const { pageItems, link } = paginate(req, list.map(issueJson), req.query);
      return json(200, pageItems, linkHeaders(link));
    }
    if (method === 'POST') {
      const parsed = parseBody(req);
      if (!parsed.ok) return parsed.res;
      const body = parsed.value;
      const title = asString(body['title']);
      if (title === undefined || title === '') return err(422, 'title is required');
      const labelNames = asStringArray(body['labels']) ?? [];
      const labelMap = store.labels.get(repoKey);
      for (const labelName of labelNames) {
        if (labelMap === undefined || !labelMap.has(labelName)) {
          return err(422, `Label does not exist: ${labelName}`);
        }
      }
      const number = store.nextIssueNumber(owner, repoName);
      const ts = store.now();
      const issue: Issue = {
        id: store.nextIssueId(),
        number,
        title,
        body: asString(body['body']) ?? '',
        state: 'open',
        labels: [...labelNames],
        created_at: ts,
        updated_at: ts,
      };
      let issueMap = store.issues.get(repoKey);
      if (issueMap === undefined) {
        issueMap = new Map();
        store.issues.set(repoKey, issueMap);
      }
      issueMap.set(number, issue);
      return json(201, issueJson(issue));
    }
    return null;
  }

  // GET/PATCH /api/v3/repos/{owner}/{repo}/issues/{number}
  // POST/GET /api/v3/repos/{owner}/{repo}/issues/{number}/comments
  if (tail.length >= 2 && tail[0] === 'issues' && isDigits(tail[1] as string)) {
    const number = Number.parseInt(tail[1] as string, 10);
    const issueMap = store.issues.get(repoKey);
    const issue = issueMap?.get(number);
    if (tail.length === 2) {
      if (method === 'GET') {
        if (issue === undefined) return NOT_FOUND();
        return json(200, issueJson(issue));
      }
      if (method === 'PATCH') {
        if (issue === undefined) return NOT_FOUND();
        const parsed = parseBody(req);
        if (!parsed.ok) return parsed.res;
        const state = asString(parsed.value['state']);
        if (state !== undefined) {
          if (state !== 'open' && state !== 'closed') return err(422, 'state must be open or closed');
          issue.state = state;
          issue.updated_at = store.now();
        }
        return json(200, issueJson(issue));
      }
      return null;
    }
    if (tail.length === 3 && tail[2] === 'comments') {
      if (issue === undefined) return NOT_FOUND();
      const commentKey = Store.issueKey(owner, repoName, number);
      if (method === 'GET') {
        const list = store.comments.get(commentKey) ?? [];
        return json(
          200,
          list.map((comment) => ({ id: comment.id, body: comment.body, created_at: comment.created_at })),
        );
      }
      if (method === 'POST') {
        const parsed = parseBody(req);
        if (!parsed.ok) return parsed.res;
        const commentBody = asString(parsed.value['body']);
        if (commentBody === undefined || commentBody === '') return err(422, 'body is required');
        const comment = { id: store.nextCommentId(), body: commentBody, created_at: store.now() };
        let list = store.comments.get(commentKey);
        if (list === undefined) {
          list = [];
          store.comments.set(commentKey, list);
        }
        list.push(comment);
        return json(201, { id: comment.id, body: comment.body, created_at: comment.created_at });
      }
      return null;
    }
    return null;
  }

  // GET/POST /api/v3/repos/{owner}/{repo}/pulls
  if (tail.length === 1 && tail[0] === 'pulls') {
    if (method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      const pullMap = store.pulls.get(repoKey);
      let list = pullMap === undefined ? [] : [...pullMap.values()];
      if (state === 'open' || state === 'closed') {
        list = list.filter((pull) => pull.state === state);
      } else if (state !== 'all') {
        return err(422, 'state must be open, closed or all');
      }
      list.sort((a, b) => a.number - b.number);
      const { pageItems, link } = paginate(req, list.map(pullJson), req.query);
      return json(200, pageItems, linkHeaders(link));
    }
    if (method === 'POST') {
      const parsed = parseBody(req);
      if (!parsed.ok) return parsed.res;
      const body = parsed.value;
      const head = asString(body['head']);
      const base = asString(body['base']);
      const title = asString(body['title']);
      if (head === undefined || head === '') return err(422, 'head is required');
      if (base === undefined || base === '') return err(422, 'base is required');
      if (title === undefined || title === '') return err(422, 'title is required');
      const headSha = branchTip(repo, head);
      if (headSha === undefined) return err(422, 'head branch does not exist');
      const baseSha = branchTip(repo, base);
      if (baseSha === undefined) return err(422, 'base branch does not exist');
      const number = store.nextPullNumber(owner, repoName);
      const ts = store.now();
      const pull: Pull = {
        number,
        title,
        body: asString(body['body']) ?? '',
        state: 'open',
        merged: false,
        merged_at: null,
        merge_commit_sha: null,
        head: { ref: head, sha: headSha },
        base: { ref: base, sha: baseSha },
        created_at: ts,
        updated_at: ts,
      };
      let pullMap = store.pulls.get(repoKey);
      if (pullMap === undefined) {
        pullMap = new Map();
        store.pulls.set(repoKey, pullMap);
      }
      pullMap.set(number, pull);
      return json(201, pullJson(pull));
    }
    return null;
  }

  // /api/v3/repos/{owner}/{repo}/pulls/{number}[...]
  if (tail.length >= 2 && tail[0] === 'pulls' && isDigits(tail[1] as string)) {
    const number = Number.parseInt(tail[1] as string, 10);
    const pullMap = store.pulls.get(repoKey);
    const pull = pullMap?.get(number);
    if (tail.length === 2) {
      if (method !== 'GET') return null;
      if (pull === undefined) return NOT_FOUND();
      return json(200, pullJson(pull));
    }
    if (tail.length === 3 && tail[2] === 'files') {
      if (method !== 'GET') return null;
      if (pull === undefined) return NOT_FOUND();
      const headCommit = repo.git.objects.get(pull.head.sha);
      const baseCommit = repo.git.objects.get(pull.base.sha);
      if (!headCommit || headCommit.type !== 'commit' || !baseCommit || baseCommit.type !== 'commit') {
        return NOT_FOUND();
      }
      const headFiles = new Map<string, { sha: string; mode: string }>();
      const baseFiles = new Map<string, { sha: string; mode: string }>();
      flattenTree(repo, parseCommit(headCommit.data).tree, '', headFiles);
      flattenTree(repo, parseCommit(baseCommit.data).tree, '', baseFiles);
      const allPaths = [...new Set([...headFiles.keys(), ...baseFiles.keys()])].sort();
      const files = allPaths.flatMap((filename) => {
        const headEntry = headFiles.get(filename);
        const baseEntry = baseFiles.get(filename);
        if (headEntry !== undefined && baseEntry !== undefined && headEntry.sha === baseEntry.sha) {
          return [];
        }
        const oldText =
          baseEntry === undefined
            ? ''
            : (repo.git.objects.get(baseEntry.sha)?.data.toString('utf8') ?? '');
        const newText =
          headEntry === undefined
            ? ''
            : (repo.git.objects.get(headEntry.sha)?.data.toString('utf8') ?? '');
        const { additions, deletions } = lineDiff(oldText, newText);
        const status = headEntry === undefined ? 'removed' : baseEntry === undefined ? 'added' : 'modified';
        return [{ filename, status, additions, deletions, changes: additions + deletions }];
      });
      return json(200, files);
    }
    if (tail.length === 3 && tail[2] === 'merge') {
      if (method !== 'PUT') return null;
      if (pull === undefined) return NOT_FOUND();
      if (pull.merged) return err(405, 'Pull request has already been merged');
      const parsed = parseBody(req);
      if (!parsed.ok) return parsed.res;
      void parsed.value;
      const headTip = branchTip(repo, pull.head.ref) ?? pull.head.sha;
      const baseTip = branchTip(repo, pull.base.ref) ?? pull.base.sha;
      const headCommit = repo.git.objects.get(headTip);
      const baseCommit = repo.git.objects.get(baseTip);
      if (!headCommit || headCommit.type !== 'commit' || !baseCommit || baseCommit.type !== 'commit') {
        return NOT_FOUND();
      }
      // merge-base：沿 head 祖先链找第一个同时是 base 祖先的 commit。
      const baseAncestors = ancestors(repo, baseTip);
      let mergeBase: string | null = null;
      const seen = new Set<string>();
      const stack = [headTip];
      while (stack.length > 0) {
        const sha = stack.pop() as string;
        if (seen.has(sha)) continue;
        seen.add(sha);
        if (baseAncestors.has(sha)) {
          mergeBase = sha;
          break;
        }
        const object = repo.git.objects.get(sha);
        if (!object || object.type !== 'commit') continue;
        for (const parent of parseCommit(object.data).parents) stack.push(parent);
      }
      const baseTreeOf = (commitSha: string | null): Map<string, { sha: string; mode: string }> => {
        const out = new Map<string, { sha: string; mode: string }>();
        if (commitSha === null) return out;
        const object = repo.git.objects.get(commitSha);
        if (!object || object.type !== 'commit') return out;
        flattenTree(repo, parseCommit(object.data).tree, '', out);
        return out;
      };
      const mergeBaseFiles = baseTreeOf(mergeBase);
      const headFiles = baseTreeOf(headTip);
      const baseFiles = baseTreeOf(baseTip);
      const allPaths = new Set([...mergeBaseFiles.keys(), ...headFiles.keys(), ...baseFiles.keys()]);
      for (const filename of allPaths) {
        const atBase = mergeBaseFiles.get(filename)?.sha;
        const atHead = headFiles.get(filename)?.sha;
        const atBaseBranch = baseFiles.get(filename)?.sha;
        const headChanged = atHead !== atBase;
        const baseChanged = atBaseBranch !== atBase;
        if (headChanged && baseChanged && atHead !== atBaseBranch) {
          return err(405, `Merge conflict: ${filename} was changed on both sides`);
        }
      }
      const headTree = parseCommit(headCommit.data).tree;
      const commitSha = createCommit(store, repo, headTree, [baseTip], pull.title, viewerLogin);
      repo.git.refs.set(`refs/heads/${pull.base.ref}`, commitSha);
      repo.updated_at = store.nowPeek();
      pull.state = 'closed';
      pull.merged = true;
      pull.merged_at = store.now();
      pull.merge_commit_sha = commitSha;
      pull.updated_at = store.nowPeek();
      return json(200, { merged: true, sha: commitSha, message: pull.title });
    }
    return null;
  }

  return null;
}
