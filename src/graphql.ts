// GraphQL v4 层：手写递归下降解析器 + 执行器，只用 Node 标准库。
// 覆盖任务所需的 Query / Mutation 子集，与 REST 共用同一个 Store，
// 因此 GraphQL 的写入能被 REST 读回，反之亦然。
// 不用 Date.now() / Math.random()：所有时间戳走 store.now()。

import { buildCommit, parseCommit, parseTree, sha1 } from './git.ts';
import { VIEWER } from './scenario.ts';
import { Store, type Comment, type Issue, type Pull, type Repo } from './store.ts';

/** 与 store.ts 的逻辑时钟起点一致（2025-01-01 UTC）。 */
const EPOCH_MS = Date.UTC(2025, 0, 1, 0, 0, 0);

/** handleGraphQL 的请求形状（由调用方 app.ts 组装）。 */
export interface GraphQLRequest {
  method: string;
  pathname: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: Buffer;
}

/** handleGraphQL 的响应形状；null 表示不是 GraphQL 路由。 */
export interface GraphQLResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

const JSON_HEADERS: Record<string, string> = {
  'content-type': 'application/json; charset=utf-8',
};

/** GraphQL 执行期错误：统一转成 HTTP 200 + { data: {}, errors: [...] }。 */
class GraphQLError extends Error {}

/* ------------------------------------------------------------------ */
/* 词法：tokenizer                                                       */
/* ------------------------------------------------------------------ */

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof' };

