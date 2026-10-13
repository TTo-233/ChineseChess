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

#### ⚠️ 占位 id 的生命周期（本方案最易实现错的一处，已在实现中被实测推翻并修正）

关键约束：`pieces` 是**固定 32 格、以 id 为下标**的数组（`pieces[id].id === id`），
棋盘 `qiPan` 里存的也是 id。而「占位 id」与「真实 id」**是同一套 1–15 / 17–31**。

> **🔴 实测结论（2026-10，实现阶段推翻本节原设计）**
>
> 原设计为「占位即退役」：揭开时退役占位 id、升起真实 id。**该设计在本仓库不可行。**
>
> 实测：任一初始局面下，**30 枚暗子的真实身份无一例外落在另一个仍在盘上的暗子的
> 占位 id 上**（id 集合完全重合，碰撞率 30/30，与种子无关）。
> 也就是说「升起真实 id」必然撞车并破坏 `pieces[id].id === id` 的下标语义 ——
> 即棋盘上会出现两枚子共享同一 id、将帅判定与崩溃防护全部失真。
>
> 参照实现（`lichlzh/pikafish-jieqi` 的 `core/position.cpp`）正是因此**从不换 id**：
> 它按格存储棋种，另用 `hidden_[square]` 平行数组记录「该格背面朝上」，
> 有效棋种由 `effectiveTypeAt(square)` 解析。**本方案改为与之同构。**

**修正后的设计：盘面 id 永不改变，只额外记录「已翻开的真实棋种」。**

```
GameState 新增两个与 id 平行、长度 32 的数组：
  hiddenMask[id]    = true  → 该子当前背面朝上（未翻开）
  revealedType[id]  = 棋种  → 该子已翻开，值即其真实身份；null = 未翻开

走法/攻击一律按「有效棋种」解析（jieqi.ts 的 effectiveTypeOf / effectiveIdOf）：
  未翻开暗子 → 用 id 自身的棋种（= 所在棋位的棋种）  ← 规则 2「暗子按棋位走」
  已翻开     → 用 revealedType[id] 的真实棋种

揭开瞬间（makeMove 内）只有两次字段写入，不碰 pieces：
  revealedType[pieceId] = identity.hiddenType[pieceId]
  hiddenMask[pieceId]   = false
  moveHistory 追加 { pieceId, revealedType }   // 供 UI 动画与精确 undo
```

由此得到的四条不变式：

1. **盘面 id 恒定**：`qiPan` 里的值与 `pieces` 下标永远一致（回归测试
   `jieqiSetup.test.ts` 的「id 冲突回归」用例钉死，翻开前后 `pieces[].id` 序列全等）；
2. **无需槽位预算**：不存在命名空间耗尽，原 §`jieqiSlotBudget` 一节作废；
3. **悔棋天然正确**：`undo` 只需把 `revealedType` 写回 `null`、`hiddenMask` 写回 `true`，
   没有置换需要复原；
4. **同棋种等价**：`effectiveIdOf` 把真实棋种映射到**该方同类棋子的代表 id**
   （车→车、马→马…），同类走法与攻击范围完全一致，故取哪一个都一样；
   卒/兵分属两方，故映射按方进行。

> 代价：已翻开的子不能沿用「真实 id」路径，而是多一次查表。
> 这是可接受的 —— 揭棋的 AI 与 UI 都需要按棋种渲染，本来就要查。

#### ⚠️ 暗子**不是**攻击者（与直觉相反，必须显式实现）

**未翻开的暗子不能将军。** 理由：暗子只有移动才会翻开，而移动前它从未动过，
不可能产生攻击。因此攻击扫描必须**跳过 `hiddenMask[id] === true` 的子**。

这与「暗子按棋位棋种走法」是两件独立的事：

| | 走法（能否动、往哪走） | 攻击（是否算将军） |
| --- | --- | --- |
| 未翻开的暗子 | 按**所在棋位的棋种** | **不攻击** —— 必须跳过 |
| 已翻开的子 | 按**真实棋种** | 正常攻击 |

因此 `isJiangJun`（`GameEngine.ts`）与 `afterMoveStillJiangJun`（`MoveCheck.ts`）
**都要拿到 `hiddenMask` 并跳过暗子**。前者是纯 `GameEngine` 改动；
后者需要给 `fillPathPoints`/`afterMoveStillJiangJun` **加参数**（`piecePositions` 已经是
只含 `{col,row,alive}` 的瘦结构，正好追加一个 `hidden: boolean` 字段即可，
调用点：`GameEngine.ts`、`RuleEngine.ts` 的攻击图构建路径 —— 需逐一核对）。

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
  /** hiddenType[占位 id] = 该暗子的真实**棋种**；仅当 hiddenMask[id] 为 true 时有意义。
   *  已翻开的子其真相已写入 GameState.revealedType，故此表只存「未翻开暗子」的真相。
   *  ⚠️ 存棋种而非 id —— 理由见 §3.1「实测结论」，id 方案会 30/30 撞车。 */
  hiddenType: (JieqiPieceType | null)[];
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
  pieceId: number;  // 标准象棋 = 真实 id；揭棋 = 盘面 id（**不因翻开而变**，见 §3.1）
  // ... 现有 5 个字段不动
  /** 该手若「走子即翻开」，记下翻开后的真实**棋种**；undefined = 未翻开 */
  revealedType?: JieqiPieceType;
}
```

`revealedType` 供**客户端动画**使用：「哪个子翻开成了什么字」。
注意它**只包含公开可见的信息** —— 翻开后的棋子本来就是明子，所以安全。

由于 `pieceId` 在揭棋下**不因翻开而改变**，历史可完整重放，
`undo` 也只需把 `revealedType` 写回 `null`（无置换需要复原）。

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
> 由于**盘面 id 永不改变**（§3.1 修正后的设计），上表 id 从开局到终局一直写在盘上，
> 身份变化只反映在 `revealedType` 上。故不存在「两种 id 并存」的问题，
> 也不存在槽位预算/耗尽。

---

## 5. 规则引擎改造

**只改 4 个函数，全部带 `variant` 分支，默认路径零行为变化。**

### 5.1 `MoveCheck.calcXiang` / `calcShi` —— 士象过河

现有 `calcXiang`（`MoveCheck.ts:199`）用行带判河界；`calcShi`（`:223`）锁九宫。
揭棋下，**已翻开的**士/象放宽。

**由于盘面 id 永不改变（§3.1 修正后的设计），只有「已翻开」的子需要按真实棋种走**。
放宽条件因此是 `variant === 'jieqi' && 该子已翻开 && 真实棋种 ∈ {士, 象}`：

- `calcShi` / `calcXiang`：接收调用方算好的 `crossRiver` 布尔量；
- 该量由 `jieqi.ts` 的 `crossRiverOf(state, id)` 给出：
  象棋恒 `undefined`（新分支永不进入），未翻开暗子给 `false`（不享放宽），
  已翻开的士/象给 `true`。

> 注：未翻开的暗子**不享**过河放宽，这与规则原文「揭开后的士、象可以过河」一致；
> 回归用例见 `jieqiVariantIsolation.test.ts` 的对照组。

由 `fillPathPoints` 把 `crossRiver` + `effectiveId` 一起传给分支函数。

> ⚠️ 这是本方案**唯一**触碰三端唯一真源文件的地方。
> `MoveCheck.ts` 现有分支的输出**必须逐点不变**（由 §12 的 `jieqiVariantIsolation` 回归铁闸钉死）。

### 5.2 `GameEngine.makeMove` —— 走子即翻开（核心改动点）

现有 `makeMove`（`GameEngine.ts`）里追加揭棋分支：

```ts
// 揭棋：暗子移动后自动翻开（见 §3.1）
// 1. 入口读 state.hiddenMask[pieceId]
//    · true  → 走法按盘面 id（= 棋位棋种），走法校验天然正确
//              落子后 revealedType[pieceId] = identity.hiddenType[pieceId]
//                       hiddenMask[pieceId]   = false
//    · false → 完全走现有逻辑
// 2. moveHistory 记 revealedType，客户端据此播翻开动画
```

**关键不变式**：`qiPan` 上写的**始终是同一个 id**（从头到尾不变），
`pieces` 的下标语义与 `pieces[id].id === id` 全部保持。
身份变化只落在 `revealedType` 这一层，故 `getPathPoints`、`isTongBang`、UI 渲染
都无需知道「真实身份」的存在 —— 只有走点派发与棋种渲染需要查 `revealedType`。

**被吃暗子（决策 A）**：只置 `alive=false`；揭棋下额外把 `col/row` 置 `-1`
使其成为「缺席子」，真实身份**不写入任何公开字段**（铁律 A）。

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

### 5.4 暗子被吃的处理（决策 A：吃子方不获得新子）

> **本节已按 §14 决策 #2（选项 A）定稿**，并已对照参考实现 `core/position.cpp`
> 与腾讯规则页核实：`makeMove` 只把身份从 `pool_` 移入 `capturedDarkPool_`，
> **吃子方不会获得任何新棋子**；规则只规定「输的一方看不到被吃暗子的身份」，
> 从未提及吃子方补子。

吃暗子时：

1. 被吃子置 `alive = false`；揭棋下额外把 `col/row` 置 `-1`（成为「缺席子」）；
2. 其真实身份**对双方都不可见**，不写入任何公开字段（铁律 A 无例外）；
3. **棋盘上直接少一枚，不补新暗子。**

因此：

- **32 格命名空间恒够用**，无需槽位预算与耗尽处理（原「槽位耗尽」一节作废）；
- 被吃暗子的身份进入一个**只增不减的未知余量**：AI 的后验分布按
  「初始多重集 − 已翻开集合」计算，被吃的那部分整体作为余量（见 §9.3）；
- 无需 `freeSlots` 退役栈。

### 5.5 被吃暗子落在己方阵营后，按哪种子力走？（**决策 A 下不适用**）

> 决策 A 确定吃子方不获得新暗子，故「落点决定占位棋种」的映射**不再需要**。
> 本节保留仅为记录历史决策，**实现时不要照此编写**。

这是揭棋规则里**唯一没有权威统一表述**的细节。两个官方规则文本都没写。
本方案提议的默认约定（按**列**映射，与底线棋子类型一致，且把中路留给兵）：

| 落点列 | 0 / 8 | 1 / 7 | 2 / 6 | 3 / 5 | 4 |
| --- | --- | --- | --- | --- | --- |
| 走法 | 车 | 马 | 象 | 士 | 兵/卒 |

理由：① 覆盖全部 9 列；② 九路正中已被帅/将占据，不会与暗子冲突；③ 与「中路是兵道」的棋理直觉一致。

> ⛔ **决策 A 下本表不再实现**（吃子方不获得新暗子，故没有「落在己方阵营的新暗子」）。
> 保留仅为记录，**不要照此编写代码**。

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
| `actMove`（`:1468`） | 揭棋分支：走法按**盘面 id**（未翻开=棋位棋种），落子时写入 `revealedType` 完成翻开 |

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
服务端拿到后按盘面 id 校验走法，落子时写入 `revealedType` 完成翻开。

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

> 📌 **最终落地（2026-10 产品调整）：揭棋没有独立页，入口并入人机对战设置页。**
> 见下方 8.1.1。下面这段是**原方案**，保留它只为记录决策沿革。

```
client/app/jieqiSetup.tsx        → screens/jieqiSetup   （揭棋人机设置：难度/执棋方）
                                     对局页复用 screens/game（传 variant=jieqi）
