/**
 * 走棋规则检查 - 移植自 C# SuanFa/MoveCheck.cs
 * 负责计算每个棋子的合法移动位置
 *
 * ============================================================================
 * 【唯一真源 / SINGLE SOURCE OF TRUTH】
 * 本文件是三端（UI / AI 引擎 / 服务端裁决）走法与王安全判定的唯一实现：
 *   · getPathPoints            —— 棋子自身走法（不含王安全语义）
 *   · afterMoveStillJiangJun  —— 走完后是否仍被将军（含飞将/白脸将段）
 * 任何一端都不得另写一套等价实现；服务端产物 chinese-chess-server/ruleEngine.cjs
 * 由 chinese-chess-client/client/utils/chess/ruleEngine.bundle.ts 经 esbuild
 * 重新打包生成（node _review/build_ruleengine.cjs），不要直接手改产物。
 *
 * 修改本文件后必须：
 *   1. 同步三端语义（UI 走 GameEngine，AI 走 AIEngine.isGeneralAttacked，
 *      服务端走 ruleEngine.cjs）。
 *   2. 跑 node _review/probe_diff_head.cjs —— 随机局面新旧差分，要求
 *      「消失的可选点」= 0、「合法着法指纹差异」= 0、「终局判定差异」= 0。
 *
 * 【不得当作 bug 修掉的语义】「将帅照面」在引擎里不是「被将军」。
 * isJiangJun（GameEngine.ts）只扫非将子，不含照面；照面由本文件的
 * afterMoveStillJiangJun 飞将段（走子后）与 AIEngine.areGeneralsFacing
 * 单独判定。引擎语义下「走完造成照面」的着法是合法的，未来收口成统一
 * 走法生成函数时不得把它并入攻击判定，否则会凭空禁掉一批合法着法。
 * ============================================================================
 */

import { BOARD_COLS, BOARD_ROWS } from './types';

/**
 * 判断两个棋子是否同一方
 */
export function isTongBang(qz1: number, qz2: number): boolean {
  return qz1 >= 0 && qz2 >= 0 && ((qz1 <= 15 && qz2 <= 15) || (qz1 >= 16 && qz2 >= 16));
}

/**
 * 分配一个 9×10 的走点布尔缓冲（供 fillPathPoints 复用，避免热路径反复分配）
 */
export function createPathPointsBuffer(): boolean[][] {
  const points: boolean[][] = [];
  for (let i = 0; i < BOARD_COLS; i++) {
    const col: boolean[] = [];
    for (let j = 0; j < BOARD_ROWS; j++) {
      col[j] = false;
    }
    points[i] = col;
  }
  return points;
}

/**
 * 把棋子的可移动目标点写入调用方提供的 9×10 布尔缓冲（会先整体清零）。
 *
 * 搜索热路径每个节点要对在场每个棋子调用一次（本函数在 AI 搜索中占 ~18% 耗时），
 * 而走点矩阵在读取后立刻被丢弃、从不长期持有，因此允许调用方复用同一块缓冲，
 * 省掉每次调用要新建 1 个外层数组 + 9 个列数组的分配开销（进而减轻 GC 压力）。
 * 注意：缓冲归调用方所有，下次调用会被覆盖 —— 调用方不得跨调用保存它。
 */
