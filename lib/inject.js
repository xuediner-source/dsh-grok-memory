/**
 * dsh-grok-memory — context injection.
 *
 * Official Grok Build (~/.grok/docs/user-guide/13-memory.md): on the first turn
 * of each session the client searches memory for content relevant to the
 * current project and injects it as context; after auto-compaction it searches
 * again to recover discarded context.
 *
 * Injection scope narrows by tier, so a busy project never bloats the prompt:
 *
 *   INJECTED (curated, always)  memory  — global durable facts
 *                               user    — durable user facts
 *                               key     — this project's long-term facts
 *   ON DEMAND (recall only)     project — per-project progress log
 *                               daily   — per-day progress log
 *
 * DSH materializes `systemPrompt.context` as a user-role tail and only
 * re-appends when the rendered text changes, so the curated snapshot stays
 * cache-stable until a tracked entry changes.
 */
import { readText, resolveTracks, splitEntryHead, TRACKS, INJECTED_TRACKS } from './tracks.js';
import { DEFAULTS, allMarkdownFiles, openIndex, reindex, search } from './search.js';

export const INJECTION_DEFAULTS = {
  enabled: true,
  minScore: 0,
  maxChars: 12000,
  memoryMaxChars: 2500,
  userMaxChars: 1500,
  keyMaxChars: 4000,
  recallMaxChars: 2000,
  maxResults: DEFAULTS.maxResults,
};

/** Trim to `max` characters, keeping a truncation marker. */
export function clip(text, max) {
  const t = String(text ?? '').trim();
  if (!max || t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 14)).trimEnd()}\n…(truncated)`;
}

/** FTS-safe query: up to 8 alphanumeric tokens of length >= 2. */
export function searchQueryOf(text) {
  return String(text ?? '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2)
    .slice(0, 8)
    .join(' ');
}

/** Latest user-visible text from an assemble context or a turn buffer. */
export function latestUserText(context, buffers) {
  // The host may hand the context object or the agent itself; normalise.
  const agent = context?.agent ?? (context?.session ? context : undefined);
  const messages = context?.messages ?? agent?.session?.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = messageText(messages[i]);
    if (text) return text;
  }
  // Session events are the authoritative record: for `user/message` the event
  // data IS the message record (verified in @deepseek-ai/dsh-session).
  const events = agent?.session?.events;
  if (Array.isArray(events)) {
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (ev?.type !== 'user/message') continue;
      const text = messageText(ev.data);
      if (text) return text;
    }
  }
  const id = String(agent?.session?.id ?? '');
  const buf = id && buffers instanceof Map ? buffers.get(id) : undefined;
  if (Array.isArray(buf?.user) && buf.user.length) return buf.user[buf.user.length - 1];
  return '';
}

/** All user prompts from session events, in order (Grok summary topics). */
export function userTextFromEvents(agent) {
  const events = agent?.session?.events;
  if (!Array.isArray(events)) return [];
  const out = [];
  for (const ev of events) {
    if (ev?.type !== 'user/message') continue;
    const text = messageText(ev.data);
    if (text) out.push(text);
  }
  return out;
}

function messageText(message) {
  if (!message) return '';
  const kind = message.source?.kind ?? message.role;
  if (kind && kind !== 'user') return '';
  if (typeof message.content === 'string') return message.content.trim();
  if (!Array.isArray(message.content)) return '';
  return message.content
    .filter((b) => b && (b.type === 'text' || typeof b.text === 'string'))
    .map((b) => b.text)
    .join('\n')
    .trim();
}

/**
 * Render one injected track as `- body` bullets, stripping the program prefixes
 * (timestamps, git branch tags) that carry no meaning for the model.
 *
 * A migrated or hand-written entry may already start with a `- ` bullet and may
 * span several lines; both are normalised so the rendered list never shows a
 * doubled bullet (`- - …`) or an unindented continuation.
 */
export function renderTrack(file, target) {
  const text = readText(file).trim();
  if (!text) return '';
  const bullets = text
    .split(/\n§\n/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => bullet(splitEntryHead(entry, target).body))
    .filter(Boolean);
  return bullets.join('\n');
}

/** One entry as a single list item, with continuation lines indented. */
function bullet(body) {
  const text = String(body ?? '').replace(/^\s*[-*]\s+/, '').trim();
  if (!text) return '';
  return `- ${text.replace(/\n+/g, '\n  ')}`;
}

/** The curated (always injected) tracks, each clipped to its own budget. */
export function renderCurated(paths, cfg = INJECTION_DEFAULTS) {
  const loc = resolveTracks(paths.root, paths.cwd);
  const budgets = { memory: cfg.memoryMaxChars, user: cfg.userMaxChars, key: cfg.keyMaxChars };
  const titles = {
    memory: 'Global memory',
    user: 'User preferences',
    key: `Project key facts (${paths.label ?? paths.cwd})`,
  };
  const parts = [];
  for (const target of INJECTED_TRACKS) {
    const body = renderTrack(loc[target].file, target);
    if (!body) continue;
    parts.push(`### ${titles[target]}\n${clip(body, budgets[target])}`);
  }
  return parts;
}

