/**
 * 【根因回归测试】AIEngine 搜索的 applyMove / unapplyMove 失配导致棋盘状态泄漏
 *
 * ============================================================================
 * 【线上事故 · 2026-10】Expo web 红屏：
 *   Uncaught Error: Cannot read properties of undefined (reading '-1')
 *   Call Stack: applyMove → minimax(next) → … → searchWithTimeBudget → runHintSearch
 *   （全部在 utils/chess/AIEngine.ts）
 * ============================================================================
 *
 * 直接原因：`getPositionBonus`（AIEngine.ts:280）读 `PAWN_POSITION_BONUS[row][col]`，
 * 当 row 为 -1 时 `PAWN_POSITION_BONUS[-1]` 是 undefined，再取 `[-1]` 抛 TypeError。
 * （同一类越界在 applyMove:742 的 ZOBRIST_TABLE 也存在，只是先被 evaluate 命中。）
 *
 * 真正的根因 —— **searchWithTimeBudget 根节点循环里 applyMove 没有配对的 unapplyMove**：
 *
 *   AIEngine.ts:1209-1342
 *     const undo = applyMove(state, move.pieceId, move.toCol, move.toRow);
 *     if (!isSideInCheck(state, moverSide)) {          // ← 非法着法（送将）走不进来
 *       let score = 0;
 *       try { …gen 驱动… } finally { gen.return(0); unapplyMove(state, undo); }  // ← 撤销只在这里
 *       …
 *     }
 *     // 没有 else：isSideInCheck 为真时，这次 applyMove 永久留在棋盘上
 *
 * 每一个**非法根走法**（送将/暴露将帅）都会把落子永久泄漏到棋盘：
 *   · 走子方的 col/row 停在 toCol/toRow（qiPan 上的 from 格已被清空 → 永不复原）；
 *   · 被吃子被置 `alive=false, col/row=-1`，但它原来的格子在 qiPan 上**仍是它**
 *     （applyMove 只清 from 格，从不清被吃子的原格），于是在棋盘上留下一枚
 *     「已死亡却仍登记在 qiPan 上、坐标为 -1」的僵尸子。
 *
 * 泄漏如何演变成「悬空活子（alive=true 且 col/row=-1）」→ 崩溃：
 *   1. 搜索返回时棋盘已被污染，但调用方拿到的 `bestMove` 仍来自正确局面 —— 泄漏被静默吞掉；
 *   2. 同一批次搜索的**后续根走法**在污染后的棋盘上继续评估：某个走法落到那枚僵尸子
 *      所在的格子上，applyMove 读到 `capturedPieceId = 僵尸 id`；
 *   3. unapplyMove 撤销时执行 `alive = true; col = undo.capturedCol; row = undo.capturedRow`，
 *      而 undo.capturedCol/Row 正是 **-1**（泄漏留下的）→ 得到
 *      **alive=true + col/row=-1 的悬空活子**；
 *   4. 悬空活子下一轮被 generatePseudoMoves 当成在场棋子，evaluate 读它的
 *      `PAWN_POSITION_BONUS[-1][col]`（卒/兵）或 ZOBRIST_TABLE[id][-1][row] → TypeError。
 *
 * 本文件把该事实钉死：
 *   · H) 随机合法对局下，每次 searchWithTimeBudget 返回后 auditBoardConsistency 必须为空
 *      —— 这是「搜索不得污染传入局面」这一不变式（修复前在 ply≈26 必然失败）；
 *   · I) 定向构造「送将 + 被吃子」局面，钉死泄漏 → 悬空活子 → 崩溃的完整链条；
 *   · J) 正常开局搜索后，pieces 坐标/alive 与搜索前逐一枚子完全一致（零漂移）。
 */
import {
  createInitialState, createFromFen, cloneGameState, makeMove, getValidMoves,
  auditBoardConsistency, type GameState,
} from '../GameEngine';
import { searchWithTimeBudget, cloneForSearch } from '../AIEngine';

