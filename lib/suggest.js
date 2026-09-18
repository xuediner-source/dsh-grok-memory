/**
 * dsh-grok-memory — the pending-suggestion queue.
 *
 * The model does not get to write global (`memory` / `user`) or injected `key`
 * facts directly: those are the statements that silently steer every future
 * session, so they queue in `SUGGESTIONS.jsonl` until the user confirms them.
 * `project` and `daily` are plain logs and are written directly.
 *
 * Storage is an append-only JSONL file, rewritten atomically on every
 * mutation. Repeated suggestions of the same target + content collapse into one
 * pending entry with a bumped `hits` counter instead of duplicating.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Tracks that require user confirmation before a write lands. */
export const GATED_TRACKS = ['memory', 'user', 'key'];

/** Normalise text for duplicate detection: collapse whitespace, lowercase. */
function normalize(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export class SuggestionQueue {
  /** @param {string} file - the JSONL file path. */
  constructor(file) {
    this.file = file;
  }

  /** Read all pending suggestions; a missing or corrupt file reads as empty. */
  read() {
    if (!existsSync(this.file)) return [];
    let text;
    try { text = readFileSync(this.file, 'utf8'); } catch { return []; }
    return text
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter((entry) => entry && typeof entry.content === 'string');
  }

  /** Atomically replace the queue file. */
  write(entries) {
    mkdirSync(dirname(this.file), { recursive: true });
    const body = entries.map((e) => JSON.stringify(e)).join('\n');
    const tmp = `${this.file}.tmp-${process.pid}-${Date.now()}`;
    try {
      writeFileSync(tmp, body ? `${body}\n` : '', 'utf8');
      renameSync(tmp, this.file);
    } catch (error) {
      try { unlinkSync(tmp); } catch { /* best effort */ }
      throw error;
    }
  }

  /**
   * Enqueue one suggestion, deduplicating on (target, normalised content).
   * @returns {{ok: boolean, message: string, queued: number, deduped?: boolean}}
   */
  enqueue(target, content, reason, cwd, now = Date.now()) {
    const text = String(content ?? '').trim();
    if (!text) return { ok: false, message: '内容不能为空', queued: this.read().length };
    const entries = this.read();
    const key = normalize(text);
    const existing = entries.find((e) => e.target === target && normalize(e.content) === key);
    if (existing) {
      existing.hits = (existing.hits ?? 1) + 1;
      existing.lastAt = new Date(now).toISOString();
      this.write(entries);
      return {
        ok: true,
        deduped: true,
        message: `该建议已在待确认队列中（第 ${existing.hits} 次提出）`,
        queued: entries.length,
      };
    }
    entries.push({
      target,
      content: text,
      reason: reason ? String(reason) : '',
      cwd: cwd ?? null,
      hits: 1,
      createdAt: new Date(now).toISOString(),
      lastAt: new Date(now).toISOString(),
    });
    this.write(entries);
    return { ok: true, message: `已加入待确认队列（共 ${entries.length} 条）`, queued: entries.length };
  }

  /** Drop one pending suggestion by 1-based index. */
  drop(index) {
    const entries = this.read();
    if (index < 1 || index > entries.length) {
      return { ok: false, message: `序号 ${index} 超出范围（队列 ${entries.length} 条）` };
    }
    const [removed] = entries.splice(index - 1, 1);
    this.write(entries);
    return { ok: true, message: `已丢弃 #${index} [${removed.target}]`, removed, queued: entries.length };
  }

  /** Clear the whole queue. */
  clear() {
    const n = this.read().length;
    this.write([]);
    return { ok: true, message: `已清空待确认队列（${n} 条）`, queued: 0 };
  }
}

/** Path of the queue file under one memory root. */
export function suggestionsFile(root) {
  return join(root, 'SUGGESTIONS.jsonl');
}