export function renderRecall(hits, cfg = INJECTION_DEFAULTS) {
  if (!hits?.length) return '';
  const lines = hits.map((h, i) => {
    const stale = h.stale ? ' (may be stale — verify before relying on it)' : '';
    return `${i + 1}. [${h.source}]${stale}\n${clip(h.body, 400)}`;
  });
  return clip(`### Recalled from earlier sessions\n${lines.join('\n\n')}`, cfg.recallMaxChars);
}

/** True when `file` lives under the project's own memory directory. */
function underProject(file, paths) {
  const n = String(file).replace(/\\/g, '/');
  const dir = String(resolveTracks(paths.root, paths.cwd).projectDir).replace(/\\/g, '/');
  return n === dir || n.startsWith(`${dir}/`);
}

/**
 * Recall hits for THIS project's chronological tracks only. The injected tracks
 * are already rendered verbatim above, so re-listing them here would duplicate
 * context.
 */
export function recallHits(paths, query, cfg = INJECTION_DEFAULTS) {
  const q = searchQueryOf(query);
  if (!q) return [];
  const hits = withIndex(paths, (db) => search(db, q, {
    maxResults: (cfg.maxResults ?? DEFAULTS.maxResults) * 3,
    minScore: cfg.minScore ?? 0,
  }));
  return hits
    .filter((h) => !INJECTED_TRACKS.includes(h.source))
    .filter((h) => underProject(h.file, paths) || h.source === 'daily')
    .slice(0, cfg.maxResults ?? DEFAULTS.maxResults);
}

/**
 * Open the project's FTS index, run `fn`, and always close the handle.
 * `DatabaseSync` holds an OS file handle: leaking one per call made the index
 * undeletable on Windows (rmSync -> EPERM) and leaked handles across a long
 * session, so every entry point funnels through here.
 */
export function withIndex(paths, fn) {
  const db = openIndex(joinIndex(paths.root, paths.cwd));
  try {
    reindex(db, allMarkdownFiles(paths.root), paths.root);
    return fn(db);
  } finally {
    try { db.close(); } catch { /* already closed */ }
  }
}

/** The FTS index lives in the project directory, beside that project's tracks. */
function joinIndex(root, cwd) {
  return `${resolveTracks(root, cwd).projectDir}/index.sqlite`;
}

/**
 * Build the injected snapshot. Empty when there is nothing to share, so a
 * brand-new project does not pay a header-only context tail.
 */
export function buildInjection({
  paths,
  query = '',
  includeRecall = true,
  recallText,
  cfg = INJECTION_DEFAULTS,
} = {}) {
  if (!paths || cfg.enabled === false) return '';
  const curated = renderCurated(paths, cfg);
  const recall = includeRecall
    ? (recallText ?? renderRecall(recallHits(paths, query, cfg), cfg))
    : '';
  if (!curated.length && !recall) return '';
  const parts = [
    '## Cross-session memory (this project)',
    'Earlier conversations in this project share this store. Instructions in the current conversation take precedence over anything stored here.',
    ...curated,
  ];
  if (recall) parts.push(recall);
  return clip(parts.join('\n\n'), cfg.maxChars);
}

export { TRACKS };