export function fillPathPoints(
  moveQiZi: number,
  qiPan: number[][],
  piecePositions: Array<{ col: number; row: number; alive: boolean }>,
  points: boolean[][],
  crossRiver?: boolean,
  effectiveId?: number
): void {
  for (let i = 0; i < BOARD_COLS; i++) {
    const col = points[i];
    for (let j = 0; j < BOARD_ROWS; j++) {
      col[j] = false;
    }
    /**
     * 【2026-10 审计 D2】兜底截断：清零循环只跑 `j < BOARD_ROWS`，
     * 若某个走法分支（历史上是揭棋已翻开士/象的跨河分支漏判行边界）把
     * `col[10]` 写成 true，数组长度会被撑到 11 且该幻影点**跨调用残留**在
     * AIEngine 复用的缓冲里。这里把长度钉回 10 并删除可能的负下标隐藏属性，
     * 使「走点矩阵恒为 9×10」成为不变量，而不再依赖每个分支都判对边界。
     */
    if (col.length !== BOARD_ROWS) col.length = BOARD_ROWS;
    delete col[-1];
    delete col[-2];
  }

  if (moveQiZi > 31 || moveQiZi < 0) return;
  if (!piecePositions[moveQiZi].alive) return;

  const col = piecePositions[moveQiZi].col;
  const row = piecePositions[moveQiZi].row;

  /**
   * 【揭棋 · 有效棋种】`dispatchId` 由调用方给出。
   *
   * 象棋：直接传 moveQiZi，下面这个 switch 的行为与改动前**逐字节一致**。
   *
   * 揭棋：暗子的盘面 id 是它的**棋位**（走法按棋位走），而**已翻开的暗子**
   * 必须按其真实身份走 —— 但盘面 id 不会变（见 types.ts hiddenMask 注释里
   * 撞车实测 30/30 的说明），所以这里需要一个「走法派发用的代表 id」。
   * 调用方按 revealedType 把真实棋种映射成该方同类棋子的**某个** id；
   * 同类棋子的走法完全相同，故取哪一个都一样（attack 范围同理）。
   */
  const dispatchId = effectiveId === undefined ? moveQiZi : effectiveId;

  switch (dispatchId) {
    case 7: case 8: case 23: case 24:
      // 车的移动
      calcChe(col, row, dispatchId, qiPan, points);
      break;
    case 5: case 6: case 21: case 22:
      // 马的移动
      calcMa(col, row, dispatchId, qiPan, points);
      break;
    case 3: case 4: case 19: case 20:
      // 相/象的移动
      calcXiang(col, row, dispatchId, qiPan, points, crossRiver);
      break;
    case 1: case 2: case 17: case 18:
      // 士/仕的移动
      calcShi(col, row, dispatchId, qiPan, points, crossRiver);
      break;
    case 0: case 16:
      // 将/帅的移动
      calcJiang(col, row, dispatchId, qiPan, points);
      break;
    case 9: case 10: case 25: case 26:
      // 炮的移动
      calcPao(col, row, dispatchId, qiPan, points);
      break;
    case 11: case 12: case 13: case 14: case 15:
      // 黑卒的移动
      calcHeiZu(col, row, dispatchId, qiPan, points);
      break;
    case 27: case 28: case 29: case 30: case 31:
      // 红兵的移动
      calcHongBing(col, row, dispatchId, qiPan, points);
      break;
  }
}

/**
 * 获取棋子可移动的目标位置
 * @param moveQiZi 棋子编号
 * @param qiPan 当前棋盘数据 (9x10)
 * @param piecePositions 所有棋子位置 [{col, row, alive}]
 * @returns 返回 bool 二维数组 [9][10]，true 表示可以移动到该位置
 *
 * ============================================================================
 * 【唯一真源 / SINGLE SOURCE OF TRUTH】本文件内所有 calcXxx 与
 * afterMoveStillJiangJun 共用同一份走法口径，三端（UI / AI 引擎 / 服务端裁决）
 * 都经由本函数取点，不允许任何一端另写一套。
 *
 * 口径边界（本函数**只**按棋子自身走法判定，不含任何王安全语义）：
 *   · 不判断"走完是否被将军"——那由 afterMoveStillJiangJun 负责，属于
 *     GameEngine.hasAnyLegalMove / isJueSha / isKunbi 的范畴。
 *   · 不含飞将/白脸将语义。送将、甚至走完造成将帅照面，本函数都照常返回 true
 *     （见 afterMoveStillJiangJun 顶部注释里"照面不是被将军"的说明）。
 *   故 getValidMoves / getSelectableMoves 直接返回本函数的结果，送将合法。
 *
 * 任何修改必须同步三端，并跑 node _review/probe_diff_head.cjs 验证
 * （"消失的可选点"必须为 0；合法着法指纹与终局判定差异必须为 0）。
 * AI 引擎若出现"看不到必杀着法 / 漏看飞将"类问题，先怀疑调用方是否
 * 绕过了本函数自建攻击判定（历史教训见 _review/probe_ai_mate.cjs）。
 * ============================================================================
 */