```

> 📌 **实施修正：没有 `jieqiGame` 页，对局复用 `screens/game`。**
> 原方案列了两页，但揭棋与象棋在对局页的交互模型完全一致
> （选中/落子/吃子特效/悔棋/重开/换边/终局/规则提示/音效，一样不缺）。
> 复制一份 1400 行的对局页只会制造**两套必然漂移的实现** ——
> 而「同一语义多处实现，改一处漏一处」正是本仓库 `CODE_AUDIT.md §8` 记的失效模式。
> 故改为给 `screens/game` 加 `variant` 开关：
> - `params.variant === 'jieqi'` ⇒ 建揭棋局面、身份表进 `ref`；
> - 身份表**不进 `GameState`**，故 `makeMove` 的第 5 参从 ref 取；
> - 复盘按 §10 跳过（揭棋不支持复盘；续局已在后续任务中支持）。

#### 8.1.1 入口合并到人机对战（最终形态）

首页只剩**一张**「人机对战」入口卡片；揭棋不再单独占一张。
进入 `screens/pveSetup` 后，第一行是「选择模式」：

| 模式 | 差异 |
| --- | --- |
| **象棋** | 有「选择先后手」区；引擎文案写「内置皮卡鱼引擎」；无玩法说明标识 |
| **揭棋** | **隐藏**「选择先后手」（红先由执棋方唯一决定）；标题右侧挂 (i) 玩法说明；引擎文案写「内置揭棋引擎」；玩法说明里列一条「不支持复盘和悔棋」 |

**为什么合并**：两种玩法除模式本身外，设置项完全一致（执棋方 / AI 难度 / 开始对弈）。
拆成两页会让「换玩法」变成「退回首页 → 点另一个入口」，多两步且要维护两份几乎相同的页面。

**存档仍然分开**（这点必须守住）：

| 玩法 | 存档键 | 对局页分流 |
| --- | --- | --- |
| 象棋 | `chess_game_save` | `saveGame` / `loadGame` / `deleteSave` |
| 揭棋 | `chess_jieqi_save` | `saveJieqiGame` / `loadJieqiGame` / `deleteJieqiSave` |

对局页 `screens/game` 已把这三对调用收成 `saveBattle` / `loadBattle` / `deleteBattleSave`
三个小函数，按 `variant` 分流 —— **设置页也必须跟着当前模式切换**，
否则会出现「在揭棋模式下读到象棋存档、点了续局却开出一局象棋」。

⚠️ 切模式**必须立即重查存档**（`useFocusEffect` 依赖里带上 `mode`）：
两个模式各存一局，沿用上一模式的续局摘要会显示错的那一局。

设置页**不提供先后手开关**：揭棋规则 1 规定红先，玩家执黑天然就是后手，
多一个开关只会让人以为可以改规则。也不提供让子（揭棋没有让子）。

**玩法说明改挂标题栏**：揭棋这几条规则只在开局前有用，开局后没人在意；
占着首屏一大块卡片会把它顶成「第一个要读的东西」，反而迟滞了选难度这一主要动作。
改为标题右侧 (i) → 弹窗，与残局闯关选关页（`screens/endgame` 的 `headerTitleRow`）同一套样式。

### 8.2 `ChessBoard` 暗子渲染

**唯一改动点**在 `components/ChessBoard.tsx` 棋子遍历处：

```tsx
const isHidden = gameState.hiddenMask?.[piece.id] === true;
imageSource={getJieqiPieceImage(
  piece.id,
  isHidden,
  gameState.revealedType?.[piece.id],   // ← 已翻开子的**真实棋种**，缺了就退化成普通象棋
  piece.id <= 15 ? 'black' : 'red',
)}
```

> 🔴 **实施踩坑（真机才发现，667 条测试全绿也没拦住）**：
> 首版 `getJieqiPieceImage(pieceId, isHidden)` 对「已翻开的子」回落到 `getPieceImage(pieceId)`。
> 而揭棋的盘面 id **恒等于棋位棋种**（决策 A：id 永不因翻开而改变），
> 所以翻开后取到的恰好是「该棋位本来的那张正面图」——
> **棋盘上看起来就是普通象棋，揭棋的随机性完全不可见。**
>
> 引擎侧全对（身份表洗牌正常、`makeMove` 正常写 `revealedType`），
> 错的是渲染层少传了一个参数。凡是「id 不变、身份另存」的模型，
> **渲染都必须同时拿到 id 和真实身份**，只按 id 取图必然出错。

新增三个函数在 `utils/chess/pieceImages.ts`：
- `getFaceDownImage(pieceId)` —— 背面图按阵营取黑/红两张；
- `getJieqiPieceImage(pieceId, isHidden, revealedType, pieceSide)` —— 暗子取背面、
  **已翻开取真实棋种的正面图**、将帅等明子按 id 取；
- `getJieqiPieceName(pieceId, isHidden, revealedType)` —— **暗子返回 `null`**，
  绝不给名字（那等于直接公布身份）。

背面表 `FACE_DOWN_IMAGES` 与正面表 `PIECE_IMAGES` **分开存放**：
正面表保持「id → 该子正面图」的单一语义不变（象棋路径零改动），揭棋选图交给调用方。

**`PieceItem` 的 memo 比较器**（`:191-198`）已包含 `imageSource`，
翻转瞬间 `imageSource` 变化即天然触发重渲染，**不需要改 memo**（已验证）。

### 8.3 新增资源

- `assets/pieces/face_down_black.png` / `face_down_red.png`（**分两版**，由用户提供原图）
  - ⚠️ 原图是 1536×1536、**各约 3.8MB**；既有棋子图是 66×66、约 10KB。
    直接入库会让包体暴涨 7.6MB（相对 13MB 的整包是 +58%）。
    **必须缩到 66×66**（与既有棋子图同规格）。
  - 缩放要在**预乘 alpha 空间**做：先 `RGB *= A/255` 再 LANCZOS 缩放、缩放后再反预乘。
    直接对 RGBA 缩放会让半透明边缘出现**黑晕**（本仓库在棋盘图上已经踩过这个坑，
    见 `client/AGENTS.md` 的「为什么必须 FASTOCTREE」）。实测 1536² → 66² 后为 8KB/张。
- 翻开音效：复用现有 `SoundManager` 的 `select` / `go`，**不新增音频**（避免包体膨胀）
- **必须**在 `utils/preloadAssets.ts` 的预热里显式加入背面图 —— 该文件当前只循环
  `getPieceImage(id)`（正面表），背面图不在其中。
  漏登记**不会报错**，只会在揭棋首帧出现图片未缓存导致的空白/闪烁 —— 真机上很难复现。

### 8.4 Hook 拆分（实施结果）

> 📌 **实施修正：没有新建 `useJieqiNewGame` / `useJieqiMove`。**
> 原方案担心「内联进巨型文件」，但两个 Hook 的职责都已被既有结构正确覆盖：
> - 重开/换局 → 复用 `hooks/useNewGame.ts`（它**本就是**为了收敛「同一重置序列的三份副本」
>   而抽出来的），只给它加 `variant` / `onIdentity` 两个选项；
> - 落子 → 直接用 `GameEngine.makeMove`（揭棋的翻开语义已在引擎内，页面不需要再包一层）。
>
> 再抽一层只会把「同一语义两处实现」的风险从页面挪到 Hook，并没有降低任何风险。

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

#### 9.3.1 实施结果与三处必要修正

落地时发现原设计**少算了三处**，均已补：

| # | 修正 | 位置 | 为什么必须 |
| --- | --- | --- | --- |
| 1 | **走点派发也要走揭棋口径** | `AIEngine.generatePseudoMoves` | 引擎自己的 `fillPathPoints(i, …)` 只传了 `moveQiZi`，于是搜索树里**已翻开的士/象拿不到过河放宽**、且走法不按真实棋种。须与 `GameEngine`/`RuleEngine` 同口径传 `crossRiver` + `effectiveId` |
| 2 | **MVV-LVA 也必须用期望价值** | 同上 | 吃子排序若仍用 `PIECE_VALUES[target]`，会把盖着的马当成车而抢吃，排序整体失真 |
| 3 | **`aiDispatcher` / `offlineAiAdapter` 必须短路** | 3 个入口 | **皮卡鱼只懂象棋**。喂揭棋 FEN 会拿到垃圾着法；而 `runOffline` 的兜底路径是给「引擎暂时不可用」设计的，揭棋是**永久**能力缺失 —— 走兜底会让界面把 TS AI 的着法标成「皮卡鱼（启动中）」，虚报棋力 |

另有一处**必须深拷贝**：`cloneForSearch` 若只浅拷 `hiddenMask/revealedType`，
搜索树里的 `applyMove` 会**真的把调用方的暗子翻开**（页面上出现「无中生有」的翻牌）。

#### 9.3.2 评估缓存

`hiddenIdentityPosterior` 每个节点重算会让评估慢一个数量级（`evaluate` 对 32 枚棋子逐个取值）。
同一局面内所有未读暗子**共用一份分布**，故按局面缓存「每方的期望价值」即可。
缓存用 `WeakMap<GameState, Map<SideTag, number>>` —— 局面是即用即弃对象，缓存随之自动回收，
不会在长对局中累积成内存泄漏。（`SideTag` 是 `boolean` 而非 `string`，故内层必须用 `Map`。）

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

### 10.1 存档（PVE 续局）——✅ **已实现**

> 📌 **本节结论已更新**：早期版本按「首版不落盘」记录（理由是身份表 `JieqiIdentity`
> 不在 `GameState` 里，读回来的档会是一局「暗子身份全丢」的棋）。
> **续局已在后续任务中实现**，做法是下面「方案 1：存身份表」。
> 下面保留原始分析，因为它记录的**风险点**（分 key、校验）仍然是当前的实现依据。

`utils/GameSave.ts` 存**完整 `GameState`**。揭棋下 `variant` / `hiddenMask` / `revealedType`
会被 `JSON.stringify` 自动带上，所以从「结构能否存下」的角度看是通的。

**关键补充**：身份表不在 `GameState` 里，所以**必须显式落盘**，否则读回来的揭棋存档
会是一局「暗子身份全丢」的棋 —— 玩家会以为引擎算错了，比不存档更糟。

落地形态：

- 存档新增可选字段 `jieqiIdentity?: { hiddenType: (JieqiPieceType|null)[]; seed: number }`；
  ⚠️ 存的是**棋种**而非 id —— 与 §3.1 决策 A 的模型一致（盘面 id 恒等于棋位棋种，
  只有「真实棋种」才是身份）。
- `canResumeJieqi(save)` 作为**能否续局**的判据：老揭棋档（本次改造之前留下的、
  缺身份表的）读得出但续不了，必须被挡住，否则会开出一局身份错乱的棋。
- 对局页 `screens/game` 把 `saveGame`/`loadGame`/`deleteSave` 与
  `saveJieqiGame`/`loadJieqiGame`/`deleteJieqiSave` 收成
  `saveBattle`/`loadBattle`/`deleteBattleSave` 三个函数按 `variant` 分流，
  避免在 5 处写三元。

**分 key 是硬要求**（这是最容易踩的坑）：

| 玩法 | 存档键 |
| --- | --- |
| 象棋 / 人机对战 | `chess_game_save` |
| 揭棋 | `chess_jieqi_save` |
| 残局闯关 | 另一套（`saveEndgameBattle` / `deleteEndgameBattle`） |

若不分 key，揭棋存档会被象棋的「继续对局」读到而崩溃 ——
且 `isValidGameSave` 的 32 子结构校验**恰好拦不住它**（结构上是合法的）。

> 原始分析（另一种更干净的方案，未采用）：把洗牌改成由单个 seed 驱动确定性 PRNG，
> 存档只存 seed，读档时重放洗牌 —— 不落盘任何身份。代价是洗牌要从 `crypto.randomInt`
> 改为 `crypto.randomBytes` 产出长种子 + 确定性 PRNG 展开。
> 现采用「存身份表」是因为它**不改动已验证的洗牌实现**，且身份表本来就已经生成好了。
> 另需评估「退出 App 后身份仍在磁盘上」是否可接受（当前实现接受）。

### 10.2 复盘——**首版不做**（现状仍如此）

`replayStorage.ts` 的 `ReplayGame` **结构上无法表示揭棋**：它只存 `moves[]` + `firstMoveSide`，
复盘时 `createInitialState` 重建（`screens/replayPlayer/index.tsx:71-85`），初始暗子身份无从还原 ——
重放出来的盘面与玩家当初下的那盘**完全不是一回事**。

故 `screens/game` 的终局复盘保存（`savePveReplay`）在揭棋下**直接 return 不存**。

> ⚠️ 注意：**续局（§10.1）已做，复盘（本节）仍不做**。两者容易混为一谈，
> 但续局存的是「当前局面的完整快照 + 身份表」，而复盘要的是「从初始局面重放着法表」，
> 后者的初始局面含随机洗牌，现有数据结构表达不了。

将来要做，同样是两条路：

1. **只存终局快照**（推荐）：新增可选字段 `jieqiFinalSecret?: { identity: (JieqiPieceType|null)[]; seed: number }`，
   **只在终局后随结算下发，中局绝不下发**（铁律 A）。
   ⚠️ 注意存的是**棋种**而非 id —— 与 §3.1 的决策 A 模型一致。
2. **改用 seed 洗牌**（更优）：摆子由 seed 确定性复现，则存档只存 seed 即可，
   无需存储任何身份。

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

| 文件 | 覆盖 | 状态 |
| --- | --- | --- |
| `jieqiSetup.test.ts` | 摆子 15 枚、占位棋种分布、`hiddenType` 多重集严格、种子可复现、翻开只写 `revealedType`、**id 恒定回归**、`undoMove` 精确还原、决策 A（吃子方不增枚 + 铁律 A）、6 局×60 步无 id 冲突、克隆深拷贝 | ✅ 17/17 |
| `jieqiVariantIsolation.test.ts` | **`variant` 缺省 = 'xiangqi'` 时，既有走法/终局/`positionKey` 指纹输出逐点不变**（回归铁闸） | ✅ 9/9 |
| `jieqiAttack.test.ts` | **暗子不将军**：占位车与对方将帅照面时 `isJiangJun` 不判将、`afterMoveStillJiangJun` 不误判飞将；翻开即刻恢复攻击身份；10 局×80 手随机对弈全程校验（优先吃子以保证覆盖到被将时刻） | ✅ 5/5 |
| `jieqiNoLeak.test.ts` | **铁律 A**：`GameState` 及其派生（走棋历史/克隆/克隆之克隆/`positionKey`）序列化后不含未翻开真相；**重点覆盖「吃暗子之后」**；并断言 `identity` 不是 `GameState` 的键 | ✅ 6/6 |
| `jieqiMoveRule.test.ts` | 走法等价性（22 个非士象占位逐点对拍：暗子 ≡ 同棋种明子）；士/象过河放宽**只**对已翻开者生效；`RULE_CONFIG` 阈值在揭棋下零调整；揭棋走 40 手规则状态自洽 | ✅ 7/7 |
| `jieqiAi.test.ts` | 身份后验为**超几何分布**：初始 2/15（车）、翻开一枚后 1/14；未读暗子取同一份分布且归一化；`expectedHiddenValue` 数值正确；吃暗子后本方不增枚 | ✅ 7/7 |
| `jieqiAiEngine.test.ts` | AIEngine 揭棋分支：搜索树里走暗子会翻开且 `cloneForSearch` 深拷贝隔离；提示（`pureBest`）两次结果一致（确定性翻牌）；AI 着法始终合法 | ✅ 9/9 |
| `jieqiFlow.test.ts` | **端到端**：用与 `screens/game` 相同的调用序列（`buildJieqiInitialGameState` → `makeMove(identity)` → `aiDispatcher`）跑完整局，每次翻开恰好减少一枚暗子；重开重新洗牌；揭棋局面不走皮卡鱼路径 | ✅ 3/3 |
| `jieqiRevealIdentity.test.ts` | **渲染必须显示真实棋种**：已翻开的子取到的图 = `getPieceImage(representativeId(revealedType))`，且**必须 ≠ `getPieceImage(id)`**；暗子取背面；暗子不给名字（铁律 A） | ✅ 5/5 |
| `jieqiAttackIdentity.test.ts` | **走子前/走子后口径必须一致**：差分测试（`isMoveKingSafe` vs 走子后 `isJiangJun` 地真，272 个随机着法零分歧）+ 用户场景（占位炮/真身卒，上仕成炮架不得判送将）+ 各项正/对照 | ✅ 9/9 |

