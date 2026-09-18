/**
 * dsh-grok-memory — five-track memory storage.
 *
 * Layout under `<root>`. The entry format is byte-compatible with the
 * Hermes / dsh-memory-evolve `§`-delimited format, so existing memory files
 * are read and rewritten as-is rather than migrated:
 *
 *   MEMORY.md                    memory track — durable global facts (INJECTED)
 *   USER.md                      user track   — durable user facts   (INJECTED)
 *   MEMORY-archive.md            archived memory entries
 *   USER-archive.md              archived user entries
 *   DAILY-archive.md             archived daily entries
 *   SUGGESTIONS.jsonl            pending suggestions awaiting user confirmation
 *   daily/<YYYY-MM-DD>.md        daily track  — per-day progress log
 *   projects/<sha1(cwd)[:12]>/
 *     MEMORY.md                  project track — per-project progress log
 *     KEY.md                     key track     — per-project long-term facts (INJECTED)
 *     KEY-archive.md             archived key entries
 *     index.sqlite               FTS5 index for this project
 *
 * Injection scope narrows by tier: `memory` / `user` / `key` are injected into
 * the context; `project` / `daily` are written every turn but read on demand
 * only, so a busy log never bloats the prompt.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Entry delimiter, byte-compatible with Hermes MEMORY.md / USER.md. */
export const ENTRY_DELIMITER = '\n§\n';

/** The five memory tracks. */
export const TRACKS = ['memory', 'user', 'project', 'key', 'daily'];

/** Tracks that are injected into the model context (the rest are on-demand). */
export const INJECTED_TRACKS = ['memory', 'user', 'key'];

/** Tracks whose entries carry a `[git <branch>]` program stamp. */
const BRANCH_STAMPED = ['project', 'daily'];

/**
 * Prompt-injection phrasing refused by the write path. A memory file is
 * re-injected into future contexts, so a poisoned entry would persist.
 */
const THREAT_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|earlier|above|your)\s+(instructions?|prompts?|messages?|rules?)/i,
  /disregard\s+(all\s+)?(previous|prior|earlier|above|your)\s+(instructions?|prompts?|messages?|rules?)/i,
  /forget\s+(all|everything|your\s+instructions)/i,
  /忽略(所有|之前|以上|先前)(的)?(指令|指示|提示|规则)/,
  /无视(所有|之前|以上|先前)(的)?(指令|指示|提示|规则)/,
];

/** Default memory root. `memories` (plural) matches the DSH plugin convention. */
export function defaultMemoryRoot() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(process.env.DSH_MEMORY_ROOT || home, 'memories');
}

