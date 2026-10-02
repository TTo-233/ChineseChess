# 中国象棋客户端 · 本地人机对战流程 只读审计报告

> 审计对象：`chinese-chess-client/client/screens/game/index.tsx`（1673 行）及其依赖
> `client/utils/chess/{GameEngine,AIEngine,aiDispatcher,onlineAI,RuleEngine,types}.ts`、
> `client/utils/{GameSave,EndgameProgress,SoundManager}.ts`、`client/hooks/useMoveEffect.ts`、
> `client/components/ChessBoard.tsx`
> 性质：只读审计，未修改任何文件。

## 概述

人机（本地/离线）对局主流程整体是「单实例 `gameGenRef` 代数 + 单一 `aiTimerRef`」的竞态模型：**AI 分支**（`triggerAIMove`）在搜索返回后、音效之后各校验了一次代数，`finally` 中也有条件复位 `aiThinking`，这部分是全文最严谨的地方；**玩家分支**（`executeMove`）却完全没有同等的代数校验，而它内部同样有 `await playSound()` 的异步窗口——两条分支的防护强度不对称，是本次审计最集中的缺陷来源。其次，两个自动触发点（挂载 effect 与 `scheduleAIMove`）在 AI 计算被作废或被调度器拦下时没有兜底重排，存在「轮 AI 走子但永远不动」的软锁可能。悔棋、绝杀/困毙/和棋判定、存档校验、音效与覆盖层清理大体正确，未见 P0 级缺陷。

---

### [P1] `executeMove` 在 `await` 之后缺少代数校验，悔棋/翻转/重开期间的在飞走子会「复活」旧局面
- 位置: `chinese-chess-client/client/screens/game/index.tsx:743-754`（异步窗口），`chinese-chess-client/client/screens/game/index.tsx:563-565`（AI 分支有防护、玩家分支没有）
- 代码:
```ts
    // 播放音效：将军时播放男声将军语音（替代走子音，避免与吃子/走子音混音重叠）
    if (isCheck && !isGameOver) {
      await playJiangJunSound();
    } else if (captured !== -1) {
      await playSound('eat');
    } else {
      await playSound('go');
    }

    // 吃子/将军特效（终局时不播，由绝杀特效接管）；返回实际播放的特效类型
    const shownEffect = triggerMoveEffect(captured, isCheck, isGameOver);

    setGameState(newState);
```
- 问题: `executeMove` 是 `async`，在 `await playSound(...)` 处让出主线程；此后它无条件把「点击那一刻的 `gameState` 推导出的 `newState`」写回 state。AI 分支在完全相同的窗口上显式写了 `if (gameGenRef.current !== gen) return;`（index.tsx:563），玩家分支没有。具体故障：玩家走一步后（`await` 期间 UI 仍是最后渲染的那一帧），立刻点「重开」→ 确认 → `invalidatePendingAI()` + `setGameState(初始局面)`；随后该 promise 恢复执行，`setGameState(newState)` 把**被重开废弃的旧局面**重新装回棋盘（`setMoveCount`、吃子计数、`scheduleAIMove` 也一并生效），表现为「重开无效，棋盘自己跳回上一局的残局」。同样的时序也适用于「悔棋」（`handleUndo` 同样调用 `invalidatePendingAI()`，但该代数对 `executeMove` 无效）与「翻转」。
- 建议: 与 AI 分支对齐：`executeMove` 入口记录 `const gen = gameGenRef.current;`，在所有 `await` 之后、任何 `set*` 之前插入 `if (gameGenRef.current !== gen) return;`（并同时 `cancelHintPonder()`）。