> 🔴 `jieqiRevealIdentity` 与 `jieqiAttackIdentity` 都是**事后补的**：
> 前者是真机发现「揭棋看起来就是普通象棋」，后者是真机发现「能上仕防御却被判送将」——
> 当时 667/672 条测试全绿、引擎单测全过。
> 两次都指向同一类漏洞：**测试只断言了状态/取值的正确性，没有断言「跨层消费方怎么用它」**
> （渲染取了哪张图、送将判定用哪套攻击口径）。
> 结论写进了 §13.0.2：**这类规则要给差分测试，不是给单条断言**。

> 🔴 `jieqiRevealIdentity` 是**事后补的**：首版 667 条测试全绿、引擎全对，
> 但真机上揭棋看起来就是普通象棋 —— 因为渲染层没把 `revealedType` 传给选图函数，
> 而 id 恒等于棋位棋种（决策 A）。详见 §8.2。
>
> **教训**：这类「id 不变、身份另存」的模型，**渲染层必须同时拿到 id 与真实身份**。
> 引擎单测覆盖不到「渲染取了哪张图」，所以必须有一条测试直接断言**图的来源**，
> 而不能只断言 `revealedType` 的值正确。

> ⛔ `jieqiSlotBudget.test.ts` **已作废**：决策 A（吃子方不获得新子）+ 盘面 id 恒定，
> 不存在槽位复用与耗尽。其防回归价值已并入 `jieqiSetup.test.ts` 的
> 「id 冲突回归」与「随机对弈无 id 冲突」用例。