/** Today's date as `YYYY-MM-DD` (local time). */
export function todayStamp(now = new Date()) {
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${mm}-${dd}`;
}

/** Current local time as `HH:MM`. */
export function clockStamp(now = new Date()) {
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** Stable 12-hex project key for one working directory. */
export function projectHash(cwd) {
  return createHash('sha1').update(String(cwd)).digest('hex').slice(0, 12);
}

/**
 * Short, stable label for one working directory: the basename, or the last two
 * path segments when the basename is too short or purely numeric (so
 * `/data/260805/1` labels as `260805/1`).
 */
export function projectLabel(cwd) {
  if (!cwd) return undefined;
  const parts = String(cwd).replace(/\\/g, '/').replace(/\/+$/, '').split('/').filter(Boolean);
  if (parts.length === 0) return '/';
  const base = parts[parts.length - 1];
  if (base.length < 3 || /^\d+$/.test(base)) {
    return parts.length > 1 ? parts.slice(-2).join('/') : base;
  }
  return base;
}

const branchCache = new Map();

/**
 * Current git branch of a working directory, or undefined outside a worktree /
 * on a detached HEAD. Cached: this runs on every stamped write and a `git`
 * spawn per entry is pure latency.
 */
export function gitBranch(cwd) {
  if (!cwd) return undefined;
  const key = String(cwd);
  if (branchCache.has(key)) return branchCache.get(key);
  let branch;
  try {
    const out = execFileSync('git', ['-C', key, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (out && out !== 'HEAD') branch = out;
  } catch {
    // not a git worktree, or git unavailable
  }
  branchCache.set(key, branch);
  return branch;
}

/** Drop a cached branch so a fresh checkout is observed (tests / long sessions). */
export function clearBranchCache() {
  branchCache.clear();
}

/**
 * Scan one entry for prompt-injection phrasing.
 * @param {string} text - content to scan.
 * @returns {string | undefined} a human-readable block reason, or undefined.
 */
export function scanThreat(text) {
  for (const pattern of THREAT_PATTERNS) {
    if (pattern.test(text)) {
      return '内容包含疑似提示注入的表述（如"忽略指令"），已拒绝写入。若确为有意内容，请直接编辑记忆文件。';
    }
  }
  return undefined;
}

/** Split raw file text into trimmed, non-empty entries. */
export function parseEntries(text) {
  return String(text ?? '')
    .split(ENTRY_DELIMITER)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** Serialize entries into canonical file text. */
export function serializeEntries(entries) {
  return entries.join(ENTRY_DELIMITER) + '\n';
}

/**
 * Strip an entry's program prefixes (id / timestamp / git branch / branch scope
 * / daily project label) and return `{head, body}`. Editing an entry rewrites
 * `head + newBody`, so program-maintained metadata survives user edits.
 */
export function splitEntryHead(entry, target) {
  let rest = String(entry ?? '').trim();
  const timeRe = target === 'project' ? /^\[(\d{4}-\d{2}-\d{2} \d{1,2}:\d{2}(?::\d{2})?)\]\s*/
    : target === 'daily' ? /^\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*/
      : /^\[(\d{4}-\d{2}-\d{2})\]\s*/;
  const tokens = [];
  const idMatch = /^\[id:([0-9a-f]{8})\]\s*/.exec(rest);
  if (idMatch !== null) { tokens.push(idMatch[0]); rest = rest.slice(idMatch[0].length); }
  const timeMatch = timeRe.exec(rest);
  if (timeMatch !== null) { tokens.push(timeMatch[0]); rest = rest.slice(timeMatch[0].length); }
  for (;;) {
    const gitMatch = /^\[git ([^\]]+)\]\s*/.exec(rest);
    if (gitMatch === null) break;
    tokens.push(gitMatch[0]);
    rest = rest.slice(gitMatch[0].length);
  }
  const branchMatch = /^\[branch:[^\]]*\]\s*/.exec(rest);
  if (branchMatch !== null) { tokens.push(branchMatch[0]); rest = rest.slice(branchMatch[0].length); }
  if (target === 'daily') {
    const tagMatch = /^\[([^\]]+)\]\s*/.exec(rest);
    if (tagMatch !== null) { tokens.push(tagMatch[0]); rest = rest.slice(tagMatch[0].length); }
  }
  return { head: tokens.join(''), body: rest };
}

/** The date stamp of an entry (`YYYY-MM-DD`), or null when it carries none. */
export function entryDate(entry, target) {
  if (target === 'daily') return null; // the file name carries the date
  const m = /^\[(\d{4}-\d{2}-\d{2})/.exec(String(entry ?? '').trim());
  return m ? m[1] : null;
}

/** The branch scope declared by a key entry's `[branch:...]` tag, or null. */
export function entryBranchScope(entry) {
  const m = /\[branch:([^\]]*)\]/.exec(String(entry ?? '').trim());
  if (m === null) return null;
  return m[1].split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Stamp one entry with its program prefix. Idempotent for content that already
 * carries the matching stamp; hand-written date-like prefixes on
 * daily/project/key are stripped first (writers guess dates — the program stamp
 * is authoritative), as are hand-written `[git ...]` tags.
 */
export function stampEntry(target, content, cwd, now = new Date()) {
  let text = String(content ?? '').trim();
  if (target === 'daily' || target === 'project' || target === 'key') {
    text = text.replace(/^\[\d{4}-\d{2}-\d{2}[^\]]*\]\s*/, '');
    text = text.replace(/^\[git [^\]]+\]\s*/, '');
  }
  const branch = BRANCH_STAMPED.includes(target) ? gitBranch(cwd) : undefined;
  const branchTag = branch !== undefined ? `[git ${branch}] ` : '';
  if (target === 'daily') {
    if (/^\[\d{2}:\d{2}\]\s/.test(text)) return text;
    const label = projectLabel(cwd);
    return `[${clockStamp(now)}] ${branchTag}${label ? `[${label}] ` : ''}${text}`;
  }
  if (target === 'project') {
    if (/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\]\s/.test(text)) return text;
    return `[${todayStamp(now)} ${clockStamp(now)}] ${branchTag}${text}`;
  }
  if (/^\[\d{4}-\d{2}-\d{2}\]\s/.test(text)) return text;
  return `[${todayStamp(now)}] ${text}`;
}

/** Resolve every track's file location for one working directory. */
export function resolveTracks(root, cwd) {
  const projectDir = join(root, 'projects', projectHash(cwd));
  return {
    root,
    cwd,
    projectDir,
    memory: { target: 'memory', file: join(root, 'MEMORY.md'), archive: join(root, 'MEMORY-archive.md') },
    user: { target: 'user', file: join(root, 'USER.md'), archive: join(root, 'USER-archive.md') },
    daily: { target: 'daily', file: join(root, 'daily', `${todayStamp()}.md`), archive: join(root, 'DAILY-archive.md') },
    project: { target: 'project', file: join(projectDir, 'MEMORY.md'), archive: join(projectDir, 'PROJECT-archive.md') },
    key: { target: 'key', file: join(projectDir, 'KEY.md'), archive: join(projectDir, 'KEY-archive.md') },
  };
}

/** Read a text file, returning '' when absent or unreadable. */
export function readText(path) {
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
}

/** Atomically replace a file: write a sibling temp file, then rename over it. */
function atomicWrite(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, file);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* best effort */ }
    throw error;
  }
}

/**
 * The five-track store. Every mutating call is read-modify-write over the whole
 * track file, so a failure never leaves a half-written entry.
 */
export class MemoryTracks {
  /**
   * @param {string} root - memory root directory (created on demand).
   * @param {object} [options] - behaviour switches.
   * @param {boolean} [options.injectionScan=true] - refuse injection phrasing.
   */
  constructor(root, options = {}) {
    this.root = root;
    this.injectionScan = options.injectionScan ?? true;
  }

  /** Resolve one track's location, failing loud when it needs a cwd. */
  trackOf(target, cwd) {
    if (!TRACKS.includes(target)) {
      throw new Error(`dsh-grok-memory: 无效的记忆轨 "${target}"（可用：${TRACKS.join(' / ')}）`);
    }
    if ((target === 'project' || target === 'key') && !cwd) {
      throw new Error(`dsh-grok-memory: 无法定位记忆轨 "${target}"（项目记忆需要有效的会话工作目录）`);
    }
    return resolveTracks(this.root, cwd)[target];
  }

  /** All entries of one track (raw, unstripped). */
  entriesOf(target, cwd) {
    const loc = this.trackOf(target, cwd);
    if (existsSync(loc.file) && readText(loc.file) === '') {
      throw new Error(`dsh-grok-memory: ${loc.file} 存在但无法读取，拒绝操作（防止清空已有记忆）`);
    }
    return parseEntries(readText(loc.file));
  }

  /** Character usage of one track (delimiter-joined length). */
  charsOf(target, cwd) {
    return this.entriesOf(target, cwd).join(ENTRY_DELIMITER).length;
  }

  /**
   * Append one entry. Rejects empty content, exact duplicates, injection
   * phrasing and unreadable files.
   */
  add(target, content, cwd, now = new Date()) {
    const loc = this.trackOf(target, cwd);
    const text = String(content ?? '').trim();
    if (!text) return { ok: false, message: '内容不能为空', target };
    if (this.injectionScan) {
      const threat = scanThreat(text);
      if (threat) return { ok: false, message: threat, target };
    }
    const stamped = stampEntry(target, text, cwd, now);
    const entries = this.entriesOf(target, cwd);
    if (entries.includes(stamped)) {
      return { ok: true, message: '条目已存在，未重复添加', target, entries: [...entries], chars: this.charsOf(target, cwd) };
    }
    const next = [...entries, stamped];
    atomicWrite(loc.file, serializeEntries(next));
    return {
      ok: true,
      message: `已添加（${target}：${entries.length} → ${next.length} 条）`,
      target,
      entries: [...next],
      chars: next.join(ENTRY_DELIMITER).length,
    };
  }

  /** Resolve a unique substring match to one entry index. */
  matchOne(target, cwd, match) {
    const needle = String(match ?? '').trim();
    if (!needle) return { error: { ok: false, message: 'match 不能为空', target } };
    const entries = this.entriesOf(target, cwd);
    const hits = entries.filter((entry) => entry.includes(needle));
    if (hits.length === 0) {
      return { error: { ok: false, message: `没有条目包含片段 "${needle}"`, target, entries: [...entries] } };
    }
    if (hits.length > 1) {
      return {
        error: {
          ok: false,
          message: `片段 "${needle}" 匹配到 ${hits.length} 个条目，请用更精确的片段`,
          target,
          matches: [...hits],
        },
      };
    }
    return { entries, index: entries.indexOf(hits[0]), entry: hits[0] };
  }

  /** Replace the whole entry containing the unique substring `match`. */
  replace(target, match, content, cwd, now = new Date()) {
    const loc = this.trackOf(target, cwd);
    const text = String(content ?? '').trim();
    if (!text) return { ok: false, message: 'content 不能为空（删除条目请用 remove）', target };
    if (this.injectionScan) {
      const threat = scanThreat(text);
      if (threat) return { ok: false, message: threat, target };
    }
    const found = this.matchOne(target, cwd, match);
    if (found.error) return found.error;
    const { entries, index, entry } = found;
    // A replacement keeps the old entry's identity: the id and the branch scope
    // are program-maintained metadata, so a rewrite must not silently drop them.
    // Canonical token order (as dsh-memory-evolve writes it) is
    // `[id:…] [timestamp] [git …] [branch:…] body`, so the kept tokens are
    // re-attached around the freshly stamped prefix rather than prepended to it.
    const oldHead = splitEntryHead(entry, target).head;
    const idToken = (/\[id:[0-9a-f]{8}\]\s*/.exec(oldHead) ?? [''])[0];
    const branchToken = (/\[branch:[^\]]*\]\s*/.exec(oldHead) ?? [''])[0];
    const stamped = stampEntry(target, text, cwd, now);
    const { head, body } = splitEntryHead(stamped, target);
    const next = [...entries];
    next[index] = `${idToken}${head}${branchToken}${body}`;
    atomicWrite(loc.file, serializeEntries(next));
    return {
      ok: true,
      message: `已替换条目（${target}：${entries.length} 条不变）`,
      target,
      entries: [...next],
      chars: next.join(ENTRY_DELIMITER).length,
    };
  }

  /** Remove the entry containing the unique substring `match`. */
  remove(target, match, cwd) {
    const loc = this.trackOf(target, cwd);
    const found = this.matchOne(target, cwd, match);
    if (found.error) return found.error;
    const next = found.entries.filter((_, i) => i !== found.index);
    atomicWrite(loc.file, serializeEntries(next));
    return {
      ok: true,
      message: `已删除 1 条（${target}：${found.entries.length} → ${next.length} 条）`,
      target,
      removed: found.entry,
      entries: [...next],
      chars: next.length ? next.join(ENTRY_DELIMITER).length : 0,
    };
  }

  /** Move the entry containing the unique substring `match` into the archive. */
  archive(target, match, cwd) {
    const loc = this.trackOf(target, cwd);
    const found = this.matchOne(target, cwd, match);
    if (found.error) return found.error;
    const next = found.entries.filter((_, i) => i !== found.index);
    const archived = parseEntries(readText(loc.archive));
    atomicWrite(loc.archive, serializeEntries([...archived, found.entry]));
    atomicWrite(loc.file, serializeEntries(next));
    return {
      ok: true,
      message: `已归档 1 条（${target}：${found.entries.length} → ${next.length} 条，归档 ${archived.length} → ${archived.length + 1} 条）`,
      target,
      archivedTo: loc.archive,
      entries: [...next],
    };
  }

  /** Move the entry containing the unique substring `match` back from the archive. */
  promote(target, match, cwd, now = new Date()) {
    const loc = this.trackOf(target, cwd);
    const archived = parseEntries(readText(loc.archive));
    const hits = archived.filter((entry) => entry.includes(String(match ?? '').trim()));
    if (hits.length === 0) return { ok: false, message: `归档中没有条目包含片段 "${match}"`, target };
    if (hits.length > 1) {
      return { ok: false, message: `片段 "${match}" 匹配到 ${hits.length} 个归档条目，请用更精确的片段`, target };
    }
    const remaining = archived.filter((entry) => entry !== hits[0]);
    const live = this.entriesOf(target, cwd);
    atomicWrite(loc.archive, remaining.length ? serializeEntries(remaining) : '');
    atomicWrite(loc.file, serializeEntries([...live, hits[0]]));
    return {
      ok: true,
      message: `已从归档取回 1 条（${target}：${live.length} → ${live.length + 1} 条）`,
      target,
      entries: [...live, hits[0]],
    };
  }

  /**
   * Read one track for the `list` action.
   *
   * `archived: true` reads the archive file instead. Filters: `filter`
   * (case-insensitive substring), `since` / `until` (`YYYY-MM-DD` against the
   * entry date stamp), `branch` (key track: entries with no `[branch:...]`
   * scope plus entries whose scope includes it), `recent` + `limit`.
   */
  list(target, cwd, options = {}) {
    const loc = this.trackOf(target, cwd);
    const source = options.archived ? loc.archive : loc.file;
    let rows = parseEntries(readText(source)).map((entry, index) => {
      const { head, body } = splitEntryHead(entry, target);
      return { entry, index, head, body, date: entryDate(entry, target), branchScope: entryBranchScope(entry) };
    });
    if (options.filter) {
      const needle = String(options.filter).toLowerCase();
      rows = rows.filter((row) => row.entry.toLowerCase().includes(needle));
    }
    if (options.since) rows = rows.filter((row) => row.date !== null && row.date >= options.since);
    if (options.until) rows = rows.filter((row) => row.date !== null && row.date <= options.until);
    if (target === 'key' && options.branch) {
      rows = rows.filter((row) => row.branchScope === null || row.branchScope.includes(options.branch));
    }
    if (options.recent) rows = [...rows].reverse();
    if (options.limit && options.limit > 0) rows = rows.slice(0, options.limit);
    return { ok: true, target, file: source, archived: Boolean(options.archived), rows, total: rows.length };
  }

  /** Every track's entry counts, for the `/memory` browser. */
  overview(cwd) {
    const out = [];
    for (const target of TRACKS) {
      let live = 0;
      let archived = 0;
      try {
        live = this.entriesOf(target, cwd).length;
        archived = parseEntries(readText(this.trackOf(target, cwd).archive)).length;
      } catch {
        // a track that cannot resolve (no cwd) reports as unavailable
        out.push({ target, live: null, archived: null });
        continue;
      }
      out.push({ target, live, archived });
    }
    return out;
  }

  /** Markdown files that belong to one project, for the search index. */
  markdownFiles(cwd) {
    const files = [];
    const loc = resolveTracks(this.root, cwd);
    for (const target of TRACKS) {
      if (target === 'project' || target === 'key' || target === 'daily') continue;
      if (existsSync(loc[target].file)) files.push(loc[target].file);
    }
    if (existsSync(loc.daily.file)) files.push(loc.daily.file);
    for (const dir of [join(this.root, 'daily'), loc.projectDir]) {
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.md')) continue;
        const full = join(dir, name);
        if (statSync(full).isFile() && !files.includes(full)) files.push(full);
      }
    }
    return files;
  }
}

/** Best-effort recursive delete, for `/memclear`. */
export function clearPath(path) {
  rmSync(path, { recursive: true, force: true });
}