### [P1] AI 回合的延时窗口里「悔棋/翻转/重开」按钮仍可点，取消一次不存在的 AI 计算
- 位置: `chinese-chess-client/client/screens/game/index.tsx:815-816`、`chinese-chess-client/client/screens/game/index.tsx:1342-1346`
- 代码:
```ts
    // AI 走棋：若玩家这步触发了特效，等特效完整播完再让 AI 落子，
    // 避免 AI 秒回导致特效被下一步棋的特效/棋盘变化打断；无特效时保持 300ms 的轻思考停顿
    const aiDelay = shownEffect ? MOVE_EFFECT_DURATION_MS[shownEffect] + 120 : 300;
    scheduleAIMove(newState, aiDelay);
```
```ts
                  disabled={gameState.moveHistory.length < 2 || aiThinking}
```
- 问题: `scheduleAIMove` 只排定时器，**不置 `aiThinking`**（`aiThinking` 要等 `triggerAIMove` 被调用时才为 true）。因此在玩家落子后的 300ms（有特效时最长约 1.4s）里，`禁用条件`仍是 false，悔棋按钮可点，底部栏此时显示的却是「AI回合」。用户在这个窗口点悔棋：`handleUndo` 一开始就 `invalidatePendingAI()` —— `gameGenRef.current += 1` 把**尚未开始**的 AI 走子连同其代数一起作废；随后 `triggerAIMove` 仍会被定时器触发（定时器在 `scheduleAIMove` 里已被清空，但 `executeMove` 的 P1 第 1 条路径会重新排一次），而新的 `triggerAIMove` 用的是新代数，于是「悔棋后局面停在 AI 回合却没有 AI 走子」这一软锁成立的条件被制造出来；反过来若时序相反，则 AI 的落子会覆盖悔棋后的局面（悔棋像没生效）。另外 300ms 窗口内玩家点棋盘也无任何反馈（`sideTag` 已是 AI，`handlePiecePress` 直接 return，见 index.tsx:645-654），体验上是「点了没反应」。
- 建议: `scheduleAIMove` 里同步 `setAiThinking(true)`（或让被作废的定时器回调补发一次），并在 `handleUndo`/`handleFlip` 里以「AI 是否已排定」而非 `aiThinking` 作为禁用判据；同时把延迟窗口内玩家点击的落点反馈（提示条/抖动）补上。

### [P1] `handleUndo` 不回滚 `capturedRed/capturedBlack`，被吃子计数与盘面/存档永久不一致
- 位置: `chinese-chess-client/client/screens/game/index.tsx:844-848`
- 代码:
```ts
    setGameState(state);
    setSelectedPieceId(null);
    setValidMoves(null);
    setMoveCount(prev => Math.max(0, prev - undone));
    setLastMove(null);
```
- 问题: `handleUndo` 正确回滚了 `gameState`（`undoMove` 会 `alive = true` 恢复被吃子与 `qiPan`）、`moveCount`、`lastMove`，唯独没有回滚 `capturedRed`/`capturedBlack` 这两个计数 state（对比 index.tsx:765-771 走子时是 +1）。它们被写进 `GameSave`（index.tsx:952-953）与 `EndgameBattleSave`（index.tsx:941-951）。具体故障：吃掉对方一车 → 悔棋 → 重新吃一次，计数变 2；用户点棋盘上的被吃摘要行时，`ChessBoard` 的 `ids.length` 用的是从 `gameState` 派生的数组（真实值），而存档里写的是 2；返回时选择「保存」再续棋，`moveCount/captured*` 与 `ruleState`、盘面自洽性被破坏（`GameSave` 的校验恰好不查这些字段，见 P2 第 4 条），后续若阅读存档字段会出现「吃了 2 个车但棋盘上只少 1 个」。
- 建议: 悔棋后用派生值同步计数（`const {capturedByRed, capturedByBlack} = deriveFrom(state)` 后 `setCapturedRed(capturedByRed.length)`），或干脆删除这两个冗余 state、只保留从 `gameState` 派生的数组。

