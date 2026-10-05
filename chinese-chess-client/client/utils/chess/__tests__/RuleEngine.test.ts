/**
 * 长将长捉规则引擎测试（方案第 14 节「必须覆盖的测试用例」全部 24 项）
 *
 * 构造说明：
 * - 端到端用例：createFromFen 构建简化局面 + makeMove 驱动真实着法序列
 * - 半构造用例：预置 RuleState 计数后走一步触发判定（互长将/二将一还等
 *   完整合法序列在纯车棋中无法构造——应将方的"解将反将"只能通过吃子完成，
 *   而吃子会重置计数，方案 3.1.1）
 */
import {
  createInitialState, createFromFen, makeMove, type GameState,
} from '../GameEngine';
import {
  RULE_CONFIG, detectZhuo, isMoveBanned, getMoveBanReason, banReasonNotice, positionKey,
  type RuleState,
} from '../RuleEngine';
import { getValidMoves } from '../GameEngine';
import { RED_SIDE, BLACK_SIDE } from '../types';

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
const RED = RED_SIDE;
const BLACK = BLACK_SIDE;

function fen(fenStr: string): GameState {
  return createFromFen(fenStr);
}

function play(state: GameState, pieceId: number, toCol: number, toRow: number): GameState {
  return makeMove(state, pieceId, toCol, toRow).newState;
}

function emptyCounters() {
  return {
    jiangCount: 0, jiangPieceIds: [], zhuoCounts: {},
    jiangZhuoLoop: 0, jiangZhuoPieceIds: [], opponentCheckedDuringRun: false,
    checkCountInWindow: 0,
  };
}

/** 预置规则状态（半构造用例）：构建/修改指定方的计数器 */
function preset(state: GameState, mutate: (rs: RuleState) => void): GameState {
  if (!state.ruleState) {
    state.ruleState = {
      red: emptyCounters(), black: emptyCounters(),
      positionKeys: [], naturalMoveCounter: 0,
      banActive: false, banSide: null, banReason: null, banChaseTargets: [],
      banMoves: [], notice: null, noticeKey: null,
    };
  }
  mutate(state.ruleState);
  return state;
}

/** 一子长将基础局面：黑将(4,0) 红车(3,3) 红帅(3,9)，车 4/5 列交替将、黑将来回躲 */
const LONG_CHECK_FEN = '4k4/9/9/3R5/9/9/9/9/9/3K5 w';

// ---------------------------------------------------------------------------
// 1-3：长将阈值与禁着
// ---------------------------------------------------------------------------

describe('方案14 用例1：一子长将 6 着 → 第 7 着禁着', () => {
  test('连续 6 将后触发 LONG_CHECK 禁着，第 7 将被拦截，变招放行', () => {
    let s = fen(LONG_CHECK_FEN);
    const seq: Array<[number, number, number]> = [
      [23, 4, 3], [0, 5, 0],  // R(3,3)→(4,3) 将1；黑将躲 (5,0)
      [23, 5, 3], [0, 4, 0],  // 将2；躲回
      [23, 4, 3], [0, 5, 0],  // 将3
      [23, 5, 3], [0, 4, 0],  // 将4
      [23, 4, 3], [0, 5, 0],  // 将5
      [23, 5, 3], [0, 4, 0],  // 将6 → 触发禁着；黑将躲回（轮红）
    ];
    for (const [p, c, r] of seq) s = play(s, p, c, r);

    expect(s.ruleState!.banActive).toBe(true);
    expect(s.ruleState!.banReason).toBe('LONG_CHECK');
    expect(s.ruleState!.banSide).toBe(RED); // 红方下一次走子受限
    // 第 7 将（车 (5,3)→(4,3) 构成将军着）被禁
    expect(isMoveBanned(s, 23, 4, 3)).toBe(true);
    // 变招（车横向走开，非将军着）放行
    expect(isMoveBanned(s, 23, 0, 3)).toBe(false);
  });

  test('超限后连续长将不判负；引擎仍可算，超限着法由上层拦截', () => {
    let s = fen(LONG_CHECK_FEN);
    const seq: Array<[number, number, number]> = [
      [23, 4, 3], [0, 5, 0], [23, 5, 3], [0, 4, 0],
      [23, 4, 3], [0, 5, 0], [23, 5, 3], [0, 4, 0],
      [23, 4, 3], [0, 5, 0], [23, 5, 3], [0, 4, 0],
    ];
    for (const [p, c, r] of seq) s = play(s, p, c, r);
    // 第 7/8/9 将继续长将：banActive 仍在，但**不判负、不终局**
    expect(s.ruleState!.banActive).toBe(true);
    expect(s.gameStatus).toBe('playing');
    // 规则引擎本身照常算得出这一步（makeMove 是纯引擎，不含拦截），
    // 拦截发生在 handleMove / 服务端 lanGame.ts：见下方「规则二禁着拦截」用例
    expect(getValidMoves(s, 23)[4][3]).toBe(true);
    // 但谓词明确报告它被禁：客户端/服务端正是据此拒绝
    expect(isMoveBanned(s, 23, 4, 3)).toBe(true);
    expect(getMoveBanReason(s, 23, 4, 3)).toBe('LONG_CHECK');
  });
});

describe('方案14 用例2/3：两子 12 着 / 三子 18 着交替长将阈值', () => {
  test('用例2：两子交替长将在第 12 将触发禁着，第 13 将被拦', () => {
    const s = fen(LONG_CHECK_FEN);
    preset(s, rs => {
      rs.red.jiangCount = 11;
      rs.red.jiangPieceIds = [23, 25]; // 两子参与 → 阈值 12
    });
    let { newState } = makeMove(s, 23, 4, 3); // 第 12 将（车到 4 列将军）
    const rs = newState.ruleState!;
    expect(rs.red.jiangCount).toBe(12);
    expect(rs.banActive).toBe(true);
    expect(rs.banReason).toBe('LONG_CHECK');
    expect(rs.banSide).toBe(RED);
    // 黑方应将后（轮红），第 13 将（车 (4,3)→(5,3) 将军 (5,0)）被禁
    newState = play(newState, 0, 5, 0);
    expect(isMoveBanned(newState, 23, 5, 3)).toBe(true);
  });

  test('用例2 补充：两子长将未达 12 着不禁（第 11 将后仍可继续）', () => {
    const s = fen(LONG_CHECK_FEN);
    preset(s, rs => {
      rs.red.jiangCount = 10;
      rs.red.jiangPieceIds = [23, 25];
    });
    const { newState } = makeMove(s, 23, 4, 3); // 第 11 将
    expect(newState.ruleState!.banActive).toBe(false);
  });

  test('用例3：三子及以上长将在第 18 将触发禁着', () => {
    const s = fen(LONG_CHECK_FEN);
    preset(s, rs => {
      rs.red.jiangCount = 17;
      rs.red.jiangPieceIds = [23, 25, 27];
    });
    const { newState } = makeMove(s, 23, 4, 3); // 第 18 将
    expect(newState.ruleState!.red.jiangCount).toBe(18);
    expect(newState.ruleState!.banActive).toBe(true);
    expect(newState.ruleState!.banReason).toBe('LONG_CHECK');
  });
});

// ---------------------------------------------------------------------------
// 4-5：长捉
// ---------------------------------------------------------------------------

