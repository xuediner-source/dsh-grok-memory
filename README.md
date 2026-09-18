# dsh-grok-memory

DeepSeek Harness 插件：**Grok Build 风格的跨会话记忆** —— 记住项目约定、决策与事实，新会话自动带着这些上下文开始。

> 功能面严格对照**本机官方 Grok CLI（v1.0.13）自带文档** `~/.grok/docs/user-guide/13-memory.md` 逆向实现，逐条对齐存储布局、评分模型、门禁参数与措辞。

## 安装

```sh
dsh plugin --profile web add github:xuediner-source/dsh-grok-memory
```

重启 DSH 后即生效。

## 能力（对照官方规格）

| 官方机制 | 本插件实现 |
|---|---|
| **Markdown 存储**：`MEMORY.md` 全局 + `<slug>-<hash8>/MEMORY.md` 项目级 | `lib/store.js`，项目身份取 git `origin` 的 `org/repo`，无 origin 时回退目录路径 |
| **组织化条目**：声明写在 `## Preferences` / `## Project Context` 等标题下 | `appendEntry()`，自动建标题并追加 |
| **`/remember`**：保存耐久声明 | 命令 + `memory_remember` 工具 |
| **`/memory`**：按 scope 分组浏览记忆文件 | 命令输出 global / workspace / sessions / topics 四组 |
| **`/flush`**：把当前会话摘要写入日期会话日志 | 命令；会话太小时如实拒绝 |
| **`/dream`**：把会话日志归并为去重的主题文件 | `lib/dream.js`，输出 `topics/<topic>.md` |
| **自动会话摘要**：会话结束时写元数据摘要（消息计数 + 前 5 个主题），无 LLM 调用 | `agent/settled` 钩子 |
| **门禁**：`min_hours=4`、`min_sessions=3`、`stale_lock_secs=3600` | `gatesOpen()` + 锁回收 |
| **首次回合注入**：新会话首回合自动带上本项目记忆 | `systemPrompt.context` 快照：注入 workspace/global `MEMORY.md`，并检索更早的 session 日志 |
| **压缩后恢复**：compaction 后再搜一次记忆 | 监听 `compaction/completed`，刷新 recall 缓存 |
| **`memory_search` / `memory_get` / `memory_forget`** | 四个模型工具 |
| **搜索评分**：BM25 + 时间衰减（仅 session chunk，`half_life_days=7`） | `lib/search.js`，SQLite FTS5；MMR 默认关闭（与官方一致，可开） |
| **陈旧标注**：过期 session 记忆附"先验证再依赖"提示 | `stale` 标记 |
| **`/memclear`**：workspace / global / all 三档清理 | 命令 |
| **优先级规则**：当前会话指令 > 笔记 | usage section 中明文声明 |
| **摘要不含工具用法**：只记消息计数，不记工具调用/文件路径/命令 | `sessionSummary()` 规格与测试断言 |

## 与官方的已知差异

| 项 | 官方 | 本插件 | 原因 |
|---|---|---|---|
| 向量检索 | `vec0` + 可选 embedding（`vector_weight=0.7`） | 仅 FTS5 全文 | 无本地 embedding provider；官方也注明默认 embedding 未配置即全文模式 |
| `/memory` 浏览器 | 分栏 Modal（列表 + 只读预览，`y` 复制路径等快捷键） | 命令行分组列表 | DSH 命令返回文本，无 Modal 面板 |
| `/dream` 归并 | LLM 生成主题 | 规则式去重归并（按 `##` 标题分组 + 语句去重） | 规则式不调 LLM、零延迟、可测试；语义归并可后续接 LLM |
| `/flush` | LLM 生成丰富摘要 | 元数据摘要（消息计数 + 前 5 个主题） | 不额外打模型；要记决策请用 `/remember` |
| 环境变量开关 | `GROK_MEMORY=1/0` + TOML `[memory]` + 远程配置四级优先级 | 插件配置 `enabled` 字段 | DSH 插件体系用配置项而非环境变量 |

## 配置

```yaml
- id: dsh-grok-memory
  config:
    enabled: true
    memoryRoot: "~/.dsh/memory"
    search:
      maxResults: 6
      minScore: 0.35
    dream:
      minHours: 4
      minSessions: 3
      staleLockSecs: 3600
    injection:
      enabled: true
      minScore: 0
```

## 验证

```sh
npm run check   # 语法
npm test        # 35+ 项测试
```

测试覆盖：同源 git origin 共享目录、FTS5 检索、时间衰减只作用于 session chunk、MMR 多样性重排、dream 门禁与锁回收、归并去重、摘要不泄漏工具用法、五个命令与四个工具的行为、新对话自动注入上一对话的 workspace MEMORY.md、同一会话不重复写摘要。

## 许可

MIT © [xuediner-source](https://github.com/xuediner-source)
