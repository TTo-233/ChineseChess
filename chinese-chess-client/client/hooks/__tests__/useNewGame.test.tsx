/**
 * @/hooks/useNewGame（第 3 批抽出）—— 唯一一份「新局重置」
 *
 * 抽出前，同一份 15 行重置序列在 `screens/game/index.tsx` 里有三份手工副本
 * （确认重开 / 再来一局 / 残局下一关）。CODE_AUDIT.md §8 表记的失效模式就是
 * 「同一语义多处实现，新增字段时漏掉其中一份」。本测试因此钉的是**字段全量覆盖**：
 * 少一个字段的测试必须在新增字段时失败，否则去重就白做了。
 *
 * GameEngine / AIEngine 被整体 mock：这里只关心「谁被调用、顺序如何」，
 * 不关心引擎内部的局面正确性。
 */

import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import {
  useNewGame,
  buildGameStateFromFen,
  buildInitialGameState,
  ENDGAME_HINT_LIMIT,
  ENDGAME_UNDO_LIMIT,
  type UseNewGameApi,
  type UseNewGameArgs,
} from '@/hooks/useNewGame';
import { getHandle, registerHandle, setHandle } from './hookHandle';

// 名字必须以 mock 开头：jest.mock 的工厂函数不允许闭包引用普通外部变量
const mockCreateInitialState = jest.fn();
const mockCreateFromFen = jest.fn();
const mockComputeZobristHash = jest.fn();
const mockClearHistoryHash = jest.fn();
const mockRecordHistoryHash = jest.fn();
const mockPrecomputeOfflineHint = jest.fn();
const mockNotifyOfflineNewGame = jest.fn();

jest.mock('@/utils/chess/GameEngine', () => ({
  createInitialState: (...args: unknown[]) => mockCreateInitialState(...args),
  createFromFen: (...args: unknown[]) => mockCreateFromFen(...args),
}));

jest.mock('@/utils/chess/AIEngine', () => ({
  computeZobristHash: (...args: unknown[]) => mockComputeZobristHash(...args),
  clearHistoryHash: (...args: unknown[]) => mockClearHistoryHash(...args),
  recordHistoryHash: (...args: unknown[]) => mockRecordHistoryHash(...args),
}));

// ⚠️ 提示预计算已从「旧 TS AI」迁到「本地皮卡鱼」（2026-10 审计 P1-8：
//    useNewGame 仍在调 AIEngine.precomputeHint，而提示早已改由本地引擎出，
//    那条链路的跑分结果不会被消费，只白占主线程）。
// 这里 mock 的是新的 offlineAiAdapter 入口。
jest.mock('@/utils/chess/offlineAiAdapter', () => ({
  precomputeOfflineHint: (...args: unknown[]) => mockPrecomputeOfflineHint(...args),
  notifyOfflineNewGame: (...args: unknown[]) => mockNotifyOfflineNewGame(...args),
}));

/** 引擎只需返回一个可写的占位局面 */
function fakeState(id: string): Record<string, unknown> {
  return { id, sideTag: true, pieces: [], moveHistory: [] };
}

/** 记录调用顺序，用来验证「先作废再写状态」 */
const callOrder: string[] = [];

function makeArgs(overrides: Partial<UseNewGameArgs> = {}): UseNewGameArgs {
  const base: UseNewGameArgs = {
    endgameResultRef: { current: 'win' },
    replaySavedRef: { current: true },
    invalidatePendingAI: jest.fn(() => {
      callOrder.push('invalidatePendingAI');
    }),
    scheduleAIMove: jest.fn(() => {
      callOrder.push('scheduleAIMove');
    }),
    clearHint: jest.fn(() => {
      callOrder.push('clearHint');
    }),
    setGameState: jest.fn(() => {
      callOrder.push('setGameState');
    }),
    setSelectedPieceId: jest.fn(),
    setValidMoves: jest.fn(),
    setLastMove: jest.fn(),
    setMoveCount: jest.fn(),
    setCapturedRed: jest.fn(),
    setCapturedBlack: jest.fn(),
    setIsFlipped: jest.fn(),
    setJueShaVisible: jest.fn(),
    setGameOverReason: jest.fn(),
    setEndgameHintLeft: jest.fn(),
    setEndgameUndoLeft: jest.fn(),
    setBoardKey: jest.fn(),
  };
  return { ...base, ...overrides };
}

function mountHook(args: UseNewGameArgs): { api: UseNewGameApi; args: UseNewGameArgs } {
  // 句柄挂到 globalThis 上（见 hookHandle.ts 的原因：eslint 的 react-hooks 规则
  // 不允许在渲染期写回组件外部的变量/对象属性）。
  registerHandle<UseNewGameApi>();
  function Probe(props: { args: UseNewGameArgs }) {
    setHandle(useNewGame(props.args));
    return null;
  }
  act(() => {
    TestRenderer.create(React.createElement(Probe, { args }));
  });
  return { get api() { return getHandle<UseNewGameApi>(); }, args };
}