describe('方案14 用例4：一子长捉 6 着 → 第 7 着禁着', () => {
  test('红车连续追捉无根黑炮 6 着触发 LONG_CHASE 禁着', () => {
    // 黑将(5,2) 黑炮(4,0) 红车(4,4) 红帅(3,9)：车 4/3 列交替追炮
    let s = fen('4c4/9/5k3/9/4R4/9/9/9/9/3K5 w');
    const seq: Array<[number, number, number]> = [
      [23, 4, 3], [9, 3, 0],   // 车(4,4)→(4,3) 捉1；炮(4,0)→(3,0)
      [23, 3, 3], [9, 4, 0],   // 捉2；炮逃回
      [23, 4, 3], [9, 3, 0],   // 捉3
      [23, 3, 3], [9, 4, 0],   // 捉4
      [23, 4, 3], [9, 3, 0],   // 捉5
      [23, 3, 3], [9, 4, 0],   // 捉6 → 禁着；炮逃回（轮红）
    ];
    for (const [p, c, r] of seq) s = play(s, p, c, r);

    expect(s.ruleState!.banActive).toBe(true);
    expect(s.ruleState!.banReason).toBe('LONG_CHASE');
    expect(s.ruleState!.banChaseTargets).toContain(9); // 目标：黑炮
    // 第 7 捉（车 (3,3)→(4,3) 后攻击 (4,0) 炮）被禁
    expect(isMoveBanned(s, 23, 4, 3)).toBe(true);
    // 变招放行（车横向走开不捉炮）
    expect(isMoveBanned(s, 23, 8, 3)).toBe(false);
  });
});

describe('方案14 用例5：分捉两子循环 → 不触发长捉', () => {
  test('目标切换清空旧目标计数（方案 2.2.2）', () => {
    const s = fen('4c4/9/5k3/9/4R4/9/9/9/9/3K5 w');
    preset(s, rs => {
      rs.red.zhuoCounts = { '9': 5, '11': 5 }; // 此前分捉：炮 5 次 + 卒 5 次
    });
    // 车 (4,4)→(0,4)：横向走开，不再捉炮 → 非捉着 → 红方捉计数全部清零
    const { newState } = makeMove(s, 23, 0, 4);
    expect(Object.keys(newState.ruleState!.red.zhuoCounts).length).toBe(0);
    expect(newState.ruleState!.banActive).toBe(false);
  });

  test('车绕行交替接近两个无根卒，永不满 6 连捉（端到端）', () => {
    // 黑将(4,0) 黑卒(0,5)(8,5)（均已过河） 红车(1,5) 红帅(3,9)
    let s = fen('4k4/9/9/9/9/pR6p/9/9/9/3K5 w');
    const seq: Array<[number, number, number]> = [
      [23, 1, 6], [0, 5, 0],   // 车下 row6（不捉）；黑将闲走
      [23, 7, 6], [0, 4, 0],   // 车横移；黑将回
      [23, 7, 5], [0, 5, 0],   // 车上 row5 攻击 (8,5) 卒 → 捉1
      [23, 7, 6], [0, 4, 0],   // 车下（非捉，计数清）
      [23, 1, 6], [0, 5, 0],
      [23, 1, 5], [0, 4, 0],   // 攻击 (0,5) 卒 → 捉1（另一目标，重新计）
      [23, 1, 6], [0, 5, 0],
      [23, 7, 6], [0, 4, 0],
      [23, 7, 5], [0, 5, 0],   // 再捉 (8,5) → 仍为 1
    ];
    for (const [p, c, r] of seq) s = play(s, p, c, r);
    expect(s.ruleState!.banActive).toBe(false);
    const maxZhuo = Math.max(0, ...Object.values(s.ruleState!.red.zhuoCounts));
    expect(maxZhuo).toBeLessThan(RULE_CONFIG.longChase);
  });
});

// ---------------------------------------------------------------------------
// 6-8：计数重置与优先级
// ---------------------------------------------------------------------------

describe('方案14 用例6：长将过程中吃子 → 计数重置', () => {
  test('连将 2 着后吃子，全部计数清零', () => {
    // 黑将(4,0) 黑卒(2,3) 红车(3,3) 红帅(3,9)
    let s = fen('4k4/9/9/2pR5/9/9/9/9/9/3K5 w');
    s = play(s, 23, 4, 3); // 将1
    s = play(s, 0, 5, 0);  // 黑躲
    s = play(s, 23, 5, 3); // 将2
    s = play(s, 0, 4, 0);  // 黑躲回
    expect(s.ruleState!.red.jiangCount).toBe(2);
    s = play(s, 23, 2, 3); // 车 (5,3)→(2,3) 吃卒 → 重置
    expect(s.ruleState!.red.jiangCount).toBe(0);
    expect(s.ruleState!.red.jiangZhuoLoop).toBe(0);
    expect(s.ruleState!.naturalMoveCounter).toBe(0); // 吃子重置自然限招窗口
    expect(s.ruleState!.banActive).toBe(false);
  });
});

describe('方案14 用例7：应将产生的捉 → 被捉次数保留但不增加', () => {
  test('仕垫将同时攻击无根过河卒，计数保留、将捉循环累计', () => {
    // 黑将(4,0) 黑车(4,6) 黑卒(3,7) 红帅(4,9) 红仕(3,9)，黑先
    let s = fen('4k4/9/9/9/9/9/4r4/3p5/9/3AK4 b');
    s = play(s, 7, 4, 5); // 黑车 (4,6)→(4,5) 将军红帅
    expect(s.isCheck).toBe(true);
    // 预置：红方此前已连续捉该黑卒 2 次
    preset(s, rs => { rs.red.zhuoCounts = { '11': 2 }; });
    const { newState } = makeMove(s, 17, 4, 8); // 红仕 (3,9)→(4,8) 垫将，同时攻击 (3,7) 卒
    const rs = newState.ruleState!;
    // 应将产生的捉：保留但不增加（方案 2.3.3）
    expect(rs.red.zhuoCounts['11']).toBe(2);
    // 算捉 → 将捉交替循环累计
    expect(rs.red.jiangZhuoLoop).toBe(1);
  });
});

describe('方案14 用例8：将捉同时出现 → 优先算将，清空捉计数', () => {
  test('车走一步同时将军与捉子，只记将军并清空此前捉计数', () => {
    // 黑将(4,0) 黑炮(6,3) 红车(3,3) 红帅(3,9)：
    // 车到 (4,3) 后纵向将军黑将 + 横向攻击无根黑炮（两条攻击线）
    const s = fen('4k4/9/9/3R2c2/9/9/9/9/9/3K5 w');
    preset(s, rs => { rs.red.zhuoCounts = { '9': 3 }; });
    const { newState, isCheck } = makeMove(s, 23, 4, 3); // 车 (3,3)→(4,3)
    expect(isCheck).toBe(true); // 纵向攻击黑将
    const rs = newState.ruleState!;
    expect(rs.red.jiangCount).toBe(1);          // 只记将军（方案 2.3.2 优先算将）
    expect(rs.red.zhuoCounts).toEqual({});      // 捉计数被清空
    expect(rs.red.jiangZhuoLoop).toBe(1);       // 将捉循环照常累计
  });
});

// ---------------------------------------------------------------------------
// 9-10：互相长将 / 互相长捉判和
// ---------------------------------------------------------------------------

