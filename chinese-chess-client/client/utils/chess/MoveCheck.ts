/**
 * 走棋规则检查 - 移植自 C# SuanFa/MoveCheck.cs
 * 负责计算每个棋子的合法移动位置
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
  points: boolean[][]
): void {
  for (let i = 0; i < BOARD_COLS; i++) {
    const col = points[i];
    for (let j = 0; j < BOARD_ROWS; j++) {
      col[j] = false;
    }
  }

  if (moveQiZi > 31 || moveQiZi < 0) return;
  if (!piecePositions[moveQiZi].alive) return;

  const col = piecePositions[moveQiZi].col;
  const row = piecePositions[moveQiZi].row;

  switch (moveQiZi) {
    case 7: case 8: case 23: case 24:
      // 车的移动
      calcChe(col, row, moveQiZi, qiPan, points);
      break;
    case 5: case 6: case 21: case 22:
      // 马的移动
      calcMa(col, row, moveQiZi, qiPan, points, piecePositions);
      break;
    case 3: case 4: case 19: case 20:
      // 相/象的移动
      calcXiang(col, row, moveQiZi, qiPan, points);
      break;
    case 1: case 2: case 17: case 18:
      // 士/仕的移动
      calcShi(col, row, moveQiZi, qiPan, points);
      break;
    case 0: case 16:
      // 将/帅的移动
      calcJiang(col, row, moveQiZi, qiPan, points, piecePositions);
      break;
    case 9: case 10: case 25: case 26:
      // 炮的移动
      calcPao(col, row, moveQiZi, qiPan, points);
      break;
    case 11: case 12: case 13: case 14: case 15:
      // 黑卒的移动
      calcHeiZu(col, row, moveQiZi, qiPan, points);
      break;
    case 27: case 28: case 29: case 30: case 31:
      // 红兵的移动
      calcHongBing(col, row, moveQiZi, qiPan, points);
      break;
  }
}

/**
 * 获取棋子可移动的目标位置
 * @param moveQiZi 棋子编号
 * @param qiPan 当前棋盘数据 (9x10)
 * @param piecePositions 所有棋子位置 [{col, row, alive}]
 * @returns 返回 bool 二维数组 [9][10]，true 表示可以移动到该位置
 */