/**
 * 求某棋子的走点。
 *
 * @param crossRiver 揭棋「士/象可过河」放宽开关。仅当 variant==='jieqi' 且
 *   **该子已翻开**时由调用方传 true；象棋恒不传（缺省 undefined）。
 *   仍是暗子时传 false —— 暗子按棋位走法，盘面无法区分身份，
 *   规则原文也只说「揭开后的士、象可以过河」。
 *   传 undefined / false 时 calcShi / calcXiang 走的分支与改动前完全一致。
 */
export function getPathPoints(
  moveQiZi: number,
  qiPan: number[][],
  piecePositions: Array<{ col: number; row: number; alive: boolean }>,
  crossRiver?: boolean,
  effectiveId?: number
): boolean[][] {
  const points = createPathPointsBuffer();
  fillPathPoints(moveQiZi, qiPan, piecePositions, points, crossRiver, effectiveId);
  return points;
}

function calcChe(col: number, row: number, moveQiZi: number, qiPan: number[][], points: boolean[][]) {
  // 向左
  for (let i = col - 1; i >= 0; i--) {
    if (qiPan[i][row] === -1) { points[i][row] = true; }
    else { if (!isTongBang(moveQiZi, qiPan[i][row])) points[i][row] = true; break; }
  }
  // 向右
  for (let i = col + 1; i <= 8; i++) {
    if (qiPan[i][row] === -1) { points[i][row] = true; }
    else { if (!isTongBang(moveQiZi, qiPan[i][row])) points[i][row] = true; break; }
  }
  // 向上
  for (let i = row - 1; i >= 0; i--) {
    if (qiPan[col][i] === -1) { points[col][i] = true; }
    else { if (!isTongBang(moveQiZi, qiPan[col][i])) points[col][i] = true; break; }
  }
  // 向下
  for (let i = row + 1; i <= 9; i++) {
    if (qiPan[col][i] === -1) { points[col][i] = true; }
    else { if (!isTongBang(moveQiZi, qiPan[col][i])) points[col][i] = true; break; }
  }
}

function calcMa(
  col: number, row: number, moveQiZi: number, qiPan: number[][],
  points: boolean[][]
) {
  // 上
  if (row > 1 && qiPan[col][row - 1] === -1) {
    if (col > 0 && !isTongBang(moveQiZi, qiPan[col - 1][row - 2])) points[col - 1][row - 2] = true;
    if (col < 8 && !isTongBang(moveQiZi, qiPan[col + 1][row - 2])) points[col + 1][row - 2] = true;
  }
  // 下
  if (row < 8 && qiPan[col][row + 1] === -1) {
    if (col > 0 && !isTongBang(moveQiZi, qiPan[col - 1][row + 2])) points[col - 1][row + 2] = true;
    if (col < 8 && !isTongBang(moveQiZi, qiPan[col + 1][row + 2])) points[col + 1][row + 2] = true;
  }
  // 左
  if (col > 1 && qiPan[col - 1][row] === -1) {
    if (row > 0 && !isTongBang(moveQiZi, qiPan[col - 2][row - 1])) points[col - 2][row - 1] = true;
    if (row < 9 && !isTongBang(moveQiZi, qiPan[col - 2][row + 1])) points[col - 2][row + 1] = true;
  }
  // 右
  if (col < 7 && qiPan[col + 1][row] === -1) {
    if (row > 0 && !isTongBang(moveQiZi, qiPan[col + 2][row - 1])) points[col + 2][row - 1] = true;
    if (row < 9 && !isTongBang(moveQiZi, qiPan[col + 2][row + 1])) points[col + 2][row + 1] = true;
  }
}