/** 把 GraphQL 源文本切成 token；逗号与注释按规范视为空白。 */
function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  const n = input.length;
  let i = 0;
  while (i < n) {
    const ch = input[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < n && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.') {
      if (input.slice(i, i + 3) === '...') {
        tokens.push({ kind: 'punct', value: '...' });
        i += 3;
        continue;
      }
      throw new GraphQLError('Unexpected character ".".');
    }
    if ('!$():=@[]{}|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      // 块字符串 """..."""：只取原文，不做缩进处理。
      if (input.slice(i, i + 3) === '"""') {
        const end = input.indexOf('"""', i + 3);
        if (end === -1) throw new GraphQLError('Unterminated block string.');
        let raw = input.slice(i + 3, end);
        if (raw.startsWith('\r\n')) raw = raw.slice(2);
        else if (raw.startsWith('\n') || raw.startsWith('\r')) raw = raw.slice(1);
        tokens.push({ kind: 'string', value: raw });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      for (;;) {
        if (j >= n) throw new GraphQLError('Unterminated string.');
        const c = input[j] as string;
        if (c === '"') break;
        if (c === '\n') throw new GraphQLError('Unterminated string.');
        if (c === '\\') {
          const e = input[j + 1];
          if (e === undefined) throw new GraphQLError('Unterminated string.');
          if (e === 'u') {
            const hex = input.slice(j + 2, j + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
              throw new GraphQLError('Invalid unicode escape in string.');
            }
            out += String.fromCharCode(Number.parseInt(hex, 16));
            j += 6;
            continue;
          }
          const escapes: Record<string, string> = {
            '"': '"',
            '\\': '\\',
            '/': '/',
            b: '\b',
            f: '\f',
            n: '\n',
            r: '\r',
            t: '\t',
          };
          const rep = escapes[e];
          if (rep === undefined) throw new GraphQLError(`Invalid escape "\\${e}" in string.`);
          out += rep;
          j += 2;
          continue;
        }
        out += c;
        j += 1;
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      let j = i;
      if (input[j] === '-') j += 1;
      if (j >= n || input[j] === undefined || !(input[j] as string >= '0' && input[j] as string <= '9')) {
        throw new GraphQLError(`Unexpected character "${ch}".`);
      }
      let isFloat = false;
      while (j < n && /[0-9]/.test(input[j] as string)) j += 1;
      if (input[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < n && /[0-9]/.test(input[j] as string)) j += 1;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        isFloat = true;
        j += 1;
        if (input[j] === '+' || input[j] === '-') j += 1;
        while (j < n && /[0-9]/.test(input[j] as string)) j += 1;
      }
      const text = input.slice(i, j);
      tokens.push(isFloat ? { kind: 'float', value: text } : { kind: 'int', value: text });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[_0-9A-Za-z]/.test(input[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new GraphQLError(`Unexpected character "${ch}".`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

/* ------------------------------------------------------------------ */
/* 语法：递归下降解析器（只支持任务所需的子集）                                */
/* ------------------------------------------------------------------ */

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selections: SelectionNode[] | null;
}

interface InlineFragmentNode {
  kind: 'inline';
  typeCondition: string | null;
  selections: SelectionNode[];
}

interface SpreadNode {
  kind: 'spread';
  name: string;
}

type SelectionNode = FieldNode | InlineFragmentNode | SpreadNode;

interface VariableDefinition {
  name: string;
  defaultValue: ValueNode | null;
}

interface OperationNode {
  kind: 'operation';
  op: 'query' | 'mutation' | 'subscription';
  name: string | null;
  varDefs: VariableDefinition[];
  selections: SelectionNode[];
}

interface FragmentNode {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private isPunct(value: string): boolean {
    const token = this.peek();
    return token.kind === 'punct' && token.value === value;
  }

  private expectPunct(value: string): void {
    if (!this.isPunct(value)) {
      throw new GraphQLError(`Expected "${value}" but found ${describeToken(this.peek())}.`);
    }
    this.next();
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') {
      throw new GraphQLError(`Expected a name but found ${describeToken(token)}.`);
    }
    return token.value;
  }

  /** 解析整份文档：若干 operation 与 fragment 定义。 */
  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'name' && token.value === 'fragment') {
        const fragment = this.parseFragmentDefinition();
        fragments.set(fragment.name, fragment);
      } else {
        operations.push(this.parseOperation());
      }
    }
    if (operations.length === 0) throw new GraphQLError('No operation found in document.');
    return { operations, fragments };
  }

  private parseOperation(): OperationNode {
    if (this.isPunct('{')) {
      return { kind: 'operation', op: 'query', name: null, varDefs: [], selections: this.parseSelectionSet() };
    }
    const keyword = this.expectName();
    if (keyword !== 'query' && keyword !== 'mutation' && keyword !== 'subscription') {
      throw new GraphQLError(`Unexpected operation type "${keyword}".`);
    }
    let name: string | null = null;
    const nameToken = this.peek();
    if (nameToken.kind === 'name') {
      this.next();
      name = nameToken.value;
    }
    let varDefs: VariableDefinition[] = [];
    if (this.isPunct('(')) varDefs = this.parseVariableDefinitions();
    this.skipDirectives();
    return { kind: 'operation', op: keyword, name, varDefs, selections: this.parseSelectionSet() };
  }

  private parseVariableDefinitions(): VariableDefinition[] {
    this.expectPunct('(');
    const defs: VariableDefinition[] = [];
    while (!this.isPunct(')')) {
      if (this.peek().kind === 'eof') throw new GraphQLError('Unterminated variable definitions.');
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseType();
      let defaultValue: ValueNode | null = null;
      if (this.isPunct('=')) {
        this.next();
        defaultValue = this.parseValue();
      }
      this.skipDirectives();
      defs.push({ name, defaultValue });
    }
    this.expectPunct(')');
    return defs;
  }

  /** 类型只做语法跳过（Name / [ ] / ! 的序列），不做校验。 */
  private parseType(): void {
    for (;;) {
      const token = this.peek();
      if (token.kind === 'name') {
        this.next();
        continue;
      }
      if (token.kind === 'punct' && (token.value === '[' || token.value === ']' || token.value === '!')) {
        this.next();
        continue;
      }
      return;
    }
  }

  /** 指令只做语法跳过（@name(args)），语义上忽略。 */
  private skipDirectives(): void {
    while (this.isPunct('@')) {
      this.next();
      this.expectName();
      if (this.isPunct('(')) this.parseArguments();
    }
  }

  private parseFragmentDefinition(): FragmentNode {
    this.expectName(); // 'fragment'
    const name = this.expectName();
    const onKeyword = this.expectName();
    if (onKeyword !== 'on') throw new GraphQLError(`Expected "on" in fragment definition but found "${onKeyword}".`);
    const typeCondition = this.expectName();
    this.skipDirectives();
    return { kind: 'fragment', name, typeCondition, selections: this.parseSelectionSet() };
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.isPunct('}')) {
      if (this.peek().kind === 'eof') throw new GraphQLError('Unterminated selection set.');
      if (this.isPunct('...')) selections.push(this.parseFragment());
      else selections.push(this.parseField());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseFragment(): SelectionNode {
    this.expectPunct('...');
    const token = this.peek();
    if (token.kind === 'name' && token.value === 'on') {
      this.next();
      const typeCondition = this.expectName();
      this.skipDirectives();
      return { kind: 'inline', typeCondition, selections: this.parseSelectionSet() };
    }
    if (token.kind === 'name') {
      const name = token.value;
      this.next();
      this.skipDirectives();
      return { kind: 'spread', name };
    }
    this.skipDirectives();
    return { kind: 'inline', typeCondition: null, selections: this.parseSelectionSet() };
  }

  private parseField(): FieldNode {
    let name = this.expectName();
    let alias: string | null = null;
    if (this.isPunct(':')) {
      this.next();
      alias = name;
      name = this.expectName();
    }
    let args: Array<{ name: string; value: ValueNode }> = [];
    if (this.isPunct('(')) args = this.parseArguments();
    this.skipDirectives();
    let selections: SelectionNode[] | null = null;
    if (this.isPunct('{')) selections = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selections };
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> {
    this.expectPunct('(');
    const args: Array<{ name: string; value: ValueNode }> = [];
    while (!this.isPunct(')')) {
      if (this.peek().kind === 'eof') throw new GraphQLError('Unterminated argument list.');
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '$') {
      this.next();
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'int') {
      this.next();
      return { kind: 'int', value: Number.parseInt(token.value, 10) };
    }
    if (token.kind === 'float') {
      this.next();
      return { kind: 'float', value: Number.parseFloat(token.value) };
    }
    if (token.kind === 'string') {
      this.next();
      return { kind: 'string', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      this.next();
      const values: ValueNode[] = [];
      while (!this.isPunct(']')) {
        if (this.peek().kind === 'eof') throw new GraphQLError('Unterminated list value.');
        values.push(this.parseValue());
      }
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      this.next();
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!this.isPunct('}')) {
        if (this.peek().kind === 'eof') throw new GraphQLError('Unterminated input object.');
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      this.next();
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new GraphQLError(`Unexpected token ${describeToken(token)} in value.`);
  }
}

function describeToken(token: Token): string {
  if (token.kind === 'eof') return 'end of document';
  return `"${token.value}"`;
}

/* ------------------------------------------------------------------ */
/* 值解析：把 AST 值节点换成 JS 值（变量来自 variables）                       */
/* ------------------------------------------------------------------ */

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.values.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/* ------------------------------------------------------------------ */
/* 内省表                                                                 */
/* ------------------------------------------------------------------ */

interface TypeInfo {
  kind: 'OBJECT' | 'ENUM';
  fields: string[];
  enumValues: string[];
}

const TYPE_INFO: Record<string, TypeInfo> = {
  Issue: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt'],
    enumValues: [],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'body', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'createdAt', 'updatedAt'],
    enumValues: [],
  },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description'],
    enumValues: [],
  },
  SearchType: {
    kind: 'ENUM',
    fields: [],
    enumValues: ['DISCUSSION', 'ISSUE', 'REPOSITORY', 'USER'],
  },
};

/* ------------------------------------------------------------------ */
/* 执行期对象：每个 wrapper 带 __typename，供 fragment 匹配与字段分发          */
/* ------------------------------------------------------------------ */

type Obj =
  | { __typename: 'Query' }
  | { __typename: 'Mutation' }
  | { __typename: 'Viewer'; login: string }
  | { __typename: 'User'; login: string }
  | { __typename: 'Repository'; repo: Repo }
  | { __typename: 'Ref'; name: string }
  | { __typename: 'Issue'; repo: Repo; issue: Issue }
  | { __typename: 'PullRequest'; repo: Repo; pull: Pull }
  | { __typename: 'IssueConnection'; repo: Repo; issues: Issue[]; hasNextPage: boolean; endCursor: string | null }
  | { __typename: 'PullRequestConnection'; repo: Repo; pulls: Pull[]; hasNextPage: boolean; endCursor: string | null }
  | { __typename: 'PageInfo'; hasNextPage: boolean; endCursor: string | null; startCursor: string | null }
  | { __typename: 'FileConnection'; paths: string[] }
  | { __typename: 'File'; path: string }
  | { __typename: 'Comment'; id: string; body: string; createdAt: string }
  | { __typename: 'CommentEdge'; node: Obj }
  | { __typename: 'CreateIssuePayload'; issue: Obj | null; clientMutationId: string | null }
  | { __typename: 'CloseIssuePayload'; issue: Obj | null; clientMutationId: string | null }
  | { __typename: 'CreatePullRequestPayload'; pullRequest: Obj | null; clientMutationId: string | null }
  | { __typename: 'MergePullRequestPayload'; pullRequest: Obj | null; clientMutationId: string | null }
  | { __typename: 'AddCommentPayload'; commentEdge: Obj | null; comment: Obj | null; clientMutationId: string | null }
  | { __typename: '__Type'; name: string }
  | { __typename: '__Field'; name: string }
  | { __typename: '__EnumValue'; name: string };

interface Ctx {
  store: Store;
  viewerLogin: string;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentNode>;
  /** 非致命错误（如合并冲突）：随 data 一起返回，不清空 data。 */
  errors: Array<{ message: string }>;
}

/* ------------------------------------------------------------------ */
/* 全局 id 与 Store 查找                                                  */
/* ------------------------------------------------------------------ */

function repoGlobalId(store: Store, repo: Repo): string {
  return store.globalId('Repository', Store.repoKey(repo.owner, repo.name));
}

function issueGlobalId(store: Store, repo: Repo, number: number): string {
  return store.globalId('Issue', Store.issueKey(repo.owner, repo.name, number));
}

function pullGlobalId(store: Store, repo: Repo, number: number): string {
  return store.globalId('PullRequest', Store.issueKey(repo.owner, repo.name, number));
}

function issueObj(store: Store, repo: Repo, issue: Issue): Obj {
  return { __typename: 'Issue', repo, issue };
}

function pullObj(store: Store, repo: Repo, pull: Pull): Obj {
  return { __typename: 'PullRequest', repo, pull };
}

/** "owner/name" -> { owner, name }；格式不对返回 null。 */
function splitRepoKey(key: string): { owner: string; name: string } | null {
  const slash = key.indexOf('/');
  if (slash <= 0 || slash === key.length - 1) return null;
  return { owner: key.slice(0, slash), name: key.slice(slash + 1) };
}

/** "owner/name#number" -> { owner, name, number }；格式不对返回 null。 */
function splitIssueKey(key: string): { owner: string; name: string; number: number } | null {
  const hash = key.lastIndexOf('#');
  if (hash <= 0) return null;
  const repoPart = splitRepoKey(key.slice(0, hash));
  if (repoPart === null) return null;
  const number = Number.parseInt(key.slice(hash + 1), 10);
  if (!Number.isFinite(number)) return null;
  return { ...repoPart, number };
}

function findRepo(store: Store, owner: string, name: string): Repo | undefined {
  return store.getRepo(owner, name);
}

function findIssue(store: Store, owner: string, name: string, number: number): { repo: Repo; issue: Issue } | null {
  const repo = store.getRepo(owner, name);
  if (repo === undefined) return null;
  const issue = store.issues.get(Store.repoKey(owner, name))?.get(number);
  if (issue === undefined) return null;
  return { repo, issue };
}

function findPull(store: Store, owner: string, name: string, number: number): { repo: Repo; pull: Pull } | null {
  const repo = store.getRepo(owner, name);
  if (repo === undefined) return null;
  const pull = store.pulls.get(Store.repoKey(owner, name))?.get(number);
  if (pull === undefined) return null;
  return { repo, pull };
}

/* ------------------------------------------------------------------ */
/* git  helpers：与 REST 保持同一语义                                      */
/* ------------------------------------------------------------------ */

/** ISO 时间戳换算为逻辑时钟秒数（自 2025-01-01 起），与 REST 的 epochSeconds 一致。 */
function epochSeconds(iso: string): number {
  return Math.floor((Date.parse(iso) - EPOCH_MS) / 1000);
}

/** 分支 tip 的 commit sha；分支不存在返回 undefined。 */
function branchTip(repo: Repo, branch: string): string | undefined {
  return repo.git.refs.get(`refs/heads/${branch}`);
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

/** 递归把 tree 拍平成 path -> { sha, mode }；路径用 '/' 连接。 */
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

/** commit 的 tree 拍平；commit 不存在返回 null。 */
function treeOf(repo: Repo, commitSha: string | null): Map<string, { sha: string; mode: string }> | null {
  if (commitSha === null) return new Map();
  const object = repo.git.objects.get(commitSha);
  if (!object || object.type !== 'commit') return null;
  const out = new Map<string, { sha: string; mode: string }>();
  flattenTree(repo, parseCommit(object.data).tree, '', out);
  return out;
}

/** 沿 head 祖先链找第一个同时是 base 祖先的 commit（merge-base）；找不到返回 null。 */
function mergeBase(repo: Repo, headSha: string, baseSha: string): string | null {
  const baseAncestors = ancestors(repo, baseSha);
  const seen = new Set<string>();
  const stack = [headSha];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    if (baseAncestors.has(sha)) return sha;
    const object = repo.git.objects.get(sha);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return null;
}

interface ConflictCheck {
  conflict: boolean;
  filename: string | null;
}

/**
 * 三方冲突判定，与 REST 的 PUT merge 完全一致：相对 merge-base，
 * head 与 base 改了同一文件且结果不同即冲突。
 */
function checkConflict(repo: Repo, headSha: string, baseSha: string): ConflictCheck {
  const base = mergeBase(repo, headSha, baseSha);
  const mergeBaseFiles = treeOf(repo, base) ?? new Map<string, { sha: string; mode: string }>();
  const headFiles = treeOf(repo, headSha) ?? new Map<string, { sha: string; mode: string }>();
  const baseFiles = treeOf(repo, baseSha) ?? new Map<string, { sha: string; mode: string }>();
  const allPaths = new Set([...mergeBaseFiles.keys(), ...headFiles.keys(), ...baseFiles.keys()]);
  for (const filename of allPaths) {
    const atBase = mergeBaseFiles.get(filename)?.sha;
    const atHead = headFiles.get(filename)?.sha;
    const atBaseBranch = baseFiles.get(filename)?.sha;
    if (atHead !== atBase && atBaseBranch !== atBase && atHead !== atBaseBranch) {
      return { conflict: true, filename };
    }
  }
  return { conflict: false, filename: null };
}

/** head 与 base 的 tree diff 路径（新增/删除/修改），按路径排序。 */
function diffPaths(repo: Repo, baseSha: string, headSha: string): string[] {
  const baseFiles = treeOf(repo, baseSha);
  const headFiles = treeOf(repo, headSha);
  if (baseFiles === null || headFiles === null) return [];
  const allPaths = [...new Set([...headFiles.keys(), ...baseFiles.keys()])].sort();
  const out: string[] = [];
  for (const path of allPaths) {
    if (headFiles.get(path)?.sha !== baseFiles.get(path)?.sha) out.push(path);
  }
  return out;
}

/** 生成一个 commit 并存入 git.objects（已存在则不动），返回新 commit sha；与 REST 的 createCommit 一致。 */
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
  const ident = `${viewerLogin} <${viewerLogin}@example.invalid> ${epoch} +0000`;
  const text = message.endsWith('\n') ? message : `${message}\n`;
  const data = buildCommit(treeSha, parents, ident, ident, text);
  const sha = sha1('commit', data);
  if (!repo.git.objects.has(sha)) repo.git.objects.set(sha, { type: 'commit', data });
  return sha;
}

/* ------------------------------------------------------------------ */
/* 分页：游标为 base64url 编码的 number                                     */
/* ------------------------------------------------------------------ */

function cursorFor(number: number): string {
  return Buffer.from(String(number), 'utf8').toString('base64url');
}

function paginate<T>(
  items: readonly T[],
  first: unknown,
  after: unknown,
  cursorOf: (item: T) => string,
): { page: T[]; hasNextPage: boolean; endCursor: string | null } {
  let start = 0;
  if (typeof after === 'string' && after !== '') {
    const index = items.findIndex((item) => cursorOf(item) === after);
    if (index >= 0) start = index + 1;
  }
  const rest = items.slice(start);
  const limit =
    typeof first === 'number' && Number.isFinite(first) && first >= 0 ? Math.floor(first) : rest.length;
  const page = rest.slice(0, limit);
  return {
    page,
    hasNextPage: rest.length > limit,
    endCursor: page.length > 0 ? cursorOf(page[page.length - 1] as T) : null,
  };
}

/* ------------------------------------------------------------------ */
/* 字段解析                                                              */
/* ------------------------------------------------------------------ */

function fieldArgs(field: FieldNode, ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, ctx.variables);
  return out;
}

/** 未知字段：message 必须包含字段名。 */
function unknownField(obj: Obj, field: FieldNode): never {
  throw new GraphQLError(`Cannot query field "${field.name}" on type "${obj.__typename}".`);
}

/** issues 列表：states 过滤 + orderBy 排序（与 REST 的 created 排序一致）。 */
function issuesConnection(ctx: Ctx, repo: Repo, args: Record<string, unknown>): Obj {
  const store = ctx.store;
  let list = [...(store.issues.get(Store.repoKey(repo.owner, repo.name))?.values() ?? [])];
  const states = args['states'];
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toLowerCase()));
    list = list.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = asRecord(args['orderBy']);
  const direction = orderBy?.['direction'] === 'ASC' ? 1 : -1;
  list.sort((a, b) => {
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -direction : direction;
    return (a.number - b.number) * direction;
  });
  const { page, hasNextPage, endCursor } = paginate(list, args['first'], args['after'], (issue) =>
    cursorFor(issue.number),
  );
  return { __typename: 'IssueConnection', repo, issues: page, hasNextPage, endCursor };
}

