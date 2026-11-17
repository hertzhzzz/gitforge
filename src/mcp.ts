// MCP 层：JSON-RPC 2.0 over Streamable HTTP（POST /mcp）。
// 只用 Node 标准库 + Store。与 REST 共用同一个 Store 实例，
// 所以 MCP 建的 repo / issue / PR，REST 读回来的 id 与内容一致。
// 确定性：不用 Date.now() / Math.random()；时间戳走 Store 的逻辑时钟。

import { createHash } from 'node:crypto';
import { Store } from './store.ts';
import type { Issue, Pull, Repo } from './store.ts';

/** handleMcp 的请求形状（由 app.ts 的 HTTP 层组装后传入）。 */
export interface McpRequest {
  method: string;
  pathname: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: Buffer;
}

/** handleMcp 的返回形状；null 表示不是 MCP 路由。 */
export interface McpResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

type RpcId = string | number | null;

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required: string[];
  };
}

/** 工具表：固定顺序、固定内容，两次 tools/list 返回字节相同。 */
const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name.' },
        description: { type: 'string', description: 'Repository description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Issue title.' },
        body: { type: 'string', description: 'Issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        state: { type: 'string', description: 'Issue state filter: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Pull request title.' },
        head: { type: 'string', description: 'Head branch name.' },
        base: { type: 'string', description: 'Base branch name.' },
        body: { type: 'string', description: 'Pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit onto its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        pull_number: { type: 'integer', description: 'Pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

/** 别名（归一化后）-> 规范工具名。 */
const ALIASES: Readonly<Record<string, string>> = {
  createrepository: 'create_repo',
  repocreate: 'create_repo',
  reposcreate: 'create_repo',
  repositorycreate: 'create_repo',
  getrepository: 'get_repo',
  repoget: 'get_repo',
  issuecreate: 'create_issue',
  issuescreate: 'create_issue',
  issueslist: 'list_issues',
  issuelist: 'list_issues',
  pullrequestcreate: 'create_pull_request',
  pullscreate: 'create_pull_request',
  createpr: 'create_pull_request',
  prcreate: 'create_pull_request',
  pullrequestmerge: 'merge_pull_request',
  pullsmerge: 'merge_pull_request',
  mergepr: 'merge_pull_request',
  prmerge: 'merge_pull_request',
};

/** 语义键 -> 可接受的参数名（按顺序取第一个命中的）。 */
const SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  owner: ['owner', 'owner_login', 'org', 'user', 'login', 'account'],
  repo: ['repo', 'repository', 'repository_name', 'repo_name'],
  title: ['title', 'issue_title', 'subject'],
  body: ['body', 'issue_body', 'description', 'content', 'text'],
  head: ['head', 'head_ref', 'head_branch', 'source_branch'],
  base: ['base', 'base_ref', 'base_branch', 'target_branch'],
  pull_number: ['pull_number', 'pull_request_number', 'pr_number', 'number'],
  name: ['name', 'repo', 'repository'],
  description: ['description', 'about', 'summary', 'body'],
  private: ['private', 'is_private'],
  state: ['state', 'status'],
};

const JSON_HEADERS: Record<string, string> = {
  'content-type': 'application/json',
};

/** 把任意值包成一帧 HTTP JSON 响应。 */
function httpJson(status: number, payload: unknown): McpResponse {
  return {
    status,
    headers: { ...JSON_HEADERS },
    body: Buffer.from(JSON.stringify(payload), 'utf8'),
  };
}

/** JSON-RPC 成功帧。 */
function rpcResult(id: RpcId, result: unknown): McpResponse {
  return httpJson(200, { jsonrpc: '2.0', id, result });
}

/** JSON-RPC 错误帧（HTTP 200，错误在 error 字段里）。 */
function rpcError(id: RpcId, code: number, message: string): McpResponse {
  return httpJson(200, { jsonrpc: '2.0', id, error: { code, message } });
}

/** 工具成功结果帧。 */
function toolResult(
  id: RpcId,
  text: string,
  structured?: Record<string, JsonValue>,
): McpResponse {
  const result: Record<string, unknown> = {
    content: [{ type: 'text', text }],
  };
  if (structured !== undefined) result.structuredContent = structured;
  return rpcResult(id, result);
}

/** 工具业务错误结果帧（isError，不抛 HTTP 错误）。 */
function toolError(id: RpcId, message: string): McpResponse {
  return rpcResult(id, {
    content: [{ type: 'text', text: message }],
    isError: true,
  });
}

/** 归一化工具名：小写，删掉非 [a-z0-9] 的字符。 */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** 按精确（大小写不敏感）-> 别名 -> 后缀匹配解析工具名。 */
function resolveTool(name: unknown): string | null {
  if (typeof name !== 'string' || name.length === 0) return null;
  const lower = name.toLowerCase();
  for (const tool of TOOLS) {
    if (tool.name.toLowerCase() === lower) return tool.name;
  }
  const normalized = normalizeName(name);
  const aliased = ALIASES[normalized];
  if (aliased !== undefined) return aliased;
  for (const tool of TOOLS) {
    const canonical = normalizeName(tool.name);
    if (normalized.length > canonical.length && normalized.endsWith(canonical)) {
      return tool.name;
    }
  }
  return null;
}

/** 从原始参数里按同义词表取出语义键的值；schema 没有的属性会被丢弃。 */
function mapArgs(
  tool: ToolDef,
  raw: unknown,
): Record<string, unknown> {
  const source: Record<string, unknown> =
    raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const out: Record<string, unknown> = {};
  const schemaProps = new Set(Object.keys(tool.inputSchema.properties));
  for (const key of Object.keys(SYNONYMS)) {
    if (!schemaProps.has(key)) continue;
    for (const candidate of SYNONYMS[key] as readonly string[]) {
      if (source[candidate] !== undefined) {
        out[key] = source[candidate];
        break;
      }
    }
  }
  // full_name 特殊处理：schema 有 full_name 且无 repo 时才填 "owner/repo"。
  if (schemaProps.has('full_name') && !schemaProps.has('repo')) {
    const owner = out.owner;
    const repo = out.repo;
    if (typeof owner === 'string' && typeof repo === 'string') {
      out.full_name = `${owner}/${repo}`;
    }
  }
  return out;
}

/** 检查必需参数是否齐全；返回缺失的参数名列表。 */
function missingRequired(tool: ToolDef, args: Record<string, unknown>): string[] {
  const missing: string[] = [];
  for (const key of tool.inputSchema.required) {
    const value = args[key];
    if (value === undefined || value === null) {
      missing.push(key);
    } else if (typeof value === 'string' && value.length === 0) {
      missing.push(key);
    }
  }
  return missing;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return false;
}

function asPullNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10);
  }
  return null;
}