function calcXiang(
  col: number, row: number, moveQiZi: number, qiPan: number[][],
  points: boolean[][], crossRiver?: boolean
) {
  let side = 0;
  if (row <= 4) side = 5; // 上方相/象边界 0-4，下方相/象边界 5-9

  // 揭棋：已翻开的象/相不受河界限制（仍保留「田」字走法与塞眼判定）
  if (crossRiver) {
    /**
     * ⚠️ 这里的边界条件必须用 `col < 7` / `col > 1`（与下方非放宽分支同口径），
     * **不能**用 `col < 8` / `col > 0`。
     *
     * 象走「田」，落点跨 2 格：col=7 时 `col+2=9` 已越界，
     * `qiPan[9][row+2]` 直接抛 `Cannot read properties of undefined`。
     * 原写成 `col < 8` 会在象贴到第 7、8 路时崩掉 —— 该分支只在揭棋下可达，
     * 故象棋不受影响，但揭棋随机对弈必然踩到。
     *
     * 【2026-10 审计 D2】**行**边界此前一直漏判：揭棋的士/象可以过河、走过九宫，
     * 落在棋盘任意行都可能触发 `row±1` / `row±2` 越界。两种越界都很隐蔽：
     *   · `row+1/row+2 > 9` → `points[c][10] = true` 把列数组**撑长到 11**，
     *     且 `fillPathPoints` 的清零循环只跑 `j < BOARD_ROWS`，于是这个幻影点
     *     **跨调用残留在 AIEngine 的复用缓冲里**；
     *   · `row-1/row-2 < 0` → 写成 `points[c][-1]` 这个**隐藏属性**，
     *     `.length` 不变，肉眼完全看不出来，但值已被污染。
     * 今天所有消费方都只遍历 `r < BOARD_ROWS`，所以 UI 无可见症状；
     * 但任何改用 `.flat()` / `for...of` / `Object.keys` 的新代码都会踩中，
     * 且会污染行/列索引敏感的逻辑（如 Zobrist、数组扁平化）。
     *
     * ⇒ 这里按「目标行是否越界」判：向下两个落点是 `row+1` 与 `row+2`，
     * 约束等价于 `row+2 <= 9`（`row+1` 更宽松，被它包含）⇒ `rowHi2`；
     * 向上同理约束于 `row-2 >= 0` ⇒ `rowLo2`。
     * 非放宽分支靠 `row !== 9-side` / `row !== 5-side` 天然避开，无需改动。
     */
    const rowLo2 = row >= 2;
    const rowHi2 = row <= BOARD_ROWS - 3;
    // 下方（落点 row+1 / row+2，受 rowHi2 约束）
    if (col > 1 && rowHi2 && qiPan[col - 1][row + 1] === -1 && !isTongBang(moveQiZi, qiPan[col - 2][row + 2])) {
      points[col - 2][row + 2] = true;
    }
    if (col < 7 && rowHi2 && qiPan[col + 1][row + 1] === -1 && !isTongBang(moveQiZi, qiPan[col + 2][row + 2])) {
      points[col + 2][row + 2] = true;
    }
    // 上方（落点 row-1 / row-2，受 rowLo2 约束）
    if (col > 1 && rowLo2 && qiPan[col - 1][row - 1] === -1 && !isTongBang(moveQiZi, qiPan[col - 2][row - 2])) {
      points[col - 2][row - 2] = true;
    }
    if (col < 7 && rowLo2 && qiPan[col + 1][row - 1] === -1 && !isTongBang(moveQiZi, qiPan[col + 2][row - 2])) {
      points[col + 2][row - 2] = true;
    }
    return;
  }

  // 下方
  if (row !== 9 - side) {
    if (col > 0 && qiPan[col - 1][row + 1] === -1 && !isTongBang(moveQiZi, qiPan[col - 2][row + 2])) {
      points[col - 2][row + 2] = true;
    }
    if (col < 8 && qiPan[col + 1][row + 1] === -1 && !isTongBang(moveQiZi, qiPan[col + 2][row + 2])) {
      points[col + 2][row + 2] = true;
    }
  }
  // 上方
  if (row !== 5 - side) {
    if (col > 0 && qiPan[col - 1][row - 1] === -1 && !isTongBang(moveQiZi, qiPan[col - 2][row - 2])) {
      points[col - 2][row - 2] = true;
    }
    if (col < 8 && qiPan[col + 1][row - 1] === -1 && !isTongBang(moveQiZi, qiPan[col + 2][row - 2])) {
      points[col + 2][row - 2] = true;
    }
  }
}