> 📌 **`jieqiNoLeak` 的口径说明**：`publicGameState`（服务端出站收口）属 P2 在线阶段，
> 本阶段未实现，故该文件改为断言「**喂给收口函数的上游数据本身不含身份**」——
> 即收口函数无身份可漏。这是比直接测收口更根本的一道闸，且现在就能防回归。

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

### 13.0 实施中发现的三个真实缺陷（已修，均有回归测试）

这三个都不是「原方案写错了」，而是**揭棋这条新路径把既有代码里从未被触发的分支暴露了出来**。
它们当时在象棋下不可达，所以既有用例测不出来。

| # | 缺陷 | 位置 | 触发条件 | 后果 | 修复 |
| --- | --- | --- | --- | --- | --- |
| 1 | **过河放宽的象走法越界崩溃** | `MoveCheck.calcXiang` | 揭棋下**已翻开**的象/相走到第 7、8 路时，边界条件写成 `col < 8` / `col > 0`，而象跨 2 格 ⇒ `col+2` 可达 9/10 ⇒ `qiPan[9][…]` 越界 | `TypeError: Cannot read properties of undefined`，揭棋随机对弈**必然**踩到 | 边界收紧为 `col < 7` / `col > 1`（与同函数非放宽分支同口径）。象棋不可达该分支，故行为零变化 |
| 2 | **AI 把暗子当攻击者** | `AIEngine.isSideInCheck` | 该函数用自建的 `isGeneralAttacked` 按**盘面 id** 推走点，不看 `hiddenMask` | 大量根本不存在的将军被算成将军，搜索评估全面失真，AI 下出莫名其妙的棋 | 揭棋分支直接复用引擎的 `isJiangJun`（已跳过暗子）；象棋仍走原路径 |
| 3 | **攻击范围按盘面 id 派发 ⇒ 应将着法被误拦成「送将」** | `MoveCheck.afterMoveStillJiangJun` | 见下 | **用户实测**：对方将军时，本可以上仕防御，却被判「着法送将，请另走」 | 增加 `attackerMotion` 回调注入，与 `isJiangJun` 走同一套 `motionArgs` |

#### 13.0.1 缺陷 3 详解：走子前/走子后口径分叉

`afterMoveStillJiangJun`（**走子后**判「是否仍被将」）扫描攻击者时只传了盘面 id：

```ts
const thisPoints = getPathPoints(localQiZi, myQiPan, myPositions);   // ← 缺 effectiveId
```

而 `GameEngine.isJiangJun`（**走子前**）一直传真实身份（`motionArgs`）。
决策 A 下盘面 id 恒等于**棋位棋种**，攻击性却由**真实身份**决定 ⇒ 两者口径分叉。

差分探针（随机对弈枚举全部合法着法，与「走子后 `isJiangJun` 地真」逐条比对）：
**修复前 272 个着法里 45 个分歧，修复后 0 个。**

**这个分叉是双向的**，症状不止「误拦」一种：

| 攻击者占位 → 真身 | 旧代码以为 | 实际 | 后果 |
| --- | --- | --- | --- |
| 炮 → 卒 | 炮能隔炮架将军 | 卒打不到 | **把本可的应将着法误拦成「送将」** ← 用户报的这条 |
| 卒 → 炮 | 卒打不到 | 炮能隔子将军 | **漏判仍在被将** ⇒ 漏拦送将 |