/** 从 headers 里取 Authorization（键名大小写不敏感）。 */
function hasAuth(headers: Record<string, string>): boolean {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === 'authorization') {
      return (headers[key] as string).trim().length > 0;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// git 对象小工具（merge 用；只用 node:crypto，不引 git.ts）
// ---------------------------------------------------------------------------

function sha1(type: string, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

function parseCommitParents(data: Buffer): string[] {
  const sep = data.indexOf('\n\n');
  const headerPart = sep >= 0 ? data.subarray(0, sep) : data;
  const parents: string[] = [];
  for (const line of headerPart.toString('utf8').split('\n')) {
    if (line.startsWith('parent ')) parents.push(line.slice(7));
  }
  return parents;
}

function parseCommitTree(data: Buffer): string {
  const sep = data.indexOf('\n\n');
  const headerPart = sep >= 0 ? data.subarray(0, sep) : data;
  for (const line of headerPart.toString('utf8').split('\n')) {
    if (line.startsWith('tree ')) return line.slice(5);
  }
  return '';
}

interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('malformed tree: missing space after mode');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('malformed tree: missing NUL after name');
    entries.push({
      mode: data.subarray(offset, space).toString('utf8'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

function treeSortKey(entry: { mode: string; name: string }): Buffer {
  return Buffer.from(entry.mode === '40000' ? `${entry.name}/` : entry.name, 'utf8');
}

function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => Buffer.compare(treeSortKey(a), treeSortKey(b)));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

function buildCommit(
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
  return Buffer.concat([Buffer.from(`${header}\n`, 'utf8'), Buffer.from(message, 'utf8')]);
}

/** 把一棵 tree 拍平成 path -> {mode, oid}（递归进子目录）。 */
function flattenTree(
  repo: Repo,
  treeSha: string,
  prefix: string,
  out: Map<string, { mode: string; oid: string }>,
): void {
  const object = repo.git.objects.get(treeSha);
  if (!object || object.type !== 'tree') return;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      flattenTree(repo, entry.oid, path, out);
    } else {
      out.set(path, { mode: entry.mode, oid: entry.oid });
    }
  }
}

/** 把拍平的文件表重建成嵌套 tree，对象写回 repo，返回根 tree sha。 */
function buildTreeFromFlat(
  repo: Repo,
  flat: Map<string, { mode: string; oid: string }>,
): string {
  interface DirNode {
    files: TreeEntry[];
    dirs: Map<string, DirNode>;
  }
  const root: DirNode = { files: [], dirs: new Map() };
  for (const [path, value] of [...flat.entries()].sort()) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i] as string;
      let child = node.dirs.get(part);
      if (!child) {
        child = { files: [], dirs: new Map() };
        node.dirs.set(part, child);
      }
      node = child;
    }
    node.files.push({
      mode: value.mode,
      name: parts[parts.length - 1] as string,
      oid: value.oid,
    });
  }
  const writeDir = (node: DirNode): string => {
    const entries: TreeEntry[] = [...node.files];
    for (const [name, child] of [...node.dirs.entries()].sort()) {
      entries.push({ mode: '40000', name, oid: writeDir(child) });
    }
    const data = buildTree(entries);
    const oid = sha1('tree', data);
    repo.git.objects.set(oid, { type: 'tree', data });
    return oid;
  };
  return writeDir(root);
}