function calcShi(
  col: number, row: number, moveQiZi: number, qiPan: number[][],
  points: boolean[][], crossRiver?: boolean
) {
  // 揭棋：已翻开的士/仕不再受九宫限制（仍保持斜行一步）
  //
  // 【2026-10 审计 D2】行边界必须逐个落点判，不能给整块加一个 `row` 区间守卫。
  //
  // 士只走斜行**一步**，落点是 `row±1`。row 取值 0..9：
  //   · 向下 `row+1` 越界 ⇔ row ≥ 10 —— 不可能发生 ⇒ **永远允许**；
  //   · 向上 `row-1` 越界 ⇔ row < 1 ⇒ 仅 row 0 需要挡。
  // 早先写成 `row >= 1 && row <= BOARD_ROWS - 2`（即 row ≤ 8），
  // 那个上界是**多余且有害**的：它让**底线 row 9 的仕彻底无着法可走**
  // （而按规则 5，已翻开的仕本就应当出九宫/过河，走到底线是合法可达局面）。
  // 实测：红仕 @(2,9) 本仓库给 0 步，引擎却能走 c0d1（(2,9)→(3,8)）。
  // 这就是百局压测里那批「引擎不认规则 5」分歧的**真正来源** ———
  // 方向反了：不是引擎不懂规则 5，是**我们**把底线的仕判成了不能动。
  //
  // 教训：跨调用残留（撑长列数组 / `points[c][-1]` 隐藏属性）这类隐患，
  // 修的时候很容易顺手把守卫写「对称好看」，从而引入真 bug。
  // 判据只能是**目标落点是否越界**，不能是「整块是否在某个区间内」。
  if (crossRiver) {
    if (col > 0 && row + 1 < BOARD_ROWS && !isTongBang(moveQiZi, qiPan[col - 1][row + 1])) points[col - 1][row + 1] = true;
    if (col < BOARD_COLS - 1 && row + 1 < BOARD_ROWS && !isTongBang(moveQiZi, qiPan[col + 1][row + 1])) points[col + 1][row + 1] = true;
    if (col > 0 && row - 1 >= 0 && !isTongBang(moveQiZi, qiPan[col - 1][row - 1])) points[col - 1][row - 1] = true;
    if (col < BOARD_COLS - 1 && row - 1 >= 0 && !isTongBang(moveQiZi, qiPan[col + 1][row - 1])) points[col + 1][row - 1] = true;
    return;
  }

  let side = 0;
  if (row <= 4) side = 7;

  // 下方
  if (row !== 9 - side) {
    if (col > 3 && !isTongBang(moveQiZi, qiPan[col - 1][row + 1])) points[col - 1][row + 1] = true;
    if (col < 5 && !isTongBang(moveQiZi, qiPan[col + 1][row + 1])) points[col + 1][row + 1] = true;
  }
  // 上方
  if (row !== 7 - side) {
    if (col > 3 && !isTongBang(moveQiZi, qiPan[col - 1][row - 1])) points[col - 1][row - 1] = true;
    if (col < 5 && !isTongBang(moveQiZi, qiPan[col + 1][row - 1])) points[col + 1][row - 1] = true;
  }
}

/**
 * 将/帅的移动：九宫内直行一步（不越河、不出宫）
 *
 * 注意：此处不再做「两将照面（飞将/白脸将）」过滤。落点是否会造成照面属于
 * 「走后己方将/帅是否仍被攻击」，与本棋子自身走法无关；若在此处依据对方
 * 将/帅所在列及中间是否有子来裁剪落点，可选落点就会随对方将/帅位置变化，
 * 形成变相提示。照面走法是否合法由 GameEngine 在终局判定
 * （isJiangJun / hasAnyLegalMove / isJueSha / isKunBi）时统一裁决。
 */
function calcJiang(
  col: number, row: number, moveQiZi: number, qiPan: number[][],
  points: boolean[][]
) {
  let side = 0;
  if (row <= 4) side = 7;

  // 下方
  if (row !== (9 - side) && !isTongBang(moveQiZi, qiPan[col][row + 1])) {
    points[col][row + 1] = true;
  }
  // 上方
  if (row !== (7 - side) && !isTongBang(moveQiZi, qiPan[col][row - 1])) {
    points[col][row - 1] = true;
  }
  // 左方
  if (col > 3 && !isTongBang(moveQiZi, qiPan[col - 1][row])) {
    points[col - 1][row] = true;
  }
  // 右方
  if (col < 5 && !isTongBang(moveQiZi, qiPan[col + 1][row])) {
    points[col + 1][row] = true;
  }
}