**修复**：`afterMoveStillJiangJun` 增加第 8 个参数 `attackerMotion`（回调注入，
与既有 `hiddenAttacker` 同一模式，避免 `MoveCheck` 直接依赖 `jieqi.ts` 形成依赖环），
由 `GameEngine.attackerMotionOf` / `RuleEngine.attackerMotionOf` 注入。
象棋两者均返回 `undefined` ⇒ 新分支恒不进入，既有行为逐字节不变。

已补齐的调用点：`isMoveKingSafe`、`hasAnyLegalMove`、`buildEngineHistory`（GameEngine）；
`isPinnedMove`、`isPiecePinned`、`getValidMoves`（RuleEngine）。
**`attackerMotion` 与 `hiddenAttacker` 必须成对注入** —— 只漏一个就会出现
「走子前说被将、走子后说没被将」。

> 📌 **一个反直觉的几何事实**（写测试时踩到）：
> 「有没有子挡在中间」**不受棋种影响** —— 士挡在车与帅之间时，按车和按马都打不到帅。
> 所以要制造口径分歧，必须让攻击者的棋种**改变可达性**（炮↔卒这类「隔子」特性差异），
> 光靠阻挡是测不出来的。

> 📌 **测试咬合验证**：本条回归测试写完后，我用「临时移除注入」逐条验证过它**确实会失败**。
> 第一版写的「上仕挡住 4 路车」用例在旧代码下**照样通过**（因为阻挡不受棋种影响），
> 属于假绿灯，已重写为「占位炮 / 真身卒，上仕成炮架」这个真正分歧的摆法。

#### 13.0.2 贯穿三个缺陷的教训

> **新增「某类子不参与/按另一套口径参与某判定」的规则时，必须把所有独立实现该判定的入口都找出来。**
>
> 本项目里同一个判定有多份实现：`isJiangJun` 有三处调用方
> （`GameEngine` / `RuleEngine` / `AIEngine`）；「是否仍被将」有**两套**判据
> （走子前的 `isJiangJun`、走子后的 `afterMoveStillJiangJun`）。
> 漏改任何一份都会让揭棋与象棋（或走子前与走子后）判定分叉 ——
> 而单测通常只覆盖了其中一份。
>
> **可操作的检查法**：对每个新判定，写一条**差分测试** ——
> 让「口径 A 的结果」与「口径 B 独立重算的地真」在大量随机着法上逐条比对，
> 要求分歧数为 0。缺陷 3 的探针正是这样做的（45 → 0）。
> 只写「这个着法应该合法」的单条用例，很容易像第一版那样写成假绿灯。

### 13.1 阶段划分与交付状态

| 阶段 | 范围 | 是否动服务端 | 可交付 |
| --- | --- | --- | --- |
| **P0 规则底座** | `types.ts` 加 `variant`/`hiddenMask`/`revealedType`；`MoveCheck`/`GameEngine`/`RuleEngine` 的分支；洗牌与后验；全部单测 | ❌ | 无（纯引擎） |
| **P1 离线人机** | `pveSetup` 首行「选择模式」+ `game` 屏 `variant` 化；`ChessBoard` 暗子渲染；背面图资源 + 预热；本地 AI（信念期望） | ❌ | **可玩的单机揭棋** |
| **P1.5 续局**（✅ 已在后续任务完成） | `chess_jieqi_save` 独占键；`JieqiIdentity` 随档落盘；`canResumeJieqi` 挡住缺身份表的老档 | ❌ | 揭棋可续局 |
| **P2 在线对局** | 服务端 `variant` 设置、`jieqiSecret`、`publicGameState` 收口（含 spectate 修复）、悔棋快照、`verify-jieqi.cjs`；`aiDispatcher` 显式短路 | ✅ | 联机揭棋 |
| **P3 复盘** | `jieqiFinalSecret` 字段（存**棋种**，非 id）、复盘还原 | ❌（客户端） | 揭棋复盘 |
| **P4（不排期）** | 原地翻子、在线揭棋引擎接入 —— 依 §14 定稿均**不做**，仅保留为预留开关 | — | 无（不排期） |

**建议 P0+P1 先跑通再评审**，因为 P1 已经能验证最核心的「暗子体验」，且完全不碰服务端，风险最低。

> 📌 **进度更正**：`P1.5 续局` 已由后续任务实现（本文档早期章节曾按「首版不落盘」记录，
> 那部分结论**已过时**，以本节为准）。当前揭棋**可续局、不可复盘**。

---

## 14. 已定稿决策（2026-10 确认，按本方案默认项执行）

以下 6 项**已全部确认按本方案默认执行**，不再是待议项。实现时直接照此写，无需再等拍板。

| # | 议题 | **定稿** | 实现落点 |
| --- | --- | --- | --- |
| 1 | **原地翻子** | ❌ **不做**。揭棋只有「走子即翻开」一种翻开方式 | 不实现任何原地翻子动作。若日后要开，须新增走子类型 + 协议字段 + 空步计数重置 |
| 2 | **被吃暗子落在己方阵营后的走法** | ✅ **该议题已消解**：经核实参考实现与腾讯规则页，吃子方**不获得任何新棋子**（见 14.3 决策 A） | 无需实现「落点→占位 id」映射表 |
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

### 14.2 第 7 项：**原「选 B」已随决策 A 失效**

> **本节作废。** 决策 A（吃子方不获得新暗子）确定后，
> 「被吃暗子是否向吃子方展示真身」这一议题**不再存在** ——
> 棋盘上根本不会出现新的暗子，也不存在需要展示的那枚。
> §2.1 **铁律 A 不开例外**：任何时刻都不因「谁被吃」向任何客户端释放身份；
> §4.2 的 `capturedHidden` **只下发计数、不下发身份**。

### 14.3 决策 A（实现阶段定稿，2026-10）：吃暗子不补子 + 盘面 id 恒定

| 议题 | 核实结论 | 依据 |
| --- | --- | --- |
| 吃暗子后吃子方是否获得新暗子 | **不获得**，棋盘上直接少一枚 | `lichlzh/pikafish-jieqi` `core/position.cpp` 的 `makeMove` 只把身份从 `pool_` 移入 `capturedDarkPool_`，不生成新子；腾讯规则页只说「输的一方看不到被吃暗子身份」，从未提及补子 |
| 揭棋是否需要「占位 id 退役 + 真实 id 顶上」 | **不需要**，且该设计在本仓库**不可行** | 实测 30/30 暗子的真实身份都会落在另一个在盘暗子的 id 上（id 集合完全重合）。改用 `revealedType` 平行数组，与参考实现的 `hidden_[square]` 同构 |

这两点共同带来三个结构性简化：

1. **32 格命名空间恒够用** —— 无槽位复用、无耗尽、无退役栈（`freeSlots` 删除）；
2. **`undoMove` 天然正确** —— 无 id 置换需要复原，只需把 `revealedType` 写回 `null`；
3. **吃暗子的后验分布更简单** —— 被吃身份整体作为「未知余量」，不再需要池回收。

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

## 附：需要改动的文件清单（**实施后实际清单**）

### 已完成（客户端 P0 + P1，本轮落地）

```
utils/chess/types.ts                        +variant +hiddenMask +revealedType +JieqiPieceType
utils/chess/jieqi.ts                        【新】洗牌、投影、effectiveIdOf/crossRiverOf、AI 信念后验
utils/chess/MoveCheck.ts                    走点派发带 effectiveId；攻击扫描跳过暗子**且按真实身份派发**；calcXiang 越界修复
utils/chess/GameEngine.ts                   makeMove 翻开（决策 A：无 id 交换）+ isJiangJun 跳过暗子
utils/chess/RuleEngine.ts                   positionKey 含暗子位图；simulateMove 保守保持暗子
utils/chess/AIEngine.ts                     揭棋分支：后验期望估值、搜索树翻开、提示确定性、hard 深度降 3
utils/chess/aiDispatcher.ts                  揭棋在入口短路到 TS AI（皮卡鱼只懂象棋）
utils/chess/offlineAiAdapter.ts             揭棋拒绝进本地引擎 + 跳过 ponder（3 道闸）
utils/chess/pieceImages.ts                  +背面图导出 +getJieqiPieceImage
utils/preloadAssets.ts                      +背面图预热
components/ChessBoard.tsx                   按 hiddenMask + revealedType 选图（无新 props）
hooks/useNewGame.ts                         +buildJieqiInitialGameState、+variant/onIdentity 选项
screens/game/index.tsx                      variant 化：建局、走子传 identity、重开重洗牌、跳过复盘
                                              +saveBattle/loadBattle/deleteBattleSave 按 variant 分流存档键
screens/pveSetup/index.tsx                  【改】首行「选择模式」（象棋/揭棋）；揭棋隐藏先后手、
                                              挂 (i) 玩法说明弹窗、换引擎文案；续局区按模式读各自的键
screens/home/index.tsx                      入口描述点明「象棋 / 揭棋」（揭棋独立卡片已移除）
assets/pieces/face_down_black.png           【新】1536² → 66²，3865KB → 8KB
assets/pieces/face_down_red.png             【新】1536² → 66²，3763KB → 8KB
utils/chess/__tests__/jieqi*.test.ts        【新】9 个测试文件，681 条全绿
```