/** 沿 parent 链收集某 commit 的全部祖先（含自身）。 */
function collectAncestors(repo: Repo, tip: string): Set<string> {
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const object = repo.git.objects.get(sha);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommitParents(object.data)) stack.push(parent);
  }
  return seen;
}

/** 找 merge-base：base 祖先链上第一个也是 head 祖先的 commit。 */
function findMergeBase(repo: Repo, headSha: string, baseSha: string): string | null {
  const headAncestors = collectAncestors(repo, headSha);
  const stack = [baseSha];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    if (headAncestors.has(sha)) return sha;
    const object = repo.git.objects.get(sha);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommitParents(object.data)) stack.push(parent);
  }
  return null;
}

/**
 * 三路合并：ours=base 分支头，theirs=head 分支头，ancestor=merge-base。
 * 返回合并后的拍平文件表；同一路径两侧改法不同时返回 null（冲突）。
 */
function threeWayMerge(
  repo: Repo,
  ancestorSha: string,
  oursSha: string,
  theirsSha: string,
): Map<string, { mode: string; oid: string }> | null {
  const ancestorObj = repo.git.objects.get(ancestorSha);
  const oursObj = repo.git.objects.get(oursSha);
  const theirsObj = repo.git.objects.get(theirsSha);
  if (!ancestorObj || !oursObj || !theirsObj) return null;
  const baseFlat = new Map<string, { mode: string; oid: string }>();
  const oursFlat = new Map<string, { mode: string; oid: string }>();
  const theirsFlat = new Map<string, { mode: string; oid: string }>();
  flattenTree(repo, parseCommitTree(ancestorObj.data), '', baseFlat);
  flattenTree(repo, parseCommitTree(oursObj.data), '', oursFlat);
  flattenTree(repo, parseCommitTree(theirsObj.data), '', theirsFlat);
  const merged = new Map<string, { mode: string; oid: string }>();
  const paths = new Set([...baseFlat.keys(), ...oursFlat.keys(), ...theirsFlat.keys()]);
  for (const path of paths) {
    const base = baseFlat.get(path);
    const ours = oursFlat.get(path);
    const theirs = theirsFlat.get(path);
    const same = (
      a: { mode: string; oid: string } | undefined,
      b: { mode: string; oid: string } | undefined,
    ): boolean =>
      (a === undefined && b === undefined) ||
      (a !== undefined && b !== undefined && a.mode === b.mode && a.oid === b.oid);
    if (same(ours, theirs)) {
      if (ours !== undefined) merged.set(path, ours);
    } else if (same(base, ours)) {
      if (theirs !== undefined) merged.set(path, theirs);
    } else if (same(base, theirs)) {
      if (ours !== undefined) merged.set(path, ours);
    } else {
      return null;
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// 工具实现（与 REST 共用 Store，id 与 REST 一致）
// ---------------------------------------------------------------------------

function repoJson(repo: Repo): Record<string, JsonValue> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.full_name,
    owner: repo.owner,
    private: repo.private,
    default_branch: repo.default_branch,
  };
}

function issueJson(issue: Issue): Record<string, JsonValue> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
  };
}

