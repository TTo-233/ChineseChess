/**
 * 揭棋 · 攻击范围必须按真实身份派发（jieqiAttackIdentity）
 *
 * ============================ 这个文件为什么存在 ============================
 * 实测症状：对方车将军，我本可以上仕防御，系统却判「着法送将」。
 *
 * 根因：`MoveCheck.afterMoveStillJiangJun`（走子后判「是否仍被将」）
 * 在算攻击范围时只传了**盘面 id**，而 `GameEngine.isJiangJun`（走子前）
 * 一直传真实身份 —— 两者口径分叉。
 *
 * 决策 A 下盘面 id 恒等于**棋位棋种**，攻击性却由**真实身份**决定，
 * 所以这个分叉是**双向**的：
 *   · 占位是车、真身是马 → 多算出不存在的车攻击 ⇒ 把本可的应将着法
 *     （如上仕挡将）**误拦成「着法送将」**；        ← 用户报的这条
 *   · 占位是卒、真身是炮 → 算不出炮的攻击 ⇒ 漏判仍在被将 ⇒ 漏拦送将。
 *
 * 差分探针实测：修复前 272 个随机着法里 45 个与「走子后 isJiangJun 地真」分歧，
 * 修复后 0 个。本文件把这条口径钉死。
 */

import { isJiangJun, isMoveKingSafe, makeMove, getValidMoves, hasAnyLegalMove } from '../GameEngine';
import { afterMoveStillJiangJun } from '../MoveCheck';
import { createJieqiInitialState, makeSeededRand } from '../jieqi';
import { BOARD_COLS, BOARD_ROWS } from '../types';

function blankJieqi(): any {
  const { state } = createJieqiInitialState(makeSeededRand(7));
  // 必须清掉**整张**盘，而不只是活子的原位（红兵 29 在 (4,6)，
  // 会悄悄挡住 4 路的车，把用例变成假绿 —— 本仓已踩过这个坑）
  for (let c = 0; c < BOARD_COLS; c++) {
    for (let r = 0; r < BOARD_ROWS; r++) state.qiPan[c][r] = -1;
  }
  state.hiddenMask = new Array(32).fill(false);
  state.revealedType = new Array(32).fill(null);
  return state;
}
function put(s: any, id: number, c: number, r: number, revealed: string | null = null, hidden = false) {
  s.qiPan[c][r] = id;
  s.pieces[id].col = c; s.pieces[id].row = r; s.pieces[id].alive = true;
  s.hiddenMask[id] = hidden; s.revealedType[id] = revealed;
}
/** 地真：真走完，再问 isJiangJun（它按真实身份派发） */
function truthStillInCheck(s: any, id: number, c: number, r: number, identity: any): boolean {
  const gen = s.sideTag ? 16 : 0;
  return isJiangJun(makeMove(s, id, c, r, identity).newState, gen)[0] === gen;
}