const SEED = 987654321;
function makeRnd(seedInit: number): () => number {
  let seed = seedInit;
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

/** 从局面里挑一个当前走棋方的随机合法着法 */
function randomLegalMove(state: GameState, rnd: () => number): [number, number, number] | null {
  const side = state.sideTag;
  const cands: number[] = [];
  for (let id = 0; id < 32; id++) {
    const belongs = id <= 15 ? false : true;
    if (belongs !== side || !state.pieces[id].alive) continue;
    let has = false;
    const pts = getValidMoves(state, id);
    for (let c = 0; c < 9 && !has; c++) for (let r = 0; r < 10 && !has; r++) if (pts[c][r]) has = true;
    if (has) cands.push(id);
  }
  if (!cands.length) return null;
  const pid = cands[Math.floor(rnd() * cands.length)];
  const pts = getValidMoves(state, pid);
  const dests: Array<[number, number]> = [];
  for (let c = 0; c < 9; c++) for (let r = 0; r < 10; r++) if (pts[c][r]) dests.push([c, r]);
  const [toCol, toRow] = dests[Math.floor(rnd() * dests.length)];
  return [pid, toCol, toRow];
}

/** 逐子快照 pieces 的 (col,row,alive)，用于比对搜索前后是否漂移 */
function snapshotPieces(state: GameState): string[] {
  return state.pieces.map(p => `${p.id}:${p.col},${p.row},${p.alive ? 1 : 0}`);
}

describe('AIEngine 搜索不得污染传入局面（applyMove/unapplyMove 配对）', () => {
  it('H) 随机合法对局：每次搜索返回后棋盘与 pieces 必须自洽', async () => {
    const rnd = makeRnd(SEED);
    let state = createInitialState();
    let checked = 0;

    for (let ply = 0; ply < 40; ply++) {
      const mv = randomLegalMove(state, rnd);
      if (!mv) { state = createInitialState(); continue; }
      state = makeMove(state, mv[0], mv[1], mv[2]).newState;

      const probeState = cloneForSearch(state);
      expect(auditBoardConsistency(probeState)).toEqual([]); // 搜索前的局面本身是干净的

      await searchWithTimeBudget(probeState, 2, 150, true);

      // 不变式：搜索是「读」局面，不得把它改坏 —— 返回后必须与搜索前完全一致
      expect(snapshotPieces(probeState)).toEqual(snapshotPieces(state));
      expect(auditBoardConsistency(probeState)).toEqual([]);
      checked++;
    }
    expect(checked).toBeGreaterThan(20);
  }, 120000);

  it('I) 送将 + 吃子：泄漏 → 悬空活子 → 崩溃 的完整链条', async () => {
    // 盘面：红帅(4,9)、红车(4,7) 被黑车(4,3) 钉在 4 线上；黑车(6,7) 紧邻红车右侧。
    // 红车横向走到 (5,7)/(6,7) 是送将（暴露帅）→ 属于「非法根走法」，正是泄漏触发条件。
    // 红炮(1,7) 炮架黑车(6,3) 后可打到 (6,7) 吃子。
    const state = createFromFen('4k4/9/9/4r4/9/9/4r4/4R1R2/9/4K4 w');
    const probeState = cloneForSearch(state);
    expect(auditBoardConsistency(probeState)).toEqual([]);

    // 修复前：这一步要么在搜索内部抛 TypeError（悬空活子被 evaluate 命中），
    // 要么返回后棋盘已被污染 —— 两种都算失败。
    await expect(searchWithTimeBudget(probeState, 3, 500, true)).resolves.toBeDefined();
    expect(snapshotPieces(probeState)).toEqual(snapshotPieces(state));
    expect(auditBoardConsistency(probeState)).toEqual([]);
  }, 30000);

  it('J) 正常开局搜索：棋子零漂移（含被吃子坐标复原）', async () => {
    const state = createInitialState();
    const probeState = cloneForSearch(state);
    await searchWithTimeBudget(probeState, 3, 400, true);
    expect(snapshotPieces(probeState)).toEqual(snapshotPieces(state));
    expect(auditBoardConsistency(probeState)).toEqual([]);
  }, 30000);
});
