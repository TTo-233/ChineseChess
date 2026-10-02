/**
 * @/hooks/usePendingAIMove（第 3 批抽出）—— AI 走子代数防护
 *
 * 这是 CODE_AUDIT.md §8 表 #8 那个不对称分支的修复所在，测的必须是**行为**
 * 而不是内部实现：
 *   - 重开/悔棋/翻转后，已经排定但未到点的 AI 走子不得触发；
 *   - 已经拿到票据的异步操作（玩家走子等音效、AI 走子等搜索）在局面被重置后
 *     落地前必须能被 isTicketLive 拦住；
 *   - 作废时必须真的调用 abortSearch（否则旧搜索继续抢主线程算力）；
 *   - 重复排定只保留最后一次（不能叠出两条 AI 走子）。
 *
 * Hook 本身只是 useRef/useCallback 的组合，用 react-test-renderer 起一个
 * 真实组件来跑它，避免用 renderHook 这类未安装的辅助库。
 */

import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import {
  usePendingAIMove,
  AI_MOVE_DEFAULT_DELAY_MS,
  type PendingAIMoveApi,
  type UsePendingAIMoveOptions,
} from '@/hooks/usePendingAIMove';
import type { GameState } from '@/utils/chess/GameEngine';
import { getHandle, registerHandle, setHandle } from './hookHandle';

// 名字必须以 mock 开头：jest.mock 的工厂函数不允许闭包引用普通外部变量
const mockAbortSearch = jest.fn();
jest.mock('@/utils/chess/AIEngine', () => ({
  abortSearch: (...args: unknown[]) => mockAbortSearch(...args),
}));

/** 占位局面：本测试只关心调用时序，不校验引擎内部 */
const fakeState = { sideTag: true } as unknown as GameState;

type Harness = {
  api: PendingAIMoveApi;
  runAIMove: jest.Mock;
  onDiscard: jest.Mock;
  onUnmount: jest.Mock;
  unmount: () => void;
};

/** 把 Hook 挂到一个一次性组件上，返回 API 句柄 */
function mountHook(initial: Partial<UsePendingAIMoveOptions> = {}): Harness {
  const runAIMove = jest.fn();
  const onDiscard = jest.fn();
  const onUnmount = jest.fn();
  // 句柄挂到 globalThis 上（见 hookHandle.ts 的原因：eslint 的 react-hooks 规则
  // 不允许在渲染期写回组件外部的变量/对象属性）。
  registerHandle<PendingAIMoveApi>();
  function Probe(props: { options: UsePendingAIMoveOptions }) {
    setHandle(usePendingAIMove(props.options));
    return null;
  }
  let renderer!: TestRenderer.TestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      React.createElement(Probe, { options: { runAIMove, onDiscard, onUnmount, ...initial } })
    );
  });
  return {
    get api() {
      return getHandle<PendingAIMoveApi>();
    },
    runAIMove,
    onDiscard,
    onUnmount,
    unmount: () =>
      act(() => {
        renderer.unmount();
      }),
  };
}