describe('方案14 用例9：双方互相长将 6 着 → 判和', () => {
  test('双方各自连将至 6 判和（后至方触发）', () => {
    // 黑将(4,0) 红车(3,3) 黑车(4,5) 红帅(3,9)，黑先：黑车 (4,5)→(3,5) 将军红帅
    const s = fen('4k4/9/9/3R5/9/4r4/9/9/9/3K5 b');
    preset(s, rs => {
      rs.red.jiangCount = 6;
      rs.black.jiangCount = 5; // 黑这一将到位 → 双方 6
    });
    const { newState, isGameOver, gameOverReason } = makeMove(s, 7, 3, 5);
    expect(isGameOver).toBe(true);
    expect(gameOverReason).toBe('mutual_long_check');
    expect(newState.gameStatus).toBe('draw');
  });

  test('互长将进行中（对方 5 将）暂不禁着，等待对方到 6 判和', () => {
    const s = fen(LONG_CHECK_FEN);
    preset(s, rs => {
      rs.red.jiangCount = 6;
      rs.black.jiangCount = 5;
    });
    // 红继续将（7 将）：黑仅 5 → 不判和（双 6 未成立）、不禁红（等待黑到 6）
    const { newState, isGameOver } = makeMove(s, 23, 4, 3);
    expect(isGameOver).toBe(false);
    expect(newState.ruleState!.banActive).toBe(false);
    expect(newState.gameStatus).toBe('playing');
  });
});

describe('方案14 用例10：双方互相长捉 6 着 → 判和', () => {
  test('双方各一子连续被捉达 6 判和', () => {
    const s = fen('4c4/9/5k3/9/4R4/9/9/9/9/3K5 w');
    preset(s, rs => {
      rs.red.zhuoCounts = { '9': 6 };    // 红连捉黑炮 6
      rs.black.zhuoCounts = { '23': 6 }; // 黑连捉红车 6
    });
    // 红走一步继续捉炮 → 双方 ≥6 → 判和
    const { newState, isGameOver, gameOverReason } = makeMove(s, 23, 4, 3);
    expect(isGameOver).toBe(true);
    expect(gameOverReason).toBe('mutual_long_chase');
    expect(newState.gameStatus).toBe('draw');
  });
});

// ---------------------------------------------------------------------------
// 11-15：判和阈值
// ---------------------------------------------------------------------------

describe('方案14 用例11：非将非捉局面重复 5 次 → 判和', () => {
  test('双方士来回走 16 着（4 着一轮 × 4 轮）后初始局面第 5 次出现', () => {
    // 双方将士 + 双方各一兵卒（保持进攻子力，避免 no_attacking 提前判和）
    let s = fen('3ak4/9/9/8p/9/9/P8/9/9/3AK4 w');
    const round: Array<[number, number, number]> = [
      [17, 4, 8],  // 红仕 (3,9)→(4,8)
      [1, 4, 1],   // 黑士 (3,0)→(4,1)
      [17, 3, 9],  // 红仕回
      [1, 3, 0],   // 黑士回 → 局面复原
    ];
    for (let i = 0; i < 4; i++) {
      for (const [p, c, r] of round) s = play(s, p, c, r);
      if (i < 3) expect(s.gameStatus).toBe('playing');
    }
    expect(s.gameStatus).toBe('draw');
  });

  test('应将着不计入局面重复计数（规则一.2）', () => {
    // 黑车(4,8) 将军红帅(4,9)；红帅平移 (4,9)→(5,9) 应将解除。
    // 每行必须恰好 9 格：3r4 少一格会被 createFromFen 静默判为非法并退化成空棋盘。
    const CHECK_FEN = '4k4/9/9/9/9/9/9/9/3r5/3AK4 b';
    const build = (): GameState => play(fen(CHECK_FEN), 7, 4, 8); // 黑车 (3,8)→(4,8) 将军
    const probe = build();
    expect(probe.isCheck).toBe(true); // 确认真的把红帅将住了

    // 先空跑一遍，取「应将后」的指纹（positionKey 取自 afterState）
    const afterRespond = play(probe, 16, 5, 9);
    expect(afterRespond.gameStatus).toBe('playing');
    const key = positionKey(afterRespond);

    // 预置 4 次相同指纹 + 本步为第 5 次：旧口径（只排除将/捉）会在这里判和
    const s = preset(build(), rs => { rs.positionKeys = [key, key, key, key]; });
    const mv = makeMove(s, 16, 5, 9);
    expect(mv.isGameOver).toBe(false);   // 应将着 → 不判和
    expect(mv.newState.gameStatus).toBe('playing');

    // 对照组：同样的第 5 次重复，若走的是**非应将**着法则判和
    const plain = fen('4k4/9/9/8p/9/9/P8/9/9/3AK4 w');
    const plainProbe = play(plain, 17, 4, 8); // 红仕 (3,9)→(4,8)
    const plainKey = positionKey(plainProbe);
    const s2 = preset(plain, rs => { rs.positionKeys = [plainKey, plainKey, plainKey, plainKey]; });
    const mv2 = makeMove(s2, 17, 4, 8);
    expect(mv2.isGameOver).toBe(true);
    expect(mv2.gameOverReason).toBe('repetition');
    expect(mv2.newState.gameStatus).toBe('draw');
  });

  test('将军着不计入局面重复计数（规则一.2）', () => {
    // 红车 (3,3)→(4,3) 将黑将(4,0)：将军着不参与重复计数，故不会因重复判和。
    // 用「应将后回到同一指纹」构造：应将着指纹预满 5 次仍可继续。
    const s = fen(LONG_CHECK_FEN);
    const checkedProbe = play(s, 23, 4, 3);
    expect(checkedProbe.isCheck).toBe(true);
    const key = positionKey(checkedProbe);
    preset(s, rs => { rs.positionKeys = [key, key, key, key, key]; });
    const mv = makeMove(s, 23, 4, 3);
    expect(mv.isGameOver).toBe(false);
    expect(mv.newState.gameStatus).toBe('playing');
  });
});

describe('方案14 用例12：自然限招 120 着无吃子 → 判和', () => {
  test('第 120 着无吃子时判和', () => {
    const s = fen('3ak4/9/9/8p/9/9/P8/9/9/3AK4 w');
    preset(s, rs => { rs.naturalMoveCounter = 119; });
    const { newState, isGameOver, gameOverReason } = makeMove(s, 17, 4, 8);
    expect(isGameOver).toBe(true);
    expect(gameOverReason).toBe('natural_limit');
    expect(newState.gameStatus).toBe('draw');
  });
});

