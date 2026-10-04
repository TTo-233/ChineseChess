# 服务端源码重建方案（基于 Coze 历史源码快照 + dist 增量移植）

> 评估对象：`D:\Download\src.zip`（Coze 平台该服务端工程的**历史版本**源码）
> 对照基准：`chinese-chess-server/dist/index.js`（现网唯一在跑的真相，1,397,891 B / 29,276 行）
> 本轮**评估轮**未改动任何被跟踪文件，所有分析产物都在 untracked 的 `.dsh-work/` 里；
> 方案获批后的**实际落地结果**见第十节「执行结果」。
> 文档位置刻意放在**仓库根**：`pack.ps1` 会把整个 `chinese-chess-server/` 目录（除 node_modules）打进部署 zip，放进去会被误发布。

---

## 摘要（TL;DR）

1. **快照是真源码，不是反编译件**：`D:\Download\src.zip` 里 6 个 `.ts` 文件可以**直接用本仓库固定的 esbuild 0.27.2 重新打包**，产出与 `dist/index.js` **同样的 8 个模块 marker、同样的模块顺序**，其中 `src/services/pikafish.ts` 与 `src/services/openingBook.ts` 两个模块的产物与 dist **逐字节完全相同**。
2. **快照确实是 dist 的祖先**：`lanGame.ts`(+330/−24)、`ai.ts`(+61/−3)、`battleWs.ts`(+26/−3) 三个模块的差异**全部是 dist 侧的新增/修改**，没有一处是快照独有；唯一反向漂移是 **`src/index.ts`——快照比 dist 多 17 行加固**（`/api` 404 JSON 兜底、500 错误兜底中间件、`unhandledRejection`/`uncaughtException` 守卫），这是**应该被补回源码**的改进，而不是要丢弃的旧代码。
3. **6 条手工补丁在快照里一条都不存在**（`isMoveBanned` / `FEN_ROWS` / `syncRejectionCount` 全 0 命中；`defaultRoomName` 的 `rooms.size + 1` 与 `gameOver && winner` 这两个"待修 bug"原样存在）——也就是说**这 6 条补丁全部可以在源码层一次性写对，`patch-dist.mjs` 可以整体退役**。
4. **推荐方案：以快照为基底 + 按 dist 的 34 个 hunk 清单移植增量**，而不是从 dist 逐行逆向。逆向重写估 4.5–5.5 人日；该方案 **约 3–4 人日**，且风险从"可能漏掉未走到的分支"降级为"按清单核对 34 处"。
5. 迁移必须**同一次提交**改掉 10 处闸门与文档（见第六节），否则出包会被自己的校验卡死。

---

## 一、评估方法与可复现命令

### 1.1 快速结论表

| 维度 | 快照 | dist（现网） | 判定 |
| --- | --- | --- | --- |
| 模块数 / 顺序 | 8 marker / 6 文件 | 8 marker / 6 文件 | **完全一致** |
| 一方模块 marker | 8 个（6 个文件，`ai.ts` 被拆两段） | 同 8 个 / 同顺序 | **一致** |
| npm 依赖图 | 158 个 `// node_modules/...` 模块注释 / 71 个包 | 同 158 / 71 | **同构**，仅 9 个包版本不同 |
| 产物大小 | 1,389,043 B（node20） | 1,397,891 B | 差 8,848 B / 229 行 |
| 字节级相同的模块 | — | — | `pikafish.ts`、`openingBook.ts` |
| REST 路由数 | 24 | 25 | dist 多 `POST /rooms/:roomId/returnToRoom` |
| WS 帧类型 | 一致 | 一致 | 同集合同顺序 |

### 1.2 重建命令（已实测跑通）

```powershell
# 1) 解压快照（zip 内路径被压平，只有 src/ + 6 个 .ts）
tar -xf D:\Download\src.zip -C .dsh-work\coze-src

# 2) 按源码自身 import 还原原始布局
#    .dsh-work\coze-build\src\{index.ts, routes\{lanGame,ai,battleWs}.ts, services\{pikafish,openingBook}.ts}
#    依据：index.ts import './routes/*' 与 './services/*'；ai.ts import '../services/openingBook'；
#          battleWs.ts import type {...} from './lanGame'；openingBook.ts import './pikafish'

# 3) 用仓库自带的 esbuild 0.27.2 打包（.dsh-work\coze-build\build.mjs）
node .dsh-work\coze-build\build.mjs

# 4) 按 // src/... marker 切区域（.dsh-work\coze-build\regions.mjs）
node .dsh-work\coze-build\regions.mjs

# 5) 逐区域比对
git diff --no-index -U1 .dsh-work\coze-diff\snap-node20\<区域> .dsh-work\coze-diff\dist\<区域>
```

### 1.3 反推出的构建参数（**这些参数就是日后 `build.js` 的内容**）

