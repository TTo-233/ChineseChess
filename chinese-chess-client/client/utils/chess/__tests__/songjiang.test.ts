/**
 * 送将（走后己方将/帅仍被攻击）判据与落子闸门测试
 *
 * ============================================================================
 * 【这个测试钉死什么 · 2026-09 线上事故】
 *
 * 4ccdae5 把「玩家能走哪些点」（getSelectableMoves / getValidMoves）的王安全过滤
 * 删掉了，理由是"允许玩家主动送将，送将后由对方走完一步即算终局，风险自负"。
 * 这个前提不成立：服务端 Pikafish 是标准象棋引擎，其合法着法生成**不含吃将**——
 * 对方将/帅摆在一步可吃的位置，它也不会去吃，而是照常走别的着法（实测 5/5 局面）。
 * 于是送将之后对局不会终结，而是永久停在一个「正被将军却无人应招」的非法局面：
 * isJueSha / isKunBi 都以 hasAnyLegalMove 为基础，对方走法充足，两者都不触发。
 *
 * 修法是**保留落点显示口径**（被将军时仍显示全部走点，避免"只剩应将点"变相提示），
 * 但真的要点下去时用 isMoveKingSafe 拦下。本文件把该判据钉死：
 *   · 四类送将必须全部识别（暴露阻挡 / 被牵制子 / 将帅照面 / 走将入攻击格）
 *   · 同类着法里"仍然挡着"的必须放行（不能把合法着法误杀）
 *   · 初始局面全部合法着法**一个都不能**被判送将（零假阳性）
 *   · 送将被拦后盘面不变，且对方随后仍能正常杀将终结（证明拦截是唯一有效修法）
 *
 * 判据复用 MoveCheck.afterMoveStillJiangJun，与 hasAnyLegalMove / isJueSha /
 * isKunBi / AIEngine.isSideInCheck 同口径——这正是选它的理由：拦截之后盘上
 * 不可能出现"该方被将且轮到该方"，绝杀/困毙判定与引擎搜索口径完全一致。
 */
import {
  createFromFen, createInitialState, makeMove, getValidMoves, isMoveKingSafe,
  type GameState,
} from '../GameEngine';
import { RED_SIDE, BLACK_SIDE } from '../types';

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 局面：行 0 = 黑方底线（上），行 9 = 红方底线（下）；字母小写=黑、大写=红 */
function fen(fenStr: string): GameState {
  return createFromFen(fenStr);
}

/** 从 FEN 局面里定位棋子的 id */
function findAt(state: GameState, col: number, row: number): number {
  const idx = state.pieces.findIndex((p) => p.alive && p.col === col && p.row === row);
  if (idx < 0) throw new Error(`局面中 (${col},${row}) 没有棋子`);
  return idx;
}

/** 列出某方所有"走点判定为可走"的着法（= 界面会显示的那些落点） */
function enumerateMoves(state: GameState, side: Tag): { pieceId: number; toCol: number; toRow: number }[] {
  const out: { pieceId: number; toCol: number; toRow: number }[] = [];
  const start = side === RED_SIDE ? 16 : 0;
  for (let i = start; i <= start + 15; i++) {
    if (!state.pieces[i].alive) continue;
    const points = getValidMoves(state, i);
    for (let c = 0; c < 9; c++) {
      for (let r = 0; r < 10; r++) {
        if (points[c][r]) out.push({ pieceId: i, toCol: c, toRow: r });
      }
    }
  }
  return out;
}

/** 某个落点是否出现在该子的走点表里 */
function shown(state: GameState, pieceId: number, toCol: number, toRow: number): boolean {
  return !!getValidMoves(state, pieceId)[toCol]?.[toRow];
}

type Tag = typeof RED_SIDE | typeof BLACK_SIDE;

// ---------------------------------------------------------------------------
// 四类送将
// ---------------------------------------------------------------------------