function pullsConnection(ctx: Ctx, repo: Repo, args: Record<string, unknown>): Obj {
  const store = ctx.store;
  const list = [...(store.pulls.get(Store.repoKey(repo.owner, repo.name))?.values() ?? [])];
  list.sort((a, b) => a.number - b.number);
  const { page, hasNextPage, endCursor } = paginate(list, args['first'], args['after'], (pull) =>
    cursorFor(pull.number),
  );
  return { __typename: 'PullRequestConnection', repo, pulls: page, hasNextPage, endCursor };
}

/** PR 是否可合并：相对 merge-base 改了同一文件且内容不同即 CONFLICTING。 */
function mergeableOf(repo: Repo, pull: Pull): string {
  const headTip = branchTip(repo, pull.head.ref) ?? pull.head.sha;
  const baseTip = branchTip(repo, pull.base.ref) ?? pull.base.sha;
  const headCommit = repo.git.objects.get(headTip);
  const baseCommit = repo.git.objects.get(baseTip);
  if (!headCommit || headCommit.type !== 'commit' || !baseCommit || baseCommit.type !== 'commit') {
    return 'UNKNOWN';
  }
  return checkConflict(repo, headTip, baseTip).conflict ? 'CONFLICTING' : 'MERGEABLE';
}

/** node(id:)：按全局 id 的 kind 分发；解析失败或找不到返回 null。 */
function resolveNode(ctx: Ctx, id: unknown): Obj | null {
  if (typeof id !== 'string') return null;
  const parsed = ctx.store.parseGlobalId(id);
  if (parsed === null) return null;
  if (parsed.kind === 'Repository') {
    const parts = splitRepoKey(parsed.key);
    if (parts === null) return null;
    const repo = findRepo(ctx.store, parts.owner, parts.name);
    return repo === undefined ? null : { __typename: 'Repository', repo };
  }
  if (parsed.kind === 'Issue' || parsed.kind === 'PullRequest') {
    const parts = splitIssueKey(parsed.key);
    if (parts === null) return null;
    if (parsed.kind === 'Issue') {
      const found = findIssue(ctx.store, parts.owner, parts.name, parts.number);
      return found === null ? null : issueObj(ctx.store, found.repo, found.issue);
    }
    const found = findPull(ctx.store, parts.owner, parts.name, parts.number);
    return found === null ? null : pullObj(ctx.store, found.repo, found.pull);
  }
  if (parsed.kind === 'Comment') {
    const colon = parsed.key.lastIndexOf(':');
    if (colon <= 0) return null;
    const parts = splitIssueKey(parsed.key.slice(0, colon));
    if (parts === null) return null;
    const commentId = Number.parseInt(parsed.key.slice(colon + 1), 10);
    if (!Number.isFinite(commentId)) return null;
    const list = ctx.store.comments.get(Store.issueKey(parts.owner, parts.name, parts.number)) ?? [];
    const comment = list.find((item) => item.id === commentId);
    if (comment === undefined) return null;
    return {
      __typename: 'Comment',
      id: ctx.store.globalId('Comment', parsed.key),
      body: comment.body,
      createdAt: comment.created_at,
    };
  }
  return null;
}