function calcPao(col: number, row: number, moveQiZi: number, qiPan: number[][], points: boolean[][]) {
  let gezi = 0;
  // 向左
  for (let i = col - 1; i >= 0; i--) {
    if (qiPan[i][row] === -1) { if (gezi === 0) points[i][row] = true; }
    else {
      if (!isTongBang(moveQiZi, qiPan[i][row]) && gezi === 1) points[i][row] = true;
      gezi++;
    }
  }
  gezi = 0;
  // 向右
  for (let i = col + 1; i <= 8; i++) {
    if (qiPan[i][row] === -1) { if (gezi === 0) points[i][row] = true; }
    else {
      if (!isTongBang(moveQiZi, qiPan[i][row]) && gezi === 1) points[i][row] = true;
      gezi++;
    }
  }
  gezi = 0;
  // 向上
  for (let i = row - 1; i >= 0; i--) {
    if (qiPan[col][i] === -1) { if (gezi === 0) points[col][i] = true; }
    else {
      if (!isTongBang(moveQiZi, qiPan[col][i]) && gezi === 1) points[col][i] = true;
      gezi++;
    }
  }
  gezi = 0;
  // 向下
  for (let i = row + 1; i <= 9; i++) {
    if (qiPan[col][i] === -1) { if (gezi === 0) points[col][i] = true; }
    else {
      if (!isTongBang(moveQiZi, qiPan[col][i]) && gezi === 1) points[col][i] = true;
      gezi++;
    }
  }
}

function calcHeiZu(col: number, row: number, moveQiZi: number, qiPan: number[][], points: boolean[][]) {
  // 未过河（row <= 4）不得横走
  if (row < 9 && !isTongBang(moveQiZi, qiPan[col][row + 1])) {
    points[col][row + 1] = true;
  }
  if (row > 4) {
    if (col > 0 && !isTongBang(moveQiZi, qiPan[col - 1][row])) points[col - 1][row] = true;
    if (col < 8 && !isTongBang(moveQiZi, qiPan[col + 1][row])) points[col + 1][row] = true;
  }
}

function calcHongBing(col: number, row: number, moveQiZi: number, qiPan: number[][], points: boolean[][]) {
  // 未过河（row >= 5）不得横走
  if (row > 0 && !isTongBang(moveQiZi, qiPan[col][row - 1])) {
    points[col][row - 1] = true;
  }
  if (row < 5) {
    if (col > 0 && !isTongBang(moveQiZi, qiPan[col - 1][row])) points[col - 1][row] = true;
    if (col < 8 && !isTongBang(moveQiZi, qiPan[col + 1][row])) points[col + 1][row] = true;
  }
}

// 【R-11】原 isKilledPoint 已删除：全仓无任何调用者（定义处是唯一命中）。
// 它自身还有与 R-2 同源的越界隐患 —— myQiPan[piecePositions[jiangOrShuai].col]
// 在缺帅/缺将时 col 为 -1，会写到 myQiPan[-1] 上。保留一个无人调用又会误导维护者
// 以为"这里有防护"的导出，比删掉更糟。

