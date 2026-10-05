/**
 * 背景选择持久化（backgroundStyleStore.ts）
 *
 * 与 boardStyleStore 同构，钉住四条：
 *   ① 默认 'none'，且订阅时若云端/本地没有存过值就保持不变；
 *   ② 选中即生效（订阅者同步收到通知）并写入同一个 storage key；
 *   ③ 非法 id 一律忽略（不入库、不广播）——防止线上脏数据把界面刷成空白；
 *   ④ 冷启动读回有效值时会广播；读到非法值时静默保持默认。
 *
 * ③ 的意义：storage 里的值可能来自旧版本或被人为改过，
 * 若不做白名单校验，`getBackgroundStyle` 会回落到 'none'，
 * 但 store 的 currentId 会停在脏值上，导致「弹窗显示选中的是 X、页面显示纯色」这种撕裂状态。
 */

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => undefined),
    removeItem: jest.fn(async () => undefined),
    clear: jest.fn(async () => undefined),
  },
}));

import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  useBackgroundStyle,
  getBackgroundStyleId,
  setBackgroundStyleId,
  __resetBackgroundStyleStoreForTest,
} from '@/utils/chess/backgroundStyleStore';

const STORAGE_KEY = 'background_style_id_v1';

/** 把 hook 的当前值渲染成一行文本，便于断言 */
function Probe() {
  const bg = useBackgroundStyle();
  return <Text>{bg.id}</Text>;
}

function renderProbe() {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(<Probe />);
  });
  return tree;
}

function renderedId(tree: TestRenderer.ReactTestRenderer): string {
  return tree.root.findByType(Text).props.children;
}

describe('backgroundStyleStore', () => {
  beforeEach(() => {
    __resetBackgroundStyleStoreForTest();
    jest.clearAllMocks();
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
  });

  it('默认是 none（纯色底）', () => {
    expect(getBackgroundStyleId()).toBe('none');
    expect(renderedId(renderProbe())).toBe('none');
  });

  it('切换后立即生效（订阅者同步刷新）并持久化到 background_style_id_v1', async () => {
    const tree = renderProbe();

    await act(async () => {
      await setBackgroundStyleId('zhuge');
    });

    expect(getBackgroundStyleId()).toBe('zhuge');
    expect(renderedId(tree)).toBe('zhuge');
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(STORAGE_KEY, 'zhuge');
  });

  it('非法 id 被忽略：既不广播也不写库', async () => {
    const tree = renderProbe();

    await act(async () => {
      await setBackgroundStyleId('不存在的id' as never);
    });

    expect(getBackgroundStyleId()).toBe('none');
    expect(renderedId(tree)).toBe('none');
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
  });

  it('冷启动读回合法值并广播', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue('jiangshan');

    const tree = renderProbe();
    // subscribe 里发起的是异步 getItem，flush 一轮微任务
    await act(async () => {
      await Promise.resolve();
    });

    expect(renderedId(tree)).toBe('jiangshan');
    expect(AsyncStorage.getItem).toHaveBeenCalledWith(STORAGE_KEY);
  });

  it('冷启动读到脏数据时静默保持默认，不会停在非法 id 上', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue('laji');

    const tree = renderProbe();
    await act(async () => {
      await Promise.resolve();
    });

    expect(getBackgroundStyleId()).toBe('none');
    expect(renderedId(tree)).toBe('none');
  });

  it('读库抛错不影响使用', async () => {
    (AsyncStorage.getItem as jest.Mock).mockRejectedValue(new Error('boom'));

    const tree = renderProbe();
    await act(async () => {
      await Promise.resolve();
    });

    expect(renderedId(tree)).toBe('none');
  });

  it('写库抛错时本次会话内仍然生效', async () => {
    (AsyncStorage.setItem as jest.Mock).mockRejectedValue(new Error('boom'));

    const tree = renderProbe();
    await act(async () => {
      await setBackgroundStyleId('shuimo');
    });

    expect(getBackgroundStyleId()).toBe('shuimo');
    expect(renderedId(tree)).toBe('shuimo');
  });
});
