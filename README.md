# dsh-grok-memory

DeepSeek Harness 插件：**五轨跨会话记忆** —— 记住项目约定、决策与事实，新会话自动带着这些上下文开始；同时把「每日进展」这类流水日志排除在上下文之外，避免长会话被日志淹没。

> v0.3.0 由 `dsh-grok-memory`（Grok Build 风格存储 + FTS5 检索 + 首轮注入 + `/dream`）与 `dsh-memory-evolve`（五轨数据模型 + 注入范围分层 + 待确认队列 + 精确条目维护）合并而成。条目格式与 `dsh-memory-evolve` 逐字节兼容，**已有记忆目录可直接接管，无需迁移**。

## 安装

```sh
dsh plugin --profile <profile> add github:xuediner-source/dsh-grok-memory
```

重启 DSH 后即生效。若此前装了 `dsh-memory-evolve`，先移除它，否则两套 `memory` 工具会同时注册并互相冲突。

插件目录下不要安装 `@deepseek-ai/*`（包括把 DSH 的 `node_modules` 拷进来）。那些包必须由 DSH 主机提供；本地一份会盖掉主机解析，并曾导致 `z.const is not a function` 整棵插件树加载失败。

## 五轨与注入范围

注入范围按轨分层——这是本插件的核心设计，也是它比「一份 MEMORY.md 全量注入」更耐用的原因：

| 轨 | 文件 | 内容 | 是否注入上下文 |
|---|---|---|---|
| `memory` | `MEMORY.md` | 全局耐久事实（环境、约定、跨项目知识） | ✅ 是 |
| `user` | `USER.md` | 用户耐久事实（偏好、习惯） | ✅ 是 |
| `key` | `projects/<hash>/KEY.md` | **本项目**的关键长期结论 | ✅ 是 |
| `project` | `projects/<hash>/MEMORY.md` | 本项目逐轮进展日志 | ❌ 否，按需检索 |
| `daily` | `daily/<YYYY-MM-DD>.md` | 每日流水日志 | ❌ 否，按需检索 |

项目轨按 **`sha1(会话工作目录)[:12]`** 定位，与 `dsh-memory-evolve` 一致，所以既有 `projects/` 目录原样继续可用。代价是：同一仓库的不同 clone / worktree 视为不同项目、不共享记忆（上游按 git origin 共享，两者不可兼得，此处选了与既有数据兼容的一侧）。

## 写入信任级

注入轨的条目会静默影响此后每一个会话，所以它们**不能由模型直接写入**：

- `memory` / `user` / `key` → 走 `memory_suggest`，进 `SUGGESTIONS.jsonl` 待用户确认（重复建议合并计数，不重复堆积）；
- `project` / `daily` → 普通日志，`memory` 工具直接写。

写入路径统一做三件事：**提示注入扫描**（拒绝「忽略之前指令」一类表述，因为它会被重新注入）、**原子写**（临时文件 + rename，失败不留半条）、**唯一片段匹配**（`replace`/`remove` 命中多条时报错，绝不猜）。

## 工具

| 工具 | 用途 |
|---|---|
| `memory` | 五轨统一入口。`action` = `list` / `add` / `replace` / `remove` / `archive` / `promote` / `search`；`target` = 五轨之一 |
| `memory_suggest` | 提交需要用户确认的 `memory` / `user` / `key` 条目 |

`archive` / `promote` 在归档文件与主轨之间双向搬运：归档条目**不再注入**但仍可被检索到，适合「不再需要常驻上下文、但丢之可惜」的旧结论。

## 命令

| 命令 | 用途 |
|---|---|
| `/memory` | 浏览五轨条目数与待确认数量 |
| `/remember [轨::]声明` | 保存一条；注入轨自动转入待确认队列（默认轨 `project`） |
| `/suggest [list\|clear\|drop <n>]` | 查看 / 清空 / 丢弃待确认建议 |
| `/flush` | 把当前会话摘要写入会话日志（会话太小时如实拒绝） |
| `/dream [force]` | 把会话日志归并为去重的主题文件 |
| `/memclear [project\|key\|daily\|all\|suggestions]` | 分轨清理 |

## 检索

SQLite FTS5 + BM25，评分模型对齐官方 Grok Build：`score = vector_weight × vector + text_weight × bm25`（默认 0.7 / 0.3）。默认无本地 embedding，因此退化为纯全文模式。

- **时间衰减只作用于 `daily` / `project` 等时序轨**（`half_life_days=7`）——`memory` / `user` / `key` 是人工维护的长期知识，豁免衰减；
- 归档轨以 0.6 权重参与检索，所以归档不等于遗忘；
- 过期时序命中带 `may be stale — verify before relying on it` 标注；
- MMR 多样性重排默认关闭（与官方一致，可开）。

## 配置

```yaml
- id: dsh-grok-memory
  config:
    enabled: true
    memoryRoot: "~/.dsh/memories"
    injectionScan: true          # 提示注入扫描
    search:
      maxResults: 6
      minScore: 0.35
    injection:
      enabled: true
      maxChars: 12000            # 注入总预算
      memoryMaxChars: 2500       # 各注入轨独立预算
      userMaxChars: 1500
      keyMaxChars: 4000
      recallMaxChars: 2000
    dream:
      minHours: 4
      minSessions: 3
      staleLockSecs: 3600
```

## 验证

```sh
npm run check   # 语法
npm test        # 63 项测试
```

测试覆盖：`§` 格式往返与既有文件零改动接管、五轨独立与路径解析、时间戳盖章幂等与手写日期剥离、`replace` 保留条目 id 与分支范围、重复/空内容/注入表述拒绝、歧义匹配拒绝、失败不改文件、归档与取回、`list` 的过滤/日期/分支/归档/倒序、FTS5 跨轨检索与来源标注、衰减只作用于时序轨、注入只含注入轨且剥离程序前缀、各轨字符预算、待确认队列去重与丢弃、`/dream` 归并与门禁与陈旧锁回收、会话摘要不含工具用法与路径、六个命令与两个工具的行为、生命周期钩子（一次 settle 只写一份摘要、`{turn,signal}` 载荷无 `next` 回调、subagent 不注入）。

## 已知边界

- 会话摘要为**元数据摘要**（消息计数 + 前 5 个主题），不调 LLM，因此不总结决策内容——要记决策请用 `memory_suggest` / `/remember`。
- `/dream` 归并为规则式（按标题分组 + 语句去重），非 LLM 语义归并。
- 单进程文件锁，跨进程并发写同一轨未做仲裁。
- 无向量检索（无本地 embedding provider）。

## 许可

MIT © [xuediner-source](https://github.com/xuediner-source)
