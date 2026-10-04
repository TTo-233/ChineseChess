"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// D:\Code\ChineseChess\chinese-chess-client\client\utils\chess\ruleEngine.bundle.ts
var ruleEngine_bundle_exports = {};
__export(ruleEngine_bundle_exports, {
  applyHandicap: () => applyHandicap,
  cloneGameState: () => cloneGameState,
  createInitialState: () => createInitialState,
  getSelectableMovesForParity: () => getSelectableMovesForParity,
  getValidMoves: () => getValidMoves2,
  isMoveBanned: () => isMoveBanned,
  makeMove: () => makeMove
});
module.exports = __toCommonJS(ruleEngine_bundle_exports);

// chinese-chess-client/client/utils/chess/types.ts
var BLACK_SIDE = false;
var RED_SIDE = true;
var QIZI_INIT_POSITION = [
  [4, 0],
  [3, 0],
  [5, 0],
  [2, 0],
  [6, 0],
  [1, 0],
  [7, 0],
  [0, 0],
  [8, 0],
  [1, 2],
  [7, 2],
  [0, 3],
  [2, 3],
  [4, 3],
  [6, 3],
  [8, 3],
  [4, 9],
  [3, 9],
  [5, 9],
  [2, 9],
  [6, 9],
  [1, 9],
  [7, 9],
  [0, 9],
  [8, 9],
  [1, 7],
  [7, 7],
  [0, 6],
  [2, 6],
  [4, 6],
  [6, 6],
  [8, 6]
];
var BOARD_COLS = 9;
var BOARD_ROWS = 10;

