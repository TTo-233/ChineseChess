/**
 * 两端规则引擎同源一致性测试（h2h：head-to-head）
 *
 * ============================================================================
 * 【为什么需要这个测试】
 *
 * 服务端的规则引擎 chinese-chess-server/ruleEngine.cjs 不是独立源码，而是把
 * chinese-chess-client/client/utils/chess/ruleEngine.bundle.ts 用 esbuild 打包的产物
 * （服务端 dist/index.js 通过 require("../ruleEngine.cjs") 加载它）。
 *
 * 于是"两端同源"只是**约定**，没有任何机制保证：
 *   · 改了客户端规则源码而忘记重新打包 → 服务端还在跑旧规则，且不报任何错；
 *   · 打包参数/esbuild 版本漂移 → 产物出现无意义差异，回归时无人看得出。
 *
 * 这道测试从两个层面钉住它：
 *   1. **逐字节**：用固定参数重新打包源码，必须与已提交的 ruleEngine.cjs 完全一致。
 *      （脚本版是 chinese-chess-server/scripts/verify-rule-engine-parity.mjs，已挂进
 *       pnpm -w verify:rule-engine-parity；这里再跑一遍，使 jest 全绿本身就等价于
 *       "两端未漂移"。）
 *   2. **行为**：对同一局面、同一串着法，两端引擎给出的走点集合与 FEN 必须一致
 *      —— 即使有人绕过字节校验（例如改了两边但改得"看起来对称"），行为比对也会失败。
 *
 * ⚠️ 本测试依赖 client 的 esbuild 依赖已安装（pnpm install）。
 */

import fs from 'node:fs';
import path from 'node:path';
import esbuild from 'esbuild';

import {
  createInitialState,
  createFromFen,
  getValidMoves,
  isMoveKingSafe,
  makeMove,
  toFenString,
  type GameState,
} from '../GameEngine';
import { RED_SIDE, BLACK_SIDE } from '../types';

// 从 client/utils/chess/__tests__ 上溯到仓库根：__tests__ → chess → utils → client → chinese-chess-client → repo
const CLIENT_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const REPO_ROOT = path.resolve(CLIENT_ROOT, '..');
const ENTRY = path.join(CLIENT_ROOT, 'client', 'utils', 'chess', 'ruleEngine.bundle.ts');
const SERVER_ENGINE = path.join(REPO_ROOT, 'chinese-chess-server', 'ruleEngine.cjs');

/* eslint-disable @typescript-eslint/no-require-imports -- 服务端产物是 CommonJS，必须用 require 加载 */
const serverEngine = require(SERVER_ENGINE) as {
  cloneGameState: (s: unknown) => unknown;
  createInitialState: () => unknown;
  getValidMoves: (s: unknown, pieceId: number) => boolean[][];
  isMoveBanned: (s: unknown, pieceId: number, toCol: number, toRow: number) => boolean;
  makeMove: (
    s: unknown,
    pieceId: number,
    toCol: number,
    toRow: number
  ) => { newState: unknown; captured: number; isGameOver: boolean; gameOverReason: string } | null;
};
/* eslint-enable @typescript-eslint/no-require-imports */
/** 换行归一化：仓库 LF/CRLF 检出混存，字节比较必须忽略行尾差异。 */
const normalize = (s: string) => s.replace(/\r\n/g, '\n');

/**
 * 归一化 esbuild 自动插入的入口注释（`// <入口路径>`）。
 * 该路径相对 esbuild 工作目录，会随"从哪个目录跑"变化，但它只是注释、与规则语义无关。
 * 出包时留在产物里的是长路径形式；这里统一成绝对入口路径再比对，避免假漂移。
 * 权威实现在 chinese-chess-server/scripts/verify-rule-engine-parity.mjs，两处参数必须一致。
 */
const normalizeEntryComment = (s: string) =>
  s.replace(
    /^\/\/ .*?(chinese-chess-client\/client\/utils\/chess\/ruleEngine\.bundle\.ts|ruleEngine\.bundle\.ts)$/m,
    `// ${ENTRY}`
  );

// ---------------------------------------------------------------------------
// 1. 逐字节：重新打包必须与已提交产物一致
// ---------------------------------------------------------------------------

