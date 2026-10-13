/**
 * 棋盘「角位带」测试
 *
 * 钉住三件最容易回归的事：
 *  1. 两端贴边且互不侵占：起端靠 flex-start、末端靠 marginLeft:'auto'（B 方案）。
 *  2. gap 按 side 落到正确的边（上带 marginBottom / 下带 marginTop）——
 *     上下留白相等全靠这一条，写反了就会一边贴死一边留白。
 *  3. 带的高度只由**自己的内容**决定：minHeight 兜底，内容更高时自然长高。
 *     这条是 2026-10 四轮实机反馈换来的核心性质 —— 角位内容不得牵动别处。
 */

import React from 'react';
import { Text, View } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

import { BoardEdgeSlot } from '@/components/BoardEdgeSlot';

const ROW_STYLE = { width: 300, alignSelf: 'center' as const };

function render(props: React.ComponentProps<typeof BoardEdgeSlot>) {
  let tree: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(<BoardEdgeSlot {...props} />);
  });
  return tree!;
}

function host(tree: TestRenderer.ReactTestRenderer, testID: string) {
  return tree.root.findAll((n) => n.type === View && n.props.testID === testID, {
    deep: true,
  })[0];
}

const CHIP = <Text>药丸</Text>;
/** 一个更高的内容（模拟被吃棋子：边长大于药丸） */
const TALL = <View style={{ width: 40, height: 40 }} />;

function styleOf(node: TestRenderer.ReactTestInstance) {
  const raw = node.props.style;
  const arr = Array.isArray(raw) ? raw : [raw];
  return Object.assign({}, ...arr.filter(Boolean)) as Record<string, unknown>;
}

function bandStyleOf(tree: TestRenderer.ReactTestRenderer, testID: string) {
  return styleOf(host(tree, testID)!);
}

/**
 * 带里直接挂载的元素（起端原样、末端包了一层 View）。
 *
 * 直接读带的 React children（元素数组），比在实例树里找要确定得多：
 * 实例树里 StyleSheet 组件会多包一层、children 还混着 composite 实例，容易数错。
 */
function bandChildren(tree: TestRenderer.ReactTestRenderer, testID: string) {
  const band = host(tree, testID)!;
  return ([] as React.ReactElement[]).concat(band.props.children ?? []).filter(React.isValidElement);
}

function styleOfElement(el: React.ReactElement) {
  const raw = el.props.style as unknown;
  const arr = Array.isArray(raw) ? raw : [raw];
  return Object.assign({}, ...arr.filter(Boolean)) as Record<string, unknown>;
}

describe('BoardEdgeSlot · 两端贴边', () => {
  it('上带：起端贴左、末端靠 marginLeft:auto 贴右', () => {
    const tree = render({
      side: 'top',
      alignedRowStyle: ROW_STYLE,
      start: CHIP,
      end: CHIP,
      testID: 'band',
    });
    const kids = bandChildren(tree, 'band');
    expect(kids).toHaveLength(2);
    // 起端**直接挂载**（元素本身就是内容，不套 View）⇒ 它的百分比宽度相对带解析
    expect(kids[0].type).toBe(Text);
    expect(kids[0].props.style).toBeUndefined();
    // 末端包一层 View，auto 挂在它身上 ⇒ 推到右端
    expect(kids[1].type).toBe(View);
    expect(styleOfElement(kids[1]).marginLeft).toBe('auto');
  });

  it('只有末端时也贴右端', () => {
    const tree = render({ side: 'top', alignedRowStyle: ROW_STYLE, end: CHIP, testID: 'band' });
    const kids = bandChildren(tree, 'band');
    expect(kids).toHaveLength(1);
    expect(kids[0].type).toBe(View);
    expect(styleOfElement(kids[0]).marginLeft).toBe('auto');
  });

  it('只有起端时贴左，且直接挂载无包装', () => {
    const tree = render({ side: 'top', alignedRowStyle: ROW_STYLE, start: CHIP, testID: 'band' });
    const kids = bandChildren(tree, 'band');
    expect(kids).toHaveLength(1);
    expect(kids[0].type).toBe(Text);
    expect(kids[0].props.style).toBeUndefined();
  });

  it('两端都没有内容时渲染空带（高度 0），不占纵向空间', () => {
    const tree = render({ side: 'bottom', alignedRowStyle: ROW_STYLE, testID: 'band' });
    expect(host(tree, 'band')).toBeDefined();
    expect(bandStyleOf(tree, 'band').minHeight).toBe(0);
    expect(bandChildren(tree, 'band')).toHaveLength(0);
  });
});