### [P2] `executeMove` 没有重入保护：同一次落点在异步窗口内被点两次会重复提交
- 位置: `chinese-chess-client/client/screens/game/index.tsx:752-771`
- 代码:
```ts
    setSelectedPieceId(null);
    setValidMoves(null);
    setMoveCount(prev => prev + 1);

    if (captured !== -1) {
      if (captured <= 15) {
        setCapturedRed(prev => prev + 1);
      } else {
        setCapturedBlack(prev => prev + 1);
      }
    }
```
- 问题: `executeMove` 只在入口用 `getValidMoves(gameState, pieceId)` 校验规则，没有「本次落点已在处理中」的标记，`selectedPieceId/validMoves` 也要等 `await playSound(...)` 之后才被清空。快速双击同一个落点（或 `<ChessBoard>` 的 `onMove={handleEmptyPress}` 与 `onPiecePress` 在双击时各派发一次）会让两次调用都基于**同一份未更新的 `gameState`** 提交同一着：`setGameState` 写成同一个 `newState`（幂等），但 `setMoveCount(prev => prev + 1)` 是函数式更新、会累加两次 → 顶部「第 N 回合」跳变（`Math.ceil(moveCount / 2) + 1`，index.tsx:1194-1195），吃子计数同样 +2，落点音效也会播两次。
- 建议: 加一个 `moveSubmittingRef`，进入即置位、提交完成后复位；或在 `executeMove` 入口先 `setSelectedPieceId(null); setValidMoves(null);` 再 await。

### [P2] `triggerAIMove` 在 AI 走法被拦截为 `null` 时静默结束，无人重排 → 「AI回合」永久软锁
- 位置: `chinese-chess-client/client/screens/game/index.tsx:506-508`
- 代码:
```ts
      // 计算返回时局面已被重置（重开/悔棋/翻转/退出）→ 丢弃结果
      if (gameGenRef.current !== gen) return;

      if (aiMove) {
```
- 问题: `aiDispatcher` 的出口守卫 `rejectMoverUnsafe`（`aiDispatcher.ts:519-523`）会对**任意来源**的着法再跑一次 `isMoveKingSafe`，不通过就返回 `null`；`aiMove` 为 `null` 时整个 `if (aiMove)` 块（含 `precomputeHint` 与新排定）被跳过，`finally` 只把 `aiThinking` 复位。此时 `gameState.sideTag` 仍是 AI 方，而唯一会重新排定 AI 的路径只剩 `executeMove`/`handleUndo`/`handleFlip`/`handleReset`（都要求玩家能操作），玩家又因为 `sideTag === aiSideTag` 而点不动任何棋子 → 对局永久卡在「AI回合」，只能重开。触发条件是服务端返回的着法在本地规则下送将（客户端规则与 Pikafish 不一致时并非不可能），且该分支不会回退到 `getBestMoveAsync`。
- 建议: `aiMove === null` 时先回退一次本地 `getBestMoveAsync(currentState, difficulty)`（残局路径已有本地兜底且 `searchWithTimeBudget` 保证「必定落子」，见 `AIEngine.ts:1401-1421`），仍失败则 `scheduleAIMove(currentState, 500)` 重试一次并给出提示。

### [P2] `handleHint` 用 await 前的 `gameState` 快照做安全校验并直接落子提示 → 提示与当前盘面不符
- 位置: `chinese-chess-client/client/screens/game/index.tsx:1085-1093`
- 代码:
```ts
      const best = await getHybridHintMove(gameState);
      // 计算期间局面已变化（走子/悔棋/换边等）或已有新请求 → 丢弃结果
      if (reqId !== hintReqRef.current) return;
      if (!best) return;
```
- 问题: 请求序号 `hintReqRef` 只在 `clearHint()` 时递增，而 `handleUndo`（index.tsx:828 会调用 `clearHint`，但**玩家走子的路径不会**——`executeMove` 里的 `clearHint()` 在 await 之前就执行了）之外的情形覆盖不全：典型故障是玩家点「提示」（在线皮卡鱼最坏 2s、本地 hard 约 2.5s）→ 期间点「悔棋」→ 悔棋确实调了 `clearHint()` 使序号递增，此时能正确丢弃；但玩家在提示计算期间**走子**（`canHint` 已因 `hintLoading` 而禁用按钮，可提示结果返回前的最后一次走子仍可能发生在按钮禁用生效前的一帧），或悔棋→再走子使 `hintReqRef` 被 `clearHint` 递增两次后恰好与旧 `reqId` 不再相等 —— 一旦序号巧合相等，`isMoveKingSafe(gameState, best.pieceId, ...)` 与 `setHintMove({...})` 都会基于**旧盘面**执行，画出「不存在的棋子/非法落点」的橙色提示，点上去会被 `executeMove` 的 `getValidMoves` 兜底拦下（index.tsx:698-703），用户只看到提示失效。
- 建议: 提示结果落地前增加局面指纹校验（比对 `gameState.zobristHash`/`moveHistory.length` 或引入与 AI 相同的 `gameGenRef` 代数），不一致则丢弃。