> 📌 **已删除**：`screens/jieqiSetup/` 与 `app/jieqiSetup.tsx`（含 `_layout.tsx` 里的那一行
> `Stack.Screen`）。揭棋入口并入 `screens/pveSetup`，见 §8.1.1。
> 首页 `pushOnce` 的联合类型里 `/jieqiSetup` 也已一并去掉。
> 注意 `utils/chess/__tests__/jieqiSetup.test.ts` 是**引擎层**的摆子测试，与那个已删的
> 设置页无关，文件名里的 "Setup" 指「摆子（setup）」，**不要**顺手删。

### P2 待做（服务端 + 揭棋续局/复盘）

```
chinese-chess-server/src/routes/lanGame.ts    Room/settings/actMove/startPlayingRoom/下发点/悔棋快照
chinese-chess-server/src/routes/jieqiView.ts  【新】publicGameState 投影收口
chinese-chess-server/scripts/verify-jieqi.cjs 【新】
utils/GameSave.ts                             拆 key + 身份落盘（或改 seed 洗棋，见 §10.1）
utils/replayStorage.ts                        +jieqiFinalSecret（存棋种，非 id）
screens/replayPlayer/index.tsx                +揭棋重建分支
```

**闸门**：`pnpm -w validate` 挂入新 verify；收尾 `pack.ps1 client`（P1 未动服务端源码，故只重打 client）。

> ⚠️ `ruleEngine.cjs` 是**客户端源码的打包产物**，改 `MoveCheck`/`GameEngine`/`RuleEngine`
> 后必须跑 `verify-rule-engine-parity.mjs --write` 并**重启服务端**，否则两端会漂移。
> 本轮已重新生成（**47285 字节**，同源校验通过；上一版 47238、46993）。

---

## 16. 揭棋引擎全面功能审计（2026-10）

> 目标：审计引擎功能是否正常、是否符合既定规则、是否能在百局内稳定运行，并逐条修正。
> 方法：两路并行审计（规则符合性 / 引擎集成）+ 自建百局自对弈压测（真实 WASM 引擎
> 驱动真实客户端规则层），所有结论均有可复现的实测证据。

### 16.1 规则符合性结论：**6 条官方规则全部符合**

逐条核对了腾讯象棋官方与棋者象棋的 6 条揭棋规则（15 暗子/将帅明置、暗子按棋位走、
移动即翻开、吃子不补新且身份不可见、已翻开士象不受九宫河界、暗子不构成攻击），
全部通过；**象棋/揭棋变体隔离干净**（双向无泄漏，40 局 × 24 手逐字节比对）。

### 16.2 已修正的缺陷

| # | 级别 | 位置 | 缺陷 | 修复 |
| --- | --- | --- | --- | --- |
| A1 | P1 | `MoveCheck.calcShi/calcXiang` | 揭棋已翻开的士/象**行边界漏判**：`row±1/±2` 越界会写出 `points[c][10]`（把列数组撑长到 11 且**跨调用残留**在 AIEngine 复用缓冲里）或 `points[c][-1]`（隐藏属性，肉眼不可见） | 两个 crossRiver 分支补行边界；`fillPathPoints` 另加兜底截断，使「走点矩阵恒为 9×10」成为不变量 |
| A11 | **P0** | `MoveCheck.calcShi` | **修 A1 时引入的真 bug**：放宽分支的守卫被写成 `row >= 1 && row <= BOARD_ROWS - 2`，那个上界多余 —— 士只斜行一步、向下永不越界。结果**底线 row 9 的已翻开仕彻底无着法可走**（0 步）。规则 5 下士出九宫走到底线是合法可达局面 ⇒ 该子永久僵死，玩家和 AI 都动不了它 | 改为逐个落点判「目标行是否越界」（`row+1 < BOARD_ROWS` / `row-1 >= 0`）。详见 §16.3 |
| A2 | P2 | `GameSave.isValidGameSave` | `revealedType` 是读档即可注入的字符串数组，却**从不校验**；非法值让 `representativeId` 查不到 id，崩溃点落在 `detectZhuo`→`makeMove`，表现为「续局后点任何子就崩」 | 补 `revealedType`/`hiddenMask` 形状与取值域校验；`idsOfType` 改为返回空数组而非 undefined |
| A3 | P1 | `jieqi.createJieqiInitialState` | `buildJieqiIdentity(rand, 0)` **硬编码 seed=0**，且 `useNewGame` 接受 seed 却 `void seed` 丢弃 ⇒ 续局/重开用 `makeSeededRand(identity.seed)` 复现出的身份表**与真实对局不是同一张**。因揭棋 FEN 里暗子一律输出 x/X，盘面逐字节相同，故一直潜伏未爆 | 新增 `makeRandomSeed()`；`seed` 真正透传并写进 identity，确立「拿到 seed 就能逐格复现」的不变量 |
| A4 | P1 | `aiDispatcher.rejectMoverUnsafe` | 揭棋引擎着法**只查送将、不查落点合法性**。揭棋引擎（`jieqi_old`）与本仓库是两套实现，一旦对边界的认知失配，非法落点会被直接落子 ⇒ 盘面进入**无法靠对方补救**的非法状态 | 补 `getValidMoves` 落点闸（与象棋路径同口径） |
| A5 | P1 | `aiDispatcher.runJieqiEngine` | `go depth N movetime M` 中 **`movetime` 是死参数**（实测 depth 4 在 90ms 就跑完）⇒ 三档 `movetimeMs` 全无效、「大师档思考更久」并未发生；且提示档的「确定性」只是巧合 | 改为只发 `go depth N`，`movetimeMs` 改作宿主侧超时预算；**顺带给了提示确定性以机制保障**（原为 D7） |
| A6 | P2 | `jieqiTier.randomPick` | 入门档的随机削弱是**死配置**：`chooseUci` 生产代码零调用，multiPV 2 收集的候选被丢弃 ⇒ 入门档实际没有削弱 | 改为真正走 `chooseUci(info, true)`，PV1 作为兜底 |
| A7 | P1 | `jieqiHost.isJieqiHostAvailable` | 只 `require` 资源、不检查承载能力 ⇒ 原生端（Worker 不可用）**恒返回 true**，进引擎分支后每次抛错并静默回落 TS AI，而角标永久显示「揭棋引擎启动中」——一个永远启动不了的引擎 + 永久降级且毫无提示 | 补 `typeof Worker` 前置检查。注：象棋侧是靠 WebView 承载解决的，揭棋**尚无** WebView transport，故只能诚实降级 |
| A8 | P3 | `jieqiUci.isCriticalErrorLine` | 引擎遇非法局面会输出 CRITICAL ERROR 并自杀；行为原本「恰好正确」（bestmove 缺失→回落），但靠巧合 | 显式判定并记日志，不再与「引擎没出着」混为一谈 |
| A9 | P3 | `jieqiRuntime.payload.degraded` | 历史不完整时退化为纯 FEN 搜索（丢失重复局面感知）**完全静默**，无法排查 | 显式记录一次告警 |
| A10 | P3 | `GameEngine.undoInPlace` | 连续两个逐字节相同的揭棋揭示回滚块 | 删除其一 |

### 16.3 最重要的发现：分歧的**方向反了** —— 引擎一直是对的，是我们的 `calcShi` 有 bug

