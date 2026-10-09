/**
 * 皮卡鱼 UCI 协议层单测
 *
 * 覆盖三类容易出错、且出错后**症状很隐蔽**的地方：
 *   1. 坐标换算（row = 9 - rank）——错了会让 AI 在"另一个局面"里下棋；
 *   2. 多候选收集——只有同一深度层内才可混用，否则会选到过期着法；
 *   3. 命令序列——`position` 带 moves 时引擎会**完全忽略** fen。
 */

import {
  uciToInternal,
  internalToUci,
  isValidUciMove,
  isValidUciMoveList,
  buildPosition,
  buildGo,
  buildSearchCommands,
  buildSetOption,
  parseBestmove,
  consumeEngineLine,
  createUciInfoState,
  chooseUci,
  isCriticalErrorLine,
  isQuitLine,
  isUciOkLine,
  isReadyOkLine,
  isBannerLine,
  parseOptionName,
  CMD_STOP,
  CMD_UCINEW_GAME,
} from '../pikafishUci';

describe('UCI 坐标换算', () => {
  it('内部坐标 → UCI：row 0 是黑方底线，映射到 rank 9', () => {
    // 内部 (col=4,row=0) 是黑方底线中卒/将位 → UCI e9
    expect(internalToUci({ fromCol: 4, fromRow: 0, toCol: 4, toRow: 1 })).toBe('e9e8');
  });

  it('内部 (0,0) → a9（黑方底线左角）', () => {
    expect(internalToUci({ fromCol: 0, fromRow: 0, toCol: 1, toRow: 1 })).toBe('a9b8');
  });

  it('UCI → 内部：与 toUci 互为逆运算', () => {
    const cases = [
      { fromCol: 0, fromRow: 0, toCol: 1, toRow: 1 },
      { fromCol: 8, fromRow: 9, toCol: 7, toRow: 8 },
      { fromCol: 4, fromRow: 5, toCol: 4, toRow: 4 },
      { fromCol: 2, fromRow: 3, toCol: 6, toRow: 7 },
    ];
    for (const c of cases) {
      const uci = internalToUci(c);
      expect(uci).not.toBeNull();
      expect(uciToInternal(uci as string)).toEqual(c);
    }
  });

  it('炮二平五（内部 (7,7)→(7,4)）应换算成 h2h5', () => {
    // 内部 row 7 是红方炮的初始行（QIZI_INIT_POSITION 红炮在 [7,7]）
    expect(internalToUci({ fromCol: 7, fromRow: 7, toCol: 7, toRow: 4 })).toBe('h2h5');
  });

  it('非法 UCI 返回 null（绝不猜一个落点）', () => {
    expect(uciToInternal('')).toBeNull();
    expect(uciToInternal('zz9z8')).toBeNull();
    expect(uciToInternal('j1j2')).toBeNull();       // 列 j 越界
    expect(uciToInternal('a1a1a1')).toBeNull();    // 位数不对
    expect(internalToUci({ fromCol: 9, fromRow: 0, toCol: 0, toRow: 0 })).toBeNull();
    expect(internalToUci({ fromCol: 0, fromRow: 10, toCol: 0, toRow: 0 })).toBeNull();
  });

  it('UCI rank 0 = 黑方底线 = 内部 row 9（不是越界）', () => {
    // 这是最容易搞反的一处：UCI 的 rank 0 是**黑方底线**，
    // 对应项目内部 row 9（红方 row 0 才是 rank 9）。
    expect(uciToInternal('a0a1')).toEqual({ fromCol: 0, fromRow: 9, toCol: 0, toRow: 8 });
    expect(internalToUci({ fromCol: 0, fromRow: 9, toCol: 0, toRow: 8 })).toBe('a0a1');
  });

  it('UCI 合法性校验与格式一致', () => {
    expect(isValidUciMove('b2e2')).toBe(true);
    expect(isValidUciMove('b2e')).toBe(false);
    expect(isValidUciMoveList(['b2e2', 'h2e2'])).toBe(true);
    expect(isValidUciMoveList(['b2e2', 'X9'])).toBe(false);
  });
});

describe('position 命令构造', () => {
  it('无着法历史时只发 fen', () => {
    expect(buildPosition('rnbakabnr/9/1c5c1/9/9/9/9/9/9/RNBAKABNR w', [])).toBe(
      'position fen rnbakabnr/9/1c5c1/9/9/9/9/9/9/RNBAKABNR w'
    );
  });

  it('带历史时追加 moves', () => {
    expect(buildPosition('abc w', ['h2e2', 'h9g7'])).toBe('position fen abc w moves h2e2 h9g7');
  });

  it('带 moves 时绝不同时塞第二个 fen（引擎会忽略 fen，行为不可预期）', () => {
    const cmd = buildPosition('start w', ['h2e2']);
    // 整条命令里只允许出现一次 "position fen"，且后面跟的是 startFen
    expect(cmd.match(/position fen/g)).toHaveLength(1);
    expect(cmd).toBe('position fen start w moves h2e2');
  });
});