/**
 * 棋子移动到指定位置后，本方是否还被将军。
 *
 * ============================================================================
 * 【唯一真源 / SINGLE SOURCE OF TRUTH】三端合法着法判定的唯一依据。
 * 本函数是 GameEngine.hasAnyLegalMove / isJueSha / isKunBi 的底层判据，
 * 也是 AIEngine.isGeneralAttacked 逐行对齐的参照（见下）。任何修改必须：
 *   1. 同步三端——UI（chinese-chess-client/client/utils/chess/）、AI 引擎
 *      （AIEngine.isGeneralAttacked）、服务端裁决（chinese-chess-server/
 *      ruleEngine.cjs，由 client/utils/chess/ruleEngine.bundle.ts 经 esbuild
 *      重新打包生成，勿直接手改产物）。
 *   2. 跑 node _review/probe_diff_head.cjs 验证——它对随机局面做新旧差分，
 *      要求"新增可选点"之外「消失的可选点」为 0、「合法着法指纹差异」与
 *      「终局判定差异」均为 0。放宽规则会显著增加可选点，属预期；
 *      但若指纹或终局判定出现非零差异，说明改动外溢到了不该动的地方。
 *
 * 【特别注意 · 不得当作 bug 修掉的语义】"将帅照面"在引擎里不是"被将军"。
 * 本函数用两段独立的逻辑分别判定，二者语义不同、不可互相替代或合并：
 *   · 飞将/白脸将段（下方 :338-355）：两将/帅同列且中间无子 ⇒ 判 true，
 *     拦的是"走完之后自己把己方将帅送到对方炮口上"。
 *   · 被攻击段（下方 :357+）：只扫 5..15（红子）与 21..31（黑子）这些
 *     **非将子**，用 getPathPoints 判是否够得着。敌方将/帅（0 / 16）不在
 *     扫描区间内——即"敌方将帅照面攻击我方将帅"在这一段里根本不算被将。
 * 换言之，照面是否算"被将"完全取决于上面那段的独立判定，不要在重构成
 * 统一走法生成函数时顺手把它并进攻击判定，那会让所有原本合法的照面着法
 * 突然变成非法（历史上 AI 曾因此漏掉大量真实取胜着，见 _review/probe_ai_mate.cjs）。
 *
 * 【揭棋 · 暗子不是攻击者（方案 §3.1，与直觉相反，必须显式实现）】
 * `hiddenAttacker(id)` 由调用方注入，命中表示该子是**未翻开的暗子**。
 * 暗子必须从被攻击段的扫描中排除，原因：
 *   暗子的占位 id 只保证「按棋位走法」，但这个走法**不是玩家能看见的攻击**。
 *   若不排除，开局基线占位（底线两枚车号暗子正对对方将/帅）就会被算成
 *   「己方将帅正被攻击」→ 开局即白脸将判负，或所有合法着法被判送将。
 *   棋规上攻击性由**真实身份**决定，而真实身份对双方都不可见，故暗子
 *   既不能将军、也不能构成白脸将的依据。
 * 象棋不注入该回调（传 undefined），分支恒不进入，既有行为逐字节不变。
 *
 * 【揭棋 · 攻击范围必须按真实身份派发（与 GameEngine.isJiangJun 同口径）】
 * `attackerMotion(id)` 注入攻击者的有效走法参数（crossRiver / effectiveId）。
 *
 * ⚠️ 这里曾漏注入，导致一个**双向**的错误（实测 272 个随机着法里 45 个分歧）：
 *   决策 A 下盘面 id 恒等于**棋位棋种**，而攻击性由**真实身份**决定。
 *   于是「占位是卒、真身是炮」的暗子翻开后会：
 *     · 只按盘面 id 派发 → 算不出炮的攻击 ⇒ **漏判仍在被将**（漏拦送将）；
 *     · 反向地「占位是车、真身是马」时 → 多算出不存在的车 ⇒
 *       把本可的应将着法（如上仕挡将）**误拦成「着法送将」**。
 *   isJiangJun（走子前）一直按真实身份派发，本函数（走子后）却没有，
 *   两者口径分叉 ⇒ 同一局面「走子前说被将、走子后说没被将」。
 *   故凡涉及攻击范围的判定，**必须**与 isJiangJun 走同一套 motionArgs。
 * ============================================================================
 */