// chinese-chess-client/client/utils/chess/MoveCheck.ts
function isTongBang(qz1, qz2) {
  return qz1 >= 0 && qz2 >= 0 && (qz1 <= 15 && qz2 <= 15 || qz1 >= 16 && qz2 >= 16);
}
function createPathPointsBuffer() {
  const points = [];
  for (let i = 0; i < BOARD_COLS; i++) {
    const col = [];
    for (let j = 0; j < BOARD_ROWS; j++) {
      col[j] = false;
    }
    points[i] = col;
  }
  return points;
}
function fillPathPoints(moveQiZi, qiPan, piecePositions, points) {
  for (let i = 0; i < BOARD_COLS; i++) {
    const col2 = points[i];
    for (let j = 0; j < BOARD_ROWS; j++) {
      col2[j] = false;
    }
  }
  if (moveQiZi > 31 || moveQiZi < 0) return;
  if (!piecePositions[moveQiZi].alive) return;
  const col = piecePositions[moveQiZi].col;
  const row = piecePositions[moveQiZi].row;
  switch (moveQiZi) {
    case 7:
    case 8:
    case 23:
    case 24:
      calcChe(col, row, moveQiZi, qiPan, points);
      break;
    case 5:
    case 6:
    case 21:
    case 22:
      calcMa(col, row, moveQiZi, qiPan, points);
      break;
    case 3:
    case 4:
    case 19:
    case 20:
      calcXiang(col, row, moveQiZi, qiPan, points);
      break;
    case 1:
    case 2:
    case 17:
    case 18:
      calcShi(col, row, moveQiZi, qiPan, points);
      break;
    case 0:
    case 16:
      calcJiang(col, row, moveQiZi, qiPan, points);
      break;
    case 9:
    case 10:
    case 25:
    case 26:
      calcPao(col, row, moveQiZi, qiPan, points);
      break;
    case 11:
    case 12:
    case 13:
    case 14:
    case 15:
      calcHeiZu(col, row, moveQiZi, qiPan, points);
      break;
    case 27:
    case 28:
    case 29:
    case 30:
    case 31:
      calcHongBing(col, row, moveQiZi, qiPan, points);
      break;
  }
}
function getPathPoints(moveQiZi, qiPan, piecePositions) {
  const points = createPathPointsBuffer();
  fillPathPoints(moveQiZi, qiPan, piecePositions, points);
  return points;
}
function calcChe(col, row, moveQiZi, qiPan, points) {
  for (let i = col - 1; i >= 0; i--) {
    if (qiPan[i][row] === -1) {
      points[i][row] = true;
    } else {
      if (!isTongBang(moveQiZi, qiPan[i][row])) points[i][row] = true;
      break;
    }
  }
  for (let i = col + 1; i <= 8; i++) {
    if (qiPan[i][row] === -1) {
      points[i][row] = true;
    } else {
      if (!isTongBang(moveQiZi, qiPan[i][row])) points[i][row] = true;
      break;
    }
  }
  for (let i = row - 1; i >= 0; i--) {
    if (qiPan[col][i] === -1) {
      points[col][i] = true;
    } else {
      if (!isTongBang(moveQiZi, qiPan[col][i])) points[col][i] = true;
      break;
    }
  }
  for (let i = row + 1; i <= 9; i++) {
    if (qiPan[col][i] === -1) {
      points[col][i] = true;
    } else {
      if (!isTongBang(moveQiZi, qiPan[col][i])) points[col][i] = true;
      break;
    }
  }
}
function calcMa(col, row, moveQiZi, qiPan, points) {
  if (row > 1 && qiPan[col][row - 1] === -1) {
    if (col > 0 && !isTongBang(moveQiZi, qiPan[col - 1][row - 2])) points[col - 1][row - 2] = true;
    if (col < 8 && !isTongBang(moveQiZi, qiPan[col + 1][row - 2])) points[col + 1][row - 2] = true;
  }
  if (row < 8 && qiPan[col][row + 1] === -1) {
    if (col > 0 && !isTongBang(moveQiZi, qiPan[col - 1][row + 2])) points[col - 1][row + 2] = true;
    if (col < 8 && !isTongBang(moveQiZi, qiPan[col + 1][row + 2])) points[col + 1][row + 2] = true;
  }
  if (col > 1 && qiPan[col - 1][row] === -1) {
    if (row > 0 && !isTongBang(moveQiZi, qiPan[col - 2][row - 1])) points[col - 2][row - 1] = true;
    if (row < 9 && !isTongBang(moveQiZi, qiPan[col - 2][row + 1])) points[col - 2][row + 1] = true;
  }
  if (col < 7 && qiPan[col + 1][row] === -1) {
    if (row > 0 && !isTongBang(moveQiZi, qiPan[col + 2][row - 1])) points[col + 2][row - 1] = true;
    if (row < 9 && !isTongBang(moveQiZi, qiPan[col + 2][row + 1])) points[col + 2][row + 1] = true;
  }
}
function calcXiang(col, row, moveQiZi, qiPan, points) {
  let side = 0;
  if (row <= 4) side = 5;
  if (row !== 9 - side) {
    if (col > 0 && qiPan[col - 1][row + 1] === -1 && !isTongBang(moveQiZi, qiPan[col - 2][row + 2])) {
      points[col - 2][row + 2] = true;
    }
    if (col < 8 && qiPan[col + 1][row + 1] === -1 && !isTongBang(moveQiZi, qiPan[col + 2][row + 2])) {
      points[col + 2][row + 2] = true;
    }
  }
  if (row !== 5 - side) {
    if (col > 0 && qiPan[col - 1][row - 1] === -1 && !isTongBang(moveQiZi, qiPan[col - 2][row - 2])) {
      points[col - 2][row - 2] = true;
    }
    if (col < 8 && qiPan[col + 1][row - 1] === -1 && !isTongBang(moveQiZi, qiPan[col + 2][row - 2])) {
      points[col + 2][row - 2] = true;
    }
  }
}
function calcShi(col, row, moveQiZi, qiPan, points) {
  let side = 0;
  if (row <= 4) side = 7;
  if (row !== 9 - side) {
    if (col > 3 && !isTongBang(moveQiZi, qiPan[col - 1][row + 1])) points[col - 1][row + 1] = true;
    if (col < 5 && !isTongBang(moveQiZi, qiPan[col + 1][row + 1])) points[col + 1][row + 1] = true;
  }
  if (row !== 7 - side) {
    if (col > 3 && !isTongBang(moveQiZi, qiPan[col - 1][row - 1])) points[col - 1][row - 1] = true;
    if (col < 5 && !isTongBang(moveQiZi, qiPan[col + 1][row - 1])) points[col + 1][row - 1] = true;
  }
}
function calcJiang(col, row, moveQiZi, qiPan, points) {
  let side = 0;
  if (row <= 4) side = 7;
  if (row !== 9 - side && !isTongBang(moveQiZi, qiPan[col][row + 1])) {
    points[col][row + 1] = true;
  }
  if (row !== 7 - side && !isTongBang(moveQiZi, qiPan[col][row - 1])) {
    points[col][row - 1] = true;
  }
  if (col > 3 && !isTongBang(moveQiZi, qiPan[col - 1][row])) {
    points[col - 1][row] = true;
  }
  if (col < 5 && !isTongBang(moveQiZi, qiPan[col + 1][row])) {
    points[col + 1][row] = true;
  }
}
function calcPao(col, row, moveQiZi, qiPan, points) {
  let gezi = 0;
  for (let i = col - 1; i >= 0; i--) {
    if (qiPan[i][row] === -1) {
      if (gezi === 0) points[i][row] = true;
    } else {
      if (!isTongBang(moveQiZi, qiPan[i][row]) && gezi === 1) points[i][row] = true;
      gezi++;
    }
  }
  gezi = 0;
  for (let i = col + 1; i <= 8; i++) {
    if (qiPan[i][row] === -1) {
      if (gezi === 0) points[i][row] = true;
    } else {
      if (!isTongBang(moveQiZi, qiPan[i][row]) && gezi === 1) points[i][row] = true;
      gezi++;
    }
  }
  gezi = 0;
  for (let i = row - 1; i >= 0; i--) {
    if (qiPan[col][i] === -1) {
      if (gezi === 0) points[col][i] = true;
    } else {
      if (!isTongBang(moveQiZi, qiPan[col][i]) && gezi === 1) points[col][i] = true;
      gezi++;
    }
  }
  gezi = 0;
  for (let i = row + 1; i <= 9; i++) {
    if (qiPan[col][i] === -1) {
      if (gezi === 0) points[col][i] = true;
    } else {
      if (!isTongBang(moveQiZi, qiPan[col][i]) && gezi === 1) points[col][i] = true;
      gezi++;
    }
  }
}
function calcHeiZu(col, row, moveQiZi, qiPan, points) {
  if (row < 9 && !isTongBang(moveQiZi, qiPan[col][row + 1])) {
    points[col][row + 1] = true;
  }
  if (row > 4) {
    if (col > 0 && !isTongBang(moveQiZi, qiPan[col - 1][row])) points[col - 1][row] = true;
    if (col < 8 && !isTongBang(moveQiZi, qiPan[col + 1][row])) points[col + 1][row] = true;
  }
}
function calcHongBing(col, row, moveQiZi, qiPan, points) {
  if (row > 0 && !isTongBang(moveQiZi, qiPan[col][row - 1])) {
    points[col][row - 1] = true;
  }
  if (row < 5) {
    if (col > 0 && !isTongBang(moveQiZi, qiPan[col - 1][row])) points[col - 1][row] = true;
    if (col < 8 && !isTongBang(moveQiZi, qiPan[col + 1][row])) points[col + 1][row] = true;
  }
}
function afterMoveStillJiangJun(qiZi, x0, y0, x1, y1, qiPan, piecePositions) {
  const myQiPan = qiPan.map((r) => [...r]);
  myQiPan[x1][y1] = qiZi;
  myQiPan[x0][y0] = -1;
  const myPositions = piecePositions.map((p, i) => {
    if (i === qiZi) return { col: x1, row: y1, alive: p.alive };
    return { ...p };
  });
  let jiang0Col = -1, jiang0Row = -1, shuai16Col = -1, shuai16Row = -1;
  for (let c = 0; c < 9; c++) {
    for (let r = 0; r < 10; r++) {
      if (myQiPan[c][r] === 0) {
        jiang0Col = c;
        jiang0Row = r;
      } else if (myQiPan[c][r] === 16) {
        shuai16Col = c;
        shuai16Row = r;
      }
    }
  }
  if (jiang0Col >= 0 && shuai16Col >= 0 && jiang0Col === shuai16Col) {
    let blocked = false;
    const top = Math.min(jiang0Row, shuai16Row);
    const bottom = Math.max(jiang0Row, shuai16Row);
    for (let r = top + 1; r < bottom; r++) {
      if (myQiPan[jiang0Col][r] !== -1) {
        blocked = true;
        break;
      }
    }
    if (!blocked) return true;
  }
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
          if (!(qiZi === 16) && shuaiOffBoard) continue;
          const thisPoints = getPathPoints(localQiZi, myQiPan, myPositions);
          const x = qiZi === 16 ? x1 : shuai.col;
          const y = qiZi === 16 ? y1 : shuai.row;
          if (thisPoints[x][y]) return true;
        }
      }
      if (qiZi < 16) {
        if (localQiZi >= 21 && localQiZi <= 31) {
          if (!piecePositions[localQiZi].alive) continue;
          if (qiZi !== 0 && jiangOffBoard) continue;
          const thisPoints = getPathPoints(localQiZi, myQiPan, myPositions);
          const x = qiZi === 0 ? x1 : jiang.col;
          const y = qiZi === 0 ? y1 : jiang.row;
          if (thisPoints[x][y]) return true;
        }
      }
    }
  }
  return false;
}

