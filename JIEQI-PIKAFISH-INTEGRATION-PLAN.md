# 揭棋接入皮卡鱼引擎 · 开发方案（WASM 路线）

> 本文是 [JIEQI-DEVELOPMENT-PLAN.md](<./JIEQI-DEVELOPMENT-PLAN.md>) 的**后续方案**，
> 只解决一件事：把揭棋 AI 从「本地 TS 信念采样 AI」升级为「皮卡鱼揭棋引擎」。
> 本文**只做方案，不改代码**。
>
> 定稿路线（用户 2026-10 拍板）：**把官方 Pikafish 的 `jieqi` 分支编译成 Emscripten WASM，
> 随客户端离线内置**。明确**不采用**「包装层」方案（把揭棋局面伪装成标准象棋 FEN 喂给现有引擎）。
> AI **只看公开信息**，不允许偷看暗子真身。

---

## 0. 一页结论

| 项 | 结论 |
| --- | --- |
| 可行性 | ✅ **已端到端验证可行（2026-10 P0 完成）**。揭棋引擎已成功编译为 **384 KB WASM** 并在 Node/Worker 中**跑通揭棋搜索出着**（`bestmove h0g2`，~1.81M nps）。详见 §2.1.0a |
| 最大风险 | ~~供给~~ → **已消除**：`jieqi_old` 可 clone 且可编译；权重用 `-DUSE_NNUEEVAL=0` classical 退路**绕开**（已验证可跑）。当前主要风险转为**工程改造工作量**与 **GPLv3 分发义务** |
| 因此第一步 | ~~P0 可行性验证~~ → **已完成并通过**。下一步是 **P1 协议适配层**（把该 WASM 接入现有引擎承载四层） |
| 接入形态 | **完全复用现有本地引擎四层**，新增一个「揭棋引擎」实例与一层 FEN 方言编解码；**服务端零改动**（服务端已去 AI 化，无任何 AI 代码） |
| 暗子真相 | 引擎**天然只知道公开信息**（它靠 FEN 里的「未揭暗子池」推理），与本仓库**铁律 A** 完全同构 —— 这是本路线最大的架构红利 |
| 工作量 | 顺利（二进制可得）约 **11~15 人日**；不顺利（需自行编译/自行训练权重）**不可估**，且可能永远做不完 |
| 棋力预期 | 大师档显著强于现有 TS AI；**入门/进阶档必须靠降深度 + 随机化来削弱**，不能靠「看牌」 |
| GPL | 现有产物已内嵌 `GPL-3.0` 声明并纳入校验；揭棋引擎**照此办理即可**，但需新增**对应源码的书面 offer**（见 §7） |

---

## 1. 现状盘点（本仓库已具备什么）

### 1.1 本地皮卡鱼链路：四层都已「变体无关」

```
aiDispatcher                    纯本地调度，无网络
  └─ offlineAiAdapter           组 FEN/历史/白名单 + 三重守卫 + 重试
       └─ OfflineEngineOrchestrator   串行队列 + 优先级 + 降级
            ├─ PikafishOfflineEngine  UCI 生命周期（承载无关）
            │    └─ EngineTransport    web-worker / webview
            └─ LegacyTsEngine         兜底（同接口）
```

关键事实（逐条已核对源码）：