export function afterMoveStillJiangJun(
  qiZi: number, x0: number, y0: number, x1: number, y1: number,
  qiPan: number[][], piecePositions: Array<{ col: number; row: number; alive: boolean }>,
  hiddenAttacker?: (id: number) => boolean,
  attackerMotion?: (id: number) => { crossRiver?: boolean; effectiveId?: number }
): boolean {
  const myQiPan = qiPan.map(r => [...r]);
  myQiPan[x1][y1] = qiZi;
  myQiPan[x0][y0] = -1;

  const myPositions = piecePositions.map((p, i) => {
    if (i === qiZi) return { col: x1, row: y1, alive: p.alive };
    return { ...p };
  });

  // 飞将规则（白脸将）：两将/帅同列且中间无任何棋子时，
  // 相当于己方将/帅正被对方将/帅攻击，该走法不合法
  let jiang0Col = -1, jiang0Row = -1, shuai16Col = -1, shuai16Row = -1;
  for (let c = 0; c < 9; c++) {
    for (let r = 0; r < 10; r++) {
      if (myQiPan[c][r] === 0) { jiang0Col = c; jiang0Row = r; }
      else if (myQiPan[c][r] === 16) { shuai16Col = c; shuai16Row = r; }
    }
  }
  if (jiang0Col >= 0 && shuai16Col >= 0 && jiang0Col === shuai16Col) {
    let blocked = false;
    const top = Math.min(jiang0Row, shuai16Row);
    const bottom = Math.max(jiang0Row, shuai16Row);
    for (let r = top + 1; r < bottom; r++) {
      if (myQiPan[jiang0Col][r] !== -1) { blocked = true; break; }
    }
    if (!blocked) return true;
  }

  // 【R-2 · P0 崩溃防护·与 GameEngine.isJiangJun 同源】piecePositions 里的缺席子
  // col/row 是 -1（createFromFen 的初始化值），下面 thisPoints[x][y] 会变成
  // thisPoints[-1][-1] → TypeError: Cannot read properties of undefined。
  // 缺将/缺帅的局面（畸形残局 FEN）没有"己方将被"的语义，直接跳过一次判定。
  const shuai = piecePositions[16];
  const jiang = piecePositions[0];
  const shuaiOffBoard = !shuai || !shuai.alive || shuai.col < 0 || shuai.col > 8 || shuai.row < 0 || shuai.row > 9;
  const jiangOffBoard = !jiang || !jiang.alive || jiang.col < 0 || jiang.col > 8 || jiang.row < 0 || jiang.row > 9;

  for (let i = 0; i < 9; i++) {
    for (let j = 0; j < 10; j++) {
      const localQiZi = myQiPan[i][j];
      if (qiZi > 15) {
        if (localQiZi >= 5 && localQiZi <= 15) {
          if (!piecePositions[localQiZi].alive) continue;
          // 揭棋：暗子不是攻击者（方案 §3.1，与直觉相反，必须显式排除）
          if (hiddenAttacker && hiddenAttacker(localQiZi)) continue;
          if (!(qiZi === 16) && shuaiOffBoard) continue;
          // 【揭棋 · 必须与 GameEngine.isJiangJun 同口径】攻击者的攻击范围按**真实身份**派发。
          // 盘面 id 只是棋位（决策 A：id 永不因翻开而改变），占位兵/卒按真实身份是炮时
          // 就能隔子将军；只按 localQiZi 派发会漏判「仍在被将」⇒ 漏拦送将，
          // 反向也会误判安全 ⇒ 把本可的应将着法（如上仕挡将）拦成「送将」。
          const am = attackerMotion ? attackerMotion(localQiZi) : undefined;
          const thisPoints = getPathPoints(localQiZi, myQiPan, myPositions, am?.crossRiver, am?.effectiveId);
          const x = (qiZi === 16) ? x1 : shuai.col;
          const y = (qiZi === 16) ? y1 : shuai.row;
          if (thisPoints[x][y]) return true;
        }
      }
      if (qiZi < 16) {
        if (localQiZi >= 21 && localQiZi <= 31) {
          if (!piecePositions[localQiZi].alive) continue;
          // 揭棋：同上
          if (hiddenAttacker && hiddenAttacker(localQiZi)) continue;
          if (qiZi !== 0 && jiangOffBoard) continue;
          const am = attackerMotion ? attackerMotion(localQiZi) : undefined;
          const thisPoints = getPathPoints(localQiZi, myQiPan, myPositions, am?.crossRiver, am?.effectiveId);
          const x = (qiZi === 0) ? x1 : jiang.col;
          const y = (qiZi === 0) ? y1 : jiang.row;
          if (thisPoints[x][y]) return true;
        }
      }
    }
  }
  return false;
}