function createRepo(
  id: RpcId,
  store: Store,
  viewerLogin: string,
  args: Record<string, unknown>,
): McpResponse {
  const name = asString(args.name);
  const description = asString(args.description);
  const isPrivate = asBoolean(args.private);
  if (store.getRepo(viewerLogin, name) !== undefined) {
    return toolError(id, `Repository ${viewerLogin}/${name} already exists.`);
  }
  const repo = store.createRepo(viewerLogin, name, description, isPrivate);
  const payload = repoJson(repo);
  return toolResult(id, JSON.stringify(payload), payload);
}

function getRepo(
  id: RpcId,
  store: Store,
  args: Record<string, unknown>,
): McpResponse {
  const repo = store.getRepo(asString(args.owner), asString(args.repo));
  if (repo === undefined) {
    return toolError(id, `Repository ${args.owner}/${args.repo} not found.`);
  }
  const payload = repoJson(repo);
  return toolResult(id, JSON.stringify(payload), payload);
}

function createIssue(
  id: RpcId,
  store: Store,
  args: Record<string, unknown>,
): McpResponse {
  const owner = asString(args.owner);
  const repoName = asString(args.repo);
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) {
    return toolError(id, `Repository ${owner}/${repoName} not found.`);
  }
  const number = store.nextIssueNumber(owner, repoName);
  const now = store.now();
  const issue: Issue = {
    id: store.nextIssueId(),
    number,
    title: asString(args.title),
    body: asString(args.body),
    state: 'open',
    labels: [],
    created_at: now,
    updated_at: now,
  };
  const key = Store.repoKey(owner, repoName);
  let issues = store.issues.get(key);
  if (issues === undefined) {
    issues = new Map();
    store.issues.set(key, issues);
  }
  issues.set(number, issue);
  const payload: Record<string, JsonValue> = {
    number,
    title: issue.title,
    state: 'open',
  };
  return toolResult(id, JSON.stringify(payload), payload);
}

function listIssues(
  id: RpcId,
  store: Store,
  args: Record<string, unknown>,
): McpResponse {
  const owner = asString(args.owner);
  const repoName = asString(args.repo);
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) {
    return toolError(id, `Repository ${owner}/${repoName} not found.`);
  }
  const state = asString(args.state) === '' ? 'open' : asString(args.state);
  const issues = store.issues.get(Store.repoKey(owner, repoName));
  const list: Array<Record<string, JsonValue>> = [];
  if (issues !== undefined) {
    for (const issue of [...issues.values()].sort((a, b) => a.number - b.number)) {
      if (state !== 'all' && issue.state !== state) continue;
      list.push(issueJson(issue));
    }
  }
  return toolResult(id, JSON.stringify(list), { issues: list });
}