beforeEach(() => {
  callOrder.length = 0;
  mockCreateInitialState.mockReset().mockImplementation(() => fakeState('initial'));
  mockCreateFromFen.mockReset().mockImplementation((fen: string) => fakeState(`fen:${fen}`));
  mockComputeZobristHash.mockReset().mockReturnValue('HASH');
  mockClearHistoryHash.mockReset();
  mockRecordHistoryHash.mockReset();
  mockPrecomputeOfflineHint.mockReset();
  mockNotifyOfflineNewGame.mockReset();
});

describe('模块级建局面纯函数', () => {
  it('buildInitialGameState 走标准局并补齐 Zobrist 与重复局面历史', () => {
    const state = buildInitialGameState(true) as unknown as { zobristHash: string };
    expect(mockCreateInitialState).toHaveBeenCalledWith(true);
    expect(state.zobristHash).toBe('HASH');
    expect(mockComputeZobristHash).toHaveBeenCalledTimes(1);
    expect(mockClearHistoryHash).toHaveBeenCalledTimes(1);
    expect(mockRecordHistoryHash).toHaveBeenCalledTimes(1);
    // 清历史再记录当前局面，顺序不能反（否则开局局面自己就判重复）
    expect(callOrder).toEqual([]);
  });

  it('buildGameStateFromFen 解析 FEN 并同样补齐哈希', () => {
    const fen = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1';
    buildGameStateFromFen(fen);
    expect(mockCreateFromFen).toHaveBeenCalledWith(fen);
    expect(mockComputeZobristHash).toHaveBeenCalledTimes(1);
    expect(mockRecordHistoryHash).toHaveBeenCalledTimes(1);
  });

  it('FEN 两端空白被裁掉（路由参数常带空格）', () => {
    buildGameStateFromFen('  fen-body  ');
    expect(mockCreateFromFen).toHaveBeenCalledWith('fen-body');
  });
});

describe('残局额度常量', () => {
  it('残局每局提示 3 次、悔棋 10 次', () => {
    expect(ENDGAME_HINT_LIMIT).toBe(3);
    expect(ENDGAME_UNDO_LIMIT).toBe(10);
  });
});

