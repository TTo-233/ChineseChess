/**
 * `../ruleEngine.cjs` 的类型声明（仅供 `tsc --noEmit` / pnpm lint 使用，不参与打包）。
 *
 * ⚠️ 为什么放在 `src/` 下、而不是和 `chinese-chess-server/ruleEngine.cjs` 并排：
 * `src/routes/lanGame.ts` 里写的是 `import ruleEngine from '../ruleEngine.cjs';`，这个**字符串**
 * 是产物 `dist/index.js` 需要的样子（`dist/index.js` 里是 `require("../ruleEngine.cjs")`，
 * 相对 `dist/` 解析到服务端根的 `ruleEngine.cjs`）。esbuild 构建时把该说明符列为 external
 * （见 `build.js` 的 `external: ['../ruleEngine.cjs']`），所以源码目录里**并不存在** `src/ruleEngine.cjs`，
 * 类型声明只能按"从 src/routes/ 出发的相对路径"落在这里，才能被 TS 解析到。
 *
 * ruleEngine.cjs 不是手写文件：它由 `chinese-chess-client/client/utils/chess/ruleEngine.bundle.ts`
 * 经 esbuild 打包而来（两端同源，见 `scripts/verify-rule-engine-parity.mjs`）。这里只声明服务端
 * 实际用到的两个方法，类型放宽为 any：
 *   - 真正的类型定义在客户端源码里（`client/utils/chess/types.ts` 等）；
 *   - 服务端只做「校验 + 落子」两次调用，声明过细会在两端打包之间反复漂移。
 * 声明文件不会进入 dist/index.js，改它无需重新构建。
 */
declare const ruleEngine: {
  /** 生成某棋子的全部合法着法；返回按列索引的二维表（`valid[toCol][toRow]` 为真即合法）。 */
  getValidMoves(state: any, pieceId: number): any;
  /** 服务端权威落子：返回 `{ newState, isGameOver, ... }`（含长将长捉与终局判定）。 */
  makeMove(state: any, pieceId: number, toCol: number, toRow: number): any;
};

export = ruleEngine;
