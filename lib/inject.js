/**
 * First-turn (and post-compaction) memory injection.
 *
 * Official Grok Build (~/.grok/docs/user-guide/13-memory.md):
 *   On the first turn of each session, Grok automatically searches memory
 *   for content relevant to the current project and injects it as context.
 *   After auto-compaction it searches again to recover discarded context.
 *
 * DSH materializes `systemPrompt.context` as a user-role tail and only
 * re-appends when the rendered text changes, so the curated MEMORY.md
 * snapshot stays cache-stable until someone /remember's.
 */
import { allMarkdownFiles, readText } from './store.js';
import { DEFAULTS, openIndex, reindex, search } from './search.js';

export const INJECTION_DEFAULTS = {
  enabled: true,
  minScore: 0,
  maxChars: 8000,
  globalMaxChars: 2000,
  workspaceMaxChars: 4000,
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
  const messages = context?.messages
    ?? context?.agent?.session?.messages
    ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = messageText(messages[i]);
    if (text) return text;
  }
  const id = String(context?.agent?.session?.id ?? '');
  const buf = id && buffers instanceof Map ? buffers.get(id) : undefined;
  if (Array.isArray(buf?.user) && buf.user.length) return buf.user[buf.user.length - 1];
  return '';
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

export function renderCurated(paths, cfg = INJECTION_DEFAULTS) {
  const parts = [];
  const global = readText(paths.globalMemory).trim();
  const workspace = readText(paths.projectMemory).trim();
  if (global) parts.push(`### Global\n${clip(global, cfg.globalMaxChars)}`);
  if (workspace) {
    parts.push(`### Workspace (${paths.identity})\n${clip(workspace, cfg.workspaceMaxChars)}`);
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

function underWorkspace(file, paths) {
  const n = String(file).replace(/\\/g, '/');
  const ws = String(paths.workspace).replace(/\\/g, '/');
  return n === ws || n.startsWith(`${ws}/`);
}

/** Session/topic hits for THIS project only (MEMORY.md is injected curated). */
export function recallHits(paths, query, cfg = INJECTION_DEFAULTS) {
  const q = searchQueryOf(query);
  if (!q) return [];
  const db = openIndex(paths.index);
  reindex(db, allMarkdownFiles(paths.root), paths.root);
  const hits = search(db, q, {
    maxResults: (cfg.maxResults ?? DEFAULTS.maxResults) * 3,
    minScore: cfg.minScore ?? 0,
  });
  return hits
    .filter((h) => h.source !== 'global' && h.source !== 'workspace')
    .filter((h) => underWorkspace(h.file, paths))
    .slice(0, cfg.maxResults ?? DEFAULTS.maxResults);
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