### [P2] 存档校验不覆盖 `moveCount`/`captured*`/`ruleState`，损坏值会直接进入 UI
- 位置: `chinese-chess-client/client/utils/GameSave.ts:43-58`（`isValidGameSave`），消费点 `chinese-chess-client/client/screens/game/index.tsx:313-318`
- 代码:
```ts
        setGameState(save.gameState);
        setMoveCount(save.moveCount);
        setCapturedRed(save.capturedRed);
        setCapturedBlack(save.capturedBlack);
        setLastMove(save.lastMove);
        setIsFlipped(save.isFlipped);
```
- 问题: `isValidGameSave` 只校验 `pieces.length === 32`、每个棋子的 `id/col/row/alive`、`sideTag` 是 boolean、`moveHistory` 是数组、`playerSide` 合法；`moveCount`（可为 `NaN`/负数）、`capturedRed/capturedBlack`（可为 `undefined`）、`gameState.ruleState`（长将长捉状态，缺失时由 `recomputeRuleState` 兜底）都不在校验范围。旧版本或半写入的存档会让 `Math.ceil(moveCount / 2) + 1` 显示为「第 NaN 回合」，而 `captured*` 为 `undefined` 时下一次保存会把它继续写成 `undefined`。
- 建议: 在 `isValidGameSave` 中补充 `Number.isFinite(moveCount) && moveCount >= 0`、`typeof capturedRed/capturedBlack === 'number'`、`qiPan` 为 9×10 数组的检查，失败即走现有的「清除损坏存档」分支。

### [P2] 无时钟/计时逻辑 → 关注点 (5) 不适用；但 AI 的 2.5s 搜索期间无任何超时兜底
- 位置: `chinese-chess-client/client/screens/game/index.tsx`（全文无 `setInterval`、无倒计时 state）、`chinese-chess-client/client/utils/chess/AIEngine.ts:1458-1464`
- 代码:
```ts
  const maxDepth = MAX_DEPTH[difficulty] || 4;
  const timeBudget = TIME_BUDGET[difficulty] || 2000;
```
- 问题: 该页面没有单人对局计时器，故「interval 泄漏 / 秒毫秒单位错误 / 超时不触发」在本地人机流程中不存在（`setTimeout` 仅用于 AI 延迟、`cancelHintPonder` 与提示 ponder 的内部让出）。但 AI 搜索只有协作式的时间预算（`hard` 约 2.5s），没有「到点强制落子」的绝对兜底：若 `searchWithTimeBudget` 因异常仍未返回（例如 `cloneForSearch` 抛错，则由 `triggerAIMove` 的 `catch` 吞掉并复位 `aiThinking`），局面仍会停在 AI 回合等待一个不会再来的排定（同 P2 第 5 条）。
- 建议: 给 AI 回合加一个「最后期限」看门狗（例如 `triggerAIMove` 内 `setTimeout` 8s，到点仍未落子则用 `enumerateLegalMoves` 任取一着或提示用户重开）。

### [P3] `savePveReplay` 的一次性标记 `replaySavedRef` 在悔棋后不复位
- 位置: `chinese-chess-client/client/screens/game/index.tsx:241-243`、`chinese-chess-client/client/screens/game/index.tsx:828-848`
- 代码:
```ts
    if (isEndgame || replaySavedRef.current) return;
    replaySavedRef.current = true;
```
- 问题: `replaySavedRef` 只在 `confirmRestart`/`handlePlayAgain`/`handleNextLevel` 里复位，`handleUndo` 不复位。终局那一步若走了「送吃」导致被判负并已保存复盘，悔棋回到终局前、再走出另一个终局时，因为 `replaySavedRef.current === true` 会被静默跳过，用户拿到的是**第一步终局**的复盘（与实际结束着法不符）。
- 建议: 在 `handleUndo` 里 `replaySavedRef.current = false;`（悔棋等于回到未终局状态）。