describe('usePendingAIMove', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockAbortSearch.mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('排定与取消', () => {
    it('默认延时 500ms 后触发 AI 走子', () => {
      const h = mountHook();
      act(() => {
        h.api.scheduleAIMove(fakeState);
      });
      expect(h.runAIMove).not.toHaveBeenCalled();
      act(() => {
        jest.advanceTimersByTime(AI_MOVE_DEFAULT_DELAY_MS - 1);
      });
      expect(h.runAIMove).not.toHaveBeenCalled();
      act(() => {
        jest.advanceTimersByTime(1);
      });
      expect(h.runAIMove).toHaveBeenCalledTimes(1);
      expect(h.runAIMove).toHaveBeenCalledWith(fakeState);
    });

    it('支持自定义延时', () => {
      const h = mountHook();
      act(() => {
        h.api.scheduleAIMove(fakeState, 1200);
      });
      act(() => {
        jest.advanceTimersByTime(1199);
      });
      expect(h.runAIMove).not.toHaveBeenCalled();
      act(() => {
        jest.advanceTimersByTime(1);
      });
      expect(h.runAIMove).toHaveBeenCalledTimes(1);
    });

    it('invalidatePendingAI 会取消尚未到点的排定（重开后 AI 不再落子）', () => {
      const h = mountHook();
      act(() => {
        h.api.scheduleAIMove(fakeState, 500);
      });
      act(() => {
        h.api.invalidatePendingAI();
      });
      act(() => {
        jest.advanceTimersByTime(5000);
      });
      expect(h.runAIMove).not.toHaveBeenCalled();
    });

    it('作废时调用 abortSearch 中止正在跑的搜索（否则重开后越打越卡）', () => {
      const h = mountHook();
      expect(mockAbortSearch).not.toHaveBeenCalled();
      act(() => {
        h.api.invalidatePendingAI();
      });
      expect(mockAbortSearch).toHaveBeenCalledTimes(1);
    });

    it('作废时通知调用方复位自己的标记（onDiscard，如 aiThinking）', () => {
      const h = mountHook();
      act(() => {
        h.api.invalidatePendingAI();
      });
      expect(h.onDiscard).toHaveBeenCalledTimes(1);
    });

    it('重复排定只保留最后一次（不叠出两条 AI 走子）', () => {
      const other = { sideTag: false } as unknown as GameState;
      const h = mountHook();
      act(() => {
        h.api.scheduleAIMove(fakeState, 500);
      });
      act(() => {
        h.api.scheduleAIMove(other, 500);
      });
      act(() => {
        jest.advanceTimersByTime(500);
      });
      expect(h.runAIMove).toHaveBeenCalledTimes(1);
      expect(h.runAIMove).toHaveBeenCalledWith(other);
    });

    it('作废后再排定可以正常触发（新局面的 AI 走子不被旧代数牵连）', () => {
      const h = mountHook();
      act(() => {
        h.api.scheduleAIMove(fakeState, 500);
      });
      act(() => {
        h.api.invalidatePendingAI();
      });
      act(() => {
        h.api.scheduleAIMove(fakeState, 500);
      });
      act(() => {
        jest.advanceTimersByTime(500);
      });
      expect(h.runAIMove).toHaveBeenCalledTimes(1);
    });

    it('多个定时器先后到点时只跑最后一个', () => {
      const h = mountHook();
      act(() => {
        h.api.scheduleAIMove(fakeState, 100);
        h.api.scheduleAIMove(fakeState, 200);
      });
      act(() => {
        jest.advanceTimersByTime(1000);
      });
      expect(h.runAIMove).toHaveBeenCalledTimes(1);
    });
  });

  describe('代数票据（§8 #8 的闸门）', () => {
    it('初始票据立即有效', () => {
      const h = mountHook();
      const ticket = h.api.beginMoveTicket();
      expect(h.api.isTicketLive(ticket)).toBe(true);
    });

    it('invalidatePendingAI 会让已开出的票据失效（玩家走子等音效期间被重开 → 丢弃）', () => {
      const h = mountHook();
      const ticket = h.api.beginMoveTicket();
      expect(h.api.isTicketLive(ticket)).toBe(true);
      act(() => {
        h.api.invalidatePendingAI();
      });
      expect(h.api.isTicketLive(ticket)).toBe(false);
    });

    it('一次作废使同一时刻开出的所有票据一起失效', () => {
      const h = mountHook();
      const a = h.api.beginMoveTicket();
      const b = h.api.beginMoveTicket();
      act(() => {
        h.api.invalidatePendingAI();
      });
      expect(h.api.isTicketLive(a)).toBe(false);
      expect(h.api.isTicketLive(b)).toBe(false);
    });

    it('作废后新开的票据恢复有效', () => {
      const h = mountHook();
      act(() => {
        h.api.invalidatePendingAI();
      });
      const fresh = h.api.beginMoveTicket();
      expect(h.api.isTicketLive(fresh)).toBe(true);
    });

    it('票据序号单调递增（readGen 可观测）', () => {
      const h = mountHook();
      const g0 = h.api.readGen();
      const t1 = h.api.beginMoveTicket();
      act(() => {
        h.api.invalidatePendingAI();
      });
      const t2 = h.api.beginMoveTicket();
      expect(h.api.readGen()).toBeGreaterThan(g0);
      expect(t2.gen).toBeGreaterThan(t1.gen);
      expect(h.api.isTicketLive(t1)).toBe(false);
      expect(h.api.isTicketLive(t2)).toBe(true);
    });

    it('AI 搜索已开始后局面被重置 → 票据失效，可拦住旧结果的落地', () => {
      // 复刻真实时序：AI 搜索已开始（票据已开）→ 用户重开 → 搜索返回
      const h = mountHook();
      const ticket = h.api.beginMoveTicket();
      act(() => {
        jest.advanceTimersByTime(0);
      });
      act(() => {
        h.api.invalidatePendingAI();
      });
      expect(h.api.isTicketLive(ticket)).toBe(false);
    });

    it('票据在多次排定间互不影响（排定本身不使票据失效）', () => {
      const h = mountHook();
      const ticket = h.api.beginMoveTicket();
      act(() => {
        h.api.scheduleAIMove(fakeState, 100);
      });
      expect(h.api.isTicketLive(ticket)).toBe(true);
      act(() => {
        jest.advanceTimersByTime(100);
      });
      expect(h.api.isTicketLive(ticket)).toBe(true);
    });
  });

  describe('稳定性与卸载', () => {
    it('API 引用跨重渲染保持稳定', () => {
      const h = mountHook();
      const first = h.api;
      act(() => {
        jest.advanceTimersByTime(0);
      });
      expect(h.api.invalidatePendingAI).toBe(first.invalidatePendingAI);
      expect(h.api.scheduleAIMove).toBe(first.scheduleAIMove);
      expect(h.api.beginMoveTicket).toBe(first.beginMoveTicket);
      expect(h.api.isTicketLive).toBe(first.isTicketLive);
    });

    it('卸载时清掉待触发的定时器（页面销毁后不再回调）', () => {
      const h = mountHook();
      act(() => {
        h.api.scheduleAIMove(fakeState, 500);
      });
      h.unmount();
      act(() => {
        jest.advanceTimersByTime(5000);
      });
      expect(h.runAIMove).not.toHaveBeenCalled();
    });

    it('卸载时调用 onUnmount', () => {
      const h = mountHook();
      expect(h.onUnmount).not.toHaveBeenCalled();
      h.unmount();
      expect(h.onUnmount).toHaveBeenCalledTimes(1);
    });

    it('未传 onDiscard / onUnmount 也能正常工作（可选回调）', () => {
      const runAIMove = jest.fn();
      registerHandle<PendingAIMoveApi>();
      function Probe() {
        setHandle(usePendingAIMove({ runAIMove }));
        return null;
      }
      let renderer!: TestRenderer.TestRenderer;
      act(() => {
        renderer = TestRenderer.create(React.createElement(Probe));
      });
      const api = getHandle<PendingAIMoveApi>();
      expect(() =>
        act(() => {
          api.invalidatePendingAI();
        })
      ).not.toThrow();
      act(() => {
        api.scheduleAIMove(fakeState, 10);
      });
      act(() => {
        jest.advanceTimersByTime(10);
      });
      expect(runAIMove).toHaveBeenCalledTimes(1);
      expect(() =>
        act(() => {
          renderer.unmount();
        })
      ).not.toThrow();
    });
  });
});