> ⚠️ **本节结论已被后续审计推翻并重写。** 保留原判据链是为了记录教训：
> 「引擎没实现规则 5」这个看似确凿的结论，从头到尾都建立在**没让双方拿到同一个局面**之上。

**原判据链（方向错了）**：百局压测里引擎约 12% 的调用给不出着法
（`info depth 0 score mate 0` + `bestmove (none)`），而客户端在同一局面明确还有 1–2 步合法棋。
逐层隔离后把根因判给引擎：
1. 只发当前 FEN、完全不带历史 → 引擎仍报 mate 0 ⇒ 差异在盘面认知；
2. 构造「红帅被困、唯一合法棋是一枚**已翻开**且远离九宫的红仕」⇒ 引擎报 `(none)` ⇒ 引擎不认规则 5。

**真正根因在 `MoveCheck.calcShi`**（已修，见 §16.2 的 D2b）。放宽分支当时写成：

```ts
if (crossRiver) {
  if (row >= 1 && row <= BOARD_ROWS - 2) {   // ← 这个上界是多余且有害的
    ... 四个 row±1 斜向落点 ...
  }
  return;                                     // ← row 0 / row 9 直接「无着法」
}
```

士只斜行**一步**，落点是 `row±1`。row 取 0..9：向下 `row+1` 越界需 `row >= 10`，
**永不发生**；向上 `row-1` 越界需 `row < 1`。所以正确判据是「目标落点是否越界」，
而 `row <= 8` 这个上界纯属多余 —— 却让**底线 row 9 的已翻开仕彻底无棋可走**。
而这恰恰是规则 5 制造的合法可达局面（仕出九宫、走过河、走到底线）。

实测对照（同一 FEN）：

| FEN | 本仓库（修前） | 引擎 | 真相 |
| --- | --- | --- | --- |
| `4k4/9/9/9/9/9/9/9/9/2A5K w ...`（已翻开仕 @ (2,9)） | **0 步** | `c0d1` | 我们错，引擎对 |
| 修后同一 FEN | 2 步 `(1,8) (3,8)` | `c0d1` | 一致 ✅ |

**修正后的结论**：`jieqi_old` 对规则 5 的处理**与本仓库一致**，未发现任何规则分歧。
那 12% 的 `(none)`，是因为我们把一批本可动子的局面判成了「红方无棋可动」，
引擎拿到的局面是真的无解，所以 `(none)` 是**正确答案**。

| 影响面 | 修正后结论 |
| --- | --- |
| 对局正确性 | 修复前已有隐患：一枚走到底线的已翻开仕会**彻底动不了**（玩家与 AI 都无法移动它），属功能性缺陷。 |
| 盘面合法性 | 不受影响 —— `makeMove` 始终拒绝非法落点。 |
| 引擎棋力 | **不受影响**。此前「残局退回 TS AI」的判断基于错误归因，作废。 |
| 修复成本 | 改一处边界判断（客户端）＋ 重新生成 `ruleEngine.cjs`（47238 → 47285 字节）。**无需重建 WASM。** |

**为什么没被现有测试抓到**：`jieqiMoveRule` 里那条「走点矩阵恒为 9×10」只断言**形状**
（列长度、负下标），而 0 步的矩阵形状是完美的 9×10 全 false。
已补三条断言**走法数量**的用例（底线 2 步 / 顶线 2 步 / 逐行扫不允许整行 0 步）。

> 教训一：修「越界污染」这类隐患时，很容易顺手把守卫写「对称好看」而引入真 bug。
> 越界判据只能是**目标落点**，不能是「整块是否在某个区间内」。
>
> 教训二：`jieqi_old` 是被审计对象，却两次被误判成有缺陷
> （§16.5 的重复 id 与 id→棋种映射错误；本节的守卫写反）。
> 三次里每一次都是**审计工具自身**的 bug，且都表现为「引擎有问题」。
> 独立判据（`enumerateLegalMoves` 作地面真值 + 双方逐子一致的局面）是唯一可靠的防线。

### 16.4 未修（需另行立项，非缺陷）

- **D6 揭棋提示无后台预计算**：`precomputeOfflineHint` 对揭棋直接 return，玩家点提示 = 一次
  完整 depth-8 的 WASM 实例冷启 + 搜索。象棋有 ponder 预热，揭棋没有。
  **这不是 bug 而是缺功能** —— 揭棋引擎「一次搜索 = 一个实例生命周期」（WASM 同步 UCI 循环，
  无常驻实例可挂 ponder），要补需要先设计后台会话机制，不在本次修正范围。
- **D5 语义偏差（不影响 6 条规则）**：`RuleEngine` 的长将长捉分类器按**盘面 id**（=棋位）而非
  真实身份推断棋种，故「揭开的暗马」落在兵位上会被当成兵参与豁免计算。
  只微调长将长捉的裁决，**不违反任何一条揭棋规则**，留作跟进项。

### 16.5 第二类分歧：是我自己的探针写错了，引擎一直是对的

第一轮归因时，压测还剩 57 次「待查」分歧，且棋种消融（`diag-ablate`）显示
**5/5 样本把 `R`/`r` 换成 `x`/`X` 后引擎都恢复正常**，看上去像是引擎对「已翻开的红车」有特殊缺陷。

追查过程分三步，结论是**我的探针脚本有两处 bug，引擎自始至终是对的**：

1. **重复棋位 id**：我构造「双车夹帅」时给两枚车写了同一个棋位 id `7`，
   `qiPan` 后写覆盖先写 ⇒ 盘面实际只有**一枚**车。于是 `(3,9)/(5,9)` 真的空着、
   我们算出 2 步合法，而引擎面对的是那**一枚**车——
   引擎说 `(none)` 是错的？不，**是我们把局面看错了**：引擎看到的就是真实局面。
   改用 `7`/`8` 两个不同 id 后，`enumerateLegalMoves = 0`，
   **引擎判定正确**（`(3,9)/(5,9)` 被车吃、`(4,8)` 是白脸将，红方真的无解）。
2. **id → 棋种字符映射写错**：另一版探针把 id `5`（黑马）渲染成 `r`（车）。
   引擎拿到的是「车」，我们这边却是「马」—— **双方拿到的根本不是同一个局面**，
   由此得出的「引擎误报将死」完全是伪结论。
3. **正确口径**：任何「引擎 vs 我们」的结论，都必须让双方拿到**逐子一致的同一个局面**。

**压测脚本已按此修正**：归因前先问 `enumerateLegalMoves` ——
我们自己已无着法时，引擎的 `(none)` 是**正确的终局判定**，不记为分歧。
补上这一步后，第二类分歧归零。

> 这条值得写进文档：审计工具本身也会有 bug，而且**两次都表现为「引擎有问题」**，
> 正好是被审计对象的反面。若不是坚持让规则层做独立判据，这两次都会被当成真缺陷
> 写进结论、甚至去「修」本来正确的引擎。

### 16.6 百局压测

自建 `client/engine-source/jieqi/stress100.cjs`：**真实 WASM 引擎 + 真实客户端规则层**
自对弈 100 局，每手校验「着法合法性 / bestmove 可解码 / 暗子池自洽 / 历史完整性 / 正常终局」。

**判据分两层**（这一点很重要）：

- **致命项（必须为 0）**：引擎异常、池不自洽、历史降级 —— 意味着喂错局面或拖垮对局；
- **引擎缺陷（已知、已安全降级，不判致命）**：§16.7 的底线暗子异常。
- **正常终局（不计入任何一项）**：引擎报 `(none)` 而**我们自己也已无着法** ——
  引擎是对的，详见 §16.5。归因前必须先做这一步判定。

**最终一轮（A11 修复后，100 局，easy 档）实测**：

```
局数        : 100（档位 easy）
总着法      : 8542  平均 85.4 手/局
引擎调用    : 8542  成功解码 8073
引擎异常    : 0（真故障：抛错/超时/崩溃）
规则分歧    : 469（引擎给不出着法 → 回落 TS AI）
  └归因    : 正常终局(引擎对) 0 / 引擎缺陷 469
             （其中 397 例同时有「已翻开出九宫的士象」，仅作线索）
  └非法着法: 0
池不自洽    : 0
历史降级    : 0
未终局(僵)  : 5
终局分布    : {"black_win":27,"red_win":40,"draw":28,"playing":5}
步数 min/中位/max: 22/73/200

致命项（必须为 0）: 异常 0 / 池不自洽 0 / 历史降级 0
RESULT     : PASS（零异常、池恒自洽、历史完整）
```