/**
 * 约束 1（2026-10 实机：药丸显示成「揭棋引擎（...」被截断）：
 * 药丸用 `maxWidth:'86%'` 限宽，百分比相对**直接父容器**解析。
 * 起端一旦被套进槽 View，86% 就变成「槽宽的 86%」，而槽宽又由药丸自身撑开
 * ⇒ 86% < 药丸宽度 ⇒ 必然截断。故起端必须直接挂载。
 */
describe('BoardEdgeSlot · 起端不得被包装（药丸限宽的百分比才有正确参照）', () => {
  it('起端是带的第一直接子元素，且不是 View', () => {
    const tree = render({ side: 'top', alignedRowStyle: ROW_STYLE, start: CHIP, end: CHIP, testID: 'band' });
    const first = bandChildren(tree, 'band')[0];
    // 如果这里变成 View，说明有人又给起端套了一层槽 —— 药丸会被截断
    expect(first.type).not.toBe(View);
  });

  it('带自身才是药丸的父容器（宽度 = 棋盘宽度，86% 才有意义）', () => {
    const tree = render({ side: 'top', alignedRowStyle: ROW_STYLE, start: CHIP, testID: 'band' });
    const band = host(tree, 'band')!;
    // 带宽来自 alignedRowStyle（与棋盘同宽）⇒ 86% 是「棋盘的 86%」，符合原意
    expect(bandStyleOf(tree, 'band').width).toBe(ROW_STYLE.width);
  });
});

/**
 * 约束 2（2026-10 实机：「有吃子时药丸与棋盘的间隙会变大」）：
 * 带的高度会被更高的内容撑开，若内容垂直居中，矮的药丸到棋盘的距离就被撑大。
 * 贴棋盘一侧对齐后，矮内容的下边（上带）/ 上边（下带）恒贴带边 ⇒ 距离恒为 gap。
 */
describe('BoardEdgeSlot · 内容贴棋盘一侧对齐（间隙不受吃子影响）', () => {
  it('上带用 flex-end（贴下 ⇒ 贴近棋盘顶边）', () => {
    const tree = render({ side: 'top', alignedRowStyle: ROW_STYLE, start: CHIP, testID: 'band' });
    expect(bandStyleOf(tree, 'band').alignItems).toBe('flex-end');
  });

  it('下带用 flex-start（贴上 ⇒ 贴近棋盘底边）', () => {
    const tree = render({ side: 'bottom', alignedRowStyle: ROW_STYLE, start: CHIP, testID: 'band' });
    expect(bandStyleOf(tree, 'band').alignItems).toBe('flex-start');
  });

  it('**不得**用 center：那是「间隙随吃子变大」的根因', () => {
    for (const side of ['top', 'bottom'] as const) {
      const tree = render({ side, alignedRowStyle: ROW_STYLE, start: CHIP, end: TALL, testID: 'band' });
      expect(bandStyleOf(tree, 'band').alignItems).not.toBe('center');
    }
  });
});

