// Shared in-memory store for the forge. Single process, whole trial = one process,
// so in-memory Maps are the store. All four surfaces (git HTTP, REST, GraphQL, MCP)
// read and write the same Store instance. Deterministic: no Date.now(), no
// Math.random() in anything a response carries. A logical clock gives strictly
// increasing timestamps so issue/PR ordering is stable and replay-safe.

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export interface GitStore {
  /** sha (40-hex) -> object. All git objects live here. */
  objects: Map<string, GitObject>;
  /** full ref name (refs/heads/main, refs/tags/v1) -> commit/tag sha. */
  refs: Map<string, string>;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  full_name: string;
  description: string;
  private: boolean;
  default_branch: string;
  created_at: string;
  updated_at: string;
  git: GitStore;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  created_at: string;
  updated_at: string;
}

export interface Comment {
  id: number;
  body: string;
  created_at: string;
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  created_at: string;
  updated_at: string;
}

export interface Label {
  name: string;
  color: string;
}

const EPOCH_MS = Date.UTC(2025, 0, 1, 0, 0, 0);

function b64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}

function unb64url(s: string): string | null {
  try {
    return Buffer.from(s, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

export class Store {
  repos = new Map<string, Repo>();
  issues = new Map<string, Map<number, Issue>>();
  comments = new Map<string, Comment[]>();
  labels = new Map<string, Map<string, Label>>();
  pulls = new Map<string, Map<number, Pull>>();

  private repoSeq = 5000;
  private issueIdSeq = 100000;
  private commentSeq = 1;
  /** Monotonic logical clock, seconds since EPOCH_MS. Increments on every now(). */
  private tick = 0;

  static repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  static issueKey(owner: string, name: string, number: number): string {
    return `${owner}/${name}#${number}`;
  }

  /** ISO timestamp from the logical clock. Strictly increasing across calls. */
  now(): string {
    this.tick += 1;
    return new Date(EPOCH_MS + this.tick * 1000).toISOString();
  }

  /** Current logical time without advancing (for read-only stamping). */
  nowPeek(): string {
    return new Date(EPOCH_MS + this.tick * 1000).toISOString();
  }

  nextRepoId(): number {
    this.repoSeq += 1;
    return this.repoSeq;
  }

  nextIssueId(): number {
    this.issueIdSeq += 1;
    return this.issueIdSeq;
  }

  nextCommentId(): number {
    const id = this.commentSeq;
    this.commentSeq += 1;
    return id;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(Store.repoKey(owner, name));
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    const repo: Repo = {
      id: this.nextRepoId(),
      name,
      owner,
      full_name: `${owner}/${name}`,
      description,
      private: isPrivate,
      default_branch: 'main',
      created_at: this.now(),
      updated_at: this.nowPeek(),
      git: { objects: new Map(), refs: new Map() },
    };
    const key = Store.repoKey(owner, name);
    this.repos.set(key, repo);
    this.issues.set(key, new Map());
    this.labels.set(key, new Map());
    this.pulls.set(key, new Map());
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    const key = Store.repoKey(owner, name);
    const ok = this.repos.delete(key);
    this.issues.delete(key);
    this.labels.delete(key);
    this.pulls.delete(key);
    for (const k of [...this.comments.keys()]) {
      if (k.startsWith(`${key}#`)) this.comments.delete(k);
    }
    return ok;
  }

  nextIssueNumber(owner: string, name: string): number {
    const m = this.issues.get(Store.repoKey(owner, name));
    return m ? m.size + 1 : 1;
  }

  nextPullNumber(owner: string, name: string): number {
    const m = this.pulls.get(Store.repoKey(owner, name));
    return m ? m.size + 1 : 1;
  }

  /**
   * Opaque global id (Relay-style). Never a plain number: the GraphQL gate
   * rejects ids equal to String(databaseId) or String(number).
   * Format: base64url("<kind>:<key>").
   */
  globalId(kind: string, key: string): string {
    return b64url(`${kind}:${key}`);
  }

  parseGlobalId(id: string): { kind: string; key: string } | null {
    const raw = unb64url(id);
    if (!raw) return null;
    const i = raw.indexOf(':');
    if (i <= 0) return null;
    return { kind: raw.slice(0, i), key: raw.slice(i + 1) };
  }
}