describe('两端规则引擎同源 —— 逐字节', () => {
  test('重新打包 ruleEngine.bundle.ts 与已提交的 ruleEngine.cjs 完全一致', () => {
    expect(fs.existsSync(ENTRY)).toBe(true);
    expect(fs.existsSync(SERVER_ENGINE)).toBe(true);

    // 打包参数是实测反推的（在已提交产物上比对到逐字节相等），不能随便改：
    // target 换 es2019/es2018 会多出 var _a, _b; 降级变量，es2017 及更低换掉整套头部。
    const built = normalizeEntryComment(
      normalize(
        esbuild.buildSync({
          entryPoints: [ENTRY],
          bundle: true,
          format: 'cjs',
          platform: 'node',
          target: 'es2020',
          write: false,
          logLevel: 'silent',
          absWorkingDir: REPO_ROOT,
        }).outputFiles[0].text
      )
    );
    const shipped = normalizeEntryComment(normalize(fs.readFileSync(SERVER_ENGINE, 'utf8')));

    if (built !== shipped) {
      let i = 0;
      while (i < Math.min(built.length, shipped.length) && built[i] === shipped[i]) i += 1;
      throw new Error(
        '两端规则引擎已漂移！请执行：\n' +
          '  node chinese-chess-server/scripts/verify-rule-engine-parity.mjs --write\n' +
          '然后**重启服务端**（dist/index.js 通过 require 加载 ruleEngine.cjs）。\n' +
          `首个差异在第 ${i} 字节：\n` +
          `  重新打包 ${built.length} 字节：${JSON.stringify(built.slice(Math.max(0, i - 60), i + 60))}\n` +
          `  已提交   ${shipped.length} 字节：${JSON.stringify(shipped.slice(Math.max(0, i - 60), i + 60))}`
      );
    }
    expect(built.length).toBe(shipped.length);
  });
});

// ---------------------------------------------------------------------------
// 2. 行为：走点集合与 FEN 必须一致
// ---------------------------------------------------------------------------

/** 用给定引擎枚举指定一方的全部走点（"col,row"集合），用于两端比对 */
function collectMoves(
  engineGetValidMoves: (s: unknown, pieceId: number) => boolean[][],
  state: unknown,
  sideTag: boolean
): string[] {
  const start = sideTag ? 16 : 0;
  const out: string[] = [];
  const pieces = (state as GameState).pieces;
  for (let i = start; i <= start + 15; i++) {
    if (!pieces[i].alive) continue;
    const points = engineGetValidMoves(state, i);
    for (let c = 0; c < 9; c++) {
      for (let r = 0; r < 10; r++) {
        if (points[c][r]) out.push(`${i}@${c},${r}`);
      }
    }
  }
  return out.sort();
}

/** 客户端口径**且**走后不送将的走点集合（= 服务端应当接受的着法集合） */
function collectClientSafeMoves(state: GameState, sideTag: boolean): string[] {
  const start = sideTag ? 16 : 0;
  const out: string[] = [];
  for (let i = start; i <= start + 15; i++) {
    if (!state.pieces[i].alive) continue;
    const points = getValidMoves(state, i);
    for (let c = 0; c < 9; c++) {
      for (let r = 0; r < 10; r++) {
        if (points[c][r] && isMoveKingSafe(state, i, c, r)) out.push(`${i}@${c},${r}`);
      }
    }
  }
  return out.sort();
}

/**
 * 两端**唯一允许的差异**：服务端裁决表 = 客户端落点表 − 送将着法。
 *
 * 这条等式同时钉死三件事，缺一不可：
 *   · 服务端确实在过滤送将（权威校验没被谁顺手删掉）；
 *   · 服务端**只**过滤送将，没有多拦任何正常着法（否则线上玩家会莫名被 400）；
 *   · 客户端落点表仍是 4ccdae5 的全量口径（否则"点下去再拦"就退化成"只剩应将点"）。
 */
function expectServerIsClientMinusSongjiang(
  clientState: GameState,
  serverState: unknown,
  sideTag: boolean
) {
  const clientShown = collectMoves(getValidMoves, clientState, sideTag);
  const serverAccepted = collectMoves(serverEngine.getValidMoves, serverState, sideTag);
  const clientSafe = collectClientSafeMoves(clientState, sideTag);

  expect(serverAccepted).toEqual(clientSafe);
  // 客户端落点表必须是服务端裁决表的超集（送将被显示、但不被接受）
  expect(clientShown.length).toBeGreaterThanOrEqual(serverAccepted.length);
}

/** 一串着法（[起点子id, 目标列, 目标行]），用于驱动两端逐步比对 */
const MOVE_SEQUENCE: [number, number, number][] = [
  // 中炮对屏风马开局若干着（红黑交替，覆盖炮/马/车/兵/卒走法生成）
  [29, 4, 6], // 红炮 (7,7) → (4,6)
  [7, 4, 3],  // 黑炮 (7,2) → (4,3)
  [27, 4, 7], // 红马 (7,9) → (4,7)（马走日）
  [5, 4, 0],  // 黑马 (7,0) → (4,0)
];