function clientMutationId(input: Record<string, unknown> | null): string | null {
  const value = input?.['clientMutationId'];
  return typeof value === 'string' ? value : null;
}

/* ------------------------------ Mutation ------------------------------ */

function mutateCreateIssue(ctx: Ctx, input: Record<string, unknown> | null): Obj {
  const store = ctx.store;
  const repoId = asString(input?.['repositoryId']);
  const parsed = repoId === undefined ? null : store.parseGlobalId(repoId);
  if (parsed === null || parsed.kind !== 'Repository') {
    ctx.errors.push({ message: 'repositoryId does not identify a Repository.' });
    return { __typename: 'CreateIssuePayload', issue: null, clientMutationId: clientMutationId(input) };
  }
  const parts = splitRepoKey(parsed.key);
  const repo = parts === null ? undefined : findRepo(store, parts.owner, parts.name);
  if (repo === undefined || parts === null) {
    ctx.errors.push({ message: 'Repository not found.' });
    return { __typename: 'CreateIssuePayload', issue: null, clientMutationId: clientMutationId(input) };
  }
  const title = asString(input?.['title']);
  if (title === undefined || title === '') {
    ctx.errors.push({ message: 'title is required.' });
    return { __typename: 'CreateIssuePayload', issue: null, clientMutationId: clientMutationId(input) };
  }
  const number = store.nextIssueNumber(parts.owner, parts.name);
  const ts = store.now();
  const issue: Issue = {
    id: store.nextIssueId(),
    number,
    title,
    body: asString(input?.['body']) ?? '',
    state: 'open',
    labels: [],
    created_at: ts,
    updated_at: ts,
  };
  let issueMap = store.issues.get(Store.repoKey(parts.owner, parts.name));
  if (issueMap === undefined) {
    issueMap = new Map();
    store.issues.set(Store.repoKey(parts.owner, parts.name), issueMap);
  }
  issueMap.set(number, issue);
  return {
    __typename: 'CreateIssuePayload',
    issue: issueObj(store, repo, issue),
    clientMutationId: clientMutationId(input),
  };
}