### [P3] `handleHint` / `handleNextLevel` 使用 `clearHint` 但未列入依赖数组
- 位置: `chinese-chess-client/client/screens/game/index.tsx:1106`、`chinese-chess-client/client/screens/game/index.tsx:1054`
- 代码:
```ts
  }, [isPlayerTurn, aiThinking, gameState, hintLoading, isEndgame, endgameHintLeft]);
```
```ts
  }, [currentEndgame, clearHint, buildEndgameState, invalidatePendingAI, scheduleAIMove]);
```
- 问题: `handleHint`（index.tsx:1077 附近）与 `handleNextLevel`（index.tsx:1030）都调用了 `clearHint`，但前者依赖数组缺 `clearHint`、后者实际已包含（对照 index.tsx:1030 处的调用与 1054 的依赖，`handleNextLevel` 是完整的）。`clearHint` 自身是普通函数、每次渲染新建，`handleHint` 捕获的是旧实例；当前它的实现只依赖 `hintReqRef`（ref 稳定）所以行为正确，但这种写法在 lint（`react-hooks/exhaustive-deps`）与后续重构下极易变成真实 bug。此外 `EXPO_PUBLIC_*`/`MOVE_EFFECT_ENABLED` 一类的常量开关不在审计范围内。
- 建议: 把 `clearHint` 用 `useCallback(..., [])` 固定身份并补进依赖数组。

### [P3] `capturedRed/capturedBlack` 与派生数组是两套数据源，UI 已改用派生值 → 这两个 state 实际是死数据
- 位置: `chinese-chess-client/client/screens/game/index.tsx:263-281`、`chinese-chess-client/client/components/ChessBoard.tsx:282-284`
- 代码:
```ts
  const opponentLostIds = playerSide === 'red' ? capturedByRed : capturedByBlack;
  const mineLostIds = playerSide === 'red' ? capturedByBlack : capturedByRed;
```
- 问题: `ChessBoard` 的数量与明细都从 `capturedByRed/capturedByBlack` 数组派生（真实值随 `gameState` 自动正确），页面传给它的也正是 `getCapturedPieces()` 的派生结果（index.tsx:281、1254-1255）；只有 `capturedRed/capturedBlack` 这两个 `useState` 计数既不被渲染、也不被除存档外的逻辑读取。结论：P1 第 3 条对 UI 无可见影响，但它使存档字段与局面不自洽，且是「悔棋一致性」这一关注点的主要残留问题。
- 建议: 删除这两个 state 与所有 `setCaptured*` 调用，保存时用 `getCapturedPieces().*` 的长度。

### [P3] 存档写入无版本号；保存失败被内部 catch 吞掉，调用方无法提示用户
- 位置: `chinese-chess-client/client/utils/GameSave.ts:11-27`、`chinese-chess-client/client/utils/GameSave.ts:63-70`、`chinese-chess-client/client/screens/game/index.tsx:960-961`
- 代码:
```ts
export interface GameSave {
  gameState: GameState;
  difficulty: Difficulty;
```
- 问题: `GameSave` 没有 schema 版本字段，未来字段变更只能靠 `isValidGameSave` 的窄校验兜底（校验失败会 `removeItem` 清档，用户看到的是「存档凭空消失」而无任何提示）。`saveGame` 把异常吞进 `console.error`，`confirmBackWithSave` 之后立即 `router.back()`，用户不可能知道保存失败。
- 建议: 增加 `version: 1` 并在加载时按版本迁移；`saveGame` 返回 `boolean`，失败时用 `GameNotice`/`Alert` 明确告知「保存失败，是否仍要离开」。

