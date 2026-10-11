/**
 * jieqiFen —— 揭棋 FEN 编解码（纯函数层，零 IO、可单测）
 *
 * ============================================================================
 * 【依据：源码级核实，非二手文档】
 *
 * 引擎 = official-pikafish/Pikafish 分支 `jieqi_old`（commit 23b9466）。
 * 以下事实全部来自读 `src/position.cpp` 的 `Position::set()` 源码：
 *
 *   1. 生效的起始 FEN 是 **5 段**（`src/uci.cpp:45`）：
 *        xxxxkxxxx/…/XXXXKXXXX w R2A2C2P5N2B2r2a2c2p5n2b2 0 1
 *                    ↑棋盘   ↑行棋方 ↑未揭暗子池   ↑半回合 ↑满回合
 *      （`src/benchmark.cpp` 另有 3 段旧格式 `棋盘 池 w`，但解析器按 5 段走，
 *        故本模块只产出 5 段格式。）
 *
 *   2. **池段解析**（`//2.rest` 段）：先遇棋种字符记入 `pt`，
 *      紧随的数字按 `color_of(pt)` 入池，数字被 `std::min(digit, 5)` 截断。
 *      ⇒ **池内顺序完全自由**；单种最多 5 枚；`x`/`X` 在池段被忽略。
 *
 *   3. **棋盘段**的 `x`/`X` 会被映射成该格的**棋位棋种**（`BPiece[s]`），
 *      即「暗子按所在棋位走」是引擎内建行为。
 *
 *   4. **收尾**：`ss >> dummy >> gamePly` —— 第 4 段（半回合）被丢弃，
 *      只有第 5 段（满回合）生效。
 *
 * ⚠️ 本模块**不读** `JieqiIdentity.hiddenType`（暗子真相，铁律 A）：
 * 未翻开的暗子一律输出 `x`/`X`，引擎据此自己按后验推理。
 */

import type { GameState, SideTag } from './types';
import { BOARD_COLS, BOARD_ROWS, RED_SIDE, BLACK_SIDE } from './types';
import { pieceTypeOf, sideOfId } from './jieqi';

/** 揭棋暗子池：一个精确的棋种多重集（引擎要求精确值，不能是分布） */
export interface JieqiDarkPool {
  red: Record<string, number>;
  black: Record<string, number>;
}

/** 空池 */
export function emptyDarkPool(): JieqiDarkPool {
  return {
    red: { R: 0, A: 0, B: 0, N: 0, C: 0, P: 0 },
    black: { r: 0, a: 0, b: 0, n: 0, c: 0, p: 0 },
  };
}

/** 池总数（不变量：应恒等于在盘暗子数） */
export function poolTotal(pool: JieqiDarkPool): number {
  let n = 0;
  for (const k of Object.keys(pool.red)) n += pool.red[k] ?? 0;
  for (const k of Object.keys(pool.black)) n += pool.black[k] ?? 0;
  return n;
}

/** 池是否合法：每种数量非负且 ≤ 5（引擎侧上限） */
export function isPoolValid(pool: JieqiDarkPool): boolean {
  const check = (m: Record<string, number>) =>
    Object.values(m).every((n) => Number.isInteger(n) && n >= 0 && n <= 5);
  return check(pool.red) && check(pool.black);
}

/** 揭棋初始池：每方 车2 马2 炮2 士2 象2 卒/兵5 */
export function initialJieqiPool(): JieqiDarkPool {
  return {
    red: { R: 2, A: 2, B: 2, N: 2, C: 2, P: 5 },
    black: { r: 2, a: 2, b: 2, n: 2, c: 2, p: 5 },
  };
}

/**
 * 池段序列化。
 *
 * ⚠️ 源码事实：引擎解析**顺序自由**（先记字符、后读数字配对），
 * 故理论上任意顺序都可用。这里仍按引擎常量 `R2A2C2P5N2B2…` 的顺序输出，
 * 好处是初始局面能与 `JIEQI_START_POOL` **逐字符对拍**，便于回归定位。
 */
export function serializeDarkPool(pool: JieqiDarkPool): string {
  const order = ['R', 'A', 'C', 'P', 'N', 'B', 'r', 'a', 'c', 'p', 'n', 'b'] as const;
  let out = '';
  for (const ch of order) {
    const n = ch >= 'A' && ch <= 'Z'
      ? pool.red[ch] ?? 0
      : pool.black[ch.toLowerCase()] ?? 0;
    if (n > 0) out += ch + String(n);
  }
  return out;
}

/**
 * 池段反序列化（容错，供读档/校验用）。
 *
 * 数量按引擎同样的 `min(n,5)` 截断。
 *
 * ⚠️ 关于 `x`/`X`：引擎源码里它们会把 `pt` 置为 `NO_PIECE`，随后数字仍会被
 * `push_back(NO_PIECE)` 推入池 —— 这是引擎的无意义行为。
 * 我们**主动跳过**这类 token（本函数不会把 `x`+数字计入任何一侧），
 * 以保证「序列化出去的东西一定是引擎能正确解析的」，避免喂垃圾局面。
 */
export function parseDarkPool(seg: string): JieqiDarkPool {
  const pool = emptyDarkPool();
  let lastCh = '';
  for (const ch of seg) {
    if (/[a-z]/i.test(ch)) {
      // x/X 不是合法的池棋种，直接忽略并清空上下文
      lastCh = ch === 'x' || ch === 'X' ? '' : ch;
      continue;
    }
    if (/\d/.test(ch) && lastCh) {
      const n = Math.min(Number(ch), 5);
      const up = lastCh.toUpperCase();
      const target = lastCh === up ? pool.red : pool.black;
      target[up] = (target[up] ?? 0) + n;
      lastCh = '';
    }
  }
  return pool;
}

