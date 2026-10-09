/**
 * 服务端权威裁决引擎入口（esbuild 打包为 ruleEngine.cjs，由
 * `chinese-chess-server/src/routes/lanGame.ts:6` 的
 * `import ruleEngine from '../ruleEngine.cjs'` 加载；【I-1】原注释此处写的是
 * 已过期的 dist 行号口径，实际调用点在服务端**源码**里）
 *
 * 联机对局走子协议改造（方案 P0「服务端权威裁决」）：客户端只发着法，
 * 服务端以与客户端完全相同的规则引擎（GameEngine + RuleEngine）进行
 * 走法校验与终局裁决。规则二的禁着**两端都拦截**：客户端 handleMove 先拦一层
 * （省一次往返、就地弹「禁止长将，请变招」），服务端在此做权威裁决（防伪造），
 * 提示文案由同一份 banReasonNotice 产出，不会漂移。
 * 本文件与客户端共享同一份源码，编译产物随服务端部署包分发。
 *
 * ============================================================================
 * 【服务端权威校验的落点：这里的 getValidMoves 比客户端多一道王安全过滤】
 *
 * 2026-09 送将事故：4ccdae5 取消了 getValidMoves 的王安全过滤之后，本入口
 * 导出的 getValidMoves 也随之失去过滤，于是服务端 `src/routes/lanGame.ts:1273` 中那句
 * `const valid = ruleEngine.getValidMoves(state, pieceId)`（原注释写着"含王安全过滤"）
 * 实际上只校了走法形状——旧客户端或篡改客户端可以照常送将，
 * 把对局推进到「正被将军却无人应招」的非法局面（服务端 Pikafish 从不吃将，
 * 这条局面永远不会自己终结）。
 *
 * 修法刻意**不**去改 GameEngine.getValidMoves（客户端落点表靠它保持
 * 4ccdae5 的全量显示口径——用户点下去再拦，比"只剩应将点"更像正常对局），
 * 而是在这个**仅服务端使用**的入口里，把 getSelectableMoves 与 isMoveKingSafe
 * 组合成一个"真正的合法着法表"再导出：
 *
 *     getValidMoves === getSelectableMoves 过滤掉送将着法
 *
 * 客户端源码只读、未改，因此规则引擎仍是"两端同源"；
 * 但服务端裁决比客户端更严（严格超集关系），由
 * scripts/verify-rule-engine-parity.mjs 与 __tests__/ruleEngineParity.test.ts
 * 共同钉死这条等式，防止将来有人把过滤去掉。
 * ============================================================================
 */
import {
  getSelectableMoves,
  getValidMoves as getRawValidMoves,
  isMoveKingSafe,
  makeMove,
  createInitialState,
  cloneGameState,
  applyHandicap,
  type GameState,
} from './GameEngine';

export { makeMove, createInitialState, cloneGameState, applyHandicap };
// 规则二禁着：服务端 lanGame.ts 用 getMoveBanReason 判定、并取 banReasonNotice
// 作为拒绝时的提示文案（与客户端弹的提示同源同字）。
export { isMoveBanned, getMoveBanReason, banReasonNotice } from './RuleEngine';

/**
 * 服务端权威「合法着法表」：走法形状合法 **且** 走后己方将/帅不被攻击。
 *
 * 返回结构与 getSelectableMoves / 客户端 getValidMoves 一致（`points[col][row]`）。
 * 之所以逐点重算 isMoveKingSafe 而不用"先过滤再返回"，是因为
 * isMoveKingSafe 需要棋子的当前位置，无法脱离 state 单独判断落点。
 */
export function getValidMoves(state: GameState, pieceId: number): boolean[][] {
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

/**
 * 客户端口径的落点表（不过滤送将）——仅供同源校验脚本/单测比对使用。
 * 服务端业务代码**不得**用它做走法合法性校验（那正是 4ccdae5 之后的漏洞）。
 */
export const getSelectableMovesForParity = getRawValidMoves;

