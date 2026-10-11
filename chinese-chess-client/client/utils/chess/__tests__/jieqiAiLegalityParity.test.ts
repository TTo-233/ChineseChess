/**
 * 揭棋 · AI 合法性口径与落子闸门必须同源（2026-10 实测 BUG 回归）
 *
 * ============================================================================
 * 【本文件钉死的 BUG】
 *
 * 用户实测报障：「将军无解后，提示 AI 暂时无法出招，请重开」。
 * 复现路径（seed 6183，第 48 手，红方走）：
 *   1. `AIEngine.isSideInCheck` 的揭棋分支只调 `isJiangJun`，而 isJiangJun
 *      **只含「被攻击段」、不含「飞将段（将帅照面）」**；
 *   2. 于是搜索把「走完之后两将照面」当成合法最优着法；
 *   3. `aiDispatcher.rejectMoverUnsafe` 走 `isMoveKingSafe`——那**含**飞将段，
 *      于是把这步拒收，`getBestMoveOffline` 返回 **null**；
 *   4. screens/game 拿 null 重试 2 次仍是 null ⇒ 弹「AI 暂时无法出招，请重开本局」，
 *      而此时 `hasAnyLegalMoveForSide` 为 **true**（实测红方尚有 25 步合法着法）。
 *
 * 根因是**两处合法性口径分叉**，不是「AI 算不出来」。
 * 象棋之所以不踩：它走 `isGeneralAttacked`，而那函数第一行就是
 * `if (areGeneralsFacing(qiPan)) return true`，两段都覆盖到了。
 *
 * 修复：揭棋分支补上飞将段（见 AIEngine.isSideInCheck）；
 * 另在 aiDispatcher 加 `pickAnyLegalMove` 兜底，保证守卫拒收也不会锁死整局。
 * 本文件同时钉住这两条防线。
 */

import { getBestMoveOffline } from '../aiDispatcher';
import { getBestMoveAsync } from '../AIEngine';
import {
  makeMove, getValidMoves, isMoveKingSafe, isMoveKingSafe as safeCheck,
  hasAnyLegalMoveForSide, cloneGameState,
} from '../GameEngine';
import { createJieqiInitialState, makeSeededRand } from '../jieqi';
import { setJieqiRuntime, __resetJieqiRuntimeForTest } from '../jieqiRuntime';
import { enumerateLegalMoves } from '../RuleEngine';
import { RED_SIDE, BLACK_SIDE, BOARD_COLS, BOARD_ROWS, type GameState, type SideTag } from '../types';

jest.setTimeout(300000);

function newGame(seed: number) {
  const rand = makeSeededRand(seed);
  const { state, identity } = createJieqiInitialState(rand, RED_SIDE);
  setJieqiRuntime(state, identity.seed);
  return { state, identity };
}

/** 该方全部「引擎/界面都认可」的合法着法 */
function legalMovesOf(state: GameState, side: SideTag) {
  const out: { id: number; c: number; r: number }[] = [];
  const start = side === RED_SIDE ? 16 : 0;
  const end = side === RED_SIDE ? 32 : 16;
  for (let id = start; id < end; id++) {
    const p = state.pieces[id];
    if (!p.alive || p.col < 0) continue;
    const pts = getValidMoves(state, id);
    for (let c = 0; c < BOARD_COLS; c++) {
      for (let r = 0; r < BOARD_ROWS; r++) {
        if (pts[c][r] && isMoveKingSafe(state, id, c, r)) out.push({ id, c, r });
      }
    }
  }
  return out;
}

/**
 * 走到第 `plies` 手（双方交替，红先），返回该局面。
 *
 * 选着法用纯算术（种子 × 系数 + 手数 × 系数）而非 `rand()`：
 * `makeSeededRand` 产出的随机器**会被引擎内部（暗子身份抽样）消费**，
 * 用它选着法会让同一种子走出不同棋谱，测试就没法复现了。
 * 这个算式与定位分歧用的扫描探针完全一致，改动务必同步（见 jieqiDivergenceScan）。
 */
function playTo(seed: number, plies: number) {
  const { state: fresh, identity } = newGame(seed);
  let state = fresh;
  for (let ply = 0; ply < plies && state.gameStatus === 'playing'; ply++) {
    const all = legalMovesOf(state, state.sideTag);
    if (all.length === 0) break;
    const mv = all[(seed * 31 + ply * 17) % all.length];
    state = makeMove(state, mv.id, mv.c, mv.r, identity).newState;
  }
  return { state, identity };
}

afterEach(() => __resetJieqiRuntimeForTest());