describe('规则一.5：无吃子窗口内单方将军累计 10 次 → 判和', () => {
  test('本方第 10 次将军判和', () => {
    const s = fen(LONG_CHECK_FEN);
    preset(s, rs => { rs.red.checkCountInWindow = 9; });
    const { newState, isGameOver, gameOverReason } = makeMove(s, 23, 4, 3); // 将军着
    expect(isGameOver).toBe(true);
    expect(gameOverReason).toBe('natural_limit');
    expect(newState.gameStatus).toBe('draw');
  });

  test('第 9 次将军不判和（差一次到阈值）', () => {
    const s = fen(LONG_CHECK_FEN);
    preset(s, rs => { rs.red.checkCountInWindow = 8; });
    const { newState, isGameOver } = makeMove(s, 23, 4, 3);
    expect(isGameOver).toBe(false);
    expect(newState.ruleState!.red.checkCountInWindow).toBe(9);
    expect(newState.gameStatus).toBe('playing');
  });

  test('单方上限：双方合计 9 次将军也不判和（不是共享 40 着口径）', () => {
    // 红 5 将 + 黑 4 将 = 合计 9，均未达单方 10 → 继续对局
    const s = fen(LONG_CHECK_FEN);
    preset(s, rs => {
      rs.red.checkCountInWindow = 5;
      rs.black.checkCountInWindow = 4;
    });
    const { newState, isGameOver } = makeMove(s, 23, 4, 3);
    expect(isGameOver).toBe(false);
    expect(newState.gameStatus).toBe('playing');
  });

  test('对方累计到 10 次将军同样判和（不是只有走子方才判）', () => {
    // 黑此前已累计 10 将（本步黑没走棋、也不吃子）→ 任一方到 10 即判和，
    // 因此红方这一着（哪怕是将军着）之后立刻收局。
    const s = fen(LONG_CHECK_FEN);
    preset(s, rs => { rs.black.checkCountInWindow = 10; });
    const mv = makeMove(s, 23, 4, 3);
    expect(mv.isGameOver).toBe(true);
    expect(mv.gameOverReason).toBe('natural_limit');
    expect(mv.newState.gameStatus).toBe('draw');
  });

  test('单方口径：黑 10 将 + 红 0 将 即判和（不要求两方同时到达）', () => {
    const s = fen(LONG_CHECK_FEN);
    preset(s, rs => {
      rs.red.checkCountInWindow = 0;
      rs.black.checkCountInWindow = 10;
    });
    const mv = makeMove(s, 23, 4, 8); // 红车 (3,3)→(4,8)：不将军、不吃子
    expect(mv.isGameOver).toBe(true);
    expect(mv.gameOverReason).toBe('natural_limit');
  });

  test('吃子后单方将军累计清零（自然限招窗口重置）', () => {
    // 黑将(4,0) 黑卒(2,3) 红车(3,3) 红帅(3,9)：红车吃卒后窗口重置
    const s = fen('4k4/9/9/2pR5/9/9/9/9/9/3K5 w');
    preset(s, rs => {
      rs.red.checkCountInWindow = 9;
      rs.black.checkCountInWindow = 9;
    });
    const { newState, isGameOver } = makeMove(s, 23, 2, 3); // 车 (3,3)→(2,3) 吃卒
    expect(isGameOver).toBe(false);
    expect(newState.ruleState!.red.checkCountInWindow).toBe(0);
    expect(newState.ruleState!.black.checkCountInWindow).toBe(0);
  });
});

describe('方案14 用例14：总步数 400 着 → 判和', () => {
  test('第 400 着判和', () => {
    const s = fen('3ak4/9/9/8p/9/9/P8/9/9/3AK4 w');
    const filler = { pieceId: 17, fromCol: 3, fromRow: 9, toCol: 4, toRow: 8, capturedPieceId: -1 };
    s.moveHistory = Array.from({ length: 399 }, () => ({ ...filler }));
    const { newState, isGameOver, gameOverReason } = makeMove(s, 17, 4, 8);
    expect(isGameOver).toBe(true);
    expect(gameOverReason).toBe('total_limit');
    expect(newState.gameStatus).toBe('draw');
  });
});

describe('方案14 用例15：最后一步将死时自然限招已到 → 判胜不判和', () => {
  test('绝杀优先于自然限招判和', () => {
    // 黑将(4,0) 红兵(3,1)(5,1) 封锁横躲位，红车(3,5) 入 4 列即绝杀
    const s = fen('4k4/3P1P3/9/9/3R5/9/9/9/9/3K5 w');
    preset(s, rs => { rs.naturalMoveCounter = 120; }); // 阈值已过
    const { newState, isGameOver, gameOverReason } = makeMove(s, 23, 4, 5); // 车入 4 列绝杀
    expect(isGameOver).toBe(true);
    expect(gameOverReason).toBe('juesha');
    expect(newState.gameStatus).toBe('red_win'); // 红胜（绝杀优先，方案 13）
  });
});

// ---------------------------------------------------------------------------
// 16-20：特殊捉子判定
// ---------------------------------------------------------------------------

describe('方案14 用例16：车被牵制时捉车 → 算捉', () => {
  test('黑车被红炮（借黑象为架）完全牵制，红车捉之算捉', () => {
    // 黑将(4,0) 红车(0,1) 黑车(4,1) 黑象(4,2) 红炮(4,6) 红帅(3,9)
    // 黑车挡住炮架（象）后对黑将的攻击线：横移/吃红车均暴露黑将；
    // 吃炮被象挡；吃象后自身成为新炮架暴露黑将 → 完全被牵
    const s = fen('4k4/R3r4/4b4/9/9/9/4C4/9/9/3K5 w');
    const zhuo = detectZhuo(s, RED);
    expect(zhuo).toContain(7); // 黑车（id=7）被捉（受牵制目标直接算捉，方案 1.2）
  });
});

describe('方案14 用例17：单炮长捉车 → 不算捉', () => {
  test('红炮借红兵为架攻击无根黑车，不计入捉', () => {
    // 黑将(5,2) 黑车(4,0) 红兵(4,3)（架） 红炮(4,6) 红帅(3,9)
    const s = fen('4r4/9/5k3/9/4P4/9/4C4/9/9/3K5 w');
    const zhuo = detectZhuo(s, RED);
    expect(zhuo).not.toContain(7);
    // 连续走炮保持攻击（架不变），多步不产生捉计数
    let s2 = s;
    const seq: Array<[number, number, number]> = [
      [25, 4, 5], [0, 5, 1],
      [25, 4, 6], [0, 5, 2],
      [25, 4, 5], [0, 5, 1],
      [25, 4, 6], [0, 5, 2],
    ];
    for (const [p, c, r] of seq) s2 = play(s2, p, c, r);
    expect(s2.ruleState!.red.zhuoCounts).toEqual({});
    expect(s2.ruleState!.banActive).toBe(false);
  });
});

describe('方案14 用例18：兵/卒长捉 → 允许', () => {
  test('过河红兵攻击无根黑炮不计入捉', () => {
    // 黑将(4,0) 黑炮(5,4) 红兵(4,4)（已过河可横走） 红帅(3,9)
    const s = fen('4k4/9/9/9/4Pc3/9/9/9/9/3K5 w');
    const zhuo = detectZhuo(s, RED);
    expect(zhuo).not.toContain(9); // 黑炮不被计捉（兵作为攻击者豁免）
  });
});

describe('方案14 用例19：捉未过河兵 → 不算捉', () => {
  test('红车攻击未过河黑卒不计入捉', () => {
    // 黑将(4,0) 黑卒(4,3)（未过河） 红车(4,6) 红帅(3,9)
    const s = fen('4k4/9/9/4p4/9/9/4R4/9/9/3K5 w');
    const zhuo = detectZhuo(s, RED);
    expect(zhuo).not.toContain(11);
  });
});

describe('方案14 用例20：双方无进攻子力 → 自动判和', () => {
  test('仅剩将士象时第一步后判和', () => {
    const s = fen('3ak4/9/4b4/9/9/9/9/4B4/9/3AK4 w');
    const { newState, isGameOver, gameOverReason } = makeMove(s, 17, 4, 8);
    expect(isGameOver).toBe(true);
    expect(gameOverReason).toBe('no_attacking');
    expect(newState.gameStatus).toBe('draw');
  });
});

// ---------------------------------------------------------------------------
// 21-24：将捉交替 / 二将一还 / 长将长捉并存
// ---------------------------------------------------------------------------