/**
 * 棋盘段序列化。
 *
 * - 未翻开暗子 → `x`(黑) / `X`(红)
 * - 已翻开 → 该子的真实棋种字符（revealedType）
 * - 将帅与从未暗置的子 → 标准 FEN 字符
 *
 * 复用 GameEngine 的 FEN_CHARS 约定（id 0..15 小写=黑，16..31 大写=红）。
 */
export function serializeBoard(state: GameState): string {
  const FEN_CHARS = [
    'k', 'a', 'a', 'b', 'b', 'n', 'n', 'r', 'r', 'c', 'c', 'p', 'p', 'p', 'p', 'p',
    'K', 'A', 'A', 'B', 'B', 'N', 'N', 'R', 'R', 'C', 'C', 'P', 'P', 'P', 'P', 'P',
  ];
  // 揭棋棋种 → FEN 字符（红大写 / 黑小写）
  const TYPE_CHAR: Record<string, [string, string]> = {
    che: ['R', 'r'], ma: ['N', 'n'], pao: ['C', 'c'],
    shi: ['A', 'a'], xiang: ['B', 'b'],
    zu: ['', 'p'], bing: ['P', ''],
  };

  let out = '';
  for (let row = 0; row < BOARD_ROWS; row++) {
    let line = '';
    let gap = 0;
    for (let col = 0; col < BOARD_COLS; col++) {
      const id = state.qiPan[col][row];
      if (id === -1) {
        gap++;
        continue;
      }
      if (gap > 0) { line += String(gap); gap = 0; }

      const isHidden = state.hiddenMask?.[id] === true;
      if (isHidden) {
        line += sideOfId(id) === RED_SIDE ? 'X' : 'x';
        continue;
      }
      const rv = state.revealedType?.[id];
      if (rv && state.variant === 'jieqi') {
        const pair = TYPE_CHAR[rv];
        const ch = sideOfId(id) === RED_SIDE ? pair[0] : pair[1];
        line += ch || FEN_CHARS[id];
      } else {
        line += FEN_CHARS[id];
      }
    }
    if (gap > 0) line += String(gap);
    out += line + (row < BOARD_ROWS - 1 ? '/' : '');
  }
  return out;
}

/**
 * 把揭棋局面编码成引擎可解析的 5 段 FEN。
 *
 * ⚠️ **铁律 A**：本函数只读 `hiddenMask` / `revealedType` / `qiPan`，
 * 绝不接触暗子真相（`JieqiIdentity`）。未翻开暗子输出 `x`，符合引擎语义。
 *
 * @param state   当前局面
 * @param pool    引擎视角的未揭暗子池（精确多重集）
 */
export function toJieqiFen(state: GameState, pool: JieqiDarkPool): string {
  if (state.variant !== 'jieqi') {
    throw new Error('toJieqiFen 只接受 variant === "jieqi" 的局面');
  }
  if (!isPoolValid(pool)) {
    throw new Error(`揭棋暗子池非法（每种数量须为 0..5 的整数）: ${JSON.stringify(pool)}`);
  }
  const board = serializeBoard(state);
  const side = state.sideTag === RED_SIDE ? 'w' : 'b';
  const poolSeg = serializeDarkPool(pool);
  // 第 4 段被引擎丢弃，仍按协议给出；第 5 段影响 gamePly，必须正确。
  const halfmove = state.ruleState?.naturalMoveCounter ?? 0;
  const fullmove = Math.floor(state.moveHistory.length / 2) + 1;
  return `${board} ${side} ${poolSeg} ${halfmove} ${fullmove}`;
}

/** 在盘暗子数量（池不变量校验用） */
export function liveHiddenCount(state: GameState): number {
  let n = 0;
  for (let id = 0; id < 32; id++) {
    if (id === 0 || id === 16) continue; // 将帅恒明
    if (!state.pieces[id]?.alive) continue;
    if (state.hiddenMask?.[id] === true) n++;
  }
  return n;
}

/**
 * 校验：池总数必须等于在盘暗子数（源码不变量：每枚暗子揭开时池 -1）。
 * 违反说明确定化簿记有 bug —— 引擎会在错误局面上搜索。
 */
export function assertPoolMatchesBoard(state: GameState, pool: JieqiDarkPool): void {
  const expect = liveHiddenCount(state);
  const got = poolTotal(pool);
  if (expect !== got) {
    throw new Error(`暗子池与盘面不一致：池=${got}，在盘暗子=${expect}`);
  }
}

/** 走棋方 → FEN 段 */
export function sideToFenChar(side: SideTag): string {
  return side === RED_SIDE ? 'w' : 'b';
}

/**
 * 自检：生成的 FEN 第 1 段是否与揭棋初始常量一致（仅 variant=jieqi 初始局面成立）。
 * 供单测与运行时守卫使用。
 */
export const JIEQI_START_BOARD =
  'xxxxkxxxx/9/1x5x1/x1x1x1x1x/9/9/X1X1X1X1X/1X5X1/9/XXXXKXXXX';

export const JIEQI_START_POOL = 'R2A2C2P5N2B2r2a2c2p5n2b2';

export const JIEQI_START_FEN =
  `${JIEQI_START_BOARD} w ${JIEQI_START_POOL} 0 1`;