**怎么读这张表**：**致命项全 0 ⇒ 稳定性通过**（这正是「百局内稳定运行」要的答案）。
469 次分歧**全部**是 §16.7 的引擎缺陷、且已被 `pickAnyLegalMove` 安全兜住，
不是我们的正确性问题；它是「引擎棋力覆盖度」指标。
「归因」这一栏本身也修过一次 —— 早期它只按「盘上有没有出九宫的士象」归因，
把正常终局和引擎缺陷都记成了「规则 5」（见 §16.5/§16.6 的教训）。

> ⚠️ 该脚本的配置**只能走环境变量**（`JIEQI_GAMES` / `JIEQI_TIER`），**切勿传命令行参数** ——
> 本项目的 Emscripten glue 只要 `process.argv` 多出额外参数，就会忽略注入的 `stdin` 回调
> 而回落到真实 `process.stdin`，导致引擎把 argv 当 UCI 命令（报 `Unknown command: '1 medium '`）。
> `verify.cjs` 不受影响（它不接受参数）。
>
> 改了任何规则层 TS 后必须重跑 `node engine-source/jieqi/gen-stress-bundle.mjs`，
> 否则压测会**静默地测旧规则**。
>
> 诊断脚本（均为环境变量配置，留作复现用）：`diag-fail.cjs`（分类计数）、
> `diag-none.cjs`（打印分歧局面盘面）、`diag-isolate.cjs`（区分盘面 vs 历史分歧）、
> `diag-shi-bound.cjs` / `diag-shi-fixed.cjs`（§16.3 那个 `calcShi` 行边界 bug 的复现与修复确认，
> 前者保留「修前」行为以便对比）、`diag-discriminate.cjs`（将死判定的判别实验）、
> `diag-flying.cjs`（飞将/暗子阻挡口径）、`diag-samecol.cjs` / `diag-single.cjs`（同列/单子消融）、
> `diag-pool.cjs`（池自洽对照）。
>
> 这些脚本全部位于 `client/engine-source/jieqi/`，而该目录已被 `pack.ps1 client` 排除，
> 不进部署包。

### 16.7 第三类分歧：已定位为**引擎缺陷**（底线暗子 `X` + 被将军）

修完 A11 后重跑百局压测，仍有 **469/8542 = 5.49%** 的调用「引擎给不出着法」，
且**全部**属于「我们还有着法、引擎却说 mate 0」。这一类与规则 5、与 `calcShi` 都无关。
用**从原始 FEN 出发的减法消融**定位（每次只拿掉一枚子，绝不自己重建局面）：

**压测抓到的原始样本**（红方，本仓库算 23 步；引擎 `bestmove (none) score mate 0`）：

```
x2xk1xb1/9/4p4/3R5/p3pr3/2P1c4/X7X/4B3P/4P4/X1XXKrX2 w A1C1P2N2p2n1 1 29
```

盘面要点：黑车 `r` 在 **(5,4)**，红帅 `K` 在 **(4,9)**；红方四枚暗子 `X` 在
**(0,9)(2,9)(3,9)(6,9)** —— 这四格的**棋位**分别是红兵、红相、红仕、红相。

| 从原局面拿掉 | 引擎 |
| --- | --- |
| (0,0) (3,0) (4,0)k (6,0) (7,0)b (4,2)p (3,3)R (0,4)p (4,4)p | 仍 `(none)` |
| **(5,4) 的黑车 `r`** | **恢复 `e0f0`** |

⇒ 去掉黑车后引擎正常，说明**黑车本身不是 bug**，真正的触发器在红方那几枚暗子里。
把局面缩到最小后逐枚加暗子：

| 局面 | 引擎 |
| --- | --- |
| `k@(4,0)` + `r@(5,4)` + `K@(4,9)` | ✅ `e0d0 … (mate -1)` |
| + `X@(0,9)`（棋位=兵） | ✅ `e0d0 … (mate -1)` |
| + `X@(2,9)`（棋位=相） | ✅ `e0d0 … (mate -1)` |
| + `X@(6,9)`（棋位=相） | ✅ `e0d0 … (mate -1)` |
| **+ `X@(3,9)`（棋位=仕）** | 💥 **WASM 堆 OOM，进程被杀** |
| 四枚暗子齐（= 最小复现） | 💥 同上 |
| `X@(3,9)` 换成明子 `A`（已翻开仕） | ✅ `d0e1` |
| `X@(3,9)` 换成明子 `P` | ✅ `d0d1` |
| `X@(3,8)` / `X@(3,7)`（不在底线） | ✅ `e0d0` |

**结论**：引擎在「**被将军时，底线 (3,9) 上有一枚暗子**」这个组合下进入异常状态
（表现为搜索不收敛 → 我们看到的 `(none)`，在独立进程里直接 OOM）。
注意最小复现里它**只认 (3,9)**：(0,9)/(2,9)/(6,9) 同在底线却完全正常，
`X@(3,8)`/`X@(3,7)` 也正常 —— 触发点精确到**格**。
(3,9) 是**红仕的棋位**，与另外三格（兵位/相位/相位）都不同。

不过百局压测里的真实缺陷局面提示**触发条件比最小复现更宽**：
另一个样本 `6x2/3k5/9/4Bc2x/2p6/2P6/2bnPc2X/5B3/p3PK1N1/3r2X1X w …`
里红帅在 (5,8)、**正被将军**、本仓库算得出 2 步，而底线暗子在 **(6,9) 与 (8,9)**。
共同点是「**被将军 + 底线暗子**」，具体落在哪一格似乎还与其他子力配置有关。
要把它精确到位的唯一办法是读 `jieqi_old` 的走法生成源码 —— 已超出本次范围。
本仓库只需要一个可靠的**判据**（`enumerateLegalMoves`），不依赖知道引擎内部细节。

> 这一条**不修**：修它必须改 `jieqi_old` 并重建 WASM、重跑 `verify.cjs` 基线，
> 超出本次审计范围。生产链路对此已安全降级 ——
> `runJieqiEngine` 把 `(none)` 判为 null，外层回落 `pickAnyLegalMove`（本地 TS AI），
> `rejectMoverUnsafe`（A4）再兜一道非法落点。对局正确性不受影响，受影响的只是这一类局面下引擎棋力。
>
> ⚠️ 压测里这一类必须与「正常终局」区分开，否则会把**引擎缺陷**记成**我们的 bug**
> —— 这正是 §16.5/§16.6 两次踩过的坑。当前压测脚本的归因是**二元的**：
> 先问 `enumerateLegalMoves`，
> - 我们**也没有**着法 ⇒ 记 `divergedTerminal`（引擎判定正确，是正常终局）；
> - 我们**还有**着法 ⇒ 记 `divergedEngineBug`（引擎缺陷，已回落 TS AI）。
>
> 另有一个**仅作线索**的计数 `advisorClue`：缺陷局面里有多少同时存在
> 「已翻开出九宫/过河的士象」。**它不能当判据** —— 实测它几乎在所有缺陷局面上
> 都为真（揭棋残局里这类棋子太常见），没有区分力。它曾把我们引向
> 「引擎未实现规则 5」的错误结论（§16.3），保留它只为观察 §16.7 与规则 5
> 是否共享同一条走法生成代码路径。

### 16.8 本次审计真正改动了什么（与最初结论的差异）

| | 最初结论（已作废） | 修正后 |
| --- | --- | --- |
| 引擎 | `jieqi_old` 未实现规则 5，残局系统性罢工 | **规则 5 与本仓库完全一致**；但另有一处独立缺陷：底线 (3,9) 暗子触发 WASM 异常（§16.7） |
| 客户端 | 无相关缺陷 | **A11（P0）**：底线士被冻住，属功能性缺陷 |
| 引擎构建 | 考虑给引擎打补丁重建 WASM | A11 不需要；§16.7 需要，但本次不修（已安全降级） |
| 压测分歧 | 5.58% 属「已知规则 5」 | 归因后 = 规则 5 **0**、正常终局若干、引擎缺陷若干 |