export function getPathPoints(
  moveQiZi: number,
  qiPan: number[][],
  piecePositions: Array<{ col: number; row: number; alive: boolean }>
): boolean[][] {
  const points = createPathPointsBuffer();
  fillPathPoints(moveQiZi, qiPan, piecePositions, points);
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
  points: boolean[][], piecePositions: Array<{ col: number; row: number; alive: boolean }>
) {
  // 检查将帅同列时是否为唯一棋子（蹩马腿的特殊情况）
  if (justOneIsThis(moveQiZi, qiPan, piecePositions)) return;

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

function calcXiang(col: number, row: number, moveQiZi: number, qiPan: number[][], points: boolean[][]) {
  if (justOneIsThis(moveQiZi, qiPan, [])) return;

  let side = 0;
  if (row <= 4) side = 5; // 上方相/象边界 0-4，下方相/象边界 5-9

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

function calcShi(col: number, row: number, moveQiZi: number, qiPan: number[][], points: boolean[][]) {
  if (justOneIsThis(moveQiZi, qiPan, [])) return;

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

function calcJiang(
  col: number, row: number, moveQiZi: number, qiPan: number[][],
  points: boolean[][], piecePositions: Array<{ col: number; row: number; alive: boolean }>
) {
  let side = 0;
  if (row <= 4) side = 7;

  const jiang0Col = piecePositions[0].col;
  const jiang0Row = piecePositions[0].row;
  const jiang16Col = piecePositions[16].col;
  const jiang16Row = piecePositions[16].row;

  // 下方
  if (row !== (9 - side)) {
    if (!isTongBang(moveQiZi, qiPan[col][row + 1])) {
      if (jiang0Col !== jiang16Col) {
        points[col][row + 1] = true;
      } else {
        if (moveQiZi === 0) {
          for (let i = jiang0Row + 2; i < jiang16Row; i++) {
            if (qiPan[col][i] !== -1) { points[col][row + 1] = true; break; }
          }
        }
        if (moveQiZi === 16) {
          points[col][row + 1] = true;
        }
      }
    }
  }
  // 上方
  if (row !== (7 - side)) {
    if (!isTongBang(moveQiZi, qiPan[col][row - 1])) {
      if (jiang0Col !== jiang16Col) {
        points[col][row - 1] = true;
      } else {
        if (moveQiZi === 0) {
          points[col][row - 1] = true;
        }
        if (moveQiZi === 16) {
          for (let i = jiang0Row + 1; i < jiang16Row - 1; i++) {
            if (qiPan[col][i] !== -1) { points[col][row - 1] = true; break; }
          }
        }
      }
    }
  }
  // 左方
  if (col > 3) {
    if (!isTongBang(moveQiZi, qiPan[col - 1][row])) {
      if (((col - 1) === jiang0Col) || ((col - 1) === jiang16Col)) {
        for (let i = jiang0Row + 1; i < jiang16Row; i++) {
          if (qiPan[col - 1][i] !== -1) { points[col - 1][row] = true; break; }
        }
      } else {
        points[col - 1][row] = true;
      }
    }
  }
  // 右方
  if (col < 5) {
    if (!isTongBang(moveQiZi, qiPan[col + 1][row])) {
      if (((col + 1) === jiang0Col) || ((col + 1) === jiang16Col)) {
        for (let i = jiang0Row + 1; i < jiang16Row; i++) {
          if (qiPan[col + 1][i] !== -1) { points[col + 1][row] = true; break; }
        }
      } else {
        points[col + 1][row] = true;
      }
    }
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
  if (row < 9 && !isTongBang(moveQiZi, qiPan[col][row + 1])) {
    points[col][row + 1] = true;
  }
  if (!justOneIsThis(moveQiZi, qiPan, []) && row <= 9 && row > 4) {
    if (col > 0 && !isTongBang(moveQiZi, qiPan[col - 1][row])) points[col - 1][row] = true;
    if (col < 8 && !isTongBang(moveQiZi, qiPan[col + 1][row])) points[col + 1][row] = true;
  }
}

function calcHongBing(col: number, row: number, moveQiZi: number, qiPan: number[][], points: boolean[][]) {
  if (row > 0 && !isTongBang(moveQiZi, qiPan[col][row - 1])) {
    points[col][row - 1] = true;
  }
  if (!justOneIsThis(moveQiZi, qiPan, []) && row >= 0 && row < 5) {
    if (col > 0 && !isTongBang(moveQiZi, qiPan[col - 1][row])) points[col - 1][row] = true;
    if (col < 8 && !isTongBang(moveQiZi, qiPan[col + 1][row])) points[col + 1][row] = true;
  }
}

/**
 * 将帅在同一列时，检查本棋子是否是将帅之间的唯一棋子
 */
function justOneIsThis(
  qiZi: number, qiPan: number[][],
  piecePositions: Array<{ col: number; row: number; alive: boolean }>
): boolean {
  if (piecePositions.length === 0) return false;
  const j0Col = piecePositions[0].col;
  const j0Row = piecePositions[0].row;
  const j16Col = piecePositions[16].col;
  const j16Row = piecePositions[16].row;

  if (j0Col !== j16Col) return false;
  if (piecePositions[qiZi].col !== j0Col) return false;
  if (piecePositions[qiZi].row < j0Row) return false;
  if (piecePositions[qiZi].row > j16Row) return false;

  let count = 0;
  for (let i = j0Row + 1; i < j16Row; i++) {
    if (qiPan[j0Col][i] !== -1) count++;
  }
  return count === 1;
}

/**
 * 在将帅的可移动路径中，排除对方车马炮卒的攻击点
 */
export function isKilledPoint(
  jiangOrShuai: number, col: number, row: number,
  qiPan: number[][], piecePositions: Array<{ col: number; row: number; alive: boolean }>
): boolean {
  const myQiPan = qiPan.map(r => [...r]);
  myQiPan[col][row] = jiangOrShuai;
  myQiPan[piecePositions[jiangOrShuai].col][piecePositions[jiangOrShuai].row] = -1;

  if (jiangOrShuai === 16) {
    for (let qizi = 5; qizi <= 15; qizi++) {
      if (!piecePositions[qizi].alive) continue;
      const thisPoints = getPathPoints(qizi, myQiPan, piecePositions);
      if (thisPoints[col][row]) return true;
    }
  }
  if (jiangOrShuai === 0) {
    for (let qizi = 21; qizi <= 31; qizi++) {
      if (!piecePositions[qizi].alive) continue;
      const thisPoints = getPathPoints(qizi, myQiPan, piecePositions);
      if (thisPoints[col][row]) return true;
    }
  }
  return false;
}

/**
 * 棋子移动到指定位置后，本方是否还被将军
 */
export function afterMoveStillJiangJun(
  qiZi: number, x0: number, y0: number, x1: number, y1: number,
  qiPan: number[][], piecePositions: Array<{ col: number; row: number; alive: boolean }>
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

  for (let i = 0; i < 9; i++) {
    for (let j = 0; j < 10; j++) {
      const localQiZi = myQiPan[i][j];
      if (qiZi > 15) {
        if (localQiZi >= 5 && localQiZi <= 15) {
          if (!piecePositions[localQiZi].alive) continue;
          const thisPoints = getPathPoints(localQiZi, myQiPan, myPositions);
          const x = (qiZi === 16) ? x1 : piecePositions[16].col;
          const y = (qiZi === 16) ? y1 : piecePositions[16].row;
          if (thisPoints[x][y]) return true;
        }
      }
      if (qiZi < 16) {
        if (localQiZi >= 21 && localQiZi <= 31) {
          if (!piecePositions[localQiZi].alive) continue;
          const thisPoints = getPathPoints(localQiZi, myQiPan, myPositions);
          const x = (qiZi === 0) ? x1 : piecePositions[0].col;
          const y = (qiZi === 0) ? y1 : piecePositions[0].row;
          if (thisPoints[x][y]) return true;
        }
      }
    }
  }
  return false;
}