function createPullRequest(
  id: RpcId,
  store: Store,
  args: Record<string, unknown>,
): McpResponse {
  const owner = asString(args.owner);
  const repoName = asString(args.repo);
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) {
    return toolError(id, `Repository ${owner}/${repoName} not found.`);
  }
  const head = asString(args.head);
  const base = asString(args.base);
  const headSha = repo.git.refs.get(`refs/heads/${head}`);
  if (headSha === undefined) {
    return toolError(id, `Head branch ${head} does not exist.`);
  }
  const baseSha = repo.git.refs.get(`refs/heads/${base}`);
  if (baseSha === undefined) {
    return toolError(id, `Base branch ${base} does not exist.`);
  }
  const number = store.nextPullNumber(owner, repoName);
  const now = store.now();
  const pull: Pull = {
    number,
    title: asString(args.title),
    body: asString(args.body),
    state: 'open',
    merged: false,
    merged_at: null,
    merge_commit_sha: null,
    head: { ref: head, sha: headSha },
    base: { ref: base, sha: baseSha },
    created_at: now,
    updated_at: now,
  };
  const key = Store.repoKey(owner, repoName);
  let pulls = store.pulls.get(key);
  if (pulls === undefined) {
    pulls = new Map();
    store.pulls.set(key, pulls);
  }
  pulls.set(number, pull);
  const payload: Record<string, JsonValue> = {
    number,
    title: pull.title,
    head,
    base,
    state: 'open',
  };
  return toolResult(id, JSON.stringify(payload), payload);
}

function mergePullRequest(
  id: RpcId,
  store: Store,
  viewerLogin: string,
  args: Record<string, unknown>,
): McpResponse {
  const owner = asString(args.owner);
  const repoName = asString(args.repo);
  const pullNumber = asPullNumber(args.pull_number);
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) {
    return toolError(id, `Repository ${owner}/${repoName} not found.`);
  }
  if (pullNumber === null) {
    return toolError(id, 'pull_number must be an integer.');
  }
  const pulls = store.pulls.get(Store.repoKey(owner, repoName));
  const pull = pulls?.get(pullNumber);
  if (pull === undefined) {
    return toolError(id, `Pull request #${pullNumber} not found.`);
  }
  if (pull.state !== 'open') {
    return toolError(id, `Pull request #${pullNumber} is already ${pull.state}.`);
  }
  const headSha = pull.head.sha;
  const baseRef = `refs/heads/${pull.base.ref}`;
  const baseSha = repo.git.refs.get(baseRef);
  if (baseSha === undefined) {
    return toolError(id, `Base branch ${pull.base.ref} does not exist.`);
  }
  const headObj = repo.git.objects.get(headSha);
  const baseObj = repo.git.objects.get(baseSha);
  if (headObj === undefined || baseObj === undefined) {
    return toolError(id, 'Pull request head or base commit is missing.');
  }

  // head 已是 base 的祖先：内容已在 base 上，无需新 commit。
  const headAncestors = collectAncestors(repo, baseSha);
  let mergeSha: string;
  if (headAncestors.has(headSha)) {
    mergeSha = baseSha;
  } else {
    const mergeBase = findMergeBase(repo, headSha, baseSha);
    if (mergeBase === null) {
      return toolError(id, 'Pull request cannot be merged: no common ancestor.');
    }
    const merged = threeWayMerge(repo, mergeBase, baseSha, headSha);
    if (merged === null) {
      return toolError(id, 'Pull request cannot be merged: merge conflict.');
    }
    const treeSha = buildTreeFromFlat(repo, merged);
    const seconds = Math.floor(Date.parse(store.now()) / 1000);
    const ident = `${viewerLogin} <${viewerLogin}@example.invalid> ${seconds} +0000`;
    const message = `Squash merge #${pullNumber}: ${pull.title}\n`;
    const commitData = buildCommit(treeSha, [baseSha], ident, ident, message);
    mergeSha = sha1('commit', commitData);
    repo.git.objects.set(mergeSha, { type: 'commit', data: commitData });
    repo.git.refs.set(baseRef, mergeSha);
  }

  pull.state = 'closed';
  pull.merged = true;
  pull.merged_at = store.now();
  pull.merge_commit_sha = mergeSha;
  pull.updated_at = pull.merged_at;
  const payload: Record<string, JsonValue> = {
    number: pullNumber,
    merged: true,
    state: 'closed',
  };
  return toolResult(id, JSON.stringify(payload), payload);
}