describe('startNewGame', () => {
  const standard = { initialSideTag: true, initialFlipped: false, aiFirst: false } as const;

  it('覆盖全部重置字段（去重的核心保证：少一个字段这里就该红）', () => {
    const args = makeArgs();
    mountHook(args).api.startNewGame(standard);

    expect(args.setGameState).toHaveBeenCalledTimes(1);
    expect(args.setSelectedPieceId).toHaveBeenCalledWith(null);
    expect(args.setValidMoves).toHaveBeenCalledWith(null);
    expect(args.setLastMove).toHaveBeenCalledWith(null);
    expect(args.setMoveCount).toHaveBeenCalledWith(0);
    expect(args.setCapturedRed).toHaveBeenCalledWith(0);
    expect(args.setCapturedBlack).toHaveBeenCalledWith(0);
    expect(args.setIsFlipped).toHaveBeenCalledWith(false);
    expect(args.setGameOverReason).toHaveBeenCalledWith(null);
    expect(args.setJueShaVisible).toHaveBeenCalledWith(false);
    expect(args.setEndgameHintLeft).toHaveBeenCalledWith(ENDGAME_HINT_LIMIT);
    expect(args.setEndgameUndoLeft).toHaveBeenCalledWith(ENDGAME_UNDO_LIMIT);
  });

  it('返回建好的局面，供调用方接着用（如再排一次 AI）', () => {
    const { api } = mountHook(makeArgs());
    const state = api.startNewGame(standard);
    // 注意：buildInitialGameState 会就地写入 zobristHash，所以只比对身份字段
    expect(state).toMatchObject({ id: 'initial' });
  });

  it('先作废旧 AI 走子再写状态（顺序反了旧代数回调会覆盖新局面）', () => {
    mountHook(makeArgs()).api.startNewGame(standard);
    expect(callOrder.indexOf('invalidatePendingAI')).toBeLessThan(callOrder.indexOf('setGameState'));
    // 清提示也必须在写状态之前，否则旧局面的提示会盖住新局
    expect(callOrder.indexOf('clearHint')).toBeLessThan(callOrder.indexOf('setGameState'));
  });

  it('清空残局结果与复盘已保存标记（新一局允许再次落结局记录）', () => {
    const args = makeArgs();
    mountHook(args).api.startNewGame(standard);
    expect(args.endgameResultRef.current).toBeNull();
    expect(args.replaySavedRef.current).toBe(false);
  });

  it('调用方漏传 setBoardKey 也不炸（可选字段）', () => {
    const args = makeArgs();
    delete args.setBoardKey;
    expect(() => mountHook(args).api.startNewGame(standard)).not.toThrow();
  });

  describe('开局走法', () => {
    it('玩家先走：后台预计算提示，不排 AI 走子', () => {
      const args = makeArgs();
      mountHook(args).api.startNewGame(standard);
      expect(mockPrecomputeOfflineHint).toHaveBeenCalledTimes(1);
      expect(args.scheduleAIMove).not.toHaveBeenCalled();
    });

    it('AI 先走：排定一次 AI 走子，不预计算提示', () => {
      const args = makeArgs();
      const { api } = mountHook(args);
      api.startNewGame({ ...standard, aiFirst: true });
      expect(args.scheduleAIMove).toHaveBeenCalledTimes(1);
      expect(args.scheduleAIMove).toHaveBeenCalledWith(expect.objectContaining({ id: 'initial' }));
      expect(mockPrecomputeOfflineHint).not.toHaveBeenCalled();
    });
  });

  describe('棋盘朝向', () => {
    it('玩家执黑默认翻转', () => {
      const args = makeArgs();
      mountHook(args).api.startNewGame({ ...standard, initialFlipped: true });
      expect(args.setIsFlipped).toHaveBeenCalledWith(true);
    });

    it('forceFlipped 覆盖 initialFlipped（残局下一关固定正向）', () => {
      const args = makeArgs();
      mountHook(args).api.startNewGame({ ...standard, initialFlipped: true, forceFlipped: false });
      expect(args.setIsFlipped).toHaveBeenCalledWith(false);
    });
  });

  describe('换棋盘实例', () => {
    it('默认不换 key', () => {
      const args = makeArgs();
      mountHook(args).api.startNewGame(standard);
      expect(args.setBoardKey).not.toHaveBeenCalled();
    });

    it('remountBoard 时按函数式 +1 递增 key', () => {
      const args = makeArgs();
      mountHook(args).api.startNewGame({ ...standard, remountBoard: true });
      expect(args.setBoardKey).toHaveBeenCalledTimes(1);
      const updater = (args.setBoardKey as jest.Mock).mock.calls[0][0] as (n: number) => number;
      expect(updater(7)).toBe(8);
    });
  });

  describe('残局局面', () => {
    const fen = '3k5/9/9/9/9/9/9/4A4/4K4 b - - 0 1';

    it('给了 FEN 就按 FEN 建局，不走标准局', () => {
      const args = makeArgs();
      const { api } = mountHook(args);
      const state = api.startNewGame({ ...standard, endgameFen: fen });
      expect(mockCreateFromFen).toHaveBeenCalledWith(fen);
      expect(mockCreateInitialState).not.toHaveBeenCalled();
      expect(state).toMatchObject({ id: `fen:${fen}` });
    });

    it('aiFirstByFen：FEN 走棋方为黑（b）时让 AI 先走', () => {
      const args = makeArgs();
      mountHook(args).api.startNewGame({ ...standard, endgameFen: fen, aiFirstByFen: true });
      expect(args.scheduleAIMove).toHaveBeenCalledTimes(1);
      expect(mockPrecomputeOfflineHint).not.toHaveBeenCalled();
    });

    it('aiFirstByFen：FEN 走棋方为红（w）时玩家先走', () => {
      const args = makeArgs();
      mountHook(args).api.startNewGame({
        ...standard,
        endgameFen: fen.replace(' b ', ' w '),
        aiFirstByFen: true,
      });
      expect(mockPrecomputeOfflineHint).toHaveBeenCalledTimes(1);
      expect(args.scheduleAIMove).not.toHaveBeenCalled();
    });

    it('aiFirstByFen 覆盖调用方给的 aiFirst=true', () => {
      const args = makeArgs();
      mountHook(args).api.startNewGame({
        ...standard,
        aiFirst: true,
        endgameFen: fen.replace(' b ', ' w '),
        aiFirstByFen: true,
      });
      expect(args.scheduleAIMove).not.toHaveBeenCalled();
    });

    it('不给 aiFirstByFen 时沿用调用方声明的 aiFirst', () => {
      const args = makeArgs();
      mountHook(args).api.startNewGame({ ...standard, endgameFen: fen, aiFirst: true });
      expect(args.scheduleAIMove).toHaveBeenCalledTimes(1);
    });

    it('aiFirstByFen 在标准局（无 FEN）时不越界读 FEN', () => {
      const args = makeArgs();
      mountHook(args).api.startNewGame({ ...standard, aiFirst: false, aiFirstByFen: true });
      expect(args.scheduleAIMove).not.toHaveBeenCalled();
      expect(mockPrecomputeOfflineHint).toHaveBeenCalledTimes(1);
    });
  });

  describe('buildEndgameState 透传', () => {
    it('Hook 暴露的 buildEndgameState 等同模块级纯函数', () => {
      const { api } = mountHook(makeArgs());
      expect(api.buildEndgameState('some fen')).toMatchObject({ id: 'fen:some fen' });
    });
  });
});