# 揭棋模式开发方案（适配本仓库架构版）

> 本文取代 `C:\Users\hthot\Desktop\揭棋开发方案.md` 作为本仓库的揭棋实施方案。
> 原方案是通用设计稿；本文按本仓库**既有架构、既有规则、既有闸门**重写，
> 逐条指明落到哪个文件、改哪一处、被哪条既有约束挡住。
>
> 撰写日期：2026-10　　状态：**待评审，未改动任何代码**

---

## 0. 结论摘要

| 项 | 结论 |
| --- | --- |
| 总体路线 | **不新起炉灶**，在现有 `utils/chess` 引擎上加 `variant` 维度，而不是并行写一套揭棋引擎 |
| 最大技术风险 | **暗子真实身份会随现有 4 个下发点泄漏**（含 `POST /rooms/:id/spectate` 直返 `room.gameState`） |
| 最大架构机会 | 暗子公开态**用「占位棋子 id」呈现**（走法由位置型 id 天然决定），可让 `MoveCheck.ts` 的 32 字面量 switch **零改动** |
| 必须改的引擎文件 | 只有 5 处：`calcXiang`、`calcShi`、`afterMoveStillJiangJun`、`makeMove`、`positionKey` |
| 原方案需修正处 | 4 处（原地翻子、暗子被吃可见性、暗子身份池、FEN 扩展），见 §1.3 |
| AI | 首版**不做在线揭棋 AI**；本地 AI 用「信念采样 + 复用现有 alpha-beta」，深度会比象棋低。理由见 §9.1（GPLv3 + 无 WASM + 权重不可得） |
| 外部引擎评估 | [lichlzh/pikafish-jieqi](https://github.com/lichlzh/pikafish-jieqi) **是 Qt6 GUI 不是引擎**，不可作 AI，但 `core/` 是高价值的揭棋规则参考，见 §9.2 |
| 建议首个可交付版本 | **离线人机（PVE）+ 本地 AI**，完全不动服务端；在线对局放到第二阶段 |
| 待决事项 | **无**。§14 全部 7 项已定稿，方案可直接进入 P0 实现 |

---

## 1. 规则基线

### 1.1 已核实的规则（两个独立来源交叉验证）

来源：[揭棋玩法说明（腾讯象棋官方）](https://image.qqchess.qq.com/test_160324/activity/html/jieqiguize.html?1549023391)、[揭棋玩法规则（棋者象棋）](https://qizhe.org.cn/home/?p=848)。两者在下列各点**完全一致**：

1. **摆子**：红黑各 15 个暗子随机摆放于己方初始位置，将/帅置于原点（九宫正中）。
2. **暗子走法**：红先。暗子按**其所在初始位置的棋子规则**走第一步（兵位暗子第一步只能向前一格）。
3. **暗子吃子**：行动范围内有对方棋子可吃；**走子后的暗子自动翻开为明子**。
4. **暗子被吃**：己方暗子被吃后，**己方不能看到它是什么棋**。
5. **明子走法**：照中国象棋规则；**唯二放宽 —— 揭开的士、象可以过河**（仕可出九宫、相可越河界）。
6. **胜负**：被绝杀或困毙判负；超时、强退、认输判负。

### 1.2 棋规阈值差异（两个来源不一致，需产品决策）

| 项 | 腾讯官方 | 棋者象棋 | 本仓库现状 |
| --- | --- | --- | --- |
| 空步判和 | 无吃子达 **40 回合** | 无吃子达 **80 步** | `naturalMoveLimit: 120` 步 |
| 长捉 | 单子连续捉超 6 回合禁着 | 单子 6 / 双子 12 回合 | `longChase: 6` |
| 长将 | 同子连续捉将超 6 回合禁着 | 1 子 6 / 2 子 12 / 3+ 子 18 | `[6, 12, 18]` |
| 局面循环 | — | 5 次判和 | `repetitionDraw: 5` |
| 无进攻子力 | — | 除将帅外都算进攻子力 | `hasAttackingPieces`（士象不计） |
| 最大步数 | — | 200 步判和 | `totalMoveLimit: 400` |

**结论**：现有 `RULE_CONFIG`（`utils/chess/RuleEngine.ts:38`）已把全部阈值集中为常量、且多为「更宽松」的一侧，
**揭棋直接复用现有值**，不为揭棋改阈值。若产品要求对齐某一家，只改 `RULE_CONFIG` 即可（这是既有设计的红利）。
需产品拍板的只有一项：**空步判和是否沿用 120 步**（本仓库是两边数字的 1.5 倍，两边都不等）。

### 1.3 对原桌面方案的修正（4 处）

原方案有 4 处与核实后的规则或本仓库约束不符，必须在实现前纠正：

| # | 原方案表述 | 问题 | 本方案定稿 |
| --- | --- | --- | --- |
| 1 | §1.5「玩家还可以选择**原地翻子**……本回合结束」 | **两个官方规则文本均无「原地翻子」**；两者只写「走子后的暗子自动翻开」。棋者象棋在空步判和条目下提到「翻暗子，翻子清空计算」，措辞可指自动翻开，存在歧义 | **默认不做原地翻子**。作为 `variant` 可选开关 `allowFlipInPlace` 预留，默认 `false`，等产品确认后再开 |
| 2 | §1.2「被吃子的一方不能翻看被吃暗子的身份，**吃子方可看**」 | 官方明确「**己方**暗子被吃后，己方不能看到是什么棋」——限制的是**被吃方**，而**吃子方同样看不到**（吃子方拿到的是一枚背面朝上的新暗子）。原方案把信息优势给反了 | | **吃子方也看不到**（✅ 已定稿，§14.2 选 B）。吃子方拿到的是一枚**背面朝上、位于己方阵营**的新暗子，按落点列走，走后翻开 |
| 3 | §2.3「暗子身份池……当暗子被吃且吃子方有权查看时，从池中移除该身份」 | 基于修正 #2 的错误前提 | 身份池是**纯服务端内部**结构，用于（a）保证 15 枚身份不重复、（b）复盘还原。**任何时刻都不因「谁被吃」而向任何客户端释放身份** |
| 4 | §2.2「推荐使用 FEN 的扩展格式」 | 本仓库 **FEN 有硬约束**：服务端 `ai.ts:60-81` 的 `isFenBoardShapeValid` 会拦畸形 FEN，且 FEN 被直接喂进 Pikafish WASM（越界写内存会打崩 worker 池）。扩展 FEN 一旦混进 `/ai/move` 就是事故 | 揭棋状态**另起序列化格式**（`JieqiSetup` + 复用既有 `GameState`），**绝不扩展 FEN**，也绝不把揭棋状态送进 `/ai/move` 的 FEN 字段 |

---

## 2. 与现有架构的碰撞点（风险清单）

这一节是本方案与原方案差别最大的地方。以下每条都已核对代码。

### 2.1 【致命】暗子身份会从 4 个下发点泄漏

现有协议的核心安全假设是「`room.gameState` 就是可以发给客户端的东西」。它被直接下发于：

1. `lanGame.ts:527` — `buildGameStatePayload` 的增量载荷（经 `slimGameState`）
2. `lanGame.ts:601` — `buildFullGameStatePayload` 的全量载荷（**直接回传 `room.gameState` 引用**）
3. `lanGame.ts:1571` — `GET /rooms/:id/gameState`
4. `lanGame.ts:1593` — **`POST /rooms/:id/spectate`，第 1628 行 `gameState: room.gameState`** ← 最隐蔽

而 `slimGameState`（`lanGame.ts:577`）的实现是 `{ ...rest }` —— **任何新增到 `GameState` 上的字段都会自动进入广播**。
换句话说：只要把 `realIdentity` 挂到 `GameState` 上，四条路径全漏，且**默认是漏的**。

**因此定死两条架构铁律：**

- **铁律 A**：暗子真实身份**永远不挂在 `GameState` 上**，存在 `room.jieqiSecret` 这个服务端私有对象里，任何 `JSON.stringify` 都碰不到它。
- **铁律 B**：所有出站下发必须且只能经过**单一投影函数** `publicGameState(room)`；`room.jieqiSecret === null` 时该函数是恒等函数（现有象棋路径零行为变化）。

> `POST /rooms/:id/spectate`（`lanGame.ts:1628`）目前是直返原始 `gameState`，**必须改为调用投影函数**。这是揭棋改造中唯一一个「不改就必然出事」的既有代码点。

### 2.2 在线对局**没有**设置初始局面的通道

`startPlayingRoom`（`lanGame.ts:795-815`）是初始局面的**唯一收口点**：

```ts
room.gameState = ruleEngine.applyHandicap(ruleEngine.createInitialState(), room.settings.handicap);
```

旧的「客户端上传完整 gameState」协议已被 **S-8 加固彻底删除**（`lanGame.ts:1474-1482`），
因为历史上 `roomId + playerId` 就能上传任意局面并直接判胜。

**含义**：揭棋的初始摆子**必须由服务端生成**（`Math.random` 洗牌在服务端做），
这既是「服务端权威」的延续，也正好符合暗子信息不能下发的要求。
客户端**不得**参与摆子、不得上传摆子结果、不得持有种子。

### 2.3 `Room.gameState` 是 `any`，但 `stateHistory` 存的是**引用**

`lanGame.ts:1526-1530` 的论证：`makeMove` 返回全新状态、旧对象此后只读，所以压栈存引用是安全的。
这条论证**对揭棋依然成立**（我们的 `makeMove` 同样返回全新对象），
因此**揭棋的悔棋快照栈可以零成本复用现有机制** —— 但快照必须同时包含 `jieqiSecret`，否则回退后身份池错乱。

### 2.4 规则引擎是**客户端源码的打包产物**

`chinese-chess-server/ruleEngine.cjs` 由 `client/utils/chess/ruleEngine.bundle.ts` 经 esbuild 打包，
`verify-rule-engine-parity.mjs` **逐字节**比对。所以：

- 改规则的**唯一入口是客户端源码**，改完必须 `--write` 重新打包并**重启服务端**；
- 若为揭棋新写一套独立引擎 → 需要第二个产物 + 第二道 parity 闸门 + 服务端改 `require` 路径。
  **这是不新起炉灶的首要理由。**

### 2.5 单点收口：所有着法合法性都走 `MoveCheck.getPathPoints`

`MoveCheck.ts:5-25` 自称三端唯一真源，禁止任何一端另写等价实现。揭棋**不能例外**。

### 2.6 `screen/game` 1392 行、`screen/lanBattle` 3608 行

两者都已用抽出的 hook（`useNewGame` / `useBattleStateSync` / `useGameBoardLayout` / `usePendingAIMove`）。
揭棋逻辑**必须**以新 hook 形式落地，不得内联进这两个巨型文件。

---

## 3. 总体架构决策

### 3.1 决策一：用「占位棋子 id」承载暗子的公开态

这是整个方案最关键的设计。

**观察**：揭棋暗子按「所在初始位置对应的棋子类型」走法。而本仓库的 `MoveCheck.fillPathPoints`
（`MoveCheck.ts:79-112`）是一个**对 32 个字面量 id 的 switch**：

```ts
switch (moveQiZi) {
  case 7: case 8: case 23: case 24: calcChe(...); break;   // 车
  case 5: case 6: case 21: case 22: calcMa(...);  break;   // 马
  ...
}
```

**做法**：把「暗子」直接**用它的占位 id（= 该初始位置对应的棋子类型 id）存进棋盘**。
即：某个暗子实际是马、但摆在车位上，它在 `qiPan` 里就存 `7`/`23`（车）。

于是：

- ✅ `getPathPoints` 对暗子**零改动**就产出**天然正确**的走法（车位的暗子走直线、兵位的暗子只能前进一格）；
- ✅ 客户端的落点提示、禁着标记、吃子特效全部照常工作；
- ✅ `isTongBang`（同方判定，`MoveCheck.ts:33`）基于 id 区间（≤15 黑 / ≥16 红），仍然正确；
- ✅ `isTongBang` 同方判定（id 区间 `≤15` / `≥16`）正确；
- ✅ 不需要为暗子新增任何 `PieceState` 字段来驱动走法。

**代价与补偿**：

| 代价 | 补偿 |
| --- | --- |
| 公开 id ≠ 真实身份，客户端无法自己区分「这格是暗子还是真的车」 | `GameState` 新增 `hiddenMask: boolean[32]`，与 `pieces` 一一对应 |
| 服务端必须维护 `占位 id → 真实 id` 映射 | `room.jieqiSecret.identity: number[]`（下标=占位 id，值=真实 id） |
| 棋子贴图会显示成「占位类型」 | `ChessBoard` 新增 prop，暗子改渲染背面图（见 §8） |

#### ⚠️ 占位 id 的生命周期（本方案最易实现错的一处）

关键约束：`pieces` 是**固定 32 格、以 id 为下标**的数组（`pieces[id].id === id`），
棋盘 `qiPan` 里存的也是 id。所以「占位 id」与「真实 id」**共用同一个 32 格命名空间**，不能并存。

本方案采用**占位即退役**制：

```
揭开瞬间（在 makeMove 内）：
  占位 23（实际是兵）的格子 → 退役 pieces[23]（alive=false）
  同一格        → 升起   pieces[27] = {col,row,alive:true}
  hiddenMask[27] = false（真实 id 本来就未标隐藏，无需翻转）
```

这样做的好处是**揭开之后全局再无特殊处理**：该子从此就是个普通的、
带真实 id 的明子，`calcShi`/`calcXiang`/`PIECE_VALUES`/将军判定/UI 全部沿用现有逻辑。

必须随之满足的三条不变式：

1. **任一时刻不存在两个活子共用同一 id**；
2. `hiddenMask[retiredId]` 一并清 `false`（占位退役后棋盘上已无该 id）；
3. 退役格复用现有 R-2 崩溃防护路径（`pieces[i] = {col:-1,row:-1,alive:false}`）
   ——`isJiangJun` 与 `afterMoveStillJiangJun` 都有缺席子防护，新机制复用即可。

#### ⚠️ 暗子**不是**攻击者（与直觉相反，必须显式实现）

**未翻开的暗子不能将军。** 理由：暗子只有移动才会翻开，而移动前它从未动过，
不可能产生攻击。因此攻击扫描必须**跳过 `hiddenMask[id] === true` 的子**。

这与「暗子按占位 id 的走法」是两件独立的事：

| | 走法（能否动、往哪走） | 攻击（是否算将军） |
| --- | --- | --- |
| 未翻开的暗子 | 按**占位 id**（= 位置型） | **不攻击** —— 必须跳过 |
| 已翻开的子 | 按**真实 id** | 正常攻击 |

因此 `isJiangJun`（`GameEngine.ts:245-268`）与 `afterMoveStillJiangJun`（`MoveCheck.ts:408-429`）
**都要拿到 `hiddenMask` 并跳过暗子**。前者是纯 `GameEngine` 改动；
后者需要给 `fillPathPoints`/`afterMoveStillJiangJun` **加参数**（`piecePositions` 已经是
只含 `{col,row,alive}` 的瘦结构，正好追加一个 `hidden: boolean` 字段即可，
调用点：`GameEngine.ts:188`、`AIEngine.ts` 的 `generatePseudoMoves` 及其评估路径 —— 需逐一核对）。

> ⚠️ 这一条若漏实现，后果是**开局即白脸将判负**：占位「车」在底线与对方将帅照面，
> 会被 `afterMoveStillJiangJun` 判成飞将，把所有合法着法全部判非法。

### 3.2 决策二：状态分层

```
┌─ 权威层（服务端内存，永不出网） ────────────────────┐
│  room.gameState        —— 含真实 id 的权威棋盘        │
│  room.jieqiSecret      —— identity[32] / 身份池 / 种子 │
│  room.stateHistory[]   —— 两者的联合快照栈            │
└────────────────────────────┬─────────────────────────┘
                             │  publicGameState(room)   ← 唯一出站收口
                             ▼
┌─ 公开层（发给所有客户端） ──────────────────────────┐
│  GameState（含 hiddenMask，暗子显示为占位 id）          │
│  JieqiPublicSetup（仅"已翻开"的子，不含未翻开身份）    │
└─────────────────────────────────────────────────────┘
```

标准象棋房 `jieqiSecret === null`，`publicGameState` 为恒等函数。

### 3.3 决策三：不扩展 FEN

沿用现有 `GameState` 结构，只增两个字段；揭棋专属信息用独立的 `JieqiSetup` 结构承载（§4.2）。

---

## 4. 数据模型

### 4.1 `GameState` 的增量（在 `utils/chess/types.ts`）

```ts
export interface GameState {
  // ... 现有 8 个字段不动
  /** 玩法变体：'xiangqi' = 中国象棋（现有全部行为）；'jieqi' = 揭棋 */
  variant?: GameVariant;
  /** 暗子标记（仅揭棋）：下标与 pieces 对齐，true=该子背面朝上。
   *  标准象棋一律 false/缺省，故现有序列化、存档、复盘全部兼容。 */
  hiddenMask?: boolean[];
}

export type GameVariant = 'xiangqi' | 'jieqi';
```

> 命名说明：内部标识用 `jieqi`（代码可读），UI 文案一律用「揭棋」。

### 4.2 服务端私有 + 客户端公开的揭棋专属结构

```ts
/** 服务端私有：暗子真相（room.jieqiSecret，绝不序列化） */
interface JieqiSecret {
  /** identity[占位 id] = 该暗子的真实棋子 id；仅当 hiddenMask[id] 为 true 时有意义。
   *  暗子揭开后该占位 id 即退役（真实 id 换 id 顶上），故此表只存「未翻开暗子」的真相。 */
  identity: number[];
  /** 已用于「吃暗子升新暗子」的占位 id 栈（实现 §5.4 的槽位复用） */
  freeSlots: number[];
  /** 初始摆子的随机种子（用于复盘还原；不外发） */
  seed: number;
}

/** 公开：揭棋房间设置（随 settings 下发） */
interface JieqiPublicSetup {
  /** 被吃暗子的展示列表：只说"红方收了 1 枚暗子"，不说是什么 */
  capturedHidden: { red: number; black: number };
}
```

**被吃暗子计数**要单独下发的原因：UI 需要显示「你已获得 N 枚未知暗子」，
但服务端不能下发这 N 枚分别是什么。现有对局已有「被吃子数量角标」的渲染惯例（`ChessBoard` 的角标层），
揭棋沿用同一视觉位置。

### 4.3 `MoveRecord` 扩展

```ts
export interface MoveRecord {
  pieceId: number;  // 标准象棋 = 真实 id；揭棋 = 真实 id（权威层），公开层另存
  // ... 现有 5 个字段不动
  /** 该手是否为暗子移动（走完自动翻开） */
  flippedPieceId?: number;
}
```

`flippedPieceId` 供**客户端动画**使用：「哪个子翻开成什么字」。
注意它**必须只包含公开可见的信息**——即翻开后的真实身份本来就是公开的，所以安全。

### 4.4 暗子占位 id 的映射表

揭棋初始 15 个暗子位的「占位 id」（即暗子阶段写在 `qiPan` 上的 id）：

| 初始位 | 数量 | 占位 id（红 / 黑） |
| --- | --- | --- |
| 底线两端 | 2 | 车 `23,24` / `7,8` |
| 马位 | 2 | 马 `21,22` / `5,6` |
| 相位 | 2 | 相 `19,20` / `3,4` |
| 仕位 | 2 | 仕 `17,18` / `1,2` |
| 炮位 | 2 | 炮 `25,26` / `9,10` |
| 兵/卒位 | 5 | 兵 `27..31` / 卒 `11..15` |
| 九宫正中 | 1 | 帅 `16` / 将 `0` ——**明子，不参与洗牌** |

> 注：上表 id 同时也是这些格子上「真实身份恰好相同」时的标准 id。
> 由于采用**占位即退役**制（§3.1），占位 id 只需在暗子存续期间写在盘上；
> 揭开后该 id 退役、真实身份占位顶上，故两种 id 在同一时刻不会并存于同一格。

---

## 5. 规则引擎改造

**只改 4 个函数，全部带 `variant` 分支，默认路径零行为变化。**

### 5.1 `MoveCheck.calcXiang` / `calcShi` —— 士象过河

现有 `calcXiang`（`MoveCheck.ts:199`）用行带判河界；`calcShi`（`:223`）锁九宫。
揭棋下，**已翻开的**士/象放宽。

**由于「占位即退役」制（§3.1），揭开后的子带真实 id，且 `hiddenMask` 为 `false`** ——
所以这两个函数只需要在「当前子不是暗子」时走放宽分支。改法很轻：

- `calcShi`：放宽条件 = `variant === 'jieqi' && !hiddenMask[moveQiZi]`；
- `calcXiang`：同理。

由 `fillPathPoints` 按 `variant` + `hiddenMask[moveQiZi]` 传入。

> ⚠️ 这是本方案**唯一**触碰三端唯一真源文件的地方。
> `MoveCheck.ts` 现有分支的输出**必须逐点不变**（由 §12 的 `jieqiVariantIsolation` 回归铁闸钉死）。

### 5.2 `GameEngine.makeMove` —— 走子即翻开（核心改动点）

现有 `makeMove`（`GameEngine.ts:436-534`）里追加揭棋分支：

```ts
// 揭棋：暗子移动后自动翻开（占位即退役制，见 §3.1）
// 1. makeMove 入口读 state.hiddenMask[pieceId]
//    · true  → 走法校验用【占位 id】(qiPan 上已经是它，走法天然正确)
//              落子后：退役 pieces[pieceId]、按真实身份升起新 piece
//    · false → 完全走现有逻辑
// 2. newState.hiddenMask[newPieceId] = false
// 3. moveHistory 记 flippedPieceId（= 退役的占位 id），客户端据此播翻开动画
```

**关键不变式**：`qiPan` 上写的**始终是「当前生效 id」**——
暗子阶段写占位 id，翻开后写真实 id。这样 `getPathPoints`、`isTongBang`、UI 渲染
全都自动正确，无需任何一处知道「真实身份」的存在。

**注意 `moveHistory` 的语义扩展**：`pieceId` 字段对暗子记的是**占位 id**。
标准象棋下该字段不变（无 `variant` 即无占位），故历史兼容。

### 5.3 `RuleEngine.positionKey` —— 局面指纹要含暗子态

现有 `positionKey`（`RuleEngine.ts:121`）= 全部活子的 `id:col,row` + 走棋方。
揭棋下，**两块一模一样的棋盘但暗子身份不同，是不同的局面**（信息状态不同），
否则重复局面判和会算错。

改法：**条件追加** `hiddenMask` 的 32 位位图到指纹串：

```ts
const key = base + (state.variant === 'jieqi' ? hiddenBitmap(state.hiddenMask) : '');
```

> ⚠️ 必须是**条件追加**而不是无条件追加后缀：现有实现是字符串拼接，
> 无条件追加会改变**所有**既有象棋指纹值，导致 `ruleState.positionKeys` 里的历史记录全失效。
> 标准象棋下指纹值必须**逐字符不变**（§12 `jieqiVariantIsolation` 钉死）。

**附带收益**：因占位 id 在暗子期就已确定走法，暗子期指纹天然包含「哪些格是暗子」，
只需再补「暗子的真实身份分布」——由于洗牌均匀随机，同一可见局面下的身份分布可由
「已翻开集合 + 剩余身份多重集」完全确定，故位图已足够，无需把真实身份写进指纹。

### 5.4 暗子被吃的处理

吃暗子的一方拿到的是一枚**背面朝上的新暗子**：

1. 被吃子置 `alive = false`；其真实身份回收进服务端身份池（**不外发**）；
2. 吃子方升起一枚**新的暗子占位 id**，放在吃子方阵营内、`hiddenMask[newId] = true`；
3. `jieqiSecret.identity[newId] = 从池中取出的一枚未使用真实身份`（`newId` 必须取自 `freeSlots` 退役栈）；
4. 该新暗子的**占位 id 按 §5.5 的规则由落点决定**。

> 因为「暗子移动即翻开」，新暗子**只会在落点原地待着**，直到某一方移动它。
> 所以「落点决定类型」的映射只需覆盖**己方阵营内的格子**（§5.5）。

**32 格命名空间够用吗？** 每方最多 15 次「吃暗子升新暗子」。
按占位退役制实现时，退役的是**占位 id**（可安全复用），而**真实 id 一旦升起就永久占用**。
单方真实 id 上限 = 初始明子 1（将/帅）+ 15 次揭示 = 16，叠加对方 16 = **32，刚好用尽**。

> ⚠️ 实现必须**精确复用退役的占位 id**，绝不能再申请新格；
> 且在 `hiddenMask[newId] = true` 之前要断言该格已退役且 `hiddenMask` 为 `false`。
> 该断言进 §12 的槽位耗尽用例。

### 5.5 被吃暗子落在己方阵营后，按哪种子力走？（**已定稿**）

这是揭棋规则里**唯一没有权威统一表述**的细节。两个官方规则文本都没写。
本方案提议的默认约定（按**列**映射，与底线棋子类型一致，且把中路留给兵）：

| 落点列 | 0 / 8 | 1 / 7 | 2 / 6 | 3 / 5 | 4 |
| --- | --- | --- | --- | --- | --- |
| 走法 | 车 | 马 | 象 | 士 | 兵/卒 |

理由：① 覆盖全部 9 列；② 九路正中已被帅/将占据，不会与暗子冲突；③ 与「中路是兵道」的棋理直觉一致。

✅ **已定稿**（§14 决策 #2）：按此表实现。若日后要改，只改这一张表。

### 5.6 终局判定

- 帅/将始终明子，**不存在「翻开发现是将」**；
- `makeMove` 中「将/帅被吃」的判定（`GameEngine.ts:510-517`）原样适用；
- `isJueSha` / `isKunBi` 复用，但揭棋下**困毙更容易发生**（暗子走法受限），属正常。

---

## 6. 服务端改造

### 6.1 房间设置与开局

| 位置 | 改动 |
| --- | --- |
| `Room.settings`（`lanGame.ts:191`） | 新增 `variant?: 'xiangqi' \| 'jieqi'` |
| `Room`（`lanGame.ts:178`） | 新增 `jieqiSecret: JieqiSecret \| null` |
| `POST /rooms`（`:895`） | 接受 `variant`，`parseVariant` 校验（白名单） |
| `PATCH /settings`（`:1189`） | 同上，仅房主 + 仅 waiting |
| `startPlayingRoom`（`:795`） | **唯一初始局面收口点**：`variant === 'jieqi'` 时走 `createJieqiInitialState(secret)`，否则走现有 `createInitialState` |
| `actSide`（`:1277`） | 揭棋房**拒绝让子**（与现有让子房同款处理：`handicap` 非空即 400） |
| `actMove`（`:1468`） | 揭棋分支：走法校验用**占位 id**（盘上就是它），落子时按退役/升起两段揭示身份 |

### 6.2 初始摆子算法（`createJieqiInitialState`）

```
1. 红黑各自持有固定身份多重集：
   红 = {车×2 马×2 炮×2 仕×2 相×2 兵×5}，黑同理
2. 各自独立洗牌（Fisher–Yates，取随机源用服务端 crypto.randomInt）
3. 把每个身份类的**任一同类占位 id** 固定分配给该格子的暗子
   ——走法由占位 id 决定（§3.1），真实 id 只写进 jieqiSecret.identity
4. hiddenMask：除帅/将外全部 true；identity[占位 id] = 真实 id
```

**洗牌用 `crypto.randomInt` 而非 `Math.random()`**：本仓库所有安全相关随机都用 `crypto`
（`issueSessionToken` 用 `crypto.randomBytes`，`tokenEquals` 用 `timingSafeEqual`）。
用 `Math.random` 会让「猜种子 → 还原全部暗子身份」成为理论可行的作弊路径。

### 6.3 出站投影收口

新增单一函数（建议放 `lanGame.ts` 或新文件 `routes/jieqiView.ts`）：

```ts
/** 房间对客户端的公开棋盘。标准象棋 = 恒等；揭棋 = 附带 hiddenMask（棋盘本身已是占位 id，无需改写）。 */
export function publicGameState(room: Room): Record<string, unknown>;
```

**必须改造的 4 个下发点**：

| # | 位置 | 现状 |
| --- | --- | --- |
| 1 | `buildGameStatePayload` `:523-527` | 经 `slimGameState(room.gameState)` |
| 2 | `buildFullGameStatePayload` `:601-610` | **直返引用**，需改为投影 |
| 3 | `GET /rooms/:id/gameState` `:1571` | 用全量载荷，随 #2 自动覆盖 |
| 4 | **`POST /rooms/:id/spectate` `:1628`** | **`gameState: room.gameState` 直返，必须单独改** |

另需检查 `GET /rooms/:id`（`:1148`）—— 目前不含 `gameState`，但要确认 `settings` 不泄漏
（`variant` 本身不是秘密，可以下发）。

### 6.4 悔棋快照

现有 `stateHistory`（`lanGame.ts:217`）存 `gameState` 引用。揭棋需要**同时**存 `jieqiSecret`：

```ts
// 标准象棋：压栈仍是 state 引用（零成本，沿用现有论证）
// 揭棋：压栈 { gameState, secret }，二者都是不可变快照，引用安全
```

`actUndoResponse`（`:1931`）与 `fullSyncPending` 机制（`:1988`）**无需改动**，自动生效。

### 6.5 观战的信息隔离

官方规则未定义观战者能看到什么。本方案定：**观战者与对局双方看到完全相同的公开信息**
（都看不到未翻开的暗子身份）。这与现有观战实现零冲突——
观战者本来就只吃 `state` 广播和 `POST /spectate` 的同一个 `gameState`。

---

## 7. 协议改造

### 7.1 走子消息：**不需要改**

现有 `BattleMove = { pieceId, toCol, toRow }`（`battleProtocol/types.ts:52`）。
揭棋下客户端发的 `pieceId` 就是**盘上的占位 id**——它本来就是客户端唯一知道的东西。
服务端拿到后按占位 id 校验走法，再按退役/升起两段揭示身份。

**这是 §3.1 设计的直接红利：协议零改动，且客户端天然无法伪造身份。**

### 7.2 新增字段（全部可选，向后兼容）

```ts
interface GameStatePayload {
  // ... 现有字段不动
  /** 揭棋房间标记；缺省即 'xiangqi' */
  variant?: 'xiangqi' | 'jieqi';
  /** 揭棋专属：被吃暗子计数（不含身份） */
  jieqiCapturedHidden?: { red: number; black: number };
}
```

### 7.3 失败码复用

`FAILURE_CODES`（`actionOutcome.ts:29`）已有 8 个通用码，揭棋**不需要新增**。
错误文案沿用 `ruleEngine.banReasonNotice` 的同源模式（`ruleEngine.cjs` 已导出）。
**不要**把中文塞进 `error` 字段（该文件 `:24-27` 明确禁止）。

### 7.4 AI 路由：揭棋**禁止**走 `/ai/move`

`POST /api/v1/ai/move` 的 FEN 会直接进 Pikafish WASM（`ai.ts:97` → `pikafishWorker.cjs:117`）。
揭棋的暗子状态**无法用 FEN 表达**，且一旦误传，`isFenBoardShapeValid` 拦不住（行宽仍合法），会让引擎在错误局面上搜索。

**定稿**：客户端 `aiDispatcher` 在 `variant === 'jieqi'` 时**根本不发这个请求**，直接走本地 AI。
并在 `runHybrid` 入口加一道显式短路 + 断言（防止将来有人加了个调用点绕过）。

> ⚠️ **实测发现的加固缺口（建议顺带修）**：`isFenBoardShapeValid`（`ai.ts:60-81`）
> **只校验 FEN 的第 1 段**（10 行 × 宽 9），第 2 段及之后一概不看。
> 这对现有象棋是安全的（`parseSideToken` 只取末 token）。
> 但揭棋 FEN 是 5 段方言、第 3 段是「未揭暗子池」（如 `R2A2C2P5N2B2r2a2c2p5n2b2`），
> 该守卫会**放行**一个 Pikafish WASM 完全无法解析的 FEN。
>
> 建议在 `aiRouter.post('/move')` 增加一条白名单拒绝：
> 若 `parts.length > 2 && !/^\d+\s+\d+$/.test(parts.slice(2).join(' '))` 则 400 `invalid_fen`。
> 这样即便将来有人误把揭棋状态送进 `/ai/move`，也会被挡在 WASM 之前（与既有加固 #2 同源）。

---

## 8. 客户端改造

### 8.1 路由与页面

```
client/app/jieqiSetup.tsx        → screens/jieqiSetup   （揭棋人机设置：难度/执棋方/先后手）
client/app/jieqiGame.tsx         → screens/jieqiGame    （揭棋对局）
```

在 `app/_layout.tsx` 的 `<Stack>` 里加两行（该文件 `:38-47`）。
首页 `screens/home/index.tsx` 加一张入口卡片，沿用现有 `pushOnce` 800ms 防连点锁（`:56-61`）。

### 8.2 `ChessBoard` 暗子渲染

**唯一改动点**在 `components/ChessBoard.tsx:796`：

```tsx
imageSource={getPieceImage(piece.id)}
```

改为按 `hiddenMask` 选择背面图。既有先例可照抄——`ghostPieces` 层（`:749-784`）
已经在做「用棋子图 + 非交互 + 半透明」的事，结构完全一致。

新增 props：
- `hiddenMask?: boolean[]` —— 与 `pieces` 对齐
- `flipTargetSlot?: number | null` —— 刚落子准备翻开的子（播翻开动画）

**注意 `PieceItem` 的 memo 比较器**（`:191-198`）目前只比较
`isSelected/animX/animY/pieceSize/imageSource`。翻转瞬间 `imageSource` 会变 → 天然触发重渲染，
**不需要改 memo**。

### 8.3 新增资源

- `assets/pieces/face_down.png`（背面图，红黑通用或分两版）
- 翻开音效：复用现有 `SoundManager` 的 `select` / `go`，**不新增音频**（避免包体膨胀）
- **必须**在 `utils/preloadAssets.ts:47-55` 的预热循环里加入背面图
  ——该文件当前硬编码 `for (let id = 0; id < 32; id++)`，新资源漏了会有首帧解码延迟

### 8.4 Hook 拆分（不得内联进巨型文件）

参照现有 `useNewGame.ts` 的形态，新建：

| Hook | 职责 |
| --- | --- |
| `useJieqiNewGame` | 初始摆子、翻转动画触发、重开 |
| `useJieqiMove` | 选中/落点/揭子/吃暗子，封装 §5 的落子顺序 |

### 8.5 约束遵守清单（`client/AGENTS.md`）

- 字号**必须**取自 `FONT.*`（`utils/typography.ts`），禁止 `StyleSheet` 裸数字；
- 颜色沿用各屏既有的本地 `COLORS` 常量（`primary #8B6914` / `accent #B22222` / …），**不要**新造一套；
- 样式用 tailwind/Uniwind 的 `className`；
- 路径必须 `@/…`；
- **禁止 emoji 当图标**（`DESIGN.md` + eslint `forbidEmoji`），用 `@expo/vector-icons`；
- 新增依赖只能用 `npx expo install`（禁 npm/yarn）；
- **不得**改 `client/assets/boards/_source/` 下的棋盘图（揭棋复用现有棋盘样式，不出新图）。

---

## 9. AI 方案

### 9.1 结论：首版**不做**在线揭棋 AI（结论不变，但理由已更正）

> **详见 §9.2**（外部引擎评估，因逻辑上从属本节而置于其后）。

> **2026-10 更正**：本节原写「不存在可直接复用的 Pikafish 揭棋分支」——**该结论有误**。
> 经核查，**揭棋分支确实存在**（见下方 §9.2 评估）。
> 但「首版不做在线揭棋 AI」的**结论仍然成立**，理由换成下面这些真正成立的障碍。

结论成立的真实理由：

1. **GPLv3 传染性**：唯一有强引擎底座的揭棋引擎是官方 `Pikafish` 的 `jieqi` 分支，
   许可证为 **GPL v3**。本仓库客户端是**闭源商业分发**的 zip 包，
   把该引擎编入服务端 zip 需履行 GPL 源码开放义务 —— 这是**法务级障碍，不是技术障碍**。
2. **无 Emscripten 构建路径**：`jieqi` 分支是 C++ 原生构建（`make -j build` → ELF 可执行文件），
   仓库内无任何 `.wasm` 产物或 emscripten target。现有 WASM worker 池架构**不能直接复用**。
3. **NNUE 权重不可得**：该分支的权重哈希体系（起始常量 `0xEC42E90D`）与官方 master
   （`0x6E24xxxx`）**完全独立**，实测官方**全部 16 个 release 的权重均加载失败**、
   官方 `Networks` 仓库无历史存档、GitHub 上 182 个相关仓库无人发布过 `.nnue`。
   目前仅社群（QQ 群 / Discord）分发。
4. **上游停滞**：`jieqi` 分支最后提交 2025-08，落后 master 约一年。
5. **协议不兼容现有 `/ai/move`**：揭棋 FEN 是 5 段方言（多「未揭暗子池」字段），
   且走法需在 4 字符后**追加揭晓后缀**（`e7e6R` / `e7e6Rp`）——
   现有 `isFenBoardShapeValid`（`ai.ts:60-81`）只校验**前两段**，第 3 段根本不看，
   等于**放行**一个引擎完全无法解析的 FEN（详见 §7.4 的加固建议）。

以上 5 条中，**第 1、3 条是硬阻塞**，且都不是本仓库能单方面解决的。

### 9.2 外部引擎评估：[lichlzh/pikafish-jieqi](https://github.com/lichlzh/pikafish-jieqi)

**结论：不可作为本应用的揭棋 AI —— 但它是本次调研最有价值的资料来源。**

#### 9.2.1 它是什么（重要纠正）

**它不是引擎，是 Qt6 桌面 GUI**（PikaJieqi，C++17 + CMake）。已核对实际文件树：

```
app/  core/  docs/  engine/  tests/  tools/  ui/  CMakeLists.txt  LICENSE  README.md
```

`engine/` 目录下**只有 `engineclient.cpp/.h`** —— 一个基于 `QProcess` 的 **UCI 客户端**，
即它**spawn 外部 Pikafish 进程**并与之说 UCI。**它本身不含任何引擎源码或算力。**

依赖关系是：**它 → 调用 → 官方 `Pikafish` 的 `jieqi` 分支**（`jieqi_old` 分支产物叫 `PikaJieqi`）。
它自己的代码是 **MIT**，但**真正要用的引擎是 GPLv3** —— 约束在引擎侧，不在它。

> ❌ 直接用作 AI：**不可能**（无引擎、需桌面 GUI + 子进程）。

#### 9.2.2 但它的规则实现与我的方案对上了

它的 `core/` 是一个不依赖 Qt 的纯 C++17 揭棋规则实现，**其规则表述与本方案 §1.1 一致**：

1. 除将帅外全部暗置，摆在初始位置，**暗子按所在棋位对应的棋种走子**（兵位只能向前一步）；
2. 暗子**第一次走动时翻开**，之后按真实棋种走；**暗子被吃时也翻开**；
3. 已翻开的**士、象不受九宫与河界限制**（士可斜走一格到全盘，象可过河，仍受蹩象眼）；
4. 引擎只能看到暗子 + 未揭暗子池，**真身由对局层掌握**。

> ✅ **第 1 条正面印证了本方案 §3.1 的「占位 id」设计**——它也是靠「暗子按所在棋位对应棋种走子」实现的。
> ✅ **第 3 条印证 §5.1 的士象过河**。
> ⚠️ **第 2 条「暗子被吃时也翻开」是对本方案 §1.3 修正 #2 的一个反例**：见下方「待确认」。

#### 9.2.3 它揭示的揭棋协议（对本方案 §1.3 修正 #4 有直接影响）

它的 README 记录了官方 `jieqi` 分支的实际方言：

```
初始 FEN（5 段）：
xxxxkxxxx/9/1x5x1/x1x1x1x1x/9/9/X1X1X1X1X/1X5X1/9/XXXXKXXXX w R2A2C2P5N2B2r2a2c2p5n2b2 0 1
                                                              └ 第 3 段 = 未揭暗子池（棋种+数量）

走法（4 字符后追加揭晓信息）：
  e7e6     无揭晓
  e7e6R    5 字符：若落点仍是暗子 → 自身暗子揭为红车；否则 → 被吃暗子身份为 R
  e7e6Rp   6 字符：R = 自身揭晓，p = 被吃暗子身份
```

**这验证了本方案 §1.3 修正 #4 的方向**（另起格式、不硬塞标准 FEN），
但也说明**引擎确实需要一个显式的「暗子池」字段**——本方案的 `jieqiSecret.identity` 承担的正是这个角色，
只是本方案把它**完全私有在服务端**，从不发给任何引擎或客户端。

#### 9.2.4 「暗子被吃时是否翻开」—— ✅ **已定稿：选 B**

该 README 明写「暗子**被吃时也翻开**」，并把「被吃暗子是否向玩家展示真身」列为**可选项**
（称竞技规则存在「不翻开」的变体）。

这与本方案 §1.3 修正 #2（依据腾讯官方 + 棋者象棋两处「己方暗子被吃后己方不能看到是什么棋」，
定稿为**吃子方也看不到**）**存在分歧**。三种可能：

| 解释 | 含义 | 裁定 |
| --- | --- | --- |
| A. 被吃暗子对**吃子方**翻开 | 吃子方获知身份 | ❌ 未采纳 |
| **B. 被吃暗子**仅对被吃方**翻开** | 即「己方被吃的暗子自己看见是什么」 | ✅ **已定稿** |
| C. 引擎内部翻开、对玩家可选 | 规则层与展示层分离 | ❌ 未采纳 |

> **定稿理由**：与已交叉核实的两个官方来源一致（§1.1 规则 4）。
> 「己方暗子被吃后，己方不能看到它是什么棋」——限制的是**被吃方**，
> 而吃子方同样看不到：它拿到的是一枚**背面朝上、位于己方阵营**的新暗子。
>
> **连带确认**：§14 决策 #2（被吃暗子落在己方阵营后按**落点列**走）与本条是**两个独立问题**，
> 二者同时成立且已一并定稿 → **§5.4 的「身份回收进服务端身份池 + 升起新暗子」逻辑完全成立，无需改动**。
>
> **§2.1 铁律 A 不开例外**：任何时刻都不因「谁被吃」而向任何客户端释放身份。

#### 9.2.5 其余评估结论

| 维度 | 结论 |
| --- | --- |
| 能否作 AI | ❌ 是 GUI，非引擎 |
| 能否作规则参考 | ✅ **可以，且价值高**（`core/` 纯 C++17、含 perft 测试与暗子池不变量测试） |
| 能否作 UI 参考 | ⚠️ Qt Widgets，与 Expo/RN 无技术交集 |
| 许可证 | 本体 MIT（可借鉴）；引擎 GPLv3（阻塞商业分发） |
| 维护状态 | 未核实（README 标注调研时间 2026-08，提交日期未取得） |

### 9.3 本地 AI：信念采样 + 复用现有 alpha-beta

现有 `AIEngine.ts`（1814 行）已有完整骨架：迭代加深 alpha-beta、静态搜索、杀手着法、
将军延伸、时间预算分片让出（`SEND_SLICE_MS = 12`）。揭棋版**复用全部骨架**，只改两处：

1. **着法生成**：对暗子按占位 id 生成（`generatePseudoMoves` 已按 id switch，天然支持）；
2. **评估**：现有 `evaluate`（`:475`）用 `PIECE_VALUES[pieceId]` 查表，
   而暗子的盘上 id 是占位（可能把马算成车的 600 分）→ **必须按信念取期望**：

```
E[eval] = Σ P(占位 id → 真实身份) × PIECE_VALUES[真实身份]
```

`P` 的来源：服务端洗牌时身份均匀随机 ⟹ **对每个暗子，每种剩余身份的概率 = 剩余数量 / 剩余身份数**。
这个后验分布是**精确可算的**（超几何分布），不需要采样——只要维护「本方还剩哪些身份、还剩几枚暗子」即可。

> 这是揭棋 AI 最优雅的一点：**暗子后验是解析可算的**，不需要蒙特卡洛。

3. **搜索中的翻转**：暗子走完即翻开 ⟹ 搜索树里「走暗子」= 「获得真实身份」。
   故在 `applyMove` 处按当前后验**采样一个身份**（Pikafish 揭棋版是「每层随机选一次后固定」，
   本方案同样在每个节点采样一次并固定到该子树），这会引入非确定性 →
   **提示（hint）功能必须关掉随机采样**，否则同一局面两次提示不同，会重现现有 `hint` 通道
   「纯最佳确定性」的同类问题。

### 9.4 强度预期（务必如实告知产品）

现有本地 AI 的预算是 `TIME_BUDGET {easy:500, medium:1200, hard:2500}` ms、
`MAX_DEPTH {easy:2, medium:3, hard:4}`（`AIEngine.ts:1223-1234`），且引擎**没有置换表**。

揭棋下每节点还要多算一层身份期望 ⟹ **同等时间预算下深度必然下降**。建议首版：

| 难度 | 建议 | 说明 |
| --- | --- | --- |
| 入门 | 深度 2，随机性高 | 主动多翻子、少算 |
| 进阶 | 深度 3 | 与现有 medium 对齐 |
| 大师 | 深度 3 + 提示 | **不建议给深度 4**，JS 单线程扛不住 |

### 9.5 自对弈评测（§12 的一部分）

原方案建议用 [lxsgx23/Jieqi-Match-Tools](https://github.com/lxsgx23) 一类自对弈框架。
本仓库已有 `scripts/verify-server-diff.cjs`（77KB，L2 差分）这类重跑验证的先例，
建议改造成**揭棋自对弈冒烟**（各难度互搏 20 局，断言：无非法着法、无死循环、终局全部可判定）。

---

## 10. 存档 / 复盘 / 悔棋 / 观战

### 10.1 存档（PVE 续局）

`utils/GameSave.ts` 存**完整 `GameState`**（含 `ruleState`）。
揭棋下 `GameState` 新增的 `variant` / `hiddenMask` 会**自动**被 `JSON.stringify` 带上。

- ✅ `isValidGameSave`（`GameSave.ts:50`）的 32 子结构校验**天然通过**；
- ⚠️ **必须新增一条校验**：揭棋存档的 `hiddenMask.length === 32`，
  且「`hiddenMask[i] === true` 的子必须是活子」——否则坏档会让 UI 显示不存在的暗子。
- ⚠️ 存档 key 是**单槽位**（`chess_game_save`）。象棋与揭棋**必须分 key**
  （新增 `chess_jieqi_game_save`），否则揭棋存档会被象棋的「继续对局」读到而崩溃。
  **这是最容易踩的坑**，因为 `isValidGameSave` 的校验恰好拦不住它。

### 10.2 复盘

`replayStorage.ts` 的 `ReplayGame` **结构上无法表示揭棋**：它只存 `moves[]` + `firstMoveSide`，
复盘时 `createInitialState` 重建（`screens/replayPlayer/index.tsx:71-85`），初始暗子身份无从还原。

方案：新增可选字段
```ts
/** 揭棋：初始摆子的完整真相（仅在终局后随结算下发，中局绝不下发） */
jieqiFinalSecret?: { identity: number[]; seed: number };
```
**只存终局后的快照**，不存「种子」——因为摆子用的是 `crypto.randomInt`（§6.2），
其输出**不可由单个种子复现**，所以复盘必须存摆子结果本身，而不是种子。
中局进行中绝不下发该字段（§2.1 铁律 A）。

普通象棋存档这两个字段为 `undefined`，`replayPlayer` 的重建路径不变。

> 备选方案（若产品要求「种子更小」）：把洗牌改成 `crypto.randomBytes` 产出**足够长的字节串**
> 作为种子、之后用确定性 PRNG 展开。这样既保留密码学强度又能复现。
> 但增加了实现复杂度，**首版建议直接存终局快照**（32 个整数，JSON 体积可忽略）。

### 10.3 悔棋

服务端快照栈天然支持（§2.3 / §6.4），**客户端无需改动**。
UI 文案上有一处差异需要产品确认：现有 `pendingUndo.depth` 的 1/2 手语义（`lanGame.ts:1844`）
在揭棋下依然成立（回退 1 手或 2 手），**但暗子身份会随之回滚**——
即「悔棋后被吃走的暗子会重新变回暗子」。这在规则上正确，但用户观感特殊，文案需在
`resolveUndoDepth` 之外加一句说明。

### 10.4 观战

§6.5 已定：与双方看到相同的公开信息。零改造。

---

## 11. 资源与打包

### 11.1 棋盘图

**复用现有 3 套棋盘样式（经典/花梨木/玄墨），不出新图**。
揭棋的棋盘与象棋完全一致。

### 11.2 棋子资源

新增 `assets/pieces/face_down.png`。棋子图走 `utils/chess/pieceImages.ts` 的 `require()` 静态引入
（Metro 要求静态可分析），在 `PIECE_IMAGES` 之外**单独加一个** `FACE_DOWN_IMAGE` 导出。

> ⚠️ 棋盘图必须走索引色 PNG 流水线（`board_assets.py`），但**棋子图不受此约束**
> （该流水线只管 `assets/boards/`）。棋子图按现有 14 张的规格做即可。

### 11.3 打包闸门（`AGENTS.md` 硬性要求）

本任务**必然触及** `chinese-chess-client/`，因此收尾必须：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\pack.ps1 all
```

且若改了规则引擎源码，还必须：

```powershell
node chinese-chess-server/scripts/verify-rule-engine-parity.mjs --write
# 然后重启服务端（dist/index.js 用 require 加载 ruleEngine.cjs，不热更）
pnpm -w validate
```

---

## 12. 测试与校验

### 12.1 新增测试文件（`client/utils/chess/__tests__/`）

| 文件 | 覆盖 |
| --- | --- |
| `jieqiSetup.test.ts` | 洗牌分布：15 枚身份不重复、与占位 id 的对应一致、帅/将恒为明子、红黑置换独立 |
| `jieqiMove.test.ts` | **占位走法等价性**：对每个占位 id，断言「暗子走点」===「对应明子走点」（复刻原方案 §6 的黄金快照思路） |
| `jieqiFlip.test.ts` | 暗子移动后翻开；占位 id 退役、真实 id 顶上；`flippedPieceId` 正确；揭开前后走法从占位切到真实 |
| `jieqiAttack.test.ts` | **暗子不将军**：构造「底线占位车与对方将帅照面」，断言 `isJiangJun` 返回未被将、`afterMoveStillJiangJun` 不误判飞将 |
| `jieqiSlotBudget.test.ts` | **槽位耗尽**：模拟一路吃满 15 枚暗子，断言始终无「两活子共用同一 id」、占位 id 均取自退役栈、真实 id 总占用 ≤ 32 |
| `jieqiReveal.test.ts` | 暗子被吃：吃子方拿到新暗子且 `identity` 不外泄；被吃方也不可见 |
| `jieqiVariantIsolation.test.ts` | **`variant` 缺省 = 'xiangqi'` 时，所有既有走法/终局/`positionKey` 指纹输出逐字符不变**（回归铁闸） |
| `jieqiNoLeak.test.ts` | 对 `publicGameState` 的输出做 JSON 序列化，断言**不含任何未翻开暗子的真实 id**；**重点覆盖「吃暗子之后」**（依 §14.2 选 B，吃子方亦不可见） |
| `jieqiAi.test.ts` | 身份后验为超几何分布：K=15 时单车概率 2/15；剩 1 枚时必为该身份 |

### 12.2 服务端测试（`chinese-chess-server/scripts/`）

仿现有 `verify-server-hardening.cjs` 的形态新增 `verify-jieqi.cjs`，断言：

1. **四条下发路径**的响应体都不含未翻开身份（重点：`POST /rooms/:id/spectate`）；
2. 揭棋房 `actMove` 的越权检查：客户端提交一个「盘上不存在 / 非占位」的 id → 400；
3. 洗牌用 `crypto.randomInt`（源码扫描）；
4. 揭棋房拒绝让子；
5. 悔棋回退后 `hiddenMask` / `identity` 与快照一致。

### 12.3 闸门挂载

把 `verify-jieqi.cjs` 挂进 `chinese-chess-client/package.json` 的 `validate` 链（现为 5 步，`:20`），
与现有 `verify:rule-engine-parity` / `verify:board-assets` 并列。

### 12.4 手工验收清单

- [ ] 暗子背面朝上，不可点开查看身份
- [ ] 兵位暗子的落点只有正前方一格
- [ ] 暗子移动后翻开，音效 + 动画正确
- [ ] 吃暗子后对方看不到身份，自己也看不到
- [ ] **开 DevTools 直接看 WS 帧，确认无身份泄漏**
- [ ] 揭开的士能出九宫、相能过河
- [ ] 悔棋后暗子状态正确回滚
- [ ] 断线重连后暗子信息完整（走全量载荷路径）
- [ ] 观战者看不到暗子身份

---

## 13. 分阶段实施

| 阶段 | 范围 | 是否动服务端 | 可交付 |
| --- | --- | --- | --- |
| **P0 规则底座** | `types.ts` 加 `variant`/`hiddenMask`；`MoveCheck`/`makeMove`/`positionKey` 的分支；洗牌函数；全部单测 | ❌ | 无（纯引擎） |
| **P1 离线人机** | `jieqiSetup`/`jieqiGame` 两页 + 入口卡片；`ChessBoard` 暗子渲染；背面图资源 + 预热；本地 AI（信念期望） | ❌ | **可玩的单机揭棋** |
| **P2 在线对局** | 服务端 `variant` 设置、`jieqiSecret`、`publicGameState` 收口（含 spectate 修复）、悔棋快照、`verify-jieqi.cjs`；`aiDispatcher` 显式短路 | ✅ | 联机揭棋 |
| **P3 复盘/存档** | `jieqiFinalSecret` 字段、存档分 key、复盘还原 | ✅ | 完整复盘 |
| **P4（不排期）** | 原地翻子、在线揭棋引擎接入 —— 依 §14 定稿均**不做**，仅保留为预留开关 | — | 无（不排期） |

**建议 P0+P1 先跑通再评审**，因为 P1 已经能验证最核心的「暗子体验」，且完全不碰服务端，风险最低。

---

## 14. 已定稿决策（2026-10 确认，按本方案默认项执行）

以下 6 项**已全部确认按本方案默认执行**，不再是待议项。实现时直接照此写，无需再等拍板。

| # | 议题 | **定稿** | 实现落点 |
| --- | --- | --- | --- |
| 1 | **原地翻子** | ❌ **不做**。揭棋只有「走子即翻开」一种翻开方式 | 不实现任何原地翻子动作。若日后要开，须新增走子类型 + 协议字段 + 空步计数重置 |
| 2 | **被吃暗子落在己方阵营后的走法** | ✅ **按落点列映射**（§5.5 表）：列 0/8→车、1/7→马、2/6→象、3/5→士、4→兵/卒 | `jieqi.ts` 的落点→占位 id 映射表 |
| 3 | **空步判和阈值** | ✅ **沿用现有 `RULE_CONFIG.naturalMoveLimit = 120` 步**（不改本仓库既有阈值） | 无需改动 |
| 4 | **观战者可见信息** | ✅ **与对局双方完全相同的公开信息**（全程看不到未翻开暗子身份） | `publicGameState` 对玩家/观战者同构，零额外分支 |
| 5 | **揭棋「让子」** | ❌ **不支持**。`handicap` 非空即拒绝开局 | 复用现有让子房拒绝逻辑（§6.1） |
| 6 | **揭棋 AI 首版强度** | ✅ **本地 AI，深度 入门 2 / 进阶 3 / 大师 3**（§9.4）；首版不做在线揭棋 AI | `AIEngine` 揭棋分支 + `aiDispatcher` 短路 |

**连带效果**：第 1、5、6 项定为「不做」后，P4 阶段（原列「原地翻子 + 在线揭棋引擎接入」）
不再是既定内容，仅保留为**预留开关**，不排期。第 4 项定为「同构」后，
`POST /rooms/:id/spectate` 的投影改造与玩家路径**共用同一个函数**，无第二条分支。

### 14.1 定稿带来的架构收敛

由于「在线揭棋 AI」首版确定不做，§7.4 的硬约束成立且更有价值：

> 客户端 `aiDispatcher` 在 `variant === 'jieqi'` 时**根本不发 `/ai/move` 请求**，直接走本地 AI。

这条约束把揭棋与 Pikafish WASM **完全隔离**——既避免了「FEN 无法表达暗子」的语义错配，
也意味着揭棋路径**不会触及 `ai.ts` 的 `isFenBoardShapeValid`**，新增风险面为零。

### 14.2 第 7 项亦已定稿：**选 B**

| # | 议题 | **定稿** | 实现落点 |
| --- | --- | --- | --- |
| 7 | **被吃暗子是否向吃子方展示真身** | ✅ **选 B**：被吃暗子仅对**被吃方**翻开；吃子方拿到背面朝上的新暗子，按落点列走（§5.5） | `jieqi.ts` 身份池回收 + 升起新暗子（§5.4 现有逻辑，**无需改动**） |

> ✅ **全部 7 项均已定稿**（本表 1~6 + 本表 7）。方案不再有待决事项，可直接进入 P0 实现。
>
> **选 B 的连带效果**：
> - §2.1 **铁律 A 不开例外** —— 任何时刻都不因「谁被吃」向任何客户端释放身份；
> - §4.2 的 `JieqiPublicSetup.capturedHidden` **只下发计数、不下发身份**，维持原设计；
> - §12 的 `jieqiNoLeak.test.ts` 覆盖面扩大到「吃暗子之后」，断言吃子方载荷仍不含被吃暗子的真实 id。

---

## 15. 与原方案的差异总结

| 维度 | 原方案 | 本方案 |
| --- | --- | --- |
| 原地翻子 | 作为核心机制 | 默认不做，改为可选开关 |
| 暗子被吃的信息 | 吃子方可见（**方向反了**） | 双方均不可见（吃子方拿到背面暗子） |
| 架构 | 建议 React + Vite + Express + MySQL + Redis | **沿用现有 Expo + Express + 内存房间**，不引入任何新中间件 |
| 数据层 | 建议 MySQL + Redis | 现有是纯内存 `Map`，揭棋不改变这一点 |
| 走法生成 | 「以 positionType 生成伪合法走法」 | **用占位 id 直接喂现有 `MoveCheck`**，走法生成代码零改动 |
| FEN | 扩展 FEN 格式 | **不碰 FEN**，另起 `JieqiSetup` |
| AI | 集成皮卡鱼揭棋引擎 | 首版本地 AI；揭棋引擎确实存在（官方 `jieqi` 分支）但受 GPLv3 + 无 WASM + 权重不可得三重阻塞 |
| 观战 | 「除非对局结束」 | 默认全程不可见（与对局双方一致） |
| 交付 | 无 | 分 4 阶段，每阶段明确是否动服务端 |

---

## 附：需要改动的文件清单（预估）

**客户端（`chinese-chess-client/client/`）**
```
utils/chess/types.ts                        +variant +hiddenMask
utils/chess/MoveCheck.ts                    士象过河 + 攻击扫描跳过暗子（唯一动「真源」之处）
utils/chess/GameEngine.ts                   makeMove 翻开 + isJiangJun 跳过暗子
utils/chess/RuleEngine.ts                   positionKey 含暗子位图
utils/chess/jieqi.ts                        【新】洗牌、投影、AI 信念后验
utils/chess/pieceImages.ts                  +背面图导出
utils/preloadAssets.ts                      +背面图预热
components/ChessBoard.tsx                   +hiddenMask / flipTargetSlot
hooks/useJieqiNewGame.ts                    【新】
hooks/useJieqiMove.ts                       【新】
screens/jieqiSetup/index.tsx                【新】
screens/jieqiGame/index.tsx                 【新】
screens/home/index.tsx                      +入口卡片
app/jieqiSetup.tsx / app/jieqiGame.tsx      【新】路由
app/_layout.tsx                             +2 行 Stack
utils/GameSave.ts                           拆 key + 暗子校验
utils/replayStorage.ts                      +jieqiFinalSecret
screens/replayPlayer/index.tsx              +揭棋重建分支
utils/chess/__tests__/jieqi*.test.ts        【新】7 个测试文件
```

**服务端（`chinese-chess-server/`）**
```
src/routes/lanGame.ts    Room/settings/actMove/startPlayingRoom/4 个下发点/悔棋快照
src/routes/jieqiView.ts  【新】publicGameState 投影收口
ai/ruleEngine.cjs        重新打包产物（由 --write 生成，不手改）
scripts/verify-jieqi.cjs 【新】
```

**闸门**：`pnpm -w validate` 挂入新 verify；收尾 `pack.ps1 all`。