describe('go 命令构造', () => {
  const base = {
    startFen: 'x w',
    moves: [] as string[],
    multiPV: 1,
    depth: 8,
    movetimeMs: 8000,
    randomPick: false,
  };

  it('同时给 depth 与 movetime（depth 收敛，movetime 兜底）', () => {
    const go = buildGo(base);
    expect(go).toContain('go');
    expect(go).toContain('depth 8');
    expect(go).toContain('movetime 8000');
  });

  it('有 searchmoves 时附加白名单', () => {
    const go = buildGo({ ...base, searchmoves: ['h2e2', 'b2e2'] });
    expect(go).toContain('searchmoves h2e2 b2e2');
  });

  it('无 searchmoves 时不出现该子句', () => {
    expect(buildGo(base)).not.toContain('searchmoves');
    expect(buildGo({ ...base, searchmoves: [] })).not.toContain('searchmoves');
  });

  it('setoption 能设置数值与布尔', () => {
    expect(buildSetOption('MultiPV', 2)).toBe('setoption name MultiPV value 2');
    expect(buildSetOption('Ponder', true)).toBe('setoption name Ponder value true');
    expect(buildSetOption('Clear Hash')).toBe('setoption name Clear Hash');
  });

  it('搜索命令序列顺序：ucinewgame → MultiPV → position → go', () => {
    const cmds = buildSearchCommands(base);
    expect(cmds[0]).toBe(CMD_UCINEW_GAME);
    expect(cmds[1]).toBe('setoption name MultiPV value 1');
    expect(cmds[2]).toMatch(/^position fen /);
    expect(cmds[3]).toMatch(/^go /);
  });
});

describe('引擎输出解析', () => {
  it('识别握手与横幅', () => {
    expect(isUciOkLine('uciok')).toBe(true);
    expect(isReadyOkLine('readyok')).toBe(true);
    expect(isUciOkLine('id name Pikafish')).toBe(false);
    expect(isBannerLine('Pikafish dev-20240226-98b20a33 by the Pikafish developers')).toBe(true);
    expect(isBannerLine('id author the Pikafish developers')).toBe(true);
    expect(isBannerLine('info depth 1')).toBe(false);
  });

  it('解析 option 名与致命错误 / 退出', () => {
    expect(parseOptionName('option name MultiPV type spin default 1 min 1 max 128')).toBe('MultiPV');
    expect(parseOptionName('option name Clear Hash type button')).toBe('Clear');
    expect(parseOptionName('info depth 1')).toBeNull();
    expect(isCriticalErrorLine('info string CRITICAL ERROR: illegal position')).toBe(true);
    expect(isQuitLine('quit')).toBe(true);
    expect(isQuitLine('info depth 3')).toBe(false);
  });

  it('bestmove 解析；(none) 与非法返回 null', () => {
    expect(parseBestmove('bestmove b2e2')).toBe('b2e2');
    expect(parseBestmove('bestmove h2e2 ponder h9g7')).toBe('h2e2');
    expect(parseBestmove('bestmove (none)')).toBeNull();
    expect(parseBestmove('info depth 5')).toBeNull();
  });

  it('累积 depth / time / 候选', () => {
    const st = createUciInfoState();
    consumeEngineLine('info depth 1 seldepth 6 multipv 1 score cp -11 nodes 123 time 4 pv b0c2', st);
    consumeEngineLine('info depth 2 multipv 1 score cp 0 nodes 205 time 5 pv b2e2', st);
    expect(st.depth).toBe(2);
    expect(st.timeMs).toBe(5);
    expect(chooseUci(st, false)).toEqual({ uci: 'b2e2', candidates: ['b2e2'] });
  });

  it('MultiPV=2 时收集两条候选，且按 pv 序号排序', () => {
    const st = createUciInfoState();
    consumeEngineLine('info depth 4 multipv 1 score cp 10 time 5 pv h2e2', st);
    consumeEngineLine('info depth 4 multipv 2 score cp 5 time 5 pv b2e2', st);
    const picked = chooseUci(st, false);
    expect(picked?.candidates).toEqual(['h2e2', 'b2e2']);
    // 非随机取第一条（主变）
    expect(picked?.uci).toBe('h2e2');
  });

  it('出现更深一层时清掉浅层候选（混用会选到过期着法）', () => {
    const st = createUciInfoState();
    consumeEngineLine('info depth 4 multipv 1 time 5 pv h2e2', st);
    consumeEngineLine('info depth 4 multipv 2 time 5 pv b2e2', st);
    // 进入 depth 5：浅层两条都应被丢弃，只留 depth 5 的
    consumeEngineLine('info depth 5 multipv 1 time 6 pv c3c4', st);
    const picked = chooseUci(st, false);
    expect(picked?.candidates).toEqual(['c3c4']);
    expect(st.depth).toBe(5);
  });

  it('randomPick 从候选中取指定那一条（注入 rand 保证可复现）', () => {
    const st = createUciInfoState();
    consumeEngineLine('info depth 4 multipv 1 time 5 pv h2e2', st);
    consumeEngineLine('info depth 4 multipv 2 time 5 pv b2e2', st);
    expect(chooseUci(st, true, () => 0)?.uci).toBe('h2e2');
    expect(chooseUci(st, true, () => 0.99)?.uci).toBe('b2e2');
  });

  it('无候选时返回 null（交由上层报错，不凭空造落点）', () => {
    const st = createUciInfoState();
    expect(chooseUci(st, false)).toBeNull();
  });

  it('bestmove 行被识别为"搜索结束"信号', () => {
    const st = createUciInfoState();
    expect(consumeEngineLine('bestmove b2e2', st)).toBe(true);
    expect(consumeEngineLine('info depth 6 pv b2e2', st)).toBe(false);
    expect(consumeEngineLine('', st)).toBe(false);
    expect(CMD_STOP).toBe('stop');
  });
});