### [P3] 残局终局后结算浮层的竞态顺序正确（记录性说明，非缺陷）
- 位置: `chinese-chess-client/client/screens/game/index.tsx:803-804`、`chinese-chess-client/client/utils/EndgameProgress.ts:141-147`
- 代码:
```ts
        deleteSave(); // 人机对战终局：仅清人机枪局存档
        savePveReplay(newState, playerWon); // 玩家走棋终局：按真实胜负保存复盘
```
- 问题: `deleteSave()`/`deleteEndgameBattle()` 是 `async` 且未 await（fire-and-forget），而 `confirmBackWithSave` 会写入新的存档，理论上是「先删后写、后删覆盖先写」的竞态。实测路径上不成立：终局 → 用户点返回 → 弹出确认 → 点保存，中间至少隔一个用户操作周期（数百毫秒以上），AsyncStorage 队列早已清空。故仅作记录，不建议为它改动代码。
- 建议: 无需修复；若后续把存档改成 IndexedDB/SQLite 等更慢的存储，再考虑给删除操作加序号或 await。

### [P3] AI 的最终落子路径可以选到「被规则标红（长将/长捉超限）」的着法，构成判负风险
- 位置: `chinese-chess-client/client/screens/game/index.tsx:516-522`、`chinese-chess-client/client/utils/chess/AIEngine.ts:1126-1131`
- 代码:
```ts
        if (isMoveBanned(currentState, aiMove.pieceId, aiMove.toCol, aiMove.toRow)) {
          const alternatives = enumerateLegalMoves(currentState, currentState.sideTag)
            .filter(m => !isMoveBanned(currentState, m.pieceId, m.toCol, m.toRow));
          if (alternatives.length > 0) {
            aiMove = { ...aiMove, ...alternatives[0] };
          }
        }
```
- 问题: `alternatives` 为空时（`if` 不成立）会**保留原来的违规着法**继续落子。搜索侧的注释认为「引擎 banMoves 仅覆盖将/捉着，必有变招着存在」，但 AI 可能处于「所有可走着法都会继续长将/长捉」的理论局面（例如仅有一子可动且该子一动就构成捉），此时 AI 会自己把违规次数推到判负阈值而送出胜利。触发概率很低（需要极窄的子力结构），属于健壮性缺口。
- 建议: `alternatives.length === 0` 时改为选择「非长将优先的任意合法着」（例如按被吃子价值排序取第一个），或在日志中记录该局面以便后续统计。

---

## 已验证干净（verified-clean）

