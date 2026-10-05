/**
 * Screen 的整屏背景图能力（`backgroundImage` prop）
 *
 * 这是本次「背景图」功能唯一跨越所有页面的公共改动，也是最容易悄悄回归的一处：
 * 背景图必须铺满**物理整屏**（含状态栏那条 insets.top 高的区域）、位于内容之下，
 * 且**不能吃掉点击**。页面自己放绝对定位 Image 做不到第一点 —— 子树不含滚动容器时
 * Screen 会再包一层 KeyboardAwareScrollView，ScrollView 会把越界内容裁掉。
 *
 * 这里钉住五条：
 *   ① 传图时渲染一层绝对定位、按负安全区偏移撑满整屏的背景层；
 *   ② `pointerEvents="none"` 挂在**那层 View** 上，且必须是 JSX prop；
 *   ③ Image 自身填满背景层（StyleSheet.absoluteFill）；
 *   ④ 不传图时**一个 Image 都不渲染**（默认观感零回归）；
 *   ⑤ 背景是本页第一个子节点 ⇒ 压在内容之下。
 *
 * ② 为什么必须是 View：`pointerEvents` 写进 style 会被 RN 静默忽略（【C-80】），
 * 而 RN 的类型里只有 View 声明了 `pointerEvents`，**ImageProps 根本没有这个 prop** ——
 * 直接写在 Image 上 tsc 报 TS2769，运行时也会被丢掉，全屏图就会拦截棋盘点击。
 */

// uniwind 直接发 TS 源码（node_modules 不被 transform），而它只是把 Screen 包一层
// 用来解析 className/CSS 变量 —— 与背景图无关，替换成恒等函数即可
jest.mock('uniwind', () => ({
  __esModule: true,
  withUniwind: (Component: unknown) => Component,
}));

// Screen 通过 useSafeAreaInsets 取安全区，固定成一组非零值才能验出负偏移
jest.mock('react-native-safe-area-context', () => ({
  __esModule: true,
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));

import React from 'react';
import { Image, Text, View } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

import { Screen } from '@/components/Screen';

const INSETS = { top: 47, bottom: 34, left: 0, right: 0 };

function flatten(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) {
    return style.reduce<Record<string, unknown>>((acc, s) => ({ ...acc, ...flatten(s) }), {});
  }
  return (style ?? {}) as Record<string, unknown>;
}

/** Screen 外层那个整屏 View（flex:1 + 带安全区 padding） */
function wrapperOf(tree: TestRenderer.ReactTestRenderer) {
  const found = tree.root
    .findAllByType(View)
    .find((n) => 'paddingTop' in flatten(n.props.style) && flatten(n.props.style).flex === 1);
  if (!found) throw new Error('未找到 Screen 的外层容器');
  return found;
}

/** 背景层：wrapper 的第一个子节点 */
function backgroundLayerOf(tree: TestRenderer.ReactTestRenderer): React.ReactElement<any> {
  const children = React.Children.toArray(wrapperOf(tree).props.children);
  const first = children[0];
  if (!React.isValidElement(first)) throw new Error('第一个子节点不是有效元素');
  return first as React.ReactElement<any>;
}

function renderScreen(props: Record<string, unknown> = {}) {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(
      <Screen safeAreaEdges={['top', 'left', 'right']} {...props}>
        <Text>内容</Text>
      </Screen>
    );
  });
  return tree;
}

describe('Screen 背景图', () => {
  it('不传 backgroundImage 时不渲染任何 Image（默认观感零回归）', () => {
    const tree = renderScreen();
    expect(tree.root.findAllByType(Image)).toHaveLength(0);
  });

  it('传 null 等同不传', () => {
    const tree = renderScreen({ backgroundImage: null });
    expect(tree.root.findAllByType(Image)).toHaveLength(0);
  });

  it('背景层按负安全区偏移撑满物理整屏', () => {
    const tree = renderScreen({ backgroundImage: { uri: 'bg' } });
    const layer = backgroundLayerOf(tree);

    expect(layer.type).toBe(View);
    const style = flatten(layer.props.style);
    expect(style.position).toBe('absolute');
    // 抵消 wrapperStyle 的四向内边距，使图片盒子等于物理整屏
    expect(style.top).toBe(-INSETS.top);
    expect(style.bottom).toBe(-INSETS.bottom);
    expect(style.left).toBe(-INSETS.left);
    expect(style.right).toBe(-INSETS.right);
    // 铺满靠四向偏移，不能再给固定尺寸
    expect(style.width).toBeUndefined();
    expect(style.height).toBeUndefined();
  });

  it('pointerEvents="none" 挂在背景层 View 上，且是 JSX prop 而不是 style', () => {
    const tree = renderScreen({ backgroundImage: { uri: 'bg' } });
    const layer = backgroundLayerOf(tree);

    expect(layer.props.pointerEvents).toBe('none');
    // 【C-80】铁证：RN 明确不把 pointerEvents 纳入 style，写进去等于没写
    expect(flatten(layer.props.style).pointerEvents).toBeUndefined();
    // 也绝不能声明在 Image 上：ImageProps 没有这个 prop，会被静默丢弃
    expect(tree.root.findByType(Image).props.pointerEvents).toBeUndefined();
  });

  it('Image 填满背景层，默认 cover', () => {
    const tree = renderScreen({ backgroundImage: { uri: 'bg' } });
    const images = tree.root.findAllByType(Image);
    expect(images).toHaveLength(1);

    const style = flatten(images[0].props.style);
    expect(images[0].props.resizeMode).toBe('cover');
    expect(style.top).toBe(0);
    expect(style.left).toBe(0);
    expect(style.right).toBe(0);
    expect(style.bottom).toBe(0);
  });

  it('backgroundResizeMode 可覆盖（如竖图改用 stretch）', () => {
    const tree = renderScreen({ backgroundImage: { uri: 'bg' }, backgroundResizeMode: 'stretch' });
    expect(tree.root.findByType(Image).props.resizeMode).toBe('stretch');
  });

  it('背景是第一个子节点 ⇒ 压在棋盘等内容之下', () => {
    const tree = renderScreen({ backgroundImage: { uri: 'bg' } });
    expect(backgroundLayerOf(tree).type).toBe(View);
    // 内容仍在（背景层不能把 children 顶掉）
    expect(tree.root.findAllByType(Text)).toHaveLength(1);
  });

  it('safeAreaEdges 不含 bottom 时外层 paddingBottom 为 0（背景图一直铺到屏幕底）', () => {
    const tree = renderScreen({ backgroundImage: { uri: 'bg' } });
    const style = flatten(wrapperOf(tree).props.style);
    expect(style.paddingTop).toBe(INSETS.top);
    expect(style.paddingBottom).toBe(0);
  });
});