function mutateCloseIssue(ctx: Ctx, input: Record<string, unknown> | null): Obj {
  const store = ctx.store;
  const issueId = asString(input?.['issueId']);
  const parsed = issueId === undefined ? null : store.parseGlobalId(issueId);
  if (parsed === null || parsed.kind !== 'Issue') {
    ctx.errors.push({ message: 'issueId does not identify an Issue.' });
    return { __typename: 'CloseIssuePayload', issue: null, clientMutationId: clientMutationId(input) };
  }
  const parts = splitIssueKey(parsed.key);
  const found = parts === null ? null : findIssue(store, parts.owner, parts.name, parts.number);
  if (found === null) {
    ctx.errors.push({ message: 'Issue not found.' });
    return { __typename: 'CloseIssuePayload', issue: null, clientMutationId: clientMutationId(input) };
  }
  found.issue.state = 'closed';
  found.issue.updated_at = store.now();
  return {
    __typename: 'CloseIssuePayload',
    issue: issueObj(store, found.repo, found.issue),
    clientMutationId: clientMutationId(input),
  };
}

function mutateCreatePullRequest(ctx: Ctx, input: Record<string, unknown> | null): Obj {
  const store = ctx.store;
  const repoId = asString(input?.['repositoryId']);
  const parsed = repoId === undefined ? null : store.parseGlobalId(repoId);
  if (parsed === null || parsed.kind !== 'Repository') {
    ctx.errors.push({ message: 'repositoryId does not identify a Repository.' });
    return { __typename: 'CreatePullRequestPayload', pullRequest: null, clientMutationId: clientMutationId(input) };
  }
  const parts = splitRepoKey(parsed.key);
  const repo = parts === null ? undefined : findRepo(store, parts.owner, parts.name);
  if (repo === undefined || parts === null) {
    ctx.errors.push({ message: 'Repository not found.' });
    return { __typename: 'CreatePullRequestPayload', pullRequest: null, clientMutationId: clientMutationId(input) };
  }
  const head = asString(input?.['headRefName']);
  const base = asString(input?.['baseRefName']);
  const title = asString(input?.['title']);
  if (head === undefined || head === '') {
    ctx.errors.push({ message: 'headRefName is required.' });
    return { __typename: 'CreatePullRequestPayload', pullRequest: null, clientMutationId: clientMutationId(input) };
  }
  if (base === undefined || base === '') {
    ctx.errors.push({ message: 'baseRefName is required.' });
    return { __typename: 'CreatePullRequestPayload', pullRequest: null, clientMutationId: clientMutationId(input) };
  }
  if (title === undefined || title === '') {
    ctx.errors.push({ message: 'title is required.' });
    return { __typename: 'CreatePullRequestPayload', pullRequest: null, clientMutationId: clientMutationId(input) };
  }
  const headSha = branchTip(repo, head);
  if (headSha === undefined) {
    ctx.errors.push({ message: `head branch does not exist: ${head}` });
    return { __typename: 'CreatePullRequestPayload', pullRequest: null, clientMutationId: clientMutationId(input) };
  }
  const baseSha = branchTip(repo, base);
  if (baseSha === undefined) {
    ctx.errors.push({ message: `base branch does not exist: ${base}` });
    return { __typename: 'CreatePullRequestPayload', pullRequest: null, clientMutationId: clientMutationId(input) };
  }
  const number = store.nextPullNumber(parts.owner, parts.name);
  const ts = store.now();
  const pull: Pull = {
    number,
    title,
    body: asString(input?.['body']) ?? '',
    state: 'open',
    merged: false,
    merged_at: null,
    merge_commit_sha: null,
    head: { ref: head, sha: headSha },
    base: { ref: base, sha: baseSha },
    created_at: ts,
    updated_at: ts,
  };
  let pullMap = store.pulls.get(Store.repoKey(parts.owner, parts.name));
  if (pullMap === undefined) {
    pullMap = new Map();
    store.pulls.set(Store.repoKey(parts.owner, parts.name), pullMap);
  }
  pullMap.set(number, pull);
  return {
    __typename: 'CreatePullRequestPayload',
    pullRequest: pullObj(store, repo, pull),
    clientMutationId: clientMutationId(input),
  };
}