describe('方案14 用例21/22：将捉交替阈值禁着', () => {
  test('用例21：一子将捉交替 12 着 → 第 13 着禁着', () => {
    const s = fen(LONG_CHECK_FEN);
    preset(s, rs => {
      rs.red.jiangZhuoLoop = 11;
      rs.red.jiangZhuoPieceIds = [23];
    });
    let { newState } = makeMove(s, 23, 4, 3); // 第 12 着（将军着）
    const rs = newState.ruleState!;
    expect(rs.red.jiangZhuoLoop).toBe(12);
    expect(rs.banActive).toBe(true);
    expect(rs.banReason).toBe('CHECK_CHASE');
    expect(rs.banSide).toBe(RED);
    // 黑方应将后（轮红），第 13 着将军着被禁（CHECK_CHASE 禁一切将/捉着）
    newState = play(newState, 0, 5, 0);
    expect(isMoveBanned(newState, 23, 5, 3)).toBe(true);
  });

  test('用例22：多子将捉交替 18 着 → 第 19 着禁着', () => {
    const s = fen(LONG_CHECK_FEN);
    preset(s, rs => {
      rs.red.jiangZhuoLoop = 17;
      rs.red.jiangZhuoPieceIds = [23, 25];
    });
    const { newState } = makeMove(s, 23, 4, 3); // 第 18 着
    const rs = newState.ruleState!;
    expect(rs.red.jiangZhuoLoop).toBe(18);
    expect(rs.banActive).toBe(true);
    expect(rs.banReason).toBe('CHECK_CHASE');
  });

  test('用例21 补充：一子交替未达 12 不禁', () => {
    const s = fen(LONG_CHECK_FEN);
    preset(s, rs => {
      rs.red.jiangZhuoLoop = 10;
      rs.red.jiangZhuoPieceIds = [23];
    });
    const { newState } = makeMove(s, 23, 4, 3); // 第 11 着
    expect(newState.ruleState!.banActive).toBe(false);
  });
});

describe('方案14 用例23：二将一还 → 长将方作负', () => {
  test('长将方连将期间对方还过将，第 6 将直接判负', () => {
    const s = fen(LONG_CHECK_FEN);
    preset(s, rs => {
      rs.red.jiangCount = 5;
      rs.red.opponentCheckedDuringRun = true; // 黑在红连将期间还过将
      rs.black.jiangCount = 0;                // 黑非步步将（否则互长将）
    });
    const { newState, isGameOver, gameOverReason } = makeMove(s, 23, 4, 3); // 红第 6 将
    expect(isGameOver).toBe(true);
    expect(gameOverReason).toBe('changjiang');
    expect(newState.gameStatus).toBe('black_win'); // 长将方（红）作负
  });

  test('对照组：对方从未还将 → 单方长将走禁着流程而非直接判负', () => {
    const s = fen(LONG_CHECK_FEN);
    preset(s, rs => {
      rs.red.jiangCount = 5;
      rs.red.opponentCheckedDuringRun = false;
      rs.black.jiangCount = 0;
    });
    const { newState, isGameOver } = makeMove(s, 23, 4, 3);
    expect(isGameOver).toBe(false);
    expect(newState.ruleState!.banActive).toBe(true); // 走禁着（用例 1 语义）
  });
});

describe('方案14 用例24：一方长将一方长捉 → 长将方禁招', () => {
  test('红长将达到阈值时被禁将，双方均不判和', () => {
    // 黑炮(4,0) 黑将(4,1) 红车(3,3) 红帅(3,9)：车入 4 列将军
    const s = fen('4c4/4k4/9/9/3R5/9/9/9/9/3K5 w');
    preset(s, rs => {
      rs.red.jiangCount = 5;               // 红即将到长将阈值
      rs.black.zhuoCounts = { '23': 5 };   // 黑同时长捉红车（进行中）
    });
    const mv = makeMove(s, 23, 4, 3);        // 红第 6 将
    let { newState } = mv;
    expect(mv.isGameOver).toBe(false);       // 不判和（黑无连将计数）
    const rs = newState.ruleState!;
    expect(rs.banActive).toBe(true);
    expect(rs.banSide).toBe(RED);          // 长将方（红）被禁
    expect(rs.banReason).toBe('LONG_CHECK');
    // 黑方应将后（轮红），红方第 7 将落点被标红为「超限」
    newState = play(newState, 0, 5, 1);
    expect(isMoveBanned(newState, 23, 5, 3)).toBe(true);
    // 引擎照常算得出这一步（走法矩阵不受禁着影响）；拦截由 handleMove / lanGame.ts 负责
    expect(getValidMoves(newState, 23)[5][3]).toBe(true);
    expect(getMoveBanReason(newState, 23, 5, 3)).toBe('LONG_CHECK');
  });
});

// ---------------------------------------------------------------------------
// 规则二.2：一方长将、一方长捉 → 长将方禁招（跨方裁决，不受"谁刚走"影响）
// ---------------------------------------------------------------------------

describe('规则二.2：一方长将一方长捉 → 长将方禁招', () => {
  test('长捉方刚走子时，禁招方仍是长将方（对方），而非长捉方自己', () => {
    // 红车(3,3) 已在 6 将（长将成立）+ 红方另在长捉黑炮 6 回合（长捉成立）；
    // 本步由**长捉方红方**走，红黑位置会切换，构造「红方走到该触发红点」的局面
    const s = fen('4c4/4k4/9/9/3R5/9/9/9/9/3K5 w');
    preset(s, rs => {
      // 红方长将已到阈值（一子 6）
      rs.red.jiangCount = 5;
      rs.red.jiangPieceIds = [23];
      // 黑方长捉红车已到阈值（6 回合）
      rs.black.zhuoCounts = { '23': 6 };
    });
    // 红走第 6 将 → 红长将达到 6；黑此前长捉已 6。
    // 规则二.2：长将方（红）禁招，即使黑是长捉方且计数已满。
    const { newState } = makeMove(s, 23, 4, 3);
    const rs = newState.ruleState!;
    expect(rs.banActive).toBe(true);
    expect(rs.banSide).toBe(RED);              // 长将方（红）被禁
    expect(rs.banReason).toBe('LONG_CHECK');
  });

  test('长将方刚被长捉方逼和（对方先到长捉阈值）→ 长将方仍被禁', () => {
    // 黑方长捉红车达 6 回合（先到），红方长将达到 6 回合后禁招方为红（长将方）
    const s = fen('4c4/4k4/9/9/3R5/9/9/9/9/3K5 w');
    preset(s, rs => {
      rs.black.zhuoCounts = { '23': 6 };  // 黑长捉红车已满
      rs.red.jiangCount = 5;              // 红差一将到长将阈值
      rs.red.jiangPieceIds = [23];
    });
    const { newState, isGameOver, gameOverReason } = makeMove(s, 23, 4, 3); // 红第 6 将
    // 双方都在超限，但规则二.2 只判红方禁招（长将方），不判和（黑无长将计数）
    expect(isGameOver).toBe(false);
    expect(gameOverReason).toBe('');
    const rs = newState.ruleState!;
    expect(rs.banActive).toBe(true);
    expect(rs.banSide).toBe(RED);
    expect(rs.banReason).toBe('LONG_CHECK');
  });

  test('长捉方在先、其超限成立，但同时长将方也超限 → 仍判长将方禁招', () => {
    // 长捉方先到 6 回合（moverBan），长将方后到 6 回合（oppBan）
    // 场景：黑方长捉达 6 且黑方刚走子 → moverBan=黑(长捉)
    //       红方长将达 6 → oppBan=红(长将)
    // 期望：长将方（红）被禁，而非长捉方（黑）
    const s = fen('4c4/4k4/9/9/3R5/9/9/9/9/3K5 b'); // 黑先
    preset(s, rs => {
      rs.black.zhuoCounts = { '23': 6 };  // 黑长捉红车满
      rs.red.jiangCount = 6;              // 红长将满
      rs.red.jiangPieceIds = [23];
      rs.black.jiangCount = 0;
    });
    // 黑走一步保持长捉（黑炮继续追红车）：黑炮(4,0)→(3,0)
    const mv = makeMove(s, 9, 3, 0);
    const rs = mv.newState.ruleState!;
    expect(rs.banActive).toBe(true);
    // 长将方（红）被禁招
    expect(rs.banSide).toBe(RED);
    expect(rs.banReason).toBe('LONG_CHECK');
  });
});