describe('BoardEdgeSlot · gap 按 side 落到正确的边', () => {
  it('上带用 marginBottom（留白在带的下方，即贴棋盘那侧）', () => {
    const tree = render({ side: 'top', alignedRowStyle: ROW_STYLE, gap: 4, start: CHIP, testID: 'band' });
    const s = bandStyleOf(tree, 'band');
    expect(s.marginBottom).toBe(4);
    expect(s.marginTop).toBe(0);
  });

  it('下带用 marginTop（留白在带的上方，同样是贴棋盘那侧）', () => {
    const tree = render({ side: 'bottom', alignedRowStyle: ROW_STYLE, gap: 4, start: CHIP, testID: 'band' });
    const s = bandStyleOf(tree, 'band');
    expect(s.marginTop).toBe(4);
    expect(s.marginBottom).toBe(0);
  });

  it('上下两条带用同一个 gap ⇒ 棋盘上下留白相等', () => {
    const top = render({ side: 'top', alignedRowStyle: ROW_STYLE, gap: 6, start: CHIP, testID: 'band' });
    const bottom = render({ side: 'bottom', alignedRowStyle: ROW_STYLE, gap: 6, start: CHIP, testID: 'band' });
    // 两条带与棋盘的距离相等（一个记在下方、一个记在上方，数值同源）
    expect(bandStyleOf(top, 'band').marginBottom).toBe(bandStyleOf(bottom, 'band').marginTop);
  });
});

describe('BoardEdgeSlot · 高度只由自己的内容决定', () => {
  it('minHeight 兜底：无内容时仍占该高度（保持既有角标行的观感）', () => {
    const tree = render({ side: 'top', alignedRowStyle: ROW_STYLE, minHeight: 26, testID: 'band' });
    expect(bandStyleOf(tree, 'band').minHeight).toBe(26);
  });

  it('用 minHeight 而非 height：内容更高时带自然长高，不会撑破别的角位', () => {
    const tree = render({
      side: 'top',
      alignedRowStyle: ROW_STYLE,
      minHeight: 26,
      start: CHIP,
      testID: 'band',
    });
    const s = bandStyleOf(tree, 'band');
    // **不得**有固定 height —— 那正是「撑破药丸行、压到盘面棋子」的机制
    expect(s.height).toBeUndefined();
    expect(s.minHeight).toBe(26);
  });

  it('不设 flex，不参与纵向分配（高度完全由内容/minHeight 决定）', () => {
    const tree = render({ side: 'top', alignedRowStyle: ROW_STYLE, minHeight: 26, start: CHIP, testID: 'band' });
    const s = bandStyleOf(tree, 'band');
    expect(s.flex).toBeUndefined();
    expect(s.flexGrow).toBeUndefined();
    // 来自 alignedRowStyle：与棋盘同宽、同居中 ⇒ 左右边缘落在棋盘本体上
    expect(s.alignSelf).toBe('center');
    expect(s.width).toBe(300);
  });

  it('药丸到棋盘的距离恒为 gap：有吃子时也不变（更矮 ⇒ 更矮，方向相反）', () => {
    // 模拟几何：带的底边（上带）恒等于「棋盘顶边 - gap」。
    // alignItems='flex-end' ⇒ 药丸下边贴带底边 ⇒ 药丸下边到棋盘顶边恒为 gap，
    // **与末端内容有多高无关**。这就是「药丸间隙不受吃子影响」的全部机制。
    const GAP = 4;
    const withTall = render({
      side: 'top',
      alignedRowStyle: ROW_STYLE,
      gap: GAP,
      minHeight: 26,
      start: CHIP,
      end: TALL, // 40pt，远高于药丸
      testID: 'band',
    });
    const s = bandStyleOf(withTall, 'band');
    // 带底边（= 药丸下边）到棋盘的距离由 marginBottom 唯一决定
    expect(s.marginBottom).toBe(GAP);
    // 且不是 center（center 会让药丸在 40pt 高的带里被顶离棋盘 7pt）
    expect(s.alignItems).toBe('flex-end');

    // 下带同理：marginTop 恒为 gap
    const bottom = render({
      side: 'bottom',
      alignedRowStyle: ROW_STYLE,
      gap: GAP,
      start: CHIP,
      testID: 'band',
    });
    expect(bandStyleOf(bottom, 'band').marginTop).toBe(GAP);
    expect(bandStyleOf(bottom, 'band').alignItems).toBe('flex-start');
  });
});
