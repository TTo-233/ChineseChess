# 中国象棋项目 · 全量代码审计报告

> **审计性质**：只读审计。**本报告不对代码做任何修改**，仅作为后续优化排期的依据。
> **审计范围**：`chinese-chess-client/`（Expo + React Native 客户端）、`chinese-chess-server/`（Express + WebSocket 服务端）、两端通信协议、构建/校验闸门与打包流程。
> **审计方式**：逐文件通读 + 交叉核对两端契约 + 运行全部静态闸门与测试 + 针对性运行时取证（Node 脚本复现）。
> **基线**：工作区 `git status --porcelain` 为空；服务端 `dist/index.js` md5 `f88c23a56573b607f1ddc46d22a88a8b`（1391234 字节，29308 行）。

---

## 0. 摘要（先读这一节）

### 0.1 总体判断

这个项目的工程质量**明显高于同体量的个人项目**：两端规则引擎同源且有一致性闸门、服务端有 `dist`↔`src` 逐区域比对、历史上 6 条关键加固全部归位源码、字号/主题有集中常量、`app/` 只放路由转发、测试虽然覆盖窄但都通过。基础设施（构建、校验、打包）是本项目最扎实的部分。

问题集中在四处：

1. **服务端没有身份认证体系**。`playerId` 由客户端自报，服务端只校验"这个 id 在我房间里"，因此**冒名顶替、顶替重连、任意改写权威局面**在协议层是可行的。这不是某个函数的 bug，而是架构决定。
2. **两条通道（HTTP / WebSocket）的实现口径不一致**。历史加固补在 HTTP 通道（`respondAction`），WS 通道没有等价实现；同一个语义在两条通道上有两套行为。
3. **客户端在异步窗口内缺少"代数校验"**。`game/index.tsx` 的 AI 分支防护很严，玩家分支没有；`battleSocket` 的 ack 反查依赖客户端自己生成的 `reqId` 前缀，两处命名不一致导致动作类型丢失。
4. **"服务端时间"没有统一出口，同一根因在客户端复现了 4 次**。项目已经算出了校正量 `serverTimeOffsetRef` 并在部分位置正确使用（`useBattleClock.ts` 的 `correctedNow`、`lanBattle/index.tsx:1176` 的公示倒数），但另有 4 处直接用本机 `Date.now()` 去减服务端时间戳。最严重的一处会让**客户端擅自替用户走棋**（详见 §6.7）。

另有两类**代码级崩溃风险**（P0）：`GameEngine.createFromFen` 对畸形 FEN 无任何越界/行宽校验，且缺将局面下会以 `-1` 索引棋盘——两者都是 `TypeError`（详见 §5.14 的 R-1 / R-2）。触发源包括残局导入与服务端下发的 `startFen`。

**浮层类问题**值得单独一提，因为它们是"用户能立刻感觉到、但代码审查最容易放过"的一类：RN 的命中测试与 `opacity` 无关（只有 `pointerEvents` / `display` 能移出命中区），而 `pointerEvents="box-none"` **不会传递给子节点**。本报告因此抓到两条 P1——绝杀浮层的按钮在淡入前 2.5 秒"看不见但能点"（C-73），以及提示条的内层 View 在可见的 3 秒内吞掉棋盘中部点击（C-74，与自身注释直接矛盾）。两者都是**一行修改**。

补充审计（残局/复盘/存储/路由，§6.10）另外暴露了一条**不可恢复的数据丢失**路径：复盘存储把"读取失败"当作"空历史"并永久缓存，此后任何一次保存都会用空列表覆盖整库（C-107）。它不在常规路径上（需先发生一次读取/解析失败），但后果与 P0 同级。

### 0.2 缺陷计数（按严重度）

> **计数口径**：下表是"报告中独立成条或独立成索引行的发现数"，不是"代码缺陷位置数"——同一条发现可能横跨两个文件（如 R-2 在 `GameEngine.ts` 与 `MoveCheck.ts` 各有一行），另有 `C-29 ~ C-39` 为空缺号段。分级明细见第 11 章的索引表。

| 严重度 | 数量 | 分布 |
| --- | --- | --- |
| **P0** | 2 | 客户端规则引擎 2（均为 `TypeError`，可由畸形 FEN 触发） |
| **P1** | 26 | 服务端 5 · 协议/通道 4 · 客户端核心 4 · 客户端页面 3 · 规则引擎/AI 2 · 棋盘与浮层 2 · 残局/复盘 2（C-96、C-107） · **构建与校验链 5（I-9 ~ I-13，见 §7.9）** · 其中 I-13 = §7.3 的 I-3，去重后为 25 |
| **P2** | 72+ | 服务端 12 · 协议/通道 5 · 客户端核心 7 · 客户端页面 4 · 规则引擎/AI 2 · 棋盘与浮层 4 · 残局/复盘/存储/路由 12 · **构建与校验链 11（I-14 ~ I-24）** · 基础设施 2 · 通信 2 · 其它 |
| **P3** | 68+ | 服务端 3 · 协议/通道 1 · 客户端核心 1 · 客户端页面 2 · 规则引擎/AI 4 · 棋盘与浮层 16 · 残局/复盘/存储/路由 17 · **构建与校验链 1（I-25，内含 4 条小债）** · 基础设施 8 · 其它 |

> 严重度定义：**P0** = 数据丢失/崩溃/资金或算力可被大规模滥用；**P1** = 对局结果错误、功能在常见路径下失效、安全边界可被绕过；**P2** = 边角场景错误、状态不一致、可观测性缺失；**P3** = 代码质量/一致性/可维护性。
> 这 2 个 P0 都**不是**"服务端或构建链崩溃"，而是**客户端在收到/载入畸形 FEN 时的崩溃**：一条是越界写棋盘（`qiPan[9][0]`），一条是用 `-1` 下标读落点表。二者都不在现有测试覆盖范围内（测试用的 FEN 全是合法局面）。

### 0.3 最值得优先处理的 9 件事

| # | 问题 | 位置 | 为什么优先 |
| --- | --- | --- | --- |
| 1 | **畸形 FEN 会让客户端崩溃**（越界写棋盘 + `-1` 下标读落点表） | `client/utils/chess/GameEngine.ts:615-638`、`:223-226` | 本报告仅有的 2 个 P0；触发源是残局导入与服务端下发的 `startFen`，且现有测试完全覆盖不到 |
| 2 | 服务端零认证：`playerId` 自报，重连接口无鉴权 | `server/src/routes/lanGame.ts:1866` | 可冒名顶替对手、可任意改写权威局面；所有其他安全问题的根因 |
| 3 | 悔棋协议让客户端提供并直接采纳 `proposedState` | `server/src/routes/lanGame.ts:1669` | 服务端**完全不校验**，等于把权威局面交给客户端改写 |
| 4 | **绝杀浮层按钮在 2.5s 淡入期内不可见却可点击** | `client/components/JueShaOverlay.tsx:294` | 用户以为在看结算动画，手指碰到棋盘下方就**直接重开/退出，本局结果被跳过**。同屏还有 GameNotice 同类问题（C-74） |
| 5 | **步时倒计时用本机时钟减服务端时间戳 + 协商期间不停表** | `client/screens/lanBattle/index.tsx:1755-1762` | 设备时钟偏快时**客户端自动替用户走随机棋**；协商中会静默吞掉悔棋/求和。同一根因在客户端共 4 处 |
| 6 | WS 通道缺少"被拒动作回推权威状态" | `server/src/routes/battleWs.ts:283-287` | 非法落子会**留在盘上**，悔棋按钮停在"等待对方同意" |
| 7 | 路由载荷 base64 含 `/`，未 URL 转义 | `client/hooks/useSafeRouter.ts:59-67` | **实测 19 个真实载荷中 7 个含 `/`**；约 37% 含中文房间名的跳转会丢参数 |
| 8 | 在线 AI 客户端 2s 超时 vs 服务端 15s 超时 | `client/utils/chess/aiDispatcher.ts:97` | 大师难度下大量请求被客户端放弃，服务端 CPU 仍在烧 |
| 9 | 观战页「步时」完全失效（hook 只写 ref 不调 setter，本页没传 ref） | `client/hooks/useBattleStateSync.ts:263-265` + `client/screens/spectate/index.tsx:206` | 限时步时房间里观众永远看不到倒计时；注释却宣称已修复 |

> 补充审计（§6.10）里还有 4 条同级别但未挤进上表的问题，建议一并排期：**C-107**（复盘整库被空列表覆盖，数据丢失）、**C-96**（摆棋编辑器保存丢先后手，与上表第 1 条同为"FEN 口径"根因）、**C-115**（一条损坏棋谱让复盘播放页在渲染期崩溃）、**C-116**（复盘播放页视口不同源，与上表第 1 条的同源缺陷 C-77 同类）。
>
> **对"闸门"的提醒**（§7.9）：本报告的 §2「已通过的校验」结论建立在现有闸门之上，而构建与校验链专项复核发现其中两条**会静默放行**——`--only <不存在的区名>` 会跳过整轮比对仍退出 0（I-9），以及两侧 `// src/...` 锚点同时消失时整份产物降级为单个 INFO 区、`src/` 与 `dist/` 可任意不同仍判通过（I-10）。另有 `pack.ps1`/`pack.sh` **先删旧包后校验**（I-11，校验失败即该端零包且不可回滚）、`.env` 不在排除面（I-12）、6 个 jest 测试不在任何闸门里（I-13）。建议在排期修复业务缺陷前，先给这五条各加一道断言。

---

## 1. 项目地图与架构

### 1.1 目录结构

```
D:\Code\ChineseChess\
├── AGENTS.md                          4.3KB  仓库级约束（收尾固化/打包规则）
├── README.md                          0 字节（空）
├── SERVER-SOURCE-REBUILD-PLAN.md     47.3KB  服务端 dist→src 逆向重建计划（历史取证文档）
├── pack.ps1 / pack.sh                5.5/2.7KB  出包脚本
├── chinese-chess-client_20261002.zip 3165.9KB  当日客户端出包产物
├── chinese-chess-server_20261002.zip 4711.2KB  当日服务端出包产物
├── .dsh-work/                                取证工作目录（探针脚本、历史基准）
├── chinese-chess-client/             Expo + RN 客户端 + pnpm workspace 根
│   ├── AGENTS.md                     15.1KB  客户端级约束
│   ├── README.md                     14.8KB
│   ├── DESIGN.md                      2.6KB
│   ├── tsconfig.json                  **空对象 `{}`**（真配置在 client/tsconfig.json）
│   ├── package.json                  workspace 根（含 verify/validate 闸门）
│   ├── eslint-plugins/               自定义 lint 规则（expo / forbid-emoji / restrict-linear-gradient）
│   ├── patches/expo@54.0.33.patch    pnpm patchedDependencies
│   ├── scripts/                      dev-all.mjs 等
│   └── client/                       ★ 真正的 app 代码
│       ├── app/                      expo-router 路由（10 个 43~51 B 的纯转发文件 + `_layout.tsx` + `+not-found.tsx`）
│       ├── screens/                  页面实现（home/game/lanGame/lanBattle/spectate/endgame/endgameEdit/replay/replayPlayer/pveSetup/demo）
│       ├── components/               ChessBoard / HandicapBoard / JueShaOverlay / Screen / Modal/ 等
│       ├── hooks/                    useBattleStateSync / useBattleClock / useSafeRouter / useMoveEffect / useBoardFrame
│       ├── utils/                    chess/（引擎、AI、规则）、battleProtocol/、battleSocket、replayStorage/GameSave/EndgameProgress、SoundManager
│       └── assets/                   图片（boards/pieces/effect）与音效（9 个 mp3/wav）
└── chinese-chess-server/             Express 服务端（独立依赖，非 workspace 成员）
    ├── DEPLOY.md                     10.6KB
    ├── build.js                     19.1KB  esbuild 构建 + dist/src 逐区域比对
    ├── package.json                 express@4 / ws@8 / cors@2（+ esbuild 0.27.2）
    ├── src/                         ★ 服务端源码（index.ts + routes/ + services/）
    ├── dist/index.js                1391234 B (1.33MiB) 构建产物（md5 f88c23a56573b607f1ddc46d22a88a8b）
    ├── ai/                          openingBook.json 39.4KB + pikafishWorker.cjs 5.0KB
    │   └── pikafish/                pikafish.wasm 500621B · pikafish.cjs 206095B · data/pikafish.data 4103914B
    ├── scripts/                     start.mjs / verify-*.cjs / generateOpeningBook.cjs
    ├── ruleEngine.cjs               35.1KB  规则引擎产物（与客户端同源）
    └── start.bat / run-server.bat / install-autostart.bat / uninstall-autostart.bat
```

> **单位说明**：本文档中标注 **B** 的是精确字节数（`FileInfo.Length`）；标注 **KB/MB** 的是 PowerShell 的两位小数**四舍五入到 KiB/MiB 的显示值**（例：`1391234 B` → `1358.63 KB`；`4103914 B` → `4007.73 KB` → 上表按 MiB 记作 `3.91MiB`）。因此同一个文件在不同小节可能出现 `1358.6KB` 与 `1.33MiB` 两种写法，**它们是同一个数**。需要精确值时以 B 为准。

### 1.2 运行形态

| 端 | 技术栈 | 关键版本 |
| --- | --- | --- |
| 客户端 | Expo + expo-router + React Native（含 Web 目标） | expo 54.0.33 · react 19.1.0 · react-native 0.81.5 · typescript ^5.8.3 · eslint ^9.39.2 · jest ^29.2.1 |
| 服务端 | Express 4 + ws 8 + worker_threads | express ^4.22.1 · ws ^8.21.3 · cors ^2.8.5 · esbuild 0.27.2 · node20 target |
| 共享 | 规则引擎两端同源 | esbuild 0.27.2（pnpm overrides 钉死）· target=es2020 |

### 1.3 与用户交互的四条主链路

```
① 单机人机对局（本地 AI）
   app/game → screens/game/index.tsx → GameEngine + AIEngine（Web Worker/主线程）

② 在线对局（LAN/房间制）
   app/lanGame → screens/lanGame（房间大厅）→ HTTP /api/v1/lan/rooms*
   app/lanBattle → screens/lanBattle（对局页）
       ├─ WebSocket /api/v1/lan/ws  （实时动作 + 状态推送，主通道）
       └─ HTTP /api/v1/lan/rooms/:id/{move,undo,draw,...} （兜底通道）

③ 观战
   app/spectate → screens/spectate（只读，走同一 WS 通道，role=spectator）

④ 残局闯关
   app/endgame（选关）→ app/endgameEdit（编辑器）→ app/game?endgame=...（残局对局）
   → app/replay + app/replayPlayer（复盘）
```

### 1.4 服务端接口清单

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/v1/health` | 健康检查（**每次请求打日志**） |
| GET | `/api/v1/lan/rooms` | 房间列表（可选按状态过滤） |
| POST | `/api/v1/lan/rooms` | 创建房间 |
| GET | `/api/v1/lan/rooms/active` | 有活跃对局的房间（**必须注册在 `/rooms/:roomId` 之前**） |
| GET | `/api/v1/lan/rooms/:roomId` | 房间详情（**含明文 password**） |
| POST | `/api/v1/lan/rooms/:roomId/join` | 加入房间 |
| PATCH | `/api/v1/lan/rooms/:roomId/settings` | 修改设置（房主） |
| POST | `/api/v1/lan/rooms/:roomId/reconnect` | **重连（无鉴权）** |
| POST | `/api/v1/lan/rooms/:roomId/leave` | 离开房间 |
| POST | `/api/v1/lan/rooms/:roomId/ready\|side\|start\|move\|surrender\|rematch\|undo\|undoResponse\|draw\|drawResponse\|emoji\|heartbeat` | 对局动作（HTTP 兜底通道） |
| GET | `/api/v1/lan/rooms/:roomId/gameState` | 拉取权威局面 |
| POST | `/api/v1/ai/move` | **在线皮卡鱼着法（无鉴权、无限房间）** |
| GET | `/api/v1/ai/stats` | 引擎池 + 开局库观测 |
| WS | `/api/v1/lan/ws` | 对局实时通道（玩家 + 观战者） |
| — | `/api/*` | 未知路径统一 JSON 404 |

---

## 2. 已通过的校验（基线证据）

> **读本节前请先看 §7.9 与 §7.10**：下面的表格证明"在现有闸门下这些结果都是绿的"，而构建与校验链专项复核（§7.9）发现其中两条闸门存在**静默放行**路径（`build.js --only` 传错区名 → 整轮比对被跳过仍 exit 0；两侧 `// src/...` 锚点同时消失 → 整包降级为 INFO 区仍判 ✅）。也就是说，**"绿"不能单独作为 dist↔src 一致的充分证据**，需与 §7.10 的能力矩阵一起读。

以下命令本次审计**实际执行**并记录结果（Windows；`node`/`pnpm` 不在 PATH，使用 DSH 内置运行时 `C:\Users\hthot\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin`）。

| # | 命令 | 工作目录 | 结果 |
| --- | --- | --- | --- |
| 1 | `node node_modules/typescript/bin/tsc --noEmit` | `chinese-chess-server/` | ✅ 退出码 0，无任何诊断 |
| 2 | `node node_modules/typescript/bin/tsc --noEmit` | `chinese-chess-client/client/` | ✅ 退出码 0，无任何诊断 |
| 3 | `node node_modules/jest/bin/jest.js --watchAll=false --ci` | `chinese-chess-client/client/` | ✅ 6 suites / 91 tests 全部通过（两次运行：3.374s、3.491s）。**注意必须在该目录下运行**——`chinese-chess-client/` 根目录没有 `node_modules/jest` |
| 4 | `node build.js --check` | `chinese-chess-server/` | ✅ 11 个区域全部 **IDENTICAL**，依赖图 158 模块/70 包，版本漂移 0 |
| 5 | `node scripts/verify-rule-engine-parity.mjs` | `chinese-chess-server/` | ✅ 两端规则引擎同源一致（35541 字节，target=es2020） |
| 6 | `git status --porcelain` | 仓库根 | ✅ 输出为空（工作区干净） |

### 2.1 测试覆盖现状（**重要盲区**）

通过的 91 个用例分布在 6 个套件：

```
utils/chess/__tests__/RuleEngine.test.ts        规则引擎核心
hooks/__tests__/useBattleClock.test.ts          时钟纯函数
utils/chess/__tests__/songjiang.test.ts         送将检测
utils/chess/__tests__/ruleEngineParity.test.ts  两端同源
utils/__tests__/battleSocket.test.ts            WS 客户端
utils/chess/__tests__/songjiangGate.test.ts     送将闸门
```

**完全没有测试覆盖**的模块（按代码体积排序）：

```
screens/lanBattle/index.tsx          166.3KB   ← 最大文件，零测试
screens/game/index.tsx                76.1KB   ← 主对局页，零测试
utils/chess/AIEngine.ts               63.4KB   ← 本地 AI，零测试
screens/lanGame/index.tsx             46.8KB   ← 房间大厅，零测试
components/ChessBoard.tsx             41.3KB   ← 棋盘渲染，零测试
screens/spectate/index.tsx            38.7KB   ← 观战，零测试
utils/chess/GameEngine.ts             34.2KB   ← 对局状态机，零测试
screens/endgame/index.tsx             34.0KB   零测试
utils/chess/RuleEngine.ts             33.6KB   ← 有测试 ✅（唯一被覆盖的大文件）
screens/endgameEdit/index.tsx         32.5KB   零测试
utils/chess/aiDispatcher.ts           27.0KB   ← 在线/本地 AI 调度，零测试
hooks/useBattleStateSync.ts           23.1KB   ← 在线状态同步，零测试
screens/replay*, pveSetup, home, ...           零测试
utils/GameSave.ts / EndgameProgress.ts         零测试
```

> **结论**：测试保护集中在"纯函数 + 规则引擎"，而**所有异步窗口、所有页面级状态、所有协议客户端代码都没有回归网**。本报告发现的 P1 缺陷全部落在这个盲区里——这不是巧合。

**两个额外的覆盖缺口**（在规则引擎专项审计中发现，值得单独记一笔）：

1. **黑方走法生成在 parity 测试里从未被真正比对**：`ruleEngineParity.test.ts:199-203` 拿 `BLACK_SIDE` 去比"黑方走点集合"，但 `createInitialState()` 的 `sideTag === RED_SIDE`，而 `getSelectableMoves` 对非走棋方一律返回全 false（`GameEngine.ts:116-117`）→ 两条断言实际比较的是 `[]` 与 `[]`。**黑方（id 0-15，行 0-4 方向、卒过河）恰是最容易出错的半边**。详见 §5.14 R-8。
2. **parity 测试用的 `MOVE_SEQUENCE` 四步全是非法着法**（`ruleEngineParity.test.ts:183-189`，注释里的 id/子力/坐标与实际的兵/车/兵/马全不对应），因为 `makeMove` 不校验所以"照样通过"。它逐步比对的是一串非法局面，"覆盖炮/马/车/兵/卒走法生成"的意图落空；且任何给 `makeMove` 加校验的改动都会让它失败，失败原因会被误读为"两端分歧"。详见 §5.14 R-9。

> 换句话说：**这条被视为"两端同源铁证"的闸门，在黑方与着法生成路径上的实际保证力低于它的名字**。竖屏看它是绿的，但它没在看你以为它在看的地方。

### 2.2 静态闸门本身的质量评价

- `build.js` 的构建参数（`build.js:5-15`）是**逆向取证锁定**的，注释逐项说明了理由，值得原样记录：`bundle: true` / `platform: 'node'` / **`format: 'esm'`** / **`target: 'node20'`** / `minify: false`；`charset` 默认 ascii（字符串里的 CJK 转义为 `\uXXXX`，注释里的 CJK 保持原文）；`legalComments` 默认 eof（尾部输出 `/*! Bundled license information:` 区块）。
- **产物顶部的 6 行 banner 是必需的、不是装饰**（`dist/index.js:1-6`）：`createRequire` / `fileURLToPath` / `dirname` 三个 `node:` 导入 + 派生 `require`/`__filename`/`__dirname`。注释明确说明缺了它，ESM 产物里没有 `require`，依赖中对 node 内建模块的 `require` 会抛 `"Dynamic require of ... is not supported"`，**服务端起不来**。
- 依赖路径基准是 `absWorkingDir` 而非 `outfile` 目录：原始构建在工作区根的 `server/` 子目录里跑，`dist` 里写的是 `../node_modules/...`；本仓库独立成 `chinese-chess-server/` 后只会渲染成 `node_modules/...`，属纯注释与 `__commonJS` 对象键差异（该键只作标签），故 **`00-PRELUDE` 被定为 INFO 区：只要求依赖图（模块序列）一致、允许版本漂移**。
- **四档用法区分清楚**（`build.js:17-27`）：`--check`（内存构建、逐区域比对、不写盘）、`--check --only src/routes/lanGame.ts`（单区域）、`--dump <dir>`（落盘两侧区域便于 `git diff --no-index`）、`--check --porting [--baseline <file>]`（对历史手工产物放宽判据，仅移植期使用；一旦 dist 由 src 重建完成就该回到严格模式）。旧产物 md5 已记录：`2646eac282e2ddc8d3d76b37a36c61b3`（2026-10-02 出厂基准 `../.dsh-work/dist-baseline-20261002.js`）。
- `build.js --check` 的设计是本项目最亮眼的部分：把 bundle 按 `// src/xxx.ts` 注释切成区域，一方代码（`src/**`）**逐字符比对**，第三方依赖区只比对依赖图（包名序列），并用 `--porting` 模式处理"历史手工产物"的已知差异（注释、`void 0`、尾逗号、引号风格）。它甚至内置了 `--dump` 落盘区域便于 `git diff`。
- **但其前提已在注释里过期**：`build.js:5` 仍指向 `SERVER-SOURCE-REBUILD-PLAN.md`，`start.mjs:19-22` 已明确"启动期不再需要补丁校验"（原脚本曾在启动前 spawn `patch-dist.mjs --check`）。相应地，**多处源码注释引用了已经不存在的 `dist/index.js` 行号**（详见 §7.1）。

---

## 3. 服务端审计

> 服务端源码共 8 个文件：`src/index.ts`（64 行）、`src/routes/lanGame.ts`（1958 行）、`src/routes/battleWs.ts`（441 行）、`src/routes/ai.ts`（225 行）、`src/services/pikafish.ts`（476 行）、`src/services/openingBook.ts`（78 行）。

### 3.1 【S-1】【P1】服务端完全没有身份认证体系

**位置**：全局设计；具体入口 `server/src/routes/lanGame.ts:1866-1904`（reconnect）、`server/src/routes/lanGame.ts:1235`（move 的 `body.playerId`）

**证据**：

```ts
// lanGame.ts:1866
router.post('/rooms/:roomId/reconnect', (req, res) => {
  const { roomId } = req.params;
  const { playerId } = req.body;          // ← 完全由客户端自报
  const room = rooms.get(roomId);
  if (!room) return res.status(404).json({ success: false, message: '房间不存在' });
  const player = room.players.find(p => p.id === playerId);
  if (!player) return res.status(404).json({ success: false, message: '玩家不在房间中' });
  player.connected = true;                 // ← 直接把对方标记为在线
  player.lastHeartbeat = Date.now();
  player.hidden = false;
  player.hiddenSince = 0;
  if (room.disconnectedPlayerId === playerId) {
    room.disconnectedPlayerId = null;
    room.disconnectTime = null;            // ← 清除对方的断线判负倒计时
  }
  ...
});
```

客户端身份凭证的生成方式（`client/utils/playerIdentity.ts:22-40`）：

```ts
id = `player_${Date.now()}_${randomSuffix().toLowerCase()}`;
// randomSuffix = Math.random().toString(36).substring(2, 8).toUpperCase()  → 约 31 bit，非加密随机
```

**具体失败场景**：

1. 攻击者与受害者同处一个房间（或抓到房间列表 + 观战席位，`roomId` 与 `playerId` 在广播里明文可见），即可调用 `POST /rooms/:id/reconnect` 顶替对方身份，让**对方的断线判负倒计时被无限清零**。
2. 任何"以 `body.playerId` 自报身份"的动作（move/undo/draw/surrender/leave）都可以用别人的 id 发出，包括**替对手认输**。
3. `playerId` 约 31 bit 随机且格式可枚举（`player_<时间戳>_<6 位 36 进制>`），配合公开的房间列表，观察到一个 id 后即可长期冒用。

**影响**：所有对局公平性保证在这条路径上都是"君子协定"。这也是 §3.2、§3.5、§3.6 等缺陷能被放大的根因。

**修复建议**（供后续排期，本次不改）：
- 加入房间时由服务端签发 `sessionToken`（加密随机 ≥ 128 bit），后续所有动作以 token 而非 `playerId` 鉴权；`playerId` 退化为"显示用标识"。
- `reconnect` 只接受"与该 player 当前 token 匹配"的请求；token 失效即拒绝。
- 若暂不做完整认证，至少把 `reconnect` 收紧为"必须携带创建房间时返回的 `playerSecret`"。

---

### 3.2 【S-2】【P1】悔棋协议把权威局面交给客户端决定且不校验

**位置**：`server/src/routes/lanGame.ts:1592`（actUndo）、`server/src/routes/lanGame.ts:1669`（actUndoResponse 同意分支）

**证据**：

```ts
// actUndoResponse 同意分支（lanGame.ts:1669）
room.gameState = room.pendingUndo.proposedState;   // ← 直接采纳客户端提交的局面
```

`pendingUndo.proposedState` 来自发起方的请求体，服务端在 `actUndo` 与 `actUndoResponse` 中**都没有**对它做任何合法性校验（既不重放着法，也不比对 `moveHistory` 长度，也不校验子力守恒）。

**具体失败场景**：一方发起悔棋并附带一个伪造的 `proposedState`（例如"对手少一个车、自己多一个车"），对方看到的是"悔棋请求"这一无害文案，点同意后棋盘变成伪造局面。整局结果被单方面改写，且**双方都在界面上"同意"过**，事后无法从日志分辨。

**修复建议**：
- 服务端不采纳客户端提供的局面，而是保存**服务端自己的历史快照栈**（每次合法走子前 push 一份），悔棋时服务端回退到自己的快照。
- 若必须让客户端传，则必须校验：`proposedState` 可由 `当前局面 + 撤销 N 步` 精确推出，且 N 与 `moveHistory` 差额一致。

---

### 3.3 【S-3】【P1】WebSocket 通道缺少"被拒动作回推权威状态"

**位置**：`server/src/routes/battleWs.ts:279-287`，对照实现 `server/src/routes/lanGame.ts:174-194`

**证据**：

```ts
// battleWs.ts:283-287（WS 通道）
if (result.status < 400) {
  broadcastRoom(room);          // ← 只有 2xx 才广播
}
sendJson(ws, { type: 'ack', reqId, status: result.status, body: result.body });
```

```ts
// lanGame.ts:174-194（HTTP 通道，已有加固）
function respondAction(res: Response, roomId: string, result: ActionResult): void {
  var rejected = result.status >= 400;
  ...
  var roomForSync = rooms.get(roomId);
  if (rejected && result.status < 500 && roomForSync) {   // ← 4xx 也广播权威状态
    var nowSync = Date.now();
    var lastSyncAt = roomForSync.lastRejectionSyncAt || 0;
    if (nowSync - lastSyncAt >= 3000) { syncRejectionCount = 0; }
    if (syncRejectionCount < 8) {
      syncRejectionCount += 1;
      roomForSync.lastRejectionSyncAt = nowSync;
      roomBroadcaster(roomForSync);
    }
  }
  res.status(result.status).json(result.body);
}
```

这条加固的**设计意图**在 `lanGame.ts:155-164` 的注释里写得很清楚（"被拒绝的动作必须把权威状态也回推给双方"），但 WS 是**对局的主通道**（客户端优先走 WS，HTTP 只作兜底），因此第 5 条加固在主通道上是失效的。

**具体失败场景**：客户端乐观更新棋盘 → 落子被服务端 4xx 拒绝（不是你的回合 / 送将 / 非法走法）→ WS 只回一个 `ack`，不推 `state` → **非法落子留在盘上**，悔棋按钮停在"等待对方同意"，直到下一次成功动作才被顺带纠正（可能几十秒后，也可能再也不会）。

**修复建议**：把 `respondAction` 的"4xx 回推"逻辑提到与通道无关的公共层，让 WS 的 `status >= 400` 分支也调用它；限流计数器顺手按房间隔离（见 §3.4）。

---

### 3.4 【S-4】【P1】拒绝回推的限流计数器是模块级全局变量，与注释的"按房间"矛盾

**位置**：`server/src/routes/lanGame.ts:165`（声明）、`:184-190`（使用）

**证据**：

```ts
// lanGame.ts:163-165
// 限流：同一房间 3 秒内最多 8 次，避免被连续非法请求刷屏；
// 且只对 4xx 生效——5xx 属于服务端自身异常，不该顺手改写客户端对局画面。
let syncRejectionCount = 0;            // ← 模块级全局，不是 per-room
```

```ts
// lanGame.ts:182-190
var lastSyncAt = roomForSync.lastRejectionSyncAt || 0;   // 只有时间戳是 per-room 的
if (nowSync - lastSyncAt >= 3000) { syncRejectionCount = 0; }
if (syncRejectionCount < 8) { syncRejectionCount += 1; ... }
```

`lastRejectionSyncAt` 存在 room 上（per-room），但**计数器不是**：多个房间并发时，房间 A 的连续非法请求会吃掉全局配额，导致房间 B、C 的被拒动作不再回推权威状态——正是 §3.3 想防的那个"画面停在乐观更新"的故障，只是换了个触发方式。这是个**多房间下才会暴露**的缺陷，单房间自测不可能发现。

**修复建议**：把计数器挂到 room 上（`room.rejectionSyncCount`），或在 GC 时一并清理的 per-room Map 中维护。

---

### 3.5 【S-5】【P1】`/api/v1/ai/move` 无鉴权且不限房间，可被用作免费算力

**位置**：`server/src/routes/ai.ts:86-215`，限流实现 `:155-180`

**证据**：

```ts
// ai.ts:91
const clientId = typeof body.clientId === 'string' && body.clientId.trim() ? body.clientId.trim() : null;
...
// ai.ts:156-163
if (clientId && inflightClients.has(clientId)) {
  res.status(429).json({ success: false, error: 'busy', message: '您已有一个 AI 请求正在计算中，请稍候' });
  return;
}
```

限流键完全来自请求体。攻击者**每次换一个 `clientId` 就能绕过**，也可以直接不传 `clientId`（此时完全不限流）。而这个接口背后是 worker_threads 里的皮卡鱼 WASM 深搜（`hard` 深度 12，`heavy` 道默认仅 **2** 个实例）。

**具体失败场景**：任何能访问服务端的人（`cors()` 全开，见 §3.11）用一个循环脚本并发打 `/api/v1/ai/move`，即可让 `heavy` 道的 2 个实例长时间饱和 → 正常用户的大师难度 AI **永久排队**，同时服务端 CPU 被占满。配合 `express.json({ limit: '50mb' })`（§3.11），单请求内存开销也被放大。

**修复建议**：按 IP + 全局并发上限双重限流；`clientId` 只作为"同用户去重"的辅助而非安全边界；对 `heavy` 道加全局排队上限与拒绝策略。

---

### 3.6 【S-6】【P2】房间密码明文下发

**位置**：`server/src/routes/lanGame.ts:915-916`

**证据**：`GET /rooms/:roomId` 的响应体包含 `password: room.password`，代码注释自述"休闲房间场景"。

**具体失败场景**：任何人 `GET /api/v1/lan/rooms` 拿到房间列表 → 逐个 `GET /api/v1/lan/rooms/:id` → 拿到明文密码 → 加入本应加密的房间。

**修复建议**：详情接口不回传 `password`，只在 `join` 时校验；或返回 `hasPassword: boolean`。

---

### 3.7 【S-7】【P2】房主判定用 `players[0]`，与显式 `hostId` 字段形成双源真相

**位置**：`server/src/routes/lanGame.ts:419`（`transferHost`）、`:954`（权限判定）

**证据**：

```ts
// lanGame.ts:419
room.hostId = room.players[0].id;

// lanGame.ts:954
if (room.players[0]?.id !== playerId) { /* 不是房主 */ }
```

`/leave` 用 `filter` 重建 `players` 数组，数组顺序会变；`Room` 接口里**已经有** `hostId` 字段。两处"谁是房主"的判据可能不一致：改设置走 `players[0]`，而 `hostId` 在别处被读取。

**修复建议**：统一以 `room.hostId` 为准，`transferHost` 只改 `hostId`，所有权限判定读 `hostId`。

---

### 3.8 【S-8】【P2】旧协议走子分支不校验 `gameOver`/`winner`，客户端可上传任意局面与胜负

**位置**：`server/src/routes/lanGame.ts:1287-1336`（旧协议分支），对照 `:1235-1285`（新协议分支）

**证据**：旧协议完整接受 `body.gameState` / `body.gameOver` / `body.winner`（`battleWs.ts:271-277` 也把这三个字段透传）。服务端仅有两道收紧（"本局尚无着法"+"房内玩家"），而这两道都依赖 `body.playerId` 自报（§3.1）。

**具体失败场景**：客户端直接提交一个"我方绝杀对方"的 `gameState` + `gameOver: true` + `winner: 'red'`，对局立即判自己获胜。

**修复建议**：新协议上线后删除旧协议分支；若需兼容，至少要求旧协议局面能由"当前权威局面 + 一步合法着法"推出。

---

### 3.9 【S-9】【P2】`actHeartbeat` 完全信任客户端上报的 `hidden`

**位置**：`server/src/routes/lanGame.ts:1839-1845`；常量 `HIDDEN_HEARTBEAT_GRACE = 90000`、`HIDDEN_MAX_DURATION = 180000`

**证据**：客户端只要持续上报 `hidden: true` 且 `hiddenSince` 落在 `HIDDEN_MAX_DURATION`（180s）窗口内，`isHiddenTolerated` 就持续宽容判定。而 `hiddenSince` 同样由客户端提供。

**具体失败场景**：对局中不想输的一方反复上报 `hidden: true`（并滚动 `hiddenSince`），即可**无限期规避断线判负**——只要不停手，60s 断线判负永远不触发。

**修复建议**：`hiddenSince` 由服务端在**首次**收到 `hidden: true` 时自行记录，后续忽略客户端值；`HIDDEN_MAX_DURATION` 到点后强制按普通断线处理。

---

### 3.10 【S-10】【P2】终局状态字段清理口径不一致

**位置**：`server/src/routes/lanGame.ts:1455-1462`（actSurrender）、`:1761-1767`（actDrawResponse 同意分支）、`detectDisconnect`、`detectClockTimeout`

**证据**：`actSurrender` 会清 `clockPausedAt`；`actDrawResponse` 同意分支只设 `winner=null / endReason='draw' / phase='ended'`，**不清** `pendingUndo` / `pendingDraw` / `clockPausedAt`；断线判负与超时判负路径也不清协商字段。

**具体失败场景**：和棋成立后客户端仍能读到残留的 `pendingUndo`/`pendingDraw`，渲染出"等待协商"UI，而服务端已进入 `ended`，任何响应都会 4xx。

**修复建议**：抽一个 `finalizeRoom(room, winner, endReason)` 统一清理终局字段。

---

### 3.11 【S-11】【P2】CORS 全开 + 50MB JSON 上限

**位置**：`server/src/index.ts:14-16`

**证据**：

```ts
app.use(cors());                                        // ← 任意来源
app.use(express.json({ limit: '50mb' }));               // ← 对局负载远小于此
app.use(express.urlencoded({ limit: '50mb', extended: true }));
```

**具体失败场景**：任意网站都能通过浏览器跨域调用全部 API（含 `/ai/move`，见 §3.5）；50MB 上限让每个请求都能占用大量内存（`express.json` 会把整个 body 缓冲成字符串再 `JSON.parse`）。

**修复建议**：`cors({ origin: <白名单> })`；JSON 上限降到实际需要（局面 + 历史着法 < 64KB 足够）。

---

### 3.12 【S-12】【P2】`/api/v1/health` 每次请求打日志

**位置**：`server/src/index.ts:18-21`

**证据**：`console.log('Health check success')` 在路由处理函数内，无任何频率限制。

**具体失败场景**：外部探针（k8s liveness、UptimeRobot 等）通常 5-10s 一次；多探针叠加后日志被健康检查刷满，真正的事故日志被淹没。

**修复建议**：删除该日志，或改成"状态变化时才打"（如首次成功 / 由失败转成功）。

---

### 3.13 【S-13】【P2】开局库与 Worker 脚本用 `process.cwd()` 多候选探测

**位置**：`server/src/services/openingBook.ts:26-38`（`resolveBookFile`）、`server/src/services/pikafish.ts:136-148`（`resolveWorkerScript`）

**证据**：

```ts
// openingBook.ts:28-33
const candidates = [
  path.resolve(process.cwd(), 'ai/openingBook.json'),
  path.resolve(process.cwd(), 'server/ai/openingBook.json'),
  path.resolve(here, '../../ai/openingBook.json'),
  path.resolve(here, '../ai/openingBook.json'),
];
```

**具体失败场景**：`start.bat` 双击启动（cwd = 服务端目录）与 pm2/systemd 启动（cwd = 任意）解析到不同结果。开局库加载失败**只 `console.warn`**，于是"开局全部走引擎"这种静默退化不会被发现；`pikafishWorker.cjs` 找不到则直接 `throw`，引擎池起不来。

**修复建议**：以 `import.meta.url` 为唯一基准（`here` 候选已经存在），删掉 `process.cwd()` 两条；加载失败改为 fail-fast 或暴露到 `/ai/stats`。

---

### 3.14 【S-14】【P2】FEN 校验只查板面行宽，不查棋子合法性

**位置**：`server/src/routes/ai.ts:59-81`（`isFenBoardShapeValid`）

**证据**：校验 10 行 × 9 列、`0` 视为非法、每行宽度必须精确 `== 9`、字符只允许数字与字母——但**不校验**棋子集合合法性（双方将帅数量、士象位置、兵卒位置）。

**具体失败场景**：畸形但"行宽正确"的 FEN（例如两个红帅、象在田字外）仍会进入 Pikafish WASM。该加固只覆盖了"行宽越界"这一类崩溃（注释里提到的历史事故），其余畸形输入仍是未知行为。

**修复建议**：复用客户端已经写得很完整的 `validateEndgameFen`（`client/utils/chess/endgames.ts:62-159`），把它作为两端共享校验的一部分抽到 `ruleEngine` 同源层。

---

### 3.15 【S-15】【P2】全局异常处理器掩盖崩溃，进程状态可能已损坏

**位置**：`server/src/index.ts:49-56`

**证据**：

```ts
// 进程级异常守卫：未处理的 Promise 拒绝/未捕获异常仅记录，不让进程退出，
// 保障在线对局服务持续可用（避免因单点异常导致全服中断）。
process.on('unhandledRejection', (reason) => {
  console.error('[Server] unhandledRejection:', reason instanceof Error ? reason.message : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[Server] uncaughtException:', err?.message || err);
});
```

**具体失败场景**：`uncaughtException` 之后进程可能处于半初始化状态（泄漏的定时器/锁/半写状态），继续对外服务比崩溃更危险——用户会拿到"服务在线但行为错乱"的结果，且没有任何告警。

**修复建议**：记录后执行优雅退出（`await pool.shutdown(); server.close(); process.exit(1)`），由进程管理器拉起。

---

### 3.16 【S-16】【P2】`actSide` 的"公示前可自由更改"承诺会被一次相同选择打破

**位置**：`server/src/routes/lanGame.ts:1026-1084`（actSide）、`:1091-1104`（assignSides）

**证据**：`room.players.every(p => p.sidePreference)` 为真时立即 `assignSides` + 生成 `sideReveal`，之后任何改选边都被 `if (room.sideReveal)` 分支拒绝（"执棋结果已公示，不能更改"）。而 `assignSides` 在双方意向相同时**随机分配**。

**具体失败场景**：双方都选红 → 第一个到达的请求直接锁定随机结果，双方再无机会沟通。

**修复建议**：意向相同时不自动公示，退回等待（或提供"重新选边"出口）。

---

### 3.17 【S-17】【P2】让子直分公示后无取消出口

**位置**：`server/src/routes/lanGame.ts:428-441`（`applyHandicapAutoReveal`）、`:1127-1139`（actReady 取消准备）

**证据**：让子直分在双方 ready 且 `handicap` 非空时直接设 `sideReveal` + `gameStartAt`，不走选边；此时 actReady 的"取消准备"被 `if (room.sideReveal) return 400 '选边已公示，无法取消准备'` 拦住。

**具体失败场景**：用户误触"让子"后无法通过取消准备自救，只能改设置（PATCH /settings）或退出房间。

**修复建议**：为让子公示提供显式取消路径（撤销 `sideReveal` + `gameStartAt` 并回到 ready 阶段）。

---

### 3.18 【S-18】【P2】`actRematch` 无条件把双方标记为在线

**位置**：`server/src/routes/lanGame.ts:1516`

**证据**：重赛重置时无条件 `p.connected = true`，即使对方已断线/已离开页面。

**具体失败场景**：每局开始时给断线方免费重置一次 60s 断线判负倒计时。

**修复建议**：保留 `connected` 的真实值，只在收到真实心跳/重连时置真。

---

### 3.19 【S-19】【P2】`tryAutoStart` 与 `actStart` 校验口径不一致

**位置**：`server/src/routes/lanGame.ts:592-614`（`tryAutoStart`）vs `:1106-1160`（actStart）

**证据**：`tryAutoStart` 只检查 `players.length < 2`、every ready、sides 含红黑；`actStart` 额外校验 `!room.sideReveal || !room.gameStartAt` 与 `START_TOLERANCE_MS = 500` 容差，但不检查 `players.length > 2`。

**具体失败场景**：两条开局路径对同一房间状态给出不同判定（例如容差窗口内 `tryAutoStart` 放行而 `actStart` 拒绝），出现"开局时间/倒计时不一致"。

**修复建议**：抽出 `canStart(room)` 单一判据供两处复用。

---

### 3.20 【S-20】【P2】`actMove` 新协议分支不校验 `makeMove` 结果，且超时走子仍得加秒

**位置**：`server/src/routes/lanGame.ts:1235-1285`（新协议分支）、`:1287-1336`（旧协议分支）

**证据**：
- 新协议分支在 `ruleEngine.makeMove(state, pieceId, toCol, toRow)` 之后直接扣时并覆盖 `room.gameState`，**不校验 `result` 是否表示合法走子**（依赖前面的 `getValidMoves` 预校验，重复校验口径靠约定）。
- 扣时用 `room.clockPausedAt ?? Date.now()` 作锚点（`:1265`）：当时钟已耗尽为负数时，`Math.max(0, ...)` 之后仍会 `+ incrementSeconds * 1000` → **超时走子仍获得加秒**（`detectClockTimeout` 的 1s tick 与请求到达之间有竞态窗口）。

**修复建议**：`makeMove` 返回值显式判错；超时判定移到扣时之前，或用"仅在剩余时间 > 0 时加秒"。

---

### 3.21 【S-21】【P2】`actDraw`/`actUndo` 不校验请求者与当前行棋方的关系

**位置**：`server/src/routes/lanGame.ts:1592`（actUndo）、`:1740`（actDraw）

**证据**：只校验 `phase === 'playing'`、player 在房、无 pending、未超拒绝次数。任何一方在任意时刻（包括对方思考中）都能发起悔棋/求和。

**具体失败场景**：对方正走一步制胜棋的过程中反复发起求和/悔棋，触发协商弹窗打断操作。

**修复建议**：悔棋只允许"走子方"在"自己刚走完、对方尚未走"的窗口内发起；求和可保持宽松但加冷却。

---

### 3.22 【S-22】【P2】`/leave` 在结算态把房间重置为等待中

**位置**：`server/src/routes/lanGame.ts:1944-1950`

**证据**：`ended` 且未刚结算时无条件 `actRematch`。

**具体失败场景**：胜方还在看结算浮层，败方退出 → 留存的胜方发现结算浮层消失、房间回到等待中，失去结算信息。

**修复建议**：`/leave` 在 `ended` 只做"移除该玩家"，不改 `phase`。

---

### 3.23 【S-23】【P3】`endedSinceMap` 无 TTL/GC 兜底（小内存泄漏）

**位置**：`server/src/routes/lanGame.ts:497` 附近（`healStaleEndedRoom` 的 Map）

**证据**：房间被删除后，`endedSinceMap` 中的条目只在"该房间下次进入 ended"时才清理，没有 TTL 也没有 GC 遍历。

**修复建议**：在房间 GC 时一并 `endedSinceMap.delete(roomId)`。

---

### 3.24 【S-24】【P3】`ai.ts` 的引擎租约常量与引擎超时常量靠注释维持一致性

**位置**：`server/src/routes/ai.ts:28-33`

**证据**：

```ts
/**
 * 持占租约时长：应大于引擎 job 安全超时（JOB_SAFETY_TIMEOUT_MS，默认 15s），
 * 这样正常路径下总是由 finally 先释放，定时器只兜底异常/重启导致的泄漏。
 * 取默认值而非引用 JOB_SAFETY_TIMEOUT_MS：本行早于该常量的定义位置（esbuild 打包后同模块顺序已变）。
 */
const INFLIGHT_LEASE_MS = 20_000;
```

**具体失败场景**：有人把 `JOB_SAFETY_TIMEOUT_MS`（`pikafish.ts:151`）调到 25s，租约 20s 就会**先于 job 超时**释放槽位，同一 clientId 可以并发两个 job；没有任何机制提示同步。

**修复建议**：在 `pikafish.ts` 导出 `JOB_SAFETY_TIMEOUT_MS`，`ai.ts` 改用它 + 余量（`const INFLIGHT_LEASE_MS = JOB_SAFETY_TIMEOUT_MS + 5_000`），或至少加一条运行时断言。

---

### 3.25 【S-25】【P3】引擎池与调度器的可观测性/健壮性小项

| 位置 | 问题 | 建议 |
| --- | --- | --- |
| `server/src/services/pikafish.ts:303-315` | `pickNextJob` 是 O(n) 线性扫描选优先级最高者，队长为每个空闲实例重复扫描 | 当前规模可接受；改用按优先级插入的队列即可 |
| `server/src/services/pikafish.ts:259` | `handleWorkerFailure` 重建实例是 fire-and-forget（`.catch(() => undefined)`）：持续失败时池会静默缩容到 0 | 记录失败次数并在 `/ai/stats` 暴露告警字段 |
| `server/src/services/pikafish.ts:346-351` | `onJobTimeout` 的 `STOP_GRACE_MS` 定时器未 `unref()` 且无取消 | 加 `unref()`；在 `handleResult`/`shutdown` 中清理 |
| `server/src/services/pikafish.ts:121-123` | `QueuedJob.startedAt` 从**分发到实例**才开始计时（排队时间不计入 15s 超时） | 这是"客户端 2s / 服务端 15s"错配能长期存在的原因之一；建议同时记录 `enqueuedAt` 并对排队时长单独设上限 |
| `server/src/routes/ai.ts:87-90` | body 允许任意形状，`difficulty` 用 `as Difficulty` 强转，非法值靠查表兜底 | 用显式白名单集合判定，去掉类型断言 |
| `server/src/routes/lanGame.ts:13-22` | `router.use` 活跃打点是全局中间件，每个带 `playerId` 的请求都做一次 Map 查找 | 与 WS 探活构成双源真相；建议明确其中一个是权威 |
| `server/src/routes/lanGame.ts:618-643` | `gameTickTimer` 每秒遍历所有房间并调用 9+ 个清理/检测函数，其中多个各自 `Date.now()`（同一 tick 内时间不一致） | 把一个 tick 的 `now` 作为参数透传 |
| `server/src/routes/lanGame.ts:648-661` | `parseClockSettings` 对 `base` 超限静默 clamp 到 3600，对 `inc > 60`/`byo > 120` 直接报错（同类参数两种策略） | 统一为"报错"或"clamp + 返回实际值" |
| `server/src/routes/lanGame.ts:1830` | heartbeat 对不存在房间返回 `{ error }`，其他动作失败用 `{ success:false, message }`（形状不统一） | 统一失败体形状 |
| `server/src/routes/lanGame.ts:1573` | `var RETURNED_GRACE_MS = 30 * 1e3`（全文件其余常量用 `const`） | 清理历史补丁痕迹 |
| `server/src/routes/lanGame.ts:1530-1531` | `export /** ... */ function actReturnToRoom`：`export` 与函数之间插入了整段 JSDoc（注释错位），`actUndo` 的真实定义在 `:1592` | 修正注释归属 |
| `server/src/routes/battleWs.ts:283` | WS 拒绝路径返回 `{ type: 'error', reqId }`，动作失败走 `{ type: 'ack', status: 4xx }`：客户端需同时处理两种失败帧 | 统一失败帧形状 |
| `server/src/routes/battleWs.ts:380` | WS 建立即置 `player.connected = true`（注释说明应以 `POST /reconnect` 为准） | 与 §3.1 的 token 方案一起收敛 |
| `server/src/routes/battleWs.ts:211` | `meta.lastActivity` 与 `touchPlayerWs` 在 JSON 解析**失败之前**刷新 → 任何畸形消息都能刷新活跃度（虚假保活） | 解析成功后再打点 |
| `server/src/routes/lanGame.ts:497` | `endedSinceMap` 无 TTL（见 §3.23） | 房间 GC 时一并清理 |

---

## 4. 客户端-服务端通信审计

### 4.1 协议总览

```
身份与地址
  client/utils/playerIdentity.ts   生成/持久化 playerId（无认证）
  client/utils/serverConfig.ts     服务器地址持久化 + 健康探测 + WS 地址推导
  client/utils/battleProtocol/     协议契约（types.ts / index.ts）
  client/utils/battleSocket.ts     WS 客户端（心跳、重连、ack、pending）

状态同步
  client/hooks/useBattleStateSync.ts   把服务端 state 帧收进页面 state
  client/hooks/useBattleClock.ts       棋钟纯函数 + 1s 定时器
```

### 4.2 通道优先级与三态错误

客户端对局动作走 WS 主通道（`battleProtocol/index.ts`），失败语义分三类：

| 错误类型 | 判据 | 后续行为 |
| --- | --- | --- |
| `BattleActionNotSentError` | 帧**根本没发出** | **回退 HTTP** 兜底通道 |
| `BattleActionRejectedError(action, status, message)` | 服务端 4xx | **绝不回退 HTTP**，回退本地乐观更新 |
| `BattleActionTimeoutError` | 5s 内无 ack（`ACTION_ACK_TIMEOUT_MS = 5000`） | 结果未知，按失败处理，**不回退 HTTP** |

这个三分法设计得很好（注释也解释得很清楚），但实现里有一处命名不一致让第一类信息丢失，见 §4.3。

### 4.3 【C-1】【P1】`send()` 的 `reqId` 前缀与 `actionOf()` 的解析约定不匹配，导致被拒动作丢失"动作类型"

**位置**：`client/utils/battleSocket.ts:429`（发送）、`:411-416`（解析）、`:394-400`（分派）、`client/hooks/useBattleStateSync.ts:472-480`（消费）

**证据**：

```ts
// battleSocket.ts:427-430  send()（fire-and-forget 路径）
return this.sendRaw({ type, reqId: `req-${this.reqCounter}`, ...payload });
//                                      ^^^^^^^^^^^^^^^^^^^^^ "req" 不在白名单

// battleSocket.ts:446-449  request()（需要 ack 的路径）—— 这里是对的
// reqId 前缀即动作类型（`move-3`）：handleAck 据此在无入参映射的情况下反查动作，
const reqId = `${type}-${this.reqCounter}`;
const frameSent = this.sendRaw({ type, reqId, ...payload });

// battleSocket.ts:406-416  actionOf()
/** 由 reqId 反查动作类型（reqId 形如 `move-3`）。 */
private actionOf(reqId: string): BattleActionType | null {
  const sep = reqId.lastIndexOf('-');
  if (sep <= 0) return null;
  const type = reqId.slice(0, sep) as BattleActionType;
  return BATTLE_ACTION_TYPES.has(type) ? type : null;   // 'req' → null
}
```

服务端只是原样回显 `reqId`（`battleWs.ts:287`：`sendJson(ws, { type: 'ack', reqId, status: result.status, body: result.body })`），所以客户端自己生成的格式就是唯一真源。

`BATTLE_ACTION_TYPES` 白名单 = `move / surrender / undo / undoResponse / draw / drawResponse / emoji`；`'req'` 不在其中 → `actionOf` 返回 `null`。

**后果链**：

```ts
// useBattleStateSync.ts:472-480
const action = error instanceof BattleActionRejectedError ? error.action : null;
if (!action || action === 'undo') { /* 清 pendingUndo */ }
if (!action || action === 'draw') { /* 清 pendingDraw */ }
```

`action === null` 时**两条协商线都被清空**：本端正在等待的求和会因为一个无关动作（例如 `surrender` 或 `emoji` 被拒）而被清掉，按钮状态与实际协商状态不符。

**具体失败场景**：玩家发出 emoji（走 `send()`）→ 服务端 4xx（例如对局已结束）→ 客户端 `onActionRejected` 收到 `action: null` → 界面同时丢弃"等待对方同意悔棋"和"等待对方同意和棋"两个状态 → 对手随后同意，客户端却已不在等待态，协商结果被忽略。

**注意**：`request()` 路径（move/undo/draw/surrender/drawResponse/undoResponse 的**带 ack 版本**）是正确的——`reqId` 形如 `undo-3`，`actionOf` 能正确解析。缺陷集中在 `send()` 这条 fire-and-forget 路径。

**后续复核（重要，这改变了本条的定级）**：全仓复查确认 **`send()` 已经没有任何调用者**——页面只调用 `request()`（`client/screens/lanBattle/index.tsx:1594`），`battleProtocol/index.ts:85` 的 `emitBattleAction()` 同样无人调用（详见 §6.7 C-52）。因此 C-1 目前是**一条被死代码掩盖的潜在缺陷**，而不是正在发生的线上故障：一旦有人复用 `send()`（它看起来仍是一个正常的公开 API），上面整条后果链会立刻生效。本报告保留 P1 定级，理由是"一个会静默清空协商状态的公开 API 就摆在工具类里"，但同时明确它的**当前可达性为零**。

**修复建议**：删除 `send()` 与 `emitBattleAction()`（推荐）；若确实要保留 `send()`，改为 `` reqId: `${type}-${this.reqCounter}` ``（与 `request()` 统一）；同时把 `!action` 分支收紧为"不清理任何协商状态，只记日志"。

---

### 4.4 【C-2】【P1】断线倒计时用本机时钟减服务端时间戳（时钟域混用）

**位置**：`client/hooks/useBattleStateSync.ts:408-411`（错误用法）vs `:255-257`（已保存校正量）

**证据**：

```ts
// useBattleStateSync.ts:255-257  已经算好并保存了校正量
opt.serverTimeOffsetRef.current = data.serverNow - Date.now();
```

```ts
// useBattleStateSync.ts:408-411  这里却没用它
const elapsed = Math.floor((Date.now() - data.disconnectTime) / 1000);
countdown = Math.max(0, DISCONNECT_WAIT_SECONDS - elapsed);
```

`data.disconnectTime` 由服务端 `detectDisconnect` 写入，是**服务端时钟域**；`Date.now()` 是**本机时钟域**。同一文件里同类问题的另一处（已复核确认存在）：`:324` 的 `duration: data.gameStartTime ? Date.now() - data.gameStartTime : 0`——`data.gameStartTime` 同样是服务端时间戳。

> 同族问题的第三个实例在 `client/screens/lanBattle/index.tsx`（该文件自己维护 `serverTimeOffsetRef`，见 §6 说明）。**这已经是同一根因的第三处**，说明"服务端时间"缺少统一出口（见 §9 第 3 批建议）。

**具体失败场景**：
- 用户手机时钟快 90s → 断线倒计时**立刻显示 0**，双方都以为马上要判负。
- 手机时钟慢 5 分钟 → 倒计时**永远不减少**，界面显示 60s 但服务端 60s 后已判负。

跨设备对局（一部快表、一部慢表）时这个问题会稳定复现。

**修复建议**：统一用 `Date.now() + serverTimeOffsetRef.current` 作为"服务端当前时间"，即 `const elapsed = Math.floor((Date.now() + offset - data.disconnectTime) / 1000)`。

---

### 4.5 【C-3】【P1】`onReconnected` 在首次连接也会触发，`hasConnectedOnce` 是死变量

**位置**：`client/utils/battleSocket.ts:196-202`

**证据**：`onopen` 中无条件调用 `onReconnected?.({ attempt: this.reconnectAttempts })`，而 `this.reconnectAttempts = 0` 在同一处的前面被重置；`hasConnectedOnce` 被赋值后**从未被读取**。

文件顶部的注释（`battleSocket.ts:67-71`）明确承诺："本回调给出本次连接之前是否断过，供调用方区分首次连上/断线恢复"——实现与承诺不符。

**具体失败场景**：首次进入对局页也会触发一次"断线恢复"语义的权威状态重拉（`lanBattle` 依赖该回调），多一次无谓的全量状态同步；更糟的是上层可能因此展示"已重连"提示。

**修复建议**：`onopen` 中按 `hasConnectedOnce` 区分，首次连接走 `onConnected`、后续走 `onReconnected`。

---

### 4.6 【C-4】【P2】本端走子乐观保护只比较"着法数"，对手走子会顶掉本端保护

**位置**：`client/hooks/useBattleStateSync.ts:335-346`（判据）、`:491-497`（卸载清理）；常量 `OPTIMISTIC_SYNC_TIMEOUT_MS = 8000`

**证据**：判据是 `historyLen >= pendingMove.historyLen` → 解除乐观保护。若对手先走一步（着法数同样增大到 ≥ 阈值），本端的乐观保护会被对手的着法"顶掉"并解除。

**具体失败场景**：本端落子（乐观更新）→ 对手的着法帧先到（着法数已 ≥ 阈值）→ 乐观保护解除、`pendingMoveRef.current` 被清空 → 此时本端着法实际被服务端拒绝 → 无基线可回退（`rollbackOptimisticMove()` 已无事可做）→ 棋盘停在一个双方都没确认过的局面。窗口 8s。

**修复建议**：保护判据改为"**本端的着法**是否已出现在权威 `moveHistory` 中"（比对 piece/from/to），而非只比长度。

---

### 4.7 【C-5】【P2】局时钟快照仅在 `data.gameState` 存在时才更新

**位置**：`client/hooks/useBattleStateSync.ts:288-302`

**证据**：

```ts
if (clocks && data.gameState) { /* 更新 clockSnapRef */ }
else if (!clocks) { clockSnapRef.current = null; }
```

当服务端下发 `clocks` 但 `gameState` 缺席时，两个分支都不命中 → 快照保持陈旧，钟面继续按旧锚点插值。

**具体失败场景**：服务端为省带宽只推 `clocks`（或 `gameState` 因体积被裁剪）时，客户端钟面与实际余时逐渐脱节。

**修复建议**：`clocks` 独立于 `gameState` 处理。

---

### 4.8 【C-6】【P2】结算原因 fallback 把"超时判负"归为 `checkmate`

**位置**：`client/hooks/useBattleStateSync.ts:319-322`；白名单 `BATTLE_END_REASONS = checkmate/resign/draw/disconnect/timeout/leave`

**证据**：`!data.winner ? 'draw' : data.surrenderBy ? 'resign' : 'checkmate'`——`endReason` 缺失或为白名单外值时，`detectClockTimeout` 写入的超时判负会被显示成"将杀"。

**修复建议**：fallback 改为 `'unknown'` 并在 UI 上显示中性文案，或让服务端保证 `endReason` 始终合法。

---

### 4.9 【C-7】【P2】`serverConfig` 无法清空地址、`isPublicHost` 误判局域网名、默认后端域名硬编码

**位置**：`client/utils/serverConfig.ts:59`、`:47-53`、`:24`

**证据**：

```ts
// :59
if (!url) return Platform.OS === 'web' ? '' : DEFAULT_SERVER_URL;
//  → setOnlineServerUrl('') 无法清空地址，会把 DEFAULT_SERVER_URL 回写进 AsyncStorage

// :47-53  isPublicHost()
// 把所有含点号的 host 判为公网并强制 https → localhost.localdomain / *.local(mDNS) 被误判
// IPv6 判定 host.includes(':') 在 extractHost 已 split(':')[0] 之后永远为假（死代码）

// :24
return process.env.EXPO_PUBLIC_BACKEND_BASE_URL || 'https://chess.ttocnserver.dpdns.org';
//  → 作者个人 Cloudflare Tunnel 域名硬编码在源码里
```

**具体失败场景**：局域网用户输入 `http://mypc.local:9091` → 被强制升级为 `https://` → 连不上，且报错信息不会提到"被自动升级"。

**修复建议**：`isPublicHost` 改为白名单/正则判定（排除 `.local`、`.localhost`、私有网段），默认域名改为必填环境变量。

---

### 4.10 【C-8】【P2】在线 AI 超时量与预算不匹配 + 非 JSON 响应被计入熔断

**位置**：`client/utils/chess/aiDispatcher.ts:97`（2s）、`client/utils/chess/onlineAI.ts:167-173`（先 `json()` 后查状态）

**证据**：

```ts
// aiDispatcher.ts:97
const ONLINE_TIMEOUT_MS = 2000;   // 注释自述由 6000 下调，理由是"线上实测 hard p50=523ms/max=550ms"
```

服务端侧：`pikafish.ts:151 JOB_SAFETY_TIMEOUT_MS = 15000`、`ai.ts:33 INFLIGHT_LEASE_MS = 20_000`、`hard` 走 `heavy` 道**仅 2 个实例**且按优先级排队（`priority=1` 的提示会插队普通走子）。

```ts
// onlineAI.ts:167-173
const data = await response.json();      // ← 先解析
if (response.status === 429) { ... }     // 后查状态
```

**具体失败场景**：
1. 自建/公网部署下 hard 排队 + 深搜轻易超过 2s → 客户端提前 abort 并用**新** `clientId` 重试（abort 不断开引擎）→ 服务端旧 job 仍在继续算 → 大师难度长时间"其实一直走本地 AI"，同时服务端 CPU 被已放弃的请求持续占用。
2. 反向代理/隧道返回 HTML 错误页（502/504 网关页）时 `json()` 抛 `SyntaxError` → 落到 `onlineAI.ts:198` 的兜底 `throw new OnlineAiNetworkError(...)` → **计入熔断**，而真实原因是"服务端可达但返回了非 JSON"，熔断器判错了对象。

**修复建议**：把 `ONLINE_TIMEOUT_MS` 提到 ≥ 服务端 job 超时（或按难度分档）；`onlineAI.ts` 先按 `response.status` 分支，再在 `try/catch` 中解析 JSON，非 JSON 归为 `OnlineAiServerError`（不熔断）。

---

### 4.11 【C-9】【P2】`getOnlineAiStatus()` 状态判定次序使 `invalid_move` 长期粘滞

**位置**：`client/utils/chess/aiDispatcher.ts:589-594`（判定）、`:220`（清空点）、`:187-195`（半开探测）

**证据**：`lastInvalidMoveReason` 只在 `recordOnlineSuccess()` 里清空。而 `recordOnlineSuccess()` 也在半开探测成功时被调用，于是：

**具体失败场景**：某次在线走法被本地守卫拒收 → 角标显示"在线走法异常" → 熔断期结束后半开探测成功 → `recordOnlineSuccess()` 把 `lastInvalidMoveReason` **静默抹掉**，用户再也不知道曾发生过"引擎与本地局面不同步"；反之若一直没成功走子，角标会永久粘滞。

**修复建议**：把"引擎返回的着法被本地守卫拒绝"做成独立的持久告警（带时间戳与次数），只在用户主动确认时清除；`recordOnlineSuccess()` 不应触碰它。

---

### 4.12 【C-10】【P2】`battleProtocol` 类型与实现轻微不一致、注释引用已废弃的 dist 行号

**位置**：`client/utils/battleProtocol/types.ts:13-15`、`:163-164`、`:201-207`；`client/utils/battleSocket.ts:49`、`:105-106`

**证据**：

- `BattleAckFrame` 只声明 `{ reqId?, status, body }`，未包含服务端实际发送的 `type: 'ack'` 字段。
- `types.ts:13` 明写"dist 无源码，行号即真源"，并引用 `chinese-chess-server/dist/index.js:26727-26766`、`:28696-28780`、`:28732-28756`；`battleSocket.ts:49` 引用 `dist/index.js:28776-28778`、`:105-106` 引用 `dist/index.js:28797-28846`。**这些前提已失效**：服务端现有 `src/` 源码，`dist` 是构建产物（md5 每次构建都可能变），注释里声称"共 9 处"的加固现在应指向 `src/`。
- `types.ts:201-207` 的注释准确描述了"服务端仅在 status < 400 时才额外广播 state"——但该描述在 HTTP 通道已因加固而**不再成立**（`lanGame.ts:180-191` 4xx 也广播），容易误导后来者。

**修复建议**：类型补齐 `type`；全部注释行号改指 `src/` 并复核描述。

### 4.13 【C-11】【P3】`playerIdentity` 的 ID 可预测

**位置**：`client/utils/playerIdentity.ts:22-40`

`id = player_${Date.now()}_${randomSuffix().toLowerCase()}`，`randomSuffix` 用 `Math.random().toString(36).substring(2,8).toUpperCase()`（约 31 bit，非加密随机，且 `Math.random` 在部分引擎上状态可被推断）。作为**唯一身份凭证**时强度不足（与 §3.1 是同一个问题的两面）。

**修复建议**：改用 `expo-crypto` 生成 128 bit 随机串（该依赖已在 `client/package.json` 中）。

---

## 5. 客户端核心逻辑审计

> 本章覆盖 `client/utils/chess/`（规则引擎、对局引擎、AI）与本地存储。

### 5.1 【C-12】【P1】`executeMove` 在 `await` 后缺少代数校验，被作废的在飞走子会"复活"旧局面

**位置**：`client/screens/game/index.tsx:743-754`（缺陷），对照 `:563-565`（AI 分支已有的正确防护）

**证据**：

```ts
// game/index.tsx:743-754（玩家落子路径）
if (isCheck && !isGameOver) {
  await playJiangJunSound();
} else if (captured !== -1) {
  await playSound('eat');
} else {
  await playSound('go');
}
// ↑ 这里让出主线程，之后无条件写回
const shownEffect = triggerMoveEffect(captured, isCheck, isGameOver);
setGameState(newState);
```

```ts
// game/index.tsx:563-565（AI 落子路径，有防护）
const gen = gameGenRef.current;
...
if (gameGenRef.current !== gen) return;   // 局面已被重置（重开/悔棋/翻转/退出）→ 丢弃结果
```

**具体失败场景**：玩家落子 → 立刻点"重开"并确认 → `invalidatePendingAI()` + `setGameState(初始局面)` → 该 promise 恢复并 `setGameState(newState)`，把**被废弃的旧局面装回棋盘**（`setMoveCount`、吃子计数、`scheduleAIMove` 一并生效）。表现为**"重开无效，棋盘自己跳回上一局残局"**。悔棋、翻转同理。

**修复建议**：与 AI 分支对齐——入口记 `const gen = gameGenRef.current`，所有 `await` 之后、任何 `set*` 之前插入 `if (gameGenRef.current !== gen) return;`。

---

### 5.2 【C-13】【P1】AI 延迟窗口内悔棋/翻转仍可点，取消一次"尚不存在"的 AI 计算

**位置**：`client/screens/game/index.tsx:815-816`（排定 AI）、`:1345`（悔棋按钮禁用判据）

**证据**：

```ts
// game/index.tsx:815-816
const aiDelay = shownEffect ? MOVE_EFFECT_DURATION_MS[shownEffect] + 120 : 300;
scheduleAIMove(newState, aiDelay);

// game/index.tsx:1345
disabled={gameState.moveHistory.length < 2 || aiThinking}
```

`scheduleAIMove` 只排定时器、**不置 `aiThinking`**，所以这 300ms（有特效时约 1.4s）里悔棋按钮可点，而底部已经显示"AI回合"。

**具体失败场景**：玩家落子 → 300ms 内点悔棋 → `handleUndo` 开头的 `invalidatePendingAI()` 把尚未开始的 AI 走子连同代数一起作废 → **局面停在 AI 回合且永不落子（软锁）**；反向时序则是 AI 落子覆盖悔棋结果。同一窗口内点棋盘也无反馈（`sideTag` 已是 AI，`game/index.tsx:645-654` 直接 return）。

**修复建议**：`scheduleAIMove` 内同步 `setAiThinking(true)`；禁用判据改为"AI 是否已排定"；补上窗口内点击的落点反馈。

---

### 5.3 【C-14】【P1】`handleUndo` 不回滚吃子计数，与盘面/存档永久不一致

**位置**：`client/screens/game/index.tsx:844-848`（悔棋），对照 `:765-771`（走子时 +1）

**证据**：

```ts
// game/index.tsx:844-848
setGameState(state);
setSelectedPieceId(null);
setValidMoves(null);
setMoveCount(prev => Math.max(0, prev - undone));
setLastMove(null);
// ← capturedRed / capturedBlack 未回滚
```

`undoMove` 已正确恢复被吃子与 `qiPan`，但两个计数 state 没回滚，而它们会被写进 `GameSave` 与 `EndgameBattleSave`。

**具体失败场景**：吃一车 → 悔棋 → 再吃一次 → 计数变 2，存档出现"吃了 2 个车但盘上只少 1 个"的不自洽。`ChessBoard` 的摘要数量实际取自**派生数组**（`components/ChessBoard.tsx:282-284`、`:695`），所以 UI 看不到差异——但存档里是错的，且这两个 `useState` 除存档外无人读取（**死数据**）。

**修复建议**：删除 `capturedRed`/`capturedBlack` 两个 state，保存时用派生数组长度（`opponentLostIds.length`）。

---

### 5.4 【C-15】【P2】`executeMove` 无重入保护，异步窗口内双击同一落点会重复提交

**位置**：`client/screens/game/index.tsx:752-771`

**证据**：入口只做规则校验，没有"处理中"标记；选中态要到 `await playSound` 之后才清空。

**具体失败场景**：快速双击同一落点 → 两次调用基于同一份未更新的 `gameState` → `setGameState` 幂等，但 `setMoveCount(prev => prev + 1)` **累加两次** → 顶部回合数跳变（`:1194-1195`），吃子计数 +2，音效播两次。

**修复建议**：加 `moveSubmittingRef` 重入锁，或进入即先清选中态再 `await`。

---

### 5.5 【C-16】【P2】AI 走法被拦为 `null` 时无人重排 → "AI回合"永久软锁

**位置**：`client/screens/game/index.tsx:506-508`；相关守卫 `client/utils/chess/aiDispatcher.ts:519-523`（`rejectMoverUnsafe`）

**证据**：

```ts
// game/index.tsx:506-508
if (gameGenRef.current !== gen) return;
if (aiMove) { /* ...落子 + 排定下一步... */ }
// aiMove === null → 整个块被跳过，finally 只复位 aiThinking
```

`aiDispatcher` 出口守卫对任意来源着法再跑 `isMoveKingSafe`，不通过即返回 `null`。

**具体失败场景**：AI 所有候选着法都被判为"送将"→ `aiMove` 为 `null` → 玩家因 `sideTag === aiSideTag` 点不动棋子，底部显示"AI回合"但永不落子 → 只能重开。该分支也不会回退 `getBestMoveAsync`。

**修复建议**：`aiMove === null` 时回退一次本地 `getBestMoveAsync`（其 `searchWithTimeBudget` 有"必定落子"兜底，`AIEngine.ts:1401-1421`）；仍失败则 `scheduleAIMove(currentState, 500)` 重试并提示。

---

### 5.6 【C-17】【P2】`handleHint` 用 `await` 前的局面快照校验并落子

**位置**：`client/screens/game/index.tsx:1085-1093`；序号仅在 `clearHint()` 时递增

**证据**：

```ts
const best = await getHybridHintMove(gameState);   // ← 用的是 await 之前的闭包快照
if (reqId !== hintReqRef.current) return;
if (!best) return;
// 随后用同一个旧 gameState 做 isMoveKingSafe 与 setHintMove
```

**具体失败场景**：AI 提示最坏 2s+；期间若局面变化（对手走子/悔棋）而 `reqId` 巧合相等，就会按旧盘面画出**不存在的棋子/非法落点**的橙色提示；点上去被 `executeMove` 的 `getValidMoves` 兜底拦下（`:698-703`），用户只看到"提示失效"。

**修复建议**：落地前增加局面指纹校验（比对 `zobristHash` / `moveHistory.length`，或直接复用 `gameGenRef` 代数）。

---

### 5.7 【C-18】【P2】存档校验不覆盖 `moveCount` / `captured*` / `ruleState`

**位置**：`client/utils/GameSave.ts:43-58`（校验），消费点 `client/screens/game/index.tsx:313-318`

**证据**：

```ts
// game/index.tsx:313-318
setGameState(save.gameState);
setMoveCount(save.moveCount);         // ← 可为 NaN / 负数
setCapturedRed(save.capturedRed);     // ← 可为 undefined
setCapturedBlack(save.capturedBlack);
```

`isValidGameSave` 只查 `pieces`（32 项数组、每项 id/col/row 为 number、alive 为 boolean）、`sideTag`（boolean）、`moveHistory`（数组）、`playerSide ∈ {red, black}`；**没有** col/row 取值范围、`moveCount` 有限性、`captured*` 类型、`qiPan`/`ruleState` 形状。

**具体失败场景**：存档被外部工具改写或版本演进后，页面顶部显示**"第 NaN 回合"**，退化值还会被继续写回存档。

**修复建议**：补 `Number.isFinite(moveCount) && moveCount >= 0`、`typeof captured* === 'number'`、`qiPan` 形状检查；失败走现有"清除损坏存档"分支。

---

### 5.8 【C-19】【P2】`hasSave()` 不做结构校验，与 `loadGame()` 口径不一致

**位置**：`client/utils/GameSave.ts:108-115`（只判 `json !== null`）vs `:75-92`（`isValidGameSave` 失败会清档并返回 null）

**具体失败场景**：损坏存档让首页/选难度页显示"有未完成的棋局"，点进去才发现没有。消费点 `screens/home/index.tsx:64-67`、`screens/pveSetup/index.tsx:57-60` 都是先 `hasSave` 再 `loadGame`，用 `save != null` 兜住，**不致崩溃**，但 UI 承诺与事实不符。

**修复建议**：`hasSave()` 内部复用 `isValidGameSave`，或直接删掉 `hasSave` 让调用方只看 `loadGame` 结果。

---

### 5.9 【C-20】【P2】本地 AI 只有协作式时间预算，没有看门狗

**位置**：`client/utils/chess/AIEngine.ts:1458-1464`；调用点 `screens/game/index.tsx`（`triggerAIMove` 的 `catch` 吞异常）

**证据**：

```ts
const maxDepth = MAX_DEPTH[difficulty] || 4;
const timeBudget = TIME_BUDGET[difficulty] || 2000;
```

**具体失败场景**：搜索异常中止时 `catch` 吞掉异常，局面同样停在 AI 回合（与 C-16 同类软锁）。该流程**没有单人对局时钟**（全文无 `setInterval`/倒计时 state），所以"interval 泄漏/单位错误/超时不触发"这类问题不存在。

**修复建议**：给 AI 回合加 8s 看门狗，到点用 `enumerateLegalMoves` 任取一着或提示重开。

---

### 5.10 【C-21】【P2】残局 FEN 校验不查"该局面是否已分胜负"

**位置**：`client/utils/chess/endgames.ts:62-159`（`validateEndgameFen`）

**已校验**（共 10 类）：空串/段数/先后手标记/10 行/字符白名单/棋子数量上限/双将存在/将帅在九宫/飞将/兵卒不在本方底线/士在士角/象在象位。

**未校验**：轮到走棋的一方是否已被将军、是否已无着。

**具体失败场景**：用编辑器摆一个**开局即绝杀**的局面 → 进入对局一步不走即通关；自定义残局还能拿**金冠**（0 次提示）。残局判胜逻辑依赖引擎的绝杀/困毙检测，而校验器不管这个前提。

**修复建议**：保存自定义残局前用规则引擎跑一次"当前走棋方是否已无合法着 + 是否被将军"，拒绝已终局局面。

---

### 5.11 【C-22】【P2】残局进度的"读-改-写"无并发保护

**位置**：`client/utils/EndgameProgress.ts:76-99`（`markLevelCompleted`）、`:111-123`（`markCustomCompleted`）

**证据**：两处都是 `loadProgress()` → 改内存 → `setItem()`，没有队列/锁/版本号。

**具体失败场景**：连点通关、或通关瞬间同时触发自定义评级写入 → 两次调用读到同一份旧档，后写覆盖前写 → **丢失一次 completed / rating 记录**（用户看到"已通关"但重进后又变未通关）。

**修复建议**：写入串行化（单一 promise 队列）或在 `setItem` 前做一次 `loadProgress` 合并。

---

### 5.12 【C-23】【P3】本地存储与进度的小项

| 位置 | 问题 |
| --- | --- |
| `client/utils/EndgameProgress.ts:89-92` | 通过最后一关（下标 29）时 `next=30` 不满足 `< 30`，`highestUnlocked` 保持 29（"最后一关自身解锁但状态上显示为未解锁的最高关"）；`isLevelUnlocked` 恰好仍能玩 |
| `client/utils/EndgameProgress.ts:149-166` | `loadEndgameBattle` 只校验 `levelIndex` 对应内置关存在，不校验 `customId` 是否还在；自定义关被删后存档仍能加载 |
| `client/utils/EndgameProgress.ts:200` | `addCustomEndgame` 的 id 用 `custom_${Date.now()}_${Math.floor(Math.random()*100000)}`（非加密随机，仅作本地主键，风险可忽略） |
| `client/utils/GameSave.ts:11-27`、`:63-70` | 存档**无版本号**；`saveGame` 内部吞异常，调用方无法提示"没保存上" |
| `client/screens/game/index.tsx:241-243`、`:828-848` | `replaySavedRef` 一次性标记悔棋后不复位：终局已存复盘 → 悔棋 → 走出另一个终局会被静默跳过 |
| `client/screens/game/index.tsx:516-522` | AI 最终落子可能选到被规则标红（长将/长捉超限）的着法：`alternatives` 为空时保留原违规着法继续落子 |
| `client/screens/game/index.tsx:1106` | `handleHint` 的依赖数组缺 `clearHint`（当前行为正确，易在重构后变成陈旧闭包） |

### 5.13 客户端核心已被核对为**正确**的部分

- **AI 不会连走两步（主路径）**：`game/index.tsx:506`、`:563` 两次代数校验；`scheduleAIMove` 先 `clearTimeout` 且自带代数校验（`:623-631`）；`finally` 仅在代未变时复位 `aiThinking`（`:615-619`）。
- **玩家无法在 AI 计算中走子**：`handlePiecePress`（`:640`）、`handleEmptyPress`（`:680`）以 `aiThinking` 守卫；AI 回合 `sideTag === aiSideTag` 使己方子不可选（`:645-654`），`executeMove` 入口还有 `getValidMoves` 兜底。
- **AI 思考中悔棋被禁用**：`:1345`（非残局）、`:1065-1066`（残局含 `!aiThinking`）。
- **悔棋局面还原一致**：`GameEngine.ts:552-585` 恢复 `alive/qiPan/sideTag/gameStatus` 并全量重放 `ruleState`；`game/index.tsx:835-847` 用差值修 `moveCount`、清 `lastMove`、`while` 循环保证停在玩家回合（仅 `captured*` 未回滚，见 C-14）。
- **终局判定完备**：`GameEngine.ts:412-536` 覆盖绝杀/困毙/吃将/长将长捉/和棋并补算胜方；和棋不被覆盖，`getWinnerSideTag` 返回 `null`（`:543-547`），不会把和棋误记成过关；`sideTag` 已翻到被判负方，文案（`:1421-1424`）与盘面一致。
- **本地 AI 必定落子**：`AIEngine.ts:1401-1421` 兜底返回第一手合法着，仅无着可走才 `null`（`:1121`）。
- **卸载清理**：AI 定时器（`:216-220`）、`cancelHintPonder()`（`:185-189`）、`unloadAllSounds()`；`SoundManager` 用 `soundSessionId` 丢弃过期播放（`SoundManager.ts:148-187`）。
- **在线 AI 订阅正确解绑**：`:439-448` 直接 `return unsubscribe`（`aiDispatcher.ts:280-285`）。
- **加载后哈希一致**：两条恢复路径都重建 Zobrist 并 `clearHistoryHash` + `recordHistoryHash`（`:292-294`、`:310-312`）。
- **返回拦截与放行标记**：`:475-484`、`:963-964`、`:977-978`，不会被自己的拦截器二次拦下。
- **特效不在终局错播**：`useMoveEffect.ts:38-60` 对 `isGameOver` 返回 `null`，终局由 `gamelose/gamewin` 接管（`:556-559`、`:807-809`）；连续将军 4s 冷却内静默跳过。
- **AI 只在私有副本上搜索**：`AIEngine.ts:1463-1464` 用 `cloneForSearch`，不写回 React state。
- **终局后输入封死**：`:1278-1279` 底部栏 `pointerEvents="none"` + `opacity:0`；`handleFlip` 有 `jueShaVisible` 守卫（`:860`）。
- **`battleSocket` 的 pending 收尾**：close / fatal / 超时三处都显式 `rejectPending`（`battleSocket.ts:418-424`），避免 Promise 悬空让 UI 停在"请求发出中"。
- **`resume()` 的重复建连守卫**：对 CONNECTING 状态不重复建连（`battleSocket.ts:310-312`）。
- **`aiDispatcher` 的 clientId 策略**：`makeRequestId()`（`:76-80`）每次请求唯一 clientId，规避服务端 `inflightClients` 活锁。
- **`aiDispatcher` 的送将三处口径统一**：`requestOnlineMove` 内、出口断言 `rejectMoverUnsafe`（`:519-523`）、落子闸门；`isOnlineMoveRuleSafe`（`:536-553`）用 `makeMove` 模拟并只拦"走子方因长将/长捉被判负"的着法。
- **`useBattleClock` 全部正确**（`client/hooks/useBattleClock.ts`，152 行，有测试）：`computeClockText(snap, correctedNow, byoyomiMs, mySide)` 为纯函数（`:84-114`）；协商期间以 `snap.clockPausedAt ?? correctedNow` 冻结钟面；走棋方按 `elapsed = Math.max(0, anchorNow - snap.lastMoveTime)` 扣减；基本用时耗尽且启用读秒显示 `读${formatClockMs(byoyomiMs + net)}`；urgent 阈值为基本用时 ≤ 30000ms、读秒阶段走棋方 ≤ 10000ms；`sideStringToTag(side) = side === 'red' ? RED_SIDE : !RED_SIDE`；`useEffect` 依赖 `[phase, mySide, serverTimeOffsetRef, byoyomiRef]`，定时器只在 `phase === 'playing'` 期间存在，并以"四字段全等则复用 prev 对象"避免无谓重渲染。
- **`narrowEndReason(raw, fallback)`** 把白名单外原因收窄为字面量联合，避免任意字符串进入页面 state（`useBattleStateSync.ts:204-211`）。
- **协商请求会自愈，不会永久卡住**（重要，已验证）：我方发起悔棋/求和后，若服务端请求因 TTL 过期或对方走棋而失效，`:384-388`（悔棋）与 `:400-403`（求和）会在"权威帧里没有 `pendingUndo`/`pendingDraw`"时**静默清除本端 pending 标记**。因此"对方离线导致悔棋无人应答"不会把界面永久锁在"等待对方同意"。两处分支的判据都是"结果帧优先、无 pending 兜底"，逻辑正确。
- **表情按 `seenEmojiIdsRef` 幂等去重**（`useBattleStateSync.ts:244-252`）；`optionsRef` 每次渲染后同步（`:219-222`）；`isActive()` 守卫丢弃晚到的帧。

---

### 5.14 规则引擎与本地 AI 专项审计（`MoveCheck.ts` / `GameEngine.ts` / `RuleEngine.ts` / `AIEngine.ts`）

> 本节编号用 **R-n**，与上文 C-n 系列区分。架构分层（重要，先读这段再读下面的缺陷）：

引擎分三层。**`MoveCheck.ts` 是走法生成的唯一真源**（`getPathPoints` 产出落点表，`afterMoveStillJiangJun` 判"走完是否仍被将/是否造成照面"）；**`GameEngine.ts`** 在其上做落子、将军/绝杀/困毙裁决、FEN 读写与在线历史构建（`buildEngineHistory`）；**`RuleEngine.ts`** 是无 UI 依赖的长将长捉计数与判和层；**`AIEngine.ts`** 是 minimax + quiescence + 迭代加深 + 时间分片（生成器 yield 让出主线程）。

客户端 UI 口径**有意宽松**：`getSelectableMoves` 不筛送将（点棋子能看到全部可走点是产品语义），送将由落子闸门 `isMoveKingSafe` 在界面层拦截。服务端 `chinese-chess-server/ruleEngine.cjs` 是 `ruleEngine.bundle.ts` 的 esbuild 产物，`src/routes/lanGame.ts` 用它的 `getValidMoves` 做权威裁决——**它比客户端多一层送将过滤**，两端一致性由 `ruleEngineParity.test.ts` 逐点钉死。

#### 【R-1】【P0】`createFromFen` 无行宽/越界校验 → 越界写入崩溃或整行静默错位

**位置**：`client/utils/chess/GameEngine.ts:615-638`（关键 `:621-626`、`:636`）

```ts
    if (c >= '0' && c <= '9') {
      const num = parseInt(c);
      for (let n = 0; n < num; n++) {
        qiPan[col][row] = -1;
        col++;
      }
    } else {
      const idx = usedFen.indexOf(c);
      if (idx !== -1) {
        qiPan[col][row] = idx;
```

**已复核确认**：本仓棋盘是**列优先**——`qiPan[col][row]`，`col` 取 0..8、`row` 取 0..9（`:596-602` 按 `BOARD_COLS` 建外层数组）。`'9k8/…'` 里 `'9'` 把 `col` 推到 9，紧接着的 `'k'` 执行 `qiPan[9][0] = 0` → `qiPan[9]` 为 `undefined` → **`TypeError: Cannot set properties of undefined (setting '0')`**，且 `pieces[0].col = 9` 已写入，局面被污染。非法字符（`usedFen.indexOf(c) === -1`）被静默跳过后仍 `col++`（`:636`），使该行之后**全部错位而不报错**；`row >= 10` 也没有任何检查。同文件 `:697` 的 `isFenBoardWidthValid` 已实现却**从不被 `createFromFen` 调用**；`__tests__/boardFixtures.ts:19-25` 明确记录过同类事故（列优先被误改为行优先导致 `col` 涨到 9 → TypeError）。

**触发面**：任何外部来源的 FEN——残局导入、服务端下发的 `startFen`、日志粘贴——都不过校验。

**修复建议**：入口先 `if (!isFenBoardWidthValid(fen)) throw new Error('非法 FEN')`；循环内对 `col >= 9 || row >= 10` 抛错；非法字符改为抛错而非 `col++` 跳过。

#### 【R-2】【P0】缺将局面下 `isJiangJun` / `afterMoveStillJiangJun` 用 `col=-1` 索引 → TypeError

**位置**：`client/utils/chess/GameEngine.ts:223-226`；同源 `client/utils/chess/MoveCheck.ts:429-431`、`:438-440`

```ts
      const thisPoints = getPathPoints(qizi, state.qiPan, positions);
      const x = state.pieces[16].col;      // GameEngine.ts:224
      const y = state.pieces[16].row;      // :225
      if (thisPoints[x][y]) {              // :226
```

```ts
          const x = (qiZi === 16) ? x1 : piecePositions[16].col;   // MoveCheck.ts:429
          const y = (qiZi === 16) ? y1 : piecePositions[16].row;   // :430
          if (thisPoints[x][y]) return true;                       // :431
```

**已复核确认**：`createFromFen` 未在 FEN 中出现的棋子坐标保持 `col=row=-1`、`alive=false`（`GameEngine.ts:606`）。只要 FEN 里缺红帅而盘上还有黑活子，`thisPoints[-1]` 即 `undefined` → 读 `[-1]` 抛 **`TypeError: Cannot read properties of undefined (reading '-1')`**。可复现：`createFromFen('4k4/9/9/9/4r4/9/9/9/9/9 w')` 后调用 `isJiangJun(state, 16)`。

注意 `makeMove` 路径**不触发**（被吃子只置 `alive=false`、保留坐标），因此**只有 FEN 载入的残局会崩**，反而更难定位。而 `afterMoveStillJiangJun` 被 `isMoveKingSafe`、`hasAnyLegalMove`、服务端裁决逐点遍历调用，会在整盘扫描中命中。

**修复建议**：取坐标后立即守卫（`if (x < 0 || y < 0) return result;`；MoveCheck 段内改为 `if (x < 0) continue;`）。

#### 【R-3】【P1】`AIEngine.findImmediateWin` 是唯一不做王安全过滤的落子出口，可返回送将着法

**位置**：`client/utils/chess/AIEngine.ts:864-884`（`:869-871`、`:875-880`），调用点 `:1174-1185`

```ts
    const undo = applyMove(state, move.pieceId, move.toCol, move.toRow);
    // 走这步之后 state.sideTag 已切到对方：对方无合法着法即为绝杀/困毙
    if (hasNoLegalMove(state)) {
      unapplyMove(state, undo);
      return move;
    }
```

**为什么值得修**：AIEngine 其它所有候选着法出口都过 `isSideInCheck(state, moverSide)`（`:1212-1213`、`:1035-1040`、`:940-950`、`:1402-1421`），**只有这个函数两段都不过**（吃将段 `:866-872` 连合法性校验都没有）；而 `searchWithTimeBudget` 在迭代加深之前先调它并**直接返回**，因此这条未过滤的着法**优先于全部合法搜索**。可构造局面：红方被将军（黑车 (0,5) 打红帅 (0,9)），同时黑方除将外的子力已把黑将 (4,0) 的三个逃格封住 → 红方任何一步都会让黑方"无合法着法"→ 返回 MVV-LVA 排序后的**第一个**伪合法着法（多半根本不解自己的将）。该着法随后被 `aiDispatcher.ts:519-523` 的 `rejectMoverUnsafe` 丢弃，**表现为 AI 该走而不走**（可用性故障，而非把非法着法落盘）。

**修复建议**：两段返回前都补 `const moverSide = state.sideTag === RED_SIDE ? BLACK_SIDE : RED_SIDE; if (isSideInCheck(state, moverSide)) { unapplyMove(state, undo); continue; }`，与根节点共用同一套合法着法过滤。

#### 【R-4】【P1】`onlineMoveGuard` 只校验起点归属，落点完全不校验（签名里也没有 `toCol`/`toRow`）

**位置**：`client/utils/chess/onlineMoveGuard.ts:51-68`（`:55-62`）

```ts
  const source = state.qiPan[move.fromCol]?.[move.fromRow] ?? -1;
  const piece = source >= 0 ? state.pieces[source] : undefined;
  if (!piece || !piece.alive) {
    throw new OnlineMoveGuardError(
      `起点 (${move.fromCol},${move.fromRow}) 无活子（服务端返回 ${move.uci}）`
    );
  }
  const pieceIsMover = state.sideTag === RED_SIDE ? piece.id >= 16 : piece.id < 16;
```

**为什么值得修**：入参只有 `{uci, fromCol, fromRow}`——`uci` **仅进错误文案、从未被解析或校验**；落点列/行没有任何范围或形状检查。守卫放行后，落子路径会执行 `const captured = newState.qiPan[toCol][toRow];`（`GameEngine.ts:422`），**越界落点即 TypeError**。服务端在对应位置有兜底（`server/src/routes/lanGame.ts:1256` 的 `if (!valid[toCol] || !valid[toCol][toRow]) return ... 非法走法`），**客户端守卫没有任何等价物**——一旦服务端/引擎返回越界坐标（UCI 解析异常、协议变更），崩溃点在客户端而不在服务端。

**修复建议**：入参加上 `toCol/toRow`，先断言 `Number.isInteger && 0<=col<9 && 0<=row<10`，再要求 `getValidMoves(state, piece.id)[toCol][toRow] === true` 才放行。

#### 【R-5】【P2】`RuleEngine.isPiecePinned` 对"一步都走不动"的子返回 `true` → 虚假长捉计数

**位置**：`client/utils/chess/RuleEngine.ts:260-274`（消费点 `:329-332`）

```ts
  const pts = getPathPoints(targetId, state.qiPan, positions);
  for (let c = 0; c < BOARD_COLS; c++) {
    for (let r = 0; r < BOARD_ROWS; r++) {
      if (!pts[c][r]) continue;
      if (c === t.col && r === t.row) continue;
      if (!afterMoveStillJiangJun(targetId, t.col, t.row, c, r, state.qiPan, positions)) {
        return false;
      }
    }
  }
  return true;
```

**为什么值得修**：伪合法落点为空时（子被己方子完全围死，例如黑象在 (0,2) 而 (1,1)、(1,3) 被己子占住；或沉底炮四邻皆己子）循环体一次都不执行即 `return true`——语义是"所有走法都会暴露将帅"（空集上任取为真），但实际含义应是"**没有走法、不存在牵制**"。于是 `:329-332` 直接把它计为可捉对象，推高 `zhuoCounts`，产生虚假的"长捉已 N 着/即将超限"红点提示。本产品长将长捉**只红点警示不判负**，故危害限于误报。

**修复建议**：循环内加 `let hasMove = false;`（遇 `pts[c][r]` 置 true），函数末尾 `return hasMove;`。

#### 【R-6】【P2】两处同名 `isSideInCheck` 对"将帅已被吃"的结论**相反**

**位置**：`client/utils/chess/AIEngine.ts:555-559` vs `client/utils/chess/RuleEngine.ts:130-133`

```ts
  const general = state.pieces[generalId];
  if (!general.alive) return true;      // AIEngine：缺失 → 恒被将军
```
```ts
  const king = state.pieces[kingId];
  if (!king.alive) return false;        // RuleEngine：缺失 → 不被将军
```

**为什么值得修**：将/帅缺失时 AI 侧判定"恒被将军"（一切着法都非法 → `hasNoLegalMove` 恒 true → minimax 把任何局面都当绝杀，搜索退化为无意义），规则侧判定"不被将军"（长将长捉计数照常推进、自然限招继续累加）。两者都只在将帅被吃后的终局残局可达，但**同名判据语义相反**，日后任一侧"对齐"另一侧都会悄悄改变终局裁决。已确认这是两处独立实现（AIEngine 另有 `isGeneralAttacked` 独立覆盖飞将段）。

**修复建议**：统一语义并在函数注释里写明（推荐统一为"不可评估，调用方须提前返回"）。

#### 【R-7】【P2】`makeMove` 不做任何合法性校验，越界参数直接崩

**位置**：`client/utils/chess/GameEngine.ts:412-426`

```ts
  const newState = cloneGameState(state);
  const piece = newState.pieces[pieceId];
  const fromCol = piece.col;
  const fromRow = piece.row;
  const captured = newState.qiPan[toCol][toRow];
```

**为什么值得修**：这是**刻意的分层设计**——`__tests__/songjiang.test.ts:200-211` 明确钉死"引擎保持不判送将的口径，拦截点在界面层"，`getSelectableMoves` 不过滤（`GameEngine.ts:95-134` 注释）也是同一决定。代价是：`pieceId` 越界 → `newState.pieces[pieceId]` 为 undefined → 读 `.col` 抛错；`toCol/toRow` 越界 → `newState.qiPan[toCol][toRow]` 抛错；形状非法的着法会被**静默落盘**。客户端 4 个调用点（`screens/game/index.tsx:729`、`:524`、`screens/lanBattle/index.tsx:1493`、`utils/chess/aiDispatcher.ts:541`）上游都有 `isMoveKingSafe` 闸门或 `rejectMoverUnsafe` 守卫，但 `screens/replayPlayer/index.tsx:64` **无任何闸门**（输入是已存历史，风险低）。

**修复建议**：`makeMove` 开头做最小参数校验（`pieceId` 0..31、坐标在盘内、`piece.alive`、`getPathPoints` 命中），非法即抛错——让"漏闸门"表现为**显式失败**而不是静默落盘。这与 R-4 是同一类问题的两端。

#### 【R-8】【P3】parity 测试"黑方走点集合一致"实为两个空数组比较，从未覆盖黑方

**位置**：`client/utils/chess/__tests__/ruleEngineParity.test.ts:199-203`

```ts
    expect(collectMoves(getValidMoves, clientState, BLACK_SIDE)).toEqual(
      collectMoves(serverEngine.getValidMoves, serverState, BLACK_SIDE)
    );
```

**为什么值得修**：`createInitialState()` 的 `sideTag === RED_SIDE`，而 `getSelectableMoves` 对非走棋方一律返回全 false（`GameEngine.ts:116-117`：`if (pieceSide !== state.sideTag) return empty()`），`collectMoves` 也不会临时切换 `sideTag`。因此这两条断言实际比较的是 `[]` 与 `[]`。**黑方的走法生成在"初始局面"这一组测试里从未被两端比对**，而黑方（id 0-15）正是行 0-4 方向、卒过河等容易出错的半边。这直接削弱了 parity 闸门的保证力。

**修复建议**：比较前 clone 一份并置 `state.sideTag = BLACK_SIDE`，或让 `collectMoves` 接受 `sideTag` 并在内部临时切换。

#### 【R-9】【P3】parity 的 `MOVE_SEQUENCE` 四步全是非法着法，注释中的子力/坐标与 `pieceId` 不符

**位置**：`client/utils/chess/__tests__/ruleEngineParity.test.ts:183-189`

```ts
const MOVE_SEQUENCE: [number, number, number][] = [
  // 中炮对屏风马开局若干着（红黑交替，覆盖炮/马/车/兵/卒走法生成）
  [29, 4, 6], // 红炮 (7,7) → (4,6)
  [7, 4, 3],  // 黑炮 (7,2) → (4,3)
  [27, 4, 7], // 红马 (7,9) → (4,7)（马走日）
  [5, 4, 0],  // 黑马 (7,0) → (4,0)
];
```

**为什么值得修**：按 `types.ts` 的 `QIZI_INIT_POSITION`/`FEN_CHARS`，id 29 是**红兵**（初始 (2,6)）、id 7 是**黑车**（(0,0)）、id 27 是**红兵**（(0,6)）、id 5 是**黑马**（(1,0)）——与注释里的"炮/炮/马/马"全不对应，四步没有一步是合法着法（步形状都不对）。因为 `makeMove` 不校验，测试仍然"通过"，但它逐步比对的是一串**非法局面**，"覆盖炮/马/车/兵/卒走法生成"的意图完全落空。隐含风险：任何给 `makeMove` 加合法校验的改动（如 R-7 的建议）都会让本测试立刻失败，而失败原因会被误读为"两端分歧"。

**修复建议**：改用合法着法序列（如 `[25,4,7]` 炮二平五 = 红炮 (1,7)→(4,7)、`[9,4,2]` 黑炮 (1,2)→(4,2)、`[21,2,2]` 马二进三 等），并让注释的 id/子力/坐标三者一致。

#### 【R-10】【P3】`GameEngine.isJiangJun` 的"实测"注释与代码实际行为矛盾

**位置**：`client/utils/chess/GameEngine.ts:199-206`

```
 * 引擎语义下"走完造成照面"的着法是**合法**的（实测走完后 isJiangJun=false、
 * hasAnyLegalMove=true），并进去会让一批合法着法凭空消失。
```

**为什么值得修**：`afterMoveStillJiangJun` 的飞将段（`MoveCheck.ts:405-420`）明确把"走完造成照面"判为 `true`，于是 `hasAnyLegalMove`（`GameEngine.ts:270`）、`isMoveKingSafe`（`:176`）、服务端裁决（`ruleEngine.bundle.ts:56`）与三张单测（`songjiang.test.ts:106-110`、`ruleEngineParity.test.ts:247-270`）都把它当非法并拦下。注释里"`hasAnyLegalMove=true`"只在"照面着法已被实际落盘之后的对方局面"上成立，写成"照面着法是合法的"与全仓实际行为相悖——注释本意是劝人别改，但**理由陈述错误**，极易误导后续把照面并入走法生成的人。

**修复建议**：改为"本函数不判照面；照面由 `afterMoveStillJiangJun` 的飞将段判为非法并拦下。本函数只回答'当前局面谁在被将'。"

#### 【R-11】【P3】`MoveCheck.isKilledPoint` 是死代码，且缺将时同样越界

**位置**：`client/utils/chess/MoveCheck.ts:337-360`

**为什么值得修**：全仓**无任何调用者**（仅导出），且内部用 `piecePositions[jiangOrShuai].col/row` 与 `afterMoveStillJiangJun` 同源的取坐标方式，在缺将局面下会与 R-2 一样越界；保留它意味着下一位读者会把它当成权威判据而引入第二套语义。

**修复建议**：删除，或补上与 `isJiangJun` 相同的坐标守卫并在注释里说明它与 `afterMoveStillJiangJun` 的分工。

#### 规则引擎与 AI 已被核对为**正确**的部分

- **八种棋子的走法生成全部逐点正确**（`MoveCheck.ts`）：车 `:150`（四向边界 `i>=0/i<=8/i<=9`，遇子按同邦断行）、马 `:173`（四向马腿 + `row>1/row<8/col>1/col<7` 出发界 + `col>0/col<8/row>0/row<9` 落点界）、象 `:199`（象眼 `=== -1` + 因象只可能落本岸故 `row<=4` 推 `side` 的河界判据成立）、士 `:223`（九宫斜线、列界 `col>3/col<5`）、将 `:248`（九宫直行；**刻意不判照面**，与注释一致）、炮 `:273`（炮架恰一：空格仅 `gezi===0` 标记、吃子仅 `!isTongBang && gezi===1`）、黑卒 `:312`（`row > 4` 才可横走）、红兵 `:323`（`row < 5` 才可横走）。
- **缓冲复用安全**：`getPathPoints`（`MoveCheck.ts:140`）每次新建 9×10 布尔表，`fillPathPoints`（`:60-99`）开头整体清零；唯一复用 scratch 的调用者 `AIEngine.generatePseudoMoves` 不递归调用。
- **绝杀/困毙/合法性**：`isJueSha`（`GameEngine.ts:284-289`）先判被将再判无合法着法；`isKunBi`（`:297-302`）"未被将且无着法"判负（符合象棋"困毙为负"）；`hasAnyLegalMove`（`:258-277`）区间 `[16,32)` / `[0,16)` 半开正确。
- **长将长捉规则层**：`RULE_CONFIG`（`RuleEngine.ts:37-56`）阈值与规范一致（长将 1 子 6 / 2 子 12 / 3 子起 18；长捉 12/18；非将非捉重复 5；自然限招 120；一局将军上限 40；总着数 400）；二将一还判负方为长将方（`:640-645`）、互长将/互长捉判和（`:618-625`）、绝杀优先于自然限招（测试用例 15）均正确；"超限仅红点提示、不拦落子"与 `__tests__/RuleEngine.test.ts` 全部用例一致（属产品决定，非缺陷）。
- **两端一致性**：服务端唯一额外过滤是 `ruleEngine.bundle.ts:52-62` 的逐点 `isMoveKingSafe`；"客户端落点表 − 送将 = 服务端裁决表"由 `ruleEngineParity.test.ts:178-180` 钉死，除 R-4 的守卫薄弱点与 R-8/R-9 的测试覆盖缺口外未发现其它分歧。
- **AI 搜索主体**：minimax / quiescence / 根节点三处的合法着法过滤口径统一为 `isSideInCheck`（含飞将段），迭代加深每层都重置 alpha/beta；`applyMove`/`unapplyMove`（`AIEngine.ts:723-791`）与 `computeZobristHash`（`:470-482`）的 XOR 序列互相对称且含走棋方；killerMoves 按层索引、"上一层两格"边界正确。
- **无除零/空数组索引/无界递归**：`rootMoveEvals`/`weights`/`candidates` 均有 length 或 `Math.max(1, …)` 守卫；搜索深度受 `MAX_DEPTH` 与时间分片双重约束；未发现共享棋盘被误改写（`afterMoveStillJiangJun` 深拷贝列、`RuleEngine.simulateMove`、AIEngine 的 apply/unapply 成对使用）。
- **id↔类型/方映射一致**：`types.ts` / `ruleEngine.bundle.ts` / `onlineMoveGuard.ts` 的 `id 0-15 黑、16-31 红` 在全部调用点一致，未发现 off-by-one 或方向反置（含 `getWinnerSideTagFromReason`、`sideTag` 取反处）。

---

## 6. 客户端页面与组件审计

> 本章覆盖 `client/screens/**` 与 `client/components/**`、`client/hooks/**`（除已在上章覆盖者）。

### 6.1 【C-24】【P1】路由载荷 base64 含 `/`，未 URL 转义 → 约 37% 含中文名的跳转丢参数

**位置**：`client/hooks/useSafeRouter.ts:59-67`（序列化）、`:97-118`（push/replace/navigate）；`PAYLOAD_KEY = '__safeRouterPayload__'`（`:43`）

**证据**：

```ts
// useSafeRouter.ts:59-67（逐字抄写）
const serializeParams = (params: Record<string, unknown>): string => {
  try {
    const jsonStr = JSON.stringify(params);
    return Base64.encode(jsonStr);            // ← 标准字母表，输出含 + / =
  } catch (error) {
    console.error(LOG_PREFIX, 'serialize failed:', error instanceof Error ? error.message : 'Unknown error');
    return '';
  }
};
```

**运行时取证（本次审计实际执行）**：对 19 个真实载荷样本（`roomId + playerId + 中文房间名 + isHost`）编码：

```
样本 19 | 含 "/" : 7 | 含 "+" : 0 | 含 "=" 补位 : 1
SLASH 七星聚会 / 蚯蚓降龙 / 房间一 / 张三的房间 / 测试房间 / A房间 / 胆大穿心
```

具体一例：

```
载荷 { roomId:'123456', playerId:'player_1759300000000_ab12cd', name:'房间一', isHost:true }
base64 = eyJyb29tSWQiOiIxMjM0NTYiLCJwbGF5ZXJJZCI6InBsYXllcl8xNzU5MzAwMDAwMDAwX2FiMTJjZCIsIm5hbWUiOiLmiL/pl7TkuIAiLCJpc0hvc3QiOnRydWV9
                              ↑ 注意 "miL/pl7T" 里的 "/"
拼出的 URL： /lanBattle?__safeRouterPayload__=eyJ...miL/pl7T...
```

**具体失败场景**：`expo-router` 用 react-navigation 的 `getPathFromState` 组装路径，query 值的 `/` 不会被百分号转义 → URL 解析时查询值被提前截断 → 接收端 `deserializeParams`（`:69-82`）`Base64.decode` 得到截断串 → `JSON.parse` 抛错 → 记 `[SafeRouter] deserialize failed:` 并回退到**空参数**（`getCurrentParams` `:47-57`：`const { [PAYLOAD_KEY]: _, ...rest } = rawParams; return rest` → rest 为空对象）。表现：房间名/roomId/playerId 全丢、进对局页空白或直接报错。日志里只有一条 error，用户只看到空白页。

**受影响跳转**：`spectate?roomId=...`、`lanBattle`、`endgameEdit`、`replayPlayer`、`game`（endgame 参数）。

**修复建议**：改用 `Base64.encodeURI(...)`（js-base64 已提供，字母表 `-` `_`；实测 `Base64.decode(encodeURI(payload)) === payload` 为 **true**，即解码端无需改动）。

**实测记录（供复现）**：探索期两次失败值得记下——在 `chinese-chess-client/client/` 下用 `require('./client/node_modules/js-base64')` 会 `MODULE_NOT_FOUND`（相对路径基准错）；把 base64 经 PowerShell 命令行参数回传时 Windows 会破坏引号/反斜杠（`TypeError: Cannot read properties of undefined (reading 'replace')`）。可行写法：工作目录设为 `chinese-chess-client/client`、require 用裸包名 `'js-base64'`、脚本用 `Out-File -Encoding utf8` 落成临时 `.cjs` 再 `node <file>` 执行。另注：`client/node_modules/.pnpm` **不存在**，真实 pnpm store 在 `chinese-chess-client/node_modules/.pnpm`（如 `js-base64@3.7.8`）。

### 6.2 【C-25】【P2】`getCurrentParams` 在解码失败时把原生 query 当业务参数返回（类型丢失）

**位置**：`client/hooks/useSafeRouter.ts:47-57`

外部深链接/浏览器直连进入的页面，其"原生 query 参数"会被原样当成 business params 返回（注释把这点当作兼容特性），但**类型丢失**（全是 `string`）且没有任何标记；接收端按 `useSafeSearchParams<{id: number}>()` 强类型解构会拿到 `string`。

### 6.3 【C-26】【P2】`setOnlineServerUrl('')` / `testServerConnection('')` 无法清空

见 §4.9（同一函数族的三个问题合并记录，实施时建议一起改）。

### 6.4 【C-27】【P2】残局选关页：批量删除竞态、`refresh` 无卸载守卫、自定义关卡缺 disabled 保护

**位置**：`client/screens/endgame/index.tsx:180-185`、`:138-151`、`:409-435`

1. **批量删除竞态**：`handleBatchDelete` 用 IIFE `(async () => { for (const id of ids) { await deleteCustomEndgame(id); } refresh(); })();`——`refresh()`（内部 `Promise.all([loadProgress(), loadEndgameBattle(), loadCustomEndgames()])`）在删除循环**之后**启动，但 IIFE 本身没被 await；若与 `useFocusEffect`（`:153-157`）的 refresh 交错，可能写入旧列表。
2. **`refresh` 无取消/无 isMounted 守卫**：async 函数在页面卸载后仍会 `setProgress/setBattleSave/setCustomLevels`（`:144-146`）；配合"每次聚焦都跑一次"，快速来回切页会出现**后发先至**的旧数据覆盖新数据。
3. **自定义关卡没有 `disabled`**：内置网格有 `disabled={!unlocked}`（`:378`），自定义网格（`:409-435`）没有，仅靠 `onPress` 内 `if (deleteMode)` 分支与 `onLongPress`（`delayLongPress={350}`，`:428`）处理——长按 350ms 期间先触发的短按会**直接进入对局**，用户"想删却进了对局"。

### 6.5 【C-28】【P3】残局页与组件的质量小项

| 位置 | 问题 |
| --- | --- |
| `client/screens/endgame/index.tsx:101-109` | `deleteArmTimer` 只在 `clearDeleteArm` 清理，**组件卸载无 cleanup**；3 秒内退出页会对已卸载组件调 `setDeleteArmed` |
| `client/screens/endgame/index.tsx:129-131` | `GRID_GAP = 10` 定义在组件体内、魔法数 108（卡片最小宽）散落在渲染路径 |
| `client/screens/endgame/index.tsx:200-209` | `handleResume` 对 `levelIndex === -1` 的自定义存档不校验 `customId` 是否仍存在 |
| `client/utils/chess/endgames.ts:105-107` + `:132-133` | `validateEndgameFen` 的兵卒规则实际是"红兵不能在第 7-9 行"（**与残局惯例一致，不是缺陷**）；真正缺的是兵卒列可达性与"双方兵卒/车马炮总数之和"一致性（降级为 P3 提示：`5 红兵 + 5 黑卒` 在 Xiangqi 中其实合法） |

### 6.6 客户端页面已被核对为**正确**的部分

- **字号规范 100% 遵守**：全部页面字号取自 `@/utils/typography` 的 `FONT`（`{ micro:10, caption:12, body:14, control:16, title:18, display:20, displayLg:24, hero:36, countdown:80, countdownCard:48 } as const`），无裸写 `fontSize`。注释声明的豁免：按棋盘尺寸等比缩放的动态字号（棋子/让子/被吃数量角标，由 `ChessBoard`、`HandicapBoard`、`endgameEdit` 自行计算）与倒计时大字（数字展示特例）。
- **残局页的交互设计有实机依据**：`deleteMode` + `deleteArmed` 两段式内联确认（3 秒有效）是有意替代"实机不弹的原生 Alert"；网格用包装层 `levelCellWrap` 作绝对定位锚点，避免皇冠角标挤压卡片居中布局（注释说明这是实机问题的修复）。
- **内置残局数据**：`BUILTIN_ENDGAMES`（`client/utils/chess/endgames.ts:16-46`）的 `id` 并非 1..30 连续，而是 `1,2,3,31,32,...,57`（30 条）；导航一律用**数组下标**而非 id。所有内置 FEN **不带** ` w`/` b` 先后手标记（默认红先）。

### 6.7 联机对局页 `lanBattle/index.tsx`（3455 行）

这是全仓最大的客户端文件，承载准备/选边/公示倒数/对局/结算/重赛的完整状态机、WS+HTTP 双通道发送、局时钟与步时、悔棋求和 UI、表情与棋盘布局。**质量明显高于平均水平**：几乎每条异步路径都有守卫（乐观更新快照 + 8s 宽限 + 回滚链、`pendingUndoRef/pendingDrawRef` 自愈、`intentionalExitRef`/`sessionGoneRef` 短路、`webPopRestoreRef` 抑制重复 popstate），关键取舍都写了「为什么」。未发现 P0。

以下 2 条 P1 都落在**同一个 effect**（步时倒计时）上，且都会让**客户端擅自替用户走棋**。

#### 【C-40】【P1】步时倒计时用本机时钟减服务端时间戳 → 设备时钟偏快时自动替用户走随机棋

**位置**：`client/screens/lanBattle/index.tsx:1755-1758`（数据来源 `client/hooks/useBattleStateSync.ts:280-283` 写入的 `room.lastMoveTime`）

```ts
    const timer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - lastMoveTimeRef.current) / 1000);
      const remaining = Math.max(0, turnTimeLimit - elapsed);
      setTurnTimeLeft(remaining);
```

**为什么值得修**：`lastMoveTimeRef.current` 存的是**服务端**毫秒时间戳（`useBattleStateSync.ts:282-284` 直接写入 `data.lastMoveTime`，来自服务端的 `room.lastMoveTime`），而这里用**本机** `Date.now()` 去减它。于是 `elapsed` 实际上等于「本步在服务端的真实经过时间 + 本机相对服务端的时钟偏差」，**两个后果同时存在**：

- **后果 A（每次都发生，用户立刻可见）**：倒计时数字被偏移量污染。设备比服务端快 7 秒时，步时 30 秒的房间开局就显示 0:23；慢 7 秒则显示 0:37 并最终停在 0:00 不动。
- **后果 B（偏差大于步时时发生，最严重）**：甲的设备比服务端快 60 秒、房主开了「步时 30 秒」→ 乙走完一步、服务端广播 `lastMoveTime=T` → 甲第一个 tick 算得 `elapsed≈60` → `remaining=0` → 只要轮到甲，第 1 秒就执行 `doRandomMove()`（`:1761-1762`）。服务端会正常接受（确实轮到甲），于是用户看到「**我还没动手，棋子自己动了**」。因为常见步时是 30/60 秒，这个阈值在"系统时钟没校准"的设备上并不罕见。

**注意**：`doRandomMove` 的触发门槛不是"偏差存在"而是"偏差 ≥ 步时"，所以后果 B 的触发率低于后果 A；但两者同源，一处修复同时消除。定级为 P1 是基于后果 B 的严重性（污染对局结果），而非其发生频率。

**修复建议**：与本文件 `:1176-1181` 的公示倒数保持一致，用 `Date.now() + serverTimeOffsetRef.current`。该文件 `:274-275` 的注释本身已写明「凡与服务端时间戳比较一律使用校正后的服务端时间」——即作者已经知道这条规则，只是这个 effect 漏了。

#### 【C-41】【P1】悔棋/求和协商期间步时不停表 → 超时自动走棋并静默吞掉协商

**位置**：`client/screens/lanBattle/index.tsx:1757-1762`；服务端暂停棋钟的证据在 `server/src/routes/lanGame.ts:1624`（悔棋）、`:1718`（求和），以及 `:1272-1273`（走子时清空 pending）

```ts
      const remaining = Math.max(0, turnTimeLimit - elapsed);
      setTurnTimeLeft(remaining);

      // 超时随机走一步棋
      if (remaining <= 0 && isMyTurn) {
        doRandomMove();
      }
```

**为什么值得修**：服务端在收到悔棋/求和时会 `pauseClock(room)` 冻结棋钟（pending 在 30s TTL 内保持），但这个 effect **完全不读** `clockSnapRef.current?.clockPausedAt`，也不随暂停复位 `lastMoveTimeRef`。真实场景：步时 30 秒，甲在第 5 秒点「悔棋」并显示「等待对方同意」，乙的同意弹窗开着思考 25 秒 → 甲的步时先归零 → 客户端自动随机走一步 → 服务端 `actMove` 里 `room.pendingUndo = null; room.pendingDraw = null;`（`lanGame.ts:1272-1273`）→ **协商被无声取消**（乙的弹窗消失、甲的「等待对方同意」复位），甲还被迫多走了一步随机棋。这是"服务端暂停了、客户端没停"造成的两端语义分叉。

**附带事实**（值得写进文档而不是当成缺陷）：步时目前**只由客户端前台定时器兜底**，服务端并不校验 `turnTimeSeconds`（`lanGame.ts:693-696` 只做入库校验）。因此界面切后台/锁屏时步时完全不生效——这是"步时"这一功能的设计边界，不是 bug，但用户可感知。

**修复建议**：`clockPausedAt` 非空时冻结本端步时（不递减、不 `doRandomMove`），或直接复用 `useBattleClock.ts` 的 `computeClockText` 语义。

#### 其余缺陷

| 编号 | 级别 | 位置 | 问题 | 修复建议 |
| --- | --- | --- | --- | --- |
| C-42 | P2 | `lanBattle/index.tsx:1609-1613` | **HTTP 兜底不读响应**：只看 `fetch` 是否抛异常，不看 `response.ok`/`body.success`。WS 断开时被服务端 400 拒绝的走子既无提示也不回滚，棋子停在服务端从未接受的位置；由于乐观保护要等 8 秒才放弃，这 8 秒内两侧互相干等 | `if (!resp.ok \|\| !body?.success) handleActionRejected(new BattleActionRejectedError(type, resp.status, body?.message))` |
| C-43 | P2 | `lanBattle/index.tsx:1530-1533`（回滚实现 `useBattleStateSync.ts:447-453`） | **乐观回滚只还原局面，不还原终局 UI**：`handleMove` 本地结算会 `setPhase('ended')` 并置 `jueShaVisible/gameResult/gameEndReason`，而 `rollbackOptimisticMove()` 只做 `setGameState(pending.snapshot)`。用户走出一手「本地绝杀」但被服务端拒绝时，棋子回滚了、页面**永久停在绝杀浮层** | 终局展示完全由服务端 `phase==='ended'` 驱动，或回滚时一并复位这几个状态 |
| C-44 | P2 | `lanBattle/index.tsx:1185-1189`（`countdownTimerRef` 声明 `:294`） | **公示倒数定时器没有卸载清理**：清理点只有 `abortRevealSequence:1196-1197`、`finishSequenceEarly:1211-1212`、`resetForRematch:1968-1969`，**没有任何 unmount effect 清它**。3 秒倒数期间返回 → 页面卸载后残留 interval 仍触发 `startGame()` → 卸载后 `setState` + `uploadInitialGame()`（POST `/start` + POST `/gameState`）。服务端 `actStart` 的三道校验会兜住不破坏房间，但会产生「鬼请求」 | 在 `:2221` 的卸载 effect 里一并 `clearInterval(countdownTimerRef.current)` |
| C-45 | P2 | `lanBattle/index.tsx:770-775`（上传体 `:1080-1137`） | **初始局面上传缺少在途互斥**：仅 `if (uploadedRef.current) return;` 守卫，而它要到「POST /start + POST /gameState + GET 读回校验」全部完成（`:1130`）才置位；调用点有三处（`startGame()`、`handleReady` 的 autoRevealed 分支、`:770` 的 12 秒轮询兜底）。慢网下会双上传 → 两次 `/start` 让 `room.matchId += 1`（`lanGame.ts:1207`）执行两次，双端 `gameStartTime` 与时长统计变得不确定 | 加 `uploadInFlightRef`，三处调用统一走"在途一次"包装 |
| C-46 | P3 | `lanBattle/index.tsx:2004-2007` | `resetForRematch` 复位了 `drawPendingRef` 却**漏了 `undoPendingRef`**（声明 `:486-487`）。上一局在「等待对方同意」期间被终局打断时，重赛进新局后「悔棋」按钮先显示成 disabled 的「等待对方同意」 | 与 draw 侧对称补 `undoPendingRef.current = false; setUndoPending(false);` |
| C-47 | P3 | `lanBattle/index.tsx:293`（清理点 `:1196`、`:1211`、`:1968`） | `revealTimerRef` 是**死引用**：全文件只有 3 处 `clearTimeout`，**没有任何一处给它赋值**（公示倒数只用 `countdownTimerRef`）。会让读者以为公示阶段还有一个 timeout | 删除该 ref 及三处 clearTimeout |
| C-48 | P3 | `lanBattle/index.tsx:169`（使用点 `:2139`） | `GamePhase` 联合类型里的 `'countdown'` 是**无人写入的死值**（全仓无 `setPhase('countdown')`），但 `inGamePhase`/`requestExit` 仍在判断它，后续改动容易被误当成真实状态 | 从联合类型与所有判断中移除 |
| C-49 | P3 | `lanBattle/index.tsx:272-276` | 注释与变量错配：`:272-273` 描述的「最近一次返回房间时间戳」ref 已被 `:277-279` 的 `playedMatchIdRef` 取代，却仍贴在 `serverTimeOffsetRef` 上 | 删除或移到 `playedMatchIdRef` 上方 |
| C-50 | P3 | `lanBattle/index.tsx:1568-1576`、`:513-531` | 每次渲染重建对象/数组：组件体内新建 `HTTP_ACTION_PATH` 映射、遍历 32 个棋子重建吃子明细。在已有 1s/800ms/250ms 多个定时器的 3400 行屏幕上会放大下游 memo 失效与重渲染 | `HTTP_ACTION_PATH` 提到模块级；吃子明细用 `useMemo(..., [gameState])` |
| C-51 | P3 | `lanBattle/index.tsx:1527`、`:1741` | 走子上报是 fire-and-forget：`sendPlayerMove(...)` 的 Promise 无人接（内部虽有两层 try/catch，但 `handleActionRejected`/`getOnlineServerUrl()` 抛错就会变成未处理拒绝） | `void sendPlayerMove(...).catch(...)` 或在 `sendBattleAction` 外层统一兜底 |
| C-52 | P3 | `battleSocket.ts:427-429`、`battleProtocol/index.ts:85` | **`BattleSocket.send()` 与 `emitBattleAction()` 已是死代码**：页面只调用 `request()`（`lanBattle/index.tsx:1594`），全仓无 `send()` 调用者。注意这让 §4.3 的 C-1 从"线上故障"降级为"潜在故障 + 死代码证据"（见 §4.3 的说明） | 删除死代码，收敛到 `request()` 单一入口 |

### 6.8 大厅与观战页 `lanGame/index.tsx`（1286 行）+ `spectate/index.tsx`（989 行）

**HTTP 契约经逐条核对与服务端完全一致**（路径/方法/body 字段/错误体形状都对），两端校验规则也无分歧（房间名 ≤5、密码 `^\d{1,6}$`、让子 21~31、局时/步时/加秒/读秒上限、加秒读秒互斥）。问题集中在**响应健壮性**（四个 fetch 全部没有 `response.ok` 检查）与**错误状态语义混用**。

#### 【C-53】【P1】观战页「步时」完全失效：hook 只写 ref 不调 setter，本页又没传 ref

**位置**：`client/screens/spectate/index.tsx:206`（关联 `client/hooks/useBattleStateSync.ts:152` 与 `:263-265`）

```tsx
    setSpectatorCount,
    setTurnTimeLimit,          // spectate/index.tsx:206
```

```ts
      // useBattleStateSync.ts:263-265 —— 只写 ref，从不调用 opt.setTurnTimeLimit
      if (typeof settings.turnTimeLimit === 'number' && opt.turnTimeLimitRef) {
        opt.turnTimeLimitRef.current = settings.turnTimeLimit;
      }
```

**已复核确认**：`useBattleStateSync` 的接口声明了 `setTurnTimeLimit`（`:152`）却**全文件从未调用**（死 API）；而本页只把 `setTurnTimeLimit` 传了进来（`:206`），**没有传 `turnTimeLimitRef`**（只有 `lanBattle/index.tsx:837` 传了 ref）。结果是本页 `turnTimeLimit` 恒为初始值 0 → `:585` 的步时芯片条件 `phase === 'playing' && turnTimeLimit > 0` 永不成立，`:296` 的步时倒计时 effect 直接 `return undefined`。**限时步时的房间里，观众永远看不到那个倒计时**——而这正是 `:523` 注释宣称已修复的用户反馈。

**修复建议**：本页加 `const turnTimeLimitRef = useRef(0)` 一并传给 hook（并让 `:296`/`:585` 读该 ref），或让 hook 在写完 ref 后补 `opt.setTurnTimeLimit?.(settings.turnTimeLimit)`。

#### 其余缺陷

| 编号 | 级别 | 位置 | 问题 | 修复建议 |
| --- | --- | --- | --- | --- |
| C-54 | P2 | `spectate/index.tsx:413` | **房间被回收后观战页永久静默空转**：服务端 GC 掉房间（`WAITING_ROOM_TTL`/`ACTIVE_ROOM_TTL`）或重启后 `GET /rooms/:id/gameState` 返回 404，这里 `if (!response.ok) return;` 既不设 `errorMsg` 也不切终态 → 每 2s 发一次注定失败的请求，棋盘永远停在最后一帧。`:434` 的观战心跳同样不看 `response.ok` | 404 时置 `setErrorMsg('房间已关闭')` + `setPhaseSafe('error')` 并停掉轮询/心跳 |
| C-55 | P2 | `lanGame/index.tsx:173-175` | **异常响应会清空 `activeRoom`**：只看响应体不看 `response.ok`，任何「非 2xx 但返回 JSON」的响应（网关 JSON 错误页）都会把 `activeRoom` 置空。而它是 `isMyActiveRoom`（`:568`）与 `handleSpectate`（`:261`）的唯一依据 → 本人正在对战的房间会冒出「观战」按钮（`:636-642`，服务端会接受：房间 playing 且席位完整），同时顶部「回到对局」横幅消失 | 先 `if (!response.ok) return;`，且仅在响应体确实含 `room` 键时才覆盖（`if ('room' in data)`） |
| C-56 | P2 | `spectate/index.tsx:369-373` | **错误状态语义混用**：`errorMsg` 同时当"瞬时提示"和"终态错误"用，`onStatusChange` 一连接就 `setErrorMsg('')` 而**没有任何路径把 phase 从 `'error'` 改回来** → 若此刻 WS 首帧里没有 gameState，用户永久停在「正在载入棋局…」，且 `:405` 轮询与 `:431` 心跳都因 `phaseRef.current === 'error'` 直接 return，20s 后还会被服务端 `SPECTATOR_TTL` 剪掉且永不重新登记 | 拆成 `noticeMsg`（瞬时，连上即清）与 `fatalMsg`（终态，不可被清），或把清空条件收紧为 `if (connected && phaseRef.current !== 'error')` |
| C-57 | P2 | `lanGame/index.tsx:193-196` | **大厅 3s 轮询无并发防护**：`fetchRooms`/`fetchActiveRoom` 都没有 in-flight 标记（同类轮询在观战页 `spectate/index.tsx:403-409` 有防护）。单次请求超过 3s 时先发后到的旧响应会覆盖新响应，房间列表与「回到对局」横幅会闪回旧状态 | 加 `inFlightRef`，与观战页一致 |
| C-58 | P2 | `lanGame/index.tsx:155-157` | **房间列表请求失败即清空列表**：无 `response.ok` 检查，5xx 返回 JSON 错误体时 `data.rooms` 为 undefined → `setRooms([])` → 界面变成「暂无房间」，用户误以为大厅被清空；非 JSON 响应则 `response.json()` 抛错被 catch 吞掉只留 console | `if (!response.ok) throw ...`，catch 里提示错误并**保留上一次的 `rooms`** |
| C-59 | P2 | `lanGame/index.tsx:225-238` | **保存服务器地址的存储写入失败会抛出未处理的 Promise 拒绝**：`setOnlineServerUrl`（`serverConfig.ts:116-121`）内部 `await AsyncStorage.setItem(...)` 无 try/catch，本函数也没有 → 弹窗不关、状态不刷新，而 `ModalButton onPress` 不接收 Promise，拒绝无人捕获。`handleResetServer`（`:233-238`）同样 | 包 try/catch，失败提示用户，且无论成败都 `setShowServerModal(false)` |
| C-60 | P2 | `spectate/index.tsx:387` | **一条非致命错误帧永久盖住观战画面**：`onError: message => setErrorMsg(message)` 写入的 `errorMsg` 渲染成全屏遮罩（`:747-758`），唯一按钮是「返回大厅」；而清空它的路径只有 `onStatusChange(true)`（连接保持存活时 BattleSocket 不会重连）→ 一次协议级失败帧（如「未知消息类型」）就让观众再也看不到棋盘，只能退出 | 非致命错误改为可自动消失的顶部提示 |
| C-61 | P2 | `spectate/index.tsx:430-442` | **观战心跳丢失后无法重新入列**：服务端 `SPECTATOR_TTL = 20000`、客户端心跳 10s，但服务端这条心跳只在「该 id 仍在 `room.spectators` 中」时刷新 `lastSeen`（`lanGame.ts:1408-1422` 先 `pruneSpectators` 再判存在）→ 一旦因后台节流错过 20s 被剪掉，这条心跳**永远不再登记**，客户端也不检查 `response.ok`、没有重新注册逻辑 → 观众人数永久少算 1 人，自己再也收不到恢复 | 心跳响应非 ok 时重新 POST 一次 `/spectate`；注册成功后立即补发一次心跳 |
| C-62 | P3 | `spectate/index.tsx:324-331` | `enter()` 缺少 `!roomId` 守卫（同屏另外三个 effect 都有），`params.roomId` 缺失时会向 `/api/v1/lan/rooms//spectate` 发 POST，错误文案与实际原因不符 | enter 开头加守卫，与其它 effect 一致 |
| C-63 | P3 | `lanGame/index.tsx:188-191` | **昵称回填会覆盖用户正在输入的内容**：每次聚焦都把持久化昵称写回受控输入框，无「用户已改动」标记 | 加 `nameTouchedRef`，或 `setPlayerName(prev => prev \|\| name)` 只做首次回填 |
| C-64 | P3 | `lanGame/index.tsx:319-332`、`:372-382` | 请求在途时退出页面，成功回调仍会继续 `router.push`（在已失焦的导航栈上继续跳转），用户会突然被推进自己已放弃的房间 | 加 `mountedRef`，await 之后先判断再写状态/导航 |
| C-65 | P3 | `spectate/index.tsx:100-102` | 忽略服务端下发的 `roomName`（`POST /spectate` 响应与 `buildGameStatePayload` 都带），深链进入时标题恒为兜底文案「在线对局」 | 增加 `roomTitle` state，渲染用 `roomName \|\| roomTitle \|\| '在线对局'` |
| C-66 | P3 | `spectate/index.tsx:44-46` | `Dimensions.get('window')` 在**模块顶层**求值，Web 端缩放窗口/旋转/分屏后棋盘高度预算与底部栏宽度仍按旧尺寸计算 | 改用 `useWindowDimensions()` |
| C-67 | P3 | `lanGame/index.tsx:86-94` | 服务端下发的 `opponentConnected`（以及 `createdAt`）读入后**从未使用**：断线重连横幅只会说「你有进行中的对局 · 对手 XXX」，无法提示「对手已离线」 | 横幅补 `opponentConnected ? '' : ' · 对手已离线'`；确定不用的字段从接口声明删除 |
| C-68 | P3 | `lanGame/index.tsx:198` | 服务器状态条（含 4s 健康探测的 `refreshServer()`）只在聚焦时跑一次，停留期间服务端掉线不会变红 | 轮询里周期性或在连续 N 次失败后触发一次 `refreshServer()` |
| C-69 | P3 | `lanGame/index.tsx:486-490` | 创建与加入**共用同一个 `loading`**：点「加入」时顶部「创建房间」按钮自转并禁用，反之亦然 | 拆成 `creating`/`joining` |
| C-70 | P3 | `lanGame/index.tsx:542`、`:587` | 卡片从不显示房主名（渲染的是 `item.name`，样式名却叫 `roomHostName`），但搜索框按 `r.hostName` 筛选 → 用户按一个界面上看不见的字段筛选 | 补显示 `item.hostName`，或改搜索提示 |
| C-71 | P3 | `lanGame/index.tsx:613`（实现 `:60`） | `handicapSummary(ids)` 对缺字段不设防：服务端未下发 `handicap` 时 `ids.map(...)` 抛 `TypeError` → **整个 FlatList 渲染失败（白屏）**。同函数的 `filteredRooms` 已用 `(r.hostName ?? '')` 兜过底，说明协议漂移是被考虑过的 | `handicapSummary(ids: number[] = [])` 或调用处 `?? []` |
| C-72 | P3 | `lanGame/index.tsx:252`、`:328`、`:381` | **`isHost` 路由参数是死参数**：三条路径都传，但 `lanBattle/index.tsx` 全文 0 处引用（完全靠服务端负载里的 `players`/`hostId` 判断房主），会让维护者误以为房主身份靠路由参数传递 | 删掉三处传参，或在 lanBattle 里真正消费 |

---

### 6.9 棋盘、浮层与共享组件（C-73 ~ C-94）

覆盖 `ChessBoard.tsx`（41.3KB）与配套浮层、Modal 系列、屏幕容器、棋盘几何/样式工具共 23 个文件。**棋盘核心的坐标数学是干净的**（详见本节末 verified-clean），22 条发现集中在浮层的可交互性、尺寸量纲与契约/死代码三类。

#### 【C-73】【P1】绝杀浮层按钮在 2.5s 淡入期内不可见但可点击，会误触「再来一局 / 下一关 / 返回首页」

**位置**：`client/components/JueShaOverlay.tsx:294`（关联 `:149-152` 动画、`:177` 定位、`:359-364` 样式）

```tsx
// JueShaOverlay.tsx:294 —— buttonsArea 没有 pointerEvents
<Animated.View style={[styles.buttonsArea, { opacity: buttonsOpacity, top: buttonsTop }]}>
  <View style={styles.buttonsRow}>
    {onNextLevel && (
      <TouchableOpacity style={styles.buttonPrimary} onPress={onNextLevel}>
```

**为什么值得修**：`showEffect` 时按钮序列是 `Animated.sequence([Animated.delay(2500), Animated.timing(buttonsOpacity, { toValue: 1, duration: 400 })])`（`:149-152`），即前 2.5 秒 `buttonsOpacity === 0`。但 **RN 的命中测试与 `opacity` 完全无关**——只有 `pointerEvents="none"` 或 `display:'none'` 才能把节点移出命中区。外层 `styles.container` 的 `pointerEvents="box-none"`（`:180`）只作用于它自己、**不传递给孩子**，而 `styles.buttonsArea`（`:359-364`）没有设 `pointerEvents`。按钮区又被绝对定位在 `buttonsTop = boardBottom + 6`（`:177`），**正好压在棋盘正下方的底部操作区上**。

于是绝杀动画开始后的 2.5 秒内，用户在底部栏位置（悔棋/认输/返回等控件附近）的任何一次落点都会命中那个看不见的 `TouchableOpacity` → 直接重开一局或返回首页，**本局结果被跳过**。这是「看不见的按钮吃掉可见按钮的点击」，用户完全无法理解发生了什么。

**修复建议**：给 `styles.buttonsArea`（或该 `Animated.View`）加 `pointerEvents={buttonsEnabled ? 'auto' : 'none'}`，用一个 state 在淡入动画的 `start()` 回调里置真。淡入完成前彻底不参与命中测试。

#### 【C-74】【P1】GameNotice 内层 View 吞掉棋盘点击，提示条可见的 3 秒内棋盘中部无法落子

**位置**：`client/components/Modal/GameNotice.tsx:131`（关联 `:125-130`、`:156-163` 样式；调用方 `client/screens/game/index.tsx:1369-1373`、`client/screens/lanBattle/index.tsx:2618-2621`）

```tsx
// GameNotice.tsx:126-131 —— box-none 只加在外层
<Animated.View
  // 绝对定位在棋盘之上居中：非阻塞，不吃掉棋盘的点击
  pointerEvents="box-none"
  style={[containerStyle, { opacity }]}
  collapsable={false}
>
  <View style={styles.inner} collapsable={false}>
```

**为什么值得修**：只有外层 `Animated.View` 设了 `box-none`，内层深色提示条 `View style={styles.inner}`（`:156-163`：`maxWidth:'92%'`、`paddingVertical:16`、`paddingHorizontal:24`，约 92% 屏宽 × 60~80px 高）是默认的 `pointerEvents="auto"`。RN 的响应者链从命中目标向上冒泡，**不会把同一位置的兄弟节点（棋盘交互层）纳入候选**；Web 上则是这个 div 的 `pointer-events:auto` 直接截获 DOM 点击。

后果：该横条覆盖的棋盘区域（约第 4~5 行、河界一带）在提示条可见期间（`NOTICE_DURATION_MS = 3000`）**点击完全失效**——与本文件 `:41-42` 自述的「**非阻塞**：…`pointerEvents="box-none"`，不拦截棋盘点击」以及 `:126` 那行注释**直接矛盾**。触发场景很常见：长将长捉规则提示、在线 AI 提示、联机通知出现时用户正好要点那条横线上的棋子或落点。

**修复建议**：给内层 `View style={styles.inner}` 也加 `pointerEvents="none"`（提示条本身不需要接受任何触摸）。这是 1 行修改。

#### 其余缺陷（P2）

| 编号 | 级别 | 位置 | 问题 | 修复建议 |
| --- | --- | --- | --- | --- |
| C-75 | P2 | `ChessBoard.tsx:458` | **最后一步起点标记把缩放因子乘了两次（scale 平方）**：`pieceSize`（`:274` = `Math.floor(boardStyle.pieceDiameter * scale)`）已是屏幕像素，`unitScale`（`:271` = `scale * (styleGridX / GRID_SPACING_X)`，classic 下 `unitScale === scale`）是无量纲比例，两者相乘 = `0.8 · 直径 · scale²`。390px 宽屏 `scale≈0.593` → `markerSize≈18.5px`，而设计意图是 `pieceSize*0.8≈31px`。该环 zIndex 2（`:1027-1032`）又画在棋子层（3/5）之下 → 「上一步从哪来」的提示在手机上基本不可见，屏幕越窄缩得越狠。同文件正确口径对照：`:432-436`/`:563` 是「原始像素 × unitScale」，`:610` 是 `Math.max(18, pieceSize * 0.6)`——**只有这一处混用两种口径** | 改为 `pieceSize * 0.8`；若确实要按样式网格归一化，应写 `boardStyle.pieceDiameter * unitScale * 0.8` |
| C-76 | P2 | `GameNotice.tsx:68-77`（关联 `:79-93`、`:95-106`） | **淡出回调不判断 `finished`，连续两条通知时新通知被旧回调清空**：`Animated.timing(...).start(() => { setVisible(false); onHide?.(); })` 的回调在动画被中途打断时（`finished === false`）**也会执行**。两个调用方的 `onHide` 都是「把通知 state 置 null」（`lanBattle/index.tsx:510`、`game/index.tsx:357`）。旧通知正在 200ms 淡出时来了新通知 → `:82` 的 `opacity.setValue(0)` 中断旧动画 → 旧回调把**新**通知置空 → 新提示条一闪即没。长将长捉「接近阈值→违规警告」连续触发、联机连续状态通知都能命中这 200ms 窗口 | `.start(({ finished }) => { if (!finished) return; setVisible(false); onHide?.(); })`，或在 `show()` 里先 `opacity.stopAnimation()` |
| C-77 | P2 | `ChessBoard.tsx:233` 与 `:895`（同款 `BoardEditor.tsx:34`） | **棋盘宽度用 `Dimensions.get('window')` 一次性取值，窗口尺寸变化不重排**：Web 端拖动浏览器窗口、Android 分屏/折叠屏切换后棋盘仍按旧宽度布局（`{width: screenWidth}`、`scale`、90 个交叉点坐标全停在旧值）→ 变窄时横向溢出、变宽时偏小。**更糟的是同一屏内 `JueShaOverlay.tsx:98` 与 `AppModal`（`:99`）用的是响应式 `useWindowDimensions()`**，它们会立刻按新尺寸重排而棋盘不会 → 结算文字/按钮锚点与棋盘错位。`onBoardLayout` 也救不了（它从 `boardRef` 量，同样受旧宽度制约） | 改用 `useWindowDimensions()`，并把 `:895` 的重复取值删掉、把已算好的 `screenWidth` 传给 `CapturedPiecesDrawer` |
| C-78 | P2 | `ChessBoard.tsx:324-344` 与 `:359-361` | **在 `setState` 更新函数内部启动动画并写 ref（副作用不纯 + 一个死分支）**：`setPieceAnims(prevAnims => { ... Animated.parallel([...]).start(); prevPositions.current.set(...) })`。更新函数必须是纯函数，而 React 会对同一更新函数调用两次（StrictMode 双调用、以及 eager-state 快速求值后在 render 阶段重放）→ 一次落子可能对同一对 `Animated.Value` 启动两遍 200ms 动画（第二遍打断第一遍），并在 render 阶段改写 ref。另外 `:359-361` 在 `setState` **之后同步**把 `isInitialLoad.current = false`，而更新函数通常在下一轮 render 才执行，届时它已是 `false` → `:339` 的 `else if (isInitialLoad.current)` 分支**在常规路径下不可达**（真正兜住"初始不播动画"的是"首帧必然没有 `prevPositions` 记录"这个巧合） | 把动画启动与 `prevPositions.current` 写入移到 effect 主体：先算出 to-animate 列表，再 `setPieceAnims(prev => 纯 map 合并)`，最后统一 `start()`；首帧直接 `setValue` 并删掉 `isInitialLoad` 分支 |

#### 其余缺陷（P3）

| 编号 | 级别 | 位置 | 问题 | 修复建议 |
| --- | --- | --- | --- | --- |
| C-79 | P3 | `Modal/AppDialog.tsx:67` | **只有确认键的对话框，Android 物理返回键会执行「确认」动作**：`onClose={hasCancel ? onCancel! : onConfirm}`，而 `AppModal` 用 `onRequestClose={handleRequestClose}`（`AppModal.tsx:102/169-174`）承接返回键。当前唯一无 `onCancel` 的调用方（`game/index.tsx:1450` 残局说明弹窗）的 `onConfirm` 仅关闭自己、良性，但 `AppDialog` 是通用组件，后续任何「删除/认输/退出房间」类单键确认弹窗都会踩坑 | 单键时把 `onClose` 设为空操作，或新增 `onDismiss` 供返回键专用 |
| C-80 | P3 | `Modal/AppModal.tsx:124-130` | Web 上**静默忽略 `dismissOnMaskPress`**：`if (Platform.OS === 'web') { Keyboard.dismiss(); return; }` 让 `:129` 永远到不了。全仓 grep 该 prop 只出现在 `AppModal.tsx:64/92/129/133` 与 `AppDialog.tsx:74`（硬编码 `false`），**目前无调用方传 true**，故是潜在契约缺陷而非现网 bug | 改为 `if (Platform.OS === 'web') Keyboard.dismiss(); if (dismissOnMaskPress) onClose();`，或注释里写明 Web 不支持 |
| C-81 | P3 | `Modal/ModalButton.tsx:100-102` | **secondary 变体按钮禁用时文字被强制白色**：样式数组把 `buttonTextDisabled: { color: '#FFFFFF' }` 排在 `buttonTextSecondary` 之后，而 `buttonDisabled` 只有 `opacity: 0.5`、secondary 背景是 `#F5F0E8` → 白字浅底半透明，基本看不见。现有 8 处 `variant="secondary"`（`endgameEdit:582/609`、`endgame:565`、`lanBattle:2913`、`AppDialog:86`、`lanGame:698/806/840`）都没同时传 `disabled`/`loading`，故是潜在缺陷 | 把 `isDisabled && styles.buttonTextDisabled` 放到样式数组最前让 variant 胜出，或按 variant 区分禁用色 |
| C-82 | P3 | `RoomSettingsControls.tsx:79` 与 `:82` | **用「label 文本全等」判定选中项，值为 0 的选项永远不高亮**：调用方对 0 值做了展示替换（`lanGame/index.tsx:771/780`、`lanBattle/index.tsx:2872/2881` 传 `baseTime === 0 ? '不限时' : ...`），而选项表里 0 的 label 是 `'关闭'`（`:40`/`:42`）→ pill 显示「不限时」、展开面板里「关闭」项没有选中态，用户无法确认当前值。`key={opt.value}` 正确说明作者本意就是按 value 判定 | 选中判定改为 `opt.value === value` |
| C-83 | P3 | `RoomSettingsControls.tsx:144-147` 与 `:184-187` | 下拉面板用**裸 `zIndex: 100 / elevation: 10`**，而同文件 `:173-174` 已把堆叠收敛到 token（`Z_INDEX.drawer`/`ELEVATION.drawer` = 50/50）。Android 上 `elevation` 是同一父容器内最主要的堆叠依据，面板 10、遮罩 50 相差一个数量级 → 先后次序只能靠巧合 | 改用 `Z_INDEX.drawer + 1` / `ELEVATION.drawer + 1`，或新增 selectPanel token |
| C-84 | P3 | `ChessBoard.tsx:404-406`（注释在 `:9`、`:800`） | 顶部注释声称已「消除 `pieces.find()` O(n²) 查找」，但点击路径的 `handleTouch` 仍每次线性 `find()`（最多 32 子，性能无害，但**注释与代码不符**）。另同文件 `.find()`（`:405`）与下标 `gameState.pieces[hintMove.pieceId]`（`:546`）两种访问风格并存（后者是引擎不变式，不是 bug） | 把注释限定为「渲染路径」，或让点击路径也复用反查表 |
| C-85 | P3 | `ChessBoard.tsx:11-14`、`:65-94` | **一批几何常量已成死导出，且注释声称被 `BoardEditor` 复用**：全仓 grep `ORIGINAL_IMAGE_WIDTH/HEIGHT`、`BOARD_WIDTH/HEIGHT`、`PIECE_LEFT/TOP`、`GRID_SPACING_X/Y` 只命中 `ChessBoard.tsx` 自身；`BoardEditor.tsx:18-19` 实际只 import `COLS, ROWS` 与 `boardStyles` 的 `gridSpacingX/Y`。且 `767×842`、左上 `(67,53)`、棋子区 `(110,96)-(650,704)` 与 `boardStyles.ts:47-55` 的 classic（`633×699`、`44/44/584/652`）**不一致**，是样式切换后遗留的陈旧注释 | 删除死导出与错误说明，或内联为私有常量 |
| C-86 | P3 | `ChessBoard.tsx:23` | 未使用的 import：`import { RED_SIDE, BLACK_SIDE } from '@/utils/chess/types';`（全文件 grep 只命中这一行） | 删除 |
| C-87 | P3 | `JueShaOverlay.tsx:58-59` | `CENTER_OFFSET_X/Y` 定义后**从未使用**（中心对齐已改由 `contentLeft/contentTop`（`:173-174`）基于 `boardCenterX/Y` 计算）；同区域 `GRID_WIDTH=631/GRID_HEIGHT=697`（`:24-25`）也已是旧口径 | 删除死常量并核实 `GRID_WIDTH/HEIGHT` 是否还有引用 |
| C-88 | P3 | `JueShaOverlay.tsx:163-165` | **未传 `boardFrame` 时的兜底几何硬编码旧样式 `631/842`**，与 `boardStyles` 三种样式（classic `633×699`、huali `891×981`、xuanmo `893×985`）都不匹配 → 切到 huali/xuanmo 时兜底定位会明显偏下。当前两个调用方（`game/index.tsx:1400/1418`、`lanBattle/index.tsx:2564`）都传了 `boardFrame`，所以这条分支**实际不可达**——属「留着就会咬人」的死分支 | 删掉兜底并把 `boardFrame` 设为必填，或用 `boardStyle.scaleBase*` 计算 |
| C-89 | P3 | `JueShaOverlay.tsx:107-154` | 动画 useEffect **没有清理函数**：`Animated.parallel([...])`（含 2.5s 延时）在卸载或 `visible` 转 false 时不会 `stop()`，继续驱动 6 个 `Animated.Value` 直到自然结束。因每次 `visible` 变真都 `setValue(0)` 重置，暂不会「重播/闪回」 | 存进变量并 `return () => animation.stop();` |
| C-90 | P3 | `BoardStyleModal.tsx:125-133` | `headerIcon` 样式定义后从未被任何 JSX 引用（假死样式，且内联了本应来自 token 的颜色 `rgba(139,105,20,0.12)`） | 删除，或补上 JSX 并换用 token |
| C-91 | P3 | `BoardStyleModal.tsx:22-29` 与 `RoomSettingsControls.tsx:11-19` | **各自复制了一份硬编码色板**，未使用 `client/constants/modal.ts` 已定义的同值 token（`modalPrimary:'#8B6914'`、`modalSecondaryBg:'#F5F0E8'`、`modalCard:'#FFF8F0'`、`modalText:'#3E2723'`、`modalTextLight:'#8D6E63'`、`modalBorder:'#D7CCC8'`），而该文件头部明确要求所有浮层统一消费它 → 改主题时必然漏改（本项目历史注释里已出现过同类漂移） | 两处改为 `import { COLORS } from '@/constants/modal'` |
| C-92 | P3 | `client/hooks/useMoveEffect.ts:42-52`（文档 `:8`、吃子分支 `:54-58`） | **将军处于 4s 冷却时会连带跳过同一步的吃子特效**：冷却期内 `isCheck` 为真直接 `return null`，后面的吃子分支不执行。而文件头文档写的是「吃子：每次吃子均播放」。于是「吃子且将军」的着法若落在上次将军特效的 4s 内，**一个特效都不播**；调用方还据返回值决定是否延时（`:36`），返回 null 会让延时与实际不符 | 冷却分支降级为吃子特效：`if (captured !== -1) {...; return 'capture'; } return null;` |
| C-93 | P3 | `BoardEditor.tsx:34-36` | **摆棋编辑器的棋盘缩放不参与高度预算，与对局页口径不一致**：`ChessBoard` 用 `Math.min(widthScale, maxBoardHeight / boardStyle.scaleBaseHeight)`（`ChessBoard.tsx:247-249`），编辑器只按宽度缩放 → 高度受限的页面上编辑器里的棋盘比同一门样式在对局页里更大，「摆好的局面」与「实际对局」视觉尺寸不一致并可能撑高容器。当前调用点（`endgameEdit/index.tsx:353-391`）外层是可滚动 `ScrollView`，故只是体验问题 | 让 `BoardEditor` 也接受/推导 `maxBoardHeight`（可复用 `capturedDrawerMetrics.ts` 的 `computeBoardLayoutBudget`） |
| C-94 | P3 | 多处 | **注释仍引用已废弃的服务端产物 `chinese-chess-server/dist/index.js` 行号**（本轮新增的实例）：`battleProtocol/types.ts:13-15,163,204`、`battleSocket.ts:49,106`、`aiDispatcher.ts:394`、`ruleEngine.bundle.ts:2,13`、`lanBattle/index.tsx:1491`、`ruleEngineParity.test.ts:9,109`。这些注释还会**暗示需要手工改产物** | 统一改指源码文件与函数名，或删掉行号 |

#### 棋盘与共享组件已被核对为**正确**的部分

- **坐标数学完全干净**：`ChessBoard.tsx:287-305` 生成 90 个交叉点、`:371-413` 反推最近点，使用同一套 `displayCol = isFlipped ? 8 - col : col` / `displayRow = isFlipped ? 9 - row : row` 变换，**行列顺序与黑方翻转均无 off-by-one**；阈值 `distance < pieceSize / scale`（`:393`）在边缘交叉点天然外扩半格 → 不会出现「点棋盘最外侧无效」；`maxBoardHeight` 为 0/undefined 时退回 `widthScale`（`:247-249`）→ **无除零、无首帧 NaN**。
- **`PieceItem` 的 `memo` 比较器**（`:109-193`）配合 `key={piece.id}` 与稳定 `onPress` 有效；`gameState.pieces[hintMove.pieceId]`（`:546`）与 `GameEngine` 全文件的 `state.pieces[pieceId]`（`GameEngine.ts:112,174,339,419,559,824`）口径一致，**id == 下标是引擎不变式，不是越界 bug**（与 §5.14 R-2 的 `-1` 情形不同，那是缺将导致的真越界）。
- **`validMoveElements`（`:416-445`）自身缺 `aiThinking` 守卫，但父级 `game/index.tsx:680` 已 `if (aiThinking || gameState.gameStatus !== 'playing') return;` 兜住** → 不计缺陷。
- **`CapturedPiecesDrawer` 在渲染期派发 state（`:859-865`）是 React 官方的 adjust-state-during-render 模式**，不是 render 期 setState 反模式。
- **`MoveEffectOverlay.tsx`**：`mountedSeqRef` 去重（`:99-155`）+ `return () => animation.stop();` 清理齐全、`pointerEvents="none"`、素材常驻 opacity 0 切换 → **未发现缺陷**。
- **`Modal/AppModal.tsx`**：`mask` 刻意不设 `elevation`、`card` 刻意不设 `overflow:'hidden'` 均有实测注释支撑；`blockBackButton`、`anchorCenter` 前提判断、`minHeight:0` 都正确。
- **`Modal/ModalButton.tsx`**：`isDisabled = disabled || loading` 正确传入 `TouchableOpacity disabled`（`:34/46-47`）→ **不存在「禁用仍触发 handler」**（仅 C-81 的颜色覆盖）。
- **`Screen.tsx`**：键盘监听 `return () => { s1.remove(); s2.remove(); };`（`:161`）清理正确；`isNodeScrollable` 递归检测（`:165-185`）确实存在「深层嵌套滚动容器不被加键盘 padding」的启发式局限（实例 `endgameEdit/index.tsx:353-391`），但外层 `wrapperStyle` 的 `paddingBottom: insets.bottom`（`:202-212`）仍兜住安全区 → **未构成可达缺陷**。
- **`HandicapBoard.tsx`**：`containerW > 0` 守卫 + `Math.abs(w - containerW) > 0.5` 阈值（`:41-46`）既避免首帧 NaN 又阻断 reflow 循环；`onPress={tappable && onToggle ? ... : undefined}`（`:70-107`）守卫完整。
- **`BoardEditor.tsx`**：`placements[col]?.[row] ?? -1`（`:90`）有可选链守卫，棋子层 `pointerEvents="none"`，触摸算法与 `ChessBoard` 同源且无除零（仅 C-93 的尺寸口径）。
- **`ColorSchemeUpdater.tsx` / `PrettyScrollbar.tsx` / `Provider.tsx` / `hooks/useBoardFrame.ts` / `hooks/useSafeRouter.ts`**：监听器注册与移除成对（`ColorSchemeUpdater.tsx:15-34`），`measure` 是 `useCallback(..., [])` 且只用 ref → 无闭包过期。
- **`utils/chess/{boardStyles,boardContentWidth,boardStyleStore,pieceImages,capturedDrawerMetrics}.ts`**：`boardContentWidth`（含 `if (!(screenWidth > 0)) return 0;`）与 `ChessBoard` 预算口径一致；`capturedDrawerMetrics` 的二分封顶（`BISECT_ITER=64`）与 `Number.isFinite(scale) && scale > 0 ? scale : 0.0001` 防除零完整；`boardStyleStore` 的 `useSyncExternalStore` + 一次性 `loaded` 守卫正确。
- **字号规范**：全 client 内联裸 `fontSize: <数字>` **仅 3 处**——`spectate/index.tsx:905`（18）、`lanBattle/index.tsx:3373`（18）、`lanBattle/index.tsx:3408`（26），三处旁均已注明是「表情等图形符号，字号随图形尺寸微调，不套用正文字阶」，属 `AGENTS.md` 明示例外。`ChessBoard.tsx` 内唯一 `FONT` 引用是 `capturedTitle: { fontSize: FONT.body }`（`:1093-1094`）。除 C-83/C-91 外，未发现其它应取自 token 的硬编码设计值。

### 6.10 补充审计：残局/复盘/存储、路由与主题（C-95 ~ C-123）

> 本节由 5 个补充审计子代理产出，规则与上同。其中 **`C-96`（摆棋编辑器丢先后手）与 `C-107`（复盘整库被空列表覆盖）为 P1**，其余为 P2/P3。`C-95` 与 `C-96` 同源（`validateEndgameFen` 的切分口径与引擎消费口径不一致），但 `C-95` 的实际症状是"黑先被静默丢弃"、不崩溃，故定 P2。

**【C-95 · P2】`validateEndgameFen` 用 `/\s+/` 切分、`createFromFen` 用 `' '` 切分 → 先后手被静默丢弃，且引擎侧的越界写成为"校验通过"路径上的潜在崩溃**
`client/utils/chess/endgames.ts:66`：`const parts = trimmed.split(/\s+/);`；消费方 `client/utils/chess/GameEngine.ts:609`：`const fenParts = fen.split(' ');`、`:640 const sideTag = fenParts[1] === 'b' ? BLACK_SIDE : RED_SIDE;`。
- **失败场景 A（已用 Node 最小复现证实，本条的主症状）**：棋盘段与先后手之间是 **Tab / NBSP / 换行，或只是多敲了一个空格**（`…2BAK4\tb`、`…2BAK4  b`）。校验侧 `/\s+/` 切出 `['…2BAK4','b']`，全部检查通过、导入成功；引擎侧 `split(' ')` 切不开 → `fenParts[1]` 是 `''` → **`sideTag` 恒为红，黑先被静默丢弃**。（三种分隔符实测输出一致：`{"sideTag":"RED"}`；单空格的对照组为 `{"sideTag":"BLACK"}`。）随后 `client/screens/game/index.tsx:118` 用**另一套口径** `currentEndgame!.fen.trim().split(/\s+/)[1] === 'b'` 判断先后手，于是界面显示「执红后手」（=AI 先手），而 `game/index.tsx:455-463` 的自动走棋读 `gameState.sideTag === aiSideTag` → **AI 永远不会先走，必须玩家自己先落子**：提示与实际先后手互相矛盾。
- **失败场景 B（同一根因，但触发条件更窄）**：引擎侧切不开时，棋盘段会连着分隔符与 `b` 一起进 `for (const c of boardStr)`——非 `'/'`、非数字的字符走 `:627-636` 的 `else` 分支，`indexOf(c) === -1` 时**仍然执行 `col++`**（`:636` 在 `if` 之外），于是列号会被推过 9，`qiPan[10][…]` 为 `undefined` → `TypeError`。**但注意**：`validateEndgameFen` 的 `:96 if (cells.length !== 9)` 保证了通过校验的棋盘段每行恰好 9 列，"某行超宽"无法从导入路径产生，因此这条崩溃只能由**不经过校验的入库路径**（见 §5.14 R-1 的 `isFenBoardWidthValid` 唯一调用点分析）或历史脏数据触发——所以它归入 R-1 的同一类，不单独计 P1。
- 修复：两端共用一次切分（`endgames.ts:66` 改 `trimmed.split(' ')`），或导入时先规范化 `trimmed.split(/\s+/).join(' ')` 再落库。

**【C-96 · P1】摆棋编辑器保存时丢掉 FEN 的 `w|b` 段，把「黑先」残局静默改成「红先」**
`client/screens/endgameEdit/index.tsx:270-285` 的 `buildFen()`（注释自述「仅棋盘部分，红方先行」）只逐行拼 `FEN_CHARS[id]` 与数字，**没有任何 `out += ' w' / ' b'` 分支**；`:306 const fen = buildFen();` 直接覆盖 `updateCustomEndgame` 的 fen。
- 失败场景：用户导入一个黑先残局（练防守），只想改名字 → 点铅笔进入编辑器（`client/screens/endgame/index.tsx:447-452` 会把 `fen: item.fen` 传进来）→ 保存 → `handleConfirmSave`(:300-321) 用不带 `b` 的串覆盖原记录。回到选关页再玩，先后手从黑先变成红先、本该 AI 先走变成自己先走，**全程无任何提示**。导入侧本来支持黑先（`endgame/index.tsx:552` 提示「末尾可附 w（红先，默认）或 b（黑先）」）。
- 修复：把 `params.fen` 的 `w|b` 段存进 state 并在 `buildFen()` 末尾拼回，或在编辑页显式提示"将丢弃先后手"。

**【C-97 · P3】`Screen` 组件对"含原生滚动子节点"的页面二次加安全区 padding，底部可能多出 `insets.bottom`**
`client/components/Screen.tsx:165-185` 的 `isNodeScrollable` 递归判定只看「子树里有没有滚动容器」、**不看「它是否自己已经处理了底部安全区」**；命中后 `:202-212` 的外层 `wrapperStyle` 加 `paddingBottom: keyboardShown ? 0 : insets.bottom`，而页面里的滚动容器往往又给自己的 `contentContainerStyle` 加了 `insets.bottom`。
- 影响：这类页面在带底部 Home Indicator / 手势条的设备上会在内容底部多出一条空白；**对"固定底栏"页面无影响**（底栏本就落在安全区内），表现为"同一个组件在不同页面效果不一致"。
- 备注：结论基于静态阅读（判定函数与两条 padding 路径均已逐行确认），但**是否真的可见取决于各页面的内容高度与是否自加 padding**，建议实机在刘海/手势条设备上比对一次再决定是否改。

**【C-98 · P2】`Text.defaultProps` / `TextInput.defaultProps` 在 React 19 已被移除，全局字号缩放是死代码**
`client/app/_layout.tsx:17-25`：
```tsx
// @ts-expect-error defaultProps 在运行时仍然有效
Text.defaultProps = Text.defaultProps || {};
// @ts-expect-error
Text.defaultProps.maxFontSizeMultiplier = 1.3;

// @ts-expect-error
TextInput.defaultProps = TextInput.defaultProps || {};
// @ts-expect-error
TextInput.defaultProps.maxFontSizeMultiplier = 1.3;
```
已用 Node/正则独立取证：`react@19.1.0` 的 `cjs/*.development.js` 与 `react-native@0.81.5` 的 `Libraries/Renderer/implementations/**` 中 **`resolveDefaultProps` 出现次数均为 0**（React 19 的标准实现就是"只读 `element.props`、不再合并 `defaultProps`"）。
- 影响：整段"运行时统一限制字号缩放"的意图**完全失效**（`Text` 与 `TextInput` 两处都是），系统字体放大时所有页面文字按系统比例放大，与 `:13-16` 注释宣称的行为不一致。代码上极具误导性——看起来处理了无障碍字号，其实没有；`@ts-expect-error` 掩盖的正是"属性已不被支持"这一信号。
- 修复：改用显式受控方案（`<Text maxFontSizeMultiplier={1.3}>` / 自建 `AppText` 包装），或删掉这段并改为在 `typography.ts` 注明策略。

**【C-99 · P2】`client/screens/demo/index.tsx` 是不可达的脚手架残留，且引用第三方 CDN**
731 B，`client/screens/` 下无任何 `app/` 路由指向它、`_layout.tsx:38-47` 的 10 个 `Stack.Screen` 里也没有，同时引用 `lf-coze-web-cdn.coze.cn` 的远端资源。**打包后仍会进入 bundle**。建议删除（见 §7.8【I-8】）。

**【C-100 · P3】`SoundManager` 的会话清理不完整（`loadingCache` 未被清空，可与 `unloadAllSounds` 竞态重建播放器），且随包携带约 115 KB 从未被播放的音频**
`client/utils/SoundManager.ts`：
```ts
export async function unloadAllSounds(): Promise<void> {
  // 会话代号自增：使仍在队列中的过期播放请求自行失效（不会重建音效对象）
  soundSessionId++;
  ...
  soundCache.clear();
  playQueues.clear();
  await Promise.all(promises);
}
```
- **问题 A（清理不完整 + 竞态）**：`unloadAllSounds()` 只清 `soundCache` 与 `playQueues`，**没有清 `loadingCache`**。若退出对局时某音效正在 `Audio.Sound.createAsync`（预加载 `:123-127` 或 `replayWithRecovery` 的重建路径 `:180`），其 `.then` 仍会在 `:106 soundCache.set(name, sound)` 把播放器放回刚被清空的缓存——`:65-66` 的注释正说这个泄漏是会话代号要防的事，但只在 `replayWithRecovery:150/162/172` 三处检查了 `sessionId`，`getOrLoadSound` 的加载完成回调没有检查。同时 `playQueues` 里正在执行的 task 会在 `:197` 之后仍被引用，而 `:235 playQueues.clear()` 清掉的是 Map 而非链上的 Promise，残留条目要等下一次同名播放才被覆盖。
- **问题 B（约 115 KB 死资源随包发布）**：`SOUND_FILES`(:42-53) 注册了 9 个音频，但全仓库搜索播放调用点后，**`select.mp3`(3385 B)、`goerror.mp3`(4341 B)、`alarm.mp3`(3456 B)、`Woman_jiangjun.wav`(103912 B) 四个从未被 `playSound` 调用**（调用点只有 `'eat'`/`'go'`/`'gamewin'`/`'gamelose'`/`Man_jiangjun`，见 `game/index.tsx:544-558/744-748/808`、`lanBattle/index.tsx:891-895/1499-1503/1719-1723`、`spectate/index.tsx:235-239`、`replayPlayer/index.tsx:189-193`），合计 115 094 B 约占 `assets/sounds/`（250 779 B）的 46%。
- 修复：`unloadAllSounds` 一并 `loadingCache.clear()` 并让 `getOrLoadSound` 的完成回调校验 `soundSessionId`；删除四个未使用音频（`stopSound`/`unloadSound` 这两个"兼容旧接口"的导出也可一并清理）。

**【C-101 · P3】`pveSetup` 的设置「没有任何持久化」，每次进入都回落默认值；而「继续对局」把难度经中文标签往返转换一次**
`client/screens/pveSetup/index.tsx:44-46`：`const [difficulty, setDifficulty] = useState<Difficulty>('medium'); const [playerSide, setPlayerSide] = useState<PlayerSide>('red'); const [firstMover, setFirstMover] = useState<FirstMover>('player');` —— 三个设置项只有组件内 state，页面内**没有任何读写全局设置/AysStorage 的代码**（`useFocusEffect`(:78-82) 只刷新存档信息），因此"上次选的难度/执黑/后手"在离开页面后就丢失，每次回来都显示入门/红方/先手。属体验层缺陷（不是"草稿态与已保存态不一致"，此前描述有误，已按实测改写）。
- **同一处的另一个具体缺陷（标签往返）**：`checkSavedGame`(:62-68) 把存档里的英文 key 转成中文标签存进 `savedGameInfo`（`{ easy: '入门', … }[save.difficulty] || save.difficulty`），`handleContinueGame`(:94-98) 再用反查表 `const diffMap: Record<string, string> = { '入门': 'easy', '进阶': 'medium', '大师': 'hard' };` 转回英文 key，失败即回落 `'medium'`：一旦 UI 文案改动（或本地化），**继续对局会静默按"进阶"难度恢复**，而存档信息行显示的是新文案、看起来一致。
- 修复：设置项落到与 `GameSave` 同级的持久化；`handleContinueGame` 直接传英文 key（让 `savedGameInfo` 保存 `difficulty` 的原始 key，展示时再映射成中文），去掉这次往返。

**【C-102 · P3】`game` 用 `as Difficulty` 断言吞掉非法规格，非法值静默降级为默认难度**
全仓库真类型断言只有两处：`client/screens/game/index.tsx:110` 与 `client/utils/chess/boardStyleStore.ts:39`。
```ts
// client/screens/game/index.tsx:110
const difficulty: Difficulty = isEndgame ? 'hard' : ((params.difficulty || 'medium') as Difficulty);
```
`params` 来自 `client/screens/pveSetup/index.tsx:85-89` 的 `router.push('/game', { difficulty, playerSide, firstMover })`，即 `params.difficulty` 的类型在编译期是 `string | undefined`。`as Difficulty` 让它在类型层面看起来已经校验过，运行期却是**任意字符串都会通过**：`'HARD'`、`'大师'`、被截断的 URL 载荷（`useSafeRouter` 解码失败时 `client/hooks/useSafeRouter.ts:144-152` 会回落到原生 query）都只会在下游查表时落空 → 静默用默认难度开局，且没有任何日志。
- `boardStyleStore.ts:39 currentId = stored as BoardStyleId;` **不是缺陷**：该文件在 `:30-40` 先做了白名单校验（`BOARD_STYLES.some(...)`) 才赋值，断言只是让 TS 收窄，行为正确（已核对，勿改）。
- 修复：写一个 `isDifficulty(v: unknown): v is Difficulty` 白名单函数，非法值走 `console.warn` + 默认值；`pveSetup` 起就不要再传裸 `string`。

**【C-103 · P3】返回行为的守卫口径不一致：仅 3 处做了 `canGoBack()` 判断，其余 11 处直接 `back()`；且只有 `lanBattle`/`game` 两个页面处理了系统返回键与离场确认**
`useSafeRouter`（`client/hooks/useSafeRouter.ts:128-134`）用 `...router` 透传了 expo-router 的全部成员，所以 `canGoBack()` 在所有页面都可用——问题不是"没有 API"，而是**用法不统一**：
- 做了守卫的只有 3 处：`client/screens/spectate/index.tsx:465`（`if (router.canGoBack()) router.back();`）、`client/screens/lanBattle/index.tsx:178-179`（同式）、`client/screens/game/index.tsx:1438-1442`（`canGoBack()` 分支走 `router.dismissAll()`，`else` 才 `router.replace('/')`）；
- **未做守卫**的有 11 处：`client/screens/lanGame/index.tsx:412`（程序化离房）、`client/screens/pveSetup/index.tsx:114`、`client/screens/endgame/index.tsx:252`、`client/screens/endgameEdit/index.tsx:320` 与 `:358`、`client/screens/replay/index.tsx:263`（`exitSelectMode` 的 `else` 分支）、`client/screens/replayPlayer/index.tsx:220` 与 `:266`、`client/screens/game/index.tsx:925`、`client/screens/game/index.tsx:964`、`client/screens/game/index.tsx:978`（另 `client/screens/game/index.tsx:1408` 的 `onGoHome` 同样直接 `back()`）。
- 深链/冷启动直接进入这些页面时 `canGoBack()` 为 `false`，此时 `back()` 在原生端是一次无人接收的 `GO_BACK`（表现为"点返回没反应"），在 Web 上则可能把 URL 上翻一级而不是回到应用内的上一层。
- **另一条更实质的口径差**：全仓库只有 `client/screens/lanBattle/index.tsx`（`usePreventRemove`(:2148) + `BackHandler`(:2253) + Web `popstate` 兜底(:2155-2159)）与 `client/screens/game/index.tsx:476`（`navigation.addListener('beforeRemove')`）处理了"系统返回键/侧滑返回"的二次确认；`endgameEdit`（有未保存的摆棋）、`lanGame`、`replayPlayer` 等页面均无任何拦截。`lanBattle:2155-2159` 的注释还专门记录了「浏览器后退不经过 `beforeRemove`、需要 `popstate` 兜底」这一坑，说明该结论已被团队验证过，但**没有推广到其它需要确认的页面**。
- 修复：把 `client/screens/game/index.tsx:1435-1443` 已经写对的那段（`canGoBack()` → `dismissAll()`，否则 `replace('/')`）抽成 `useSafeBack()` 并全量替换；再给有未保存状态的页面（`endgameEdit`）补 `usePreventRemove`。

**【C-104 · P3】难度中文标签在 5 处各写一份映射表，其中一处还维护了反查表**
同一组 `easy/medium/hard → 入门/进阶/大师` 的映射在全仓库出现 5 次：`client/screens/pveSetup/index.tsx:36-40`（`DIFFICULTY_OPTIONS` 内的 `label`）、`:62`（存档信息行）、`:94`（**反查表** `{ '入门': 'easy', … }`，供 C-101 的「继续对局」用）、`client/screens/game/index.tsx:240`（存档写入 `diffLabel`）、`:1108`（状态栏 `difficultyLabel`）、`client/screens/home/index.tsx:69`（首页存档卡片）。难度枚举本体在 `client/utils/chess/types.ts`（`EasyDifficulty = 'easy' | 'medium' | 'hard'`）与 `client/utils/chess/aiDispatcher.ts` 的 `ONLINE_DIFFICULTY` 表里**没有标签字段**，所以新增一档难度（例如 `'expert'`）时：类型检查全绿，而 `game/index.tsx:1108` 的 `difficultyLabel` 会是 `undefined`（它没有 `|| difficulty` 兜底，状态栏直接显示空白），`:240`/`home:69` 有 `||` 兜底则退化成英文 key。修复：在 `types.ts` 旁边放唯一的 `DIFFICULTY_LABEL: Record<Difficulty, string>` 与 `isDifficulty`，各处引用同一份。

**【C-105 · P3】`client/constants/` 只有 `modal.ts`，`client/theme/**` 目录不存在**
与 §1 的地图承诺不一致：颜色/尺寸 token 实际散落在各 `StyleSheet` 与 `boardStyles.ts` 里。属文档与实现漂移，非运行时缺陷（与 §8「设计 token 消费」一行同源）。

**【C-106 · P2】AI 走子返回 `null` 时界面没有 `else` 分支 → 对局停在「AI回合」，观感是卡死**
契约在 `client/utils/chess/aiDispatcher.ts:471-472`：`const offline = rejectMoverUnsafe(state, await offlineFallback()); if (!offline) return null;`，注释明写「宁可返回 null（**界面提示无可用着法**）也不把非法着法落进盘面」。
消费方 `client/screens/game/index.tsx:506-508`：
```ts
      // 计算返回时局面已被重置（重开/悔棋/翻转/退出）→ 丢弃结果
      if (gameGenRef.current !== gen) return;

      if (aiMove) {
```
**没有 `else`**；`finally`(:618) 只把 `aiThinking` 复位。
- 失败场景：`AIEngine.searchWithTimeBudget` 仅在"走棋方没有任何王安全着法"时落空（`client/utils/chess/AIEngine.ts:1121 if (moves.length === 0) return null;`，及根节点逐着 `isSideInCheck` 过滤后 `:1401-1421` 的兜底也挑不出着法），于是走到 `:472 return null`。局面仍停在"走棋方=AI"：玩家点自己的子会在 `game/index.tsx:654 if (!isPlayerPiece) return;` 被静默丢弃，状态栏继续显示「AI回合」(:1207)，**没有任何提示**，只能悔棋/重开/退出。触发前提是"无合法着法但 `gameStatus` 仍为 `playing`"的病态局面（如恢复了一份局面与 `gameStatus` 不同步的存档）。
- 修复：补 `else` 分支，用现有 `showRuleNotice` 提示「无可用着法」并给出重开/悔棋入口。

**【C-107 · P1】复盘存储把「读取失败」当成「空历史」并永久缓存，下一次自动保存会用空列表覆盖真实存储（不可恢复的整库丢失）**
`client/utils/replayStorage.ts:42 if (cache) return cache;` 与 `:55-60`：
```ts
  } catch {
    list = [];
  }
  // 统一按时间倒序
  list.sort((a, b) => b.timestamp - a.timestamp);
  cache = list;
  return list;
```
- 失败场景：`AsyncStorage.getItem` 抛错（磁盘满、底层 SQLite 异常）或 `JSON.parse` 抛错（最典型是上次写盘被系统杀进程截断）、或该键下存的不是数组 / 记录被解析成不含 `id`·`moves` 的形态（未来格式变更、部分写入）时，异常分支把结果置 `[]` 并**写进 `cache`**——而 `:42` 的 `if (cache)` 对空数组同样为真，**此后所有 `readAll()` 永远返回这个空列表**。于是 ① 复盘列表页在整个进程生命周期内都显示"暂无棋谱"（不会重读存储）；② 更严重的是，用户之后任意一次写入——收藏一次（`toggleFavorite` → `writeAll`）、删除一次（`deleteReplays` → `writeAll`）、或再打完一局（`game/index.tsx:244` 的 `saveReplay` → `replayStorage.ts:87 const list = await readAll();` 拿到空数组 → `:93 list.unshift(game);`）——都会执行 `AsyncStorage.setItem(KEY_REPLAYS, JSON.stringify([...]))`，把原有**最多 200 条棋谱永久覆盖**（写入路径 `:106` 无备份、无确认、无二次确认）。界面全程无提示，且因内存缓存已是空数组，连回退到旧数据的机会都没有。
- 定级说明：后果是不可恢复的整库数据丢失（P0 级后果），但需先发生一次读取/解析失败，不在常规路径上，故记 **P1**；若团队口径是"任何不可恢复的数据丢失都算 P0"，本条应上调。
- 修复：用 `cache: ReplayGame[] | null` 的 `null` 语义区分「未加载/加载失败」与「确实为空」，读取/解析失败时标记为 `failed` 并让 `writeAll` 在 `failed` 状态下**拒绝写入**（或先把 `raw` 原文备份到 `replay_games_v1.bak` 再继续）。

**【C-108 · P3】熔断冷却后的「半开探测」打成"冷启动探测"：条件与语义双错，且探测本身会白等一次 2 s 超时**
`client/utils/chess/aiDispatcher.ts:186-195`：
```ts
  // 半开：曾熔断且冷却刚结束 → 主动探测恢复
  if (everSucceeded === false && consecutiveFailures > 0) {
    const healthy = await probeServerHealth();
    if (!healthy) {
      // 探测未通过则继续熔断（不要每次走子都白等一次探测）
      circuitOpenUntil = now + CIRCUIT_COOLDOWN_MS;
      return false;
    }
    recordOnlineSuccess();
  }
```
- **两个问题叠加**：① 注释写"曾熔断"，代码判的是 `everSucceeded === false`（**从未成功过**）——语义完全相反；② `recordOnlineFailure()`(:205-213) 打开熔断时会把 `consecutiveFailures` 清零（`:209`），所以"冷却刚结束"这一分支的第二个合取条件对任何人都为假……但 `everSucceeded === false && consecutiveFailures > 0` 在**从未成功过的冷启动客户端**上仍可能成立（走子失败后 `consecutiveFailures` 尚未达到阈值 2 的中间态）。
- 失败场景 A（多数客户端）：曾经成功过在线 AI 的客户端两次超时 → 熔断 30 s → 冷却结束后 `everSucceeded === true` **直接跳过探测**、发真实走子请求；该请求又要连续失败 2 次才重新熔断 → 服务**已经完全恢复**的情况下仍会白等一次 2 s 超时（`ONLINE_TIMEOUT_MS`），随后才由 `scheduleReconnect` 定时器(:233-255) 救回。
- 失败场景 B（冷启动客户端，方向相反的坏处）：从未成功过且已有 1 次失败时，冷却刚结束就**先做一次 `probeServerHealth()`**；若服务仍未恢复，探测本身要等一次网络超时，然后 `return false` → 用户看到"重连中"却比直接试走子更慢。
- 修复：新增显式 `halfOpenProbeNeeded` 标志，在 `recordOnlineFailure()` 打开熔断时置位，探测成功/熔断解除时清除；不要在 `isOnlineAllowed()` 里用"是否成功过"代替"是否刚熔断过"。

**【C-109 · P3】定时器恢复路径漏清 `lastInvalidMoveReason` → 恢复后角标仍显示「在线走法异常」**
`client/utils/chess/aiDispatcher.ts:243-253` 手工复位 `circuitOpenUntil / consecutiveFailures / everSucceeded`，但不像 `recordOnlineSuccess()`(:215-223，含 `:220 lastInvalidMoveReason = null;`) 那样清空诊断原因。
- 失败场景：在线走法被本地守卫拒收一次（记下原因）→ 两次网络故障熔断 → 30 s 后定时器探测成功、在线 AI 实际已恢复，但 `getOnlineAiStatus()`(:591) 仍因 `lastInvalidMoveReason !== null` 返回 `invalid_move`，界面继续挂「在线走法异常」，直到下一次在线走子成功。**与已报告的「状态判定次序使 invalid_move 粘滞」不是同一处**（修复位置不同）。
- 修复：`healthy` 分支直接调 `recordOnlineSuccess()`。

**【C-110 · P3】复盘写入先改内存缓存、再落盘，且静默吞掉失败**
`client/utils/replayStorage.ts:64-72`：
```ts
async function writeAll(list: ReplayGame[]): Promise<void> {
  list.sort((a, b) => b.timestamp - a.timestamp);
  cache = list;
  try {
    await AsyncStorage.setItem(KEY_REPLAYS, JSON.stringify(list));
  } catch {
    // 写入失败时仅保留内存值
  }
}
```
写入失败（磁盘满、存储被回收、序列化超限）时异常被吞且 `cache` 已指向新列表 → 本次会话里"保存成功"，磁盘仍是旧数据，重启后新复盘与收藏切换全部消失（调用方 `game/index.tsx:253` 也只有 `.catch(() => undefined)`）。修复：失败时回滚 `cache` 并把失败透出给调用方。

**【C-111 · P3】「提示」在无解/被拒时静默 `return`，用户点击后没有任何反馈**
`client/screens/game/index.tsx:1085-1096`：`if (reqId !== hintReqRef.current) return;`、`if (!best) return;`、`if (!isMoveKingSafe(gameState, best.pieceId, best.toCol, best.toRow)) return;` 三条路径都无提示。而同段 `:1090-1095` 的注释明确记录该病态局面**实测会发生**（历史里含送将着法时服务端皮卡鱼会返回对方的着法）。玩家点「提示」只看到 loading 转一圈后什么都没有（不消耗次数、无文案），与"引擎算不出"无法区分。修复：`return` 前用 `showRuleNotice(...)` 给出原因。

**【C-112 · P3】`loadCustomEndgames` 只判数组类型、不校验元素结构（与同项目校验风格不一致）**
`client/utils/EndgameProgress.ts:183-193` 仅 `if (Array.isArray(list)) return list;`；同文件 `loadEndgameBattle`(:157-165) 却会逐项校验 32 个棋子字段。若该 key 被外部工具或历史版本写成 `[{id:...}]`（缺 `fen`），列表页仍能渲染，直到点进该残局才在 `GameEngine.createFromFen`（`client/utils/chess/GameEngine.ts:609`）抛 `TypeError` 崩溃。正常 UI 路径有 `validateEndgameFen` 把关（`client/screens/endgameEdit/index.tsx:289`），故属防御性技术债。修复：按 `loadEndgameBattle` 口径过滤并回写清理。

**【C-113 · P3】`addCustomEndgame` / `updateCustomEndgame` 吞掉写入失败，界面一律报「保存成功」**
`client/utils/EndgameProgress.ts:196-225` 内部 `catch (e) { console.error('保存自定义残局失败:', e); }`（add 吞掉后**仍返回 entry**；update 返回 `false`），异常永远传不到调用方 —— `client/screens/endgameEdit/index.tsx:308-317` 的 `try/catch { setSaveError('保存失败，请重试'); }` 实际是**死代码**，且 update 的布尔返回值从不被检查。
- 失败场景：存储写满/被拒时用户摆完棋点保存 → 编辑器仍执行 `markPendingFocusCustomTab(); setSaveVisible(false); router.back();` 返回选关页并切到「自定义」标签，但列表里没有这条残局（编辑场景则是内容其实没改）。**用户以为已保存，摆的棋全丢**。
- 修复：让 add/update 把失败向上抛，失败时保留弹窗并提示重试。

**【C-114 · P3】编辑已有残局时 FEN 解析失败静默退化为空棋盘，用户可能把原残局覆盖成另一局面**
`client/screens/endgameEdit/index.tsx:104-114`：
```ts
  const [placements, setPlacements] = useState<Placements>(() => {
    if (params.fen) {
      try {
        return createFromFen(params.fen).qiPan;
      } catch {
        return emptyBoard();
      }
    }
    return emptyBoard();
  });
```
编辑一条引擎解析不了的残局（如 C-95 那种带 Tab/NBSP 的记录，或任何历史/损坏数据）时，用户看到一张**空棋盘**、无错误提示；按正常流程重摆或只改名字保存 → `handleConfirmSave` 覆盖该记录 fen，原局面永久丢失（保存路径不会再读回 `params.fen`）。修复：`catch` 里 `setBoardError('原残局局面解析失败，请重新导入')` 并在解析失败时禁用保存。

**【C-115 · P2】复盘播放页对存档着法零校验：一条损坏记录让该页在渲染期抛 `TypeError`，且页面内无法自愈**
`client/utils/replayStorage.ts:49-52` 的过滤只校验 `Array.isArray(g.moves)`，**元素本身零校验**（与 `client/utils/GameSave.ts` 的 `isValidGameSave` 严格校验形成鲜明对比）；`client/screens/replayPlayer/index.tsx:53-68` 的 `buildSteps` 直接把每条着法喂给引擎：
```ts
  for (const m of replay.moves) {
    // makeMove 返回深拷贝后的新状态，不修改传入状态，链式应用安全
    state = makeMove(state, m.pieceId, m.toCol, m.toRow).newState;
    steps.push(state);
  }
```
- 失败场景：`moves` 里出现 `null` / 缺字段 / 越界值（部分写入的存档、手工改过的数据、字段改名后回滚版本）时，用户在列表点开这一条 → `buildSteps` 在 `useMemo`(`:112`) 内执行 → `m.pieceId` 抛 `TypeError: Cannot read property 'pieceId' of null`；若结构合法但越界，则在 `client/utils/chess/GameEngine.ts:419-420` 的 `piece.col` 或 `:422` 的 `qiPan[toCol][toRow]` 抛 `TypeError`。**因为发生在渲染期，整页被红屏接管，每次点开都必炸**，播放页内没有自愈入口，只能回列表长按删除。
- 修复：`buildSteps` 前对每条 `MoveRecord` 做与 `GameSave.isValidGameSave` 同级的校验（`pieceId` 0..31 整数、`fromCol/toCol` 0..8、`fromRow/toRow` 0..9 整数、`capturedPieceId` -1..31），非法即判为「棋谱已损坏」并显示可返回的空态。

**【C-116 · P2】复盘播放页使用模块级 `Dimensions.get('window')`：旋转/改窗口后预算仍按旧视口算，棋盘与控件、抽屉尺寸不同源**
`client/screens/replayPlayer/index.tsx:47-51`：
```ts
const screenWidth = Dimensions.get('window').width;
// 窗口高度：用于把棋盘宿主实测高度封顶到视口内，打断宽屏纵向溢出的正反馈
const windowHeight = Dimensions.get('window').height;
// 与人机对战一致：棋盘与下方控制区的间距随屏宽自适应
const dynamicGap = Math.max(Math.round(screenWidth * 0.03), 8);
```
- 失败场景：这三个值在模块求值时取一次、**永不更新**。旋转屏幕或（Web/平板分屏）改变窗口尺寸后，`boardArea` 的 `onLayout` 会重渲染、`ChessBoard.tsx:233` 与 `CapturedPiecesDrawer`（`ChessBoard.tsx:895`）拿到**新**宽度重算棋盘/抽屉，而本页传给 `useBoardLayoutBudget` 的 `screenWidth`、`boardAlignedRowStyle(screenWidth, ...)`（控件行宽度）、`capHostHeightToViewport(..., windowHeight, ...)`（高度封顶）**全是旧视口**。结果：变窄后控件行宽大于实际屏幕、棋盘按旧宽预算溢出到屏幕外（右侧列不可见/被裁切）；变高变矮后 `maxBoardHeight` 与真实可用高度不符，底部进度条与「上一步/下一步」可能被挤出视口点不到。
- 修复：改用 `const { width: screenWidth, height: windowHeight } = useWindowDimensions();`（项目里 `client/screens/endgame/index.tsx:75`、`components/Modal/AppModal.tsx:99`、`components/JueShaOverlay.tsx:98` 已是这个写法），`dynamicGap` 改为随 `screenWidth` 的 `useMemo`。**与 §6.9 的 C-77 同源**。

**【C-117 · P3】`buildSteps` 是 O(n²) 深拷贝且把全部局面常驻内存**
`client/screens/replayPlayer/index.tsx:54-68`、`:112 const steps = useMemo(() => (replay ? buildSteps(replay) : []), [replay]);`。`makeMove` 每步内部 `cloneGameState` 深拷贝（`qiPan` 9×10 + 32 子 + `moveHistory` + `ruleState`）并跑一次完整规则评估（`isJiangJun`/`isJueSha`/`isKunBi`/`evaluateRuleAfterMove`）；`buildSteps` 从第 i 步局面重新应用 i 步得到第 i+1 步，总拷贝量 ~n²/2，并保留 n+1 个完整局面对象（每个还含长度 i 的 `moveHistory`）。打开一条 200~300 步的长对局，首帧要做几万次深拷贝、常驻几十 MB；注释已注明这是「用空间换拖动流畅」的有意取舍，但代价随步数平方增长。修复：只缓存当前步局面，`setStep` 时从最近已算步增量推进。

**【C-118 · P3】复盘列表 `FlatList` 缺 `extraData`，卡片选中态刷新依赖"`renderItem` 每次都是新引用"**
`client/screens/replay/index.tsx:341-346`：`<FlatList data={filtered} keyExtractor={item => item.id} renderItem={renderCard} … />`。卡片是否显示勾选圈只由闭包里的 `selectMode`/`selectedIds` 决定，而 `VirtualizedList` 是 `PureComponent`、`data`（`filtered`）不变时会跳过 item 重渲染。**当前之所以正常，是因为 `renderCard` 定义在组件体内、每次渲染都是新函数**——一旦有人把它用 `useCallback` 包起来（很自然的优化，文件里 `reload` 已经这么做了），长按进入多选、勾选/取消、全选后卡片就不刷新。修复：补 `extraData={[selectedIds, selectMode]}`。

**【C-119 · P3】复盘列表的时间筛选基准 `nowTs` 只在 focus 时刷新，跨零点或长时间停留会过期**
`client/screens/replay/index.tsx:58-67`（`matchTimeFilter`）与 `:104-115`（`const reload = useCallback(async () => { setNowTs(Date.now()); …`）。`nowTs` 只在 `useFocusEffect` 触发时更新：前一夜把 App 停在复盘列表页（或次日回到前台但路由焦点事件未再触发）时，筛「今天」会把昨天 23:00 的对局算作今天、筛「近 7 天 / 近 30 天」的边界整体偏一天，`formatTime` 对「昨天的对局」也仍按 `HH:MM` 显示（`:75-77` 判定为今天）。首帧 `nowTs === 0` 时 `filtered` 靠 `now === 0 ||` 逃生显示全部，属同一处「基准时间未就绪」的补丁。修复：`AppState` 回到 `active` 时或用按分钟对齐的定时器刷新（并在卸载时清理）。

**【C-120 · P3】`MAX_REPLAYS` 容量控制对「全部收藏」的列表完全失效，列表可无上限增长**
`client/utils/replayStorage.ts:95-104`：`if (list.length > MAX_REPLAYS) { let excess = list.length - MAX_REPLAYS; for (let i = list.length - 1; i >= 0 && excess > 0; i--) { if (!list[i].favorite) { list.splice(i, 1); excess--; } } }`。当库里 200 条**全部**被标记为收藏（`favorite` 只能由用户逐条打星累积）时，`excess` 在循环里永不自减，`list.length` 直接突破 200 且此后每条新对局都继续追加，`writeAll` 每次都把整个数组 `JSON.stringify` 落盘；列表页没有任何「容量已满」提示。数组大到超出 AsyncStorage 单值上限时即退化为 **C-110 的静默写失败**（用户看到「对局保存了、重启后没了」）。修复：全收藏时仍淘汰最旧一条，或返回失败并在列表页提示「请先取消部分收藏」，同时展示已用容量 `n/200`。

**【C-121 · P3】`listReplays` 返回模块缓存本体，页面 state 与存储层共享同一个数组对象**
`client/utils/replayStorage.ts:42 if (cache) return cache;` 与 `:66 cache = list;`，调用点 `client/screens/replay/index.tsx:104-108 const list = await listReplays(); setGames(list);`。`listReplays()` 返回的是模块级 `cache` **本身而非副本**，`setGames` 让 React state 与存储层指向同一数组；`saveReplay` 会对它 `list.unshift(game)`、`toggleFavorite` 会原地改元素。当前看不出问题（列表页每次 focus 先 `setNowTs` 强制重渲染、`handleToggleFavorite` 用 `{...g}` 造了新数组），一旦去掉 `setNowTs`，或存储层在页面挂载期间被另一页写入（同一数组原地变异但引用不变），`setGames` 会因 `Object.is` 相同**跳过更新**、界面停在旧内容。这也正是 `:111-115 useFocusEffect` 缺取消/代数守卫却侥幸无害的原因（旧结果与新结果本来就是同一引用）。修复：存储层对外返回 `[...cache]`。

**【C-122 · P3】被吃抽屉因"该步无被吃子"直接 `return null` 时不复位状态：后续再出现时无展开动画**
`client/components/ChessBoard.tsx:907-908`（配合 `:868-876` 的动画 effect 与 `client/screens/replayPlayer/index.tsx:250-257` 的 `capturedDrawerSide`）：
```ts
  // 未展开（且收起动画已结束）或该方暂无棋子时不渲染（自动收起，避免空卡片）
  if (!renderedSide || ids.length === 0) return null;
```
用户展开被吃抽屉后把滑块拖回开局（或拖回尚未发生吃子的步数）：该分支直接 `return null`，`renderedSide` 仍为 `'opponent'`、父页 `capturedDrawerSide` 也仍为 `'opponent'`、`anim` 停在 1；再往后拖到有吃子的步数时，抽屉**毫无 160 ms 展开过渡地整块蹦出**（正常展开是 opacity + translateY 动画），视觉上像渲染抖动，且父页状态与"抽屉已收起"这一事实不一致。修复：`ids.length === 0` 时走收起分支，或父页监听被吃集合清空时复位 `capturedDrawerSide`。

**【C-123 · P3】首页存档状态可能"显示有存档 + 展示上一次的旧信息"；闯关进度分母口径不一致**
`client/screens/home/index.tsx:63-90`：
```tsx
  const checkSavedGame = async () => {
    const exists = await hasSave();
    setHasSavedGame(exists);
    if (exists) {
      const save = await loadGame();
      if (save) { … setSavedGameInfo({ … }); }
    }
  };
  useFocusEffect(useCallback(() => {
    checkSavedGame();
    loadProgress().then(p => setEndgamePassed(p.completed.length));
    preloadChessAssets();
  }, []));
```
- ① `hasSave()`（`:64`）为真但 `loadGame()`（`:67`）返回 `null` 时，只 `setHasSavedGame(true)`（`:65`），**不把 `savedGameInfo` 清空**——`GameSave.loadGame` 在校验失败时会**静默清档并返回 null**（`client/utils/GameSave.ts:75-92`），所以这条路径真实存在：入口卡片会显示"有未完成的棋局 · 点击进入"（`:140`）配上**上一次**的难度/手数/时间（`:139-141`），且真正点进去没有棋局。修复：`else` 分支补 `setSavedGameInfo(null)`。
- ② `loadProgress()`（`:86`）**没有 `.catch`**：`AsyncStorage` 抛错时产生未处理 rejection（红屏/告警），且 `endgamePassed` 永远停在 0。
- ③ 闯关进度分母口径不一致：`:158` 渲染 `已通过 {endgamePassed}/{BUILTIN_ENDGAMES.length} 关`，分子来自 `loadProgress().completed.length`——而 `completed` **同时包含自定义残局**（`client/utils/EndgameProgress.ts` 的自定义关卡通过后也写进去），分母 `BUILTIN_ENDGAMES.length = 30` 只算内置关 → 通关自定义残局后会显示 `31/30`。修复：分子用 `completed.filter(id => 内置集合.has(id)).length`，或分母改用"内置 + 自定义"总数。
- （先记一笔以便后续排期，优先级低于 C-104）难度标签 `easy/medium/hard → 入门/进阶/大师` 在首页 `:69` 又是**第 6 处**内联副本。

> 同页 `pushOnce`(`:53-61`) 的 800 ms 硬编码节流（`navLockAtRef`）经复核**方向正确**：它拦的是"同一路由短时间重复入栈"，重新聚焦首页时 `useFocusEffect` 不会重置该锁——即从对局页返回后 800 ms 内再点入口卡片会被静默忽略，属可感知但极短的卡顿，不单独成条。
> `preloadChessAssets()`(`:88`) 复核为**幂等且无泄漏**：`client/utils/preloadAssets.ts:21/37-39` 有 `let preloaded = false` + `if (preloaded) return;`，`:23-34` 的 `Image.prefetch(...).catch(() => {})` 与 `try/catch` 兜底到位。唯一可议之处是首页不 await 它的返回（该函数返回 `void`、不阻塞绘制），无实际后果。

**同批补充审计中被核对为正确的部分（不重复报告）**
- `validateEndgameFen` 的白名单与规则本体正确：`ADVISOR_POINTS` 红 `a=['0,3','0,5','1,4','2,3','2,5']` / 黑 `A=['7,3','7,5','8,4','9,3','9,5']`，`ELEPHANT_POINTS` 红 `b=['0,2','0,6','2,0','2,4','2,8','4,2','4,6']` / 黑 `B=['5,2','5,6','7,0','7,4','7,8','9,2','9,6']`，与「象走田」七点逐点一致；九宫限制、飞将、兵卒不得在本方底线、每类子力上限（合计恰好 32 枚）、数字展开与每行 9 列校验均正确（**唯一问题是 C-95 的分隔符口径**）。
- `BoardEditor.tsx` 与 `ChessBoard.tsx` 同源：`:130-131 onStartShouldSetResponder` + `onResponderRelease` 与 `ChessBoard.tsx:748-749` 逐字一致；棋子层 `pointerEvents="none"`（`:86-116`），不存在"棋子吞点击"；最近交叉点阈值 `pieceSize / scale`（原图 66px）介于 `gridSpacingX=67.5` 与 `gridSpacingY≈67.56` 之间，不会跨格误判；`:151-161` 棋子底盘与 `ChessBoard.tsx:985-997` 一致；`:30 useBoardStyle()` 使三套样式与对局页同步。
- `HandicapBoard.tsx` 几何与语义正确：宽度取自 `onLayout`（`:45 if (w > 0 && Math.abs(w - containerW) > 0.5) setContainerW(w);`），旋转/分屏后重算；`CROP_TOP = ROW6_Y - SY*0.8` / `CROP_HEIGHT = imgHeight - CROP_TOP` 与 classic 常量（`pieceTop 44`、`pieceBottom 652`、`imgHeight 699`）逐点核对成立（row6 中心距裁剪顶 54px、row9 中心距底 47px）；17 个 id 无重复，可点集合只含红方 21-31（**仕/相/帅不参与让子**，与 `GameEngine.ts:70-85 applyHandicap` 只清红方棋子一致，`lanBattle/index.tsx:2897-2906` 文案亦写明「红方让子先行」）。
- `endgameEdit` 资源处理规范：`hintTimer / clearTimer / copyTimer` 三个定时器在卸载时全部 `clearTimeout`（`:157-161`）；抽屉 `Animated.start` 判了 `finished` 才 `setRenderedDrawerSide(null)`（`:151-153`）；`:143-145` 渲染期 setState 是 React 官方模式；`:618-826` 全部字号取 `FONT.*`，唯一动态字号 `paletteBadgeFont` 随棋盘尺寸等比缩放且在 `:491-496` 注明理由。
- 保存弹窗期间无法改棋盘（`AppModal` 用 RN `<Modal transparent animationType="fade" statusBarTranslucent>`，`components/Modal/AppModal.tsx:169-186`，渲染在独立原生窗口），因此 `handleConfirmSave` 不重新校验 `buildFen()` 是安全的；空盘也会被 `:288-297` 的 `validateEndgameFen` 拦下并常驻红条提示。
- `capturedDrawerMetrics.computeBoardLayoutBudget`（`:124-184`）与 `useBoardLayoutBudget`（`:189-200`）无缺陷：`fits()` 随 `boardSize` 单调递减，二分 64 次的收敛与不变式成立；缩放口径与 `ChessBoard.tsx:233-249` 一致。**该模块未被 `BoardEditor` / `endgameEdit` 引用**（调用方是 `game/index.tsx:370`、`spectate/index.tsx:155`、`replayPlayer/index.tsx:148`、`lanBattle/index.tsx:328`）。
- 自定义残局 ID `custom_${Date.now()}_${Math.floor(Math.random() * 100000)}`（`client/utils/EndgameProgress.ts:196-210`）碰撞概率可忽略；`deleteCustomEndgame` 同时清理 `customBestUndoUsed`；`useSafeSearchParams` 同步解码（`client/hooks/useSafeRouter.ts:144-152`），`endgameEdit` 的 `useState` 初始化器能同步读到 `params.fen`，无首帧空参数竞态。
- 客户端 `utils/` 侧（13 个文件深审）**未发现 P0/P1**：`boardContentWidth.ts`（含 `if (!(screenWidth > 0)) return 0;` 与 `boardAlignedRowStyle` 的满屏兜底）与 `ChessBoard.tsx:236/246-249` 完全同口径；`boardStyleStore.ts` 的 `useSyncExternalStore(subscribe, getSnapshot, getSnapshot)` 三参数齐备、`setBoardStyleId` 先校验再 emit；`boardStyles.ts` 三套棋盘的 `(pieceRight-pieceLeft)/8`、`(pieceBottom-pieceTop)/9` 与 `pieceDiameter` 比例均为 0.97~0.98（classic 66/67.5、huali 92/94.7、xuanmo 92/94.3），三套一致且素材齐备（`assets/boards/` 6 张、`assets/pieces/` 14 张）；`pieceImages.ts` 覆盖 0..31 且与 `types.ts:26 QIZI_INIT_POSITION` 顺序一致、越界返回 null；`typography.ts` 的 `FONT` 十档与 `AGENTS.md` 字阶表逐项一致；`types.ts` 的 `BOARD_COLS=9`/`BOARD_ROWS=10` 与 `qiPan[col][row]` 列优先约定一致。
- `onlineAI.ts`：计时器在函数入口启动（把地址读取算进总预算，`:134-135`）；AbortError 用 `cancelledExternally` 归因，**外部取消不计熔断、计时器超时计熔断**（`:186-193`）；`finally`(`:199-202`) 同时清计时器与监听；429→busy 与"非 JSON 响应经 `response.json()` 抛错→归 `OnlineAiNetworkError`"的分类合理。
- `AIEngine.ts`：`activeSearch` 在正常结束(`:1424`)与立即取胜早退(`:1176`)都复位；分片循环 `gen.next()/yield` 的 `finally` 先 `gen.return(0)` 再 `unapplyMove`（`:1295-1301`）；`killerMoves` 每次搜索前重置（`:1139-1141`）。
- `GameEngine.ts` FEN/历史构建段：`toFenString`(`:658`) 行主序与仓库 FEN 约定一致；`toUci`(`:721`) 的 `a..i` + `9-row` 自洽；`buildEngineHistory`(`:751`) 回退不自洽时返回 null（宁可不带历史）；`buildReplayableSegment`(`:798`) 取"最后一段可重放后缀"（`:823` 的 `break` 只在 broken 分支），与服务端 Pikafish 拒绝重放送将着法的已知行为吻合。
- `aiDispatcher.ts` 守卫链完整：`requestOnlineMove`(`:358-381`) 依次做归属方/回合 → 落点形状 → 王安全 → 规则安全四道校验，`runHybrid`(`:427-431`) 与 `rejectMoverUnsafe`(`:471`) 各再断言一次；`subscribeOnlineAiStatus`(`:280-285`) 返回取消订阅且回调有 try/catch。
- `replayStorage.ts` 除 C-107/C-110 外语义正确：`saveReplay` 容量淘汰只从尾部剔未收藏项(`:96-104`)，`toggleFavorite`/`deleteReplays` 均保护收藏项(`:111-130`)；id 碰撞概率足够低。`GameSave.ts` 的 `resolveFirstMover`(`:32-37`) 兼容旧存档、`loadGame`(`:75-92`) 校验失败即清档。
- `Screen.tsx` 除 C-97 外：键盘监听 `return () => { s1.remove(); s2.remove(); };`(`:161`) 清理正确。
- **路由与页面对照（10 个转发路由，每个 43~51 B，`app/` 内不含实现）**：`app/_layout.tsx`(2277 B) 的 `:38-47` 十个 `Stack.Screen` 与 `app/` 下十个单行 `export { default } from '@/screens/...'` 一一对应，另有 `app/+not-found.tsx`(405 B)；`client/screens/` 实际为 demo、endgame、endgameEdit、game、home、lanBattle、lanGame、pveSetup、replay、replayPlayer、spectate —— **没有 `settings/`、没有 `index.tsx`**，即"有 screen 目录但无路由"的只有 `demo`（→ C-99），反向（有路由无 screen）为 0。
- **编号/坐标口径全链路一致（复盘链路专门核对）**：`client/utils/chess/types.ts`（`// 黑方: 0-15, 红方: 16-31`）、`GameEngine.ts:116` 的 `pieceId <= 15 ? BLACK_SIDE : RED_SIDE`、`replayPlayer/index.tsx:131` 的 `if (p.id < 16) byRed.push(p.id);`、`ChessBoard.tsx:38` 的 `capturedByRed: number[]; // 红方吃掉的棋子（黑方棋子ID）` 与 `:283-284` 的 `opponentLostIds/mineLostIds`、`CapturedPiecesDrawer`(`:881-891`)，以及 `game/index.tsx:264-278`、`lanBattle/index.tsx:514-531`、`spectate/index.tsx:478-483` 三处对局页**同口径**。
- **让子链路四处 id 语义一致**：`components/HandicapBoard.tsx` 的 `HC_TAPPABLE = new Set([21..31])`、`lanBattle/index.tsx:1110` 用 `applyHandicap(createInitialState(), roomHandicapRef.current)` 建初始局面、存档 `handicap` 取 `roomHandicapRef.current`、`replayPlayer` 用 `applyHandicap(state, replay.handicap)` 重建。`applyHandicap` 虽是**原地**修改，但 `replayPlayer` 传入的是 `createInitialState()` 的新对象、且后续每步 `makeMove` 内部 `cloneGameState`，`steps[0]` 不会被污染。
- **`makeMove` 契约与重放序列安全**：`makeMove` 永远返回对象（不返回 `null`），`.newState` 取值安全；`undoMove`(`GameEngine.ts:552-556`) 同步 `moveHistory.pop()`，历史与局面不脱节，故存档里的 `moveHistory` 可直接作为可重放序列。
- **复盘播放页边界不会崩**：`currentStep === 0` 时 `replay.moves[currentStep - 1]` 走不到（`currentLastMove` 有 `currentStep > 0` 守卫，`:116-122`；进度行三元也短路）；0 步对局（认输/超时判负）`totalSteps === 0`，滑块与上一步/下一步 `disabled`、hint 落「开局」，不越界。回合文案 `Math.floor((currentStep - 1) / 2) + 1` 恒等于 `Math.ceil(currentStep / 2)`，红先/黑先两种 `firstMoveSide` 下都对。
- **`replayPlayer` 的布局封顶公式没有重复扣减**：`Screen.tsx:202-212` 给子树加 `paddingTop: insets.top`（该页子树无可滚动容器，故被 `KeyboardAwareScrollView` 包裹、`flexGrow: 1` 生效），`boardArea.onLayout` 的 `y` 相对该容器，所以 `windowHeight - insets.top - boardAreaY - insets.bottom` 的算术正确；`stripOffset: 0` 与 `capturedDrawerMetrics` 的 `stripReserve = 8 + 0 + 30` 正好对应 `ChessBoard` 的 `capturedStrip`（`bottom:'100%'` + `marginBottom 8` + `CAPTURED_SUMMARY_H = 30`）；抽屉高度模型与 `CapturedPiecesDrawer` 实测尺寸最多差 1 px，且模型取安全方向（按 7 组算上限）。
- **`@react-native-community/slider` 不是缺陷**：`value={currentStep}` 在 `currentStep === 0` 时会被内部 `const passedValue = Number.isNaN(value) || !value ? undefined : value;` 变成 `undefined`，但 web 实现（`RNCSliderNativeComponent.web.tsx:54` 的 `value: initialValue = 0` 与 `:163-174` 的 `useLayoutEffect` 同步）与原生端 `double` 属性对 `null` 的落值都会把它还原为 0，滑块位置仍跟随 `currentStep`（含拖回第 0 步）。
- **音效清理属全局约定**：`useEffect(() => { preloadSounds(); return () => { unloadAllSounds(); }; }, [])`（`replayPlayer:173-176`）与 `client/screens/spectate/index.tsx:319-320`、`lanBattle/index.tsx:452-453`、`game/index.tsx:286/328` 写法完全一致，不作为单页缺陷（若将来支持多页同时出声再统一改造）。
- **`app/replayPlayer.tsx` 是一行转发、`app/_layout.tsx:47` 已注册**；两页均用 `useSafeRouter`（base64 payload），`/replayPlayer` 仅由列表页 `router.push('/replayPlayer', { id: game.id })` 进入，**没有参数泄漏到明文 URL**。

## 7. 基础设施、构建与打包审计

### 7.1 【I-1】【P2】多处源码注释引用已废弃的 `dist/index.js` 行号

**证据**：`client/utils/battleProtocol/types.ts:13-15` 明写"dist 无源码，行号即真源"，引用 `dist/index.js:26727-26766 / 28696-28780 / 28732-28756`；`client/utils/battleSocket.ts:49` 引用 `dist/index.js:28776-28778`、`:105-106` 引用 `dist/index.js:28797-28846`（注释称"共 9 处"）。服务端源码已在 `src/`（`start.mjs:19-22` 明确"启动期不再需要补丁校验"），且 `dist/index.js` 每次构建都可能是新内容。

**为什么值得修**：这些注释是**维护者定位真源的唯一线索**。当前它们指向一个 1.33MiB（1391234 B）构建产物中的行号——即使行号碰巧还对，读的人也拿不到可编辑的源。

**修复建议**：全部改为 `chinese-chess-server/src/routes/xxx.ts:行号`。

### 7.2 【I-2】【P2】`express@4` 运行时 + `@types/express@5` 类型（潜在错配）

**证据**：`server/package.json:17` `"express": "^4.22.1"`，`:22` `"@types/express": "^5.0.6"`。

**为什么值得修**：`tsc --noEmit` 目前通过（说明现有代码用到的 API 在两版类型下签名兼容），但 v5 类型对 `RequestHandler` 返回值、`Request.body` 类型等的约束与 v4 运行时不一致，未来改动可能"类型通过、运行时出错"。

**修复建议**：二选一——升运行时到 v5，或把类型降到 `@types/express@^4`。

### 7.3 【I-3】【P1】客户端 `test` 脚本是 watch 模式，6 个测试文件不在任何闸门里

**证据**：`client/package.json:12` `"test": "jest --watchAll"`；`chinese-chess-client/package.json:18` 的 `validate` 只串了 `lint` + 两条 parity，**不含 jest**。详见 §7.9 的 **I-13**（此处按"脚本自身坏掉"记 P1）。

**修复建议**：加 `"test:ci": "jest --watchAll=false --ci"`（本次审计即用它跑通）。

### 7.4 【I-4】【P3】workspace 根的 `dev` / `build` / `start` 三个脚本指向不可用的 `.cozeproj/scripts/*.sh`

**证据**：`chinese-chess-client/package.json:6,10,11` 都是 `bash .cozeproj/scripts/*.sh`（POSIX-only，且 `.cozeproj` 属于另一套工具链）。`AGENTS.md` 已说明这一点。

**修复建议**：删除或改为指向 `dev:all` / `expo` 命令，避免新人误用。

### 7.5 【I-5】【P3】根 `tsconfig.json` 是空对象

**证据**：`chinese-chess-client/tsconfig.json` = `{}`。编辑器在客户端根目录打开文件时不会应用 `client/tsconfig.json` 的路径映射（`@/*`），可能出现"编辑器报红但 `tsc` 通过"的体验落差。

**修复建议**：根 tsconfig 改为 `{ "extends": "./client/tsconfig.json" }` 或明确注释说明它是有意的空配置。

### 7.6 【I-6】【P3】仓库根 `README.md` 为 0 字节

**证据**：`D:\Code\ChineseChess\README.md` 大小 0。项目有 14.8KB 的客户端 README 与 10.6KB 的 DEPLOY.md，但**仓库入口说明是空的**。

**修复建议**：补一份顶层 README：项目定位、目录说明、如何跑起来、两条校验闸门、出包流程。

### 7.7 【I-7】【P3】`dist/index.js` 与 `ai/pikafish/**` 共约 6.1MB 二进制/产物**全部入库**，无 LFS、无构建时下载
**证据**（均已 `git ls-files` 确认 tracked，且未被任何 `.gitignore` 排除）：

```
chinese-chess-server/dist/index.js                 1391234 B  1.33MiB  （esbuild 产物，与 src 逐区域比对守住）
chinese-chess-server/ai/pikafish/pikafish.wasm      500621 B  0.48MiB
chinese-chess-server/ai/pikafish/pikafish.cjs       206095 B  0.20MiB
chinese-chess-server/ai/pikafish/data/pikafish.data 4103914 B  3.91MiB   ← 开局评估数据
chinese-chess-server/ai/openingBook.json             39375 B
chinese-chess-server/ai/pikafishWorker.cjs            4982 B
```

**问题**：这是**有意**的设计（保证离线可运行、`postinstall: node build.js` 无需源码外的下载），但代价是仓库体积与每次 `dist` 重建产生的 diff 噪声（1.33MB 的单文件产物进版本库）；`ai/pikafish/data/pikafish.data` 接近 4MB 且不会变，重复存储成本最高。

> **本次审计初稿曾把该目录记为"空目录"**——这是浅层 `Get-ChildItem` 的误判，**已纠正**。`pikafish/` 下有 `data/` 子目录，资源完整。

**修复建议**：无需改动（能跑起来优先）。若日后要瘦身：WASM/评估数据可考虑 Git LFS 或发布时下载 + 本地缓存校验 md5，`dist/index.js` 可只在 release tag 上提交。属可选优化，不是缺陷。

### 7.8 【I-8】【P3】`client/screens/demo/index.tsx` 是**不可达的脚手架残留**，且引用外部 CDN

**证据**：`client/app/` 下共 12 个路由文件（11 个转发路由 + `_layout.tsx`），**没有任何一个指向 `screens/demo`**；全 client 目录 grep `screens/demo` / `@/screens/demo` **零命中**。文件本身是 Coze 模板的占位页：

```tsx
// chinese-chess-client/client/screens/demo/index.tsx:1-19（全文 19 行 / 731 B）
import { View, Text } from 'react-native';
import { Image } from 'expo-image';
import { Screen } from '@/components/Screen';

export default function DemoPage() {
  return (
    <Screen statusBarStyle="auto">
      <View className="absolute top-0 left-0 w-full h-full flex flex-col items-center justify-center">
        <Image
          className="w-[130px] h-[109px]"
          source="https://lf-coze-web-cdn.coze.cn/obj/eden-cn/lm-lgvj/ljhwZthlaukjlkulzlp/coze-coding/expo/coze-loading.gif"
        />
        <Text className="text-base font-bold text-foreground">APP 开发中</Text>
        <Text className="text-sm mt-2 text-muted">即将为您呈现应用界面</Text>
      </View>
    </Screen>
  );
}
```

**问题**：(a) 死页面，永远渲染不到；(b) 唯一一处 `expo-image` 的远程 `source` 指向第三方 CDN（`lf-coze-web-cdn.coze.cn`），是脚手架残留而非本应用资产；(c) 文本「APP 开发中 / 即将为您呈现应用界面」若被误接上路由会直接误导用户。

> 相邻的 `client/screens/home/index.tsx`（9689 B）是**在用**的首页（`app/index.tsx` 转发到它），不是残留。

**修复建议**：删除 `client/screens/demo/`。若要保留模板样例，移到文档或 `examples/` 并去掉远程 URL。

### 7.9 构建与校验链专项复核（I-9 ~ I-25）

> 本节由一次针对「闸门本身是否可靠」的专项只读审计产出：审计对象是 `chinese-chess-server/build.js`、`chinese-chess-server/scripts/{start.mjs,verify-server-diff.cjs,verify-server-hardening.cjs,verify-lan-disconnect.cjs,verify-rule-engine-parity.mjs}`、两端 `package.json`/`tsconfig.json`、根 `pack.ps1`/`pack.sh`、两个 `AGENTS.md`。**结论：没有 P0；但最严重的两条不是"坏包出厂"，而是"闸门静默放行"——它们会让一次真实的 dist↔src 漂移以 ✅ 退出 0。**

#### 【I-9 · P1】`build.js --only <不存在的区名>` 会跳过整轮比对并 exit 0

`chinese-chess-server/build.js:368`：
```js
  if (ONLY && name !== ONLY) continue;
```
`--only` 只在区名**完全命中**时才进入比对。区名写错、或 `src/` 文件被改名/移动（例如 `src/routes/lanGame.ts` → `src/routes/lanGame/index.ts`）时，`names` 的每一项都被 `continue`，`failed` 保持 0 → 脚本打印 `✅ 区域 <x> 与基准产物一致（仅比对了该区域，其他区域未检查）。` 并 `exit 0`。而 build.js 头部把 `node build.js --check --only src/routes/lanGame.ts` 写成文档化用法，是最容易被人和脚本复制粘贴的"定点校验"。
**修复**：循环结束后断言 `if (ONLY && !names.includes(ONLY))` 直接失败，并打印可用区名。

> **本次审计已实测复现**（只读，不写盘）：`node build.js --check --only src/routes/doesNotExist.ts` → 区域表格**一行都没有**，随后直接打印 `✅ 区域 src/routes/doesNotExist.ts 与基准产物一致（仅比对了该区域，其他区域未检查）。`，`exit 0`。

#### 【I-10 · P1】两侧同时丢失 `// src/...` 锚点 → 整份产物降级为单个 INFO 区，src 与 dist 可任意不同仍判通过

`chinese-chess-server/build.js:92-94`（切区）、`:360`（INFO 集合）、`:379-385`（判据）：
```js
  } else {
    regions.push({ name: '00-PRELUDE', text: lines.slice(from, end).join('\n') });
  }
```
```js
const INFO = new Set(['00-PRELUDE', 'ZZ-BANNER']);
```
```js
  if (name === '00-PRELUDE') {
    const info = preludeInfo(distText, builtText);
    const same = d === b;
    const verdict = same ? 'IDENTICAL' : info.ok ? 'INFO-DIFFER' : 'DIFFER';
    rows.push([name, `${dl}/${bl} 行`, verdict, `  ${info.msg}`]);
    if (!same && !info.ok) failed++;
```
`splitRegions` 只在 `MARKER_RE = /^\/\/ (src\/.+)$/` 命中时切出 `src/**` 区。一旦产物不再带这些注释（esbuild 升级，或调 `minify`/`legalComments`/`format`/`target` 后重新 `node build.js` 并提交新 dist），**两侧同时丢锚点** → 只剩 `00-PRELUDE`(+`ZZ-BANNER`)，二者都在 `INFO` 里 → 判据退化为 `preludeInfo` 的"第三方包名序列一致"，而两侧都抽不出模块注释时它返回 `ok: true`（"0 个模块 / 0 个包"也算一致）→ `src/` 与 `dist/` 可以任意不同，`--check` 仍 ✅ 且 exit 0。对照：只有**单侧**丢锚点会走 `MISSING` 分支被 `failed++`，所以这是"两侧一起坏才静默"的失效模式。
**修复**：切区后加断言——`--check` 时若任一侧不存在任何 `src/` 前缀的区，直接失败。

#### 【I-11 · P1】先删旧包、后校验：校验失败即「旧包已删、新包未出」，该端变成零包

`pack.ps1:90-104`（`:91-92` 删包、`:98-104` 才校验）与 `pack.sh:43-52`（`:44-45` 删包、`:49-52` 才校验）：
```powershell
  $out = "chinese-chess-server_$Date.zip"
  if (Test-Path $out) { Remove-Item $out }
  Remove-OldZip 'chinese-chess-server'
# ……
  if ($checkExit -ne 0) {
    throw "服务端 dist 与 src/ 不一致，已阻塞打包。请在 chinese-chess-server 下执行：node build.js"
  }
```
```sh
  rm -f "$out"
  remove_old_zip 'chinese-chess-server'
# ……
  ( cd chinese-chess-server && node build.js --check ) || { echo "[FAIL] …" >&2; exit 1; }
```
`Remove-OldZip` 按前缀删除**该端全部历史 zip**（含当天已存在的那个），而它在强校验之**前**执行。`pack.ps1 all` 时客户端包已打完，服务端校验随后失败 → 上一版可用 server 包（以及当天更早打的）已被删除、新包未生成，该端**零包**，且失败后无法回滚，与 `AGENTS.md`「每端始终只保留当天这一个包」的约定正好相反。
**修复**：把 `node build.js --check` 移到 `Remove-OldZip`/`Remove-Item` 之前；或先打到临时文件名，校验通过后再改名并删旧。

#### 【I-12 · P1】`.env` 不在打包排除面内，且 `Assert-NoJunk` 不检查它

`pack.ps1:60` 的垃圾匹配模式：
```powershell
  $junkPattern = '(^|/)(node_modules|\.expo|\.expo-shared|coverage|\.cache|\.turbo|\.parcel-cache|\.vscode|\.idea|\.git)(/|$)'
```
`$ExcludeCommon`(`:23-42`) 与 `pack.sh` 的 `zip -x` 列表同样没有 `.env`。而仓库模板本身预期会有 `.env`（`chinese-chess-client/.gitignore:14` 就是 `.env`），脚本大量读 `process.env.EXPO_PUBLIC_*`/`SERVER_PORT`。只要有人把 `.env`（或 `.env.local`、`client/.env`）落在被打包目录下，两套出包脚本都会原样打进 zip，自检也不报——zip 是本项目的主要交付物。**本机实测当前不存在任何 `.env*`**，故按潜在泄漏定 P1 而非 P0。
**修复**：排除项与 `$junkPattern` 均加 `.env` / `.env.*` / `*.env`，`pack.sh` 同步。

#### 【I-13 · P1】客户端 6 个测试文件不在任何闸门里，且 `test` 是 watch 模式

`chinese-chess-client/package.json:18` 与 `chinese-chess-client/client/package.json:12`：
```json
    "validate": "pnpm run lint && pnpm run verify:server-parity && pnpm run verify:rule-engine-parity"
```
```json
    "test": "jest --watchAll"
```
`client/**/__tests__` 下 6 个测试（`RuleEngine.test.ts` 29260 B、`songjiangGate.test.ts` 17622 B、`songjiang.test.ts` 10342 B、`ruleEngineParity.test.ts`、`useBattleClock.test.ts`、`battleSocket.test.ts`）只在有人手动 `pnpm --filter expo-app test` 时才跑；`validate`、打包脚本、`postinstall` 都不调用 jest（jest 配置内联在 `client/package.json:14-23`，无 `jest.config.js`）。而 `--watchAll` 是交互式监听模式，非 TTY 下不会自行结束，接进流水线会挂住而不是给结论 → 规则引擎行为层（送将/长将/对局时钟/断线重连）与已有 4 个 parity 断言**没有任何自动闸门**。（与 §7.3 的 I-3 是同一条，此处按"闸门链"口径重述并升级为 P1。）
**修复**：`test` 改为 `jest`，`validate` 末尾追加 `pnpm --filter expo-app exec jest --ci --silent`。

#### 【I-14 · P2】差分闸门对 `clocks` 只比形状、不比数值

`chinese-chess-server/scripts/verify-server-diff.cjs:351-355` 与 `:720`：
```js
    if (structuralOnly.has(k) && typeOf(a[k]) === typeOf(b[k])) {
      // 只比形状：键集合/类型已由递归保证，跳过数值比对
      if (typeOf(a[k]) === 'object' && a[k] !== null) collectShape(a[k], b[k], child, out);
      continue;
    }
```
```js
    collectDiffs(a.body, b.body, 'body', diffs, { structuralOnly: new Set(['clocks']) });
```
`clocks` 是正式对局响应里的真实字段（`chinese-chess-server/src/routes/lanGame.ts:104 clocks: { red: number; black: number } | null;`、`:387 clocks: room.clocks,`、`:1266/:1324 room.clocks[side] = Math.max(0, room.clocks[side] - elapsed) + room.settings.incrementSeconds * 1000;`），而 `collectShape`(`:366-386`) 只比键集合与数组长度 → **局时/加秒的任何数值差异都不会被判为 diff**，差分闸门对时间控制数值完全失明。
**修复**：把 `clocks` 移出 `structuralOnly`，或断言两侧 clocks 差值 ≤ 1 个 tick。

#### 【I-15 · P2】差分基线只存在于未跟踪的 `.dsh-work/`

`chinese-chess-server/scripts/verify-server-diff.cjs:123-129` 的 `BASELINE_PATH` 指向 `<repo>/.dsh-work/dist-baseline-20261002.js`（`BASELINE_MD5 = '2646eac282e2ddc8d3d76b37a36c61b3'`、`BASELINE_SIZE = 1397891`），而 `.dsh-work/` 被 `.gitignore:16` 忽略、`git ls-files .dsh-work` 为 0 条 → 唯一可用的 old 产物不在版本控制内。缺基线时脚本**不退化为跳过**，而是要求 `dist/index.js` 与工厂基线逐字节一致，否则 `throw`（"拒绝把它当作 old…请用 --old <path> 显式指定旧产物"），即新克隆/新机器/CI 上必然硬失败。基线常量本身的实测自洽性已核实：`.dsh-work/dist-baseline-20261002.js` = 1,397,891 B / md5 `2646eac…`，`dist/index.js` = 1,391,234 B / md5 `f88c23a…`，与 build.js 头注释三方一致。
**修复**：把基线（或其生成方式）纳入版本控制，或让缺基线时以明确的"未运行"退出码跳过。

#### 【I-16 · P2】KNOWN 规则 A2 判据过宽，预先赦免新侧所有 500 响应差异

`chinese-chess-server/scripts/verify-server-diff.cjs:411-414`：
```js
    id: 'A2',
    title: '全局错误中间件（新增加固：HTML 500 → JSON 500）',
    reason: '新 dist 增加全局错误中间件返回 internal_error JSON，旧 dist 走 express 默认错误处理',
    match: (d, step) => step.statusNew === 500 && /(^|\.)(contentType|body|text)/.test(d.path),
```
它只看**新侧**是否 500 就放过 `contentType/body/text` 差异，不比对 `statusOld`、不要求 `step.frameworkResponse`（同类规则 B 在 `:424-435` 两者都要求）。于是"新 dist 任何返回 500 的分支"被预先赦免，而 500 恰是加固改动最常出现的地方；若新 500 响应体里带出堆栈/内部路径，差分也不会报。
**修复**：给 A2 加 `step.statusOld === step.statusNew` 与 `step.frameworkResponse === true`（或要求新侧 body 匹配 `"error":"internal_error"`）。

#### 【I-17 · P2】内联第三方依赖发生变化不阻塞出包（"0 个模块也算一致"）

`chinese-chess-server/build.js:222-244`（`preludeInfo`）、`:360`、`:379-385`：`00-PRELUDE`/`ZZ-BANNER` 都在 `INFO` 里，差异只要"node_modules 包名序列一致"就只报 `INFO-DIFFER` 不失败；而 `preludeInfo` 在两侧都抽不出模块注释（`dNames`/`bNames` 均空 → `join('\n')` 相等）时返回 `ok: true`，消息退化为"dist 0 个模块 / built 0 个模块"级别的一致 → 升级或替换被打进 dist 的第三方依赖不会阻塞出包，只会打印版本漂移（版本漂移本身永不判失败）。与 **I-10** 是同一处判据的两个侧面。
**修复**：把"两侧模块数均为 0"也当失败条件，并断言模块数非零。

#### 【I-18 · P2】`verify-server-hardening.cjs` 声称覆盖"补丁五"，实际零断言

`chinese-chess-server/scripts/verify-server-hardening.cjs:21` 自述 `补丁五 被拒绝的动作回推权威状态（由 A2/A3 的隐含前提覆盖：拒绝后客户端仍能拿到权威局面）。`，而 `:202-205`、`:229-233` 两条断言只数 `moveHistory` 长度：
```js
  ok('A2b 非法着法后 moveHistory 长度不变（局面未被污染）', after2Moves === afterMoves,
    `expected=${afterMoves} actual=${after2Moves}`);
```
```js
  ok('A3c 被拒的越权着法未落子（着法历史恰好 +1）', after3Moves === after2Moves + 1,
    `expected=${after2Moves + 1} actual=${after3Moves}`);
```
**没有任何断言检查被拒动作的响应/广播里是否带权威局面**，而被拒响应对象 `bad`(`:196-199`)、`wrongTurn`(`:216-219`) 就在手上。加固语义（客户端不会停在乐观更新）因此没有回归保护——§5 的 S-3（WS 通道缺少被拒动作回推）之所以能长期存在，与这里恰好没有断言互为因果。
**修复**：断言被拒响应（或同帧广播）里含权威 `fen`/`gameState`。

#### 【I-19 · P2】E1/E2 是 dist 文本搜索式"哨兵"，改名即失效

`chinese-chess-server/scripts/verify-server-hardening.cjs:445-453`：
```js
  const src = fs.readFileSync(DIST_PATH, 'utf8');
  ok('E1 dist/index.js 不含 isMoveBanned（长将长捉拦截逻辑又回到了产物里）',
    !src.includes('isMoveBanned'), '…');
  ok('E2 dist/index.js 不含已废弃的违规判负计数（recordBanViolation）',
    !src.includes('recordBanViolation'));
```
E 是六个场景里唯一的静态断言。函数一旦改名（或改成对象方法/常量开关），"拦截逻辑又回到了产物里"就查不出来——而它守护的正是"服务端不得二次拒绝客户端能走的着法"这条最容易被重新引入的回归（见 §4/§5 的历史加固第 1 条）。
**修复**：改成行为断言（构造一手客户端认为合法、服务端曾禁着的棋，断言 200），或匹配调用点特征而非仅标识符名。

#### 【I-20 · P2】`pack.sh` 与 `pack.ps1` 不等价：POSIX 出包会带杂项且没有自检

`pack.sh:30-38` 的 `zip -x` 只有 8 条，对比 `pack.ps1:23-42`（19 条排除）+ `:58-67`（`Assert-NoJunk`）。`pack.sh` 缺 `.DS_Store`、`Thumbs.db`、`__pycache__`、`*.pyc`、`*.log`、`*.log.*`、`logs`、`*.tsbuildinfo`、`.cache`、`.turbo`、`.parcel-cache`、`.vscode`、`.idea`、`*.iml`、`.git`、`.env`、`coverage` 的排除，且**没有 `Assert-NoJunk` 等价物**（只检查 `zip` 退出码）。在 macOS/Linux/WSL 上照 `AGENTS.md` 用 `./pack.sh` 出包会把这些带进 zip，且没有任何自检报警。
**修复**：两端共用一份 exclude 清单，并给 `pack.sh` 补 `unzip -Z1` + 同 pattern 的自检。

#### 【I-21 · P2】根 `AGENTS.md` 对打包自检的描述与脚本实际不符

`AGENTS.md:17` 称 `Assert-NoJunk`「一旦混入上述缓存/构建产物就直接失败」，但 `$ExcludeCommon` 里**没有** `dist`/`web-build`/`build`（客户端侧只靠 `New-ClientZip` 内三条具体路径 `chinese-chess-client/client/dist|web-build|build` 兜住），`$junkPattern` 也不含这三个目录名 → 对仓库级同名目录（例如将来出现 `chinese-chess-client/dist/` 或根级 `build/`）承诺不成立。
**修复**：文档逐条对齐实际清单，或把这些目录名（服务端 `dist/` 除外）加进排除与 `$junkPattern`。

#### 【I-22 · P2】出包身份依赖环境变量，仓库内没有任何固化

`chinese-chess-client/client/app.config.ts:3-4`、`:30`、`:37-43`：
```ts
const projectId = process.env.COZE_PROJECT_ID || process.env.EXPO_PUBLIC_COZE_PROJECT_ID;
const slugAppName = projectId ? `app${projectId}` : 'myapp';
```
```ts
      "package": `com.anonymous.x${projectId || '0'}`,
```
仓库里没有 `app.json`/`eas.json`/`.env`（实测），`slug`、Android `applicationId`、expo-router 的 `origin` 全取决于打包机器是否设置了那三个环境变量 → 同一份源码在不同机器上产出 `app<id>` vs `myapp`、`com.anonymous.x<id>` vs `com.anonymous.x0` 的不同身份包。
**修复**：提交一份固定的 `app.json`（或 `.env.example` + 打包前置校验），让 applicationId/slug 与机器无关。

#### 【I-23 · P2】`install-missing-deps.js` 的安装命令非法，实际总会回退到 `npm install`

`chinese-chess-client/client/scripts/install-missing-deps.js:83`、`:91`：
```js
      execSync(`pnpm expo install ${packagesToInstall}`, { stdio: 'inherit' });
```
```js
      execSync(`npm install ${packagesToInstall}`, { stdio: 'inherit' });
```
`pnpm expo install` 不是合法形式（pnpm 不会把未知子命令当 bin 执行，应为 `pnpm exec expo install`），该调用抛错后被 try/catch 吞掉 → 每次 `pnpm install`（`postinstall` → `install-missing` → `check-deps` → 这里）都走 `npm install` 分支：在 pnpm workspace 里用 npm 装依赖，可能生成/污染 `package-lock.json` 与扁平 `node_modules`，破坏 pnpm 严格依赖树；`preinstall: npx only-allow pnpm` 只拦"用 npm 当包管理器"，拦不住这个子进程。
**修复**：改成 `pnpm exec expo install ...` 并删除 npm 回退。

#### 【I-24 · P2】`.verify-old/` 残留会进服务端 zip

`chinese-chess-server/scripts/verify-server-diff.cjs:123-124`（`RUN_DIR = <server>/.verify-old`、`DEFAULT_OLD = RUN_DIR/index.js`）在服务端目录下复制一份 1.4 MB 旧产物；正常结束会 `cleanupRunDir` 删除，但 `--keep`、被强杀（该 harness 在 win32 自己就靠 `taskkill /f /t`）、或 `prepareOldArtifact` 中途 `throw` 都可能留下它。`pack.ps1:106-109` / `pack.sh:54-55` 只排 `chinese-chess-server/node_modules`，`Assert-NoJunk` 也不查 `.verify-old` → 一份**旧 dist 产物**会随"自包含部署包"（DEPLOY.md 明示可直接运行）发出去，极易被误用。
**修复**：排除项加 `.verify-old`，并把 `RUN_DIR` 移到待打包目录之外。

#### 【I-25 · P3】校验链的四条小债（死配置/死代码/不受 tsc 保护/装依赖即失败）

- **差分 harness 含生成即失效的"时间键学习"**：`chinese-chess-server/scripts/verify-server-diff.cjs:235-240` 的 `msKeys` 学习结果**从不参与任何判据**（全文没有第二次读 `msKeys`），`ctx.side` 也从未被改成 `'new'`；`buildNormalizer` 返回的 `structuralOnly`（含 `aiStats`）无人读取——`:720` 另建了只含 `clocks` 的 Set。头注释 R5 与 `:281`"两趟归一化"的注释因此夸大了实际机制。另有 `compareObj`(`:702-707`) 构造后从不使用，`:1653` 把"步数"与"差异条数"混在一行打印。
- **hardening 的死 helper**：`chinese-chess-server/scripts/verify-server-hardening.cjs:86` 的 `const heartbeat = (roomId, playerId) => post(...)` 全文未被调用（grep 仅此一处），"后台/前台心跳"这条路径在这份测试里其实没覆盖（覆盖它的是 lan-disconnect）。
- **三个 `.cjs` 校验脚本不受 `tsc` 保护**：`chinese-chess-server/tsconfig.json` 的 `include` 是 `["src/**/*.ts","build.js","scripts/**/*.mjs"]`，`verify-server-diff.cjs`/`verify-server-hardening.cjs`/`verify-lan-disconnect.cjs` 不在其中，`pnpm lint` 覆盖不到；它们是纯 JS，笔误只在运行时暴露。
- **`postinstall` 依赖 devDependency**：`chinese-chess-server/package.json` 的 `postinstall: node build.js` 与 `devDependencies.esbuild`——`pnpm install --prod` 时 `postinstall` 仍执行 → `Cannot find module 'esbuild'`，即便只想运行已提交的 dist。另：`pack.sh:4` 与 `.gitignore:12` 仍把产物目录写成 `/workspace`（模板遗留）；根 `AGENTS.md:51` 称"node/pnpm 不在 PATH"，但本机实测 `node` 在 PATH（`C:\Program Files\nodejs\node.exe`）、`tar` 为 `C:\WINDOWS\system32\tar.exe`（文档滞后，不构成阻塞）。

### 7.10 闸门能力矩阵（每个闸门"能验什么 / 不能验什么 / 怎么失效"）

| 闸门 | 验证什么 | 靠什么机制 | 不能验证什么 | 失效方式 |
| --- | --- | --- | --- | --- |
| `pack.ps1 server\|all` / `pack.sh server\|all` | 出包前 dist 是否等于 src 重建结果；包内是否混入缓存 | `node build.js --check` 非零即 throw（ps1:102-104 / sh:49-52）；`Assert-NoJunk` 用 `tar -tf` + regex（**仅 ps1**） | 包内是否有 `.env`/`.verify-old`；dist 与 src 是否**行为**等价；仓库级 `dist`/`web-build`/`build` 目录 | 先删包后校验（I-11）；`.env` 未排除（I-12）；pack.sh 无自检、排除项仅 8 条（I-20） |
| `node build.js --check`（= `pnpm -w verify:server-parity` = 服务端 `pnpm verify`） | 已提交 `dist/index.js` 与 `src/` 重建产物逐区域一致 | 同参数内存重建（`:303-319` 仅 `write` 不同）+ 区域切分后逐字符全等/去转义比较；非 INFO 区 DIFFER/MISSING 即 exit 1 | `00-PRELUDE`/`ZZ-BANNER` 内容（只看第三方包名序列）；`--only` 未覆盖的区域；行为等价；`ruleEngine.cjs`（external） | `--only` 名字不存在 → 全跳过仍 ✅（I-9）；两侧 `// src/` 锚点同时消失 → 整包降级为 INFO（I-10）；`preludeInfo` 抽不到模块也算一致（I-17） |
| `pnpm -w validate` | 客户端 tsc+eslint → dist↔src → 两端规则引擎同源 | 三条命令 `&&` 串联，任一非零即失败 | jest 的 6 个测试、hardening、lan-disconnect、server-diff、zip 内容 | 不跑就等于没有闸门（无 CI）；三条退出码都是 1，需读日志区分哪条失败 |
| 服务端 `postinstall: node build.js` | 不是闸门——它**直接重写**已提交的 dist | pnpm install 后自动构建（写出） | 任何东西（它把"不一致"洗成"一致"） | 手工改过的 dist 被静默覆盖；依赖 devDependency esbuild（I-25） |
| `verify-rule-engine-parity.mjs`（权威 parity） | `ruleEngine.cjs` 是否等于客户端 `ruleEngine.bundle.ts` 的内存重建字节 | esbuild `buildSync(bundle,cjs,node,es2020,无 banner)` + CRLF/入口注释归一化后字符串比较；不一致打印首个差异字节 ±60 字符，exit 1 | esbuild 版本差异造成的合法漂移（报假阳性而非漏检）；dist 是否真的 require 这份（靠约定）；`--write` 后是否重启了服务端 | 两边参数不一致 → 假阳性；`--write` 后忘记重启 → 运行期仍是旧规则（AGENTS.md 已警告，非闸门能管） |
| 客户端 `ruleEngineParity.test.ts` | 与权威脚本同样的字节比对 + 行为断言（服务端合法着法 = 客户端安全着法、4 手序列 FEN、送将局面过滤） | **重复一份** buildSync + 逐字节比较（另有行为 expect） | 与权威脚本共享逻辑（各写一套）；不跑就什么也不验 | jest 不在任何闸门/CI 里（I-13） |
| `verify-server-diff.cjs`（L2 差分） | 旧基线产物 vs 重建 dist 在同一 HTTP/WS 序列下的响应与广播结构差异 | 真起两个进程（spawn + 端口 9091/9092）、lockstep 请求、时间戳/房号/id 归一化、结构化 diff + KNOWN 白名单；exit 0 = 无未知差异 | `clocks` 数值（I-14）；帧重排（LCS 对内容相同的帧不敏感）；A2 覆盖的 500 差异（I-16）；依赖 `.dsh-work/` 基线（I-15） | 基线缺失 → throw（不静默）；两侧同 md5 → 只证"无假阳性"（脚本自己警告）；纯人工跑 |
| `verify-server-hardening.cjs` | 6 条加固里的 5 条半：权威落子/拒绝不污染局面、初始上传收紧、首传不能伪造终局、畸形 FEN、房间名最小空缺 | 同进程 `require(dist)` + 全局 `fetch` 打真实 `/api/v1/lan`、`/api/v1/ai` | 补丁五（回推权威状态，零断言，I-18）；长将长捉的**行为**（E 是文本 includes，I-19）；无引擎环境时 C 场景会当环境问题跳过 | 函数改名即可绕过 E；不在 validate/CI 里，需人工跑 |
| `verify-lan-disconnect.cjs` | 后台节流、超时判负、回前台撤销、终局房间不销毁、对局中/等待期离场 | 改写 `Date.now()` 的虚拟时钟 + 服务端真实 `setInterval` tick（同进程 require dist） | 任何不走 `Date.now()` 的时间源（当前 `src/**` 全是 `Date.now()`，故成立）；真实网络断线（模拟的是时钟推进与 hidden 状态） | 将来引入 `new Date()`/`performance.now()` 计时 → 虚拟时钟失效而测试仍"通过"；不在 validate/CI 里 |
| `Assert-NoJunk`（pack.ps1 出包自检） | zip 内是否有 node_modules/.expo/coverage/.cache/.turbo/.parcel-cache/.vscode/.idea/.git 与 `*.log`/`*.tsbuildinfo`/`*.eslintcache`/`.DS_Store` | `tar -tf` + regex，命中即 throw | `dist`/`web-build`/`build`、`.env`、`.verify-old`、文件内容（密钥） | 只在 pack.ps1 有、pack.sh 无（I-20）；文档声称覆盖构建产物但 pattern 里没有（I-21） |
| 服务端 `tsc --noEmit`（`pnpm lint`） | `src/**/*.ts`、`build.js`、`scripts/**/*.mjs` 的类型 | tsconfig include + `strict` | `scripts/*.cjs` 三个校验脚本（I-25）；运行期行为 | `.cjs` 里的笔误只在运行时暴露；除 validate 外无自动环节 |
| 客户端 `lint: tsc --noEmit && eslint ./ -f ./scripts/formatter.mjs --quiet` | client 的 TS 类型与 eslint error | expo tsconfig + `eslint.config.mjs` + 自定义 formatter | eslint warning（`--quiet` 丢弃）；jest 断言；运行期行为 | 只报 error 会漏掉 warning 级规则；被 `validate` 覆盖，但 jest 不在闸门内（I-13） |

> **专项复核确认"真的做到"的硬承诺**（避免把这份审计读成"全是漏洞"）：`pack.ps1`/`pack.sh` 的 `node build.js --check` **确实**在 tar/zip 之前执行、非零即 `throw`/`exit 1`，不会生成 zip，且 `$ErrorActionPreference = 'Stop'`(`pack.ps1:11`) 保证异常不静默继续；`pack.ps1` **实测是 UTF-8 with BOM**（前 3 字节 `EF BB BF`）；两份 zip **实测干净**（client 无 `node_modules`/`.expo`/`dist`/`web-build`/`build`；server 仅 37 条、无 `node_modules`/`.env`/日志，`dist/` 与 `ai/` 是有意保留的可运行主体；`client/.npmrc` 会进 client zip 但其中无 token）；全仓库**无硬编码凭据**（`_authToken`/私钥/`api_key`/password 字面量的命中全是 LAN 房间密码业务字段与 express/cookie-signature 等库代码）、**无本机绝对路径入包**（唯二命中是文档与 WASM 库内部的 `/home/web_user`）；`--check` 与写出构建**共用同一份 `buildOptions`**（`build.js:303-319` 只差 `write`），不存在"校验一套参数、出包另一套"；区域比对是**逐字节全等**（`d === b`，非 md5），`normalize` 只做 `\uXXXX` 解码，单侧锚点丢失是响亮的 `MISSING` 失败；三个 `verify-*.cjs` **都是真跑的测试**而非"读源码找字符串"（diff 起两个真实进程做 HTTP/WS lockstep 差分；hardening 同进程起 dist 并用真实 `fetch`；lan-disconnect 用被改写的 `Date.now()` 虚拟时钟驱动真实 `setInterval`，且已核实 `chinese-chess-server/src/**` 的全部时间判断都走 `Date.now()`——无 `new Date(`、无 `performance.now()`——故虚拟时钟前提成立），三者退出码都正确；两条 parity 各自实现但都做内存重建 + 逐字节比对，覆盖的正是客户端运行期引擎闭包（`ruleEngine.bundle.ts` 只 re-export `./GameEngine` 并 `export { isMoveBanned } from './RuleEngine'`，`GameEngine.ts:11`/`RuleEngine.ts:29` → `./MoveCheck`，`MoveCheck.ts:28` → `./types`），不存在"客户端跑另一份引擎"的缝；同源链闭合（`src/routes/lanGame.ts:6 import ruleEngine from '../ruleEngine.cjs';` 且 build.js 把 `'../ruleEngine.cjs'` 列为 external，dist 里保留 `require("../ruleEngine.cjs")`）；脚本引用的文件**全部存在**（`.cozeproj/scripts/*.{sh,ps1}`、`scripts/dev-all.mjs`、`client/scripts/{formatter.mjs,install-missing-deps.js}`、`patches/expo@54.0.33.patch`、`eslint.config.mjs`、`metro.config.js`），`client/package.json` 的 name=`expo-app` 与 `--filter expo-app` 匹配；**仓库内不存在任何 CI 配置**（无 `.github/`、无 `.gitlab-ci.yml`）——`AGENTS.md` 里"CI 调用任一即可阻塞流水线"是设想而非现状。

### 7.11 基础设施已被核对为**正确**的部分

- **收尾固化规则明确且可执行**：`AGENTS.md` 规定"任务若触及 `chinese-chess-client/` 或 `chinese-chess-server/`，必须重新打包对应 zip：`powershell -NoProfile -ExecutionPolicy Bypass -File .\pack.ps1 all`"；`pack.ps1` 必须保持 **UTF-8 with BOM**。
- **服务端出包的强校验**：`pack.ps1` 在出包前强制 `node build.js --check`，`dist` 与 `src` 不一致则**阻塞出包**。这条闸门本次实测为**通过**（11 区域 IDENTICAL）。
- **规则引擎同源闸门**：`pnpm -w verify:rule-engine-parity` 校验 `chinese-chess-server/ruleEngine.cjs` 与 `client/utils/chess/ruleEngine.bundle.ts` 一致（本次实测通过，35541 字节，target=es2020）。注意 **target 换成 es2019/es2018 或更低会造成假漂移**（`AGENTS.md` 已注明）。
- **`build.js` 的比对策略**：按 `// src/xxx.ts` 注释切区域，一方代码逐字符比对、第三方只比依赖图（158 模块 / 70 包，版本漂移 0）；`--porting` 模式对历史手工产物的已知差异（整行注释 / `void 0≡undefined` / 尾逗号 / 多声明符展开 / `function(` 空格 / 引号风格 / 裸 `require≡ESM import`）做了有依据的归一化，并保留"非注释代码仍逐字符一致"的强度。
- **`start.mjs` 修掉了两个真实历史问题**：Windows 上 `VAR=value cmd` 不被 cmd 识别；旧脚本 `PORT=${PORT:-5000}` 与 `dist` 默认 9091、DEPLOY.md、start.bat 三处文档不一致。
- **客户端路由层"零逻辑"规范被严格遵守**：`client/app/` 下 **10 个转发路由**每个只有 **43~51 字节**的单行 re-export（如 `app/game.tsx` 43 B），确实没有逻辑泄漏到路由层；`_layout.tsx`（2277 B）与 `+not-found.tsx`（405 B）是仅有的两个有内容的文件，属正常。`_layout.tsx:38-47` 声明的 10 个 `Stack.Screen` 与这 10 个路由文件**一一对应，无缺无余**（路由专项审计已独立复核）。
- **pnpm 版本与 esbuild 版本被钉死**：`packageManager: pnpm@9.0.0`、`pnpm.overrides.esbuild: 0.27.2`（规则引擎产物与客户端 bundle 依赖同一版本才能同源）。

---

## 8. 跨端一致性问题汇总（同一语义多处实现）

这是本报告最希望被排期关注的一类问题：**同一个语义在两个地方各写一遍，其中一处后来加固了，另一处没有。** 下表是本次审计找到的全部实例。

| # | 语义 | 实现 A（已加固/正确） | 实现 B（缺失/不一致） | 后果 |
| --- | --- | --- | --- | --- |
| 1 | 被拒动作回推权威状态 | `server/src/routes/lanGame.ts:174-194`（HTTP，4xx 也广播） | `server/src/routes/battleWs.ts:283-287`（WS，仅 2xx 广播） | WS 主通道上非法落子留在盘上（§3.3） |
| 2 | 拒绝回推限流 | `roomForSync.lastRejectionSyncAt`（per-room） | `syncRejectionCount`（全局，`lanGame.ts:165`） | 多房间互相吃配额（§3.4） |
| 3 | 房主判定 | `room.hostId` 字段 | `room.players[0].id`（`lanGame.ts:419`、`:954`） | 双源真相（§3.7） |
| 4 | 开局校验 | `actStart`（含容差与 phase 校验） | `tryAutoStart`（`lanGame.ts:592-614`，判据更弱） | 两条路径口径不同（§3.19） |
| 5 | 终局字段清理 | `actSurrender`（清 `clockPausedAt`） | `actDrawResponse`/断线/超时（不清 pending） | 残留协商 UI（§3.10） |
| 6 | 动作类型反查 | `request()` 的 `reqId = ${type}-${n}`（`battleSocket.ts:448`） | `send()` 的 `reqId = req-${n}`（`battleSocket.ts:429`） | `actionOf` 返回 null，误清两条协商线（§4.3） |
| 7 | 时钟域 | `serverTimeOffsetRef` 已计算并**正确使用**（`useBattleStateSync.ts:255-257` 计算、`useBattleClock.ts` 的 `correctedNow`、`lanBattle/index.tsx:1176-1181` 公示倒数） | **4 处**用裸 `Date.now()` 减服务端时间戳：`useBattleStateSync.ts:408-411`（断线倒计时）、`:324`（对局时长）、`lanBattle/index.tsx:1756`（**步时 → 会自动替用户走随机棋**） | 倒计时错乱；步时形同虚设（§4.4、§6.7 C-40） |
| 8 | 异步写状态的代数校验 | AI 分支（`game/index.tsx:563-565`） | 玩家分支（`:743-754`，无校验） | 重开被"复活"（§5.1） |
| 9 | 吃子计数 | `ChessBoard` 用派生数组（`ChessBoard.tsx:282-284`、`:695`） | 页面 `capturedRed/Black` state（存档用） | 悔棋后存档不一致（§5.3） |
| 10 | 存档校验 | `loadGame` 会校验并清坏档（`GameSave.ts:75-92`） | `hasSave` 只判存在（`:108-115`） | UI 承诺与事实不符（§5.8） |
| 11 | FEN 校验强度 | 客户端 `validateEndgameFen`（10 类校验） | 服务端 `isFenBoardShapeValid`（只查行宽）；`GameEngine.createFromFen` 连行宽都不查（`GameEngine.ts:615-638`）；同文件的 `isFenBoardWidthValid`（`:697`）只被 `aiDispatcher.ts:349` 用于在线请求前自检，**`createFromFen` 入口不用** | 畸形 FEN 进 WASM；**客户端直接崩溃**（§3.14、§5.14 R-1） |
| 12 | 引擎超时常量 | `JOB_SAFETY_TIMEOUT_MS = 15000`（`pikafish.ts:151`） | `INFLIGHT_LEASE_MS = 20_000`（`ai.ts:33`，靠注释维持 >15s） | 调整时无提示（§3.24） |
| 13 | 在线 AI 超时预算 | 服务端 15s job / 20s 租约 | 客户端 `ONLINE_TIMEOUT_MS = 2000`（`aiDispatcher.ts:97`） | 客户端先放弃，服务端仍烧 CPU（§4.10） |
| 14 | 注释真源 | 服务端已有 `src/` 源码 | 客户端注释指向 `dist/index.js` 行号 | 定位不到真源（§7.1） |
| 15 | 送将过滤 | 服务端裁决逐点过 `isMoveKingSafe`（`ruleEngine.bundle.ts:52-62`）；客户端 4 个 `makeMove` 调用点上游都有闸门 | `onlineMoveGuard.assertOnlineMoveSide` 只查起点归属，落点不查（`onlineMoveGuard.ts:51-68`）；`replayPlayer/index.tsx:64` 无任何闸门 | 越界落点在客户端崩（§5.14 R-4、R-7） |
| 16 | 王安全过滤（AI 内部） | 根节点/quiescence/minimax 三处统一过 `isSideInCheck` | `AIEngine.findImmediateWin` 两段都不过（`:864-884`）且在 `:1174-1185` 优先返回 | AI 输出送将着法 → 被丢弃 → "该走而不走"（§5.14 R-3） |
| 17 | 同名判据的终局语义 | `AIEngine.isSideInCheck`：将帅缺失 → `return true` | `RuleEngine.isSideInCheck`：将帅缺失 → `return false` | 两处语义相反，任一侧"对齐"都会改变终局裁决（§5.14 R-6） |
| 18 | 房间设置的写入方式 | `baseTimeSeconds`/`handicap` 走 setter（`useBattleStateSync.ts:269-277`） | `turnTimeLimit` **只写 ref、从不调 setter**（`:263-265`，接口 `:152` 的 `setTurnTimeLimit` 是死 API） | 观战页步时完全失效（§6.8 C-53） |
| 19 | 服务端响应的错误处理 | 观战页轮询有 `inFlight` 防护（`spectate/index.tsx:403-409`） | 大厅 3s 轮询无防护（`lanGame/index.tsx:193-196`）；四个 fetch 全不查 `response.ok` | 旧响应覆盖新数据、失败静默清空（§6.8 C-55~C-58） |
| 20 | 定时器清理 | battleSocket/轮询/心跳/断线倒计时/对局时长/准备倒数/表情/返回房间兜底**都有** cleanup | `countdownTimerRef` **没有** unmount cleanup（`lanBattle/index.tsx:1185-1189`） | 卸载后仍开局并上传初始局面（§6.7 C-44） |
| 21 | 浮层的点击穿透 | 外层容器设 `pointerEvents="box-none"` 且**注释明确声明"非阻塞、不吃掉棋盘点击"**（`GameNotice.tsx:126`、`JueShaOverlay.tsx:180`） | `box-none` **不传递给子节点**，内层 View 仍是默认 `auto`（`GameNotice.tsx:131`）；且 `opacity: 0` 的按钮仍在命中区（`JueShaOverlay.tsx:294`） | 提示条吞掉棋盘中部点击 3 秒；绝杀按钮"看不见但能点"（§6.9 C-73/C-74） |
| 22 | 窗口尺寸响应 | `JueShaOverlay.tsx:98` 与 `AppModal`（`:99`）用响应式 `useWindowDimensions()` | `ChessBoard.tsx:233`/`:895` 与 `BoardEditor.tsx:34` 用一次性 `Dimensions.get('window')` | 尺寸变化后棋盘不重排，而结算锚点已重排 → 错位（§6.9 C-77） |
| 23 | 设计 token 的消费 | `constants/modal.ts` 集中定义颜色与 `Z_INDEX`/`ELEVATION`，且文件头要求所有浮层消费它 | `BoardStyleModal.tsx:22-29` 与 `RoomSettingsControls.tsx:11-19` 各复制一份色板；`RoomSettingsControls.tsx:144-147` 用裸 `zIndex:100/elevation:10`（token 是 50/50） | 改主题必然漏改；Android 堆叠次序靠巧合（§6.9 C-83/C-91） |
| 24 | 动画回调与清理 | `MoveEffectOverlay.tsx:99-155` 有 `mountedSeqRef` 去重 + `animation.stop()` 清理 | `GameNotice.tsx:68-77` 的 `start()` 回调不判 `finished`；`JueShaOverlay.tsx:107-154` 的动画 effect 无清理函数 | 新通知被旧回调清空；卸载后动画空转（§6.9 C-76/C-89） |

---

## 9. 修复路线建议（第 0 / 1 / 2 批已落地，第 3 批见 §9.3）

> **执行状态（本次更新）**：第 0、1、2、3 批的全部条目**已按顺序修复并通过闸门**。
> 第 0/1 批的记录见「§9.1」，第 2 批见「§9.2」，第 3 批见「§9.3」。
> 下表保留原排序，作为改动范围的对照。

### 第 0 批：先让闸门真的能拦住（建议最先做，否则后面所有"已验证"都不可信）

| 项 | 改动量 | 收益 |
| --- | --- | --- |
| `build.js:368` 循环后补 `if (ONLY && !names.includes(ONLY))` 失败（§7.9 I-9） | ~3 行 | 「定点校验」不再可能整轮跳过还报 ✅ |
| `build.js` 切区后断言"任一侧存在 `src/` 前缀区"（§7.9 I-10） | ~4 行 | 锚点两侧同时消失不再让 `src/dist` 任意不同仍通过 |
| `pack.ps1`/`pack.sh` 把 `node build.js --check` 移到删旧包之前（§7.9 I-11） | 移动 4 行 | 校验失败不再把上一版可用包删掉（该端零包） |
| 两套出包脚本的排除项与 `$junkPattern` 增加 `.env`/`.env.*`（§7.9 I-12） | ~4 行 | 环境配置不再可能随 zip 交付 |
| `client/package.json` 的 `test` 改 `jest`，`validate` 末尾加 `jest --ci --silent`（§7.9 I-13） | ~2 行 | 6 个已存在却从不运行的测试接入闸门 |

### 第 1 批：小改动、大收益（建议优先）

| 项 | 改动量 | 收益 |
| --- | --- | --- |
| **`GameNotice` 内层 View 加 `pointerEvents="none"`（§6.9 C-74）** | **1 行** | 修掉棋盘中部的 3 秒点击黑洞，并让代码与它自己的注释一致 |
| **`JueShaOverlay` 按钮区按淡入进度切 `pointerEvents`（§6.9 C-73）** | ~3 行 | 修掉"看不见的按钮吃掉本局结果" |
| **`GameEngine.createFromFen` 入口加 `isFenBoardWidthValid` + 坐标守卫；缺将时坐标守卫（§5.14 R-1/R-2）** | ~6 行 | **修掉本报告仅有的 2 个 P0**（畸形 FEN 导致客户端崩溃），且 `isFenBoardWidthValid` 已写好（`:697`，目前只被 `aiDispatcher.ts:349` 调用），只是没被 `createFromFen` 用上 |
| **`lanBattle` 步时倒计时改用 `Date.now() + serverTimeOffsetRef.current`（§6.7 C-40）** | 1 行 | 修掉"客户端自动替用户走随机棋"（用户可感知的最严重体验缺陷） |
| **步时在 `clockPausedAt` 非空时冻结（§6.7 C-41）** | ~3 行 | 协商期间不再自动走棋、不再静默吞掉悔棋/求和 |
| `ChessBoard` 最后一步标记改 `pieceSize * 0.8`（§6.9 C-75） | 1 行 | 恢复"上一步从哪来"的可见提示 |
| `GameNotice` 淡出回调加 `if (!finished) return`（§6.9 C-76） | 1 行 | 连续通知不再互相清空 |
| `useSafeRouter` 改 `Base64.encodeURI`（§6.1） | 1 行 | 修掉约 37% 跳转丢参数，且解码端无需改 |
| `useBattleStateSync` 断线倒计时加 `serverTimeOffsetRef`（§4.4） | 1 行 | 修掉跨设备倒计时错乱 |
| WS 通道补 4xx 回推（§3.3）+ 计数器按房间隔离（§3.4） | ~10 行 | 修掉非法落子留在盘上 |
| 大厅四个 fetch 补 `response.ok` 检查（§6.8 C-55~C-58） | ~8 行 | 不再因异常响应清空房间列表/`activeRoom` |
| 观战页传 `turnTimeLimitRef`（或让 hook 调 `setTurnTimeLimit`）（§6.8 C-53） | 1~2 行 | 限时步时的房间观测端恢复倒计时 |
| `countdownTimerRef` 补 unmount cleanup（§6.7 C-44） | 1 行 | 不再有卸载后的"鬼开局/鬼上传" |
| `ChessBoard`/`BoardEditor` 改用 `useWindowDimensions()`（§6.9 C-77） | 2 行 | Web 缩放窗口/分屏后棋盘不再与结算浮层错位 |
| `RoomSettingsControls` 选中判定改为按 value（§6.9 C-82） | 1 行 | 「不限时/关闭」这类 0 值选项恢复选中态 |
| `handicapSummary(ids = [])` 补默认值（§6.8 C-71） | 1 行 | 协议漂移时不再白屏 |
| 删除 `/health` 的日志（§3.12） | 1 行 | 日志可用性 |
| `playerIdentity` 改用 `expo-crypto`（§4.13） | ~5 行 | 身份不可枚举 |
| 删除死代码：`battleSocket.send()`、`emitBattleAction()`、`revealTimerRef`、`MoveCheck.isKilledPoint`、`isHost` 路由参数、`ChessBoard` 的一批几何死导出与 `RED_SIDE/BLACK_SIDE` import、`JueShaOverlay.CENTER_OFFSET_X/Y`、`BoardStyleModal.headerIcon`（§6.7 C-47/C-52、§5.14 R-11、§6.8 C-72、§6.9 C-85/C-86/C-87/C-90） | 删除 | 减少误读与"看似有防护"的假象 |
| `AppDialog` 单键时不再把返回键接到 `onConfirm`（§6.9 C-79） | 1 行 | 预防未来「删除/认输/退出」类弹窗被返回键误确认 |
| 注释行号改指 `src/`（§7.1、§6.9 C-94）；修正 `GameEngine.ts:199-206` 的照面注释（§5.14 R-10） | 文本 | 维护性 |

### 第 2 批：需要设计决策

| 项 | 为什么需要决策 |
| --- | --- |
| **服务端身份认证（§3.1）** | 影响所有路由的入参契约与客户端持久化；建议先做"进房签发 token"的最小版本 |
| **悔棋改为服务端快照（§3.2）** | 需要服务端保存历史快照栈，涉及内存与房间 GC |
| **旧协议分支下线（§3.8）** | 需要确认现网客户端版本分布 |
| **`playerId`→`sessionToken` 迁移（§3.1）** | 需要客户端与观战端同步改，且要兼容旧版本 |

### 第 3 批：结构性改善

| 项 | 说明 |
| --- | --- |
| **给 `screens/` 补测试**（§2.1） | 本次发现的 4 个客户端 P1 全部落在零测试区。建议从 `battleSocket`/`useBattleStateSync`/`GameSave`/`EndgameProgress` 这几个"纯逻辑 + 少量依赖"的模块开始，成本低、回归价值高 |
| **抽出跨通道公共层** | 把"动作执行 → 结果广播 → 4xx 回推"收成一份，让 HTTP / WS 两通道共用（根治 §8 表的 #1、#5） |
| **`game/index.tsx` 拆分** | 76.1KB 单文件、职责包含棋盘交互 + AI 调度 + 存档 + 计时 + 提示 + 复盘；`lanBattle/index.tsx` 更达 166.3KB。建议按 hook 拆分（`:743-754` 与 `:563-565` 这类"两条分支防护强度不同"的问题，正是单文件过大导致的） |
| **统一"服务端时间"抽象** | 提供 `serverNow()` 一处出口，杜绝再出现"本机时钟减服务端时间戳"（§4.4、`:324`） |
| **统一失败响应形状** | 目前至少三种：`{ success:false, message }`、`{ error }`、WS 的 `{ type:'error', message }` |

### 9.1 第 0 / 1 批修复完成记录

第 0 批（5 项）先让闸门真的能拦住，第 1 批（20 项）是小改动大收益。全部已落地并复跑闸门。

#### 第 0 批（先让闸门真的能拦住）

| 项 | 落地位置 | 落地形态 |
| --- | --- | --- |
| I-9 `--only` 区名不存在即失败 | `chinese-chess-server/build.js` 比对循环之后、`if (failed === 0)` 之前 | 两段守卫：`--only` 未知区名时列出 11 个可用区名 + `exit 1`；无 `--only` 时断言两侧存在 `src/` 前缀区，否则报错 + `exit 1`。实测 `--only src/routes/doesNotExist.ts` → `EXIT=1`，`--only src/routes/lanGame.ts` → `1445/1445 IDENTICAL, EXIT=0`，全量 → 11 区域全 IDENTICAL |
| I-10 切区后断言 `src/` 锚点存在 | 同上（第二段守卫） | 两侧锚点同时消失时不再降级为 `INFO` 区通过 |
| I-11 先校验后删旧包 | `pack.ps1`：新增 `Assert-ServerDistFresh`，在 `$needServerCheck` 分派前调用；`New-ServerZip` 内删掉原校验块。`pack.sh`：新增 `assert_server_dist_fresh()`，在 `case` 分派前执行 | 校验失败不再把上一版可用包删掉 |
| I-12 `.env` 进入排除面与自检 | `pack.ps1` 的 `$ExcludeCommon` + `Assert-NoJunk` 的 `$junkPattern`；`pack.sh` 的 `zip -x` 列表与 `JUNK_RE` | `.env` / `.env.*` / `*.env` / `.verify-old` 均被排除并被自检覆盖 |
| I-13 jest 接入闸门 | `client/package.json` `test` 改 `jest`、新增 `test:ci`；`chinese-chess-client/package.json` 新增 `test:client` 并追加进 `validate` | `pnpm validate` = lint + 两条 parity + `jest --ci --silent` |

#### 第 1 批（20 项）

- **C-74 / C-76（GameNotice）**：内层 `View` 加 `pointerEvents="none"`（`box-none` 只作用于本节点）；淡出回调改 `.start(({ finished }) => { if (!finished) return; … })`。
- **C-73（JueShaOverlay）**：新增 `buttonsReady`，非绝杀 300ms / 绝杀 `2500+400`ms 后才置 `true`，按钮区 `pointerEvents={buttonsReady ? 'box-none' : 'none'}`，`noticeArea` 加 `pointerEvents="none"`。
- **R-1 / R-2（规则引擎）**：`createFromFen` 入口加 `isFenBoardWidthValid` 守卫（非法退化为空棋盘，不抛）；`isJiangJun` 与 `afterMoveStillJiangJun` 加缺将坐标守卫。**新增回归测试 `client/utils/chess/__tests__/malformedFen.test.ts`**（11 用例覆盖超宽行 / 缺行 / 空串 / 非法字符 / 缺将）。
- **C-40 / C-41 / §4.4 / C-53（步时）**：`lanBattle` 与 `useBattleStateSync` 统一改用 `Date.now() + serverTimeOffsetRef.current`；`clockPausedAt` 非空时冻结，不触发 `doRandomMove()`；`useBattleStateSync` 现在真的调 `setTurnTimeLimit`（此前声明却不调用），`spectate` 补传 `turnTimeLimitRef`。
- **C-75**：最后一步标记 `pieceSize * unitScale * 0.8` → `pieceSize * 0.8`（原式把 scale 乘两次）。
- **§6.1**：`serializeParams` 改 `Base64.encodeURI`（`decode` 两种字母表都能解，历史链接兼容）。
- **§3.3 / §3.4（服务端）**：新增 `shouldSyncRejection`（限流状态挂 Room，不再是模块全局），`respondAction` 与 `battleWs` 的 WS 回执共用；被拒动作（4xx）按房间限流补推权威状态。
- **C-55 ~ C-58**：大厅四个 fetch 补 `response.ok`；创建/加入两处按 `!response.ok && response.status >= 500` 抛（保留 4xx 的 `data.error` / `needPassword` 业务语义）。
- **C-44**：`countdownTimerRef` 补 unmount cleanup。
- **C-77**：`ChessBoard` / `BoardEditor` 改用 `useWindowDimensions()`。
- **C-82**：`SettingSelect` 选中判定改按 `value`（8 个调用点同步传值）。
- **C-71**：`handicapSummary(ids = [])` 补默认值。
- **§3.12**：`/api/v1/health` 删掉每次请求的 `console.log`。
- **§4.13**：`playerIdentity` 改用 `expo-crypto` 的 `randomUUID`。
- **死代码删除**：`battleSocket.send()`、`emitBattleAction()`、`revealTimerRef`、`MoveCheck.isKilledPoint`、`isHost` 路由参数、`ChessBoard` 的一批几何死导出 + `RED_SIDE/BLACK_SIDE` import、`JueShaOverlay` 的 `GRID_*`/`CENTER_OFFSET_*`、`BoardStyleModal.headerIcon`、`lanGame` 里两处遗留 `var`。
- **C-79**：`AppDialog` 单键时 `onClose` 传空操作 + `blockBackButton || !hasCancel`，返回键不再落到确认。
- **I-1 / C-94 / R-10**：注释里指向 `dist/index.js` 的行号全部改指 `src/`（含 `battleProtocol/types.ts`、`battleSocket.ts`、`aiDispatcher`、`lanBattle`、`ruleEngine.bundle.ts`、`ruleEngineParity.test.ts`）；`GameEngine.ts` 照面注释订正为"照面着法在全仓按非法拦下"。

#### 闸门复跑（全部绿）

| 闸门 | 结果 |
| --- | --- |
| 服务端 `tsc --noEmit` | exit 0 |
| 客户端 `tsc --noEmit` | exit 0 |
| 客户端 `eslint ./ --quiet` | exit 0（C-73 的 `setButtonsReady(false)` 加了带理由的 `react-hooks/set-state-in-effect` 豁免） |
| `node build.js` + `node build.js --check` | 11 区域全 IDENTICAL，`dist/index.js` 1391632 B / md5 `4b7aa67d353a983cf090f1d98a1c6110` |
| `verify-rule-engine-parity.mjs --write` + check | exit 0，36079 字节 |
| `verify-server-hardening.cjs` | 32 项断言全过 |
| `verify-lan-disconnect.cjs` | 25 项断言全过 |
| 客户端 jest（cwd=`chinese-chess-client/client`） | 7 suites / 102 tests 全 PASS |
| `pack.ps1 all` | client zip 3.1 MB、server zip 4.6 MB，无 `.env` / `node_modules` / `.verify-old` |

### 9.2 第 2 批修复完成记录

第 2 批 4 项（S-1 身份认证 / S-2 悔棋服务端快照 / S-8 旧协议下线 / `playerId`→`sessionToken` 迁移）已全部落地。无现网分发，故不做旧版本兼容。

#### 服务端（`chinese-chess-server/src/routes/lanGame.ts`、`battleWs.ts`、`ruleEngine.d.cts`）

- **S-1 会话凭证鉴权**：新增 `issueSessionToken()`（`crypto.randomBytes(32).toString('base64url')`）、`tokenEquals()`（`timingSafeEqual`）、`readSessionToken()`（header → body → query）、`findPlayerByToken()`、`stripPlayerToken()` / `stripRoomTokens()`。`Player` 新增 `sessionToken` 字段（绝不下发）。所有 `act*` 签名统一为 `actX(roomId, _body, sessionToken)`，鉴权前置到业务判断之前。`POST /rooms` 与 `POST /join` 签发 token；`POST /reconnect`、`POST /leave`、`PATCH /settings`、`actStart`、`actMove`、`actSurrender`、`actRematch`、`actReturnToRoom`、`actUndo`、`actUndoResponse`、`actDraw`、`actDrawResponse`、`actEmoji`、`actHeartbeat` 全部改按 token 鉴权。`battleWs.ts` 连接握手三重校验（缺 token / token 不匹配 / playerId 不匹配），WS 动作全部透传 token。
- **S-2 悔棋服务端快照**：`Room` 新增 `stateHistory: any[]`（`STATE_HISTORY_MAX = 200`）。`actMove` 走子前 `push(state)`（存引用，因 `makeMove` 返回全新状态）。`actUndo` 不再接收 `proposedState`。`actUndoResponse` 同意分支改为服务端回退：`UNDO_DEPTH = 2`，栈不足返回 `409 {reason:'no_snapshot'}`；否则 `room.gameState = room.stateHistory[length - 2]` 并截断栈，同时复位 `phase/winner/endReason/surrenderBy`。
- **S-8 旧协议下线**：`actMove` 删除整个旧协议分支（完整 `gameState`/`gameOver`/`winner` 采纳），改为仅接受 `{move}`，否则 `400`。路由 `POST /rooms/:roomId/gameState` 改名为 `POST /rooms/:roomId/move`。新增落点越界守卫。`startPlayingRoom()` 成为开局唯一落地入口（兼修 S-19 两条开局路径口径不一致）。
- **S-10 兼修**：`actDrawResponse` 同意分支补 `room.clockPausedAt = null; room.pendingUndo = null;`。
- **S-7 兼修**：`PATCH /settings` 房主判定从 `room.players[0]?.id` 改为 `findPlayerByToken` + `actor.id !== room.hostId`。
- `ruleEngine.d.cts` 补 `createInitialState` / `applyHandicap` 声明；`ruleEngine.bundle.ts` 补 `applyHandicap` 导出。

#### 客户端（`client/utils/playerIdentity.ts`、`screens/lanGame/index.tsx`、`screens/lanBattle/index.tsx`、`utils/battleSocket.ts`）

- `playerIdentity.ts` 新增房间级 token 存取（`setRoomSessionToken` / `getRoomSessionToken` / `peekRoomSessionToken` / `clearRoomSessionToken`，key = `lan_session_token_${roomId}__${playerId}`，内存 Map 同步缓存）。
- `lanGame/index.tsx` 创建/加入成功后 `await setRoomSessionToken(...)` 再跳转。
- `lanBattle/index.tsx` 新增 `sessionTokenRef` + 凭证恢复 effect；所有写请求加 `x-session-token` 头；`HTTP_ACTION_PATH.move` 改 `'move'`；`sendBattleAction` HTTP 兜底补 `response.ok` 检查 + 403 清 token + `handleSessionGone`；`uploadInitialGame` 删除上传初始局面两步（S-8 后服务端自建）；`handleUndo` 不再算 `proposedState`；`handleSessionGone` 末尾清 token。
- `battleSocket.ts` `constructor` 新增第 5 参 `getSessionToken`，`connect()` 拼 `&sessionToken=`，`FATAL_ERROR_MESSAGES` 新增两条拒绝文案。

#### 验证脚本（`chinese-chess-server/scripts/`）

- `verify-server-hardening.cjs` 重写：删除依赖旧协议的 A0/B1~B4/B5 组，新增 `scenarioSessionAuth`（B=鉴权 10 项）、`scenarioUndoSnapshot`（S2=悔棋快照 7 项）、`scenarioLegacyProtocolRemoved`（S8=旧协议下线 6 项）。`post()` 第三参 token。
- `verify-lan-disconnect.cjs` 全部写操作补 token。

#### 闸门复跑（全部绿）

| 闸门 | 结果 |
| --- | --- |
| 服务端 `tsc --noEmit` | exit 0 |
| 客户端 `tsc --noEmit` | exit 0 |
| 客户端 `eslint ./ --quiet` | exit 0 |
| `node build.js --check` | 11 区域全 IDENTICAL，`dist/index.js` 1393783 B / md5 `033fa5f5234eb1296b33aaae9199f42b` |
| `verify-rule-engine-parity.mjs` | exit 0，36521 字节 |
| `verify-server-hardening.cjs` | 39 项断言全过 |
| `verify-lan-disconnect.cjs` | 25 项断言全过 |
| 客户端 jest | 7 suites / 102 tests 全 PASS |
| `pack.ps1 all` | client zip 3.1 MB、server zip 4.6 MB，BOM `EF BB BF` |

---

### 9.3 第 3 批修复完成记录

第 3 批 5 项（§2.1 补测试 / 抽出跨通道公共层 / `game/index.tsx` 拆分 / 统一「服务端时间」抽象 / 统一失败响应形状）已全部落地。

#### ① 抽出跨通道公共层 —— 根治 §8 表 #1、#5

**新增 `chinese-chess-server/src/routes/actionOutcome.ts`（162 行）**，成为动作结算的**唯一**实现。改造前 `lanGame.ts` 的 `respondAction`（HTTP）与 `battleWs.ts` 的 `handleMessage` 尾部（WS）把同一个语义写了两遍，且只有前者做了「被拒动作也回推权威状态」的限频加固：

- `failBody(status, message, extra?, code?)` —— 唯一的失败 body 构造器；
- `actionFailure(status, message, extra?, code?)` —— 动作层拒绝的单一入口；
- `interface ActionResult` 从 `lanGame.ts` 移到这里（动作结果不再由 HTTP 路由模块定义）；
- `settleActionOutcome(roomId, result)` —— 「动作执行 → 广播 → 4xx 限频回推」的唯一决策点，HTTP 与 WS 都只调它，口径无法再分叉；
- `shouldSyncRejection(roomId, status, nowMs)` —— 签名从 `(roomId, result)` 改为注入 `nowMs`，使限流判定可测；限流常量 `REJECTION_SYNC_WINDOW_MS = 3000` / `REJECTION_SYNC_LIMIT = 8`；
- `registerRoomAccess(lookup, broadcast)` —— **用注入而不是 `import { rooms }`**：直接导入会形成 lanGame ↔ actionOutcome 循环依赖，而两个模块都带顶层副作用（lanGame 有 `setInterval` GC 与 gameTick），ESM 循环导入会在初始化顺序上留下真实的坑。

`lanGame.ts` 46 处内联失败字面量 + 31 处 `res.status().json()` 失败全部改走 `failBody` / `actionFailure`（改造后文件内零字面量失败 body）。`battleWs.ts` 的重复广播块换成 `settleActionOutcome`，9 处握手拒绝收敛为 `rejectHandshake(ws, status, message)`（其文案被客户端 `FATAL_ERROR_MESSAGES` 逐字匹配，改文案即改客户端分类）。

**§8 #5 终局字段清理**同步根治：新增 `clearEndedNegotiations(room)`（清 `clockPausedAt` + `pendingUndo`/`undoResult`/`pendingDraw`/`drawResult`），6 条终局路径（断线判负 / 超时判负 / `settleAbandonedPlayingRoom` / `actMove` 终局 / `actSurrender` / `actRematch` / 求和达成）全部改调它。原先求和达成只清 `clockPausedAt` + `pendingUndo`，遗留 `undoResult`/`drawResult`。

**顺带修掉一个形状统一暴露的真 bug**：畸形 JSON 请求体此前落到 `index.ts` 的全局 500 分支，返回 `internal_error` / 「服务器内部错误」，而客户端把 `status >= 500` 当作「服务端故障，请重试」——一次客户端 bug 会被当成服务端问题提示用户重试。现按 body-parser 的 `err.type === 'entity.parse.failed'` 精确降级到 `400`；`index.ts` 的 API-404 兜底也改走 `failBody`。`internal_error` 已登记进 `FAILURE_CODES`。

#### ② 统一失败响应形状

全端只剩一种失败形状：`{ success: false, error: <snake_case 机器码>, message: <可展示文案>, ...附加字段 }`。`error` 是稳定的机器码（沿用 `ai.ts` 既有的 `invalid_fen` 约定），`message` 是文案。状态码分级沿用第 2 批口径，未改动：**403 = 身份校验失败**（房间内动作的 token 问题），**401 = 房间密码**。

客户端随之收口：`battleAckMessage` 只读 `body.message`（删掉 `body.message ?? body.error` 双读兜底）、`lanGame/index.tsx` 的建房错误改读 `data.message`。全客户端已无任何把 `error` 当人读文案的路径。

#### ③ 统一「服务端时间」抽象 —— 根治 §8 表 #7

**新增 `client/utils/serverClock.ts`**：`serverNow(offsetRef)` / `applyServerNow(offsetRef, serverNowMs)` / `serverElapsedMs(offsetRef, sinceServerMs, fallbackMs?)` / `serverRemainingSec(offsetRef, totalSec, startMs)` + `interface ServerTimeOffsetRef`。`applyServerNow` 只在 `typeof === 'number' && Number.isFinite` 时写入，所以畸形载荷不会把已有的正确偏移清零。

改造掉 15 处「本机 `Date.now()` 减服务端时间戳」（改造后全客户端仅 `serverClock.ts` 的文档注释里还留着这个写法）：`useBattleStateSync` 4 处（clockSnap 兜底 / 对局时长 / 断线倒计时 / 偏移写入）、`useBattleClock` 1 处、`spectate` 2 处、`lanBattle` 9 处（含删掉本地遮蔽 lambda `const serverNow = () => ...`）。

**刻意保留裸 `Date.now()` 的**：去抖/节流/动画/AI 截止/本地存档时间戳等纯本地计时器（`battleSocket` 心跳、`AIEngine`、`aiDispatcher`、`useMoveEffect`、`serverConfig`、`savePveReplay` 的 `timestamp` 等）。判据写在 `serverClock.ts` 的模块注释里：**服务端时间轴 → `serverClock`；纯本地计时 → 裸 `Date.now()`**。

#### ④ `game/index.tsx` 拆分

`1673 行 / 77973 B → 1548 行 / 72281 B`，并**顺带根治 §8 表 #8**（AI 分支有代数校验 `:563-565`、玩家分支 `:743-754` 没有 → 音效播放期间重开会被旧着法覆盖）：代数守卫 `gameGenRef` 随 `usePendingAIMove` 一起抽出，玩家分支经 `invalidatePendingAI()` 拿同一把守卫。

| 新文件 | 行 | 抽出内容 |
| --- | --- | --- |
| `hooks/usePendingAIMove.ts` | 102 | AI 代数守卫 + 调度 + 票据作废（`AI_MOVE_DEFAULT_DELAY_MS = 500`） |
| `hooks/useNewGame.ts` | 198 | `confirmRestart` / `handlePlayAgain` / `handleNextLevel` 三份近乎相同的 15 字段重置逻辑收成一处 |
| `hooks/useGameBoardLayout.ts` | 150 | 棋盘布局预算 + frame + 棋盘尺寸 + 让子框重测量 |

另删掉模块级死代码 `const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window')`（两个名字都无人使用，C-77 的实例之一）。

#### ⑤ 给零测试模块补测试

新增 6 个套件 + 扩写 1 个，客户端 jest 从 **7 suites / 102 tests → 13 suites / 318 tests**：

| 套件 | 覆盖 |
| --- | --- |
| `utils/__tests__/serverClock.test.ts`（新增 24） | 偏移正负/为 null、畸形 `serverNow` 不污染已有偏移、时钟偏斜免疫、夹取到 0 |
| `hooks/__tests__/useBattleStateSync.test.tsx`（新增 47） | 该 hook 存在的理由：局面被乐观保护延迟时**控制信息不得被吞掉**（phase/ended/断线/协商）；8s 窗口的释放与超时；断线倒计时；协商与拒绝上限；rematch 跟随；动作被拒回滚 |
| `hooks/__tests__/useNewGame.test.tsx`（新增 22） | **15 个重置字段的全覆盖**（这正是去重的意义）、调用顺序、ref 清理、让子房 AI 先走 |
| `hooks/__tests__/usePendingAIMove.test.tsx`（新增 19） | 票据作废、代数单调、重复调度只留最后一次、卸载清理 |
| `utils/__tests__/GameSave.test.ts`（新增 29） | 往返、`isValidGameSave` 逐字段校验、存储失败不抛出 |
| `utils/__tests__/EndgameProgress.test.ts`（新增 48） | 解锁推进、皇冠档位、存档往返、自定义残局增删改、**删自定义残局同时清皇冠记录** |
| `utils/__tests__/battleSocket.test.ts`（14 → 41） | 动作请求与回执契约；**失败文案只读 `message`、绝不当机器码展示**；ack 2xx/4xx 分流；非致命错误帧；畸形帧容错 |
| `chinese-chess-server/scripts/verify-action-outcome.cjs`（新增 116 项断言） | 两个通道**并排**断言失败形状与回推口径——这是唯一能证明「同源」的方式，分开写就又回到 §8 #1 的老问题 |

**新增测试基建 `hooks/__tests__/hookHandle.ts`**：项目没有 `@testing-library/react-hooks`，hook 只能靠 `react-test-renderer` 挂到一次性 Probe 组件上再把返回值取到组件外断言，而这一步（渲染期写回外部变量/对象属性）会被 eslint 的 `react-hooks/globals` 与 `react-hooks/immutability` 拦下。解法是把句柄挂到 `globalThis` 的私有 key 上，规则不覆盖，且不引入真实副作用。

#### 顺带修正的文档失真

- `battleSocket.ts` 的 `rejectPending` 注释原称「连接断开时调用」，实际 `onclose` **不**调它——在途请求会等满 5s 回执超时。这是**正确**的行为（断连时帧可能已送达并生效，立刻 reject 会把「结果未知」谎报成「未送达」，页面据此重试就可能重复执行一次已生效的着法），已改正注释并把测试拆成「断连→超时」与「主动 close→立即失败」两条。
- `battleProtocol/types.ts` 对被拒回推的说明仍指向已移走的 `lanGame.ts` / `battleWs.ts` 行号，已改指 `actionOutcome.ts`。

#### 闸门复跑（全部绿）

| 闸门 | 结果 |
| --- | --- |
| 服务端 `tsc --noEmit` | exit 0 |
| 服务端 `node build.js` | `dist/index.js` 1393793 B |
| `node build.js --check` | 11 区域全 IDENTICAL（含新增的 `src/routes/actionOutcome.ts` 74 行区） |
| `verify:rule-engine-parity` | exit 0，36899 字节 |
| `verify-action-outcome.cjs`（新增） | **116 项断言全过** |
| `verify-server-hardening.cjs` | 39 项断言全过 |
| `verify-lan-disconnect.cjs` | 25 项断言全过 |
| 客户端 `pnpm -w lint` | exit 0 |
| 客户端 jest | **13 suites / 318 tests 全 PASS** |

---

## 10. 附：审计方法与可复现命令

### 10.1 环境

```powershell
# node / pnpm 不在 PATH，使用 DSH 内置运行时
$node = "C:\Users\hthot\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin"
$env:PATH = "$node;$env:PATH"
```

### 10.2 全部校验命令

```powershell
# 服务端类型检查
Set-Location D:\Code\ChineseChess\chinese-chess-server
& "$node\node.exe" node_modules/typescript/bin/tsc --noEmit

# 服务端 dist ↔ src 一致性（本次：11 区域 IDENTICAL）
& "$node\node.exe" build.js --check

# 两端规则引擎同源（本次：35541 字节一致）
& "$node\node.exe" scripts/verify-rule-engine-parity.mjs

# 客户端类型检查
Set-Location D:\Code\ChineseChess\chinese-chess-client\client
& "$node\node.exe" node_modules/typescript/bin/tsc --noEmit

# 客户端测试（非 watch 模式；本次：6 suites / 91 tests 全通过）
# 注意：必须在本目录下运行——chinese-chess-client/ 根目录与仓库根都没有 node_modules/jest
& "$node\node.exe" node_modules/jest/bin/jest.js --watchAll=false --ci

# 服务端行为层测试（构建与校验链专项审计读过源码，本次审计未运行；建议后续补跑）
& "$node\node.exe" scripts/verify-server-hardening.cjs
& "$node\node.exe" scripts/verify-lan-disconnect.cjs
# 差分闸门需要 .dsh-work/dist-baseline-20261002.js 存在（见 §7.9 I-15）
& "$node\node.exe" scripts/verify-server-diff.cjs

# 打包自检（会删除并重建 zip，谨慎运行；见 §7.9 I-11）
# powershell -NoProfile -ExecutionPolicy Bypass -File .\pack.ps1 all
```

### 10.3 关键取证脚本（本次实际运行）

**base64 路由载荷 URL 安全性**（工作目录 `chinese-chess-client/client`，require 用裸包名）：

```js
const { Base64 } = require('js-base64');
const names = ['七星聚会','野马操田','蚯蚓降龙','千里独行','带子入朝','火烧连营','车马冷着',
               '双车错杀','房间一','张三的房间','棋友对局','测试房间','A房间','甲乙丙丁',
               '炮碾丹砂','送佛归殿','海底捞月','三子归边','胆大穿心'];
let slash = 0;
for (const n of names) {
  const e = Base64.encode(JSON.stringify({
    roomId: '123456', playerId: 'player_1759300000000_ab12cd', name: n, isHost: true,
  }));
  if (e.includes('/')) slash++;
}
console.log(`样本 ${names.length} | 含 "/" : ${slash}`);   // → 样本 19 | 含 "/" : 7
```

**其余取证**：`git status --porcelain`（干净）、`Get-ChildItem`（目录清单与体积）、`grep router.push/replace/navigate`（20 处跳转点）、`grep reqId`（两端 ack 契约）。

### 10.4 严重度判据（本报告所用）

| 级别 | 判据 |
| --- | --- |
| **P0** | 崩溃、不可恢复的数据丢失、或可被大规模滥用的资源/资金漏洞。**本报告 2 条均为"客户端在处理畸形 FEN 时崩溃"** |
| **P1** | 对局结果错误；常见路径下功能失效；安全边界可被绕过；**或"客户端替用户做出对局决策"** |
| **P2** | 边角场景错误；状态不一致；可观测性缺失；UI 承诺与事实不符 |
| **P3** | 代码质量、一致性、可维护性、文档准确性 |

> 补充说明本报告的两条定级判断，避免读者觉得"为什么这个算 P1/不算 P1"：
> - `§4.3` 的 C-1（`send()` 的 reqId 格式）**保留 P1 但可达性为零**——因为它所在的方法已是死代码；定级依据是"工具类里摆着一个会静默清空协商状态的公开 API"。
> - `§6.7` 的 C-40（步时倒计时时钟域）定为 P1 而非 P2，是因为它不只是"显示错"，而是**会让客户端自动替用户走一步棋**——这是对局结果的直接污染。同理 C-41（协商期间不停表）也会产生一步用户没下的棋。

---

## 11. 附：按文件索引的全部发现

> 便于按文件排期。行号为本次审计读到的源码行号。
>
> 本章按严重度优先排序为：**§11.0 棋盘/浮层/共享组件（C-73 ~ C-94，含 2 条 P1）** → §11.1 服务端与通信 → §11.2 客户端核心 → §11.3 页面 → §11.4 规则引擎与 AI → §11.5 lanBattle → §11.6 大厅与观战 → §11.7 补充审计（C-95 ~ C-123，含 2 条 P1）。

### 11.0 棋盘、浮层与共享组件（C-73 ~ C-94）

| 文件 | 行号 | 编号 | 级别 | 一句话 |
| --- | --- | --- | --- | --- |
| `client/components/JueShaOverlay.tsx` | 294（关联 149-152, 177, 359-364） | C-73 | **P1** | 按钮淡入前 2.5s `opacity:0` 但仍在命中区，误触重开/退出 |
| `client/components/Modal/GameNotice.tsx` | 131（关联 125-130, 156-163） | C-74 | **P1** | 内层 View 未设 `pointerEvents`，提示条可见的 3s 内吞掉棋盘中部点击 |
| `client/components/ChessBoard.tsx` | 458 | C-75 | P2 | `pieceSize * unitScale * 0.8` 把缩放乘了两次（scale²），标记小到看不见 |
| `client/components/Modal/GameNotice.tsx` | 68-77 | C-76 | P2 | 淡出回调不判 `finished`，连续通知时新通知被旧回调清空 |
| `client/components/ChessBoard.tsx` | 233, 895（+`BoardEditor.tsx:34`） | C-77 | P2 | `Dimensions.get()` 一次性取值，窗口变化不重排棋盘并与结算浮层错位 |
| `client/components/ChessBoard.tsx` | 324-344, 359-361 | C-78 | P2 | 在 `setState` 更新函数内启动动画并写 ref（不纯 + `isInitialLoad` 死分支） |
| `client/components/Modal/AppDialog.tsx` | 67 | C-79 | P3 | 单键对话框的 `onClose` 指向 `onConfirm`，返回键会执行确认 |
| `client/components/Modal/AppModal.tsx` | 124-130 | C-80 | P3 | Web 上静默忽略 `dismissOnMaskPress`（当前无调用方传 true） |
| `client/components/Modal/ModalButton.tsx` | 100-102 | C-81 | P3 | secondary 禁用字色被强制 `#FFFFFF`，浅底上几乎不可见 |
| `client/components/RoomSettingsControls.tsx` | 79, 82 | C-82 | P3 | 按 label 文本全等判选中，值为 0 的选项（「不限时/关闭」）永不高亮 |
| `client/components/RoomSettingsControls.tsx` | 144-147, 184-187 | C-83 | P3 | 下拉面板裸 `zIndex:100/elevation:10`，与同文件 token（50/50）口径不一 |
| `client/components/ChessBoard.tsx` | 404-406（注释 9, 800） | C-84 | P3 | 注释称已消除 `pieces.find()`，点击路径仍留一次 |
| `client/components/ChessBoard.tsx` | 11-14, 65-94 | C-85 | P3 | 一批几何常量为死导出，注释称被 BoardEditor 复用（且尺寸已陈旧） |
| `client/components/ChessBoard.tsx` | 23 | C-86 | P3 | 未使用的 import `RED_SIDE, BLACK_SIDE` |
| `client/components/JueShaOverlay.tsx` | 58-59 | C-87 | P3 | `CENTER_OFFSET_X/Y` 定义后从未使用 |
| `client/components/JueShaOverlay.tsx` | 163-165 | C-88 | P3 | 兜底几何硬编码旧样式 631/842（当前调用方都传 `boardFrame`，分支不可达） |
| `client/components/JueShaOverlay.tsx` | 107-154 | C-89 | P3 | 动画 effect 没有清理函数 |
| `client/components/BoardStyleModal.tsx` | 125-133 | C-90 | P3 | `headerIcon` 样式定义后从未被引用 |
| `client/components/BoardStyleModal.tsx`、`RoomSettingsControls.tsx` | 22-29、11-19 | C-91 | P3 | 各自复制一份硬编码色板，未用 `constants/modal.ts` 的同值 token |
| `client/hooks/useMoveEffect.ts` | 42-52（文档 8，吃子分支 54-58） | C-92 | P3 | 将军冷却期内连带跳过同一步的吃子特效（`return null` 让吃子分支走不到） |
| `client/components/BoardEditor.tsx` | 34-36 | C-93 | P3 | 摆棋编辑器缩放不含高度预算，与对局页棋盘尺寸口径不一致 |
| 多处（客户端） | 见 §6.9 | C-94 | P3 | 注释仍引用已废弃的 `dist/index.js` 行号（含 `aiDispatcher.ts:394`、`ruleEngine.bundle.ts:2,13` 等） |
| `client/screens/home/index.tsx` | 63-90, 158 | C-123 | P3 | 有存档但 `loadGame()` 返回 null 时不清 `savedGameInfo`；`loadProgress()` 无 `.catch`；闯关分母只算内置 30 关而分子含自定义 → 可显示 `31/30` |

### 11.1 ~ 11.6 其余索引

> 便于按文件排期。行号为本次审计读到的源码行号。
>
> **编号按「审计批次」分段、不保证连续**：`S-n` = 服务端（n=1..25）、`I-n` = 基础设施（n=1..7）、`R-n` = 规则引擎与本地 AI（n=1..11）、`C-n` = 客户端。客户端编号出现过两轮重排（一次在补齐联机页时、一次在补齐棋盘组件时），因此 **C-29 ~ C-39 是空缺号段，对应的发现并未丢失**——它们的位置见 §6.7（C-40 起）与 §6.6。少量发现横跨两个批次，故表中以 `C-7 / C-26` 这类斜杠形式列出（同一处代码的同一问题，两章各有侧重）。

| 文件 | 行号 | 编号 | 严重度 | 一句话 |
| --- | --- | --- | --- | --- |
| `server/src/index.ts` | 14-16 | S-11 | P2 | CORS 全开 + 50MB JSON 上限 |
| `server/src/index.ts` | 18-21 | S-12 | P2 | `/health` 每次请求打日志 |
| `server/src/index.ts` | 49-56 | S-15 | P2 | 全局异常处理器掩盖崩溃 |
| `server/src/routes/lanGame.ts` | 165 | S-4 | P1 | 拒绝回推限流计数器是全局变量 |
| `server/src/routes/lanGame.ts` | 174-194 | S-3 | P1 | HTTP 通道的加固（对照 WS 缺失） |
| `server/src/routes/lanGame.ts` | 419, 954 | S-7 | P2 | 房主判定用 `players[0]` |
| `server/src/routes/lanGame.ts` | 428-441 | S-17 | P2 | 让子直分公示后无取消出口 |
| `server/src/routes/lanGame.ts` | 497 | S-23 | P3 | `endedSinceMap` 无 TTL |
| `server/src/routes/lanGame.ts` | 592-614 | S-19 | P2 | `tryAutoStart` 判据弱于 `actStart` |
| `server/src/routes/lanGame.ts` | 618-643 | S-25 | P3 | `gameTickTimer` 每秒 O(rooms) 且时间不一致 |
| `server/src/routes/lanGame.ts` | 648-661 | S-25 | P3 | `parseClockSettings` 两种超限策略 |
| `server/src/routes/lanGame.ts` | 915-916 | S-6 | P2 | 房间密码明文下发 |
| `server/src/routes/lanGame.ts` | 1026-1084 | S-16 | P2 | `actSide` 意向相同即锁定随机结果 |
| `server/src/routes/lanGame.ts` | 1235-1285 | S-20 | P2 | 新协议走子不校验 `makeMove` 结果；超时走子仍加秒 |
| `server/src/routes/lanGame.ts` | 1287-1336 | S-8 | P2 | 旧协议分支可上传任意局面与胜负 |
| `server/src/routes/lanGame.ts` | 1516 | S-18 | P2 | `actRematch` 无条件置 `connected = true` |
| `server/src/routes/lanGame.ts` | 1530-1531 | S-25 | P3 | `export` 与函数间的注释错位 |
| `server/src/routes/lanGame.ts` | 1573 | S-25 | P3 | `var RETURNED_GRACE_MS` 风格不一致 |
| `server/src/routes/lanGame.ts` | 1592 | S-21 | P2 | `actUndo` 不校验行棋方关系 |
| `server/src/routes/lanGame.ts` | 1669 | S-2 | P1 | 悔棋直接采纳客户端 `proposedState` |
| `server/src/routes/lanGame.ts` | 1740 | S-21 | P2 | `actDraw` 不校验行棋方关系 |
| `server/src/routes/lanGame.ts` | 1761-1767 | S-10 | P2 | 和棋成立后不清协商字段 |
| `server/src/routes/lanGame.ts` | 1830 | S-25 | P3 | heartbeat 失败体形状不统一 |
| `server/src/routes/lanGame.ts` | 1839-1845 | S-9 | P2 | `actHeartbeat` 完全信任 `hidden` |
| `server/src/routes/lanGame.ts` | 1866-1904 | S-1 | P1 | `reconnect` 无鉴权 |
| `server/src/routes/lanGame.ts` | 1944-1950 | S-22 | P2 | `/leave` 把结算态重置为等待中 |
| `server/src/routes/battleWs.ts` | 211 | S-25 | P3 | 畸形消息也能刷新活跃度 |
| `server/src/routes/battleWs.ts` | 283-287 | S-3 | P1 | WS 通道 4xx 不回推权威状态 |
| `server/src/routes/battleWs.ts` | 380 | S-25 | P3 | 连接建立即置 `connected = true` |
| `server/src/routes/ai.ts` | 28-33 | S-24 | P3 | 租约常量靠注释维持与 job 超时的关系 |
| `server/src/routes/ai.ts` | 59-81 | S-14 | P2 | FEN 校验只查行宽 |
| `server/src/routes/ai.ts` | 86-215 | S-5 | P1 | `/ai/move` 无鉴权、限流可绕过 |
| `server/src/services/pikafish.ts` | 136-148 | S-13 | P2 | Worker 脚本用 `process.cwd()` 探测 |
| `server/src/services/pikafish.ts` | 151-155 | S-24 | P3 | job 超时/宽限常量（与 `ai.ts` 耦合） |
| `server/src/services/pikafish.ts` | 259 | S-25 | P3 | 实例重建 fire-and-forget |
| `server/src/services/pikafish.ts` | 303-315 | S-25 | P3 | `pickNextJob` O(n) 扫描 |
| `server/src/services/pikafish.ts` | 346-351 | S-25 | P3 | STOP_GRACE 定时器未 unref |
| `server/src/services/openingBook.ts` | 26-38 | S-13 | P2 | 开局库用 `process.cwd()` 探测 |
| `client/hooks/useSafeRouter.ts` | 59-67 | C-24 | P1 | base64 含 `/`，37% 跳转丢参数 |
| `client/hooks/useSafeRouter.ts` | 47-57 | C-25 | P2 | 解码失败时把原生 query 当业务参数 |
| `client/hooks/useBattleStateSync.ts` | 288-302 | C-5 | P2 | 时钟快照仅在 `gameState` 存在时更新 |
| `client/hooks/useBattleStateSync.ts` | 319-322 | C-6 | P2 | 超时判负被归为 `checkmate` |
| `client/hooks/useBattleStateSync.ts` | 335-346 | C-4 | P2 | 乐观保护只比着法数，会被对手顶掉 |
| `client/hooks/useBattleStateSync.ts` | 408-411 | C-2 | P1 | 断线倒计时时钟域混用 |
| `client/hooks/useBattleStateSync.ts` | 472-480 | C-1 | P1 | `!action` 时误清两条协商线 |
| `client/utils/battleSocket.ts` | 196-202 | C-3 | P1 | 首次连接也触发 `onReconnected` |
| `client/utils/battleSocket.ts` | 411-416, 429 | C-1 | P1 | `reqId` 前缀与 `actionOf` 约定不匹配 |
| `client/utils/battleProtocol/types.ts` | 13-15, 163-164, 201-207 | C-10 / I-1 | P2 | 类型缺 `type`；注释指向废弃 dist 行号 |
| `client/utils/serverConfig.ts` | 24, 47-53, 59 | C-7 / C-26 | P2 | 无法清空地址 / `*.local` 误判 / 默认域名硬编码 |
| `client/utils/playerIdentity.ts` | 22-40 | C-11 | P3 | ID 可预测（约 31 bit，非加密随机） |
| `client/utils/chess/aiDispatcher.ts` | 97 | C-8 | P2 | 在线 AI 2s 超时 vs 服务端 15s |
| `client/utils/chess/aiDispatcher.ts` | 147-151 | — | P3 | `netInfoCache` 异常分支是死代码 |
| `client/utils/chess/aiDispatcher.ts` | 187-195, 220, 589-594 | C-9 | P2 | `invalid_move` 状态先被抹掉后粘滞 |
| `client/utils/chess/aiDispatcher.ts` | 447 | — | P3 | `busy` 退避 sleep 不可取消（累计 4.9s） |
| `client/utils/chess/onlineAI.ts` | 167-173 | C-8 | P2 | 先 `json()` 后查状态，非 JSON 计入熔断 |
| `client/utils/chess/onlineAI.ts` | 175-184 | — | P3 | 不校验 `data.move` 坐标类型 |
| `client/utils/GameSave.ts` | 43-58 | C-18 | P2 | 校验不覆盖 `moveCount`/`captured*` |
| `client/utils/GameSave.ts` | 108-115 | C-19 | P2 | `hasSave` 不校验结构 |
| `client/utils/chess/endgames.ts` | 62-159 | C-21 | P2 | 不校验"局面是否已分胜负" |
| `client/utils/EndgameProgress.ts` | 76-99, 111-123 | C-22 | P2 | 读-改-写无并发保护 |
| `client/utils/EndgameProgress.ts` | 89-92, 149-166, 200 | C-23 | P3 | 最高关/自定义 id/随机主键小项 |
| `client/screens/game/index.tsx` | 241-243 | C-23 | P3 | `replaySavedRef` 悔棋后不复位 |
| `client/screens/game/index.tsx` | 506-508 | C-16 | P2 | `aiMove === null` 时无人重排（软锁） |
| `client/screens/game/index.tsx` | 516-522 | C-23 | P3 | `alternatives` 为空时仍落违规着法 |
| `client/screens/game/index.tsx` | 743-754 | C-12 | P1 | `await` 后缺代数校验，重开被"复活" |
| `client/screens/game/index.tsx` | 815-816, 1345 | C-13 | P1 | AI 延迟窗口内悔棋可点（软锁） |
| `client/screens/game/index.tsx` | 844-848 | C-14 | P1 | 悔棋不回滚吃子计数 |
| `client/screens/game/index.tsx` | 752-771 | C-15 | P2 | 无重入保护，双击重复提交 |
| `client/screens/game/index.tsx` | 1085-1093 | C-17 | P2 | 提示基于 `await` 前快照 |
| `client/screens/game/index.tsx` | 1106 | C-23 | P3 | `handleHint` 依赖数组缺 `clearHint` |
| `client/screens/endgame/index.tsx` | 101-109 | C-28 | P3 | `deleteArmTimer` 卸载无 cleanup |
| `client/screens/endgame/index.tsx` | 129-131 | C-28 | P3 | `GRID_GAP`/魔法数 108 在渲染路径 |
| `client/screens/endgame/index.tsx` | 138-151 | C-27 | P2 | `refresh` 无卸载守卫 |
| `client/screens/endgame/index.tsx` | 180-185 | C-27 | P2 | 批量删除与 `refresh` 竞态 |
| `client/screens/endgame/index.tsx` | 200-209 | C-28 | P3 | 自定义存档不校验 `customId` |
| `client/screens/endgame/index.tsx` | 409-435 | C-27 | P2 | 自定义关卡缺 `disabled` 保护 |
| `chinese-chess-client/package.json` | 6, 10, 11 | I-4 | P3 | `dev`/`build`/`start` 指向不可用的 `.cozeproj` |
| `chinese-chess-client/tsconfig.json` | 1 | I-5 | P3 | 根 tsconfig 是空对象 |
| `chinese-chess-client/client/package.json` | 12 | I-3 | P3 | `test` 是 watch 模式 |
| `chinese-chess-server/package.json` | 17, 22 | I-2 | P2 | express@4 运行时 + `@types/express@5` |
| `chinese-chess-server/dist/index.js` + `ai/pikafish/**` | — | I-7 | P3 | 约 6.1MB 二进制/产物全部入库（无 LFS、无下载），其中 `data/pikafish.data` 3.91MiB |
| `client/screens/demo/index.tsx` | 1-19 | I-8 | P3 | 不可达脚手架残留页（**已由路由专项审计独立复现**：无任何路由指向），且引用第三方 CDN `lf-coze-web-cdn.coze.cn` |
| `README.md`（仓库根） | 1 | I-6 | P3 | 0 字节 |
| `chinese-chess-server/build.js` | 368 | I-9 | **P1** | `--only` 传不存在的区名 → 整轮比对被跳过仍 exit 0 |
| `chinese-chess-server/build.js` | 92-94, 360, 379-385 | I-10 | **P1** | 两侧 `// src/...` 锚点同时消失 → 整包塌成 INFO 区，src/dist 可任意不同仍 ✅ |
| `pack.ps1`、`pack.sh` | 90-104、43-52 | I-11 | **P1** | 先删旧包后校验 → 校验失败即该端零包且不可回滚 |
| `pack.ps1`、`pack.sh` | 23-42/60、30-38 | I-12 | **P1** | `.env` 不在排除面，`Assert-NoJunk` 也不检查 |
| `chinese-chess-client/package.json` + `client/package.json` | 18、12 | I-13 | **P1** | 6 个 jest 测试不在任何闸门里；`test` 是 `--watchAll` |
| `chinese-chess-server/scripts/verify-server-diff.cjs` | 351-355, 720 | I-14 | P2 | `clocks` 只比形状不比数值 → 局时/加秒数值差异失明 |
| `chinese-chess-server/scripts/verify-server-diff.cjs` | 123-129 | I-15 | P2 | 差分基线只在未跟踪的 `.dsh-work/`，新机器必然硬失败 |
| `chinese-chess-server/scripts/verify-server-diff.cjs` | 411-414 | I-16 | P2 | KNOWN 规则 A2 只看新侧 500 → 500 响应差异被预先赦免 |
| `chinese-chess-server/build.js` | 222-244 | I-17 | P2 | 内联第三方依赖变化不阻塞出包（"0 个模块也算一致"） |
| `chinese-chess-server/scripts/verify-server-hardening.cjs` | 21, 202-233 | I-18 | P2 | 声称覆盖"补丁五"（回推权威状态）实际零断言 |
| `chinese-chess-server/scripts/verify-server-hardening.cjs` | 445-453 | I-19 | P2 | E1/E2 是 dist 文本 includes 哨兵，函数改名即失效 |
| `pack.sh` | 30-38 | I-20 | P2 | 排除项仅 8 条且无 `Assert-NoJunk` 等价自检（与 pack.ps1 不等价） |
| `AGENTS.md`（仓库根） | 17 | I-21 | P2 | 「构建产物混入即失败」的承诺对 `dist`/`web-build`/`build` 不成立 |
| `chinese-chess-client/client/app.config.ts` | 3-4, 30, 37-43 | I-22 | P2 | slug/applicationId 依赖环境变量，仓库内无任何固化 |
| `chinese-chess-client/client/scripts/install-missing-deps.js` | 83, 91 | I-23 | P2 | `pnpm expo install` 非法 → 每次 install 都回退 `npm install` |
| `chinese-chess-server/scripts/verify-server-diff.cjs` + `pack.ps1`/`pack.sh` | 123-124、106-109、54-55 | I-24 | P2 | `.verify-old/` 残留会把旧 dist 打进"自包含部署包" |
| `chinese-chess-server/scripts/verify-server-diff.cjs`、`verify-server-hardening.cjs`、`tsconfig.json`、`package.json` | 235-240/702-707、86、— | I-25 | P3 | 死配置（`msKeys` 学习结果从不参与判据）、死 helper（`heartbeat`）、三个 `.cjs` 不受 tsc 保护、`postinstall` 依赖 devDependency esbuild |

#### 规则引擎与 AI（R-n）

| 文件 | 行 | 编号 | 级别 | 问题 |
| --- | --- | --- | --- | --- |
| `client/utils/chess/GameEngine.ts` | 615-638 | R-1 | **P0** | `createFromFen` 无行宽/越界校验（`qiPan[9][0]` 崩溃、非法字符静默错位）；同文件 `:697` 已实现 `isFenBoardWidthValid`，唯一调用方是 `aiDispatcher.ts:349`，**`createFromFen` 自己不用** |
| `client/utils/chess/GameEngine.ts` | 223-226 | R-2 | **P0** | 缺将局面 `col=-1` → `thisPoints[-1]` TypeError |
| `client/utils/chess/MoveCheck.ts` | 429-431, 438-440 | R-2 | **P0** | 同源越界（`afterMoveStillJiangJun` 取 `piecePositions[16]`） |
| `client/utils/chess/AIEngine.ts` | 864-884（调用点 1174-1185） | R-3 | P1 | `findImmediateWin` 是唯一不做王安全过滤的出口，优先于迭代加深返回 |
| `client/utils/chess/onlineMoveGuard.ts` | 51-68 | R-4 | P1 | 只校验起点归属，落点/`uci` 完全不校验（签名无 `toCol/toRow`） |
| `client/utils/chess/RuleEngine.ts` | 260-274（消费点 329-332） | R-5 | P2 | `isPiecePinned` 对"走不动"的子返回 `true` → 虚假长捉计数 |
| `client/utils/chess/AIEngine.ts` | 555-559 | R-6 | P2 | 与 RuleEngine 同名判据对"将帅已被吃"结论相反 |
| `client/utils/chess/RuleEngine.ts` | 130-133 | R-6 | P2 | 同上（`return false`） |
| `client/utils/chess/GameEngine.ts` | 412-426 | R-7 | P2 | `makeMove` 不校验合法性/坐标范围（分层设计，漏闸门即静默落盘或崩） |
| `client/utils/chess/__tests__/ruleEngineParity.test.ts` | 199-203 | R-8 | P3 | 黑方走点比对实为 `[]` vs `[]`，黑方从未被两端比对 |
| `client/utils/chess/__tests__/ruleEngineParity.test.ts` | 183-189 | R-9 | P3 | `MOVE_SEQUENCE` 四步全非法，注释 id/子力/坐标三者不符 |
| `client/utils/chess/GameEngine.ts` | 199-206 | R-10 | P3 | 注释称"照面着法合法"，与全仓实际行为相悖 |
| `client/utils/chess/MoveCheck.ts` | 337-360 | R-11 | P3 | `isKilledPoint` 死代码，且缺将时越界 |

#### 联机对局页 `lanBattle/index.tsx`（C-40 ~ C-52）

| 文件 | 行 | 编号 | 级别 | 问题 |
| --- | --- | --- | --- | --- |
| `client/screens/lanBattle/index.tsx` | 1755-1758 | C-40 | **P1** | 步时倒计时用本机时钟减服务端时间戳 → 自动替用户走随机棋 |
| `client/screens/lanBattle/index.tsx` | 1757-1762 | C-41 | **P1** | 协商期间步时不停表 → 超时自动走棋并静默吞掉悔棋/求和 |
| `client/screens/lanBattle/index.tsx` | 1609-1613 | C-42 | P2 | HTTP 兜底不读响应（拒绝既无提示也不回滚） |
| `client/screens/lanBattle/index.tsx` | 1530-1533 | C-43 | P2 | 乐观回滚只还原局面，不还原终局 UI（永久停在绝杀浮层） |
| `client/screens/lanBattle/index.tsx` | 294, 1185-1189 | C-44 | P2 | 公示倒数定时器无卸载清理（离开后仍开局并上传） |
| `client/screens/lanBattle/index.tsx` | 770-775, 1080-1137 | C-45 | P2 | 初始局面上传缺少在途互斥（可双 `/start`） |
| `client/screens/lanBattle/index.tsx` | 2004-2007 | C-46 | P3 | `resetForRematch` 漏复位 `undoPendingRef` |
| `client/screens/lanBattle/index.tsx` | 293 | C-47 | P3 | `revealTimerRef` 是死引用（只 clear 不赋值） |
| `client/screens/lanBattle/index.tsx` | 169, 2139 | C-48 | P3 | `GamePhase` 的 `'countdown'` 无人写入 |
| `client/screens/lanBattle/index.tsx` | 272-276 | C-49 | P3 | 注释与变量错配（描述的是已被取代的 ref） |
| `client/screens/lanBattle/index.tsx` | 513-531, 1568-1576 | C-50 | P3 | 每次渲染重建对象/数组 |
| `client/screens/lanBattle/index.tsx` | 1527, 1741 | C-51 | P3 | 走子上报 fire-and-forget，未捕获 rejection |
| `client/utils/battleSocket.ts` | 427-429 | C-52 | P3 | `send()`/`emitBattleAction()` 是死代码 |

#### 大厅与观战页（C-53 ~ C-72）

| 文件 | 行 | 编号 | 级别 | 问题 |
| --- | --- | --- | --- | --- |
| `client/screens/spectate/index.tsx` | 206（+hook 152, 263-265） | C-53 | **P1** | 观战页「步时」完全失效（hook 只写 ref 不调 setter，本页没传 ref） |
| `client/screens/spectate/index.tsx` | 413, 434 | C-54 | P2 | 房间被回收后永久静默空转（404 被 return 吞掉） |
| `client/screens/lanGame/index.tsx` | 173-175 | C-55 | P2 | 异常响应清空 `activeRoom`（冒出「观战」按钮、丢「回到对局」） |
| `client/screens/spectate/index.tsx` | 369-373 | C-56 | P2 | `errorMsg` 语义混用 → 卡在「正在载入棋局…」且心跳/轮询全停 |
| `client/screens/lanGame/index.tsx` | 193-196 | C-57 | P2 | 3s 轮询无并发防护（旧响应覆盖新数据） |
| `client/screens/lanGame/index.tsx` | 155-157 | C-58 | P2 | 房间列表请求失败即清空列表，无用户可见反馈 |
| `client/screens/lanGame/index.tsx` | 225-238 | C-59 | P2 | 保存/恢复服务器地址的存储失败抛出未处理拒绝，弹窗不关 |
| `client/screens/spectate/index.tsx` | 387 | C-60 | P2 | 一条非致命错误帧永久盖住棋盘（唯一出口是退出） |
| `client/screens/spectate/index.tsx` | 430-442 | C-61 | P2 | 心跳丢失后无法重新入列（观众数永久少算 1） |
| `client/screens/spectate/index.tsx` | 324-331 | C-62 | P3 | `enter()` 缺少 `!roomId` 守卫 |
| `client/screens/lanGame/index.tsx` | 188-191 | C-63 | P3 | 昵称回填覆盖用户正在输入的内容 |
| `client/screens/lanGame/index.tsx` | 319-332, 372-382 | C-64 | P3 | 请求在途时退出页面，成功回调仍导航 |
| `client/screens/spectate/index.tsx` | 100-102 | C-65 | P3 | 忽略服务端下发的 `roomName` |
| `client/screens/spectate/index.tsx` | 44-46 | C-66 | P3 | `Dimensions.get` 在模块顶层求值 |
| `client/screens/lanGame/index.tsx` | 86-94 | C-67 | P3 | `opponentConnected`/`createdAt` 读入后从未使用 |
| `client/screens/lanGame/index.tsx` | 198 | C-68 | P3 | 服务器状态条只在聚焦时探测 |
| `client/screens/lanGame/index.tsx` | 486-490 | C-69 | P3 | 创建与加入共用 `loading`（按钮自转） |
| `client/screens/lanGame/index.tsx` | 542, 587 | C-70 | P3 | 卡片不显示房主名，搜索却按房主名筛选 |
| `client/screens/lanGame/index.tsx` | 60, 613 | C-71 | P3 | `handicapSummary` 对缺字段不设防（列表白屏） |
| `client/screens/lanGame/index.tsx` | 252, 328, 381 | C-72 | P3 | `isHost` 路由参数是死参数 |

#### 补充审计：残局 / 复盘 / 存储 / 路由 / 主题（C-95 ~ C-123）

| 文件 | 行号 | 编号 | 级别 | 一句话 |
| --- | --- | --- | --- | --- |
| `client/utils/chess/endgames.ts` + `client/utils/chess/GameEngine.ts` | 66（消费 609、640） | C-95 | P2 | 校验用 `/\s+/` 切分、引擎用 `' '` 切分 → 黑先被静默丢弃（AI 永不先走） |
| `client/screens/endgameEdit/index.tsx` | 270-285（保存 306-310） | C-96 | **P1** | `buildFen()` 不拼 `w\|b` 段，编辑并保存黑先残局会静默变成红先 |
| `client/components/Screen.tsx` | 165-185, 202-212 | C-97 | P3 | 对"含原生滚动子节点"的页面二次加安全区 `paddingBottom`（是否可见待实机比对） |
| `client/app/_layout.tsx` | 17-25 | C-98 | P2 | `Text`/`TextInput` 的 `defaultProps` 在 React 19 已失效 → 全局字号缩放是死代码 |
| `client/screens/demo/index.tsx` | 1-19 | C-99 | P2 | 不可达的脚手架残留页，且引用第三方 CDN（与 I-8 同一处） |
| `client/utils/SoundManager.ts` | 88-118, 225-237 | C-100 | P3 | `unloadAllSounds` 不清 `loadingCache`（可与重建竞态）；4 个音频共 115 KB 从未被播放 |
| `client/screens/pveSetup/index.tsx` | 44-46, 62, 94 | C-101 | P3 | 设置无持久化（每次回落默认）；「继续对局」经中文标签往返转换、失败静默降为「进阶」 |
| `client/screens/game/index.tsx` | 110 | C-102 | P3 | `as Difficulty` 断言吞掉非法规格，非法值静默降级为默认难度 |
| `client/screens/*`（多处） | 见 §6.10 | C-103 | P3 | 仅 3 处做 `canGoBack()` 判断（其余 11 处直接 `back()`）；系统返回键只有 `lanBattle`/`game` 处理 |
| `client/utils/chess/types.ts` 周边 + 5 处页面 | 见 §6.10 | C-104 | P3 | 难度中文标签 5 份映射表（含一份反查表）；新增难度档时状态栏会显示空白 |
| `client/constants/`、`client/theme/` | — | C-105 | P3 | 只有 `modal.ts`；`theme/**` 目录不存在（与 §1 地图承诺不一致） |
| `client/screens/game/index.tsx` | 506-508（`aiDispatcher.ts:471-472`） | C-106 | P2 | `aiMove === null` 时无 `else` 分支 → 对局停在「AI回合」，观感是卡死 |
| `client/utils/replayStorage.ts` | 42, 55-60, 86-93 | C-107 | **P1** | 读取失败被当成空历史并永久缓存 → 下一次写入把最多 200 条棋谱永久覆盖 |
| `client/utils/chess/aiDispatcher.ts` | 186-195, 205-213 | C-108 | P3 | 「半开探测」条件与语义双错：曾经成功的客户端不再探测，冷启动客户端反而白等超时 |
| `client/utils/chess/aiDispatcher.ts` | 243-253（对照 215-223） | C-109 | P3 | 定时器恢复路径漏清 `lastInvalidMoveReason` → 恢复后仍挂「在线走法异常」 |
| `client/utils/replayStorage.ts` | 64-72 | C-110 | P3 | 写入先改内存缓存再落盘且静默吞失败 → 重启后新复盘与收藏切换全部回滚 |
| `client/screens/game/index.tsx` | 1085-1096 | C-111 | P3 | 「提示」在无解/被拒时静默 `return`，玩家点完没有任何反馈 |
| `client/utils/EndgameProgress.ts` | 183-194 | C-112 | P3 | `loadCustomEndgames` 只判数组类型、不校验元素结构 |
| `client/utils/EndgameProgress.ts` | 196-225 | C-113 | P3 | `add`/`update` 吞掉写入失败仍报「保存成功」（`endgameEdit` 的 catch 是死代码） |
| `client/screens/endgameEdit/index.tsx` | 104-114 | C-114 | P3 | 编辑已有残局时 FEN 解析失败静默退化为空棋盘 → 可能把原残局覆盖成另一局面 |
| `client/screens/replayPlayer/index.tsx` + `client/utils/replayStorage.ts` | 53-68（过滤 49-52） | C-115 | P2 | 存档着法零校验 → 一条损坏记录让播放页在渲染期抛 `TypeError` 且无法自愈 |
| `client/screens/replayPlayer/index.tsx` | 47-51 | C-116 | P2 | 模块级 `Dimensions.get('window')` → 旋转/改窗口后棋盘与控件、抽屉尺寸不同源（与 C-77 同源） |
| `client/screens/replayPlayer/index.tsx` | 54-68, 112 | C-117 | P3 | `buildSteps` 是 O(n²) 深拷贝且常驻 n+1 个完整局面 |
| `client/screens/replay/index.tsx` | 341-346 | C-118 | P3 | `FlatList` 缺 `extraData`，一旦 `renderCard` 被 `useCallback` 化选中态就不刷新 |
| `client/screens/replay/index.tsx` | 58-67, 104-115 | C-119 | P3 | 时间筛选基准 `nowTs` 只在 focus 时刷新，跨零点会错判「今天/近 7 天」 |
| `client/utils/replayStorage.ts` | 95-104 | C-120 | P3 | 容量淘汰对「全部收藏」失效 → 列表可无上限增长，最终退化为 C-110 的静默写失败 |
| `client/utils/replayStorage.ts` | 42, 66 | C-121 | P3 | `listReplays` 返回模块缓存本体，页面 state 与存储层共享同一数组 |
| `client/components/ChessBoard.tsx` | 907-908 | C-122 | P3 | 该步无被吃子时 `return null` 而不复位状态 → 后续再出现时无展开动画 |
| `client/screens/home/index.tsx` | 63-90, 158 | C-123 | P3 | 有存档但 `loadGame()` 返回 null 时不清 `savedGameInfo`（旧信息+有存档并存）；`loadProgress()` 无 `.catch`；闯关分母只算内置 30 关而分子含自定义 → 可显示 `31/30` |

*报告结束。审计阶段未修改任何既有源码文件，仅新增本报告与一份子代理产出的补充报告（`CODE_AUDIT_pve-flow.md`）；随后按用户要求落地了 §9 第 0 批（5 项）、第 1 批（20 项）、第 2 批（4 项）、第 3 批（5 项）修复，记录分别见 §9.1、§9.2、§9.3。*