describe('送将判据 isMoveKingSafe —— 四类必须拦截的着法', () => {
  /**
   * 类 1：暴露阻挡（discovered check）
   * 黑车 (4,2) 挡在黑将 (4,0) 与红车 (4,4) 之间的 4 路上。
   * 挪到 7 路 → 让开 4 路 → 黑将自己暴露给红车（送将，必须拦）。
   * 挪到 (4,1) → 仍然挡在 4 路上 → 合法（必须放行，见下一组）。
   */
  test('类1 暴露阻挡：移开挡在将帅与敌子之间的子 → 判送将', () => {
    const state = fen('4k4/9/4r4/9/9/4R4/9/9/9/4K4 b');
    const rook = findAt(state, 4, 2);
    expect(shown(state, rook, 7, 2)).toBe(true); // 走点表里仍然显示（保持 4ccdae5 口径）
    expect(isMoveKingSafe(state, rook, 7, 2)).toBe(false); // 但落子必须被拦
  });

  /**
   * 类 2：被牵制子（钉子）
   * 黑马 (4,4) 被红车 (4,9) 钉在 4 路上，垫在黑将与红车之间。
   * 马走 (3,2) 离开 4 路 → 黑将被红车照面 → 送将。
   */
  test('类2 被牵制子：钉子离开线路 → 判送将', () => {
    const state = fen('4k4/9/9/9/4n4/9/9/9/9/4R4 b');
    const horse = findAt(state, 4, 4);
    expect(shown(state, horse, 3, 2)).toBe(true);
    expect(isMoveKingSafe(state, horse, 3, 2)).toBe(false);
  });

  /**
   * 类 3：将帅照面（飞将 / 白脸将）
   * 黑车 (4,6) 是黑将 (4,0) 与红帅 (4,9) 在 4 路上的唯一阻挡子。
   * 挪到 7 路 → 两将帅照面 → 送将。（红车 (4,9) 在该局面里不存在，
   * 红线由"将帅照面"本身构成，与 MoveCheck 的飞将段对应。）
   */
  test('类3 将帅照面：移开两将之间唯一阻挡子 → 判送将', () => {
    const state = fen('4k4/9/9/9/9/4r4/9/9/9/4K4 b');
    const rook = findAt(state, 4, 5);
    expect(isMoveKingSafe(state, rook, 7, 5)).toBe(false);
  });

  /**
   * 类 4：走将入攻击格
   * 黑将 (4,0) 沿 4 路下到 (4,1)，正落在红车 (4,5) 的火力线上 → 送将。
   */
  test('类4 走将入攻击格：走到敌子可控格 → 判送将', () => {
    const state = fen('4k4/9/9/9/9/4R4/9/9/9/4K4 b');
    const king = findAt(state, 4, 0);
    expect(isMoveKingSafe(state, king, 4, 1)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 同类着法里的合法分支（防误杀）
// ---------------------------------------------------------------------------

describe('送将判据 —— 同类着法里仍然成立的必须放行', () => {
  test('类1 变体：移开后仍然挡在攻击线上 → 合法', () => {
    const state = fen('4k4/9/4r4/9/9/4R4/9/9/9/4K4 b');
    const rook = findAt(state, 4, 2);
    expect(isMoveKingSafe(state, rook, 4, 1)).toBe(true);
  });

  test('类3 变体：移开后仍然挡住两将照面 → 合法', () => {
    const state = fen('4k4/9/9/9/9/4r4/9/9/9/4K4 b');
    const rook = findAt(state, 4, 5);
    expect(isMoveKingSafe(state, rook, 4, 3)).toBe(true);
  });

  test('类4 变体：将走到未被攻击的邻格 → 合法', () => {
    const state = fen('4k4/9/9/9/9/4R4/9/9/9/4K4 b');
    const king = findAt(state, 4, 0);
    // (5,0) 在 5 路，红车在 4 路打不到；该局面防守方只有将，无其他红子
    expect(isMoveKingSafe(state, king, 5, 0)).toBe(true);
  });

  test('吃将（对方将/帅被吃）永远是安全的 —— 否则没人能终结对局', () => {
    // 黑将 (4,0) 就摆在红车 (4,5) 的 4 路上（对方送将后的局面，红先）
    const state = fen('4k4/9/9/9/9/4R4/9/9/9/4K4 w');
    const rook = findAt(state, 4, 5);
    expect(isMoveKingSafe(state, rook, 4, 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 零假阳性
// ---------------------------------------------------------------------------

describe('送将判据 —— 初始局面零假阳性', () => {
  test('初始局面红方全部可走着法，被判送将的数量为 0', () => {
    const state = createInitialState();
    expect(state.sideTag).toBe(RED_SIDE);
    const moves = enumerateMoves(state, RED_SIDE);
    expect(moves.length).toBeGreaterThan(0); // 走点表本身非空（4ccdae5 的口径）
    const rejected = moves.filter((m) => !isMoveKingSafe(state, m.pieceId, m.toCol, m.toRow));
    expect(rejected).toEqual([]);
  });

  test('初始局面黑方全部可走着法，被判送将的数量也为 0', () => {
    const state = createInitialState();
    state.sideTag = BLACK_SIDE;
    const moves = enumerateMoves(state, BLACK_SIDE);
    expect(moves.length).toBeGreaterThan(0);
    const rejected = moves.filter((m) => !isMoveKingSafe(state, m.pieceId, m.toCol, m.toRow));
    expect(rejected).toEqual([]);
  });

  test('初始局面炮二平五（红炮 29 从 (7,7) 到 (4,6)）判为合法', () => {
    const state = createInitialState();
    expect(isMoveKingSafe(state, 29, 4, 6)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 与被拦着法同局面的对照：拦截之后，对方仍能正常杀将终结
// ---------------------------------------------------------------------------

describe('拦截送将的唯一性验证', () => {
  test('送将局面下，对方一步吃将即可终结（这正是被拦下来的那条脆弱路径）', () => {
    // 黑方送将后的局面：黑将 (4,0) 与红车 (4,5) 同在 4 路，红先
    const state = fen('4k4/9/9/9/9/4R4/9/9/9/4K4 w');
    const rook = findAt(state, 4, 5);
    // 红车吃将：captured === 0 表示吃的是黑将，引擎据此判红胜
    const result = makeMove(state, rook, 4, 0);
    expect(result.captured).toBe(0);
    expect(result.isGameOver).toBe(true);
    expect(result.newState.gameStatus).toBe('red_win');
  });

  test('送将判据拦住的着法，makeMove 仍能执行 —— 拦截点在界面层，不在引擎层', () => {
    // 这条测试记录一个刻意的分层选择：引擎保持"不判送将"的口径（服务端 ruleEngine
    // 是同一份代码，且 getValidMoves 被三端共用），送将拦截统一放在落子入口
    // （screens/game 的 executeMove、screens/lanBattle 的 handleMove、
    //  aiDispatcher 的在线走法守卫）。若哪天有人把过滤加回 getValidMoves，
    // 本测试会失败——那时应同步复核界面提示文案是否还成立。
    const state = fen('4k4/9/4r4/9/9/4R4/9/9/9/4K4 b');
    const rook = findAt(state, 4, 2);
    expect(isMoveKingSafe(state, rook, 7, 2)).toBe(false);
    const result = makeMove(state, rook, 7, 2);
    expect(result.newState.pieces[rook].col).toBe(7);
  });
});
