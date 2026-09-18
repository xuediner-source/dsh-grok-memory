/**
 * Migrate a v0.2.x dsh-grok-memory store into the v0.3.0 five-track layout.
 *
 * The v0.2 layout kept one free-form `MEMORY.md` per workspace, whose sections
 * mixed durable project conclusions with pending action items. v0.3.0 splits
 * those by injection scope, so this script copies each section into the track
 * that matches its nature:
 *
 *   durable conclusions  -> key      (injected every session)
 *   pending work items   -> project  (on demand, not injected)
 *
 * The source file is never modified. Run with `--dry-run` first.
 *
 * Usage:
 *   node scripts/migrate-v0.2.mjs --from <oldRoot> --to <newRoot> --cwd <projectDir> [--dry-run]
 *
 * `--from` defaults to `~/.dsh/memory` (the v0.2 root) and `--to` to
 * `~/.dsh/memories` (the v0.3 root).
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { MemoryTracks, resolveTracks } from '../lib/tracks.js';

/** Section headings whose content is a pending work item, not a durable fact. */
const PROJECT_HINTS = [
  /待办/, /遗留/, /下一步/, /待补/, /待确认/, /未接入/, /同步待办/,
  /to-?do/i, /next\s+steps?/i, /open\s+items?/i, /follow-?ups?/i,
];

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const dryRun = args.includes('--dry-run');
const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
const fromRoot = flag('from', join(dshHome, 'memory'));
const toRoot = flag('to', join(dshHome, 'memories'));
const cwd = flag('cwd', process.cwd());

/** Split one markdown file into `{heading, body}` sections. */
export function sectionsOf(markdown) {
  const out = [];
  let current = null;
  for (const line of markdown.split('\n')) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      current = { heading: m[1], lines: [] };
      out.push(current);
      continue;
    }
    if (current) current.lines.push(line);
  }
  return out
    .map((s) => ({ heading: s.heading, body: s.lines.join('\n').trim() }))
    .filter((s) => s.body.length > 0);
}

/** Which track a section belongs to, by the nature of its content. */
export function trackForSection(heading) {
  return PROJECT_HINTS.some((re) => re.test(heading)) ? 'project' : 'key';
}

/** Locate the v0.2 workspace directories that hold a MEMORY.md. */
function oldWorkspaces(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((name) => join(root, name))
    .filter((p) => {
      try { return statSync(p).isDirectory() && existsSync(join(p, 'MEMORY.md')); } catch { return false; }
    });
}

function main() {
  console.log(`v0.2 -> v0.3 migration${dryRun ? ' (dry run)' : ''}`);
  console.log(`  from: ${fromRoot}`);
  console.log(`  to:   ${toRoot}`);
  console.log(`  cwd:  ${cwd}`);

  const workspaces = oldWorkspaces(fromRoot);
  if (workspaces.length === 0) {
    console.log('\n没有找到 v0.2 工作区记忆（%s 下没有含 MEMORY.md 的目录）。', fromRoot);
    return;
  }

  const store = new MemoryTracks(toRoot);
  const target = resolveTracks(toRoot, cwd);
  console.log(`\n项目轨目标：${target.projectDir}`);

  let total = 0;
  for (const ws of workspaces) {
    const markdown = readFileSync(join(ws, 'MEMORY.md'), 'utf8');
    const sections = sectionsOf(markdown);
    console.log(`\n源：${ws}  （${sections.length} 个小节）`);
    if (workspaces.length > 1) {
      console.log('  注意：v0.2 按 git origin / 路径分目录，v0.3 按 cwd 哈希定位项目。');
      console.log('  只有与 --cwd 对应的项目才应导入；其余源文件保持原样供人工判断。');
    }
    for (const section of sections) {
      const track = trackForSection(section.heading);
      const content = `【${section.heading}】\n${section.body}`;
      if (dryRun) {
        console.log(`  [dry] ${track.padEnd(8)} ${section.heading}  (${section.body.length} 字符)`);
        continue;
      }
      const result = store.add(track, content, cwd);
      console.log(`  ${result.ok ? '✓' : '✗'} ${track.padEnd(8)} ${section.heading}  ${result.message}`);
      if (result.ok) total += 1;
    }
  }

  if (dryRun) {
    console.log('\n干跑结束，未写入任何内容。去掉 --dry-run 执行实际迁移。');
    return;
  }
  console.log(`\n迁移完成：写入 ${total} 条。源文件未改动。`);
  console.log(`核对：node -e "import('./lib/tracks.js').then(m=>{const s=new m.MemoryTracks(${JSON.stringify(toRoot)});for(const t of m.TRACKS)console.log(t, s.entriesOf(t, ${JSON.stringify(cwd)}).length)})"`);
}

// Only run when invoked directly, so the helpers stay importable for tests.
if (process.argv[1] && process.argv[1].endsWith('migrate-v0.2.mjs')) main();
