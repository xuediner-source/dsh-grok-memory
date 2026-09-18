/**
 * Live smoke test against the REAL memory directory.
 *
 * Boots the plugin through the Cordis-like host with the production memory
 * root and exercises every command and both tools.
 *
 * SAFETY: the `memory`, `user` and `daily` tracks are root-level (shared by all
 * projects), so a scratch cwd does NOT isolate them. This script therefore runs
 * every write against a throwaway memory ROOT by default. Pass --live to point
 * at the real root (read-only inspection only, writes will pollute the global
 * tracks — run scripts/clean-smoke.mjs afterwards if you do).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPlugin, makeHost, emit } from '../test/harness.mjs';

const live = process.argv.includes('--live');
const realRoot = process.env.DSH_HOME ? join(process.env.DSH_HOME, 'memories') : 'C:/Users/19404/.dsh/memories';
// Default to a throwaway root: the global tracks are NOT per-project, so a
// scratch cwd alone would still write into the live MEMORY.md / USER.md.
const root = live ? realRoot : mkdtempSync(join(tmpdir(), 'gm-smoke-root-'));
const scratch = mkdtempSync(join(tmpdir(), 'gm-smoke-'));

const mod = await loadPlugin();
const { ctx, host } = makeHost();
mod.apply(ctx, { memoryRoot: root });

const agent = { session: { id: 'smoke-1', header: { cwd: scratch } } };
const call = async (name, args) => {
  const tool = host.tools.get(name);
  const result = await tool.execute(args, { agent });
  return tool.output.render(args, result)[0].text;
};

console.log('mode        :', live ? 'LIVE (只读检查 + 会写全局轨)' : 'isolated (throwaway root)');
console.log('memory root :', root);
console.log('scratch cwd :', scratch);
console.log('commands    :', [...host.commands.keys()].join(', '));
console.log('tools       :', [...host.tools.keys()].join(', '));

console.log('\n=== 1. 五个轨各写一条 ===');
for (const target of ['memory', 'user', 'key', 'project', 'daily']) {
  console.log(`  ${target.padEnd(8)} ${await call('memory', { action: 'add', target, content: `smoke ${target} fact` })}`);
}

console.log('\n=== 2. list / search ===');
console.log(await call('memory', { action: 'list', target: 'key' }));
console.log(await call('memory', { action: 'search', query: 'smoke' }));

console.log('\n=== 3. 注入轨被拒绝直写（memory_suggest）===');
console.log(await call('memory_suggest', { target: 'key', content: 'smoke suggestion', reason: 'smoke test' }));
console.log(await call('memory_suggest', { target: 'project', content: 'x' }));

console.log('\n=== 4. 命令 ===');
console.log(host.commands.get('memory').handler({ agent, rawInput: '' }).text);
console.log('--- /suggest ---');
console.log(host.commands.get('suggest').handler({ agent, rawInput: '' }).text);
console.log('--- /remember project:: ---');
console.log(host.commands.get('remember').handler({ agent, rawInput: 'project::smoke via command' }).text);
console.log('--- /dream ---');
console.log(host.commands.get('dream').handler({ agent, rawInput: '' }).text);

console.log('\n=== 5. 首轮注入快照（scratch 项目）===');
const snapshot = host.contexts.get('grok-memory:snapshot').text({ agent });
console.log(snapshot.slice(0, 700));
console.log(`\n[注入总长 ${snapshot.length} 字符；含 project 日志=${snapshot.includes('smoke project fact')}；含 key=${snapshot.includes('smoke key fact')}]`);

console.log('\n=== 6. 生命周期钩子 ===');
agent.session.events = [
  { type: 'user/message', data: { role: 'user', content: 'smoke prompt one' } },
  { type: 'user/message', data: { role: 'user', content: 'smoke prompt two' } },
  { type: 'user/message', data: { role: 'user', content: 'smoke prompt three' } },
];
await emit(host, 'agent/settled', agent, 1, 'completed');
await emit(host, 'agent/turn-stopping', { turn: 1, signal: undefined });
await emit(host, 'agent/disposed', { agent });
console.log('  settled / turn-stopping / disposed 均无异常');

console.log('\n=== 7. 真实项目记忆的注入（只读，始终读真实 root）===');
const liveMod = await loadPlugin();
const { ctx: liveCtx, host: liveHost } = makeHost();
liveMod.apply(liveCtx, { memoryRoot: realRoot });
const liveAgent = { session: { id: 'smoke-live', header: { cwd: 'F:\\低空经济' } } };
const liveSnapshot = liveHost.contexts.get('grok-memory:snapshot').text({ agent: liveAgent });
console.log(`  F:\\低空经济 注入长度 ${liveSnapshot.length} 字符`);
console.log(`  含课题7结论纪律: ${liveSnapshot.includes('课题7项目结论纪律')}`);
console.log(`  含迁移的政策台账: ${liveSnapshot.includes('渝府办发')}`);
console.log(`  含 project 日志（应 false）: ${liveSnapshot.includes('C 表的遗留问题')}`);

console.log('\n=== 8. 清理 ===');
console.log(host.commands.get('memclear').handler({ agent, rawInput: 'all' }).text);
console.log(host.commands.get('memclear').handler({ agent, rawInput: 'suggestions' }).text);
rmSync(scratch, { recursive: true, force: true });
if (!live) {
  rmSync(root, { recursive: true, force: true });
  console.log('  scratch 目录与临时 memory root 已删除');
} else {
  console.log('  注意：LIVE 模式下全局轨可能已被写入 smoke 条目，请运行 scripts/clean-smoke.mjs --apply');
}