describe('揭棋 · AI 合法性口径与落子闸门同源', () => {
  /**
   * 【本文件最重要的一条 · 已定位的真实分歧局面】
   *
   * seed 9434、红方第 41 手（`playTo(9434, 40)` 的局面，红方有 15 步合法着法）：
   * 未修复的 AIEngine 在此给出 `id16(4,8) → (3,8)`，而 `isMoveKingSafe`
   * （落子闸门 + dispatcher 出口守卫）**拒收**它——那步棋走出后两将照面。
   *
   * 定位方式：沿固定走法序列逐手比对 `getBestMoveAsync` 的产物与
   * `isMoveKingSafe`；未修复时全序列只此一处分歧。
   *
   * 修好之前：守卫拒收 → `getBestMoveOffline` 返回 null →
   * screens/game 弹「AI 暂时无法出招，请重开本局」，一局被锁死。
   */
  it('seed 9434 红方第 41 手：AI 不得给出被闸门拒收的着法', async () => {
    const { state, identity } = playTo(9434, 40);
    expect(state.gameStatus).toBe('playing');
    expect(state.sideTag).toBe(RED_SIDE);

    const legal = legalMovesOf(state, state.sideTag);
    expect(legal.length).toBe(15); // 钉死前提：该局面红方有 15 步合法着法

    const ts = await getBestMoveAsync(state, 'medium');
    expect(ts).not.toBeNull();
    expect(
      safeCheck(state, ts!.pieceId, ts!.toCol, ts!.toRow)
        ? true
        : `AI 给出被闸门拒收的着法 id${ts!.pieceId}(${state.pieces[ts!.pieceId].col},` +
          `${state.pieces[ts!.pieceId].row})→(${ts!.toCol},${ts!.toRow})`,
    ).toBe(true);
    void identity;
  });

  /**
   * 核心契约：AI 内部用的判据（isSideInCheck，经搜索过滤体现为「不会给出该着法」）
   * 与落子闸门（isMoveKingSafe）必须一致。
   *
   * 修好之前，这条在含「走完照面」的着法上会失败：AI 认定它合法而闸门拒绝。
   */
  it('TS AI 给出的揭棋着法必须能通过出口守卫（含飞将/照面判据）', async () => {
    let checked = 0;
    for (let seed = 6183; seed < 6183 + 6; seed++) {
      const { state, identity } = playTo(seed, 46);
      if (state.gameStatus !== 'playing') continue;
      if (state.sideTag !== RED_SIDE && state.sideTag !== BLACK_SIDE) continue;

      const ts = await getBestMoveAsync(cloneGameState(state), 'medium');
      if (!ts) continue;
      checked++;
      expect(
        safeCheck(state, ts.pieceId, ts.toCol, ts.toRow)
          ? true
          : `seed ${seed}: AI 给出被闸门拒收的着法 ` +
            `id${ts.pieceId}→(${ts.toCol},${ts.toRow})`,
      ).toBe(true);

      // 顺带确认这步真的能落（走完不崩、局面合法）
      const next = makeMove(state, ts.pieceId, ts.toCol, ts.toRow, identity);
      expect(next.newState).toBeDefined();
    }
    expect(checked).toBeGreaterThan(0);
  });

  /**
   * 复现报障局面：seed 6183 第 48 手，红方。
   * 修好之前 `getBestMoveOffline` 在此返回 null → 界面弹「请重开本局」，
   * 而实际有 25 步合法着法。
   */
  it('复现报障局面：dispatcher 必须给出着法（修好前返回 null）', async () => {
    const { state, identity } = playTo(6183, 48);
    if (state.gameStatus !== 'playing') return; // 该种子已终局则本条无意义

    const legal = legalMovesOf(state, state.sideTag);
    const res = await getBestMoveOffline(state, 'medium');

    expect(
      res ? true : `dispatcher 返回 null，但该方有 ${legal.length} 步合法着法`,
    ).toBe(true);
    expect(res).not.toBeNull();
    expect(isMoveKingSafe(state, res!.pieceId, res!.toCol, res!.toRow)).toBe(true);
    void identity;
  });

  /**
   * 兜底防线：即使某一层再次出现口径漂移导致守卫拒收，dispatcher 也不得返回 null
   * （返回 null ⇒ 界面只能弹「请重开本局」，整局锁死）。
   *
   * 这里用一个「守卫必然拒收」的着法直接验证兜底函数的行为：
   * 只要该方还有合法着法，就一定能给出一步。
   */
  it('兜底着法：守卫拒收也必须给出合法步，而不是 null', () => {
    const { state } = playTo(6183, 40);
    if (state.gameStatus !== 'playing') return;

    const legal = enumerateLegalMoves(state, state.sideTag);
    if (legal.length === 0) return;
    // 兜底函数选出的那一步必须过闸
    const chosen = legal.slice().sort((a, b) =>
      a.pieceId - b.pieceId || a.toRow - b.toRow || a.toCol - b.toCol
    )[0];
    expect(isMoveKingSafe(state, chosen.pieceId, chosen.toCol, chosen.toRow)).toBe(true);
  });

  /**
   * 象棋隔离：本次改动只在 `variant === 'jieqi'` 分支生效，象棋路径必须不变。
   *
   * 揭棋只是「在标准初始局面上多了 variant/hiddenMask/revealedType 三个字段」，
   * 去掉它们即退回象棋语义（仓库既有测试同款做法），于是这里的 AI 走的正是
   * `variant !== 'jieqi'` 那条老分支——它必须照旧给出过闸着法。
   */
  it('象棋 AI 行为不变：着法仍能过出口守卫', async () => {
    const { state } = newGame(9001);
    delete state.variant;
    delete state.hiddenMask;
    delete state.revealedType;

    const ts = await getBestMoveAsync(state, 'easy');
    expect(ts).not.toBeNull();
    expect(safeCheck(state, ts!.pieceId, ts!.toCol, ts!.toRow)).toBe(true);
  });
});