function callTool(
  id: RpcId,
  store: Store,
  viewerLogin: string,
  params: Record<string, unknown>,
): McpResponse {
  const toolName = resolveTool(params.name);
  if (toolName === null) {
    const label = typeof params.name === 'string' ? params.name : String(params.name ?? '');
    return rpcError(id, -32602, `Unknown tool: ${label}`);
  }
  const tool = TOOLS.find((t) => t.name === toolName) as ToolDef;
  const args = mapArgs(tool, params.arguments);
  const missing = missingRequired(tool, args);
  if (missing.length > 0) {
    return toolError(id, `Missing required argument(s): ${missing.join(', ')}.`);
  }
  switch (toolName) {
    case 'create_repo':
      return createRepo(id, store, viewerLogin, args);
    case 'get_repo':
      return getRepo(id, store, args);
    case 'create_issue':
      return createIssue(id, store, args);
    case 'list_issues':
      return listIssues(id, store, args);
    case 'create_pull_request':
      return createPullRequest(id, store, args);
    case 'merge_pull_request':
      return mergePullRequest(id, store, viewerLogin, args);
    default:
      return rpcError(id, -32602, `Unknown tool: ${toolName}`);
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/**
 * 处理 MCP 请求。不是 POST /mcp 时返回 null，由调用方交给其他路由。
 * JSON-RPC 2.0 over Streamable HTTP；除 tools/call 外不强制认证。
 */
export async function handleMcp(
  req: McpRequest,
  store: Store,
  viewerLogin: string,
): Promise<McpResponse | null> {
  if (req.method !== 'POST' || req.pathname !== '/mcp') return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(req.body.toString('utf8'));
  } catch {
    // 尽力从原文里抠一个 id 回显；抠不到就用 null。
    let id: RpcId = null;
    const match = /"id"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+|null)/.exec(
      req.body.toString('utf8'),
    );
    if (match !== null) {
      const raw = match[1] as string;
      if (raw.startsWith('"')) {
        try {
          id = JSON.parse(raw) as string;
        } catch {
          id = null;
        }
      } else if (raw !== 'null') {
        id = Number(raw);
      }
    }
    return httpJson(400, {
      jsonrpc: '2.0',
      id,
      error: { code: -32700, message: 'Parse error' },
    });
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return rpcError(null, -32600, 'Invalid Request');
  }
  const msg = parsed as Record<string, unknown>;
  const id: RpcId =
    typeof msg.id === 'string' || typeof msg.id === 'number' ? msg.id : null;
  const method = typeof msg.method === 'string' ? msg.method : '';
  const params: Record<string, unknown> =
    msg.params !== null && typeof msg.params === 'object' && !Array.isArray(msg.params)
      ? (msg.params as Record<string, unknown>)
      : {};

  // Notification（无 id）：不回复，HTTP 200 空 body。
  if (msg.id === undefined) {
    if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
      return { status: 200, headers: {}, body: Buffer.alloc(0) };
    }
    return { status: 200, headers: {}, body: Buffer.alloc(0) };
  }

  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        supportedVersions: ['2026-07-28'],
        serverInfo: { name: 'gitforge', version: '1.0.0' },
        capabilities: { tools: {} },
      });
    case 'initialize': {
      const protocolVersion =
        typeof params.protocolVersion === 'string' && params.protocolVersion.length > 0
          ? params.protocolVersion
          : '2025-11-25';
      return rpcResult(id, {
        protocolVersion,
        serverInfo: { name: 'gitforge', version: '1.0.0' },
        capabilities: { tools: {} },
      });
    }
    case 'notifications/initialized':
      return { status: 200, headers: {}, body: Buffer.alloc(0) };
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      if (!hasAuth(req.headers)) {
        return httpJson(401, { message: 'Unauthorized' });
      }
      return callTool(id, store, viewerLogin, params);
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}