function mutateMergePullRequest(ctx: Ctx, input: Record<string, unknown> | null): Obj {
  const store = ctx.store;
  const pullRequestId = asString(input?.['pullRequestId']);
  const parsed = pullRequestId === undefined ? null : store.parseGlobalId(pullRequestId);
  if (parsed === null || parsed.kind !== 'PullRequest') {
    ctx.errors.push({ message: 'pullRequestId does not identify a PullRequest.' });
    return { __typename: 'MergePullRequestPayload', pullRequest: null, clientMutationId: clientMutationId(input) };
  }
  const parts = splitIssueKey(parsed.key);
  const found = parts === null ? null : findPull(store, parts.owner, parts.name, parts.number);
  if (found === null) {
    ctx.errors.push({ message: 'Pull request not found.' });
    return { __typename: 'MergePullRequestPayload', pullRequest: null, clientMutationId: clientMutationId(input) };
  }
  const { repo, pull } = found;
  if (pull.merged) {
    return {
      __typename: 'MergePullRequestPayload',
      pullRequest: pullObj(store, repo, pull),
      clientMutationId: clientMutationId(input),
    };
  }
  const headTip = branchTip(repo, pull.head.ref) ?? pull.head.sha;
  const baseTip = branchTip(repo, pull.base.ref) ?? pull.base.sha;
  const headCommit = repo.git.objects.get(headTip);
  const baseCommit = repo.git.objects.get(baseTip);
  if (!headCommit || headCommit.type !== 'commit' || !baseCommit || baseCommit.type !== 'commit') {
    ctx.errors.push({ message: 'Head or base commit not found.' });
    return { __typename: 'MergePullRequestPayload', pullRequest: pullObj(store, repo, pull), clientMutationId: clientMutationId(input) };
  }
  const conflict = checkConflict(repo, headTip, baseTip);
  if (conflict.conflict) {
    ctx.errors.push({ message: `Merge conflict: ${conflict.filename} was changed on both sides` });
    return { __typename: 'MergePullRequestPayload', pullRequest: pullObj(store, repo, pull), clientMutationId: clientMutationId(input) };
  }
  // 与 REST 的 squash 合并一致：新 commit 落到 base 分支，tree 取 head 的 tree，
  // 单父提交（MERGE 方法则为双父提交），message 为 PR 标题。
  const headTree = parseCommit(headCommit.data).tree;
  const method = asString(input?.['mergeMethod']) ?? 'MERGE';
  const parents = method === 'MERGE' ? [baseTip, headTip] : [baseTip];
  const commitSha = createCommit(store, repo, headTree, parents, pull.title, ctx.viewerLogin);
  repo.git.refs.set(`refs/heads/${pull.base.ref}`, commitSha);
  repo.updated_at = store.nowPeek();
  pull.state = 'closed';
  pull.merged = true;
  pull.merged_at = store.now();
  pull.merge_commit_sha = commitSha;
  pull.updated_at = store.nowPeek();
  return {
    __typename: 'MergePullRequestPayload',
    pullRequest: pullObj(store, repo, pull),
    clientMutationId: clientMutationId(input),
  };
}

function mutateAddComment(ctx: Ctx, input: Record<string, unknown> | null): Obj {
  const store = ctx.store;
  const subjectId = asString(input?.['subjectId']);
  const parsed = subjectId === undefined ? null : store.parseGlobalId(subjectId);
  if (parsed === null || parsed.kind !== 'Issue') {
    ctx.errors.push({ message: 'subjectId does not identify an Issue.' });
    return { __typename: 'AddCommentPayload', commentEdge: null, comment: null, clientMutationId: clientMutationId(input) };
  }
  const parts = splitIssueKey(parsed.key);
  if (parts === null) {
    ctx.errors.push({ message: 'Issue not found.' });
    return { __typename: 'AddCommentPayload', commentEdge: null, comment: null, clientMutationId: clientMutationId(input) };
  }
  const found = findIssue(store, parts.owner, parts.name, parts.number);
  if (found === null) {
    ctx.errors.push({ message: 'Issue not found.' });
    return { __typename: 'AddCommentPayload', commentEdge: null, comment: null, clientMutationId: clientMutationId(input) };
  }
  const body = asString(input?.['body']);
  if (body === undefined || body === '') {
    ctx.errors.push({ message: 'body is required.' });
    return { __typename: 'AddCommentPayload', commentEdge: null, comment: null, clientMutationId: clientMutationId(input) };
  }
  const comment: Comment = { id: store.nextCommentId(), body, created_at: store.now() };
  const commentKey = Store.issueKey(parts.owner, parts.name, parts.number);
  let list = store.comments.get(commentKey);
  if (list === undefined) {
    list = [];
    store.comments.set(commentKey, list);
  }
  list.push(comment);
  const node: Obj = {
    __typename: 'Comment',
    id: store.globalId('Comment', `${commentKey}:${comment.id}`),
    body: comment.body,
    createdAt: comment.created_at,
  };
  return {
    __typename: 'AddCommentPayload',
    commentEdge: { __typename: 'CommentEdge', node },
    comment: node,
    clientMutationId: clientMutationId(input),
  };
}

/* --------------------------- 字段分发 --------------------------- */

