/**
 * 揭棋 · 端到端冒烟（jieqiFlow.test.ts）
 *
 * 用**与 screens/game 完全相同的调用序列**跑完一整局：
 *   buildJieqiInitialGameState → makeMove(带 identity) → aiDispatcher 拿 AI 着法 → makeMove → …
 *
 * 目的是把「引擎单测全绿但界面接线是错的」这类问题挡在测试里：
 * 例如漏传 identity（于是 AI/玩家走暗子永远不翻开）、
 * 或重开时没重新洗牌（于是两局暗子布局一模一样）。
 */

import { getBestMoveOffline } from '../aiDispatcher';
import { makeMove, getValidMoves, isMoveKingSafe, isJiangJun } from '../GameEngine';
import { buildJieqiInitialGameState } from '../../../hooks/useNewGame';
import { liveHiddenSlots } from '../jieqi';
import { RED_SIDE, BLACK_SIDE, BOARD_COLS, BOARD_ROWS, type GameState } from '../types';

describe('揭棋 · 端到端（与 screens/game 同调用序列）', () => {
  it('一整局：玩家与 AI 都能走暗子，每次翻开一枚且不重复', async () => {
    const { state: fresh, identity } = buildJieqiInitialGameState(RED_SIDE);
    const playerSide = RED_SIDE;
    const aiSide = BLACK_SIDE;

    let state = fresh;
    expect(state.variant).toBe('jieqi');
    expect(liveHiddenSlots(state, RED_SIDE)).toHaveLength(15);
    expect(liveHiddenSlots(state, BLACK_SIDE)).toHaveLength(15);

    let playerMoves = 0;
    let aiMoves = 0;
    let reveals = 0;

    for (let ply = 0; ply < 20; ply++) {
      const isPlayer = state.sideTag === playerSide;
      let mv: { pieceId: number; toCol: number; toRow: number } | null = null;

      if (isPlayer) {
        // 玩家：优先走暗子（验证玩家侧翻开）
        const ids = liveHiddenSlots(state, playerSide);
        outer:
        for (const id of ids) {
          const pts = getValidMoves(state, id);
          for (let c = 0; c < BOARD_COLS; c++) {
            for (let r = 0; r < BOARD_ROWS; r++) {
              if (pts[c][r] && isMoveKingSafe(state, id, c, r)) {
                mv = { pieceId: id, toCol: c, toRow: r };
                break outer;
              }
            }
          }
        }
        if (!mv) {
          for (let id = playerSide === RED_SIDE ? 16 : 0; id < (playerSide === RED_SIDE ? 32 : 16); id++) {
            if (!state.pieces[id].alive) continue;
            const pts = getValidMoves(state, id);
            for (let c = 0; c < BOARD_COLS && !mv; c++) {
              for (let r = 0; r < BOARD_ROWS && !mv; r++) {
                if (pts[c][r] && isMoveKingSafe(state, id, c, r)) mv = { pieceId: id, toCol: c, toRow: r };
              }
            }
            if (mv) break;
          }
        }
        playerMoves++;
      } else {
        // AI：走 aiDispatcher（它内部会为揭棋短路到本地 TS AI）
        const aiMove = await getBestMoveOffline(state, 'easy');
        expect(aiMove).not.toBeNull();
        mv = { pieceId: aiMove!.pieceId, toCol: aiMove!.toCol, toRow: aiMove!.toRow };
        aiMoves++;
      }

      expect(mv).not.toBeNull();
      const wasHidden = state.hiddenMask![mv!.pieceId] === true;
      const before = liveHiddenSlots(state, mv!.pieceId <= 15 ? BLACK_SIDE : RED_SIDE).length;

      state = makeMove(state, mv!.pieceId, mv!.toCol, mv!.toRow, identity).newState;

      if (wasHidden) {
        // 关键：走暗子 ⇒ 必须翻开，且 revealedType 必须有值
        expect(state.hiddenMask![mv!.pieceId]).toBe(false);
        expect(state.revealedType![mv!.pieceId]).toBeTruthy();
        const after = liveHiddenSlots(state, mv!.pieceId <= 15 ? BLACK_SIDE : RED_SIDE).length;
        expect(after).toBe(before - 1);
        reveals++;
      }

      // 任何时刻：被判将的攻击者都不是暗子
      const king = state.sideTag === RED_SIDE ? 16 : 0;
      const j = isJiangJun(state, king);
      for (const a of [j[1], j[2]]) {
        if (a !== -1) expect(state.hiddenMask![a]).not.toBe(true);
      }
      void aiSide;
      if (state.gameStatus !== 'playing') break;
    }

    expect(playerMoves).toBeGreaterThan(0);
    expect(aiMoves).toBeGreaterThan(0);
    expect(reveals).toBeGreaterThan(0);
    expect(state.moveHistory.length).toBeGreaterThan(0);
  }, 60000);

  it('重开必须重新洗牌：两局初始身份不同', () => {
    const a = buildJieqiInitialGameState(RED_SIDE);
    const b = buildJieqiInitialGameState(RED_SIDE);
    // 身份表不同（几乎必然），但**状态里不含身份**（铁律 A）
    expect(JSON.stringify(a.state)).not.toContain('hiddenType');
    expect(JSON.stringify(b.state)).not.toContain('hiddenType');

    // 至少有一枚暗子的真实身份在两局之间不同
    const differing = a.identity.hiddenType.some((t, i) => t !== b.identity.hiddenType[i]);
    expect(differing).toBe(true);
  });

  it('揭棋局面不会被皮卡鱼 FEN 路径接受（杜绝误喂引擎）', async () => {
    const { state } = buildJieqiInitialGameState(RED_SIDE);
    // aiDispatcher 对揭棋短路到 TS AI，engine 标签必须是 'legacy'（本地基础 AI）
    const move = await getBestMoveOffline(state, 'easy');
    expect(move).not.toBeNull();
    expect(move!.engine).toBe('legacy');
  }, 20000);

  /**
   * 续局还原（2026-10 支持揭棋续局）。
   *
   * 模拟 screens/game 的真实存/取档路径：走若干手 → 把 gameState 与身份表
   * 过一遍 JSON（AsyncStorage 存的就是这个）→ 读回来继续走。
   *
   * 钉的是最要命的那条性质：**读档后未翻开的暗子仍带真实身份**。
   * 身份表若丢了或错位，续局不会立刻报错，而是把暗子翻成 null——
   * 玩家看到的是一盘凭空变空的棋。这种错只有真跑一遍走子才暴露。
   */
  it('存/取档后继续走子：暗子仍能按原身份翻开', () => {
    const { state: fresh, identity } = buildJieqiInitialGameState(RED_SIDE);
    let state = fresh;

    // 先走几步，确保盘面已推进（这也覆盖了"已翻开的子存的是 revealedType"）
    for (let step = 0; step < 4; step++) {
      const side = state.sideTag;
      const slots = liveHiddenSlots(state, side);
      if (slots.length === 0) break;
      const id = slots[0];
      const pts = getValidMoves(state, id);
      let mv: { pieceId: number; toCol: number; toRow: number } | null = null;
      outer: for (let c = 0; c < BOARD_COLS; c++) {
        for (let r = 0; r < BOARD_ROWS; r++) {
          if (pts[c][r] && isMoveKingSafe(state, id, c, r)) {
            mv = { pieceId: id, toCol: c, toRow: r };
            break outer;
          }
        }
      }
      if (!mv) break;
      state = makeMove(state, mv.pieceId, mv.toCol, mv.toRow, identity).newState;
    }

    // ---- 存档：走 screens/game 存的那两个字段，并过一遍 JSON ----
    const dumped = JSON.stringify({
      gameState: state,
      jieqiIdentity: { hiddenType: identity.hiddenType, seed: identity.seed },
    }) as string;
    const restored = JSON.parse(dumped) as {
      gameState: GameState;
      jieqiIdentity: { hiddenType: (typeof identity.hiddenType)[number][]; seed: number };
    };

    // 铁律 A 复查：身份**仍然不在** gameState 里（它只活在并列字段里）
    expect(JSON.stringify(restored.gameState)).not.toContain('hiddenType');

    // ---- 续局：从读回的盘面继续走 ----
    let resumed = restored.gameState;
    const restoredIdentity = { hiddenType: restored.jieqiIdentity.hiddenType, seed: restored.jieqiIdentity.seed };
    let flipsAfterResume = 0;

    for (let step = 0; step < 12 && resumed.gameStatus === 'playing'; step++) {
      const side = resumed.sideTag;
      const slots = liveHiddenSlots(resumed, side);
      if (slots.length === 0) break;
      let mv: { pieceId: number; toCol: number; toRow: number } | null = null;
      // 走任一有路可走的暗子，重点看它翻开时有没有真实身份
      for (const id of slots) {
        const pts = getValidMoves(resumed, id);
        outer2: for (let c = 0; c < BOARD_COLS; c++) {
          for (let r = 0; r < BOARD_ROWS; r++) {
            if (pts[c][r] && isMoveKingSafe(resumed, id, c, r)) {
              mv = { pieceId: id, toCol: c, toRow: r };
              break outer2;
            }
          }
        }
        if (mv) break;
      }
      if (!mv) break;

      const wasHidden = resumed.hiddenMask![mv.pieceId] === true;
      resumed = makeMove(resumed, mv.pieceId, mv.toCol, mv.toRow, restoredIdentity).newState;
      if (wasHidden) {
        // 核心断言：走暗子必翻开，且**翻出真实身份**（不是 null 的空壳）
        expect(resumed.hiddenMask![mv.pieceId]).toBe(false);
        expect(resumed.revealedType![mv.pieceId]).toBeTruthy();
        // 且身份要与身份表里存的一致
        expect(resumed.revealedType![mv.pieceId]).toBe(restoredIdentity.hiddenType[mv.pieceId]);
        flipsAfterResume++;
      }
    }

    expect(flipsAfterResume).toBeGreaterThan(0);
  });
});