// chinese-chess-client/client/utils/chess/RuleEngine.ts
var RULE_CONFIG = {
  /** 长将允许回合数：按参与长将的子力数量（1 子 / 2 子 / 3 子及以上，规则二.3） */
  longCheckByPieceCount: [6, 12, 18],
  /** 长捉对方子允许回合数（规则二.1） */
  longChase: 6,
  /** 将捉交替允许回合数：一子 / 一子以上（规则二.4） */
  checkChaseByPieceCount: [12, 18],
  /** 非将非应将非捉非应捉局面重复判和次数（规则一.2） */
  repetitionDraw: 5,
  /** 互相长将判和阈值（双方各自长将达到该回合数，规则一.3） */
  mutualLongCheckDraw: 6,
  /** 互相长捉判和阈值（规则一.4） */
  mutualLongChaseDraw: 6,
  /** 自然限招：无吃子着数上限（规则一.5：双方无吃子 120 步 = 60 回合） */
  naturalMoveLimit: 120,
  /** 自然限招窗口内**单方**累计将军上限（规则一.5：双方各自最多只累计 10 次将军） */
  checkCountLimitPerSide: 10,
  /** 双方累计总着数上限（规则一.6：总步数 400 步 = 200 回合） */
  totalMoveLimit: 400
};
function sideOfPiece(id) {
  return id <= 15 ? BLACK_SIDE : RED_SIDE;
}
function isJiangShuai(id) {
  return id === 0 || id === 16;
}
function isChe(id) {
  return id === 7 || id === 8 || id === 23 || id === 24;
}
function isPao(id) {
  return id === 9 || id === 10 || id === 25 || id === 26;
}
function isBingZu(id) {
  return id >= 11 && id <= 15 || id >= 27 && id <= 31;
}
function samePieceType(a, b) {
  const t = (id) => isJiangShuai(id) ? "k" : isChe(id) ? "r" : isPao(id) ? "c" : isBingZu(id) ? "p" : id === 5 || id === 6 || id === 21 || id === 22 ? "n" : id === 3 || id === 4 || id === 19 || id === 20 ? "b" : "a";
  return t(a) === t(b);
}
function hasCrossedRiver(id, row) {
  return id <= 15 ? row >= 5 : row <= 4;
}
function sideKey(side) {
  return side === RED_SIDE ? "red" : "black";
}
function toPositions(state) {
  return state.pieces.map((p) => ({ col: p.col, row: p.row, alive: p.alive }));
}
function positionKey(state) {
  let key = "";
  for (let i = 0; i < 32; i++) {
    const p = state.pieces[i];
    if (p.alive) key += `${i}:${p.col}${p.row};`;
  }
  return key + (state.sideTag === RED_SIDE ? "w" : "b");
}
function isSideInCheck(state, side) {
  const kingId = side === RED_SIDE ? 16 : 0;
  const king = state.pieces[kingId];
  if (!king.alive) return false;
  const positions = toPositions(state);
  const enemyStart = side === RED_SIDE ? 5 : 21;
  const enemyEnd = side === RED_SIDE ? 16 : 32;
  for (let id = enemyStart; id < enemyEnd; id++) {
    if (!state.pieces[id].alive) continue;
    const pts = getPathPoints(id, state.qiPan, positions);
    if (pts[king.col][king.row]) return true;
  }
  return false;
}
function enumerateLegalMoves(state, side) {
  const moves = [];
  const positions = toPositions(state);
  const start = side === RED_SIDE ? 16 : 0;
  const end = side === RED_SIDE ? 32 : 16;
  for (let id = start; id < end; id++) {
    const piece = state.pieces[id];
    if (!piece.alive) continue;
    const pts = getPathPoints(id, state.qiPan, positions);
    for (let c = 0; c < BOARD_COLS; c++) {
      for (let r = 0; r < BOARD_ROWS; r++) {
        if (!pts[c][r]) continue;
        if (c === piece.col && r === piece.row) continue;
        if (afterMoveStillJiangJun(id, piece.col, piece.row, c, r, state.qiPan, positions)) continue;
        moves.push({ pieceId: id, fromCol: piece.col, fromRow: piece.row, toCol: c, toRow: r });
      }
    }
  }
  return moves;
}
function simulateMove(state, pieceId, toCol, toRow) {
  const next = {
    qiPan: state.qiPan.map((r) => [...r]),
    pieces: state.pieces.map((p) => ({ ...p })),
    sideTag: !state.sideTag,
    moveHistory: [...state.moveHistory],
    gameStatus: "playing",
    isCheck: false,
    checkMessage: "",
    zobristHash: 0,
    ruleState: state.ruleState
  };
  const piece = next.pieces[pieceId];
  const captured = next.qiPan[toCol][toRow];
  next.qiPan[piece.col][piece.row] = -1;
  next.qiPan[toCol][toRow] = pieceId;
  piece.col = toCol;
  piece.row = toRow;
  if (captured !== -1) next.pieces[captured].alive = false;
  next.isCheck = isSideInCheck(next, next.sideTag);
  return next;
}
function isPinnedMove(state, pieceId, toCol, toRow) {
  const positions = toPositions(state);
  const p = state.pieces[pieceId];
  return afterMoveStillJiangJun(pieceId, p.col, p.row, toCol, toRow, state.qiPan, positions);
}
function attackersOf(state, attackSide, col, row) {
  const positions = toPositions(state);
  const result = [];
  const start = attackSide === RED_SIDE ? 16 : 0;
  const end = attackSide === RED_SIDE ? 32 : 16;
  for (let id = start; id < end; id++) {
    if (!state.pieces[id].alive) continue;
    const pts = getPathPoints(id, state.qiPan, positions);
    if (pts[col][row]) result.push(id);
  }
  return result;
}
function targetHasRealRoot(state, targetId, attackerId) {
  const t = state.pieces[targetId];
  const sim = simulateMove(state, attackerId, t.col, t.row);
  const defenderSide = sideOfPiece(targetId);
  const a = sim.pieces[attackerId];
  const guards = attackersOf(sim, defenderSide, a.col, a.row).filter((id) => id !== targetId);
  for (const g of guards) {
    if (!isPinnedMove(sim, g, a.col, a.row)) return true;
  }
  return false;
}
function isSacrificeExchange(state, attackerId, targetId) {
  if (!samePieceType(attackerId, targetId)) return false;
  const defenderSide = sideOfPiece(targetId);
  const a = state.pieces[attackerId];
  const t = state.pieces[targetId];
  if (!attackersOf(state, defenderSide, a.col, a.row).includes(targetId)) return false;
  if (isPinnedMove(state, attackerId, t.col, t.row)) return false;
  if (isPinnedMove(state, targetId, a.col, a.row)) return false;
  return true;
}
function isPiecePinned(state, targetId) {
  const positions = toPositions(state);
  const t = state.pieces[targetId];
  const pts = getPathPoints(targetId, state.qiPan, positions);
  for (let c = 0; c < BOARD_COLS; c++) {
    for (let r = 0; r < BOARD_ROWS; r++) {
      if (!pts[c][r]) continue;
      if (c === t.col && r === t.row) continue;
      if (!afterMoveStillJiangJun(targetId, t.col, t.row, c, r, state.qiPan, positions)) {
        return false;
      }
    }
  }
  return true;
}
function detectZhuo(state, moverSide) {
  const enemySide = !moverSide;
  const enemyStart = enemySide === RED_SIDE ? 16 : 0;
  const enemyEnd = enemySide === RED_SIDE ? 32 : 16;
  const results = [];
  const positions = toPositions(state);
  const myPoints = /* @__PURE__ */ new Map();
  const myStart = moverSide === RED_SIDE ? 16 : 0;
  const myEnd = moverSide === RED_SIDE ? 32 : 16;
  for (let id = myStart; id < myEnd; id++) {
    if (!state.pieces[id].alive) continue;
    myPoints.set(id, getPathPoints(id, state.qiPan, positions));
  }
  for (let targetId = enemyStart; targetId < enemyEnd; targetId++) {
    const t = state.pieces[targetId];
    if (!t.alive) continue;
    if (isJiangShuai(targetId)) continue;
    if (isBingZu(targetId) && !hasCrossedRiver(targetId, t.row)) continue;
    const attackers = [];
    for (const [id, pts] of myPoints) {
      if (pts[t.col][t.row]) attackers.push(id);
    }
    if (attackers.length === 0) continue;
    let effective = attackers.filter((id) => !isBingZu(id) && !isJiangShuai(id));
    if (effective.length === 0) continue;
    if (isChe(targetId) && effective.every(isPao)) continue;
    effective = effective.filter((id) => !isSacrificeExchange(state, id, targetId));
    if (effective.length === 0) continue;
    if (isPiecePinned(state, targetId)) {
      results.push(targetId);
      continue;
    }
    let chased = false;
    for (const attackerId of effective) {
      if (!targetHasRealRoot(state, targetId, attackerId)) {
        chased = true;
        break;
      }
    }
    if (chased) results.push(targetId);
  }
  return results;
}
function emptySideCounters() {
  return {
    jiangCount: 0,
    jiangPieceIds: [],
    zhuoCounts: {},
    jiangZhuoLoop: 0,
    jiangZhuoPieceIds: [],
    opponentCheckedDuringRun: false,
    checkCountInWindow: 0
  };
}
function createInitialRuleState(state) {
  return {
    red: emptySideCounters(),
    black: emptySideCounters(),
    positionKeys: [positionKey(state)],
    naturalMoveCounter: 0,
    banActive: false,
    banSide: null,
    banReason: null,
    banChaseTargets: [],
    banMoves: [],
    notice: null,
    noticeKey: null
  };
}
function cloneSideCounters(s) {
  return {
    jiangCount: s.jiangCount,
    jiangPieceIds: [...s.jiangPieceIds],
    zhuoCounts: { ...s.zhuoCounts },
    jiangZhuoLoop: s.jiangZhuoLoop,
    jiangZhuoPieceIds: [...s.jiangZhuoPieceIds],
    opponentCheckedDuringRun: s.opponentCheckedDuringRun,
    checkCountInWindow: s.checkCountInWindow
  };
}
function cloneRuleState(r) {
  return {
    red: cloneSideCounters(r.red),
    black: cloneSideCounters(r.black),
    positionKeys: [...r.positionKeys],
    naturalMoveCounter: r.naturalMoveCounter,
    banActive: r.banActive,
    banSide: r.banSide,
    banReason: r.banReason,
    banChaseTargets: [...r.banChaseTargets],
    banMoves: r.banMoves.map((m) => ({ ...m })),
    notice: r.notice,
    noticeKey: r.noticeKey
  };
}
function resetSideCounters(s) {
  s.jiangCount = 0;
  s.jiangPieceIds = [];
  s.zhuoCounts = {};
  s.jiangZhuoLoop = 0;
  s.jiangZhuoPieceIds = [];
  s.opponentCheckedDuringRun = false;
}
function longCheckLimit(pieceCount) {
  return pieceCount <= 1 ? RULE_CONFIG.longCheckByPieceCount[0] : pieceCount === 2 ? RULE_CONFIG.longCheckByPieceCount[1] : RULE_CONFIG.longCheckByPieceCount[2];
}
function checkChaseLimit(pieceCount) {
  return pieceCount <= 1 ? RULE_CONFIG.checkChaseByPieceCount[0] : RULE_CONFIG.checkChaseByPieceCount[1];
}
function buildBanMoves(state, banSide, banReason, chaseTargets) {
  const bans = [];
  for (const mv of enumerateLegalMoves(state, banSide)) {
    const after = simulateMove(state, mv.pieceId, mv.toCol, mv.toRow);
    let banned = false;
    if (banReason === "LONG_CHECK") {
      banned = after.isCheck;
    } else if (banReason === "LONG_CHASE") {
      banned = detectZhuo(after, banSide).some((id) => chaseTargets.includes(id));
    } else {
      banned = after.isCheck || detectZhuo(after, banSide).length > 0;
    }
    if (banned) bans.push({ ...mv, reason: banReason });
  }
  return bans;
}
function isMoveBanned(state, pieceId, toCol, toRow) {
  const rs = state.ruleState;
  if (!rs || !rs.banActive || rs.banReason == null) return false;
  if (state.sideTag !== rs.banSide) return false;
  return rs.banMoves.some((m) => m.pieceId === pieceId && m.toCol === toCol && m.toRow === toRow);
}
function maxZhuoCount(s) {
  let max = 0;
  for (const k of Object.keys(s.zhuoCounts)) {
    if (s.zhuoCounts[k] > max) max = s.zhuoCounts[k];
  }
  return max;
}
function hasAttackingPieces(state, side) {
  const start = side === RED_SIDE ? 16 : 0;
  const end = side === RED_SIDE ? 32 : 16;
  for (let id = start; id < end; id++) {
    if (!state.pieces[id].alive) continue;
    if (isJiangShuai(id)) continue;
    if (id === 1 || id === 2 || id === 17 || id === 18) continue;
    if (id === 3 || id === 4 || id === 19 || id === 20) continue;
    return true;
  }
  return false;
}
function finish(rs, gameOver, reason, loser) {
  if (gameOver) {
    rs.banActive = false;
    rs.banSide = null;
    rs.banReason = null;
    rs.banChaseTargets = [];
    rs.banMoves = [];
  }
  return { ruleState: rs, gameOver, gameOverReason: reason, loser };
}
function evaluateRuleAfterMove(beforeState, afterState, move) {
  const moverSide = sideOfPiece(move.pieceId);
  const opponentSide = !moverSide;
  const isCheck = afterState.isCheck;
  const wasRespondingCheck = beforeState.isCheck;
  const rs = beforeState.ruleState ? cloneRuleState(beforeState.ruleState) : createInitialRuleState(beforeState);
  rs.notice = null;
  rs.noticeKey = null;
  const mover = rs[sideKey(moverSide)];
  const opponent = rs[sideKey(opponentSide)];
  const zhuoList = isCheck ? [] : detectZhuo(afterState, moverSide);
  if (move.captured !== -1) {
    resetSideCounters(mover);
    resetSideCounters(opponent);
    rs.naturalMoveCounter = 0;
    mover.checkCountInWindow = 0;
    opponent.checkCountInWindow = 0;
  } else if (isCheck) {
    mover.jiangCount += 1;
    if (!mover.jiangPieceIds.includes(move.pieceId)) mover.jiangPieceIds.push(move.pieceId);
    mover.jiangZhuoLoop += 1;
    if (!mover.jiangZhuoPieceIds.includes(move.pieceId)) mover.jiangZhuoPieceIds.push(move.pieceId);
    mover.zhuoCounts = {};
    mover.checkCountInWindow += 1;
    if (opponent.jiangCount > 0) {
      opponent.opponentCheckedDuringRun = true;
    }
  } else if (zhuoList.length > 0) {
    mover.jiangCount = 0;
    mover.jiangPieceIds = [];
    mover.jiangZhuoLoop += 1;
    if (!mover.jiangZhuoPieceIds.includes(move.pieceId)) mover.jiangZhuoPieceIds.push(move.pieceId);
    if (wasRespondingCheck) {
    } else {
      const next = {};
      for (const targetId of zhuoList) {
        next[String(targetId)] = (mover.zhuoCounts[String(targetId)] ?? 0) + 1;
      }
      mover.zhuoCounts = next;
    }
  } else {
    resetSideCounters(mover);
  }
  const currentKey = positionKey(afterState);
  rs.positionKeys.push(currentKey);
  if (move.captured === -1) rs.naturalMoveCounter += 1;
  const totalMoves = afterState.moveHistory.length;
  if (!hasAttackingPieces(afterState, RED_SIDE) && !hasAttackingPieces(afterState, BLACK_SIDE)) {
    return finish(rs, true, "no_attacking", null);
  }
  if (totalMoves >= RULE_CONFIG.totalMoveLimit) {
    return finish(rs, true, "total_limit", null);
  }
  if (rs.naturalMoveCounter >= RULE_CONFIG.naturalMoveLimit) {
    return finish(rs, true, "natural_limit", null);
  }
  if (mover.checkCountInWindow >= RULE_CONFIG.checkCountLimitPerSide || opponent.checkCountInWindow >= RULE_CONFIG.checkCountLimitPerSide) {
    return finish(rs, true, "natural_limit", null);
  }
  if (rs.red.jiangCount >= RULE_CONFIG.mutualLongCheckDraw && rs.black.jiangCount >= RULE_CONFIG.mutualLongCheckDraw) {
    return finish(rs, true, "mutual_long_check", null);
  }
  if (maxZhuoCount(rs.red) >= RULE_CONFIG.mutualLongChaseDraw && maxZhuoCount(rs.black) >= RULE_CONFIG.mutualLongChaseDraw) {
    return finish(rs, true, "mutual_long_chase", null);
  }
  if (!isCheck && !wasRespondingCheck && zhuoList.length === 0) {
    let repetition = 1;
    for (let i = rs.positionKeys.length - 2; i >= 0; i--) {
      if (rs.positionKeys[i] === currentKey) repetition++;
    }
    if (repetition >= RULE_CONFIG.repetitionDraw) {
      return finish(rs, true, "repetition", null);
    }
  }
  if (isCheck && mover.jiangCount >= RULE_CONFIG.longCheckByPieceCount[0] && mover.opponentCheckedDuringRun && opponent.jiangCount < RULE_CONFIG.mutualLongCheckDraw - 1) {
    return finish(rs, true, "changjiang", moverSide);
  }
  const tryBan = (side) => {
    const c = rs[sideKey(side)];
    const opp = rs[sideKey(!side)];
    if (c.jiangCount >= longCheckLimit(c.jiangPieceIds.length)) {
      if (opp.jiangCount < RULE_CONFIG.mutualLongCheckDraw - 1) {
        return { reason: "LONG_CHECK", targets: [] };
      }
      return null;
    }
    const targets = Object.keys(c.zhuoCounts).filter((k) => c.zhuoCounts[k] >= RULE_CONFIG.longChase).map((k) => Number(k));
    if (targets.length > 0) {
      if (maxZhuoCount(opp) < RULE_CONFIG.mutualLongChaseDraw - 1) {
        return { reason: "LONG_CHASE", targets };
      }
      return null;
    }
    if (c.jiangZhuoLoop >= checkChaseLimit(c.jiangZhuoPieceIds.length)) {
      return { reason: "CHECK_CHASE", targets: [] };
    }
    return null;
  };
  const moverBan = tryBan(moverSide);
  const oppBan = tryBan(opponentSide);
  let hit = moverBan ?? oppBan;
  let hitSide = moverBan ? moverSide : opponentSide;
  if (moverBan && oppBan) {
    const moverIsCheckish = moverBan.reason === "LONG_CHECK" || moverBan.reason === "CHECK_CHASE";
    const oppIsCheckish = oppBan.reason === "LONG_CHECK" || oppBan.reason === "CHECK_CHASE";
    const isOpposed = (a, b) => a.reason !== "LONG_CHASE" && b.reason === "LONG_CHASE" || a.reason === "LONG_CHASE" && b.reason !== "LONG_CHASE";
    if (moverIsCheckish && !oppIsCheckish && isOpposed(moverBan, oppBan)) {
      hit = moverBan;
      hitSide = moverSide;
    } else if (oppIsCheckish && !moverIsCheckish && isOpposed(moverBan, oppBan)) {
      hit = oppBan;
      hitSide = opponentSide;
    }
  }
  const banName = (reason) => reason === "LONG_CHECK" ? "\u957F\u5C06" : reason === "LONG_CHASE" ? "\u957F\u6349" : "\u5C06\u6349\u4EA4\u66FF";
  if (hit) {
    rs.banActive = true;
    rs.banSide = hitSide;
    rs.banReason = hit.reason;
    rs.banChaseTargets = hit.targets;
    rs.banMoves = buildBanMoves(afterState, hitSide, hit.reason, hit.targets);
  } else {
    rs.banActive = false;
    rs.banSide = null;
    rs.banReason = null;
    rs.banChaseTargets = [];
    rs.banMoves = [];
  }
  const noticeFor = (side) => {
    const c = rs[sideKey(side)];
    const other = rs[sideKey(!side)];
    if (totalMoves === RULE_CONFIG.totalMoveLimit - 1) {
      return { text: `\u53CC\u65B9\u5DF2\u8D70 ${totalMoves} \u6B65\uFF0C\u4E0B\u7740\u5C06\u6EE1 ${RULE_CONFIG.totalMoveLimit} \u6B65\u5224\u548C`, key: `total-${totalMoves}` };
    }
    if (rs.naturalMoveCounter === RULE_CONFIG.naturalMoveLimit - 1) {
      return { text: `\u5DF2 ${rs.naturalMoveCounter} \u6B65\u65E0\u5403\u5B50\uFF0C\u4E0B\u7740\u5C06\u6EE1 ${RULE_CONFIG.naturalMoveLimit} \u6B65\u5224\u548C`, key: `natural-${rs.naturalMoveCounter}` };
    }
    if (c.checkCountInWindow === RULE_CONFIG.checkCountLimitPerSide - 1 || other.checkCountInWindow === RULE_CONFIG.checkCountLimitPerSide - 1) {
      const n = Math.max(c.checkCountInWindow, other.checkCountInWindow);
      return { text: `\u6709\u4E00\u65B9\u5DF2\u5C06\u519B ${n} \u6B21\uFF0C\u4E0B\u7740\u518D\u5C06\u519B\u5C06\u6EE1 ${RULE_CONFIG.checkCountLimitPerSide} \u6B21\u5224\u548C`, key: `chkwin-${n}` };
    }
    if (c.jiangCount === RULE_CONFIG.mutualLongCheckDraw - 1 && other.jiangCount >= RULE_CONFIG.mutualLongCheckDraw - 1) {
      return { text: `\u53CC\u65B9\u957F\u5C06\u5DF2\u8FBE ${RULE_CONFIG.mutualLongCheckDraw - 1} \u6B21\uFF0C\u53CC\u65B9\u7EE7\u7EED\u957F\u5C06\u5C06\u5224\u548C`, key: `mutualcheck-${c.jiangCount}-${other.jiangCount}` };
    }
    const cMax = maxZhuoCount(c);
    const otherMax = maxZhuoCount(other);
    if (cMax === RULE_CONFIG.mutualLongChaseDraw - 1 && otherMax >= RULE_CONFIG.mutualLongChaseDraw - 1) {
      return { text: `\u53CC\u65B9\u957F\u6349\u5DF2\u8FBE ${RULE_CONFIG.mutualLongChaseDraw - 1} \u6B21\uFF0C\u53CC\u65B9\u7EE7\u7EED\u957F\u6349\u5C06\u5224\u548C`, key: `mutualzhuo-${cMax}-${otherMax}` };
    }
    if (!isCheck && !wasRespondingCheck && zhuoList.length === 0) {
      let seen = 0;
      for (let i = 0; i < rs.positionKeys.length - 1; i++) {
        if (rs.positionKeys[i] === currentKey) seen++;
      }
      if (seen === RULE_CONFIG.repetitionDraw - 2) {
        return { text: `\u672C\u5C40\u9762\u5DF2\u51FA\u73B0 ${seen + 1} \u6B21\uFF0C\u4E0B\u7740\u91CD\u590D\u5C06\u5224\u548C`, key: `rep-${seen + 1}` };
      }
    }
    const checkLimit = longCheckLimit(c.jiangPieceIds.length);
    if (c.jiangCount >= checkLimit - 1 && c.jiangCount < checkLimit) {
      return { text: `${banName("LONG_CHECK")}\u5DF2 ${c.jiangCount} \u7740\uFF0C\u4E0B\u7740\u5C06\u8D85\u9650\uFF0C\u8BF7\u5C3D\u5FEB\u53D8\u62DB`, key: `jiang-${c.jiangCount}` };
    }
    const zhuoMax = maxZhuoCount(c);
    if (zhuoMax >= RULE_CONFIG.longChase - 1 && zhuoMax < RULE_CONFIG.longChase) {
      return { text: `${banName("LONG_CHASE")}\u5DF2 ${zhuoMax} \u7740\uFF0C\u4E0B\u7740\u5C06\u8D85\u9650\uFF0C\u8BF7\u5C3D\u5FEB\u53D8\u62DB`, key: `zhuo-${zhuoMax}` };
    }
    const jzLimit = checkChaseLimit(c.jiangZhuoPieceIds.length);
    if (c.jiangZhuoLoop >= jzLimit - 1 && c.jiangZhuoLoop < jzLimit) {
      return { text: `${banName("CHECK_CHASE")}\u5DF2 ${c.jiangZhuoLoop} \u7740\uFF0C\u4E0B\u7740\u5C06\u8D85\u9650\uFF0C\u8BF7\u5C3D\u5FEB\u53D8\u62DB`, key: `jz-${c.jiangZhuoLoop}` };
    }
    return null;
  };
  const notice = noticeFor(moverSide) ?? noticeFor(opponentSide);
  if (notice) {
    rs.notice = notice.text;
    rs.noticeKey = notice.key;
  }
  return finish(rs, false, "", null);
}

