/**
 * Memory storage layout — mirrors the Grok Build official client
 * (~/.grok/docs/user-guide/13-memory.md) verbatim:
 *
 *   <root>/
 *     MEMORY.md                        global scope
 *     <slug>-<hash8>/
 *       MEMORY.md                      workspace scope
 *       sessions/<YYYY-MM-DD>.md      per-day session summaries
 *       topics/<topic>.md              /dream output
 *       index.sqlite                   FTS5 index
 *
 * Project identity is the git origin remote in `org/repo` form when the
 * directory is a git repository with an origin remote, or the directory path
 * otherwise. Clones and worktrees of the same repository share an origin, so
 * they share one memory directory — exactly as the official client states.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Default memory root, analogous to ~/.grok/memory/. */
export function defaultMemoryRoot() {
  return join(process.env.DSH_MEMORY_ROOT || join(homedir(), '.dsh'), 'memory');
}

/**
 * Project identity string per the official rule: git `origin` remote reduced
 * to `org/repo`, else the absolute directory path.
 */
export function projectIdentity(cwd) {
  try {
    const url = execFileSync('git', ['-C', cwd, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const m = url.match(/(?:github\.com[:/]|gitlab\.com[:/]|bitbucket\.org[:/])((?:[^/]+)\/[^/.]+?)(?:\.git)?$/);
    if (m && m[1]) return m[1];
    if (url) return url;
  } catch {
    // not a git repo, or no origin — fall through to the path form
  }
  return cwd;
}

/** `<slug>-<hash8>` workspace directory name. */
export function projectSlug(cwd) {
  const identity = projectIdentity(cwd);
  const hash8 = createHash('sha256').update(identity).digest('hex').slice(0, 8);
  const base = identity
    .replace(/^.*[/:]/, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${base || 'workspace'}-${hash8}`;
}

/** Absolute paths for one workspace under a memory root. */
export function pathsFor(cwd, root = defaultMemoryRoot()) {
  const dir = join(root, projectSlug(cwd));
  return {
    root,
    identity: projectIdentity(cwd),
    slug: projectSlug(cwd),
    workspace: dir,
    globalMemory: join(root, 'MEMORY.md'),
    projectMemory: join(dir, 'MEMORY.md'),
    sessions: join(dir, 'sessions'),
    topics: join(dir, 'topics'),
    index: join(dir, 'index.sqlite'),
  };
}

export function ensureDirs(paths) {
  for (const p of [paths.root, paths.workspace, paths.sessions, paths.topics]) {
    if (!existsSync(p)) mkdirSync(p, { recursive: true });
  }
}

/** Read a markdown file, returning '' when absent. */
export function readText(path) {
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
}

/**
 * Append a durable statement under an organized heading, as the official
 * client does (`## Preferences`, `## Project Context`, `## Debugging`, ...).
 */
export function appendEntry(path, heading, statement) {
  mkdirSync(dirname(path), { recursive: true });
  let text = readText(path);
  const headingLine = `## ${heading}`;
  const entry = `- ${statement.trim()}`;
  if (!text.includes(headingLine)) {
    text = `${text.trimEnd()}\n\n${headingLine}\n${entry}\n`;
  } else {
    const idx = text.indexOf(headingLine) + headingLine.length;
    text = `${text.slice(0, idx)}\n${entry}${text.slice(idx)}`;
  }
  writeFileSync(path, text, 'utf8');
  return path;
}

/**
 * Best-effort removal of every line matching the needle (official behaviour:
 * forget is best-effort, guaranteed removal is a manual file edit).
 */
export function removeEntry(path, needle) {
  const text = readText(path);
  if (!text) return { removed: 0 };
  const re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const kept = text.split('\n').filter((line) => !(line.trimStart().startsWith('- ') && re.test(line)));
  const removed = text.split('\n').length - kept.length;
  if (removed > 0) writeFileSync(path, kept.join('\n'), 'utf8');
  return { removed };
}

/** Append raw markdown to a dated session log. */
export function appendSession(paths, date, markdown) {
  ensureDirs(paths);
  const file = join(paths.sessions, `${date}.md`);
  const stamp = new Date().toISOString();
  writeFileSync(file, `${readText(file)}\n\n<!-- ${stamp} -->\n${markdown.trim()}\n`, 'utf8');
  return file;
}

/** List markdown files grouped by scope, for the /memory browser. */
export function listMemory(paths) {
  const groups = { global: [], workspace: [], sessions: [], topics: [] };
  if (existsSync(paths.globalMemory)) groups.global.push(paths.globalMemory);
  if (existsSync(paths.projectMemory)) groups.workspace.push(paths.projectMemory);
  for (const [key, dir] of [['sessions', paths.sessions], ['topics', paths.topics]]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.md')).sort().reverse()) {
      groups[key].push(join(dir, f));
    }
  }
  return groups;
}

/** Enumerate every markdown file under a root for indexing. */
export function allMarkdownFiles(root) {
  const out = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) { if (name !== 'topics') walk(full); else walk(full); }
      else if (name.endsWith('.md')) out.push(full);
    }
  };
  walk(root);
  return out;
}
