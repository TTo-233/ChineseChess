/**
 * @/hooks/useBattleStateSync（第 3 批补测试）—— 服务端负载 → 页面状态的映射
 *
 * 这个 Hook 是从两个页面各写一份的 applyServerState 收敛而来的，它存在的**唯一理由**
 * 是修掉一个吞帧缺陷：旧实现里「服务端局面比本端着法数旧」时 `return` 退出的是整个
 * 函数，于是同一帧的结算、重赛跟随、表情、协商、断线**全部被跳过**。若该着法恰好
 * 被服务端 400 拒绝（服务端拒绝时不广播 state），客户端会连续 8 秒丢弃所有状态推送。
 *
 * 所以这里钉的核心行为是：**局面块可以被延迟，控制信息绝不能被延迟**。
 * 其余用例覆盖时钟校正（§8 #7）、断线倒计时、协商封禁与在途清理。
 */

import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import {
  useBattleStateSync,
  type BattleStateSyncApi,
  type BattleStateSyncHandlers,
  type BattleStateSyncOptions,
} from '@/hooks/useBattleStateSync';
import {
  BattleActionRejectedError,
  BattleActionTimeoutError,
} from '@/utils/battleProtocol';
import type { GameState } from '@/utils/chess/GameEngine';
import { getHandle, registerHandle, setHandle } from './hookHandle';

jest.useFakeTimers();

/** 造一个带 moveHistory 的局面 */
function gameState(moveHistory: unknown[] = []): GameState {
  return { sideTag: true, moveHistory } as unknown as GameState;
}

type Harness = {
  api: BattleStateSyncApi;
  options: BattleStateSyncOptions;
  handlers: Required<
    Pick<
      BattleStateSyncHandlers,
      | 'onEnded'
      | 'onRematchFollowed'
      | 'onPhaseChange'
      | 'onOpponentReturned'
      | 'onBoardApplied'
      | 'onEmoji'
      | 'onUndoResult'
      | 'onDrawResult'
      | 'onOpponentDisconnected'
      | 'onSelfMarkedDisconnected'
      | 'onActionFailure'
    >
  >;
  setGameState: jest.Mock;
  pendingMoveRef: { current: unknown };
  undoBlockedRef: { current: boolean };
  drawBlockedRef: { current: boolean };
  selfDisconnectedRef: { current: boolean };
  serverTimeOffsetRef: { current: number };
  disconnectCountdown: number;
  setDisconnectCountdown: jest.Mock;
};

function mount(options: Partial<BattleStateSyncOptions> = {}): Harness {
  // requestReconnect 等可选回调需要一个合法实现；空箭头函数会被
  // @typescript-eslint/no-empty-function 拦下，所以给一个带注释的实现体。
  const noop = () => {
    // 默认不做事
  };
  const handlers = {
    onEnded: jest.fn(),
    onRematchFollowed: jest.fn(),
    onPhaseChange: jest.fn(),
    onOpponentReturned: jest.fn(),
    onBoardApplied: jest.fn(),
    onEmoji: jest.fn(),
    onUndoResult: jest.fn(),
    onDrawResult: jest.fn(),
    onOpponentDisconnected: jest.fn(),
    onSelfMarkedDisconnected: jest.fn(),
    onActionFailure: jest.fn(),
  } as Harness['handlers'];

  const setGameState = jest.fn();
  const pendingMoveRef = { current: null };
  const undoBlockedRef = { current: false };
  const drawBlockedRef = { current: false };
  const selfDisconnectedRef = { current: false };
  // 允许测试传入自己的 ref 身份，否则下面返回的句柄拿不到同一个对象
  const serverTimeOffsetRef = options.serverTimeOffsetRef ?? { current: 0 };
  const setDisconnectCountdown = jest.fn();

  const merged: BattleStateSyncOptions = {
    selfId: 'me',
    setGameState,
    pendingMoveRef,
    undoBlockedRef,
    drawBlockedRef,
    selfDisconnectedRef,
    serverTimeOffsetRef,
    setDisconnectCountdown,
    requestReconnect: noop,
    ...options,
    handlers,
  };

  // 句柄挂到 globalThis 上（见 hookHandle.ts 的原因：eslint 的 react-hooks 规则
  // 不允许在渲染期写回组件外部的变量/对象属性）。
  const holder = registerHandle<BattleStateSyncApi>();
  function Probe(props: { options: BattleStateSyncOptions }) {
    setHandle(useBattleStateSync(props.options));
    return null;
  }
  act(() => {
    TestRenderer.create(React.createElement(Probe, { options: merged }));
  });

  return {
    get api(): BattleStateSyncApi {
      return getHandle<BattleStateSyncApi>();
    },
    options: merged,
    handlers,
    setGameState,
    pendingMoveRef,
    undoBlockedRef,
    drawBlockedRef,
    selfDisconnectedRef,
    serverTimeOffsetRef,
    setDisconnectCountdown,
    get disconnectCountdown() {
      return setDisconnectCountdown.mock.calls.at(-1)?.[0] ?? 60;
    },
  };
}