function resolveField(obj: Obj, field: FieldNode, ctx: Ctx): unknown {
  const store = ctx.store;
  switch (obj.__typename) {
    case 'Query': {
      switch (field.name) {
        case 'viewer':
          return { __typename: 'Viewer', login: ctx.viewerLogin };
        case 'repository': {
          const args = fieldArgs(field, ctx);
          const owner = asString(args['owner']);
          const name = asString(args['name']);
          if (owner === undefined || name === undefined) {
            throw new GraphQLError('repository requires "owner" and "name" arguments.');
          }
          const repo = findRepo(store, owner, name);
          return repo === undefined ? null : { __typename: 'Repository', repo };
        }
        case 'node': {
          const args = fieldArgs(field, ctx);
          return resolveNode(ctx, args['id']);
        }
        case '__type': {
          const args = fieldArgs(field, ctx);
          const name = asString(args['name']);
          if (name === undefined || TYPE_INFO[name] === undefined) return null;
          return { __typename: '__Type', name };
        }
        default:
          return unknownField(obj, field);
      }
    }
    case 'Mutation': {
      const args = fieldArgs(field, ctx);
      const input = asRecord(args['input']);
      switch (field.name) {
        case 'createIssue':
          return mutateCreateIssue(ctx, input);
        case 'closeIssue':
          return mutateCloseIssue(ctx, input);
        case 'createPullRequest':
          return mutateCreatePullRequest(ctx, input);
        case 'mergePullRequest':
          return mutateMergePullRequest(ctx, input);
        case 'addComment':
          return mutateAddComment(ctx, input);
        default:
          return unknownField(obj, field);
      }
    }
    case 'Viewer': {
      switch (field.name) {
        case 'login':
          return obj.login;
        case 'id':
          return obj.login === VIEWER.login ? VIEWER.id : null;
        case 'email':
          return `${obj.login}@example.invalid`;
        default:
          return unknownField(obj, field);
      }
    }
    case 'User': {
      if (field.name === 'login') return obj.login;
      return unknownField(obj, field);
    }
    case 'Repository': {
      const repo = obj.repo;
      switch (field.name) {
        case 'id':
          return repoGlobalId(store, repo);
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return repo.full_name;
        case 'description':
          return repo.description;
        case 'owner':
          return { __typename: 'User', login: repo.owner };
        case 'defaultBranchRef':
          return { __typename: 'Ref', name: repo.default_branch };
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'issue': {
          const args = fieldArgs(field, ctx);
          const number = args['number'];
          if (typeof number !== 'number') throw new GraphQLError('issue requires an integer "number" argument.');
          const found = findIssue(store, repo.owner, repo.name, number);
          return found === null ? null : issueObj(store, repo, found.issue);
        }
        case 'issues':
          return issuesConnection(ctx, repo, fieldArgs(field, ctx));
        case 'pullRequest': {
          const args = fieldArgs(field, ctx);
          const number = args['number'];
          if (typeof number !== 'number') throw new GraphQLError('pullRequest requires an integer "number" argument.');
          const found = findPull(store, repo.owner, repo.name, number);
          return found === null ? null : pullObj(store, repo, found.pull);
        }
        case 'pullRequests':
          return pullsConnection(ctx, repo, fieldArgs(field, ctx));
        default:
          return unknownField(obj, field);
      }
    }
    case 'Ref': {
      if (field.name === 'name') return obj.name;
      return unknownField(obj, field);
    }
    case 'Issue': {
      switch (field.name) {
        case 'id':
          return issueGlobalId(store, obj.repo, obj.issue.number);
        case 'number':
          return obj.issue.number;
        case 'title':
          return obj.issue.title;
        case 'state':
          return obj.issue.state.toUpperCase();
        case 'body':
          return obj.issue.body;
        case 'createdAt':
          return obj.issue.created_at;
        case 'updatedAt':
          return obj.issue.updated_at;
        default:
          return unknownField(obj, field);
      }
    }
    case 'PullRequest': {
      const pull = obj.pull;
      switch (field.name) {
        case 'id':
          return pullGlobalId(store, obj.repo, pull.number);
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'headRefName':
          return pull.head.ref;
        case 'baseRefName':
          return pull.base.ref;
        case 'mergeable':
          return mergeableOf(obj.repo, pull);
        case 'state':
          return pull.merged ? 'MERGED' : pull.state.toUpperCase();
        case 'merged':
          return pull.merged;
        case 'createdAt':
          return pull.created_at;
        case 'updatedAt':
          return pull.updated_at;
        case 'files': {
          const args = fieldArgs(field, ctx);
          const paths = diffPaths(obj.repo, pull.base.sha, pull.head.sha);
          const first = args['first'];
          const sliced =
            typeof first === 'number' && Number.isFinite(first) && first >= 0
              ? paths.slice(0, Math.floor(first))
              : paths;
          return { __typename: 'FileConnection', paths: sliced };
        }
        default:
          return unknownField(obj, field);
      }
    }
    case 'IssueConnection': {
      switch (field.name) {
        case 'nodes':
          return obj.issues.map((issue) => issueObj(store, obj.repo, issue));
        case 'totalCount':
          return obj.issues.length;
        case 'pageInfo':
          return {
            __typename: 'PageInfo',
            hasNextPage: obj.hasNextPage,
            endCursor: obj.endCursor,
            startCursor: obj.issues.length > 0 ? cursorFor(obj.issues[0]?.number ?? 0) : null,
          };
        default:
          return unknownField(obj, field);
      }
    }
    case 'PullRequestConnection': {
      switch (field.name) {
        case 'nodes':
          return obj.pulls.map((pull) => pullObj(store, obj.repo, pull));
        case 'totalCount':
          return obj.pulls.length;
        case 'pageInfo':
          return {
            __typename: 'PageInfo',
            hasNextPage: obj.hasNextPage,
            endCursor: obj.endCursor,
            startCursor: obj.pulls.length > 0 ? cursorFor(obj.pulls[0]?.number ?? 0) : null,
          };
        default:
          return unknownField(obj, field);
      }
    }
    case 'PageInfo': {
      switch (field.name) {
        case 'hasNextPage':
          return obj.hasNextPage;
        case 'endCursor':
          return obj.endCursor;
        case 'hasPreviousPage':
          return false;
        case 'startCursor':
          return obj.startCursor;
        default:
          return unknownField(obj, field);
      }
    }
    case 'FileConnection': {
      switch (field.name) {
        case 'nodes':
          return obj.paths.map((path) => ({ __typename: 'File', path }));
        case 'totalCount':
          return obj.paths.length;
        default:
          return unknownField(obj, field);
      }
    }
    case 'File': {
      if (field.name === 'path') return obj.path;
      return unknownField(obj, field);
    }
    case 'Comment': {
      switch (field.name) {
        case 'id':
          return obj.id;
        case 'body':
          return obj.body;
        case 'createdAt':
          return obj.createdAt;
        default:
          return unknownField(obj, field);
      }
    }
    case 'CommentEdge': {
      if (field.name === 'node') return obj.node;
      return unknownField(obj, field);
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (field.name === 'issue') return obj.issue;
      if (field.name === 'clientMutationId') return obj.clientMutationId;
      return unknownField(obj, field);
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (field.name === 'pullRequest') return obj.pullRequest;
      if (field.name === 'clientMutationId') return obj.clientMutationId;
      return unknownField(obj, field);
    }
    case 'AddCommentPayload': {
      switch (field.name) {
        case 'commentEdge':
          return obj.commentEdge;
        case 'comment':
          return obj.comment;
        case 'clientMutationId':
          return obj.clientMutationId;
        default:
          return unknownField(obj, field);
      }
    }
    case '__Type': {
      const info = TYPE_INFO[obj.name] as TypeInfo;
      switch (field.name) {
        case 'name':
          return obj.name;
        case 'kind':
          return info.kind;
        case 'fields':
          return info.fields.map((name) => ({ __typename: '__Field', name }));
        case 'enumValues':
          return info.enumValues.map((name) => ({ __typename: '__EnumValue', name }));
        default:
          return unknownField(obj, field);
      }
    }
    case '__Field':
    case '__EnumValue': {
      if (field.name === 'name') return obj.name;
      return unknownField(obj, field);
    }
  }
}