| # | 事实 | 位置 | 对本方案的意义 |
| --- | --- | --- | --- |
| 1 | `OfflineEngine` 接口**协议无关**，只说「给我这一步棋」 | [offlineEngine.ts:192](<./chinese-chess-client/client/utils/chess/offlineEngine.ts#L192>) | 揭棋引擎是**第三个实现**，不动上层 |
| 2 | 引擎已内置：`pikafish.wasm` 489KB + `data/pikafish.data` 4.0MB（NNUE），Emscripten 构建 | `client/engine-source/pikafish/` | **先例存在**：揭棋引擎走同一条构建/分发路 |
| 3 | 承载层是**通用 stdio 泵**：`send_command` / `read_stdout`，不理解协议内容 | [gen-pikafish-host.mjs:26-34](<./chinese-chess-client/client/scripts/gen-pikafish-host.mjs#L26-L34>) | 换引擎**不用重写承载** |
| 4 | 主线程侧发的是**命令字符串数组**（`commands: string[]`） | [engineTransport.ts:25-30](<./chinese-chess-client/client/utils/chess/pikafish/engineTransport.ts#L25-L30>) | 5 段揭棋 FEN 能原样穿过，**无需改消息契约** |
| 5 | 单线程 WASM，无 SharedArrayBuffer，无 COOP/COEP | [webWorkerTransport.ts:13-15](<./chinese-chess-client/client/utils/chess/pikafish/webWorkerTransport.ts#L13-L15>) | 新引擎**必须同规格编译**（见 §4.1） |
| 6 | 搜索**同步阻塞**，`stop` 不能中途打断，靠 `depth + movetime` 兜底 | [CLIENT-PIKAFISH-OFFLINE.md:86-88](<./CLIENT-PIKAFISH-OFFLINE.md#L86-L88>) | 揭棋档位设计沿用同一约束 |
| 7 | 全局**只有一个引擎实例**，编排器串行 | [offlineOrchestrator.ts:7-9](<./chinese-chess-client/client/utils/chess/pikafish/offlineOrchestrator.ts#L7-L9>) | 象棋与揭棋**各挂一个实例**的代价要算清（见 §5.4） |
| 8 | 引擎来源标签三值：`pikafish-local` / `pikafish-starting` / `legacy` | [aiDispatcher.ts:46-47](<./chinese-chess-client/client/utils/chess/aiDispatcher.ts#L46-L47>) | 揭棋要新增标签，不能复用 `legacy`（见 §6.5） |

### 1.2 揭棋侧已具备什么

| 能力 | 位置 | 状态 |
| --- | --- | --- |
| 暗子身份表 `JieqiIdentity{hiddenType[32], seed}` | [jieqi.ts:195-200](<./chinese-chess-client/client/utils/chess/jieqi.ts#L195-L200>) | ✅ 独立于 `GameState`（铁律 A） |
| 占位 id / 有效棋种 / 过河放宽三件套 | [jieqi.ts:135-166](<./chinese-chess-client/client/utils/chess/jieqi.ts#L135-L166>) | ✅ |
| 暗子身份**超几何后验**（解析可算） | [jieqi.ts:374-415](<./chinese-chess-client/client/utils/chess/jieqi.ts#L374-L415>) | ✅ **可直接当引擎的采样分布用**（§4.4） |
| `toFenString`：id→FEN 字符表（`k a a b b n n r r c c p×5 / 大写`） | [GameEngine.ts:854-883](<./chinese-chess-client/client/utils/chess/GameEngine.ts#L854-L883>) | ✅ 揭棋 FEN 第 1 段就在它上面加 `x`/`X` |
| `isFenBoardWidthValid`：逐行宽 9 | [GameEngine.ts:893-913](<./chinese-chess-client/client/utils/chess/GameEngine.ts#L893-L913>) | ✅ **`x`/`X` 天然通过**（`/[a-z]/i` 匹配，计宽 1） |
| `buildEngineHistory`：可重放片段（startFen + moves） | [GameEngine.ts:947](<./chinese-chess-client/client/utils/chess/GameEngine.ts#L947>) | ⚠️ 揭棋需**另写一份**（见 §4.3） |
| 揭棋 TS AI（信念期望 + 搜索树翻牌 + 确定性提示） | [AIEngine.ts:44-164](<./chinese-chess-client/client/utils/chess/AIEngine.ts#L44-L164>) | ✅ 留作**兜底**，不废弃 |
| 揭棋 9 个测试文件 | `utils/chess/__tests__/jieqi*.test.ts` | ✅ 回归基线 |

### 1.3 现状的三道「揭棋禁止进皮卡鱼」闸门

这三道闸是**上一阶段刻意加的**，本方案要**逐道重开**，且必须保证「新引擎不可用时闸门自动回落到原样」：

1. [aiDispatcher.ts:102](<./chinese-chess-client/client/utils/chess/aiDispatcher.ts#L102>) — `variant === 'jieqi'` 直接短路到 TS AI，标签写死 `legacy`
2. [offlineAiAdapter.ts:146](<./chinese-chess-client/client/utils/chess/offlineAiAdapter.ts#L146>) — 最深处显式抛 `OfflineMoveRejectedError`
3. [offlineAiAdapter.ts:363](<./chinese-chess-client/client/utils/chess/offlineAiAdapter.ts#L363>) — ponder 拒绝喂揭棋局面

> ⚠️ 理由原文仍然成立：「**皮卡鱼只懂象棋**」。本方案改变的是**引擎**，不是这句判断 ——
> 换上的必须是**懂揭棋的**引擎二进制。在拿到它之前，三道闸一道都不能拆。

### 1.4 服务端：零改动

`chinese-chess-server/src/` 只有 `index.ts` + `routes/{lanGame,battleWs,actionOutcome}.ts`，
**已无任何 AI 代码、无 `/api/v1/ai/*`、无引擎二进制**（2026-10 去 AI 化）。
旧方案 §7.4「揭棋禁止走 `/ai/move`」与「`isFenBoardShapeValid` 加固缺口」**已随该接口删除而失效**。
本方案**服务端一行不改**。

---

## 2. 外部事实核查（GitHub 揭棋项目 + 皮卡鱼 `jieqi` 分支）

> 本节是决策依据。凡未标 ✅ 的，都是**尚未取得证据**的假设，必须在 P0 逐条验证后才能开工。

### 2.1 相关项目清单

| 项目 | 是什么 | 能否当引擎用 | 判定 |
| --- | --- | --- | --- |
| 官方 [Pikafish](https://github.com/official-pikafish/Pikafish) master | 标准象棋引擎（**UCI**，非 UCCI） | ❌ 不懂暗子 | 本仓库现内置的正是它（`dev-20240226-98b20a33`） |
| 官方 `jieqi` 分支 | 皮卡鱼的揭棋变体分支，C++ 原生构建 | ✅ **本方案的目标** | 需 P0 核实：产物/权重/协议（§2.3） || [lichlzh/pikafish-jieqi](https://github.com/lichlzh/pikafish-jieqi) | **Qt6 桌面 GUI**（PikaJieqi），`engine/` 只有 `engineclient.cpp` 一个 `QProcess` UCI 客户端 | ❌ 本体无算力 | **但它是最佳资料来源**：README 记录了 `jieqi` 分支的 FEN 方言与揭晓后缀；`core/` 是不依赖 Qt 的纯 C++17 揭棋规则实现，可当**规则对拍基准** |
| [miaosiSari/Jieqi](https://github.com/miaosiSari/Jieqi) | 揭棋 AI | 待核 | 备选/参考 |
| [arthuryangcs/JieqiAI](https://github.com/arthuryangcs/JieqiAI) | 揭棋 AI 系统 | 待核 | 备选/参考 |
| [Velithia/JieqiBox](https://github.com/Velithia/JieqiBox) | 揭棋桌面 GUI | ❌ GUI | UI/交互参考 |
| [lxsgx23/Jieqi-Match-Tools](https://github.com/lxsgx23) | 自对弈匹配工具 | — | 棋力评测可用（§8.3） |

---

### 2.1.0a 【2026-10 P0 结论】揭棋引擎 WASM 化 **已端到端验证成功** 🎉

> 这是本轮最重要成果：路线 A 的核心不确定性**已消除**。

**实测结果**（构建产物：`client/engine-source/jieqi/jieqi.wasm`，384.4 KB）

```
$ UCI: uci → isready → position fen <揭棋初始FEN> → go depth 6 movetime 5000

info depth 1 seldepth 1 score cp 267 nodes 46737  nps 1374617 time 34 pv g0e2
info depth 2 seldepth 2 score cp 277 nodes 95404  nps 1564000 time 61 pv g3g4
...
info depth 6 seldepth 4 score cp 241 nodes 686848 nps 1812263 time 379 pv h0g2 c9e7
bestmove h0g2 ponder c9e7
```

| 判据 | 结果 |
| --- | --- |
| 完整编译（20 源文件） | ✅ release `-O2 -DNDEBUG` |
| 产出 WASM | ✅ **384.4 KB**，`-DUSE_NNUEEVAL=0` classical，**不依赖权重** |
| Node 中 UCI 握手 | ✅ `uciok` + `readyok` + 完整 option 表 |
| **揭棋搜索出着** | ✅ `bestmove h0g2`，depth 1→6 迭代加深 |
| **性能** | ✅ **~1.81M nps**（180 万节点/秒） |
| **揭晓后缀重放** | ✅ `moves h0g2R` 被正确解析，换边后评分视角正确（+260 → -406） |

→ **结论**：揭棋引擎可完整编译为 WASM 并在浏览器/Worker 中运行。
**权重不再是阻塞项**（classical 退路已验证可跑，棋力优化可作为后续项）。

**已实施并验证的单线程适配补丁（5 处，全部必需）**

Emscripten 单线程下 `std::thread` 构造会 `abort()`。本引擎 5 处依赖真实线程，已全部适配
（补丁在 `client/engine-source/jieqi/patches/`，用 `__EMSCRIPTEN__` 守卫，**不影响原生构建**）：

| 文件 | 问题 | 修复 |
| --- | --- | --- |
| `thread_win32_osx.h` | `NativeThread` = `std::thread` 建真实线程 | 空实现 `NativeThread`（不建线程） |
| `thread.cpp` | `wait_for_search_finished()` 等 `idle_loop` → **死锁** | 单线程直接 return |
| `thread.cpp` | `start_searching()` 无人执行搜索；置位不复位 → 析构断言失败 | 单线程**同步执行 `search()`** 再复位 |
| `tt.cpp` | `TT::clear()` 用 `std::vector<std::thread>` | 单线程直接 `memset` |
| `thread.h` | `searching` 初值 `true` → 析构 `assert(!searching)` 失败 | 单线程初值 `false` |

> `-DNDEBUG` 也是必需的：否则 Stockfish 遗留的调试断言
> （如 `search.cpp:1905 assert(!MoveList<LEGAL>(pos).size())`）在揭棋下会误触发
> —— 因为揭棋「暗子不算攻击者」使其与原生将军判定不一致。

**踩坑记录（供后续复现）**

1. `INCOMING_MODULE_JS_API` **必须**含 `stdin`，否则传 stdin 回调时 `Aborted()`；
2. emsdk 官方安装器在 Windows 上因 `WinError 5`（解压 `.py` 被拦）失败
   → 解法：用 .NET `ZipFile` 手工解压，并把 `upstream/install/*` 上提一层；
3. 源码是 **CRLF** 换行，打补丁脚本必须换行无关（用正则，勿用字面量）。

### 2.1.0c 【2026-10 权重调研结论】专用权重 **确认不存在**，且本分支默认不用 NNUE

> 网络调研 + 本地源码核实，双重确认。

**结论 1：`jieqi_old` 硬编码 `#define USE_NNUEEVAL 0`**（本地核实 `src/types.h:106`）

⇒ **即使拿到完美匹配的权重，默认编译产物也不会使用它。**
`Eval::evaluate()` 走 `#else` 分支；`NNUE::verify()` 在 `#else` 里直接 `return`（加载失败静默降级）。

**结论 2：classical 退路比我原先描述的更强（非子力差）**

```cpp
// evaluate.cpp，#else 分支
Value v = Evaluation<NO_TRACE>(pos).value();
```

这是 **psqt + threats + pair + space + mobility 的完整经典评估**
（Stockfish 2015 年代成熟实现）。实测 depth 6 评分 `cp 267` 且随深度合理波动，
评估确实在工作。⇒ 「权重不可得」对棋力的影响**小于原方案估计**。

**结论 3：权重公开渠道确认无解**

| 渠道 | 结论 |
| --- | --- |
| 皮卡鱼官网下载页 | 无揭棋版、无权重入口 |
| 官方论坛揭棋版块（tid-268 / fid=45） | 2025-01 至今仅 3 主题；ipikafish 2025-07-17 称「快去下载」但**正文无任何 URL**；carot 2026-09-17 求助权重 **至今零回复** |
| 官方 `Networks` 仓库 | 仅 master 滚动网 |
| `jieqi_old` CI workflow | 只打包 exe/bin + 文档，无 nnue |

**结论 4：AB-JChess 权重与 `jieqi_old` 完全不兼容**（四个独立硬阻断）

容器 magic（`ABJCHESSV11` vs `Version=0x7AF32F20`）、特征维度（34800 vs 7020）、
PSQT 桶（0 vs 8，AB-JChess 显式校验非零）、哈希算法（SHA-256 vs uint32 链式）。
任一独立成立即拒绝加载。

**后续建议（不排期）**

1. `jieqi`（非 `_old`）分支的 NNUE 是**活的**（有 `network.cpp`、`scripts/net.sh`、
   zstd 解压），若要 NNUE 棋力，**它比 `jieqi_old` 更值得投入** —— 但需重新做一次
   WASM 适配（含 NNUE 的 SIMD 热路径，实测 WASM 下 NNUE 掉到 ~60 knps，见 §10 风险 1）；
2. `jieqi_old` 的哈希契约已完整推导（`Version=0x7AF32F20`、特征集 `HashValue=0xd17b100`、
   1536 宽、PSQT 8 桶、8 层栈、起始常量 `0xEC42E90D`），拿到任何候选权重可**读 header
   第 2 个 u32 秒判**是否匹配；
3. 唯一可能拿到真链接的途径：QQ 群 1062385162 直接问 ipikafish 本人。

### 2.1.0b 【2026-10 P0 编译实测】WASM 化真实进展与根因

> 本机 emsdk 6.0.12-git + clang 24 实测（源码 = `jieqi_old` `23b9466`）。

**已达成（实测证据）**

| 项 | 结果 | 证据 |
| --- | --- | --- |
| emsdk 可用 | ✅ `emcc 6.0.12-git`、`clang 24.0.0git` | `emcc.py --version` 正常输出 |
| **20 个源文件全部编译通过** | ✅ 含揭棋核心 `position.cpp` / `uci.cpp` / `search.cpp` | 逐个 `em++ -c` exit=0 |
| **产出 WASM** | ✅ **403.5 KB**（classical 评估，`-DUSE_NNUEEVAL=0`，**不依赖权重**） | `build/jieqi.wasm` |
| 引擎在 Node 中启动 | ✅ 打印横幅 `Pikafish 2026-10-09 by the Pikafish developers` | 探针观测 |

**当前阻塞（已定位根因，非"不明原因"）**

```
thread.cpp:  Thread::Thread(size_t n) : idx(n), stdThread(&Thread::idle_loop, this)
             → 构造函数立即创建真实 std::thread
main.cpp:    Threads.set(size_t(Options["Threads"]))  →  new MainThread(0)
             → 触发 std::thread 创建
             → 单线程 WASM（未启 -pthread）下 std::thread 构造直接 abort()
```

→ 表现为 `Aborted(native code called abort())`，发生在 `main()` 早期（早于任何探针输出）。

**这解释了为什么官方要有 `wasm` 分支**：Stockfish/Pikafish 的 WASM 端口本质工作之一就是
**把线程模型改成单线程**（`-DSINGLE_THREAD` 或条件编译 `Thread`）。

**决定性对照实验（本机实测）**

| 实验 | 配置 | 结果 |
| --- | --- | --- |
| 最小 C++ 程序（`mini.cpp`，仅打印） | **完全相同**的 emcc 参数与环境 | ✅ 正常输出 `MINI OK` |
| `jieqi_old` 引擎 | 同上 | ❌ `Aborted()`，且**连 `main()` 内第一行探针都不输出** |

→ 结论：**工具链、编译参数、Node 加载方式均已验证正常**（排除环境问题）；
abort 来自**引擎自身的静态初始化期**（全局对象构造，早于 `main()`），
最可疑的是 `thread.h` 中作为成员变量的 `std::mutex` / `std::condition_variable`，
以及全局 `ThreadPool Threads` / `UCI::OptionsMap Options` 的构造。

**已实施的单线程适配补丁（3 处，方向正确、需保留）**

1. `thread_win32_osx.h` — 新增 `#elif defined(__EMSCRIPTEN__) && !defined(USE_PTHREADS)` 分支，
   提供**不创建真实线程**的 `NativeThread` 空实现；
2. `thread.cpp` — `wait_for_search_finished()` 在单线程下直接 `return`（否则因无 `idle_loop` 死锁，实测 `uci+quit` 即卡死）；
3. `thread.h` — `searching` 初始值在单线程下改为 `false`（否则析构 `assert(!searching)` 触发 abort）。

**下一步（需改引擎源码，约 1~2 人日）**

| 方案 | 做法 | 代价 |
| --- | --- | --- |
| **A（推荐）** 条件编译单线程 | 给 `Thread::Thread` 加 `#if defined(__EMSCRIPTEN__) && !defined(USE_PTHREADS)` 分支：不建 `stdThread`，`idle_loop` 改为同步空转；`wait_for_search_finished` 直接返回 | 改动小，与现有单线程 WASM 架构一致 |
| B 启用 Emscripten pthreads | `-pthread -sUSE_PTHREADS=1` | ❌ **需 SharedArrayBuffer + COOP/COEP 响应头**，与本仓库现有「单线程、无 SAB」架构冲突（`webWorkerTransport.ts:13-15`） |
| C 移植官方 `wasm` 分支 | 用其 `-DSINGLE_THREAD` 方案 | 该分支源码是 2023 年布局，与 `jieqi_old` 差异大，合并成本高 |

> 📌 结论：**WASM 化路线技术可行**，编译链路已全部打通；剩余工作是明确的工程改造（单线程适配），
> 不再是"能否做到"的不确定性，而是"做多久"的确定性工作。

### 2.1.0 【2026-10 P0 实测更正】三条改变结论的事实

> 以下为本轮**亲自 clone 源码核实**的结果，覆盖 §2.1.1 的间接证据与 §2.3 的风险评级。

| # | 事实 | 证据 | 对方案的影响 |
| --- | --- | --- | --- |
| 1 | **官方 `jieqi` 分支已消失**；现存只有 `jieqi_old`（`23b9466`，2025-08-04，"Fix a bug"） | `git ls-remote --heads` 仅返回 `jieqi_old` / `master` / `tune`；`jieqi` 已 404 | 目标分支改为 **`jieqi_old`** |
| 2 | `jieqi_old` **源码完整且含全部揭棋逻辑** | clone 后 grep 到 `isDark`、`PieceExchange`、`pGet`、`pCaptured`、`do_flip`（`position.cpp/.h`、`search.cpp`、`uci.cpp`、`types.h`） | ✅ 路线前提成立，可编译 |
| 3 | **`jieqi_old` 保留完整 classical 评估**，且 `evaluate.cpp` 有 `#if USE_NNUEEVAL` 退路分支（关掉后走 `pos.material_diff()`） | 存在 `material.cpp` / `psqt.cpp`（classical 标志文件）；`evaluate.cpp` 仅 2 处 `USE_NNUEEVAL` 守卫 | 🔴 **推翻「权重拿不到 = 路线终止」** → 降级为「棋力优化项」 |
| 4 | 引擎**无运行时 `UseNNUE` 选项** | `ucioption.cpp` 选项表只有 `EvalFile`，无 `UseNNUE` | 关 NNUE 只能**编译期** `-DUSE_NNUEEVAL=0` |
| 5 | 初始 FEN 确认（揭棋串，含暗子池第 3 段） | `uci.cpp`: `xxxxkxxxx/9/1x5x1/.../XXXXKXXXX w R2A2C2P5N2B2r2a2c2p5n2b2 0 1` | §2.2 协议方言**已由源码直接证实**（不再是二手 README） |
| 6 | 源码规模可控 | 34 个 `.cpp/.h`，约 **10,991 行** | 移植/裁剪工作量可估 |
| 7 | **本机 `git` 可访问 GitHub**；`emcc` 未装但 emsdk 可 clone | `git ls-remote emsdk` 成功返回 | P0 可在本机执行，无需代理 |

### 2.1.1 证据强度声明（诚实标注）

| 结论 | 强度 | 说明 |
| --- | --- | --- |
| 官方 org `official-pikafish` 下**没有独立的揭棋仓库** | ✅ **已核实** | 镜像索引列出该 org 全部仓库：`Pikafish`、`Networks`、`px0`、`pxzero-training`、`lczero-client`、`pxzero-networks`、`fast`（[repos.ecosyste.ms/hosts/GitHub/owners/official-pikafish](https://repos.ecosyste.ms/hosts/GitHub/owners/official-pikafish)）。故揭棋支持**只可能以分支/fork 形式存在** |
| `Pikafish` 主仓是 C++、UCI、活跃（近期有 push） | ✅ 已核实 | 同上（Language: C++，2.1k stars） |
| 官方存在 `jieqi` 分支 | ⚠️ **间接证据** | 来自 [JIEQI-DEVELOPMENT-PLAN.md §9.1](<./JIEQI-DEVELOPMENT-PLAN.md#L707-L722>) 记录的核查结论 + `lichlzh/pikafish-jieqi` 的依赖关系描述。**本次会话无法直连 GitHub 复核**（`github.com` / `api.github.com` / `raw.githubusercontent.com` 在本环境均解析到非公网 IP 而被拦） |
| 分支协议（5 段 FEN + 揭晓后缀） | ⚠️ 二手 | 来自 `lichlzh/pikafish-jieqi` README 的记录，非引擎源码原文 |
| 分支的构建方式 / 权重体系 / 最后提交时间 | ⚠️ 二手 | 同上，需在 P0 用**本地 clone** 复核 |

> 🔴 **因此 P0 的第一项工作不是编译，而是「把分支拿到本地并核对上述事实」**。
> 若 `jieqi` 分支实际不存在或已删除，本方案 §2.2 之后的全部设计前提失效，
> 应立刻转 §12 问题 4 的备选路线，不要继续投入。

### 2.2 协议方言（来源：`lichlzh/pikafish-jieqi` README 记录，**待 P0 以引擎源码复核**）

```
初始 FEN（5 段）：
xxxxkxxxx/9/1x5x1/x1x1x1x1x/9/9/X1X1X1X1X/1X5X1/9/XXXXKXXXX w R2A2C2P5N2B2r2a2c2p5n2b2 0 1
                                                       │ │                            │ │
                                                       │ └ 第 3 段 = 未揭暗子池（棋种+数量） └ 半回合 / 满回合
走法（4 字符坐标 + 可选揭晓后缀）：
  e7e6     无揭晓
  e7e6R    5 字符：自身暗子揭为红车
  e7e6Rp   6 字符：R = 自身揭晓，p = 被吃暗子身份
```

> ✅ **已本地校验（2026-10）**：该参考串 10 行、每行宽度严格为 9，
> 暗子池 `R2A2C2P5N2B2r2a2c2p5n2b2` 总数 = 30（每方 15），与「除将帅外全部暗置」一致；
> 大写=红、小写=黑、`x`=暗子 —— 与本仓库 `FEN_CHARS` 的大小写约定**完全同构**
> （[GameEngine.ts:855-858](<./chinese-chess-client/client/utils/chess/GameEngine.ts#L855-L858>)：id 0..15 小写=黑，16..31 大写=红）。
> 因此**揭棋初始局面的 FEN 第 1 段是一个常量**，可直接写死进单测断言：
>
> ```
> xxxxkxxxx/9/1x5x1/x1x1x1x1x/9/9/X1X1X1X1X/1X5X1/9/XXXXKXXXX
> ```
>
> ⚠️ 池内**排序**（`R A C P N B`，而非标准 `K A B N R C P` 的相对顺序）与
> 是否允许缺项/零项，**必须按引擎解析器的实际要求来**，不能照抄 README
> —— 列入 P0 实测（§2.3 #5）。

#### 2.2.1 一条可直接钉死的不变量（已本地推导）

把本仓库 `toFenString` 的**标准象棋初始 FEN** 中除将/帅外的所有棋子字符替换为 `x`/`X`，
结果与上面的揭棋参考串**逐字符相等**：

```
标准：  rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w
揭棋：  xxxxkxxxx/9/1x5x1/x1x1x1x1x/9/9/X1X1X1X1X/1X5X1/9/XXXXKXXXX w
        └ 仅把非将帅字符换成 x/X，行宽/斜杠/位置一个不动
```

这条不变量的价值有三层：

1. **印证「占位 id == 该位标准 id」的设计**（[jieqi.ts:169-177](<./chinese-chess-client/client/utils/chess/jieqi.ts#L169-L177>) 的 `hiddenSlotIdsOf`）——
   暗子恰好占据标准初始格，与引擎 FEN 的 `x` 位置**同一套坐标**；
2. **`toJieqiFenString` 可以写成 `toFenString` 的一层薄包装**，而不是第二套棋盘序列化实现
   （本仓库反复强调的「同一语义多处实现必然漂移」，[JIEQI-DEVELOPMENT-PLAN.md:588](<./JIEQI-DEVELOPMENT-PLAN.md#L588>)）；
3. **`isFenBoardWidthValid` 天然放行**：`x`/`X` 命中其 `/[a-z]/i` 分支并计宽 1
   （[GameEngine.ts:905-907](<./chinese-chess-client/client/utils/chess/GameEngine.ts#L905-L907>)），
   越界写内存打崩 Worker 的历史事故（[:888-891](<./chinese-chess-client/client/utils/chess/GameEngine.ts#L888-L891>)）
   **不会因为换了变体就复发**。

> 📌 列为 §8.1 `jieqiFen.test.ts` 的**第一条**断言（初始局面逐字符对拍）。

**这套方言与本仓库数据结构几乎一一对应**，是本方案 §4 全部编解码设计的基础：

| 揭棋 FEN 概念 | 本仓库对应物 |
| --- | --- |
| `x`/`X` 暗子 | `hiddenMask[id] === true` |
| 明子（真实棋种字符） | `revealedType[id] ?? 棋位棋种` |
| 第 3 段「未揭暗子池」 | ⚠️ **不等于** `hiddenIdentityPosterior` 的 `remaining`（口径差见 §4.2）；需新增 `JieqiDeterminization.pool`（§4.4.1） |
| 揭晓后缀 `R` / `Rp` | `makeMove` 的 `flipping` + `revealedType` 写入（[GameEngine.ts:559-576](<./chinese-chess-client/client/utils/chess/GameEngine.ts#L559-L576>)） |
| 引擎不知道暗子真身 | **铁律 A**（身份只在 `jieqiSecret` / `jieqiIdentityRef`） |

> ✅ 最后一条是**架构级印证**：官方揭棋引擎的设计前提与我们的「暗子真相不外泄」是同一件事。
> 走这条路线，我们**不需要为了喂引擎而泄漏身份**。

### 2.3 P0 必须实测的六件事（阻塞项）

| # | 待验证 | 若为否 | 验证方式 |
| --- | --- | --- | --- |
| 1 | `jieqi` 分支**能否用 Emscripten 编译通过**（官方无 emscripten target） | ~~路线终止~~ | ✅ **已完成**（§2.1.0a）：20 源文件全编译通过，产出 384KB WASM |
| 2 | 编译产物**能否在浏览器 Worker 里跑起来**（`-msimd128`、无 pthreads、内存上限） | ~~路线终止~~ | ✅ **已完成**（Node 中握手+搜索出着均成功；Worker 接入见 P1） |
| 3 | **NNUE 权重能否取得**（该分支权重体系与 master 独立） | 只能关 NNUE 跑 classical eval，棋力大降 | 找分支内嵌默认网 / 社群分发 |
| 4 | 关掉 `UseNNUE` 后引擎**是否仍可正常搜索** | 无退路 | `setoption name UseNNUE value false` |
| 5 | `position fen <5段>` 是否支持 `moves` 重放；`searchmoves` 是否接受带揭晓后缀的着法 | 影响 §4.3/§4.5 设计 | 手工握手实测 |
| 6 | 规则口径与**本仓库定稿**是否一致（§2.4） | 需要白名单/后处理弥合 | 与 `core/` 对拍 + 自对弈 |

### 2.4 规则口径差异清单（本仓库定稿 vs 引擎）

| 议题 | 本仓库定稿 | 引擎（`lichlzh` 描述） | 处理 |
| --- | --- | --- | --- |
| 吃暗子后吃子方是否补一枚新暗子 | ❌ 不补，盘面直接少一枚（决策 A） | ❌ 不补（`pool_` → `capturedDarkPool_`） | ✅ 一致 |
| 被吃暗子是否向吃子方揭晓 | ❌ 双方都看不到（铁律 A） | ⚠️ 被吃时**会翻开** | **P0 必查**：引擎是否把被吃暗子身份写进 FEN/着法。若写，适配层必须**丢弃**该信息（§4.6） |
| 暗子是否算攻击者 | ❌ 不算（不将军、不照面） | 待核 | 不一致则靠 `searchmoves` 白名单兜 |
| 已翻开士/象放宽 | ✅ 可出九宫/过河 | ✅ 一致 | ✅ |
| 原地翻子 | ❌ 不做（定稿 #1） | 待核 | 白名单不含即不会发生 |
| 长将长捉 | 沿用现有 `RULE_CONFIG`（阈值后**禁着**） | 待核 | **靠 `searchmoves` 白名单**（现有机制，[offlineAiAdapter.ts:76-97](<./chinese-chess-client/client/utils/chess/offlineAiAdapter.ts#L76-L97>)） |

---

## 3. 架构方案

### 3.1 一句话

**新增一个「揭棋引擎实例」，与现有象棋引擎共用同一套承载与编排；差异全部收敛在三个新文件——`jieqiDeterminization.ts`（确定化簿记）、`jieqiFen.ts`（5 段 FEN 编解码）、`jieqiUci.ts`（揭晓后缀着法）+ 一个 `variant` 分流点。**

### 3.2 目标形态

```
aiDispatcher
  ├─ variant='xiangqi' → 现有象棋引擎（一字不改）
  └─ variant='jieqi'   → 揭棋引擎（新）
                            │
                            ├─ jieqiDeterminization.ts  后验采样 → 声明身份 + 引擎池（§4.4.1）
                            ├─ jieqiFen.ts              GameState + 确定化 → 5 段 FEN
                            ├─ jieqiUci.ts              揭晓后缀着法编解码 + 校验
                            └─ OfflineEngineOrchestrator（复用）
                                 ├─ PikafishOfflineEngine（复用，指向新资产）
                                 └─ LegacyTsEngine（复用，揭棋分支已实现）
```

### 3.3 为什么不复用「同一个引擎实例」

| 方案 | 优点 | 缺点 | 选择 |
| --- | --- | --- | --- |
| A. 象棋/揭棋共用一个实例，每次搜索前 `ucinewgame` + 换资产 | 省 5MB 内存 | **不可能**：`jieqi` 分支与 master 是**两个不同的 wasm 二进制**，一个 Module 实例只能装一个 | ❌ |
| B. 两个引擎实例，**懒加载**：进入哪种模式才起哪个 | 内存只在用到时占用；互不干扰 | 首次进入揭棋有一次冷启动 | ✅ |
| C. 两个实例都预热 | 无冷启动 | 常驻 ~10MB + 双份 Worker | ❌ |

**定稿 B**：`getOfflineEngine()` 保持象棋单例不变；新增 `getJieqiOfflineEngine()` 懒创建单例，
只在 `variant === 'jieqi'` 的对局里被触碰。现有 `warmupLocalEngine()` **只预热象棋**（首页默认路径），
揭棋预热挂在对局页进入时。

### 3.4 资产与产物布局

沿用现有「构建期源 → 生成产物 → 随包分发」三段式（[CLIENT-PIKAFISH-OFFLINE.md:77-82](<./CLIENT-PIKAFISH-OFFLINE.md#L77-L82>)）：

```
client/engine-source/pikafish-jieqi/     【新】构建期材料，不入部署包
  pikafish-jieqi.cjs / .wasm / data/pikafish-jieqi.data

client/assets/engines/
  pikafish.worker.bin / pikafish.html / pikafish.wasm / pikafish.nnue      （现有，象棋）
  jieqi.worker.bin / jieqi.html / jieqi.wasm / jieqi.nnue                  【新】

client/scripts/gen-jieqi-host.mjs        【新】由 gen-pikafish-host.mjs 派生
client/scripts/verify-jieqi-engine-assets.mjs  【新】
```

> ⚠️ 后缀约定**必须照抄**（`.bin` 而非 `.js`、`assetExts` 登记、**不得用 `blockList`**）：
> 这三条都是踩过的坑，见 [metro.config.js:37-41](<./chinese-chess-client/client/metro.config.js#L37-L41>)
> 与 [:111-127](<./chinese-chess-client/client/metro.config.js#L111-L127>)。
> `pack.ps1` 的 `engine-source` 排除项要扩到两个目录（[pack.ps1:124-129](<./pack.ps1#L124-L129>)）。

---

## 4. 协议适配层设计

### 4.1 编译配方（P0 试编清单）

必须与现有产物同规格，否则现有承载层全部失效：

| 约束 | 原因 | 现有先例 |
| --- | --- | --- |
| **单线程**，`-DUSE_PTHREADS=0` | 无 SharedArrayBuffer → 不需要 COOP/COEP 响应头 | [webWorkerTransport.ts:13-15](<./chinese-chess-client/client/utils/chess/pikafish/webWorkerTransport.ts#L13-L15>) |
| 暴露 `send_command` / `read_stdout` | 承载层协议依赖 | [gen-pikafish-host.mjs:31-33](<./chinese-chess-client/client/scripts/gen-pikafish-host.mjs#L31-L33>) |
| 工厂返回 `Module['ready']` Promise | 最易踩的接入坑 | [CLIENT-PIKAFISH-OFFLINE.md:92-94](<./CLIENT-PIKAFISH-OFFLINE.md#L92-L94>) |
| `getPreloadedPackage` / `instantiateWasm` 注入口保留 | 全程不碰 `fs`（Worker 里没有 fs） | [gen-pikafish-host.mjs:33-34](<./chinese-chess-client/client/scripts/gen-pikafish-host.mjs#L33-L34>) |
| 体积预算 | 现象棋 wasm 489KB + 权重 4.0MB；揭棋**不得显著超出** | `engine-source/pikafish/` |

> 📌 具体 emcc flags 由 P0 实测确定（需外部调研结论 + 本地试编），本文不预先编造。

#### 4.1.1 本机工具链现状（**已实测**，决定 P0 能否就地开工）

| 工具 | 状态 |
| --- | --- |
| `git` | ✅ `D:\Code\Git\cmd\git.exe` |
| `python` | ✅ `C:\Python314\python.exe`（emsdk 脚本需要） |
| `emcc` / `em++` / `emsdk` / `wasm-opt` | ❌ **全部未安装**（PATH 无、常见目录 `~\emsdk`、`C:\emsdk`、`D:\emsdk` 均不存在） |
| `clang++` / `g++` / `cmake` / `make` / `cl.exe` | ❌ 均不在 PATH |

→ **P0 第 ① 步必须先装 emsdk**（`git clone emsdk` + `emsdk install latest` + `emsdk activate`），
约 0.5 人日 + 数 GB 下载。这是**纯前置成本，与引擎能否编译无关**，故应在 P0 一开始就做，
不要等到要编译时才发现缺工具而空转。

> ⚠️ 另需注意：`AGENTS.md` 记录本机 `node` / `pnpm` 也不在 PATH，需用 DSH 内置运行时。
> emsdk 的 `emsdk.py` 与构建脚本都依赖 PATH 上有可用解释器，装的时候一并确认。

### 4.2 `toJieqiFenString(state, identity?)` —— 编码

**输入只有 `GameState`（+ 可选 `revealedType`），绝不读 `identity.hiddenType`。**

```
第 1 段（棋盘）：逐格
  hiddenMask[id] === true            → 'x'（黑方）/ 'X'（红方）
  已翻开                              → 用 revealedType[id] 查 FEN_CHARS
  明子（将帅/从未暗置的子）             → 现有 FEN_CHARS[id]
第 2 段：'w' | 'b'（沿用 sideTag）
第 3 段：未揭暗子池 = **`JieqiDeterminization.pool`**（精确多重集，见 §4.4.1），
        按 R H E A C P N r h e a c p n 排序，形如 'R2A2C2P5N2B2r2a2c2p5n2b2'
第 4 段：半回合计数 = ruleState.naturalMoveCounter
第 5 段：满回合计数 = ceil(moveHistory.length / 2) + 1
```

`FEN_CHARS` 直接复用 [GameEngine.ts:855-858](<./chinese-chess-client/client/utils/chess/GameEngine.ts#L855-L858>)。

#### 4.2.1 【2026-10 源码级校正】暗子池的确切语义（来自 `jieqi_old` `position.cpp`）

我直接读了 `Position::set()` 的 `//2.rest` 段，**逐条纠正**此前的 README 二手推断：

| # | 源码事实 | 纠正前（README 二手） | 影响 |
| --- | --- | --- | --- |
| 1 | 池段解析为「棋种字符 → 数字」配对，数字**上限截断为 5**：`std::min((token-'0'), 5)` | 未提及 | 单种最多 5 枚（与「5 兵/5 卒」一致，**无需担心溢出**） |
| 2 | 先出现字符设定 `pt`，紧随的数字按 `color_of(pt)` 入队 ⇒ **池内顺序完全自由** | 我以为需固定 `R A C P N B` 顺序 | ✅ **放宽**：编码不必强行排序，只需「字符+数量」成对 |
| 3 | 池段里的 `x`/`X` 被显式忽略（`pt = NO_PIECE`） | 未提及 | 池段**只写真实棋种**，不带 `x` |
| 4 | **棋盘段**的 `x` 按 `Piece(BPiece[s] \| 8 \| 16)` 落子 —— 暗子的**棋位棋种**由格位决定 | 未提及 | 🔑 **正面印证 §4.4.1「哪些身份不用猜」**：走子前暗子按棋位走，是引擎内建行为 |
| 5 | 结束段读取：`ss >> dummy >> gamePly` —— **第 4 段（半回合）被丢弃**，只有第 5 段生效 | 我以为两段都要给 | ✅ 第 4 段可填 `0`，第 5 段必须正确（影响 `gamePly`） |

> 📌 第 2、5 条直接修正了 §4.2 的原设计（排序不必强求、半回合不参与），
> 请以本节为准。单测断言相应改为「成对字符+数量」而非「固定顺序」。

> ⚠️ **第 3 段不能直接用 `hiddenIdentityPosterior` 的 `remaining`**：
> 那份多重集的语义是「初始 − 已翻开」，**仍包含被吃暗子的身份**
> （[jieqi.ts:393](<./chinese-chess-client/client/utils/chess/jieqi.ts#L393>) 跳过死子，把它们留在余量里），
> 而引擎池要求「等于在盘暗子数」。两者的差正是「已声明离开池的身份」。
> 故池的唯一来源是 §4.4.1 的 `JieqiDeterminization.pool`；
> `remaining` 只在**采样时**提供权重（后验），不直接当池写进 FEN。
> 这条口径差必须有单测（§8.1 `jieqiFen.test.ts` 断言 `Σ pool == 在盘暗子数`）。

### 4.3 历史重放：必须另写一份

现有 `buildEngineHistory`（[GameEngine.ts:947](<./chinese-chess-client/client/utils/chess/GameEngine.ts#L947>)）
产出的是**纯 4 字符 UCI**，且判据是「走完该步后己方是否仍被将」。揭棋需要：

1. `MoveRecord` 已带 `flippedPieceId` / `revealedType`（[GameEngine.ts:604](<./chinese-chess-client/client/utils/chess/GameEngine.ts#L604>)）→ **可无损重放**，
   这是上一阶段「盘面 id 永不改变」设计带来的直接红利（[JIEQI-DEVELOPMENT-PLAN.md:1187-1191](<./JIEQI-DEVELOPMENT-PLAN.md#L1187-L1191>)）；
2. 重放时要给每步**补揭晓后缀**（后缀由 `revealedType` 反查棋种字符，不需要真身）；
3. 「暗子不算攻击者」这条**必须进重放判据**，否则引擎会像当年拒绝送将步那样拒绝暗子步，
   历史断在中途（同一失效模式，[GameEngine.ts:969-985](<./chinese-chess-client/client/utils/chess/GameEngine.ts#L969-L985>)）。

> 落点：新增 `buildJieqiEngineHistory(state)`，**不改** `buildEngineHistory`（象棋路径逐字节不变）。

### 4.4 核心难点：引擎要**精确池**，而我们只有**分布**

这是整条路线**最需要想清楚的一点**，比坐标换算重要得多。

引擎的 FEN 第 3 段「未揭暗子池」是一个**精确多重集**（`R2A2C2P5N2B2…`），
而本仓库对暗子的认知是**一个分布**——见 [jieqi.ts:367-370](<./chinese-chess-client/client/utils/chess/jieqi.ts#L367-L370>) 的口径：

> 被吃暗子的真实身份对双方都不可见，故只能整体作为**未知余量**

于是有三个必须回答的问题：

| # | 场景 | 引擎要求 | 我们的认知 | 处理 |
| --- | --- | --- | --- | --- |
| 1 | 暗子**走动**翻开 | 后缀 `R` 声明它揭为什么 | 可从后验**采样**（且翻开后它就是明子，声明即事实的公开面） | 采样后写进后缀 |
| 2 | 暗子**被吃** | 后缀 `p` 声明被吃暗子是什么，池才能精确扣减 | ⚠️ **规则上禁止任何人知道**（铁律 A + 决策 A），但它确实离开了池 | **同样只能采样声明** |
| 3 | 池的总量守恒 | 池数量 == 在盘暗子数 | 我们的 `remaining` 把「被吃暗子」也算进余量（[:393](<./chinese-chess-client/client/utils/chess/jieqi.ts#L393>) 跳过死子） | ⚠️ **两者口径不同，必须显式对齐** |

> 🔴 第 3 条是本节最容易写错的地方：现有后验的 `remaining` 语义是
> 「初始多重集 − 已翻开」，**包含**已被吃暗子的身份；
> 而引擎池的语义是「仍在盘的暗子身份」，**不含**已被吃的。
> 直接拿 `remaining` 当池写进 FEN，会让池比在盘暗子**多**出被吃的那几枚 ——
> 引擎要么拒绝局面，要么在错误局面上搜索（正是 [JIEQI-DEVELOPMENT-PLAN.md:555](<./JIEQI-DEVELOPMENT-PLAN.md#L555>) 描述的失效形态）。
> **必须在 §4.2 编码前做一次「声明扣减」**，把已声明离开池的身份扣掉。

#### 4.4.1 先分清：哪些身份**根本不用猜**

这是本节最关键的简化，务必先钉死口径：

| 暗子的去向 | 身份是否公开可知 | 来源 | 是否需要采样 |
| --- | --- | --- | --- |
| **走动后翻开**（留在盘上） | ✅ **公开**（翻开即明子） | `MoveRecord.revealedType` / `state.revealedType[id]`（[types.ts:61-71](<./chinese-chess-client/client/utils/chess/types.ts#L61-L71>)：注释明写「该信息对双方都是公开的，不构成信息泄漏」） | ❌ **用真值** |
| **被吃**（离开棋盘） | ❌ 双方都不知道 | 无 | ✅ **必须声明** |
| **仍在盘上的暗子** | ❌ 未知 | 无 | ✅ 需要一份赋值（供引擎搜索） |

> ⚠️ 也就是说：**「猜」只发生在「被吃暗子」与「在盘暗子的具体分布」两处**，
> 已翻开的部分一律用真值。这条区分直接决定了 §4.3 历史重放的后缀**不需要**采样
> （重放的是已经发生的事实），也决定了确定化簿记的规模。

于是池的等式变成：

```
pool = 初始多重集 − Σ(已翻开真值) − Σ(被吃暗子的声明值)
Σ pool  ==  在盘暗子数   （恒成立，可单测）
```

#### 4.4.2 解法：一层「确定性化（determinization）」簿记

标准做法（也是不完全信息博弈引擎的通行解）：**为整局维护一份"声明出来"的确定化身份表**，
它服从后验分布、且与引擎池严格自洽。这份表**不是真相**，与真相物理隔离：

```
JieqiDeterminization {              【新，与 JieqiIdentity 并列、同样私有】
  capturedDeclared: Record<type, number> // 各棋种「已声明被吃」的枚数
  pool:             Record<type, number> // 引擎视角的当前未揭池（精确多重集）
  seed:             number               // 独立随机种子，保证可重放
}
```

> 📌 注意这里**不再需要** `declared[盘面 id]` 那张表：
> 在盘暗子的**具体分布**只在**单次搜索内**由引擎自己处理
> （引擎看到 `x` + 池，它内部怎么假设是它的事）；
> 我们只需要保证**池这个多重集**精确且跨搜索稳定。
> 若 P0 实测发现引擎要求「盘面暗子顺序与池严格对应」，再补那张表（列为 §2.3 #5 的子问）。

不变量（全部可单测钉死，见 §8.1）：

1. `Σ pool` **恒等于**在盘暗子总数（与引擎池语义一致）；
2. `capturedDeclared` 每个棋种都从池中扣过，**不超发**；
3. 本结构**永不写入** `GameState`、永不进任何出站 payload（铁律 A 的延伸）；
4. 给定同一 `seed` 与同一**公开着法序列**，`pool` 的演化**逐次可复现**
   （重开 / 悔棋 / 续局 / 重放 四条路径都要过这条）。

> ⚠️ 不变量 4 意味着**续局必须落盘 `JieqiDeterminization`**，
> 否则读档后重放会得到另一份声明，引擎池与盘面暗子数**当场对不上**。
> 现有存档已有 `jieqiIdentity` 字段（[screens/game/index.tsx:1000-1003](<./chinese-chess-client/client/screens/game/index.tsx#L1000-L1003>)），
> 本方案**再加一个并列字段**即可，不改存档结构语义。

#### 4.4.2 与现有 TS AI 的取舍（必须如实告知产品）

| 维度 | 现有 TS AI（期望值） | 揭棋引擎（确定化） |
| --- | --- | --- |
| 对暗子的处理 | 按**期望价值**评估（[AIEngine.ts:44-58](<./chinese-chess-client/client/utils/chess/AIEngine.ts#L44-L58>)），一次搜索覆盖全部分支 | 一次搜索只走**一个采样世界** |
| 方差 | 无（解析精确） | **有**：同一局面两次采样可能给出不同着法 |
| 深度/棋力 | 浅（JS 单线程，hard 只到 3，[AIEngine.ts:1838-1840](<./chinese-chess-client/client/utils/chess/AIEngine.ts#L1838-L1840>)） | 深得多，但**建立在猜世界上** |

→ 因此**必须提供 K 世界聚合**作为大师档选项：采样 K 份声明各搜一次、对候选着法计分聚合。
代价是单步耗时 ×K（用户未指定预算，见 §12 问题 1），建议：

| 难度 | K | 说明 |
| --- | --- | --- |
| 入门 / 进阶 | 1 | 单世界，快；随机性正好充当削弱手段 |
| 大师 | 2~3 | 聚合压方差；K 由实测回调 |
| 提示 | 1 + **确定性采样** | 两次提示必须同解（沿用 [AIEngine.ts:159-164](<./chinese-chess-client/client/utils/chess/AIEngine.ts#L159-L164>) 的同一开关语义） |

> 📌 注意这与 §11 排除的「包装层」**不是一回事**：包装层是把揭棋**伪装成标准象棋**喂给不懂暗子的引擎；
> 这里的 K 世界聚合是把**同一个真实局面**采样 K 份**合法确定化**喂给**懂揭棋的**引擎，是正解做法。

### 4.5 `searchmoves` 白名单：口径必须换成揭棋

现有 `collectLegalRootMoves`（[offlineAiAdapter.ts:76-97](<./chinese-chess-client/client/utils/chess/offlineAiAdapter.ts#L76-L97>)）
已经是「本地规则放行的着法」白名单，机制可直接复用，但两点要改：

1. 生成的 UCI 必须**带揭晓后缀**（否则引擎视角里那步不是翻牌）；
2. 过滤条件沿用 `isMoveKingSafe` + `isMoveBanned`，**不加**任何「看牌」判断。

> ⚠️ 沿用现有约束：**带历史时不发 `searchmoves`**（[pikafishLocalEngine.ts:417-427](<./chinese-chess-client/client/utils/chess/pikafish/pikafishLocalEngine.ts#L417-L427>)）。
> 这条是审计 P1-3 修出来的，揭棋不能例外。

### 4.6 解码：着法回来之后

```
bestmove e7e6R
  → 拆 4 字符坐标 + 后缀
  → 坐标 → 内部 col/row（沿用 uciToInternal 的 row = 9 - rank，[pikafishUci.ts:56-65](<./chinese-chess-client/client/utils/chess/pikafishUci.ts#L56-L65>)）
  → 后缀 → 声明的揭晓棋种
  → 与本地 identity 交叉校验：
      · 若引擎给的后缀 ≠ 我们采样的结果 → 以**我们的采样**为准（引擎无权决定真身）
      · 若引擎给的后缀指向一枚**盘上明子** → 判非法着法，走 OfflineEngineBadMoveError
  → 出口守卫：isMoveKingSafe（与象棋同一道，[aiDispatcher.ts:66-70](<./chinese-chess-client/client/utils/chess/aiDispatcher.ts#L66-L70>)）
```

> 🔴 **铁律 A 的新增泄漏面**：若引擎在「被吃暗子」的后缀里返回了**我们没告诉它的身份**，
> 那就是引擎在替我们发牌。适配层必须**丢弃**这类后缀、只按本地 `identity` 落子。
> 这条必须有单测（§8.1 `jieqiNoLeak` 扩展）。

### 4.7 协议层文件划分

| 文件 | 职责 | 依赖 |
| --- | --- | --- |
| `utils/chess/jieqiDeterminization.ts` 【新】 | 后验采样 → 声明身份 + 引擎池簿记（§4.4.1 四条不变量） | `jieqi.ts`（只读后验） |
| `utils/chess/jieqiFen.ts` 【新】 | `GameState` + 确定化 ↔ 5 段 FEN；池序列化 | 上两者 / `types.ts` |
| `utils/chess/jieqiUci.ts` 【新】 | 揭晓后缀着法编解码 + 校验（**纯函数**，与 `pikafishUci.ts` 同构） | 无 IO |
| `utils/chess/pikafish/jieqiLocalEngine.ts` 【新】 | 揭棋引擎装配（复用 `PikafishOfflineEngine`，换资产 + 换编解码） | 上两者 |

> 现有 `pikafishUci.ts` 的正则是 `^[a-i]\d[a-i]\d$`（[:35-37](<./chinese-chess-client/client/utils/chess/pikafishUci.ts#L35-L37>)），
> **不匹配** 5/6 字符后缀 → 揭棋必须走独立校验函数，**不能放宽现有正则**
> （现有正则同时守着头部守卫与 `isFenBoardWidthValid`，放宽等于给象棋路径开门）。

---

## 5. 档位与性能

### 5.1 档位设计（揭棋专用，不改象棋档位）

现有象棋档位：`easy d4/5s`、`medium d8/8s`、`hard d12/15s`（[pikafishTier.ts:27-32](<./chinese-chess-client/client/utils/chess/pikafishTier.ts#L27-L32>)）。

揭棋分支**搜索树更大**（每层多一个身份维度），同等深度耗时更高，故：

| 难度 | 深度 | movetime | 削弱手段 |
| --- | --- | --- | --- |
| 入门 | 3 | 3000ms | 高随机性（沿用 `randomPick`，多候选随机挑） |
| 进阶 | 6 | 6000ms | `randomPick` 关 |
| 大师 | 10 | 12000ms | 全力 |
| 提示 | 8 | 8000ms | **确定性翻牌**（§4.4） |

> 落点：新增 `jieqiTier.ts`，**不动** `pikafishTier.ts`。
> ⚠️ 数值是**起点**，必须由 §8.3 的自对弈实测回调（本仓库档位一改，UI 文案会撒谎，见 [pikafishDifficulty.ts:52-60](<./chinese-chess-client/client/utils/chess/pikafishDifficulty.ts#L52-L60>)）。

### 5.2 削弱只能靠降深度，不能靠看牌

用户已定稿「**AI 不允许看暗子真身**」。因此入门档的「弱」必须来自
**低深度 + 高随机**，而不是「少给信息」—— 引擎本来就只看到公开信息，没有可减的。

> 这一点要写进 UI 文案（§6.2），否则用户会以为入门档在「放水看牌」。

### 5.3 冷启动

- 揭棋引擎只在进入揭棋对局时创建（§3.3 方案 B）；
- 启动预算沿用现有双档：Worker 20s / WebView 45s（[pikafishLocalEngine.ts:50-59](<./chinese-chess-client/client/utils/chess/pikafish/pikafishLocalEngine.ts#L50-L59>)）；
- **未就绪期间必须能出棋**：编排器已有的 `BRIEF_INIT_WAIT_MS = 800ms` + 兜底 TS AI 机制**原样复用**，
  揭棋兜底就是现有 `AIEngine` 揭棋分支（已实现，[AIEngine.ts:44-164](<./chinese-chess-client/client/utils/chess/AIEngine.ts#L44-L164>)）。

> ✅ 这是本方案**风险最低**的一点：即使揭棋引擎永远起不来，玩家体验与今天完全一致。

### 5.4 内存与包体代价（**已实测现有基线**）

现有象棋引擎产物实测（`client/assets/engines/`）：

| 文件 | 大小 | 用途 |
| --- | --- | --- |
| `pikafish.wasm` | 488.9 KB | Web Worker fetch |
| `pikafish.nnue` | 4007.7 KB | Web Worker fetch |
| `pikafish.worker.bin` | 207.4 KB | Web Worker 脚本（loader + UCI） |
| `pikafish.html` | 6200.3 KB | **原生 WebView 内联页**（base64 内联 wasm+权重） |

→ **Web 侧每引擎约 4.6MB；原生侧每引擎约 6.1MB**。

| 项 | 现象棋 | 揭棋新增（按同量级估） | 合计 |
| --- | --- | --- | --- |
| Web 资产 | 4.6MB | ~4.6MB | **~9.2MB** |
| 原生资产 | 6.1MB | ~6.1MB | **~12.2MB** |
| 常驻内存（仅当同时用两种玩法） | 1 份 | 第 2 份 | 双份 |

> ⚠️ 原生端 WebView 承载是**内联 base64**（[pikafish/index.ts:130-151](<./chinese-chess-client/client/utils/chess/pikafish/index.ts#L130-L151>)），
> 两份产物会让部署包与内存**约翻倍**。**这是本方案唯一必须提前和产品确认的资源代价**。
>
> 缓解选项（择一，需在 §12 拍板）：
> 1. **接受**：包体 +6MB（原生）/ +4.6MB（Web），最简单，且保住「完全断网可用」承诺
>    （[aiDispatcher.ts:25-27](<./chinese-chess-client/client/utils/chess/aiDispatcher.ts#L25-L27>)）；
> 2. **揭棋权重裁剪**：换更小的 NNUE（若引擎支持），只减权重不减功能；
> 3. **揭棋引擎按需下载**：⚠️ **会破坏「断网可用」的既有承诺**，且引入 GPL 分发与完整性校验的新面，
>    **不推荐**；
> 4. 由于 §3.3 采用**懒加载**，只玩象棋的用户**不会**加载揭棋引擎（内存不翻倍，包体仍翻倍）。

---

## 6. UI / 产品改动

### 6.1 引擎标签（必须新增，不能复用 `legacy`）

现有三值标签会把揭棋引擎误报成「基础 AI」（[aiDispatcher.ts:109-111](<./chinese-chess-client/client/utils/chess/aiDispatcher.ts#L109-L111>)）。新增：

| 标签 | 含义 |
| --- | --- |
| `jieqi-engine` | 揭棋皮卡鱼已就绪 |
| `jieqi-engine-starting` | 揭棋引擎启动中，本步由内置 AI 代走（会自动升级） |
| `legacy` | 沿用：内置 AI |

对应改动点：`OfflineEngineOrchestrator.getStatus().source`、`resolveOfflineEngineLabel`、
[screens/game/index.tsx:207](<./chinese-chess-client/client/screens/game/index.tsx#L207>) 与 [:1154-1161](<./chinese-chess-client/client/screens/game/index.tsx#L1154-L1161>) 的展示分支。

> 🔴 **这里有一个必须显式处理的失效模式**：`aiChipLabel` 是**三元链**，
> 而它的**默认分支**是「皮卡鱼启动中（会自动升级）」（[:1160-1161](<./chinese-chess-client/client/screens/game/index.tsx#L1160-L1161>)）。
> 新增 `jieqi-engine` 标签若不在链上**加显式分支**，就会一路掉进默认分支，
> 表现为「引擎明明已就绪，界面却永远显示启动中」——
> 与 [aiDispatcher.ts:98-100](<./chinese-chess-client/client/utils/chess/aiDispatcher.ts#L98-L100>)
> 记录的「虚报棋力来源」是同一类问题。
> 故 §8.1 的 `jieqiEngine.test.ts` 必须断言**标签字符串本身**，而不是只断言走了引擎。

### 6.2 设置页文案

[screens/pveSetup/index.tsx:367-376](<./chinese-chess-client/client/screens/pveSetup/index.tsx#L367-L376>) 现在明写：

> 「揭棋没有专用引擎（皮卡鱼只懂象棋），走本机内置 TS AI」

接入后改为：

> 「揭棋由本机内置揭棋引擎对弈，断网可用；它和你一样看不到暗子真身，按剩余棋种的可能性来推算」

后半句**必须保留** —— 它是「AI 没看牌」的用户可见承诺（§5.2）。

### 6.3 其余 UI

- 棋盘、背面图、选图逻辑：**零改动**（[ChessBoard.tsx:787-801](<./chinese-chess-client/client/components/ChessBoard.tsx#L787-L801>) 已按 `revealedType` 渲染）；
- 存档 key `chess_jieqi_save` 与 `jieqiIdentity` 落盘：**零改动**；
- 复盘：仍不支持（[JIEQI-DEVELOPMENT-PLAN.md:1141-1142](<./JIEQI-DEVELOPMENT-PLAN.md#L1141-L1142>)），本方案不动。

---

## 7. 许可与分发（GPLv3）

| 事实 | 依据 |
| --- | --- |
| 引擎产物里**已内嵌** GPL 声明，且被校验脚本钉住（缺标记即出包失败） | [gen-pikafish-host.mjs:219](<./chinese-chess-client/client/scripts/gen-pikafish-host.mjs#L219)、[:409-410](<./chinese-chess-client/client/scripts/gen-pikafish-host.mjs#L409-L410)、[verify-pikafish-engine-assets.mjs:61-62](<./chinese-chess-client/client/scripts/verify-pikafish-engine-assets.mjs#L61-L62>) |
| 现有声明已注明「权重受皮卡鱼官方 NNUE 协议约束（非 GPL，**商用需另行授权**）」 | 同上 :410 |
| 现有立场是「本项目仅内部娱乐使用」 | 同上 :219 |

本方案的处置：

1. **沿用同一模式**：揭棋引擎产物内嵌同样的 GPL-3.0 声明 + 源二进制放 `engine-source/`（不入包）；
2. **新增义务**：`jieqi` 分支是我们**自行编译**的，需按 GPLv3 §6 提供**对应源码**
   （随包附 `README` 指明分支与 commit，或提供书面 offer）；
3. **权重**：若最终用的是社群分发的非官方权重，许可状态**未知**，必须在 P0 查清；
   查不清 → 走「关 NNUE」退路（§2.3 #4），棋力换合规；
4. ⚠️ 这几条**不是技术阻塞，但需要产品/法务确认**，与旧方案 §9.1 第 1 条的顾虑同源。

---

## 8. 测试与闸门

### 8.1 单测（沿用现有 9 个 `jieqi*.test.ts` 的写法）

| 文件 | 断言 |
| --- | --- |
| `jieqiFen.test.ts` 【新】 | 初始局面 → 5 段 FEN **逐字符**等于 §2.2 参考串；**`Σ pool` 恒等于在盘暗子数**（§4.2 口径差）；`x`/`X` 与 `hiddenMask` 严格对应；**不含任何未揭晓身份** |
| `jieqiDeterminization.test.ts` 【新】 | §4.4.1 四条不变量：池守恒、不超发、**不是 `GameState` 的键**、同 seed 同着法序列**逐次可复现**（对 重开/悔棋/续局/重放 四条路径分别验） |
| `jieqiUci.test.ts` 【新】 | 4/5/6 字符着法编解码；后缀棋种非法 → `null`；**现有象棋正则不受影响** |
| `jieqiHistory.test.ts` 【新】 | 揭晓后缀重放后局面与 `makeMove` 逐步一致；暗子步不被误判为断点 |
| `jieqiEngine.test.ts` 【新】 | 引擎不可用 → 自动落兜底 TS AI 且**标签正确**；`bestmove (none)` 不降级整局（沿用 P0-2 语义，[offlineEngine.ts:154-177](<./chinese-chess-client/client/utils/chess/offlineEngine.ts#L154-L177>)） |
| `jieqiNoLeak.test.ts` 【扩展】 | **新增**：引擎返回的被吃暗子后缀被丢弃；出站 payload 仍不含身份 |
| `jieqiVariantIsolation.test.ts` 【扩展】 | **新增**：象棋路径产物逐字节不变（新引擎的存在不影响象棋档位/标签/FEN） |

### 8.2 构建产物校验

`verify-jieqi-engine-assets.mjs` 复制现有 `verify-pikafish-engine-assets.mjs` 的四道校验
（sha256 逐字节、关键标记、loader 前 3.16% 盲区、旧内联 base64 版本检测），
并挂进 `validate` 链（现为 6 步，[package.json:20](<./chinese-chess-client/package.json#L20>)）。

### 8.3 棋力评测（必须先于档位定稿）

1. **规则对拍**：随机对弈 N 局，引擎着法逐条喂本地 `makeMove` → 断言**零非法着法**、
   零 id 冲突（沿用 `jieqiSetup.test.ts` 的 6 局×60 步口径）；
2. **自对弈冒烟**：各难度互搏 20 局，断言无死循环、终局全部可判定
   （旧方案 §9.5 的建议，[JIEQI-DEVELOPMENT-PLAN.md:872-876](<./JIEQI-DEVELOPMENT-PLAN.md#L872-L876>)）；
3. **强度对照**：新引擎 vs 现有 TS AI，各 100 局，先手后手各半 → 用来定 §5.1 的深度数值；
4. **看牌自检**：跑一局「AI 是否走出只有知道真身才走得出的棋」的统计对照 ——
   这是「AI 不看牌」承诺的**可回归证据**。

### 8.4 手工验收清单（在旧 §12.4 之上追加）

- [ ] 揭棋对局里引擎标签显示「揭棋引擎」，不是「基础 AI」
- [ ] 断网状态下揭棋 AI 正常出棋
- [ ] 引擎启动失败时自动落内置 AI，**对局不卡住**
- [ ] 提示功能两次给出同一着法（确定性翻牌）
- [ ] DevTools 里看发给引擎的 FEN：**不含任何未揭晓暗子真身**
- [ ] 象棋对局全程行为与今天逐字节一致

---

## 9. 分阶段实施

| 阶段 | 内容 | 交付判据 | 工作量 |
| --- | --- | --- | --- |
| **P0 可行性验证**（闸门） | ①**本机装 emsdk**；②取 `jieqi` 分支源码并**核对 §2.1.1 的间接证据**；③emsdk 试编 → Worker 里跑通 `uci`/`isready`/一次 `position fen <5段>`/`go depth 5`；④核实 §2.3 六项 | **一份实测记录 + 一个能出 `bestmove` 的 wasm**。拿不到 → **止损，本文作废，现状不动** | ①0.5 人日（**已实测本机现状**，见下）；②~④ 3~5 人日，**结果不可控** |
| **P1 协议层** | `jieqiFen.ts` / `jieqiUci.ts` / `buildJieqiEngineHistory` + §8.1 单测 | 单测全绿；象棋路径 `verify` 链不变 | 2~3 人日 |
| **P2 引擎接入** | `gen-jieqi-host.mjs`、`jieqiLocalEngine.ts`、双实例懒加载、三道闸门改分流、`verify-jieqi-engine-assets.mjs` | 揭棋对局由引擎出棋；不可用时自动落兜底 | 3 人日 |
| **P3 档位与 UI** | `jieqiTier.ts`、自对弈评测、标签新增、设置页文案 | §8.3 四项通过；文案如实 | 2 人日 |
| **P4 出包** | `pack.ps1` 排除项、包体/内存实测、GPL 源码 offer | `pnpm -w validate` 全绿 + 重新打包（AGENTS.md 硬性要求） | 1 人日 |

> **P0 是硬闸门**：P0 不通过就不进 P1。这条是本方案与旧方案最大的差别 ——
> 旧方案 §9.1 列的五条障碍里，「无 Emscripten 构建路径」「权重不可得」两条**直接决定 P0 能不能过**，
> 与其在 P2 才发现，不如把不确定性全部前置。

---

## 10. 风险登记

| # | 风险 | 概率 | 影响 | 缓解 |
| --- | --- | --- | --- | --- |
| 1 | `jieqi` 分支**编译不出 wasm**（SIMD/AVX2、`_mm_dp_ps`、pthread 依赖） | 中 | 路线终止 | P0 前置；备选 Fairy-Stockfish 变体路线（需另评） |
| 2 | **NNUE 权重拿不到** | **高**（旧方案实测：官方 16 个 release 权重全部加载失败、182 个相关仓库无人发布；本次核查补充：`official-pikafish/Networks` 仓库仅 **1.95 KB**，即只是 release 索引、不含历史存档，[镜像](https://repos.ecosyste.ms/hosts/GitHub/owners/official-pikafish)） | ⬇️ **已降级**：不再是路线终止条件 | 🔑 **已确认退路（2026-10 实测）**：`jieqi_old` 保留完整 classical 评估（`material.cpp`/`psqt.cpp`），`evaluate.cpp` 有 `#if USE_NNUEEVAL` 分支，关掉后走 `pos.material_diff()` ⇒ **编译期 `-DUSE_NNUEEVAL=0` 即可产出可运行引擎**。代价是棋力下降，但**可用性不受影响**。权重仍作为「棋力优化项」继续找（社群/自行训练） |
| 3 | 上游停滞（旧方案记：最后提交 2025-08，落后 master 约一年） | 已发生 | 无安全/规则更新 | 固定 commit 入库 + 记录 sha256 |
| 4 | **GPLv3 分发义务** | 确定存在 | 法务 | §7；随包源码 offer；产品/法务确认 |
| 5 | 引擎规则与本地定稿不一致（尤其「被吃暗子翻开」） | 中 | 判负/泄漏 | `searchmoves` 白名单 + §4.6 后缀丢弃 + §8.3 对拍 |
| 6 | 包体/内存翻倍（原生 WebView 内联 base64） | 高 | 分发成本 | §5.4；必要时揭棋引擎按需启用 |
| 7 | 单线程同步搜索被长考卡住 | 中 | 手感 | 沿用 `depth + movetime` 双限 + ponder 抢占（已验证机制） |
| 8 | 「AI 看牌」的观感质疑 | 中 | 口碑 | §5.2 + §6.2 文案 + §8.3 #4 统计自检 |

---

## 11. 明确不做

| 项 | 原因 |
| --- | --- |
| 包装层（伪装成标准象棋 FEN 喂现有引擎） | 用户 2026-10 明确排除 |
| 让 AI 看暗子真身 | 用户定稿「不允许」；且与铁律 A 冲突 |
| 服务端承载揭棋引擎 | 服务端已去 AI 化；且引入 GPL 分发面 + 多用户并发算力成本 |
| 象棋/揭棋共用一个引擎实例 | §3.3：两个不同二进制，物理上不可能 |
| 放宽现有象棋 UCI 正则以兼容揭晓后缀 | §4.7：等于给象棋路径开非法着法之门 |
| 改动象棋档位 / `pikafishTier.ts` | 档位一改 UI 文案就撒谎（[pikafishDifficulty.ts:52-60](<./chinese-chess-client/client/utils/chess/pikafishDifficulty.ts#L52-L60>)） |
| 原地翻子、揭棋让子、揭棋复盘 | 旧方案定稿 #1/#5，本方案不重开 |

---

## 12. 实施进展（2026-10，原「待拍板」已全部落地）

原列的 4 个待定项**均已决策并落地**：

| 原待定项 | 结论 | 依据 |
| --- | --- | --- |
| P0 止损线 | ✅ 已通过（无需止损） | §2.1.0a：编译 + 搜索 + 浏览器 E2E 全通 |
| 权重缺失的 classical 退路 | ✅ 接受 | §2.1.0c：classical 实为**完整经典评估**（非子力差），损失小于预估；且权重确认不可得 |
| 包体代价 | ✅ 接受（+0.47MB） | 揭棋产物仅 `jieqi.wasm` 384KB + `jieqi.worker.bin` 67KB；且**懒加载**，不玩揭棋不加载 |
| GPL 处置 | ✅ 沿用现有模式 | 产物内嵌 GPLv3 声明 + `engine-source/` 保留源码；`verify-jieqi-engine-assets` 会检查声明 |
| 备选路线 | 不需要 | 路线 A 已跑通 |

### 12.1 P1 已完成并**端到端验证** ✅

| 交付物 | 验证方式 | 结果 |
| --- | --- | --- |
| `jieqiFen.ts`（5 段 FEN 编解码） | 32 条 jest 单测 | ✅ **初始 FEN 逐字符等于引擎常量** |
| `jieqiUci.ts`（揭晓后缀编解码） | 同上 | ✅ 全绿 |
| `jieqiDeterminization.ts`（暗子池簿记） | 同上 | ✅ 池守恒、同 seed 可重放 |
| `jieqiHistory.ts`（历史重放） | 7 条 jest 单测 | ✅ **重放中间态与真实终态逐项一致** |
| `jieqiRuntime.ts`（运行时上下文） | 类型 + 集成 | ✅ |
| 引擎对拍 | `faceoff.mjs` | ✅ 3/3 |
| 引擎直连回归 | `verify.cjs` | ✅ PASS（1.70M nps） |
| **浏览器端到端** | `browser-verify.mjs`（puppeteer + 本机 Chrome） | ✅ **3/3** |
| `aiDispatcher` 揭棋分流 | 类型 + 单测 + E2E | ✅ 引擎优先、**TS AI 兜底**（产品定稿） |
| 引擎标签 | `screens/game` 显式分支 | ✅ `jieqi-engine` / `jieqi-engine-starting` |
| 构建链可复现 | `build.ps1` + `apply-wasm-patches.cjs` + `emenv.ps1` | ✅ 从零跑通 |
| 资源校验闸门 | `verify:jieqi-engine-assets` → `validate` | ✅ |
| 全量回归 | `pnpm -w validate` | ✅ **739/739，退出码 0** |
| 打包 | `pack.ps1 client` | ✅ 13.4 MB；产物入包、engine-source 不入包 |

### 12.2 浏览器验证揭示的三条硬约束（**踩坑记录**）

| # | 约束 | 证据 |
| --- | --- | --- |
| 1 | **wasm 必须是独立同源资源**，不能内联 | blob: worker 里 `fetch(data:)` 失败；同源 worker 里 data: 被物化为文本 ⇒ `CompileError: found "Asse"`。只有真同源 `.wasm`（`application/wasm`）走通 |
| 2 | **不能设 `noInitialRun`** | 设了之后 `run()` 跳过 `callMain`；手工调 `_main()` 因 stdin 已被 `TTY.init()` 接管而读到 EOF ⇒ **只出横幅、无 `uciok`**（静默失败） |
| 3 | **Metro 资源 URL 形态** | `/assets/engines/x.bin` 是 404；须用 `/assets/?unstable_path=...&platform=web` |

> 这三条**只有真实浏览器能暴露**（Node 无 `WorkerGlobalScope`/`instantiateStreaming`）。
> 印证了一个重要教训：**P0 直连成功 ≠ 接入成功**。

### 12.3 真机实测暴露的 4 个接入缺陷（**均已修复 + 加回归测试**）

> 这四个都**不是**引擎问题，而是接入层缺陷；且**单元测试与引擎直连 E2E 都没能发现**
> （它们绕过了应用接线与 UI）。只有真机 UI 验收才暴露。

| # | 现象 | 根因 | 修复 |
| --- | --- | --- | --- |
| 1 | 揭棋对局显示「基础AI」（引擎完全没生效） | `jieqiHost.ts` 写了 `require(modulePath)`（**变量**），而 Metro 要求**静态字符串字面量** ⇒ `TransformError` ⇒ **整个 bundle 编译失败**（1KB 错误页）⇒ 应用回退旧 bundle | 改为静态 `require('.../jieqi.worker.bin')`，归一化逻辑抽成独立函数 |
| 2 | 玩家执红先手时显示「皮卡鱼启动中」 | `aiEngine === null`（AI 尚未走子）掉进默认分支，而该分支文案是象棋的 | `null` 状态按 `variant` 区分；揭棋显示「揭棋引擎」 |
| 3 | **走一步后一直显示「揭棋引擎启动中」** | `determinization.pool` **开局建一次后从不更新**，而池语义是「当前仍未揭晓的暗子」⇒ 走一步后 `池=30` 而 `在盘暗子=29` ⇒ `assertPoolMatchesBoard` 抛错 ⇒ 引擎被静默跳过、回落 TS AI | 新增 `computePoolFromState(state, capturedDeclared)`：从初始池扣掉**已翻开真值**（`revealedType`，公开信息）与**已声明被吃**，每步实时重算 |
| 4 | **前几回合正常，回合数增加后又回到「启动中」** | 修好 #3 后仍复用**同一份** `ctx.determinization` 重放整段历史，而 `declareCapturedIdentity` 会**就地累加** `capturedDeclared` ⇒ 同一批「被吃」在**每次搜索时被重复声明** ⇒ 声明数随搜索次数线性增长 ⇒ 池被过度扣减 ⇒ 断言抛错。**只有发生过吃子才触发**，且要等下一次搜索才暴露 | 每次搜索用 `seed` **重建一份全新簿记**（幂等、不累积）；并用 `topUpCapturedDeclarations` 按**数量差**补齐，保证 `ΣcapturedDeclared == 真实被吃数` |

**第 3、4 条的教训最值得记**——它们是**同一处状态演化缺陷的两个阶段**：
- #3：首步恰好 `30=30` 所以成功，**第二步才暴露**（池该减没减）；
- #4：前几回合成功，**发生吃子后才暴露**（池减多了）。
两者都因失败被 `catch` **静默降级成 TS AI** ⇒
**表面只是标签文案不对，实际引擎从未被用上**。这类"静默降级掩盖故障"的
设计必须靠**真机长对局 + 主动制造触发条件**才能发现。

回归测试：
- `__tests__/jieqiPoolEvolution.test.ts`（8 条）钉死「池必须随局面演化」；
- `__tests__/jieqiRuntime.test.ts`（7 条）钉死「载荷幂等性 / 不累积」——
  含「发生过吃子后连续 5 次构建都成功」「`ctx.determinization` 不被污染」。

**另一条工程教训**：本项目的 Metro **HMR 不可靠**——改了源码后
bundle 可能仍是旧的（实测多次）。**每次改动后必须重启 Metro 并清 `.expo` 缓存**，
否则会误判为「代码没生效」。

### 12.4 真机验收（2026-10，puppeteer + 本机 Chrome 走真实 UI）

| 场景 | 结果 |
| --- | --- |
| 执黑（AI 先走） | ✅ 角标「揭棋引擎（进阶）」，AI 落子（`h0→g2`，暗子翻开为「車」） |
| 执红，连续 6 回合走子（无吃子） | ✅ 每回合均稳定「揭棋引擎」，无回落警告 |
| **执红 14 手，含 3 次吃暗子** | ✅ 全程「揭棋引擎」；存档 `capturedBlack=3` 证明**触发条件已覆盖** |

> 第 3 行是关键：前两行都**没吃到子**，因此没能暴露缺陷 #4。
> 固化脚本：`engine-source/jieqi/browser-verify-captures.mjs`
> —— 它走真实 UI、用「红兵连续前进必然吃卒」的路线，并**读存档断言被吃数 > 0**，
> 从而保证「测试确实覆盖了触发条件」，而不是空跑一遍。


### 12.5 真机报障修复（2026-10 揭棋实测两处）

用户实测反馈两条：① 名称标签一直显示「揭棋引擎」但**指示灯恒为灰色**，
疑似引擎没在跑；② 「将军无解后」弹出「AI 暂时无法出招，请重开本局」，是一局被锁死。

#### 12.5.1 灰点：不是引擎没跑，是角标判据漏了揭棋

**引擎本身完全正常**，两侧都验证过：

| 验证方式 | 结果 |
| --- | --- |
| Node 直载 `jieqi.wasm` | `uciok/readyok` ✔、`bestmove h0g2` ✔、1.70 Mnps ✔ |
| **真实无头 Chrome**（CDP + Node 内置 WebSocket，不依赖 puppeteer） | Worker 启动 ✔、`bestmove a9b9`、`depth 6`、397 knps ✔ |
| Metro 资源可达性 | `jieqi.wasm` → 200 `application/wasm` 393 619 B；`jieqi.worker.bin` → 200 ✔ |
| **引擎着法 vs 规则引擎对拍**（14 个中盘揭棋局面） | 14/14 命中合法着法，坐标换算（`row = 9 - rank`）无误 ✔ |

真正原因是 `screens/game/index.tsx` 里指示灯只判 `aiEngine === 'pikafish-local'`，
而揭棋返回的是 `'jieqi-engine'` ⇒ **结构上永远点不亮**。
修复：判据改为「这一步是否由**真引擎**算出」（`pikafish-local || jieqi-engine`），
样式更名 `aiNameChipDotPikafish` → `aiNameChipDotEngine`（原名只覆盖皮卡鱼，语义已不副实）。
同时把 `aiEngine === null`（首步之前）的文案从「揭棋引擎」改为「**揭棋引擎启动中**」——
揭棋引擎是**一次性会话、没有任何预热**，首步前它压根没跑过，写死「揭棋引擎」属于虚报。

#### 12.5.2 「AI 暂时无法出招」：两处合法性口径分叉（真 BUG）

用户描述是「将军无解后」，但实测局面**并非终局**（`gameStatus: 'playing'`，
红方仍有合法着法）——那条提示是**误报**，掩盖了真正的问题：

1. `AIEngine.isSideInCheck` 的揭棋分支只调 `isJiangJun`，而 `isJiangJun`
   **只含「被攻击段」、不含「飞将段（将帅照面）」**；
2. 于是搜索把「走完两将照面」当成合法最优着法；
3. `aiDispatcher.rejectMoverUnsafe` 走 `isMoveKingSafe`——那**含**飞将段，于是拒收，
   `getBestMoveOffline` 返回 **null**；
4. `screens/game` 拿 null 重试 2 次仍是 null ⇒ 弹「AI 暂时无法出招，请重开本局」。

**为什么只有揭棋中招**：象棋走 `isGeneralAttacked`，而它第一行就是
`if (areGeneralsFacing(qiPan)) return true`，两段都覆盖 ⇒ 不是两种玩法规则不同，
是**揭棋分支单方面漏了第二段**。这也解释了为什么 §12.3 那批缺陷能潜伏这么久：
它只在「走完恰好照面」的局面触发，随机短对局几乎撞不上。

**修复（两道防线）**
- 主修：`AIEngine.isSideInCheck` 揭棋分支补上 `areGeneralsFacing` 段；
  象棋分支**一行未动**（逐字节不变）。
- 兜底：`aiDispatcher` 新增 `pickAnyLegalMove` —— 守卫拒收后不再直接返回 null，
  而是枚举该方合法着法取一步。判据与守卫用**同一个** `isMoveKingSafe`，
  故返回的着法必然过闸。宁可走一步平庸的棋，也不能把整局锁死。

**回归测试**：`__tests__/jieqiAiLegalityParity.test.ts`（5 条），核心一条钉在
**seed 9434 / 红方第 41 手**：未修复时 AI 给出 `id16(4,8)→(3,8)` 被闸门拒收，
修复后给出合法着法（已实测：还原修复 ⇒ 该条变红；恢复修复 ⇒ 全绿）。
> 定位手法：沿固定走法序列**逐手**比对 AI 产物与闸门判据。
> 注意**不能用 `rand()` 选着法**——`makeSeededRand` 产出的随机器会被引擎内部
> （暗子身份抽样）消费，同种子会走出不同棋谱，测试就不可复现了。

### 12.6 真机报障修复（2026-10）：回合数增多后回退「揭棋引擎启动中」

用户实测：**前几回合角标显示「揭棋引擎」，回合多了就退回「揭棋引擎启动中」**。
这与 §12.3 #3/#4 是**同一处状态演化缺陷的第三阶段**——前两次分别修了
「池该减没减」与「声明跨搜索累积」，本次是「声明**超发**」。

**因果链**（每一环都在别处被静默吞掉，所以表面只是文案不对）：

| # | 环节 | 现象 |
| --- | --- | --- |
| 1 | `declareCapturedIdentity` 拿 `d.pool` 当采样源 | 而 `d.pool` = 初始 − 已声明，**从不扣已翻开真值** |
| 2 | 采样选中"已被翻开的棋种" | 例如某方 2 枚炮全已翻开，采样仍选中 `C` |
| 3 | `computePoolFromState` 按真值扣完该棋种已归零，再扣这枚声明被 `Math.max(0,…)` 吞掉 | 池总数比在盘暗子**多 1** |
| 4 | `assertPoolMatchesBoard` 抛错 | — |
| 5 | `aiDispatcher` 的 `catch` **静默跳过引擎**、回落 TS AI | 对局不中断，看不出异常 |
| 6 | 角标显示「揭棋引擎启动中」 | 用户唯一可见的症状 |

**为什么"回合数越多越容易复发"**：触发需要「某棋种**先**被翻开、**之后**再吃到
该棋种的暗子」——短对局撞不上。这解释了它为何能潜伏到 §12.3 #4 修复之后才暴露。

**修复**：声明的采样源改为「**尚未公开的身份余量**」
`初始多重集 − 已翻开真值 − 已声明`：

- `jieqiDeterminization.ts` 新增 `residualPoolOf(state, d, side)`，
  `declareCapturedIdentity` 增加可选 `state` 形参（不传时退化为旧行为，仅供兼容）；
- ⚠️ 传入的必须是**最终局面**，不能是重放到该步的中间态：
  约束 `声明 + 已翻开 ≤ 初始` 对**终局**才成立；只看中间态会在
  「此刻还没翻开、后来被翻开」的棋种上超发，症状完全一样。
  故 `DeclareCapturedFn` 的第二参数语义定为 `finalState`（`jieqiHistory.ts`）。

**验证（均为修复后实测）**：

| 方式 | 结果 |
| --- | --- |
| 载荷构造扫荡（120 局 / 12333 手 / 24666 次构建，每步构建 2 次验幂等） | **0 失败、0 退化**（修复前：seed 6183/9434/31337/13579 分别在 ply 21~76 抛错） |
| **真实 `jieqi.wasm` E2E**（4 seeds × 40 手，逐步喂 FEN+历史，断言出 `bestmove` 且无 CRITICAL） | **160/160 全部接受、0 退化** |
| 单测 | `jieqiHistory.test.ts` 新增 2 条（长对局池恒等式、每棋种不超发），**全量 775 条中 768 通过**（7 条失败全为 `SoundManager` 时序敏感用例，与揭棋无关，见下） |

**回归断言**：`jieqiHistory.test.ts` 的
「长对局每步：重算的池恒等于在盘暗子数」与
「每种棋种都不能被超发：声明 + 已翻开 ≤ 初始」。

> **工程教训（第三次同类复发的根因）**：这三阶段 bug 的**共同**失效模式是
> 「池算错 → `assertPoolMatchesBoard` 抛错 → 被 `catch` 静默降级成 TS AI」。
> 断言本来是为拦住错误，但**降级路径让它变成了隐形开关** —— 用户看到的
> 永远只是"角标文案不对"，而引擎从未被用上。
> 后续若再出现「引擎标签异常」，应**优先查池不变量**，而不是先怀疑引擎本身。

### 12.7 后续可选（不排期）

1. 揭棋专用 NNUE 权重（唯一渠道：QQ 群 1062385162）；
2. `jieqi`（非 `_old`）分支的 NNUE 是活的，若追求更强棋力值得单独评估
   （需重做 WASM 适配，含 NNUE SIMD 热路径；WASM 下约 60 knps，见 §10 风险 1）；
3. 自对弈棋力评测，用于回调 `jieqiTier.ts` 的深度数值（当前数值为起点值）。