describe('useBattleStateSync', () => {
  describe('控制信息不被乐观保护吞掉（Hook 存在的理由）', () => {
    it('局面被延迟时，phase 流转仍照常触发', () => {
      const h = mount();
      h.api.markOptimisticMove(3, gameState([1, 2, 3]));
      // 服务端局面比本端着法数旧 → 局面块延迟
      act(() => h.api.applyPayload({ phase: 'waiting', gameState: gameState([1]) }));
      expect(h.setGameState).not.toHaveBeenCalled();
      expect(h.handlers.onPhaseChange).toHaveBeenCalledTimes(1);
    });

    it('局面被延迟时，结算回调仍照常触发', () => {
      const h = mount();
      h.api.markOptimisticMove(3, gameState([1, 2, 3]));
      act(() =>
        h.api.applyPayload({
          phase: 'ended',
          winner: 'p2',
          endReason: 'resign',
          gameState: gameState([1]),
        })
      );
      expect(h.handlers.onEnded).toHaveBeenCalledTimes(1);
      expect(h.handlers.onEnded.mock.calls[0][0]).toMatchObject({
        winner: 'p2',
        isDraw: false,
        endReason: 'resign',
      });
    });

    it('局面被延迟时，协商结果与断线标记仍照常处理', () => {
      const h = mount();
      h.api.markOptimisticMove(3, gameState([1, 2, 3]));
      act(() =>
        h.api.applyPayload({
          phase: 'playing',
          gameState: gameState([1]),
          disconnectedPlayerId: 'p2',
          disconnectTime: 1000,
        })
      );
      expect(h.handlers.onOpponentDisconnected).toHaveBeenCalledWith({
        disconnected: true,
        countdown: expect.any(Number),
      });
    });

    it('局面被延迟时，协商封禁仍照常判定', () => {
      const h = mount();
      h.api.markOptimisticMove(3, gameState([1, 2, 3]));
      act(() =>
        h.api.applyPayload({
          phase: 'playing',
          gameState: gameState([1]),
          undoRefusals: { me: 2 },
          drawRefusals: { me: 5 },
        })
      );
      expect(h.undoBlockedRef.current).toBe(true);
      expect(h.drawBlockedRef.current).toBe(true);
    });

    it('服务端局面已包含本端着法 → 解除保护，本帧照常落地', () => {
      const h = mount();
      h.api.markOptimisticMove(3, gameState([1, 2, 3]));
      act(() => h.api.applyPayload({ phase: 'playing', gameState: gameState([1, 2, 3]) }));
      expect(h.setGameState).toHaveBeenCalledTimes(1);
      expect(h.pendingMoveRef.current).toBeNull();
      expect(h.handlers.onBoardApplied).toHaveBeenCalledWith(
        expect.objectContaining({ historyLen: 3, isNewMove: true })
      );
    });

    it('长时间未见本端着法 → 放弃保护并按服务端局面恢复', () => {
      const h = mount();
      h.api.markOptimisticMove(3, gameState([1, 2, 3]));
      // 【P5】乐观保护窗口已由写死的 8s 改为按 RTT 标定（下限 12s、上限 30s），
      // 未注入 rttMs 时按 12s 计。
      act(() => {
        jest.advanceTimersByTime(13000);
        h.api.applyPayload({ phase: 'playing', gameState: gameState([1]) });
      });
      expect(h.setGameState).toHaveBeenCalledTimes(1);
      expect(h.pendingMoveRef.current).toBeNull();
    });

    it('【P5】窗口内（12s）仍保护本端着法，不因慢链路误判为上传失败', () => {
      const h = mount();
      h.api.markOptimisticMove(3, gameState([1, 2, 3]));
      act(() => {
        jest.advanceTimersByTime(11000);
        h.api.applyPayload({ phase: 'playing', gameState: gameState([1]) });
      });
      // 局面被延迟，控制信息仍处理
      expect(h.setGameState).not.toHaveBeenCalled();
      expect(h.pendingMoveRef.current).not.toBeNull();
    });

    it('【P5】注入 RTT 时窗口按 RTT×6 放大，并受 30s 上限约束', () => {
      const slow = mount({ rttMs: () => 20000 });
      slow.api.markOptimisticMove(3, gameState([1, 2, 3]));
      act(() => {
        jest.advanceTimersByTime(29000);
        slow.api.applyPayload({ phase: 'playing', gameState: gameState([1]) });
      });
      // 29s < 20000×6（已到 30s 上限）→ 仍保护
      expect(slow.setGameState).not.toHaveBeenCalled();

      const mid = mount({ rttMs: () => 3000 });
      mid.api.markOptimisticMove(3, gameState([1, 2, 3]));
      act(() => {
        jest.advanceTimersByTime(19000);
        mid.api.applyPayload({ phase: 'playing', gameState: gameState([1]) });
      });
      // 3000×6=18000 < 19s → 窗口已过，放弃保护
      expect(mid.setGameState).toHaveBeenCalledTimes(1);
      expect(mid.pendingMoveRef.current).toBeNull();
    });

    it('未登记乐观保护时永远直接落地', () => {
      const h = mount();
      act(() => h.api.applyPayload({ phase: 'playing', gameState: gameState([1, 2]) }));
      expect(h.setGameState).toHaveBeenCalledTimes(1);
      expect(h.handlers.onBoardApplied).toHaveBeenCalledWith(
        expect.objectContaining({ historyLen: 2, isNewMove: true })
      );
    });

    // ---- P4：增量载荷（gameState 不含 moveHistory）的兼容 ----

    it('增量载荷：着法数读顶层 moveCount，并把 lastMove 合并进本地棋谱', () => {
      const h = mount();
      const lastMove = { pieceId: 6, fromCol: 7, fromRow: 0, toCol: 4, toRow: 2, capturedPieceId: -1 };
      // 服务端增量载荷：gameState 里完全没有 moveHistory
      act(() =>
        h.api.applyPayload({
          phase: 'playing',
          moveCount: 1,
          lastMove,
          gameState: { sideTag: false } as unknown as GameState,
        })
      );
      const applied = h.setGameState.mock.calls.at(-1)?.[0] as GameState;
      expect(applied.moveHistory).toEqual([lastMove]);
      expect(h.handlers.onBoardApplied).toHaveBeenCalledWith(
        expect.objectContaining({ historyLen: 1, isNewMove: true, lastMove })
      );
    });

    it('增量载荷：连续多手时本地棋谱逐手累积，不被清空', () => {
      const h = mount();
      const base = { sideTag: true } as unknown as GameState;
      for (let i = 1; i <= 3; i += 1) {
        const lastMove = { pieceId: i, fromCol: 0, fromRow: 0, toCol: 1, toRow: i, capturedPieceId: -1 };
        act(() =>
          h.api.applyPayload({ phase: 'playing', moveCount: i, lastMove, gameState: base })
        );
        const applied = h.setGameState.mock.calls.at(-1)?.[0] as GameState;
        expect(applied.moveHistory).toHaveLength(i);
        expect(applied.moveHistory[i - 1]).toEqual(lastMove);
      }
    });

    it('全量载荷（含 moveHistory）直接采用服务端棋谱', () => {
      const h = mount();
      const full = gameState([1, 2, 3]);
      act(() => h.api.applyPayload({ phase: 'playing', moveCount: 3, lastMove: 3, gameState: full }));
      const applied = h.setGameState.mock.calls.at(-1)?.[0] as GameState;
      expect(applied.moveHistory).toEqual([1, 2, 3]);
    });

    it('增量载荷：悔棋截断历史时按 moveCount 截断本地棋谱', () => {
      const h = mount();
      const base = { sideTag: true } as unknown as GameState;
      for (let i = 1; i <= 3; i += 1) {
        const lastMove = { pieceId: i, fromCol: 0, fromRow: 0, toCol: 1, toRow: i, capturedPieceId: -1 };
        act(() => h.api.applyPayload({ phase: 'playing', moveCount: i, lastMove, gameState: base }));
      }
      // 悔棋：服务端回退两手并发全量载荷；这里验证增量形态下 moveCount 变小也能截断
      act(() => h.api.applyPayload({ phase: 'playing', moveCount: 1, lastMove: 1, gameState: base }));
      const applied = h.setGameState.mock.calls.at(-1)?.[0] as GameState;
      expect(applied.moveHistory).toHaveLength(1);
    });

    it('重开一局：resetSyncBaseline 清空本地棋谱基线', () => {
      const h = mount();
      const base = { sideTag: true } as unknown as GameState;
      const lastMove = { pieceId: 1, fromCol: 0, fromRow: 0, toCol: 1, toRow: 1, capturedPieceId: -1 };
      act(() => h.api.applyPayload({ phase: 'playing', moveCount: 1, lastMove, gameState: base }));
      act(() => { h.api.resetSyncBaseline(); });
      // 新一局第 1 手：不应把上一局的着法接在后面
      const firstOfNew = { pieceId: 9, fromCol: 2, fromRow: 0, toCol: 2, toRow: 2, capturedPieceId: -1 };
      act(() => h.api.applyPayload({ phase: 'playing', moveCount: 1, lastMove: firstOfNew, gameState: base }));
      const applied = h.setGameState.mock.calls.at(-1)?.[0] as GameState;
      expect(applied.moveHistory).toEqual([firstOfNew]);
    });

    it('结算的 moveCount 优先取顶层字段', () => {
      const h = mount();
      act(() => h.api.applyPayload({ phase: 'ended', winner: 'p1', moveCount: 12 }));
      expect(h.handlers.onEnded.mock.calls[0][0].moveCount).toBe(12);
    });

    it('老服务端（无顶层 moveCount）回落到 gameState.moveHistory.length', () => {
      const h = mount();
      act(() => h.api.applyPayload({ phase: 'ended', winner: 'p1', gameState: gameState([1, 2, 3, 4]) }));
      expect(h.handlers.onEnded.mock.calls[0][0].moveCount).toBe(4);
    });
  });

  describe('结算语义', () => {
    it('无 winner 视为和棋', () => {
      const h = mount();
      act(() => h.api.applyPayload({ phase: 'ended', endReason: 'draw' }));
      expect(h.handlers.onEnded.mock.calls[0][0]).toMatchObject({
        winner: null,
        isDraw: true,
        endReason: 'draw',
      });
    });

    it('白名单外的 endReason 收窄为推断值，不把任意字符串塞进页面 state', () => {
      const h = mount();
      act(() => h.api.applyPayload({ phase: 'ended', winner: 'p1', endReason: 'weird-value' }));
      expect(h.handlers.onEnded.mock.calls[0][0].endReason).toBe('checkmate');
    });

    it('有 surrenderBy 时推断为认输', () => {
      const h = mount();
      act(() => h.api.applyPayload({ phase: 'ended', winner: 'p1', surrenderBy: 'p2' }));
      expect(h.handlers.onEnded.mock.calls[0][0].endReason).toBe('resign');
    });

    it('房间已重置为 waiting（负载无 gameState）时 moveCount 为 undefined', () => {
      const h = mount();
      act(() => h.api.applyPayload({ phase: 'ended', winner: 'p1' }));
      expect(h.handlers.onEnded.mock.calls[0][0].moveCount).toBeUndefined();
    });

    it('非 ended 阶段不触发结算', () => {
      const h = mount();
      act(() => h.api.applyPayload({ phase: 'playing' }));
      expect(h.handlers.onEnded).not.toHaveBeenCalled();
    });
  });

  describe('服务端时钟校正（§8 #7）', () => {
    it('用负载里的 serverNow 校正偏移量', () => {
      const h = mount();
      const now = Date.now();
      act(() => h.api.applyPayload({ serverNow: now + 45000, phase: 'playing' }));
      expect(h.serverTimeOffsetRef.current).toBeGreaterThan(0);
    });

    it('负载缺少 serverNow 时保留已有偏移（坏负载不把好偏移清零）', () => {
      const h = mount({ serverTimeOffsetRef: { current: 1234 } });
      act(() => h.api.applyPayload({ phase: 'playing' }));
      expect(h.serverTimeOffsetRef.current).toBe(1234);
    });

    it('结算时长用校正后的服务端时间求差（§8 #7）', () => {
      const h = mount();
      const now = Date.now();
      act(() => {
        // 本机时钟比服务端慢 60s
        h.api.applyPayload({ serverNow: now + 60000, phase: 'playing' });
      });
      // 服务端说开局在 10s 前 → 校正后应算出 10s，而不是本机算出的 -50s
      act(() => {
        h.api.applyPayload({
          phase: 'ended',
          winner: 'p1',
          gameStartTime: now + 60000 - 10000,
          serverNow: now + 60000,
        });
      });
      expect(h.handlers.onEnded.mock.calls[0][0].duration).toBe(10000);
    });
  });

  describe('断线倒计时', () => {
    it('无 disconnectTime 时给满 60s', () => {
      const h = mount();
      act(() => h.api.applyPayload({ phase: 'playing', disconnectedPlayerId: 'p2' }));
      expect(h.handlers.onOpponentDisconnected).toHaveBeenCalledWith({
        disconnected: true,
        countdown: 60,
      });
    });

    it('按服务端时间轴扣减已过秒数，且不会因设备时钟偏快直接归零', () => {
      const h = mount();
      const now = Date.now();
      act(() => {
        // 校正后：服务端 10s 前断线
        h.api.applyPayload({ serverNow: now + 60000, phase: 'playing' });
        h.api.applyPayload({
          phase: 'playing',
          disconnectedPlayerId: 'p2',
          disconnectTime: now + 60000 - 10000,
          serverNow: now + 60000,
        });
      });
      expect(h.handlers.onOpponentDisconnected).toHaveBeenLastCalledWith({
        disconnected: true,
        countdown: 50,
      });
    });

    it('断线超过 60s 时归零（Math.max 下限）', () => {
      const h = mount();
      const now = Date.now();
      act(() => {
        h.api.applyPayload({
          phase: 'playing',
          disconnectedPlayerId: 'p2',
          disconnectTime: now + 60000 - 99000,
          serverNow: now + 60000,
        });
      });
      expect(h.handlers.onOpponentDisconnected).toHaveBeenLastCalledWith({
        disconnected: true,
        countdown: 0,
      });
    });

    it('没有对手断线时归零标记并回满倒计时', () => {
      const h = mount();
      act(() => h.api.applyPayload({ phase: 'playing' }));
      expect(h.handlers.onOpponentDisconnected).toHaveBeenLastCalledWith({
        disconnected: false,
        countdown: 60,
      });
    });

    it('断线方是自己时不上报对手断线，而是请求重连', () => {
      const requestReconnect = jest.fn();
      const h = mount({ requestReconnect, selfDisconnectedRef: { current: false } });
      act(() => h.api.applyPayload({ phase: 'playing', disconnectedPlayerId: 'me' }));
      expect(requestReconnect).toHaveBeenCalled();
      expect(h.handlers.onOpponentDisconnected).toHaveBeenLastCalledWith({
        disconnected: false,
        countdown: 60,
      });
    });
  });

  describe('协商（悔棋 / 求和）', () => {
    it('对方发起的请求提示我方', () => {
      const setUndoRequestFromOpponent = jest.fn();
      const h = mount({ setUndoRequestFromOpponent });
      act(() =>
        h.api.applyPayload({
          phase: 'playing',
          pendingUndo: { playerId: 'p2', proposedState: {} },
        })
      );
      expect(setUndoRequestFromOpponent).toHaveBeenCalledWith(true);
    });

    it('自己发起的请求不提示自己', () => {
      const setUndoRequestFromOpponent = jest.fn();
      const h = mount({ setUndoRequestFromOpponent });
      act(() =>
        h.api.applyPayload({
          phase: 'playing',
          pendingUndo: { playerId: 'me', proposedState: {} },
        })
      );
      expect(setUndoRequestFromOpponent).toHaveBeenCalledWith(false);
    });

    it('我方请求被同意 → 清除在途状态且不弹拒绝提示', () => {
      const setUndoPending = jest.fn();
      const pendingUndoRef = { current: true };
      const h = mount({ setUndoPending, pendingUndoRef });
      act(() =>
        h.api.applyPayload({
          phase: 'playing',
          undoResult: { playerId: 'me', agreed: true },
        })
      );
      expect(setUndoPending).toHaveBeenCalledWith(false);
      expect(pendingUndoRef.current).toBe(false);
      expect(h.handlers.onUndoResult).not.toHaveBeenCalled();
    });

    it('我方请求被拒绝 → 弹提示并带上封禁状态', () => {
      const setUndoPending = jest.fn();
      const h = mount({ setUndoPending, pendingUndoRef: { current: true } });
      act(() =>
        h.api.applyPayload({
          phase: 'playing',
          undoResult: { playerId: 'me', agreed: false },
        })
      );
      expect(h.handlers.onUndoResult).toHaveBeenCalledWith(
        expect.objectContaining({ agreed: false }),
        false
      );
    });

    it('请求因对方走棋失效且无结果 → 静默清除在途状态', () => {
      const setDrawPending = jest.fn();
      const pendingDrawRef = { current: true };
      const h = mount({ setDrawPending, pendingDrawRef });
      act(() => h.api.applyPayload({ phase: 'playing' }));
      expect(setDrawPending).toHaveBeenCalledWith(false);
      expect(pendingDrawRef.current).toBe(false);
    });

    it('被拒次数达到 2 次即封禁对应入口', () => {
      const h = mount();
      act(() => h.api.applyPayload({ phase: 'playing', undoRefusals: { me: 1 } }));
      expect(h.undoBlockedRef.current).toBe(false);
      act(() => h.api.applyPayload({ phase: 'playing', undoRefusals: { me: 2 } }));
      expect(h.undoBlockedRef.current).toBe(true);
    });
  });

  describe('表情去重', () => {
    // 表情内容用纯 ASCII 占位符：项目 eslint 有 forbidEmoji/no-emoji 规则，
    // 而本组要断言的是「去重 / 跳过畸形项」，与表情具体长什么样无关。
    it('同一 id 只入列一次（WS 与轮询双通道会下发同一批）', () => {
      const h = mount();
      const payload = {
        phase: 'playing',
        emojiMessages: [{ id: 'e1', emoji: ':thumbsup:', at: 1 }],
      };
      act(() => h.api.applyPayload(payload));
      act(() => h.api.applyPayload(payload));
      expect(h.handlers.onEmoji).toHaveBeenCalledTimes(1);
    });

    it('缺 id / emoji 的畸形项被跳过，不影响后续正常项', () => {
      const h = mount();
      act(() =>
        h.api.applyPayload({
          phase: 'playing',
          emojiMessages: [null, { id: 'e1' }, { emoji: ':thumbsup:' }, { id: 'e2', emoji: ':tada:' }],
        })
      );
      expect(h.handlers.onEmoji).toHaveBeenCalledTimes(1);
      expect(h.handlers.onEmoji.mock.calls[0][0].id).toBe('e2');
    });
  });

  describe('重赛跟随', () => {
    it('自己已表态跟随 → 跟随回准备界面', () => {
      const h = mount({ currentPhase: () => 'ended' });
      act(() =>
        h.api.applyPayload({
          phase: 'waiting',
          returnedToRoom: { me: 1000 },
          players: [{ id: 'me' }, { id: 'p2' }],
        })
      );
      expect(h.handlers.onRematchFollowed).toHaveBeenCalledTimes(1);
    });

    it('只有对手表态 → 留在结算页（双方互不干扰）', () => {
      const h = mount({ currentPhase: () => 'ended' });
      act(() =>
        h.api.applyPayload({
          phase: 'waiting',
          returnedToRoom: { p2: 1000 },
          players: [{ id: 'me' }, { id: 'p2' }],
        })
      );
      expect(h.handlers.onRematchFollowed).not.toHaveBeenCalled();
    });

    it('兜底倒计时已表态也算跟随', () => {
      const h = mount({ currentPhase: () => 'ended', rematchFollowedFallback: () => true });
      act(() => h.api.applyPayload({ phase: 'waiting', players: [{ id: 'me' }] }));
      expect(h.handlers.onRematchFollowed).toHaveBeenCalledTimes(1);
    });

    it('不在结算页时 waiting 不触发跟随', () => {
      const h = mount({ currentPhase: () => 'playing' });
      act(() =>
        h.api.applyPayload({
          phase: 'waiting',
          returnedToRoom: { me: 1000 },
          players: [{ id: 'me' }],
        })
      );
      expect(h.handlers.onRematchFollowed).not.toHaveBeenCalled();
    });
  });

  describe('乐观更新的登记与回退', () => {
    it('markOptimisticMove 记录着法数与回滚快照', () => {
      const snapshot = gameState([1, 2]);
      const h = mount();
      h.api.markOptimisticMove(2, snapshot);
      expect(h.pendingMoveRef.current).toMatchObject({ historyLen: 2, snapshot });
    });

    it('rollbackOptimisticMove 回退到快照并返回 true', () => {
      const snapshot = gameState([1]);
      const h = mount();
      h.api.markOptimisticMove(1, snapshot);
      let rolled = false;
      act(() => {
        rolled = h.api.rollbackOptimisticMove();
      });
      expect(rolled).toBe(true);
      expect(h.setGameState).toHaveBeenCalledWith(snapshot);
      expect(h.pendingMoveRef.current).toBeNull();
    });

    it('没有在途乐观更新时回退返回 false 且不写状态', () => {
      const h = mount();
      let rolled = true;
      act(() => {
        rolled = h.api.rollbackOptimisticMove();
      });
      expect(rolled).toBe(false);
      expect(h.setGameState).not.toHaveBeenCalled();
    });

    it('resetSyncBaseline 清空着法基线与乐观保护', () => {
      const h = mount();
      h.api.markOptimisticMove(4, gameState([1, 2, 3, 4]));
      act(() => h.api.applyPayload({ phase: 'playing', gameState: gameState([1, 2, 3, 4]) }));
      act(() => h.api.resetSyncBaseline());
      expect(h.pendingMoveRef.current).toBeNull();
      expect(h.api.seenHistoryLenRef.current).toBe(0);
    });
  });

  describe('动作被拒（handleActionRejected）', () => {
    it('BattleActionNotSentError 不处理（交给 HTTP 兜底，不算服务端拒绝）', () => {
      const h = mount();
      const err = new Error('socket down');
      err.name = 'BattleActionNotSentError';
      act(() => h.api.handleActionRejected(err));
      expect(h.handlers.onActionFailure).not.toHaveBeenCalled();
      expect(h.setGameState).not.toHaveBeenCalled();
    });

    it('拒绝：回退乐观更新 + 通知页面（着法被拒不清在途协商）', () => {
      // 被拒的 move 不清 undo/draw 的在途标记：服务端 400 时根本没执行走子，
      // 因此并未作废对方已提出的悔棋/求和请求（只有**成功**落子才会作废它们）。
      // 清掉反而会让界面停在「等待对方同意」而服务端仍保留请求。
      const snapshot = gameState([1]);
      const setUndoPending = jest.fn();
      const setDrawPending = jest.fn();
      const h = mount({ setUndoPending, setDrawPending });
      h.api.markOptimisticMove(1, snapshot);
      act(() =>
        h.api.handleActionRejected(new BattleActionRejectedError('move', 400, '着法非法'))
      );
      expect(h.setGameState).toHaveBeenCalledWith(snapshot);
      expect(setUndoPending).not.toHaveBeenCalled();
      expect(setDrawPending).not.toHaveBeenCalled();
      expect(h.handlers.onActionFailure).toHaveBeenCalledWith('着法非法');
    });

    it('拒绝：动作类型未知时清掉全部在途协商（对应服务端 4xx 未建立 pending）', () => {
      const setUndoPending = jest.fn();
      const setDrawPending = jest.fn();
      const h = mount({ setUndoPending, setDrawPending });
      act(() => h.api.handleActionRejected(new BattleActionTimeoutError('surrender', 5000)));
      expect(setUndoPending).toHaveBeenCalledWith(false);
      expect(setDrawPending).toHaveBeenCalledWith(false);
    });

    it('超时同样按失败处理并回退（结果未知）', () => {
      const h = mount();
      h.api.markOptimisticMove(1, gameState([1]));
      act(() => h.api.handleActionRejected(new BattleActionTimeoutError('move', 5000)));
      expect(h.setGameState).toHaveBeenCalled();
      expect(h.handlers.onActionFailure).toHaveBeenCalled();
    });

    it('非协议错误用兜底文案', () => {
      const h = mount();
      act(() => h.api.handleActionRejected(new Error('boom')));
      expect(h.handlers.onActionFailure).toHaveBeenCalledWith('操作未送达服务端，请重试');
    });

    it('被拒的 draw 只清 draw，不误清悔棋在途', () => {
      const setUndoPending = jest.fn();
      const setDrawPending = jest.fn();
      const h = mount({ setUndoPending, setDrawPending });
      act(() => h.api.handleActionRejected(new BattleActionRejectedError('draw', 400, '不允许求和')));
      expect(setDrawPending).toHaveBeenCalledWith(false);
      expect(setUndoPending).not.toHaveBeenCalled();
    });
  });

  describe('守卫', () => {
    it('isActive 返回 false 时整帧丢弃', () => {
      const h = mount({ isActive: () => false });
      act(() =>
        h.api.applyPayload({ phase: 'ended', winner: 'p1', gameState: gameState([1, 2]) })
      );
      expect(h.setGameState).not.toHaveBeenCalled();
      expect(h.handlers.onEnded).not.toHaveBeenCalled();
      expect(h.handlers.onPhaseChange).not.toHaveBeenCalled();
    });

    it('无 gameState 的负载（房间重置为 waiting）不写状态', () => {
      const h = mount();
      act(() => h.api.applyPayload({ phase: 'waiting' }));
      expect(h.setGameState).not.toHaveBeenCalled();
    });

    it('时钟面：负载无 clocks 时清空快照，避免残留上一局时间', () => {
      const clockSnapRef = {
        current: {
          red: 1000,
          black: 2000,
          lastMoveTime: 5,
          sideTag: true,
          clockPausedAt: null,
        },
      };
      const h = mount({ clockSnapRef });
      act(() => h.api.applyPayload({ phase: 'waiting' }));
      expect(clockSnapRef.current).toBeNull();
    });

    it('时钟面：有 clocks 时按负载写入权威毫秒', () => {
      const clockSnapRef = { current: null as unknown };
      const h = mount({ clockSnapRef });
      act(() =>
        h.api.applyPayload({
          phase: 'playing',
          clocks: { red: 30000, black: 25000 },
          lastMoveTime: 777,
          clockPausedAt: 900,
          gameState: gameState([1]),
        })
      );
      expect(clockSnapRef.current).toMatchObject({
        red: 30000,
        black: 25000,
        lastMoveTime: 777,
        clockPausedAt: 900,
      });
    });

    it('API 引用跨重渲染稳定（供 WS/轮询回调安全持有）', () => {
      const h = mount();
      const first = h.api;
      act(() => {
        h.api.applyPayload({ phase: 'playing' });
      });
      expect(h.api.applyPayload).toBe(first.applyPayload);
      expect(h.api.markOptimisticMove).toBe(first.markOptimisticMove);
      expect(h.api.handleActionRejected).toBe(first.handleActionRejected);
    });
  });
});