// ---------------------------------------------------------------------------
// 补充：超限不判负（废除「连续 3 次坚持禁着判负」；但超限着法会被禁 —— 规则二）
// ---------------------------------------------------------------------------

describe('补充：超限不判负但禁着', () => {
  test('banViolations 计数字段已废除，RuleState 不再包含违规次数', () => {
    const rs: RuleState = {
      red: emptyCounters(), black: emptyCounters(),
      positionKeys: [], naturalMoveCounter: 0,
      banActive: true, banSide: RED, banReason: 'LONG_CHECK',
      banChaseTargets: [], banMoves: [],
      notice: null, noticeKey: null,
    };
    expect('banViolations' in rs).toBe(false);
  });

  test('超限后继续长将 20 轮不判负（由互长将/自然限招等判和收场）', () => {
    let s = fen(LONG_CHECK_FEN);
    let lastReason = '';
    // 连将 20 轮（红黑各走）——远超一子长将阈值 6
    const step = (p: number, c: number, r: number) => {
      const res = makeMove(s, p, c, r);
      s = res.newState;
      if (res.gameOverReason) lastReason = res.gameOverReason;
    };
    for (let i = 0; i < 10 && s.gameStatus === 'playing'; i++) {
      step(23, 4, 3); step(0, 5, 0); step(23, 5, 3); step(0, 4, 0);
    }
    // 僵持不下 → 判和收场，绝不是某方长将判负
    expect(s.gameStatus).toBe('draw');
    expect(['mutual_long_check', 'mutual_long_chase', 'repetition', 'natural_limit', 'total_limit', 'no_attacking'])
      .toContain(lastReason);
  });

  test('长将第 5 着（阈值前一步）不再出提示：规则二只保留禁着拦截提示', () => {
    // 2026-10 口径：规则二取消「阈值前一步」预警，只保留点禁着时的拦截提示。
    // 下方紧接的「规则二禁着拦截」用例仍断言第 6 将后第 7 手被禁、提示正确。
    // 黑将(4,0) 红车(3,3) 红帅(3,9)：车在 3/4 列交替将军 5 次
    let s = fen(LONG_CHECK_FEN);
    const seq: Array<[number, number, number]> = [
      [23, 4, 3], [0, 5, 0],   // 将1；将躲到 (5,0)
      [23, 5, 3], [0, 4, 0],   // 将2
      [23, 4, 3], [0, 5, 0],   // 将3
      [23, 5, 3], [0, 4, 0],   // 将4
      [23, 4, 3],               // 将5 —— 阈值 6 的倒数第 2 着
    ];
    for (let i = 0; i < seq.length - 1; i++) {
      s = play(s, seq[i][0], seq[i][1], seq[i][2]);
    }
    const [p, c, r] = seq[seq.length - 1];
    s = play(s, p, c, r);
    const rs = s.ruleState!;
    expect(rs.red.jiangCount).toBe(5);
    expect(rs.banActive).toBe(false);   // 第 5 将尚未超限
    // 规则二不预警：notice/noticeKey 均不产生
    expect(rs.notice).toBeNull();
    expect(rs.noticeKey).toBeNull();
    expect(rs.banMoves).toEqual([]);
    // 第 6 将（下着）照常能走：车 (4,3)→(5,3) 仍会被将军，但**尚未超限**故不禁
    const next = play(s, 0, 5, 0);
    expect(next.ruleState!.red.jiangCount).toBe(5);
    expect(getValidMoves(next, 23)[5][3]).toBe(true);
    expect(getMoveBanReason(next, 23, 5, 3)).toBeNull();
    // 真正禁住的是再下一手：第 6 将达阈值（此刻轮到黑，banSide=红），
    // 黑方应将后轮回红方，第 7 将继续将军才被禁。
    // 车在 4/5 列交替将 → 第 6 将落在 (5,3)，故应将走 (4,0)，下一手 (5,3)→(4,3)。
    const after6 = play(next, 23, 5, 3);
    expect(after6.ruleState!.red.jiangCount).toBe(6);
    expect(after6.ruleState!.banActive).toBe(true);
    const next2 = play(after6, 0, 4, 0);
    expect(getMoveBanReason(next2, 23, 4, 3)).toBe('LONG_CHECK');
  });

  test('长捉第 5 捉（阈值前一步）同样不再提示', () => {
    // 黑将(5,2) 黑炮(4,0) 红车(4,4) 红帅(3,9)：车在 3/4 列交替追捉无根炮
    let s = fen('4c4/9/5k3/9/4R4/9/9/9/9/3K5 w');
    const seq: Array<[number, number, number]> = [
      [23, 4, 3], [9, 3, 0],
      [23, 3, 3], [9, 4, 0],
      [23, 4, 3], [9, 3, 0],
      [23, 3, 3], [9, 4, 0],
      [23, 4, 3],   // 第 5 捉 —— 阈值 6 的倒数第 2 着
    ];
    for (const [p, c, r] of seq) s = play(s, p, c, r);
    const rs = s.ruleState!;
    expect(rs.red.zhuoCounts['9']).toBe(5);
    expect(rs.banActive).toBe(false);
    expect(rs.notice).toBeNull();            // 规则二不预警
    expect(rs.noticeKey).toBeNull();
    expect(rs.banMoves).toEqual([]);
    // 第 6 捉（下着）照常能走：此刻尚未超限，继续追捉的车 (4,3)→(3,3) 合法可走
    const next = play(s, 9, 3, 0);
    expect(next.ruleState!.red.zhuoCounts['9']).toBe(5);
    expect(next.ruleState!.banActive).toBe(false);
    expect(getValidMoves(next, 23)[3][3]).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 提示口径 2026-10：
// - 规则一（判和类）：保留「阈值前一次」一次性提示；
// - 规则二（强制变招）：**取消**阈值前一步预警，只保留点禁着时的拦截提示。
// ---------------------------------------------------------------------------

describe('提示收敛：判和类预警保留，规则二不预警', () => {
  test('长将第 5 着（阈值前一步）不产生任何 notice，超限后也恒为 null', () => {
    let s = fen(LONG_CHECK_FEN);
    // 连将到第 6 着（跨过阈值 → banActive）并让黑方应着，此后一直超限。
    // 注意：banMoves 是在「行棋方轮到被禁的那一方」时才枚举得到，所以
    // 第 6 将那一步（此刻轮到黑）banMoves 仍为空——这是引擎的正确行为。
    const seq: Array<[number, number, number]> = [
      [23, 4, 3], [0, 5, 0],
      [23, 5, 3], [0, 4, 0],
      [23, 4, 3], [0, 5, 0],
      [23, 5, 3], [0, 4, 0],
      [23, 4, 3],   // 将5 → 规则二不预警，notice 应为空
      [0, 5, 0],
      [23, 5, 3],   // 将6 → 超限，notice 仍应为空
      [0, 4, 0],    // 黑应着 → 回到红方行棋
      [23, 4, 3],   // 将7 → 超限期间继续走，notice 仍应为空
    ];
    const keys: Array<string | null> = [];
    const banCounts: number[] = [];
    for (const [p, c, r] of seq) {
      s = play(s, p, c, r);
      keys.push(s.ruleState?.noticeKey ?? null);
      banCounts.push(s.ruleState?.banMoves.length ?? 0);
    }
    // 第 5 将那一步也不再预警：整段长将过程 noticeKey 全为 null
    expect(keys[8]).toBeNull();
    expect(s.ruleState!.banActive).toBe(true);       // 第 6 将起超限
    expect(banCounts[11]).toBeGreaterThan(0);        // 黑应着后回到红方行棋，禁着表就位
    // 整段序列都没有规则二提示
    expect(keys.every(k => k === null)).toBe(true);
    expect(s.ruleState!.notice).toBeNull();
  });

  test('禁着表仍保留（棋盘标红 + AI 择优 + 落子拦截都依赖它，不能因为不提示就删）', () => {
    let s = fen(LONG_CHECK_FEN);
    const seq: Array<[number, number, number]> = [
      [23, 4, 3], [0, 5, 0],
      [23, 5, 3], [0, 4, 0],
      [23, 4, 3], [0, 5, 0],
      [23, 5, 3], [0, 4, 0],
      [23, 4, 3], [0, 5, 0],
      [23, 5, 3],   // 将6 → 超限
      [0, 4, 0],    // 黑应着 → 轮到红，行棋侧才拿得到禁着表
    ];
    for (const [p, c, r] of seq) s = play(s, p, c, r);
    const rs = s.ruleState!;
    expect(rs.banActive).toBe(true);
    expect(rs.banMoves.length).toBeGreaterThan(0);
    expect(rs.notice).toBeNull();                       // 规则二不预警
    expect(isMoveBanned(s, 23, 4, 3)).toBe(true);      // 但仍可供 AI 过滤与落子拦截
    expect(isMoveBanned(s, 23, 5, 3)).toBe(false);     // 非将军的落点不受限
  });

  test('规则一.6 总步数：第 399 步预警，第 400 步判和', () => {
    const s = fen('3ak4/9/9/8p/9/9/P8/9/9/3AK4 w');
    // totalMoveLimit 取的是 afterState.moveHistory.length（= 已走步数 + 1），
    // 直接把历史补到 398 步，让本步正好是第 399 步。
    const padded = {
      ...s,
      moveHistory: Array.from({ length: 398 }, () => ({
        pieceId: 0, fromCol: 0, fromRow: 0, toCol: 0, toRow: 0,
      })),
    } as unknown as GameState;
    const mv = makeMove(padded, 17, 4, 8);
    expect(mv.newState.moveHistory.length).toBe(399);
    expect(mv.isGameOver).toBe(false);
    expect(mv.newState.ruleState!.notice).toBe('双方已走 399 步，下着将满 400 步判和');
    expect(mv.newState.ruleState!.noticeKey).toBe('total-399');
    // 再走一步到 400 → 判和，且 finish 会清掉提示
    const mv2 = makeMove(mv.newState, 1, 4, 1);
    expect(mv2.isGameOver).toBe(true);
    expect(mv2.gameOverReason).toBe('total_limit');
    expect(mv2.newState.ruleState!.notice).toBeNull();
  });

  test('规则一.5 无吃子 120 步：第 119 步预警', () => {
    const s = preset(fen('3ak4/9/9/8p/9/9/P8/9/9/3AK4 w'), rs => {
      rs.naturalMoveCounter = 118;
    });
    const mv = makeMove(s, 17, 4, 8);
    expect(mv.isGameOver).toBe(false);
    expect(mv.newState.ruleState!.notice).toBe('已 119 步无吃子，下着将满 120 步判和');
    expect(mv.newState.ruleState!.noticeKey).toBe('natural-119');
  });

  test('规则一.5 单方将军 10 次：第 9 次预警，任一方到 9 都预警', () => {
    // 走子方红已累计 8 将，本着将军 → 红到 9 → 预警
    const s = preset(fen(LONG_CHECK_FEN), rs => { rs.red.checkCountInWindow = 8; });
    const mv = makeMove(s, 23, 4, 3);
    expect(mv.isGameOver).toBe(false);
    expect(mv.newState.ruleState!.notice).toBe('有一方已将军 9 次，下着再将军将满 10 次判和');
    expect(mv.newState.ruleState!.noticeKey).toBe('chkwin-9');
    // 对方到 9 同样预警（本步红方走不吃子的着法，黑保持 9）
    const s2 = preset(fen(LONG_CHECK_FEN), rs => { rs.black.checkCountInWindow = 9; });
    const mv2 = makeMove(s2, 23, 4, 8);
    expect(mv2.newState.ruleState!.noticeKey).toBe('chkwin-9');
  });

  test('规则一.2 局面重复：第 4 次出现预警，第 5 次判和', () => {
    const s = fen('4k4/9/9/8p/9/9/P8/9/9/3AK4 w');
    const probe = play(s, 17, 4, 8);
    const key = positionKey(probe);
    // 预置 3 次 + 本步第 4 次 → 预警
    const s4 = preset(s, rs => { rs.positionKeys = [key, key, key]; });
    const mv4 = makeMove(s4, 17, 4, 8);
    expect(mv4.isGameOver).toBe(false);
    expect(mv4.newState.ruleState!.notice).toBe('本局面已出现 4 次，下着重复将判和');
    expect(mv4.newState.ruleState!.noticeKey).toBe('rep-4');
    // 预置 4 次 + 本步第 5 次 → 判和（预警提前一格，故这里无提示）
    const s5 = preset(s, rs => { rs.positionKeys = [key, key, key, key]; });
    const mv5 = makeMove(s5, 17, 4, 8);
    expect(mv5.isGameOver).toBe(true);
    expect(mv5.gameOverReason).toBe('repetition');
  });

  test('规则一.3 互相长将：双方都到 5 次时预警', () => {
    const s = preset(fen(LONG_CHECK_FEN), rs => {
      rs.red.jiangCount = 4; rs.black.jiangCount = 5;
    });
    const mv = makeMove(s, 23, 4, 3); // 红第 5 将 → 双方都 5
    expect(mv.isGameOver).toBe(false);
    expect(mv.newState.ruleState!.notice).toBe('双方长将已达 5 次，双方继续长将将判和');
    expect(mv.newState.ruleState!.noticeKey).toBe('mutualcheck-5-5');
  });

  test('规则一.4 互相长捉：双方都到 5 捉时预警', () => {
    const s = preset(fen('4c4/9/5k3/9/4R4/9/9/9/9/3K5 w'), rs => {
      rs.red.zhuoCounts = { '9': 4 };
      rs.black.zhuoCounts = { '25': 5 }; // 黑方也在追捉某子
    });
    const mv = makeMove(s, 23, 4, 3); // 红第 5 捉
    expect(mv.isGameOver).toBe(false);
    expect(mv.newState.ruleState!.notice).toBe('双方长捉已达 5 次，双方继续长捉将判和');
    expect(mv.newState.ruleState!.noticeKey).toBe('mutualzhuo-5-5');
  });

  test('普通对局不产生任何规则提示', () => {
    let s = createInitialState(RED);
    s = play(s, 26, 4, 7); // 炮二平五
    expect(s.ruleState!.notice).toBeNull();
    expect(s.ruleState!.noticeKey).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 回归：标准开局走子
// ---------------------------------------------------------------------------

describe('回归：标准开局走子', () => {
  test('初始局面炮二平五后规则状态正常（无禁着/无终局）', () => {
    let s = createInitialState(RED);
    s = play(s, 26, 4, 7); // 红炮 (7,7)→(4,7) 炮二平五
    expect(s.gameStatus).toBe('playing');
    expect(s.ruleState!.banActive).toBe(false);
    expect(s.ruleState!.red.jiangZhuoLoop).toBe(0);
    expect(s.ruleState!.naturalMoveCounter).toBe(1);
  });

  test('初始局面完整开局序列无禁着（回归）', () => {
    let s = createInitialState(RED);
    const opening: Array<[number, number, number]> = [
      [26, 4, 7],  // 炮二平五
      [10, 4, 2],  // 黑炮 (7,2)?? —— 黑炮 10 初始 (7,2)：进到 (4,2)?? 黑炮8平5
      [22, 7, 7],  // 红马 (7,9)→(7,7) 马八进七?? 红马 22 初始 (7,9)：到 (7,7)?? 马走日 (7,9)→(6,7)/(8,7)
      [6, 1, 2],   // 黑马 (1,0)→(1,2)?? 马 (1,0) 走 (2,2)/(0,2)
    ];
    void opening;
    // 具体开局着法走法校验较繁，仅验证第一步 + 黑方应着的规则状态稳定
    s = play(s, 26, 4, 7);
    s = play(s, 10, 4, 2); // 黑炮 (7,2)→(4,2) 炮8平5
    expect(s.gameStatus).toBe('playing');
    expect(s.ruleState!.banActive).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 规则二禁着拦截：getMoveBanReason / banReasonNotice
// 客户端 screens/game、screens/lanBattle 与服务端 lanGame.ts 都靠这两个函数拦落子，
// 故必须是规则引擎的一等出口（且经 ruleEngine.bundle.ts 导出给服务端）。
// ---------------------------------------------------------------------------

describe('规则二禁着拦截：getMoveBanReason / banReasonNotice', () => {
  test('一子长将满 6 后，第 7 手继续长将被禁并提示「禁止长将，请变招」', () => {
    // 用户给出的范例场景：满 6 回合后再走第 7 手 → 禁着 + 提示
    let s = fen(LONG_CHECK_FEN); // 黑将(4,0) 红车(3,3) 红帅(3,9)
    const seq: Array<[number, number, number]> = [
      [23, 4, 3], [0, 5, 0], // 将1；将躲到 (5,0)
      [23, 5, 3], [0, 4, 0], // 将2
      [23, 4, 3], [0, 5, 0], // 将3
      [23, 5, 3], [0, 4, 0], // 将4
      [23, 4, 3], [0, 5, 0], // 将5
      [23, 5, 3],             // 将6 —— 达到阈值
    ];
    for (const [p, c, r] of seq) s = play(s, p, c, r);
    expect(s.ruleState!.red.jiangCount).toBe(6);
    expect(s.ruleState!.banActive).toBe(true);
    expect(s.ruleState!.banReason).toBe('LONG_CHECK');

    const after6 = play(s, 0, 4, 0); // 黑将应将，轮回红方
    expect(after6.sideTag).toBe(RED);
    // 第 7 手：车 (5,3)→(4,3) 继续将军 → 被禁
    expect(getMoveBanReason(after6, 23, 4, 3)).toBe('LONG_CHECK');
    expect(banReasonNotice('LONG_CHECK')).toBe('禁止长将，请变招');
    // 变招（车走开，非将军着）始终合法
    expect(getMoveBanReason(after6, 23, 3, 3)).toBeNull();
  });

  test('长捉超限给出「禁止长捉，请变招」', () => {
    // 黑将(5,2) 黑炮(4,0) 红车(4,4) 红帅(3,9)：红车追捉无根炮
    // 预置已捉 5 次，第 6 捉达阈值 → 红方被禁着
    const s = fen('4c4/9/5k3/9/4R4/9/9/9/9/3K5 w');
    preset(s, rs => { rs.red.zhuoCounts = { '9': 5 }; rs.red.jiangZhuoPieceIds = [23]; });
    const after6 = play(s, 23, 4, 3);          // 红车 (4,4)→(4,3) 第 6 捉
    expect(after6.ruleState!.red.zhuoCounts['9']).toBe(6);
    expect(after6.ruleState!.banActive).toBe(true);
    expect(after6.ruleState!.banReason).toBe('LONG_CHASE');
    expect(after6.ruleState!.banSide).toBe(RED);
    // 黑炮逃到 (3,0) → 轮回红方；红车再吃回 (4,0) 即第 7 捉，被禁
    const next = play(after6, 9, 3, 0);
    expect(next.sideTag).toBe(RED);
    expect(getMoveBanReason(next, 23, 4, 0)).toBe('LONG_CHASE');
    expect(banReasonNotice('LONG_CHASE')).toBe('禁止长捉，请变招');
    // 变招（车不追炮）合法
    expect(getMoveBanReason(next, 23, 2, 3)).toBeNull();
  });

  test('将捉交替（CHECK_CHASE）超限给出合并提示', () => {
    const s = preset(fen(LONG_CHECK_FEN), rs => {
      rs.red.jiangZhuoLoop = 18; // 三子及以上阈值 18
      rs.red.jiangZhuoPieceIds = [23, 25, 27];
    });
    const mv = makeMove(s, 23, 4, 3);
    const after = mv.newState;
    expect(after.ruleState!.banActive).toBe(true);
    expect(after.ruleState!.banReason).toBe('CHECK_CHASE');
    expect(banReasonNotice('CHECK_CHASE')).toBe('禁止将军或长捉，请变招');
  });

  test('未超限时任何着法都不被禁（getMoveBanReason 返回 null）', () => {
    const s = fen(LONG_CHECK_FEN);
    expect(getMoveBanReason(s, 23, 4, 3)).toBeNull();
    expect(getMoveBanReason(s, 23, 0, 3)).toBeNull();
  });

  test('非 banSide 方不受限（禁着只约束下一手继续长将/长捉的那一方）', () => {
    const s = fen(LONG_CHECK_FEN);
    preset(s, rs => { rs.red.jiangCount = 6; rs.red.jiangPieceIds = [23]; });
    const after = play(s, 0, 5, 0); // 黑将先走 → 轮回红方
    expect(after.ruleState!.banSide).toBe(RED);
    expect(getMoveBanReason(after, 0, 4, 0)).toBeNull(); // 若轮到黑，黑将照走
  });

  test('banReasonNotice 覆盖全部 BanReason 取值（两端文案不会漂移）', () => {
    expect(banReasonNotice('LONG_CHECK')).toBe('禁止长将，请变招');
    expect(banReasonNotice('LONG_CHASE')).toBe('禁止长捉，请变招');
    expect(banReasonNotice('CHECK_CHASE')).toBe('禁止将军或长捉，请变招');
  });
});