function isObj(value: unknown): value is Obj {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { __typename?: unknown }).__typename === 'string'
  );
}

/** 把字段值按选择集物化为响应 JSON。 */
function materialize(value: unknown, selections: SelectionNode[] | null, ctx: Ctx): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    if (selections !== null) {
      throw new GraphQLError('Scalar field must not have a selection of subfields.');
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => materialize(item, selections, ctx));
  if (isObj(value)) {
    if (selections === null) {
      throw new GraphQLError(`Field of type "${value.__typename}" must have a selection of subfields.`);
    }
    return executeSelectionSet(value, selections, ctx);
  }
  return value;
}

/** 执行一个选择集，返回响应对象（key 为别名或字段名）。 */
function executeSelectionSet(obj: Obj, selections: SelectionNode[], ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'field') {
      if (selection.name === '__typename') {
        out[selection.alias ?? selection.name] = obj.__typename;
        continue;
      }
      const value = resolveField(obj, selection, ctx);
      out[selection.alias ?? selection.name] = materialize(value, selection.selections, ctx);
    } else if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === obj.__typename) {
        Object.assign(out, executeSelectionSet(obj, selection.selections, ctx));
      }
    } else {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment === undefined) throw new GraphQLError(`Unknown fragment "${selection.name}".`);
      if (fragment.typeCondition === obj.__typename) {
        Object.assign(out, executeSelectionSet(obj, fragment.selections, ctx));
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 单个 operation 的执行                                                  */
/* ------------------------------------------------------------------ */

function executeOne(body: unknown, store: Store, viewerLogin: string): Record<string, unknown> {
  const record = asRecord(body);
  if (record === null) {
    return { data: {}, errors: [{ message: 'GraphQL request body must be an object.' }] };
  }
  const query = record['query'];
  if (typeof query !== 'string') {
    return { data: {}, errors: [{ message: 'GraphQL query must be a string.' }] };
  }
  let document: DocumentNode;
  try {
    document = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: {}, errors: [{ message: err instanceof Error ? err.message : 'GraphQL parse error.' }] };
  }
  const operationName = typeof record['operationName'] === 'string' ? record['operationName'] : undefined;
  let operation: OperationNode | undefined;
  if (operationName !== undefined) {
    operation = document.operations.find((item) => item.name === operationName);
  } else if (document.operations.length === 1) {
    operation = document.operations[0];
  }
  if (operation === undefined) {
    return {
      data: {},
      errors: [
        {
          message:
            operationName !== undefined
              ? `Unknown operation named "${operationName}".`
              : 'Must provide operation name if query contains multiple operations.',
        },
      ],
    };
  }
  if (operation.op === 'subscription') {
    return { data: {}, errors: [{ message: 'Subscriptions are not supported.' }] };
  }
  // 变量：定义里的默认值先行，请求体里的 variables 覆盖（null 也是有效值）。
  const variables: Record<string, unknown> = {};
  for (const def of operation.varDefs) {
    if (def.defaultValue !== null) variables[def.name] = resolveValue(def.defaultValue, {});
  }
  const provided = asRecord(record['variables']);
  if (provided !== null) {
    for (const [key, value] of Object.entries(provided)) {
      if (value !== undefined) variables[key] = value;
    }
  }
  const ctx: Ctx = { store, viewerLogin, variables, fragments: document.fragments, errors: [] };
  const root: Obj = operation.op === 'mutation' ? { __typename: 'Mutation' } : { __typename: 'Query' };
  try {
    const data = executeSelectionSet(root, operation.selections, ctx);
    if (ctx.errors.length > 0) return { data, errors: ctx.errors };
    return { data };
  } catch (err) {
    return { data: {}, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
}

function jsonResponse(status: number, body: unknown): GraphQLResponse {
  return { status, headers: JSON_HEADERS, body: Buffer.from(JSON.stringify(body), 'utf8') };
}

/**
 * GraphQL v4 入口。
 *
 * 只处理 POST /api/graphql；其他 pathname 或方法返回 null，由调用方继续路由。
 * 未认证（无 `Authorization: Bearer ...` 头）返回 HTTP 401；
 * 其余错误一律 HTTP 200 + { data, errors }，未知仓库返回 { data: { repository: null } } 且无 errors。
 * 请求体为单个对象或 JSON 数组（批量，按顺序返回同长度数组）。
 */
export async function handleGraphQL(
  req: GraphQLRequest,
  store: Store,
  viewerLogin: string,
): Promise<GraphQLResponse | null> {
  if (req.method !== 'POST' || (req.pathname !== '/api/graphql' && req.pathname !== '/api/graphql/')) {
    return null;
  }
  const auth = req.headers['authorization'] ?? req.headers['Authorization'];
  if (typeof auth !== 'string' || !auth.startsWith('Bearer ') || auth.length <= 7) {
    return jsonResponse(401, { message: 'Unauthorized' });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(req.body.toString('utf8'));
  } catch {
    return jsonResponse(400, { message: 'Invalid JSON body' });
  }
  if (Array.isArray(parsed)) {
    return jsonResponse(
      200,
      parsed.map((item) => executeOne(item, store, viewerLogin)),
    );
  }
  return jsonResponse(200, executeOne(parsed, store, viewerLogin));
}