// chinese-chess-client/client/utils/chess/GameEngine.ts
function createInitialState(firstMoveSide = RED_SIDE) {
  const qiPan = [];
  for (let i = 0; i < BOARD_COLS; i++) {
    qiPan[i] = [];
    for (let j = 0; j < BOARD_ROWS; j++) {
      qiPan[i][j] = -1;
    }
  }
  const pieces = [];
  for (let i = 0; i < 32; i++) {
    const col = QIZI_INIT_POSITION[i][0];
    const row = QIZI_INIT_POSITION[i][1];
    pieces.push({ id: i, col, row, alive: true });
    qiPan[col][row] = i;
  }
  const state = {
    qiPan,
    pieces,
    sideTag: firstMoveSide,
    // 先手方（默认红先，支持黑先变体）
    moveHistory: [],
    gameStatus: "playing",
    isCheck: false,
    checkMessage: "",
    zobristHash: 0
    // 初始哈希，稍后在调用方通过 computeZobristHash 计算
  };
  return state;
}
function cloneGameState(state) {
  return {
    qiPan: state.qiPan.map((r) => [...r]),
    pieces: state.pieces.map((p) => ({ ...p })),
    sideTag: state.sideTag,
    moveHistory: [...state.moveHistory],
    gameStatus: state.gameStatus,
    isCheck: state.isCheck,
    checkMessage: state.checkMessage,
    zobristHash: state.zobristHash,
    ruleState: state.ruleState ? cloneRuleState(state.ruleState) : void 0
  };
}
function applyHandicap(state, handicapIds) {
  if (!Array.isArray(handicapIds) || handicapIds.length === 0) return state;
  for (const id of handicapIds) {
    const piece = state.pieces[id];
    if (!piece || !piece.alive) continue;
    piece.alive = false;
    if (state.qiPan[piece.col]?.[piece.row] === id) {
      state.qiPan[piece.col][piece.row] = -1;
    }
  }
  return state;
}
function toPiecePositions(pieces) {
  return pieces.map((p) => ({ col: p.col, row: p.row, alive: p.alive }));
}
function getSelectableMoves(state, pieceId) {
  const empty = () => Array.from({ length: BOARD_COLS }, () => Array(BOARD_ROWS).fill(false));
  if (pieceId < 0 || pieceId > 31) return empty();
  const piece = state.pieces[pieceId];
  if (!piece.alive) return empty();
  if (piece.col < 0 || piece.col >= BOARD_COLS || piece.row < 0 || piece.row >= BOARD_ROWS) return empty();
  const pieceSide = pieceId <= 15 ? BLACK_SIDE : RED_SIDE;
  if (pieceSide !== state.sideTag) return empty();
  const points = getPathPoints(pieceId, state.qiPan, toPiecePositions(state.pieces));
  points[piece.col][piece.row] = false;
  return points;
}
function getValidMoves(state, pieceId) {
  return getSelectableMoves(state, pieceId);
}
function isMoveKingSafe(state, pieceId, toCol, toRow) {
  const piece = state.pieces[pieceId];
  if (!piece || !piece.alive) return false;
  return !afterMoveStillJiangJun(
    pieceId,
    piece.col,
    piece.row,
    toCol,
    toRow,
    state.qiPan,
    toPiecePositions(state.pieces)
  );
}
function isJiangJun(state, jiangOrShuai) {
  const result = [-1, -1, -1];
  if (jiangOrShuai !== 0 && jiangOrShuai !== 16) return result;
  const target = state.pieces[jiangOrShuai];
  if (!target || !target.alive) return result;
  if (target.col < 0 || target.col >= BOARD_COLS || target.row < 0 || target.row >= BOARD_ROWS) {
    return result;
  }
  const positions = toPiecePositions(state.pieces);
  if (jiangOrShuai === 16) {
    for (let qizi = 5; qizi <= 15; qizi++) {
      if (!state.pieces[qizi].alive) continue;
      const thisPoints = getPathPoints(qizi, state.qiPan, positions);
      const x = target.col;
      const y = target.row;
      if (thisPoints[x][y]) {
        result[0] = 16;
        if (result[1] === -1) result[1] = qizi;
        else {
          result[2] = qizi;
          return result;
        }
      }
    }
  }
  if (jiangOrShuai === 0) {
    for (let qizi = 21; qizi <= 31; qizi++) {
      if (!state.pieces[qizi].alive) continue;
      const thisPoints = getPathPoints(qizi, state.qiPan, positions);
      const x = target.col;
      const y = target.row;
      if (thisPoints[x][y]) {
        result[0] = 0;
        if (result[1] === -1) result[1] = qizi;
        else {
          result[2] = qizi;
          return result;
        }
      }
    }
  }
  return result;
}
function hasAnyLegalMove(state, side) {
  const positions = toPiecePositions(state.pieces);
  const start = side === RED_SIDE ? 16 : 0;
  const end = side === RED_SIDE ? 32 : 16;
  for (let id = start; id < end; id++) {
    const piece = state.pieces[id];
    if (!piece.alive) continue;
    const pathBool = getPathPoints(id, state.qiPan, positions);
    for (let c = 0; c < 9; c++) {
      for (let r = 0; r < 10; r++) {
        if (!pathBool[c][r]) continue;
        if (!afterMoveStillJiangJun(id, piece.col, piece.row, c, r, state.qiPan, positions)) {
          return true;
        }
      }
    }
  }
  return false;
}
function isJueSha(state, moveQiZi) {
  const checkedSide = moveQiZi < 16 ? RED_SIDE : BLACK_SIDE;
  const jiangId = checkedSide === RED_SIDE ? 16 : 0;
  if (isJiangJun(state, jiangId)[0] === -1) return false;
  return !hasAnyLegalMove(state, checkedSide);
}
function isKunBi(state, side) {
  const jiangId = side === RED_SIDE ? 16 : 0;
  if (isJiangJun(state, jiangId)[0] !== -1) return false;
  return !hasAnyLegalMove(state, side);
}
function makeMove(state, pieceId, toCol, toRow) {
  const newState = cloneGameState(state);
  const piece = newState.pieces[pieceId];
  const fromCol = piece.col;
  const fromRow = piece.row;
  const captured = newState.qiPan[toCol][toRow];
  newState.qiPan[fromCol][fromRow] = -1;
  newState.qiPan[toCol][toRow] = pieceId;
  piece.col = toCol;
  piece.row = toRow;
  if (captured !== -1) {
    newState.pieces[captured].alive = false;
  }
  newState.moveHistory.push({
    pieceId,
    fromCol,
    fromRow,
    toCol,
    toRow,
    capturedPieceId: captured
  });
  newState.sideTag = !newState.sideTag;
  const checkResult = newState.sideTag === RED_SIDE ? isJiangJun(newState, 16) : isJiangJun(newState, 0);
  newState.isCheck = checkResult[0] !== -1;
  newState.checkMessage = "";
  let isGameOver = false;
  let gameOverReason = "";
  if (isJueSha(newState, pieceId)) {
    isGameOver = true;
    gameOverReason = "juesha";
  }
  if (!isGameOver && isKunBi(newState, newState.sideTag)) {
    isGameOver = true;
    gameOverReason = "kunbi";
  }
  const ruleEvaluation = evaluateRuleAfterMove(state, newState, { pieceId, captured });
  newState.ruleState = ruleEvaluation.ruleState;
  if (!isGameOver && ruleEvaluation.gameOver) {
    isGameOver = true;
    gameOverReason = ruleEvaluation.gameOverReason;
    newState.gameStatus = ruleEvaluation.loser === null ? "draw" : ruleEvaluation.loser === RED_SIDE ? "black_win" : "red_win";
  }
  if (captured === 0) {
    isGameOver = true;
    gameOverReason = "red_win";
  }
  if (captured === 16) {
    isGameOver = true;
    gameOverReason = "black_win";
  }
  if (isGameOver && newState.gameStatus === "playing") {
    const winnerTag = getWinnerSideTagFromReason(newState.sideTag, gameOverReason);
    newState.gameStatus = winnerTag === RED_SIDE ? "red_win" : "black_win";
  }
  return {
    newState,
    captured,
    isCheck: newState.isCheck,
    isGameOver,
    gameOverReason
  };
}
function getWinnerSideTagFromReason(newSideTag, reason) {
  switch (reason) {
    case "red_win":
      return RED_SIDE;
    case "black_win":
      return BLACK_SIDE;
    case "juesha":
    case "kunbi":
    default:
      return !newSideTag;
  }
}

// chinese-chess-client/client/utils/chess/ruleEngine.bundle.ts
function getValidMoves2(state, pieceId) {
  const points = getSelectableMoves(state, pieceId);
  for (let col = 0; col < 9; col++) {
    for (let row = 0; row < 10; row++) {
      if (points[col][row] && !isMoveKingSafe(state, pieceId, col, row)) {
        points[col][row] = false;
      }
    }
  }
  return points;
}
var getSelectableMovesForParity = getValidMoves;
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  applyHandicap,
  cloneGameState,
  createInitialState,
  getSelectableMovesForParity,
  getValidMoves,
  isMoveBanned,
  makeMove
});