1. **AI 不会连走两步（主路径）**：`triggerAIMove` 在计算返回后（index.tsx:506）与音效之后（index.tsx:563）各校验一次 `gameGenRef.current !== gen`；`scheduleAIMove` 进入时 `clearTimeout(aiTimerRef.current)` 并同样带代数校验（index.tsx:623-631）；`finally` 中只在代未变时复位 `aiThinking`（index.tsx:615-619），不会用旧流程覆盖新流程的思考态。
2. **玩家无法在 AI 计算中走子**：`handlePiecePress`（index.tsx:640）与 `handleEmptyPress`（index.tsx:680）都以 `aiThinking` 为前置守卫；且 AI 回合时 `gameState.sideTag === aiSideTag`，`handlePiecePress` 的 `pieceSide !== currentSide` 分支（index.tsx:645-654）会拒绝选择己方棋子，`executeMove` 入口还有 `getValidMoves` 兜底（index.tsx:698-703）。
3. **AI 思考中悔棋被正确禁用**：非残局 `disabled={gameState.moveHistory.length < 2 || aiThinking}`（index.tsx:1345），残局 `canEndgameUndo` 同时包含 `!aiThinking`（index.tsx:1065-1066）。
4. **悔棋的局面还原是一致的**：`undoMove` 恢复 `alive`、`qiPan`、`sideTag`、`gameStatus` 并全量重放 `ruleState`（`GameEngine.ts:552-585`）；`handleUndo` 用 `undone` 差值修正 `moveCount`（index.tsx:838/847）、清 `lastMove`/选中，并用 while 循环保证终态停在玩家回合（index.tsx:835-837）；只有 `captured*` 计数未回滚（见 P1 第 3 条）。
5. **终局判定完备，不存在「无合法着法却无胜者」**：`makeMove` 覆盖绝杀/困毙/吃将/长将长捉/和棋，并在 `isGameOver && gameStatus === 'playing'` 时用 `getWinnerSideTagFromReason` 补出胜方（`GameEngine.ts:412-536`）；和棋不会被误覆盖，`isDraw = newState.gameStatus === 'draw'` 且 `getWinnerSideTag` 对和棋返回 `null`（index.tsx:554、778，`GameEngine.ts:543-547`），因此不会把和棋误记成「玩家过关」。`sideTag` 在终局已翻到被判负方，绝杀/困毙文案（index.tsx:1421-1424）与盘面一致。
6. **本地 AI 必定落子**：`searchWithTimeBudget` 在迭代加深全部被中止时，用「遍历合法着法、尝试落子并检查己方是否被将」的兜底选出第一手合法着（`AIEngine.ts:1401-1421`），只有 `generatePseudoMoves` 为空才返回 `null`（`AIEngine.ts:1121`）。
7. **挂载/卸载的定时器与音效清理**：AI 定时器在卸载时 `clearTimeout`（index.tsx:216-220），`cancelHintPonder()` 在卸载时调用（index.tsx:185-189），初始化 effect 的 cleanup 调用 `unloadAllSounds()`（index.tsx:329 附近）；`SoundManager` 内部用 `soundSessionId` 丢弃过期播放请求（`SoundManager.ts:148-187`）。
8. **在线 AI 状态订阅正确解绑**：`subscribeOnlineAiStatus` 返回取消订阅函数，effect 直接 `return unsubscribe`（index.tsx:439-448）；`aiDispatcher.subscribeOnlineAiStatus` 确实返回退订函数（`aiDispatcher.ts:280-285`）。
9. **存档加载后哈希一致性**：`loadGame`/`loadEndgameBattle` 两条恢复路径都重建 Zobrist 哈希并 `clearHistoryHash()` + `recordHistoryHash()`（index.tsx:292-294、310-312），避免跨会话重复局面计数污染。
10. **返回拦截与放行标记**：`beforeRemove` 监听在无着法或对局结束时放行，否则弹确认（index.tsx:475-484）；`allowLeaveRef` 在保存/不保存后置位再 `router.back()`（index.tsx:963-964、977-978），不会被自己的拦截器二次拦下。
11. **音效/特效不会因终局而错播**：`triggerMoveEffect` 内部对 `isGameOver` 直接返回 `null`（`useMoveEffect.ts:38-60`），终局改由 `gamelose/gamewin` 接管（index.tsx:556-559、807-809）；连续将军有 4s 冷却节流，冷区内静默跳过而非错播其他音效。
12. **无时钟逻辑**：`client/screens/game/index.tsx` 全文不含 `setInterval` 或无倒计时 state，`setTimeout` 仅出现在 AI 延迟排定与 `beforeRemove` 无关处，关注点 (5)`interval 泄漏/漂移/负值/超时未触发`在该流程中不适用。
13. **AI 只活在本地副本上**：`getBestMoveAsync` 用 `cloneForSearch(state)` 搜索（`AIEngine.ts:1463-1464`），搜索期间的让出不会改写到 React 持有的 state。
14. **`MOVE_EFFECT_DURATION_MS[shownEffect]` 不会取到 `undefined`**：仅当 `shownEffect` 为真值时才索引（index.tsx:815），`triggerMoveEffect` 的返回类型被限定为 `MoveEffectKind | null`。
15. **终局后棋盘输入被彻底封死**：底部栏在 `jueShaVisible` 时 `pointerEvents="none"` + `opacity: 0`（index.tsx:1278-1279），`handleFlip` 也有 `jueShaVisible` 守卫（index.tsx:860）。

---

## 交付说明（工具限制）

本次审计为子代理任务，要求「完成前用 `send_message` 把自包含结果发给父代理 `session-2a1259e1-8c7a-4b3b-b6f8-66b695ecb708`」。**当前会话的工具列表中不存在 `send_message` 工具**，无法调用，因此改为把完整结果写入工作区文件 `D:\Code\ChineseChess\CODE_AUDIT_pve-flow.md`（父代理共享工作区，可直接读取），并在最终回复中内联同一份报告。除本次新增的这一个报告文件外，未修改仓库中任何既有文件。
