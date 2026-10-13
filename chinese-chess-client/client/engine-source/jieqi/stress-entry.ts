/**
 * 压力测试用的「真实规则层 + 编解码层」汇总入口（仅供 esbuild 打包）。
 *
 * ⚠️ 为什么需要它：WASM glue 只有在**干净进程**里才会接受注入的 `stdin` 回调。
 * 在同一进程里 `require('tsx/cjs')` 之后，glue 会改读真实 process.stdin，
 * 于是脚本 argv 被当成 UCI 命令喂进引擎（实测报 `Unknown command`）。
 * 故把 TS 源码预打包成 CJS，主进程不再加载 tsx。
 *
 * 这里汇总的全是 utils/chess/ 下的**纯 TS**（无 react-native 依赖），
 * 与 App 运行时用的是同一份源码，不做任何替身。
 */

export {
  createJieqiInitialState,
  makeSeededRand,
  makeShuffleRand,
  sideOfId,
  liveHiddenSlots,
  hiddenIdentityPosterior,
  isHidden,
} from '../../utils/chess/jieqi';

export {
  makeMove,
  cloneGameState,
  getValidMoves,
  isMoveKingSafe,
  isJiangJun,
  createInitialState,
} from '../../utils/chess/GameEngine';

export {
  enumerateLegalMoves,
  isMoveBanned,
  getMoveBanReason,
  recomputeRuleState,
} from '../../utils/chess/RuleEngine';

export {
  setJieqiRuntime,
  getJieqiRuntime,
  clearJieqiRuntime,
  buildJieqiSearchPayload,
} from '../../utils/chess/jieqiRuntime';

export {
  createDeterminization,
  cloneDeterminization,
  computePoolFromState,
  declareCapturedIdentity,
  makeDeterministicRand,
  topUpCapturedDeclarations,
  capturedHiddenCount,
} from '../../utils/chess/jieqiDeterminization';

export { buildJieqiHistoryMoves } from '../../utils/chess/jieqiHistory';

export {
  parseBestmove,
  createInfoState,
  consumeEngineLine,
  chooseUci,
  buildJieqiMove,
  parseJieqiMove,
  isCriticalErrorLine,
} from '../../utils/chess/jieqiUci';

export {
  toJieqiFen,
  assertPoolMatchesBoard,
  liveHiddenCount,
  initialJieqiPool,
  JIEQI_START_FEN,
} from '../../utils/chess/jieqiFen';

export { getJieqiTier, getJieqiTierCopy } from '../../utils/chess/pikafish/jieqiTier';

export { RED_SIDE, BLACK_SIDE, BOARD_COLS, BOARD_ROWS } from '../../utils/chess/types';