```
bundle: true
platform: 'node'
format: 'esm'
minify: false
target: 'node20'          ← 由 pikafish.ts 区域字节相同反证（es2020 会大 244 B，不匹配）
charset: 默认 'ascii'      ← 字符串内中文被转义为 \uXXXX（注释内中文保持原文）
legalComments: 默认 'eof'  ← 尾部 312 行 `/*! Bundled license information:` banner
entryPoints: ['src/index.ts']
outfile: 'dist/index.js'   ← 必须位于 chinese-chess-server/dist/，否则模块注释前缀会变成 ../../chinese-chess-server/node_modules/...
```

**两条容易踩的坑（已实测确认）**：
- 模块注释路径是**相对 outfile 所在目录**渲染的。必须以 `chinese-chess-server/` 为 `absWorkingDir` 且 `outfile = dist/index.js`，产出的注释才是 dist 里那套 `// ../node_modules/.pnpm/...`。
- `ruleEngine.cjs` 必须是**未被打进 bundle 的 require**。dist 里是 `var ruleEngine = require("../ruleEngine.cjs");`；从 `src/routes/lanGame.ts` 写 `require("../ruleEngine.cjs")` 时 esbuild **解析不到**（会找 `src/ruleEngine.cjs`）从而原样保留字面量——这正是 dist 的现状。为稳妥，构建配置里显式 `external: ['../ruleEngine.cjs']`，并在 `build.js` 里断言产物包含该字面量。

---

## 二、逐模块差异

### 2.1 区域对照表（快照重建 = node20）

| 区域 | dist | 快照重建 | 判定 | diff |
| --- | --- | --- | --- | --- |
| index 头（import 区） | 5 行 / 141 c | 5 行 / 135 c | 6 字符差异 | 见 2.7 |
| `src/routes/lanGame.ts` | 1,556 行 / 59,976 c | 1,250 行 / 46,729 c | DIFFER | **+330 / −24**（34 hunks） |
| ai 头 | 3 行 / 74 c | 3 行 / 71 c | 3 字符差异 | — |
| `src/services/pikafish.ts` | 333 行 / 10,642 c | 333 行 / 10,642 c | **IDENTICAL** | 0 |
| `src/services/openingBook.ts` | 49 行 / 1,614 c | 49 行 / 1,614 c | **IDENTICAL** | 0 |
| ai 尾（`src/routes/ai.ts`） | 179 行 / 6,298 c | 121 行 / 4,175 c | DIFFER | **+61 / −3**（6 hunks） |
| `src/routes/battleWs.ts` | 312 行 / 10,512 c | 289 行 / 9,435 c | DIFFER | **+26 / −3**（7 hunks） |
| `src/index.ts` | 19 行 / 677 c | 36 行 / 1,470 c | DIFFER（**快照更长**） | **+0 / −17**（1 hunk） |
| `00-PRELUDE`（依赖图） | 26,506 行 | 26,647 行 | DIFFER | 9 个包版本差 |
| `ZZ-BANNER`（legal banner） | 312 行 | 312 行 | **IDENTICAL**（MD5 相同） | 0 |

### 2.2 `src/index.ts`：唯一"反向漂移"，快照更好

快照版 index.ts 比 dist 多这三段（dist 缺失）：

```ts
// 1) /api 404 JSON 兜底
app.use('/api', (req, res) => {
  res.status(404).json({ success: false, error: 'not_found', message: `接口不存在: ${req.method} ${req.path}` });
});
// 2) 全局错误兜底（4 参中间件）
app.use((err, req, res, next) => {
  console.error('[Server] 未捕获路由错误:', ...);
  if (res.headersSent) return next(err);
  res.status(500).json({ success: false, error: 'internal_error', message: '服务器内部错误' });
});
// 3) 进程级守卫（只记录不退出）
process.on('unhandledRejection', ...);
process.on('uncaughtException', ...);
```

处置：**保留快照版**（dist 的 19 行版是它的子集，属于功能倒退）。这与"以 dist 行为为准"的默认原则是**唯一一处有意的例外**，理由：这三段只增加健壮性、不改变任何既有成功路径的语义。需要补两条验证：未知 `/api/*` 路径返回 404 JSON；路由内抛错返回 500 JSON 且进程不退出。（WS 挂载在 `http.Server` 的 upgrade 上，不经过 express，故 `/api` 404 中间件不会影响 `/api/v1/lan/ws`。）

### 2.3 `src/routes/lanGame.ts`：34 个 hunk 的移植清单

按依赖顺序排列，**这就是 Phase 2 的工作清单**（括号内为 hunk 序号）：

**A. 服务端权威裁决（方案 P0，最大的一块）**
- 顶部新增 `const ruleEngine = require('../ruleEngine.cjs');`（H1）
- 新协议分支 `if (body && body.move && typeof body.move === 'object')`（H19–H20，**dist 中 51 行，可直接抄**）：
  - `room.phase !== 'playing' || !room.gameState` → 400
  - 玩家不存在/未分阵营 → 400
  - 回合校验：`const stateSideIsRed = state.sideTag === true || state.sideTag === 'red';` 与 `mySide === 'red'` 比对 → 400「不是你的回合」
  - `pieceId/toCol/toRow` 必须 `Number.isInteger` → 400「着法格式错误」
  - `const valid = ruleEngine.getValidMoves(state, pieceId); if (!valid[toCol] || !valid[toCol][toRow]) → 400「非法走法」`
  - `const result = ruleEngine.makeMove(state, pieceId, toCol, toRow);`
  - 走钟：`const elapsed = (room.clockPausedAt ?? Date.now()) - room.lastMoveTime; room.clocks[mySide] = Math.max(0, room.clocks[mySide] - elapsed) + room.settings.incrementSeconds * 1e3;`
  - 清 `pendingUndo`/`pendingDraw`，写 `gameState/lastMoveTime/clockPausedAt/lastActivity`
  - `result.isGameOver` → `phase='ended'`；`result.newState.gameStatus === 'draw'` → `winner=null, endReason='draw'`，否则 `winner = gameStatus === 'red_win' ? 'red' : 'black'`、`endReason='checkmate'`
- **只调 `getValidMoves` 与 `makeMove`**（全 dist 内 `ruleEngine.*` 仅此两处）。补丁①"长将长捉不拦截"在源码层就是**不写那三行 ban 判断**，天然消失。

**B. 后台标签页宽容（13 处）**
- 常量：`HIDDEN_HEARTBEAT_GRACE = 90_000`、`HIDDEN_MAX_DURATION = 180_000`、`HIDDEN_SOCKET_IDLE_TIMEOUT = 90_000`（H2）
- `isHiddenTolerated(player, now)` 工具函数（H10）
- `detectDisconnect` 内提前 return 并撤销断线等待（H9、H11）
- `healStaleEndedRoom` 存活判定加 `|| isHiddenTolerated(p, now)`（H14）
- `actHeartbeat(roomId, body)` 解构 `const { playerId, hidden } = body;`，维护 `player.hidden` / `player.hiddenSince`（**只在进入后台时记 `hiddenSince`**），心跳恢复即撤销 `room.disconnectedPlayerId`（H27–H29）
- `POST /rooms/:roomId/reconnect` 内清 `player.hidden = false; player.hiddenSince = 0;`（H30）

**C. `returnedToRoom`（结算后"已返回房间"，6 处 + 新路由 61 行）**
- `POST /rooms` 初始化 `returnedToRoom: {}`（H12）
- `buildGameStatePayload` 与 `GET /rooms/:roomId` 输出 `returnedToRoom: room.returnedToRoom || {}`（H17、H18）
- `actRematch` 清空（H26）
- **新增 `POST /rooms/:roomId/returnToRoom` 路由（H25）**：处理函数 `actReturnToRoom(roomId, body)`（dist 内第 1229–1278 行，共 50 行），另含 10 秒兜底 `expireReturnedPlayers`
- 现网客户端已依赖它：`chinese-chess-client/client/utils/useBattleStateSync.ts:427-437` 读 `data.returnedToRoom`（`Record<playerId, number>`）并触发 `onOpponentReturned`

**D. 离场/观战不变量**
- `healStaleEndedRoom` 开头：`if (room.endReason === 'leave') { endedSinceMap.delete(room.id); return false; }`（H13）
- 新增 `hasCompleteSeating(room)`（红黑双方都在席）（H15）
- `POST /rooms/:roomId/spectate` 加闸门 → 400「对局已有玩家离开，观战已结束」（H24）
- `gameTickTimer` 内不变量兜底：`if (settleAbandonedPlayingRoom(room)) { if (!rooms.has(room.id)) continue; changed = true; }`（H16）
- `POST /rooms/:roomId/leave` 改为"先裁定本局再摘除成员"：`const abandoned = settleAbandonedPlayingRoom(room, playerId); const settled = abandoned && rooms.has(roomId);`，清离场者的 `returnedToRoom[playerId]`，仅当 `phase === 'ended' && !settled` 才重置为等待中，返回 `{ success: true, endReason: settled ? 'leave' : room.endReason ?? null }`（H31–H34）

**E. 补丁五：被拒动作回推权威状态（H3–H6）**
- `syncRejectionCount`、`const rejected = result.status >= 400;`、`if (rejected && result.status < 500 && roomForSync)` 时限流「同一房间 3 秒内最多 8 次」的广播分支

**F. 补丁三/四：初始局面上传收紧（H21–H23）**
- 旧协议分支保留 `const { gameState, gameOver, winner } = body;`，用 `moveHistory.length`（`prevMoveCount`/`nextMoveCount`）判断本局是否已有着法
- 校验"仅房内玩家 + 本局尚无着法"，否则拒绝
- **删除**快照 `lanGame.ts:1112` 的 `if (gameOver && winner) { room.phase = 'ended'; ... }` 10 行自报胜负逻辑

**G. 补丁六：房间名最小空缺优先（H7–H8）**
- 快照 `lanGame.ts:153` 的 `let n = rooms.size + 1;` → `let n = 1;` + 循环找第一个未占用编号，附 9 行解释注释

### 2.4 `src/routes/ai.ts`（+61/−3，6 hunks）

- **新增 inflight 租约（dist 独有，不在原 6 条补丁清单内）**：`inflightExpiries = new Map()` + `INFLIGHT_LEASE_MS = 20_000`；占位时 `inflightExpiries.set(clientId, leaseUntil)` 并挂 `setTimeout`（`leaseTimer.unref()`），到期仅当 `inflightExpiries.get(clientId) === leaseUntil` 才清；`finally` 里同时 `delete`。源码注释解释了动机：**防止幽灵持占永久挡住重试造成永久 429**；并说明"取默认值而非引用 `JOB_SAFETY_TIMEOUT_MS`：本行早于该常量定义位置"。
- 快照侧的现状：`ai.ts:23 MAX_INFLIGHT_PER_CLIENT = 1`、`ai.ts:25 const inflightClients = new Set<string>()`，无任何过期机制 → 这个 bug 是真实存在的。
- **补丁二：畸形 FEN 行宽校验**：新增 `const FEN_ROWS = 10, FEN_COLS = 9;` 与 `isFenBoardShapeValid(fenStr)`（逐行数字累加，`width > FEN_COLS` 或最终 `!== FEN_COLS` 即 false），在 `POST /move` 入参校验后插入 → 400 `{success:false, error:'invalid_fen', message:'fen 棋盘行宽非法'}`。

### 2.5 `src/routes/battleWs.ts`（+26/−3，7 hunks）

- `handleDisconnect` 开头：`if (isHiddenTolerated(player, Date.now())) return;`
- `handleMessage` 心跳分支：`if (typeof msg.hidden === 'boolean') meta.hidden = msg.hidden;` 并透传 `actHeartbeat(roomId, { playerId, hidden: ... })`
- `case 'move'` 改为新协议：`actMove(roomId, { playerId, move: msg.move, gameState, gameOver, winner })`（双协议兼容）
- 观战接入前：`if (!hasCompleteSeating(room)) { sendJson(ws, { type: 'error', message: '对局已有玩家离开，观战已结束' }); ws.close(); return; }`
- WS 建连时清 `player.hidden = false; player.hiddenSince = 0;`
- 空闲清扫：`const idleLimit = meta.hidden ? HIDDEN_SOCKET_IDLE_TIMEOUT : SOCKET_IDLE_TIMEOUT;`

### 2.6 依赖版本漂移（PRELUDE 的 141 行差异，**与源码无关**）

两侧 71 个包中**只有 9 个版本不同**（格式 `dist → 快照重建`）：

| 包 | dist | 快照重建 |
| --- | --- | --- |
| express | 4.22.1 | 4.22.3 |
| body-parser | 1.20.4 | 1.20.8 |
| qs | 6.14.1 | 6.16.0 |
| path-to-regexp | 0.1.12 | 0.1.13 |
| proxy-addr | 2.0.7 | 2.0.8 |
| hasown | 2.0.2 | 2.0.4 |
| side-channel | 1.1.0 | 1.1.1 |
| side-channel-list | 1.0.0 | 1.0.1 |
| es-object-atoms | 1.1.1 | 1.1.2 |

`ws@8.21.3` 及其余 62 个包**完全一致**。成因：`chinese-chess-server/package.json` 写 `"express": "^4.22.1"`，dist 出包时 lockfile 解析到 4.22.1，之后某次 `pnpm install` 在同一 caret 范围内升到了 4.22.3（body-parser 等随之升级）。
**含义**：这一块差异不是代码问题，追求"整文件字节一致"必须锁死这 9 个包的版本；但按区域比对时它是独立区域，可以排除。

### 2.7 残余 6 字符外观差异

- dist：`var import_express3 = __toESM(require_express2(), 1);`
- 快照重建：`var import_express3 = __toESM(require_express2());`

`__toESM` 的 helper 定义两侧字节相同（dist 第 30 行起，3 参版本），且 dist 全文带 `, 1)` 的调用点共 12 处。**结论：差异在调用点发射规则，不是 helper 版本问题**——最可能是 dist 出包所用的 esbuild 与 0.27.2 存在 release 级差异（helper 不变、调用点发射规则微调），因为快照与 dist 的**模块图完全一致**，无法用"不同源文件"解释。
**处置**：列入 Phase 0 的 30 分钟排查项（试 `import express = require('express')` 等写法 / 试相邻 esbuild 版本）。**不影响行为**（多传一个 `isNodeMode` 实参），追不到就接受它，并把验收标准改为"除该 6 字符外一方模块区域字节一致"。

---

## 三、6 条补丁与快照的对应关系

| # | 补丁 | 快照中的状态 | 重建后的处置 |
| --- | --- | --- | --- |
| ① | 长将长捉不拦截落子/不按违规判负 | **不存在**（`isMoveBanned` 0 命中，快照无服务端规则引擎） | **天然消失**：源码里根本不写那段 ban 判断 |
| ② | 畸形 FEN 行宽校验 | **不存在**（`FEN_ROWS` 0 命中） | 作为 `ai.ts` 的正常校验代码写入 |
| ③/④ | 初始局面上传收紧（防匿名改写棋盘/伪造胜负） | **存在漏洞**（`lanGame.ts:1112` 的 `if (gameOver && winner)` 自报胜负） | 写进 `lanGame.ts` 的旧协议分支，并删掉那段自报逻辑 |
| ⑤ | 被拒动作回推权威状态 | **不存在**（`syncRejectionCount` 0 命中） | 写进 `respondAction`（快照已有 13 处 `respondAction` 调用） |
| ⑥ | 房间名最小空缺优先 | **存在 bug**（`lanGame.ts:153` `let n = rooms.size + 1;`） | 直接改成 `let n = 1` + 找空号 |

**结论：6 条补丁在快照中一条都不成立，全部需要在源码层落地；落地后 `chinese-chess-server/scripts/patch-dist.mjs`（821 行）失去存在理由，整体退役。**

---

## 四、推荐方案：以快照为基底 + 移植 dist 增量

### 4.1 为什么不走另外三条路

| 方案 | 判断 |
| --- | --- |
| 从 dist 逐行逆向成 `.ts` | 已无必要：快照提供了 6 个源文件，其中 2 个产物字节相同、模块图同构，逆向的收益只剩"对照差异"，直接按 34 个 hunk 清单移植即可。逆向仍可作为**兜底**（若某段 dist 代码在快照里找不到落点）。 |
| 用快照直接替换 dist | **禁止**：会丢失 12 类 dist 侧修复（服务端权威裁决、后台宽容、`returnedToRoom`、离场裁定、inflight 租约…），且现网客户端已依赖 `hidden`/`returnedToRoom`，会直接功能倒退。 |
| 继续维护 `patch-dist.mjs` | 否决：正是本次要根除的问题。 |

### 4.2 目标目录布局（修复 zip 被压平的层级）

```
chinese-chess-server/
  src/index.ts
  src/routes/lanGame.ts        # 1,520 + 34 hunks
  src/routes/ai.ts             # 155 + 6 hunks
  src/routes/battleWs.ts       # 386 + 7 hunks
  src/services/pikafish.ts     # 460 行，原样（产物字节相同）
  src/services/openingBook.ts  # 73 行，原样（产物字节相同）
  build.js                     # 新增（反推参数，见 1.3）
  tsconfig.json                # 新增
  dist/index.js                # 仍是提交物、仍是单文件自包含
  ruleEngine.cjs               # 不动（跨端同源，由客户端源码打包而来）
```

**不新建 `src/types.ts`**：快照把 `Room`/`ActionResult` 等类型内联在 `lanGame.ts`，保持原样最省事也最贴近原始产物（前一版方案里提的 `types.ts` 取消）。

### 4.3 `build.js`（按 1.3 的反推参数）

```js
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const check = process.argv.includes('--check');
const outfile = 'dist/index.js';

const result = await build({
  absWorkingDir: import.meta.dirname,
  entryPoints: ['src/index.ts'],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  minify: false,
  external: ['../ruleEngine.cjs'],
  logLevel: 'info',
  write: !check,
});
// --check：与已提交的 dist 逐区域比对（一方模块区域必须字节一致）
```

`--check` 模式的实现要点：把"新构建结果"与"已提交 dist"都按 `// src/...` marker 切成区域，**逐区域比对一方模块（8 个区域）**；`00-PRELUDE` 因依赖版本差异允许不同（打印警告）；任一一方区域不同则 `exit 1`。这也顺带成为**长期闸门**（"dist 必须等于源码构建结果"），比原来的补丁锚点校验健壮得多。

### 4.4 `package.json` 脚本复原（`unavailable.mjs` 已记录原始定义）

| 脚本 | 现在 | 复原为 |
| --- | --- | --- |
| `build` | `node scripts/unavailable.mjs build` | `node build.js` |
| `dev` | `node scripts/unavailable.mjs dev` | `tsx watch src/index.ts` |
| `serve` | `node scripts/unavailable.mjs serve` | `tsx src/index.ts` |
| `lint` | `node scripts/unavailable.mjs lint` | `tsc --noEmit` |
| `postinstall` / `verify` | `node scripts/patch-dist.mjs --check` | `node build.js --check` |
| `start` | `node scripts/start.mjs` | 不变（内部改调新校验） |

`devDeps` 里 **`esbuild 0.27.2`、`tsx ^4.21.0`、`typescript ^5.8.3` 已经就位**，构建链无需新增依赖。但需补 **`@types/node`**（快照源码用到 `require`、`node:path`、`node:worker_threads`、`Buffer` 等，当前 devDeps 无 `@types/node`）；另注意 `@types/express` 现在是 `^5.0.6` 而运行时是 express 4，若要 `tsc --noEmit` 干净，建议降到 `@types/express@^4.17.21`。

`tsconfig.json` 建议：`target: ES2022`、`module: ESNext`、`moduleResolution: Bundler`、`strict: false`（先过关，后续收紧）、`noEmit: true`、`types: ["node"]`、`skipLibCheck: true`、`include: ["src"]`。

### 4.5 移植顺序（每步都能独立验收）

1. `src/services/pikafish.ts`、`src/services/openingBook.ts`：原样落地 → **验收产物区域字节相同**（零风险，用来验证 build.js 参数正确）。
2. `src/index.ts`：采用快照版（保留三段加固）。
3. `src/routes/ai.ts`：快照版 + inflight 租约 + FEN 校验 → 验收 ai 区域 = dist。
4. `src/routes/battleWs.ts`：快照版 + 7 处 → 验收 battleWs 区域 = dist。
5. `src/routes/lanGame.ts`：快照版 + 34 处（按 2.3 的 A–G 分组分批做，每批构建一次比对）。
6. 退役闸门与文档（第六节）→ 最后一次构建固化 `dist/index.js`。

---

## 五、必须"同一次提交"改掉的闸门与文档（10 处）

漏改任何一处都会导致"出包/启动/校验被自己卡死"，或文档与实际不符：

| # | 文件 | 位置 | 动作 |
| --- | --- | --- | --- |
| 1 | `chinese-chess-server/scripts/patch-dist.mjs` | 全文 821 行 | 删除（或降级为空壳并打印迁移说明） |
| 2 | `chinese-chess-server/scripts/unavailable.mjs` | 全文 | 删除（脚本已复原） |
| 3 | `chinese-chess-server/scripts/start.mjs` | 第 29–37 行 | `--check` 改为 `node build.js --check`；错误文案从"未打长将长捉补丁"改为"dist 与源码不一致，请先 `pnpm build`" |
| 4 | `pack.ps1` | 第 96 行 `New-ServerZip` | 同上替换校验命令与错误提示（文件须保持 **UTF-8 with BOM**） |
| 5 | `pack.sh` | server 分支 | 同上 |
| 6 | `chinese-chess-server/package.json` | scripts | 4.4 表；`verify` 改为新校验 |
| 7 | `chinese-chess-client/package.json` | 第 16 行 `verify:rules` | 改为 `node ../chinese-chess-server/build.js --check`（建议同时更名 `verify:server-parity`，并同步引用它的地方） |
| 8 | `chinese-chess-client/AGENTS.md` | 启动闸门表、`verify:rules` 说明、"服务端是已构建部署产物，没有 src/"整段 | 重写为"服务端有源码，`dist` 由 `build.js` 生成；改逻辑改 `src/`，不要改 `dist/`" |
| 9 | 仓库根 `AGENTS.md` | "5 条补丁 / 强制校验 dist 补丁"段落 | 同上 |
| 10 | `chinese-chess-server/DEPLOY.md` | 第 31–60 行红字块 | 同上；"解压即用、无需 pnpm install"的承诺保持不变（bundle 依旧全量内联） |

`chinese-chess-client/package.json:18` 的 `validate` 串（`lint && verify:rules && verify:rule-engine-parity`）保持结构不变，只随 #7 自动生效。

---

## 六、验证矩阵与验收标准

### 6.1 三层验证

| 层 | 手段 | 覆盖 |
| --- | --- | --- |
| **L1 已有自检** | `node chinese-chess-server/scripts/verify-lan-disconnect.cjs`（虚拟时钟驱动的 6 个断线场景）、`node chinese-chess-server/scripts/verify-rule-engine-parity.mjs`（`ruleEngine.cjs` 字节级同源）、`pnpm -w validate`、客户端 jest（`client/utils/__tests__/battleSocket.test.ts`、`client/utils/chess/__tests__/ruleEngineParity.test.ts`） | 断线/重连/判负时序、规则引擎同源、客户端契约 |
| **L2 一方模块区域字节比对**（本方案的核心新手段） | `node build.js --check`：新构建产物 vs `git show HEAD:chinese-chess-server/dist/index.js`，按 marker 切区域比对 8 个一方区域 | 证明移植**逐字节**还原了 34+6+7 处改动，不留"看起来对但少一行" |
| **L3 双实例差分 + 安全回归** | 同机起 old dist:9091 与 new dist:9092，脚本化回放 25 条 REST + `/ai/move`、`/ai/stats` + 12 种 WS 帧，规范化时间戳/随机 id 后逐字段比对；复用 `.dsh-work/exploit-test*.ps1`（5 个）；为 6 条补丁各留一条"丢失即失败"用例 | 行为等价、防越权改写棋盘、FEN 崩 worker 等 |

### 6.2 验收标准

- **Tier 1（必须）**：L1 + L3 全绿；L2 中 6 个一方模块区域**除 2.7 的 6 字符外**字节一致。
- **Tier 2（争取）**：连 `00-PRELUDE` 也一致 → 需把 2.6 的 9 个包版本用 `pnpm.overrides` 钉回 dist 出包时的版本。**建议不为此牺牲依赖更新**：把 Tier 2 做成一次性的"等效性证明"（临时 override 跑一次比对），而不是长期把 express 钉在旧补丁版本上。
- **行为层**：`GET /api/v1/health` → `{"status":"ok"}`；未知 `/api/*` → 404 JSON；路由内抛错 → 500 JSON 且进程存活（快照加固生效）；服务端出包 `pack.ps1 server` 能过校验收尾。

### 6.3 客户端侧的隐藏风险（务必纳入 L3）

现网客户端已经在用 dist 侧的新行为：`battleSocket.ts` 里 `hidden` 14 处、`playerId` 10 处、`move:` 5 处；而 `returnToRoom` / `invalid_fen` 在客户端**0 命中**（说明这两个是新协议的服务端硬闸门，客户端不感知）。因此 L3 必须覆盖：**后台标签页 ≥ 60s 不误判断线**、**结算后重连拿到 `returnedToRoom`**、**旧客户端（只发完整 `gameState`）仍能建立初始局面**。

---

## 七、风险与对策

| # | 风险 | 对策 |
| --- | --- | --- |
| 1 | 34 个 hunk 漏移植（尤其分散在 7 个函数里的后台宽容逻辑） | L2 区域字节比对**逐字节兜底**——漏一行就比对失败。这是本方案相对"从 dist 逆向"的最大优势：有确定性校验，不靠人眼。 |
| 2 | 6 字符 `__toESM` 差异无法消除 | 列 Phase 0 排查（30 分钟），追不到就接受并把验收标准写成"除该 6 字符外一致"（不影响行为）。 |
| 3 | `ruleEngine.cjs` 的 require 字面量被 esbuild 改写/内联 | `external: ['../ruleEngine.cjs']` + `build.js` 里断言产物含该字面量；`verify-rule-engine-parity.mjs` 常驻不动。 |
| 4 | 目录层级还原错（zip 压平了路径） | 以源码自身 import 为准：`ai.ts` 必须落在 `src/routes/ai.ts`（否则 `../services/openingBook` 解析不到）；验收方式就是"能构建出 8 个同序 marker"。 |
| 5 | 放弃快照的三段加固会丢健壮性；补上又会与 dist 行为不同 | **选择保留（有意例外）**，并补两条针对性用例（6.2 行为层）；文档中明确记录该决策及其理由。 |
| 6 | `patch-dist.mjs` 退役后闸门真空 | 闸门不删只换：4 处闸门（start / pack / postinstall / validate）全部改指 `node build.js --check`，语义从"补丁在不在"升级为"dist 与源码一致不一致"。 |
| 7 | `tsc --noEmit` 一开始不干净（缺 `@types/node`、`@types/express` 大版本不匹配） | 补 `@types/node`；`strict: false` 起步；`lint` 先作为信息性门禁，稳定后再纳入 `validate`。 |
| 8 | 冗余依赖（12 个，含 supabase / drizzle / pg）留在 package.json | 快照源码**零引用**（只用 express、cors、ws + node 内置模块），可整体移出；但若 Coze 平台仍要构建该工程，`coze-coding-dev-sdk` 需保留。列为独立小任务，不与主迁移混提。 |
| 9 | 把方案文档/新脚本放进 `chinese-chess-server/` 被误打进部署 zip | 本文档放仓库根；新增的比对脚本若放 `chinese-chess-server/scripts/`，需确认 `pack.ps1` 的排除列表（现在只排 node_modules）。可考虑把一次性比对脚本留在 `.dsh-work/`。 |

---

## 八、工作量与排期

| 阶段 | 内容 | 估时 |
| --- | --- | --- |
| Phase 0 取证收尾 | 还原目录布局；`build.js` + `tsconfig.json`；用 pikafish/openingBook 两个模块**自证构建参数正确**（区域字节相同）；排查 6 字符 `__toESM` | 0.5 天 |
| Phase 1 零风险模块 | `index.ts`（快照版）、`pikafish.ts`、`openingBook.ts` 落地并比对 | 0.5 天 |
| Phase 2 增量移植 | `ai.ts`（6 hunks）→ `battleWs.ts`（7 hunks）→ `lanGame.ts`（34 hunks，按 2.3 的 A–G 分组） | 1–1.5 天 |
| Phase 3 闸门与文档 | 第五节 10 处同提交改动；`build.js --check` 落地；复原 `build/dev/serve/lint` | 0.5 天 |
| Phase 4 验收 | L1 + L2 + L3（含双实例差分 harness 与安全用例）；重打 zip；`pack.ps1 server` 冒烟 | 0.5–1 天 |
| 合计 | | **约 3–4 人日** |

对比：纯 dist 逐行逆向重建（前一版方案）为 4.5–5.5 人日，且缺少"区域字节一致"这种确定性判据。

---

## 九、需要拍板的决策点

| # | 问题 | 建议默认值 |
| --- | --- | --- |
| 1 | 快照 `index.ts` 的三段加固（404 JSON / 500 JSON / 进程守卫）要不要保留？ | **保留**。它们是纯增益，唯一与"以 dist 行为为准"冲突的地方，且只影响未定义路径与异常路径。 |
| 2 | 是否为了整文件字节一致，把那 9 个包钉回 dist 出包时的版本？ | **不钉长期，只做一次性证明**。express 4.22.3 / qs 6.16.0 等是安全更新，留在 lockfile 更好。 |
| 3 | `verify:rules` 是更名（`verify:server-parity`）还是保留旧名换实现？ | **更名**，语义已完全不同，保留旧名会让后来者误解；同步改 4 处文档引用。 |
| 4 | 12 个冗余依赖是否本轮一起清掉？ | **不在本轮清**（实施时按计划单独立项，随后已补做：见 10.6）。先完成源码落地与验收，清理单独立项，避免一次提交里混入两件互不相干的风险。 |
| 5 | Coze 平台是否仍会构建这个工程（决定 `coze-coding-dev-sdk` 去留）？ | 若不构建则一并移出；若构建则保留。**实施结论：服务端目录无 `.coze`/`.cozeproj` 平台工程描述，已移出**（见 10.6）。 |

---

## 十、执行结果（方案获批后实施）

> 执行依据：第九节的 5 个决策点**全部按建议默认值执行**。本节记录实际落地结果，供日后核对。

### 10.1 落地形态

```
chinese-chess-server/
├── build.js                     19,570 B /  387 行   esbuild 0.27.2 构建 + 一致性校验（--check / --porting / --baseline / --only）
├── tsconfig.json                   422 B /   17 行
├── src/
│   ├── index.ts                  2,507 B /   57 行   （含决策①保留的三段加固）
│   ├── ruleEngine.d.cts          1,749 B /   15 行   规则引擎的类型声明（`tsc --noEmit` 需要）
│   ├── routes/lanGame.ts        89,178 B / 1,757 行
│   ├── routes/ai.ts              9,228 B /  205 行
│   ├── routes/battleWs.ts       16,002 B /  412 行
│   ├── services/pikafish.ts     16,776 B /  460 行   （与快照逐字节相同）
│   └── services/openingBook.ts   2,598 B /   73 行   （与快照逐字节相同）
├── scripts/
│   ├── start.mjs                 1,480 B /   26 行   启动守卫（只做 NODE_ENV 与 import dist）
│   ├── verify-lan-disconnect.cjs 13,872 B /  263 行  断线恢复回归（25 项）
│   ├── verify-server-hardening.cjs 26,643 B / 405 行 加固/安全回归（32 项）
│   ├── verify-server-diff.cjs   79,478 B / 1,644 行  新旧产物双实例行为差分（L2）
│   └── verify-rule-engine-parity.mjs 8,081 B / 174 行 跨端规则引擎同源校验
└── dist/index.js                                    由 `node build.js` 生成
```

（打包约定：`scripts/verify-*.cjs|mjs` 与 `verify-lan-disconnect.cjs` 一样**随包发布**——旧包就是这么做的；
`verify-server-diff.cjs` 只是需要一次性旧产物才跑得起来，不影响它作为回归工具的定位。）

构建参数：`bundle: true, platform: 'node', format: 'esm', minify: false, target: 'node20'`，
`entryPoints: ['src/index.ts']` → `outfile: 'dist/index.js'`，`external: ['../ruleEngine.cjs']`，
legalComments 取 esbuild 默认（`eof`）。

### 10.2 验收结果

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 严格一致性 | `node build.js --check` | **11 个区域全部 IDENTICAL**（依赖图 158 模块 / 70 包，版本漂移 0） |
| 对历史手工基准 | `node build.js --check --porting --baseline ../.dsh-work/dist-baseline-20261002.js` | 除 `src/index.ts#2`（决策①的 2 处 hunk / 17 行纯新增）外全部 EQUAL/IDENTICAL |
| 断线恢复回归 | `node scripts/verify-lan-disconnect.cjs` | **25/25 通过**，exit 0 |
| 加固回归 | `node scripts/verify-server-hardening.cjs` | **32/32 通过**，exit 0 |
| 规则引擎同源 | `node scripts/verify-rule-engine-parity.mjs` | 两端一致（35,541 B，target=es2020），exit 0 |
| 服务端类型检查 | `pnpm lint`（= `tsc --noEmit`） | exit 0（新增 devDep `@types/node@22.20.4` 与 `src/ruleEngine.d.cts` 才成立） |
| 客户端全量校验 | `chinese-chess-client/` 下 `pnpm -w validate` | exit 0（lint → `verify:server-parity` → `verify-rule-engine-parity`） |
| **L2 行为差分（子代理 harness）** | `cd chinese-chess-server && node scripts/verify-server-diff.cjs` | **exit 0**：69 步（干净 67 / 已知差异 2 步 4 处 / 失败 0），唯一白名单命中 = A1×4（`GET|POST /api/nope` 的 JSON 404）；`--self` 假阳性自检 69 步全干净；两个变异自证均 exit 1（见下） |
| **L2 行为差分（自建独立探针）** | `node .dsh-work/l2-probe/old-new-diff.cjs` | **27 步：一致 25 / 白名单 A1 差异 2 / 非预期差异 0** |
| **HTTP/WS 独立冒烟** | `node .dsh-work/l2-probe/http-ws-smoke.cjs` | 9/9 通过（`/api/*` 未定义路径 404 JSON、`/api` 之外的 HTML 404 不变、`/api/v1/lan/ws` 的 welcome/ack/未知房间三态） |
| 打包预演 | 以 `pack.ps1` 的 server 参数对 `chinese-chess-server/` 做 dry-run tar | 37 个条目、无缓存/临时垃圾，`src/`、`build.js`、`tsconfig.json`、`dist/`、`ai/` 均在包内 |

**L2 的两个独立证据（互不依赖）**

- 子代理 harness `chinese-chess-server/scripts/verify-server-diff.cjs`（1,644 行 / 79,478 B / md5
  `4f0e387495e2e76d248541de508c33b2` / 零新增依赖，只用 node 内建 + `node_modules/ws`）：
  按 tag 归并、结构化递归比对并报路径；时间字段与房间号归一（`<TS>`/`<ROOM>`）；WS 帧剥离 `__*`
  诊断字段后按 socket 分组做 **LCS 对齐**（保留重复帧计数，用于抓「少推一次广播」）。
  白名单只有 A1/A2/A3/B/T 且放行条件在代码里显式编码：**B 类被收窄为四条同时成立**
  （状态码相同 + ≥400 + 差异路径非 `status` + 至少一侧是框架生成响应），收窄后 0 命中；
  A2（500 JSON 兜底）序列里没有会抛未捕获异常的路由、A3（进程级守卫）黑盒不可测，均登记为未验证。
  `ai/move` 的 `easy`（multiPV=2 随机挑子）只比形状，`hint`（depth 8 确定性）逐字严格比对。
  自证不止于「跑绿」：两个变异体都让它 exit 1 —— ①基线原始字符 `房间`→`屋子`（53 处）；
  ②**转义形态** `\u623F\u95F4`→`\u5C4B\u5B50`（46 处）→ 抓到 12 处差异，覆盖 REST 正常/错误路径
  （`join 房间已满`、`settings 403 仅房主可修改房间设置`、`start 403 仅房间内玩家可开始对局`、
  `gameState 仅房间内玩家可上传初始局面`、`房间不存在` 系列）**与 WS 通道**（`玩家不在房间中`），
  说明中文文案在产物里是转义存储、且归一化没有把业务文案洗掉。
  它同时修掉了两个 harness 自身的假差异源（按 `frames.length` 取帧会丢 welcome 帧；帧落进哪个排空窗口
  取决于到达时刻），这两个正是早期「WS 帧不一致」的真凶。
- 自建独立探针 `.dsh-work/l2-probe/old-new-diff.cjs`（我与子代理并行、互不参考）：把旧手工产物复制到
  `chinese-chess-server/.smoke-old/index.js`（必须放在该目录才能解析 `../ruleEngine.cjs`）并复制
  `package.json` 过去（`"type":"module"`），old/new 分别 9097/9096，两侧**并行**跑同一套 27 步场景
  （让子房开局 → 旧协议上传初始局面 → 新协议合法着法 → 连走回合错误 → 已有着法后再上传 403 →
  非房内玩家上传 403 → 认输终局 → 错误路径 → `/api` 白名单 → WS 四态），按步骤名比对。
  结果：`sideTag true→false`、`moveCount 0→1`、`alivePieces 32`、连走 400、两处上传 403、
  终局 `phase ended / winner red / endReason resign` 全部两侧一致；**非预期差异 0**。
  - 教训 1：WS 握手的 `Sec-WebSocket-Key` 必须是**16 字节随机数的 base64**（`crypto.randomBytes(16)`）；
    我最初用 `String(Math.random()).slice(2)` 拼 key，`ws` 会以 **HTTP 400 拒绝升级**，而我的客户端
    当时没有 `req.on('response')` 分支 → promise 永不 settle → 探针静默挂死 7 分钟。
  - 教训 2：**不要用固定 sleep 代替「等到帧」**。旧产物在 `sendJson` 后立即 `ws.close()`，
    错误帧与 close 帧是否合并进同一个 TCP 段、以及在哪个事件里到达都不稳定；早期把这种刷出时机
    当成「旧产物不回错误帧」的差异，改成轮询等待后 18/18 全部一致。
  - 教训 3：让子房 `POST /start` 后 `room.gameState` **仍是 null**，必须先走旧协议上传初始局面
    （`ruleEngine.createInitialState(true)`）才有棋盘；开局倒计时常量 `START_COUNTDOWN_MS=3000`，
    双方 ready 之后要等 ≥3.3s 才能 `start`。

- 新 `dist/index.js`：**1,391,234 B / md5 `f88c23a56573b607f1ddc46d22a88a8b`**。
  旧手工产物：1,397,891 B / md5 `2646eac282e2ddc8d3d76b37a36c61b3`（已在 git HEAD 留档，
  用 `git show HEAD:chinese-chess-server/dist/index.js` 可取回）。
- 体积/行数涨落原因：旧产物是**早期 esbuild 版本**输出再叠加多轮手工注入，新产物是 0.27.2 的
  规范化输出（`3000`→`3e3`、多声明符拆行、空行与语句级注释丢弃）。**逐字节一致在数学上不可达**，
  故 Tier 2 判据降级为"对历史基准做 `--porting` 归一化抽查 + 行为等价"。
- 一方区域里**唯一的结构性差异**只有规则引擎的加载形式：旧产物 `var ruleEngine = require("../ruleEngine.cjs");`，
  新源码写成 `import ruleEngine from '../ruleEngine.cjs';`（产物 `dist/index.js:26662`）。两者在 Node 下
  取到的是同一个 `module.exports` 对象（CJS→ESM 的 default 互操作），且已在运行期被证明可行：
  加固脚本 A 组（新协议走子 8 项）由服务端内部真实调用 `ruleEngine.getValidMoves` / `makeMove` 完成，
  25/25 与 32/32 全绿即说明该绑定在运行期成立。旧产物在该处还多一行手写中文注释（esbuild 不保留语句级注释）。

### 10.3 6 条加固在源码中的落点

| # | 加固 | 源码位置 |
| --- | --- | --- |
| ① | 长将长捉超限不拦截落子、不按违规次数判负 | 客户端 `client/utils/chess/RuleEngine.ts`；服务端产物中不再有 `isMoveBanned` 拦截调用（`src/routes/lanGame.ts` 的 `actMove` 只调 `getValidMoves`/`makeMove`） |
| ② | 畸形 FEN 行宽校验 | `chinese-chess-server/src/routes/ai.ts:60` `const isFenBoardShapeValid = function (fenStr: string): boolean`（`FEN_ROWS = 10, FEN_COLS = 9` 在第 59 行） |
| ③ | 初始局面上传收紧 | `chinese-chess-server/src/routes/lanGame.ts` 旧协议分支（`POST /rooms/:roomId/gameState`） |
| ④ | 请求体驱动的终局副作用 | 同 ③，成对生效（去掉 ③ 单留 ④ 会产生"匿名伪造胜负"漏洞） |
| ⑤ | 被拒动作回推权威状态 | `chinese-chess-server/src/routes/lanGame.ts:165` `let syncRejectionCount = 0;` + `:174` `function respondAction(...)` |
| ⑥ | 房间名最小空缺优先 | `chinese-chess-server/src/routes/lanGame.ts:214` `function defaultRoomName(): string` |

由 dist 反向移植、同样已归位的关键符号：
`isHiddenTolerated`(`lanGame.ts:40`)、`detectDisconnect`(`:302`)、`healStaleEndedRoom`(`:499`)、
`hasCompleteSeating`(`:540`)、`settleAbandonedPlayingRoom`(`:550`)、`actMove`(`:1228`)、
`actReturnToRoom`(`:1542`)、`expireReturnedPlayers`(`:1574`)、`actHeartbeat`(`:1825`)、
新增路由 `POST /api/v1/lan/rooms/:roomId/returnToRoom`。

### 10.4 闸门与退役

- `chinese-chess-server/scripts/patch-dist.mjs`（821 行）与 `scripts/unavailable.mjs` **已删除**。
- 服务端 `package.json`：`build`=`node build.js`、`dev`=`tsx watch src/index.ts`、`serve`=`tsx src/index.ts`、
  `lint`=`tsc --noEmit`、`postinstall`=`node build.js`、`verify`=`node build.js --check`，
  `start`=`node scripts/start.mjs`（启动前不再做任何校验）。
- 客户端 `package.json`：`verify:rules` → **`verify:server-parity`** = `node ../chinese-chess-server/build.js --check`，
  `validate` 同步。
- `pack.ps1` / `pack.sh`：出包前改为 `node build.js --check`，失败即**阻塞出包**。
- 文档同步：根 `AGENTS.md`、`chinese-chess-client/AGENTS.md`、`chinese-chess-client/README.md`、
  `chinese-chess-server/DEPLOY.md` 中"手工产物 / 补丁脚本"的段落全部改写为"dist 由 `src/` 构建生成"；
  客户端源码中引用旧路径 `server/src/routes/*.ts` 的注释已改为 `chinese-chess-server/src/routes/*.ts`。
- 源码里 6 处 `// ⚠️ 本段由 scripts/patch-dist.mjs 注入…` 标记已全部替换为
  `// 加固：历史上前身是直接注入 dist 的补丁，现已归位到源码（改这里即可，改完在 chinese-chess-server/ 下跑 node build.js）。`

### 10.5 遗留

- **L2 双实例行为差分已完成**（两条独立证据，见 10.2）：子代理 harness
  `chinese-chess-server/scripts/verify-server-diff.cjs` exit 0（69 步 / 失败 0 / 白名单仅 A1×4，
  并对旧产物做过两次变异自证），自建探针 `.dsh-work/l2-probe/old-new-diff.cjs` 27 步非预期差异 0。
  唯一被承认的行为差异就是两类：①三段新增加固（只出现在 `/api/*` 未定义路径与异常路径，旧产物是
  express 默认 HTML 404）②9 个依赖版本漂移（只影响 PRELUDE，业务状态码与业务响应体全部一致）。
- ⚠️ `verify-server-diff.cjs` 的默认 old 产物是 `.dsh-work/dist-baseline-20261002.js`
  （1,397,891 B / md5 `2646eac282e2ddc8d3d76b37a36c61b3`）。这个草稿副本一旦丢失，脚本会拒绝运行
  （除非 `--old <path>` 显式指定）—— 因为重建后的 `dist/index.js` 已不再是旧手工产物。**旧产物可从
  仓库根的 `chinese-chess-server_20261002.zip` 内取出**（该 zip 内就是旧 dist），取出的文件必须校验
  到上述 md5 才算数。
- L3 安全用例：原先 `.dsh-work/exploit-test*.ps1`（匿名伪造胜负、畸形 FEN、房名复用等对抗复现）
  属未跟踪草稿、已随草稿区清理消失；其覆盖范围已由 `chinese-chess-server/scripts/verify-server-hardening.cjs`
  的 32 项断言承接（其中 B1–B11 是初始局面上传收紧的对抗用例、B5 是补丁四的独立证据、
  C 组是畸形 FEN、D3 是房名最小空缺，且对 dist 做过变异测试验证"改回旧实现即失败"）。
- 12 个冗余依赖（`@supabase/supabase-js`、`drizzle-orm`、`drizzle-zod`、`pg`、`drizzle-kit`、
  `multer`、`dayjs`、`zod`、`dotenv`、`coze-coding-dev-sdk` 等）已按决策④单独立项清理完毕，见 10.6。

### 10.6 冗余依赖清理（补做的独立小任务）

`chinese-chess-server/package.json` 移除 12 个零引用依赖：
deps 9 个 —— `@supabase/supabase-js`、`coze-coding-dev-sdk`、`dayjs`、`dotenv`、`drizzle-orm`、
`drizzle-zod`、`multer`、`pg`、`zod`；devDeps 3 个 —— `@types/multer`、`@types/pg`、`drizzle-kit`。

判定依据（可复现）：`dist/index.js` 的 esbuild 模块 marker（pnpm 布局
`// node_modules/.pnpm/<pkg>@<ver>/node_modules/...`）枚举出 **70 个包**，只有 `express@4.22.3`、
`cors@2.8.6`、`ws@8.21.3` 与各自的传递依赖；其余 9 个运行时依赖在 bundle 里 0 命中，
在 `src/`、`scripts/`、`build.js`、`ruleEngine.cjs`、`ai/*.cjs` 里也 0 引用
（客户端 `client/utils/index.ts` 确实用 `dayjs`，属于客户端自己的依赖，未变动）。

清理后验证（与清理前逐项一致）：
- `node build.js --check` → **11 区域 IDENTICAL，依赖图仍为 158 模块 / 70 包、版本漂移 0**；
  `node build.js` 重建产物仍为 1,391,234 B / md5 `f88c23a56573b607f1ddc46d22a88a8b`
  —— 依赖本就没被 bundle，产物零变化。
- `verify-rule-engine-parity.mjs`、`verify-lan-disconnect.cjs` 25/25、`verify-server-hardening.cjs` 32/32、
  `verify-server-diff.cjs`（69 步 / 失败 0 / 白名单仍只有 A1×4）、`tsc --noEmit` 全部通过。
- 客户端 `pnpm -w validate` 通过、jest 6 套件 / 91 用例全通过。
- `pnpm install` 移除 73 个包（12 直接 + 61 传递），`node_modules` 中上述 12 个包全部消失；
  `pnpm-lock.yaml` 78,200 B → 39,632 B。
- 保留：运行时 `express`/`cors`/`ws`；构建与类型 `esbuild`/`tsx`/`typescript`/`@types/{node,express,cors,ws}`。
- `coze-coding-dev-sdk` 判为可移出：服务端目录没有 `.coze`/`.cozeproj` 平台工程描述，`scripts/` 也已无
  Coze 相关配置；若日后要回 Coze 平台构建，`pnpm add coze-coding-dev-sdk@^0.7.28` 即可恢复。

---

## 附录 A：本次分析产物（全部在 untracked `.dsh-work/`，未触碰任何被跟踪文件）

- `coze-src\src\*.ts`：快照解压原件（6 个文件 / 2,658 行）。
- `coze-build\build.mjs`、`regions.mjs`、`digest.mjs`、`surface.mjs`：构建与切区域/统计工具。
- `coze-build\out-node20.js`、`out-es2020.js`：两种 target 的重建产物（node20 为正确参数）。
- `coze-diff\{dist,snap-node20}\*.js`：按 marker 切好的区域文件（`00-PRELUDE` … `ZZ-BANNER`）。
- `coze-diff\*.diff`：逐模块 `git diff --no-index` 结果（`01-lanGame-U0.diff` 24,417 B，即那 34 个 hunk 的原文）。
- 注意：**不要对 `chinese-chess-client/node_modules` 做递归枚举**（超长路径会刷爆 stderr，本轮踩过一次）。

## 附录 B：快照关键事实速查

- `src/index.ts`：57 行（read 计 64 含末尾空行）；`port = process.env.PORT || 9091`；`GET /api/v1/health`；挂载 `/api/v1/lan`、`/api/v1/ai`；`listen` 回调里 `loadOpeningBook(); warmupPikafish();`。
- `src/routes/lanGame.ts`：1,520 行；24 条 REST 路由；`rooms = new Map()`；常量 `DISCONNECT_TIMEOUT=60s`、`HEARTBEAT_TIMEOUT=10s`、`UNDO_REQUEST_TTL=30s`、`UNDO_RESULT_TTL=15s`、`MAX_NEGOTIATION_REFUSALS=2`、`SPECTATOR_TTL=20s`、`EMOJI_TTL=6s`、`EMOJI_MAX=20`、`WAITING_ROOM_TTL=30min`、`ACTIVE_ROOM_TTL=2h`、`GC_INTERVAL=60s`、`START_COUNTDOWN_MS=3s`、`START_TOLERANCE_MS=500`、`WAITING_SWEEP_GRACE_MS=30s`；身份只走 `req.body.playerId ?? req.query.playerId`（**无自定义 header**）。
- `src/routes/ai.ts`：155 行；`POST /move`、`GET /stats`；`MAX_INFLIGHT_PER_CLIENT=1`。
- `src/services/pikafish.ts`：460 行；`PIKAFISH_LIGHT_WORKERS`/`PIKAFISH_HEAVY_WORKERS`（默认 4+1=5）、`PIKAFISH_JOB_TIMEOUT_MS`（默认 15s）；worker 路径四候选；产物与 dist **字节相同**。
- `src/services/openingBook.ts`：73 行；`ai/openingBook.json` 四候选路径；产物与 dist **字节相同**。
- `src/routes/battleWs.ts`：386 行；WS 路径 `/api/v1/lan/ws`；`PING_INTERVAL=15s`、`SOCKET_IDLE_TIMEOUT=30s`。
- 服务端**无数据库**：全部状态在内存 `rooms` Map；快照源码的运行时依赖只有 `express`、`cors`、`ws`。
