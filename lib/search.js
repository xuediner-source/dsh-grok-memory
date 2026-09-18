/**
 * Memory search — matches the official Grok Build scoring model
 * (~/.grok/docs/user-guide/13-memory.md, "Memory Search").
 *
 * The default embedding model is unset, so memory starts in full-text-only
 * mode. When a vector score is supplied, the official combination is:
 *
 *   score = vector_weight * vector + text_weight * bm25
 *           (defaults 0.7 / 0.3, min_score 0.35)
 *
 * Each source (workspace / session / global) carries a weight multiplier,
 * all defaulting to 1.0. Temporal decay applies to session chunks only —
 * global and workspace memory are curated long-term knowledge and exempt.
 * MMR re-ranks for diversity with lambda 0.7 (1.0 = pure relevance).
 */
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const DEFAULTS = {
  maxResults: 6,
  minScore: 0.35,
  vectorWeight: 0.7,
  textWeight: 0.3,
  sourceWeights: { workspace: 1.0, session: 1.0, global: 1.0 },
  temporalDecay: { enabled: true, halfLifeDays: 7.0 },
  mmr: { enabled: false, lambda: 0.7 },
  maxChunkChars: 1600,
  chunkOverlapChars: 320,
};

/** Split markdown into overlapping chunks per the official index settings. */
export function chunk(text, { maxChunkChars = 1600, chunkOverlapChars = 320 } = {}) {
  const out = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + maxChunkChars, text.length);
    out.push(text.slice(start, end).trim());
    if (end === text.length) break;
    start = end - chunkOverlapChars;
    if (start < 0) start = 0;
  }
  return out.filter(Boolean);
}

/** Open (or create) the FTS5 index at the given path. */
export function openIndex(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY,
      file TEXT NOT NULL,
      source TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      body TEXT NOT NULL,
      mtime INTEGER NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      body, content='chunks', content_rowid='id'
    );
  `);
  return db;
}

/** Determine a chunk's source scope from its file path. */
export function sourceOf(file, root) {
  const rel = file.replace(root, '').replace(/\\/g, '/');
  if (rel.includes('/sessions/')) return 'session';
  if (rel.includes('/topics/')) return 'session';
  if (rel.endsWith('/MEMORY.md')) {
    const dir = rel.slice(0, rel.lastIndexOf('/MEMORY.md'));
    return dir === '' ? 'global' : 'workspace';
  }
  return 'workspace';
}

/**
 * (Re)index every markdown file under `root`. Deleted files' stale chunks are
 * removed first, mirroring the official file-watcher behaviour.
 */
export function reindex(db, files, root) {
  const seen = new Set();
  db.exec('BEGIN');
  try {
    for (const file of files) {
      seen.add(file);
      const st = statSync(file);
      const text = readFileSync(file, 'utf8');
      const source = sourceOf(file, root);
      const existing = db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE file = ?').get(file);
      if (existing && Number(existing.n) > 0) {
        const mtime = db.prepare('SELECT MAX(mtime) AS m FROM chunks WHERE file = ?').get(file);
        if (mtime && Number(mtime.m) === st.mtimeMs) continue;
        db.prepare('DELETE FROM chunks WHERE file = ?').run(file);
      }
      const insert = db.prepare(
        'INSERT INTO chunks (file, source, ordinal, body, mtime) VALUES (?, ?, ?, ?, ?)',
      );
      chunk(text).forEach((body, ordinal) => {
        insert.run(file, source, ordinal, body, st.mtimeMs);
      });
    }
    // drop chunks whose files vanished
    const rows = db.prepare('SELECT DISTINCT file FROM chunks').all();
    for (const row of rows) {
      if (!seen.has(String(row.file))) db.prepare('DELETE FROM chunks WHERE file = ?').run(String(row.file));
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  // rebuild the FTS mirror
  db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')");
}

/** BM25-ish text score: use FTS5's bm25() when the query matches, else 0. */
export function textScore(db, query) {
  try {
    const rows = db.prepare(
      "SELECT rowid, bm25(chunks_fts) AS s FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY s",
    ).all(query);
    // bm25() returns a negative number where lower = better; invert to a 0..1 shape
    const map = new Map();
    if (!rows.length) return map;
    const worst = Math.min(...rows.map((r) => Number(r.s)));
    for (const r of rows) {
      map.set(Number(r.rowid), worst === 0 ? 1 : Number(r.s) / worst);
    }
    return map;
  } catch {
    return new Map();
  }
}

/**
 * Search memory. `vectorScores` optionally maps rowid -> similarity in 0..1,
 * enabling the official weighted combination; without it the search runs in
 * full-text-only mode.
 */
export function search(db, query, options = {}) {
  const cfg = {
    ...DEFAULTS,
    ...options,
    sourceWeights: { ...DEFAULTS.sourceWeights, ...(options.sourceWeights || {}) },
    temporalDecay: { ...DEFAULTS.temporalDecay, ...(options.temporalDecay || {}) },
    mmr: { ...DEFAULTS.mmr, ...(options.mmr || {}) },
  };
  const now = options.now ?? Date.now();
  const scores = textScore(db, query);
  const ids = [...scores.keys()];
  if (!ids.length) return [];

  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT id, file, source, body, mtime FROM chunks WHERE id IN (${placeholders})`).all(...ids);
  const results = [];
  for (const row of rows) {
    const id = Number(row.id);
    const text = scores.get(id) ?? 0;
    const vector = options.vectorScores?.get(id) ?? 0;
    const combined = options.vectorScores
      ? cfg.vectorWeight * vector + cfg.textWeight * text
      : text;
    const weight = cfg.sourceWeights[String(row.source)] ?? 1.0;
    let score = combined * weight;
    let stale = false;
    if (cfg.temporalDecay.enabled && String(row.source) === 'session') {
      const ageDays = (now - Number(row.mtime)) / 86_400_000;
      const half = cfg.temporalDecay.halfLifeDays;
      score *= 0.5 ** (ageDays / half);
      stale = ageDays > half;
    }
    if (score < cfg.minScore) continue;
    results.push({ id, file: String(row.file), source: String(row.source), body: String(row.body), score, stale });
  }
  results.sort((a, b) => b.score - a.score);
  return cfg.mmr.enabled ? mmrRerank(results, cfg.mmr.lambda, cfg.maxResults) : results.slice(0, cfg.maxResults);
}

/** Maximal Marginal Relevance: penalise results redundant with earlier picks. */
export function mmrRerank(results, lambda = 0.7, max = DEFAULTS.maxResults) {
  const picked = [];
  const rest = [...results];
  while (picked.length < max && rest.length) {
    let best = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < rest.length; i++) {
      const relevance = rest[i].score;
      const redundancy = picked.length === 0
        ? 0
        : Math.max(...picked.map((p) => jaccard(rest[i].body, p.body)));
      const mmr = lambda * relevance - (1 - lambda) * redundancy;
      if (mmr > bestScore) { bestScore = mmr; best = i; }
    }
    picked.push(rest.splice(best, 1)[0]);
  }
  return picked;
}

function jaccard(a, b) {
  const ta = new Set(a.toLowerCase().split(/\W+/).filter(Boolean));
  const tb = new Set(b.toLowerCase().split(/\W+/).filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}
