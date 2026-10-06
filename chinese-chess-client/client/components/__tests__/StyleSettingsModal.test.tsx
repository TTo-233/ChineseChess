/**
 * @/components/StyleSettingsModal —— 「样式设置」弹窗（棋盘 / 背景 双分页）
 *
 * 用户 m02998 要求把背景图集成进首页右上角的样式入口，m02531 明确：
 * 弹窗标题改成「样式设置」，并做棋盘与背景两个按钮的切换。
 *
 * 本文件钉住四条契约：
 *   ① 标题是「样式设置」（不再是「棋盘样式」）；
 *   ② 两枚分页按钮存在，默认停在「棋盘」；
 *   ③ 切到「背景」后棋盘卡片整体消失、背景卡片出现（含「默认」纯色底）；
 *   ④ 点卡片即选中——写 store、写 AsyncStorage、并把选中态挪到该卡片上。
 *      两个分页各自写各自的 key，互不串台。
 *
 * 说明：这里直接调 `props.onPress()`，是**接线检查**而非命中测试
 * （react-test-renderer 不做触摸派发）。同类教训见【C-80】：按压行为要用
 * pointerEvents 属性断言，不能靠 mock 里调 onPress 去推断。
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

import StyleSettingsModal from '@/components/StyleSettingsModal';
import {
  getBackgroundStyleId,
  __resetBackgroundStyleStoreForTest,
} from '@/utils/chess/backgroundStyleStore';

const BACKGROUND_KEY = 'background_style_id_v1';
const BOARD_KEY = 'board_style_id_v1';

/** 把 StyleProp 摊平成单个对象 */
function flatten(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) {
    return style.reduce<Record<string, unknown>>((acc, s) => ({ ...acc, ...flatten(s) }), {});
  }
  return (style ?? {}) as Record<string, unknown>;
}

function render(visible = true) {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(<StyleSettingsModal visible={visible} onClose={() => undefined} />);
  });
  return tree;
}

/** 树里所有字符串文本 */
function allText(tree: TestRenderer.ReactTestRenderer): string[] {
  return tree.root
    .findAllByType(Text)
    .map((n) => n.props.children)
    .filter((c: unknown): c is string => typeof c === 'string');
}

/**
 * 按文案找可点卡片/按钮并按下。
 * 取最内层匹配项：外层容器也可能带 onPress，但只有内层那张卡片承载 label。
 */
function pressByText(tree: TestRenderer.ReactTestRenderer, label: string) {
  const matches = tree.root.findAll(
    (n) =>
      typeof n.props.onPress === 'function' &&
      n.findAll((c) => c.type === Text && c.props.children === label).length > 0
  );
  if (matches.length === 0) throw new Error(`未找到可点击元素：${label}`);
  const node = matches[matches.length - 1];
  act(() => {
    node.props.onPress();
  });
  return node;
}

/** 卡片是否处于选中态（选中态 = 外框换成主题古铜金） */
function isSelected(tree: TestRenderer.ReactTestRenderer, label: string): boolean {
  const matches = tree.root.findAll(
    (n) =>
      typeof n.props.onPress === 'function' &&
      n.findAll((c) => c.type === Text && c.props.children === label).length > 0
  );
  if (matches.length === 0) throw new Error(`未找到卡片：${label}`);
  return flatten(matches[matches.length - 1].props.style).borderColor === '#8B6914';
}

describe('StyleSettingsModal', () => {
  beforeEach(() => {
    __resetBackgroundStyleStoreForTest();
    jest.clearAllMocks();
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
  });

  it('标题为「样式设置」，且提供「棋盘」「背景」两枚分页按钮', () => {
    const tree = render();
    const texts = allText(tree);

    expect(texts).toContain('样式设置');
    expect(texts).not.toContain('棋盘样式');
    expect(texts).toContain('棋盘');
    expect(texts).toContain('背景');
  });

  it('默认停在「棋盘」分页：只渲染三种棋盘样式，背景卡片不出现', () => {
    const texts = allText(render());

    expect(texts).toEqual(expect.arrayContaining(['经典', '花梨木', '玄墨']));
    for (const bgName of ['默认', '江山', '竹月', '华彩', '茶室']) {
      expect(texts).not.toContain(bgName);
    }
  });

  it('切到「背景」分页：五张背景卡片出现，棋盘卡片消失', () => {
    const tree = render();
    pressByText(tree, '背景');
    const texts = allText(tree);

    expect(texts).toEqual(expect.arrayContaining(['默认', '江山', '竹月', '华彩', '茶室']));
    for (const boardName of ['经典', '花梨木', '玄墨']) {
      expect(texts).not.toContain(boardName);
    }
  });

  it('分页可来回切换，且回到「棋盘」后棋盘样式还在', () => {
    const tree = render();
    pressByText(tree, '背景');
    expect(allText(tree)).toContain('江山');
    pressByText(tree, '棋盘');
    expect(allText(tree)).toContain('经典');
    expect(allText(tree)).not.toContain('江山');
  });

  it('选中背景即生效 + 持久化，选中态挪到该卡片上', async () => {
    const tree = render();
    pressByText(tree, '背景');
    expect(isSelected(tree, '江山')).toBe(false);
    expect(isSelected(tree, '默认')).toBe(true);

    await act(async () => {
      pressByText(tree, '江山');
      await Promise.resolve();
    });

    expect(getBackgroundStyleId()).toBe('jiangshan');
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(BACKGROUND_KEY, 'jiangshan');
    expect(isSelected(tree, '江山')).toBe(true);
    expect(isSelected(tree, '默认')).toBe(false);
  });

  it('可以退回「默认」（纯色底），保证背景能被取消', async () => {
    const tree = render();
    pressByText(tree, '背景');

    await act(async () => {
      pressByText(tree, '江山');
      await Promise.resolve();
    });
    expect(getBackgroundStyleId()).toBe('jiangshan');

    await act(async () => {
      pressByText(tree, '默认');
      await Promise.resolve();
    });
    expect(getBackgroundStyleId()).toBe('none');
    expect(AsyncStorage.setItem).toHaveBeenLastCalledWith(BACKGROUND_KEY, 'none');
  });

  it('「棋盘」分页写的是棋盘自己的 key，不与背景串台', async () => {
    const tree = render();

    await act(async () => {
      pressByText(tree, '花梨木');
      await Promise.resolve();
    });

    expect(AsyncStorage.setItem).toHaveBeenCalledWith(BOARD_KEY, 'huali');
    expect(AsyncStorage.setItem).not.toHaveBeenCalledWith(BACKGROUND_KEY, expect.anything());
    expect(getBackgroundStyleId()).toBe('none');
  });

  it('visible=false 时不渲染内容（弹窗未打开不占位）', () => {
    const texts = allText(render(false));
    expect(texts).not.toContain('样式设置');
  });
});