describe('两端规则引擎同源 —— 行为一致', () => {
  test('初始局面的走点集合两端一致', () => {
    const clientState = createInitialState();
    const serverState = serverEngine.createInitialState();
    // 开局双方都不会被将军，因此"全量落点"与"服务端裁决表"此时应当完全相同
    expect(collectMoves(getValidMoves, clientState, RED_SIDE)).toEqual(
      collectMoves(serverEngine.getValidMoves, serverState, RED_SIDE)
    );
    expect(collectMoves(getValidMoves, clientState, BLACK_SIDE)).toEqual(
      collectMoves(serverEngine.getValidMoves, serverState, BLACK_SIDE)
    );
    expectServerIsClientMinusSongjiang(clientState, serverState, RED_SIDE);
    expectServerIsClientMinusSongjiang(clientState, serverState, BLACK_SIDE);
  });

  test('同一串着法逐步推进后，局面 FEN 与走点集合始终一致', () => {
    let clientState = createInitialState();
    let serverState = serverEngine.createInitialState();

    expect(toFenString(clientState)).toBe(toFenString(serverState as GameState));

    for (const [pieceId, toCol, toRow] of MOVE_SEQUENCE) {
      const clientResult = makeMove(clientState, pieceId, toCol, toRow);
      const serverResult = serverEngine.makeMove(serverState, pieceId, toCol, toRow);

      // 两端对"这一步是否被接受"必须同判
      expect(!!clientResult).toBe(!!serverResult);
      if (!clientResult || !serverResult) break;

      // 吃子、终局判定也必须同判
      expect(clientResult.captured).toBe(serverResult.captured);
      expect(clientResult.isGameOver).toBe(serverResult.isGameOver);

      clientState = clientResult.newState;
      serverState = serverResult.newState;

      expect(toFenString(clientState)).toBe(toFenString(serverState as GameState));
      const sideTag = clientState.sideTag;
      expect(collectMoves(getValidMoves, clientState, sideTag)).toEqual(
        collectMoves(getValidMoves, serverState as GameState, sideTag)
      );
      expectServerIsClientMinusSongjiang(clientState, serverState, sideTag);
    }
  });

  /**
   * 服务端权威校验（2026-09 送将事故的第二道防线）。
   *
   * 客户端界面上的拦截只能约束"正常客户端"。旧版本或篡改过的客户端可以直接发
   * 送将着法，把对局推入「正被将军却无人应招」的非法局面——而服务端 Pikafish
   * 从不吃将，这种局面永远不会自己终结。所以服务端必须自己判。
   *
   * 这也是两端引擎**唯一**被允许的差异：服务端 getValidMoves 比客户端多一道
   * 王安全过滤。客户端不改（落点表保持 4ccdae5 全量显示），因此仍是"两端同源"。
   */
  test('送将局面：客户端显示该落点，但服务端把它从裁决表里过滤掉', () => {
    const fenStr = '4k4/9/4r4/9/9/4R4/9/9/9/4K4 b';
    const clientState = createFromFen(fenStr);
    const serverState = serverEngine.cloneGameState(clientState) as GameState;
    const sideTag = clientState.sideTag;

    const clientShown = collectMoves(getValidMoves, clientState, sideTag);
    const serverAccepted = collectMoves(serverEngine.getValidMoves, serverState, sideTag);

    // 客户端照旧给出全部走点（含送将）——保证"点下去才知道不行"的观感
    expect(clientShown).toEqual(collectMoves(getValidMoves, clientState, sideTag));
    expect(clientShown.length).toBeGreaterThan(0);

    // 服务端必须更严：只接受"走后己方将/帅不被攻击"的那些着法
    expect(serverAccepted).toEqual(collectClientSafeMoves(clientState, sideTag));

    // 客户端显示、服务端拒绝的那些着法，逐一必须能被 isMoveKingSafe 判为送将
    // （黑车 (4,5) 离开 4 路会暴露将帅照面，就是其中之一）
    const songjiangMoves = clientShown.filter((m) => !serverAccepted.includes(m));
    expect(songjiangMoves.length).toBeGreaterThan(0);
    for (const m of songjiangMoves) {
      const [pieceId, square] = m.split('@');
      const [col, row] = square.split(',').map(Number);
      expect(isMoveKingSafe(clientState, Number(pieceId), col, row)).toBe(false);
    }
  });
});
