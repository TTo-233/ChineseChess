/**
 * 服务端权威裁决引擎入口（esbuild 打包为 ruleEngine.cjs，由 dist/index.js 加载）
 *
 * 联机对局走子协议改造（方案 P0「服务端权威裁决」）：客户端只发着法，
 * 服务端以与客户端完全相同的规则引擎（GameEngine + RuleEngine）进行
 * 走法校验与终局裁决（长将长捉只提示不判负，服务端不再二次拦截禁着）。
 * 本文件与客户端共享同一份源码，编译产物随服务端部署包分发。
 */
export {
  makeMove,
  getValidMoves,
  createInitialState,
  cloneGameState,
} from './GameEngine';
export { isMoveBanned } from './RuleEngine';