describe('揭棋 · 攻击范围按真实身份派发（走子前/走子后必须同口径）', () => {
  it('差分：isMoveKingSafe 与「走子后 isJiangJun」在 272 个随机着法上零分歧', () => {
    let compared = 0, diverged = 0;
    const samples: string[] = [];
    for (const seed of [11, 12, 13, 14, 15, 16]) {
      const { state: init, identity } = createJieqiInitialState(makeSeededRand(seed));
      let state = init;
      for (let ply = 0; ply < 60; ply++) {
        const shape = getValidMoves(state, state.sideTag ? 16 : 0);
        for (let id = 0; id < 32; id++) {
          if (!state.pieces[id].alive) continue;
          if ((id <= 15 ? false : true) !== state.sideTag) continue;
          for (let c = 0; c < BOARD_COLS; c++) {
            for (let r = 0; r < BOARD_ROWS; r++) {
              if (!shape[c][r]) continue;
              compared++;
              const judged = !isMoveKingSafe(state, id, c, r);
              const truth = truthStillInCheck(state, id, c, r, identity);
              if (judged !== truth && samples.length < 5) {
                samples.push(`${seed}/${ply} ${id}(${state.pieces[id].col},${state.pieces[id].row})->(${c},${r}) 判=${judged} 真=${truth}`);
              }
              if (judged !== truth) diverged++;
            }
          }
        }
        const safe: Array<[number, number, number]> = [];
        for (let id = 0; id < 32; id++) {
          if (!state.pieces[id].alive) continue;
          if ((id <= 15 ? false : true) !== state.sideTag) continue;
          for (let c = 0; c < BOARD_COLS; c++) for (let r = 0; r < BOARD_ROWS; r++) {
            if (shape[c][r] && !truthStillInCheck(state, id, c, r, identity)) safe.push([id, c, r]);
          }
        }
        if (safe.length === 0) break;
        const p = safe[(seed * 7 + ply * 13) % safe.length];
        state = makeMove(state, p[0], p[1], p[2], identity).newState;
      }
    }
    expect(compared).toBeGreaterThan(200);
    expect(samples.join(' | ')).not.toMatch(/./);
    expect(diverged).toBe(0);
  });

  it('用户场景：黑炮真身是卒时，上仕不该被判「着法送将」', () => {
    // ============================================================================
    // 这就是用户报的 bug 的准确形状：
    //   攻击者盘面 id 是**炮**（按炮算：隔一个炮架就能打到帅 ⇒ 以为上仕后还在被将
    //   ⇒ 把「上仕」误拦成「着法送将」），而它的真实身份是**卒**（卒打不到帅，
    //   这盘根本就没被将）。上仕是唯一像样的应招，却点不动。
    //
    // 摆法：帅(4,9)、黑炮位(4,7)、仕暗子在(5,9)。
    // 上仕到 (4,8) 后，(4,8) 正好成了炮与帅之间的**炮架** ——
    // 若按占位炮算，炮能隔它打中帅 ⇒ 旧代码判「送将」；按真实卒算，打不到 ⇒ 合法。
    // ============================================================================
    const s = blankJieqi();
    s.sideTag = true;
    put(s, 16, 4, 9);                       // 红帅
    put(s, 9, 4, 7, 'zu');                  // 黑炮位（9），真身黑卒
    put(s, 17, 5, 9, null, true);           // 红仕 17：暗子

    // 地真：按真实身份（卒），这盘没被将
    expect(isJiangJun(s, 16)[0]).toBe(-1);
    // 所以上仕绝不能被判成送将 —— 这是旧代码会拦掉的着法
    expect(isMoveKingSafe(s, 17, 4, 8)).toBe(true);
  });

  it('对照：同一摆法但真身确实是炮时，上仕挡不住必须判送将', () => {
    const s = blankJieqi();
    s.sideTag = true;
    put(s, 16, 4, 9);
    put(s, 9, 4, 7, 'pao');                 // 真身就是炮
    put(s, 17, 5, 9, null, true);
    // 上仕到 (4,8) 成了炮架，炮仍能隔它将军 ⇒ 真送将，必须拦
    expect(isMoveKingSafe(s, 17, 4, 8)).toBe(false);
  });

  it('用户场景（正向）：黑车沿 4 路将军，暗子上仕到 (4,8) 挡住 —— 合法', () => {
    const s = blankJieqi();
    s.sideTag = true;
    put(s, 16, 4, 9);                       // 红帅 (4,9)
    put(s, 7, 4, 3, 'che');                 // 黑车（7 是黑车 id），真身车，4 路将军
    put(s, 17, 5, 9, null, true);           // 红仕 17：**暗子**，棋位 (5,9)
    expect(isJiangJun(s, 16)[0]).toBe(16);  // 确实被将
    expect(isMoveKingSafe(s, 17, 4, 8)).toBe(true);   // 上仕挡住 ⇒ 合法
    expect(isMoveKingSafe(s, 17, 6, 8)).toBe(false);  // 走到 (6,8) 离开 4 路 ⇒ 送将
  });

  it('对照：上仕离开 4 路（不再挡车）应判送将', () => {
    const s = blankJieqi();
    s.sideTag = true;
    put(s, 16, 4, 9);
    put(s, 7, 4, 3, 'che');
    put(s, 17, 5, 9, null, true);
    expect(isMoveKingSafe(s, 17, 4, 8)).toBe(true);   // 挡住 ⇒ 合法
    expect(isMoveKingSafe(s, 17, 6, 8)).toBe(false);  // 离开 4 路 ⇒ 送将
  });

  it('暗子兵横走进 4 路挡车同样合法（占位棋种不改变防御的几何性）', () => {
    // 兵已过河（row<5）才可横走；未过河的兵只能直走、永远进不了中路这一段。
    const s = blankJieqi();
    s.sideTag = true;
    put(s, 16, 4, 9);
    put(s, 7, 4, 2, 'che');                 // 黑车 (4,2)，4 路将军
    put(s, 29, 5, 3, null, true);           // 红兵 29：暗子，已过河，在 (5,3)
    expect(isJiangJun(s, 16)[0]).toBe(16);  // 车沿 4 路畅通地将军
    // 横走到 (4,3)：正好填进车帅之间 ⇒ 必须合法
    expect(isMoveKingSafe(s, 29, 4, 3)).toBe(true);
    // 对照：直走 (5,2) 不挡 4 路 ⇒ 送将
    expect(isMoveKingSafe(s, 29, 5, 2)).toBe(false);
  });

  it('真实身份与盘面 id 不一致时，攻击范围按真实身份（双向）', () => {
    // (a) 占位是卒、真身是炮：按盘面 id 算不出攻击，按真实身份隔子将军
    const a = blankJieqi();
    a.sideTag = true;
    put(a, 16, 4, 9);
    put(a, 12, 4, 7);           // 黑卒做炮架（盘面卒 id）
    put(a, 13, 4, 5, 'pao');    // 13 是黑卒位，真身炮 ⇒ 隔 (4,7) 将 (4,9)
    expect(isJiangJun(a, 16)[0]).toBe(16);
    // 帅躲到 (4,8)：仍在炮口（炮隔一子打到 4,9，4,8 是炮与帅之间 ⇒ 挡不住）
    expect(isMoveKingSafe(a, 16, 4, 8)).toBe(false);

    // (b) 占位是车、真身是马：车不能打到同列远处，必须按马算 ⇒ 没被将
    const b = blankJieqi();
    b.sideTag = true;
    put(b, 16, 4, 9);
    put(b, 7, 4, 3, 'ma');      // 7 是黑车位，真身马
    expect(isJiangJun(b, 16)[0]).toBe(-1);           // 马够不着 (4,9) ⇒ 没被将
  });

  it('暗子仍然不是攻击者（回归：本次改动不得放宽这一条）', () => {
    const s = blankJieqi();
    s.sideTag = true;
    put(s, 16, 4, 9);
    put(s, 7, 4, 3, null, true);  // 黑车是**暗子**
    expect(isJiangJun(s, 16)[0]).toBe(-1);
    const pos = s.pieces.map((p: any) => ({ col: p.col, row: p.row, alive: p.alive }));
    expect(afterMoveStillJiangJun(16, 4, 9, 4, 8, s.qiPan, pos, (id: number) => s.hiddenMask[id] === true)).toBe(false);
  });

  it('象棋路径逐字节不变：不传新参数时行为与从前一致', () => {
    const { state } = createJieqiInitialState(makeSeededRand(3));
    // 构造一个纯象棋局面
    const x: any = JSON.parse(JSON.stringify(state));
    x.variant = undefined; x.hiddenMask = undefined; x.revealedType = undefined;
    x.sideTag = true;
    expect(hasAnyLegalMove(x, true)).toBe(true);
    expect(hasAnyLegalMove(x, false)).toBe(true);
  });
});
