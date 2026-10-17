/**
 * @/components/GameBottomBar —— 按键点击必须真正触发回调（2026-10 线上问题回归）
 *
 * 线上问题（人机对战）：底栏「提示」「悔棋」按下毫无反应。
 * 根因是**类型契约太松**：`GameBottomBarAction.onPress` 原本声明为可选
 * （`onPress?: () => void`），于是在 screens/game 里拼 actions 时漏接
 * handleHint / handleUndo 既不报 tsc 错误也不报 eslint 错误，
 * 按钮渲染成正常样子、点击时 `action.onPress?.()` 静默跳过。
 *
 * 修复分两层，本文件钉住第一层：
 *   ① 类型层：`onPress` 对非菜单键必填（GameBottomBarAction.onPress: () => void），
 *      只有 key === 'menu' 的 GameBottomBarMenuAction 不带它；
 *   ② 行为层（本测试）：传入的每一个非菜单键按下时都必须调用自己的 onPress，
 *      互不串台；菜单键按下只切换弹出列表，不误触发其它键的回调。
 *
 * 真正防止「忘接回调」回归的是 ① 的类型约束（漏接会在 tsc 阶段报错），
 * 本测试防的是 ②：万一有人把 onPress 又改回可选、或把回调接错到别的键上。
 *
 * react-test-renderer 不做布局，所以这里断言的是**行为契约**，不涉及像素。
 */

import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { StyleSheet } from 'react-native';

import GameBottomBar, {
  BOTTOM_BAR_HEIGHT,
  ARROW_HALF_SIZE,
  POPUP_MAX_CARD_FRACTION,
  POPUP_MIN_CARD_WIDTH,
  type GameBottomBarActionInput,
  type GameMenuItem,
} from '@/components/GameBottomBar';

function renderBar(node: React.ReactElement) {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(node);
  });
  return tree;
}

/** 按可访问性标签找到某个按键的 Pressable 节点 */
function pressByLabel(
  tree: TestRenderer.ReactTestRenderer,
  label: string
): TestRenderer.ReactTestInstance {
  const node = tree.root.findAll(
    (n) => typeof n.type !== 'string' && n.props.accessibilityLabel === label
  )[0];
  if (!node) throw new Error(`未找到按键：${label}`);
  return node;
}

/** 弹层用例共用的一组菜单项（含最长的六字文案，用于代表窄屏最坏情况） */
const MENU_ITEMS: GameMenuItem[] = [
  { key: 'settings', icon: 'gear', label: '房间设置', onPress: () => undefined },
  { key: 'exit', icon: 'door-open', label: '退出对局', onPress: () => undefined },
];

/** 4 键底栏（菜单在最左，与人机/在线对战一致） */
const NARROW_ACTIONS: GameBottomBarActionInput[] = [
  { key: 'menu', icon: 'bars', label: '菜单' },
  { key: 'surrender', icon: 'flag', label: '认输', onPress: () => undefined },
  { key: 'draw', icon: 'handshake', label: '求和', onPress: () => undefined },
  { key: 'undo', icon: 'rotate-left', label: '悔棋', onPress: () => undefined },
];

/** 2 键底栏（回放页「菜单 / 上一步」），槽宽很大，用于验证宽度上限 */
const WIDE_ACTIONS: GameBottomBarActionInput[] = [
  { key: 'menu', icon: 'bars', label: '菜单' },
  { key: 'next', icon: 'forward-step', label: '下一步', onPress: () => undefined },
];

/**
 * 手动触发按钮行的 onLayout，把「实测行宽」喂给组件。
 * react-test-renderer 不做布局不会自动回调，因此显式调用其 onLayout prop；
 * 这样用例走的是真机上 rowWidth 的同一条路径，而非首帧的屏幕宽兜底。
 */
function layoutRow(tree: TestRenderer.ReactTestRenderer, width: number) {
  const row = tree.root.findAll((n) => {
    const s = StyleSheet.flatten(n.props?.style) as Record<string, unknown> | undefined;
    return (
      !!n.props?.onLayout &&
      !!s &&
      s.height === BOTTOM_BAR_HEIGHT &&
      s.flexDirection === 'row'
    );
  })[0];
  if (!row) throw new Error('未找到按钮行节点');
  act(() => {
    row.props.onLayout({ nativeEvent: { layout: { width, height: BOTTOM_BAR_HEIGHT } } });
  });
}

/**
 * 捞出弹出卡片的展开态宽度（px）。
 * 卡片带 testID，定位唯一；StyleSheet.create 产出的是数字 ID，
 * 需经 StyleSheet.flatten 解析回对象才能读到 width。
 */
function cardBox(tree: TestRenderer.ReactTestRenderer): { left: number; width: number } {
  const card = tree.root.findByProps({ testID: 'game-bottom-bar-popup-card' });
  const s = StyleSheet.flatten(card.props.style) as Record<string, unknown>;
  if (typeof s.width !== 'number' || typeof s.left !== 'number') {
    throw new Error(`卡片 left/width 不是像素值：${JSON.stringify(s)}`);
  }
  return { left: s.left, width: s.width };
}

function cardWidth(tree: TestRenderer.ReactTestRenderer): number {
  return cardBox(tree).width;
}

/**
 * 读出某个节点的展开态样式。
 * Pressable 的 style 是**函数**（`{ pressed } => style[]`），
 * 直接 StyleSheet.flatten 一个函数只会得到 undefined，必须先调用它；
 * 非函数样式则原样 flatten。
 */
function styleOf(node: TestRenderer.ReactTestInstance): Record<string, unknown> {
  const raw = node.props.style;
  const resolved = typeof raw === 'function' ? raw({ pressed: false }) : raw;
  return (StyleSheet.flatten(resolved) ?? {}) as Record<string, unknown>;
}

/** 渲染 → 喂入实测行宽 → 打开弹出列表，返回可继续断言的渲染树 */
function openMenu(actions: GameBottomBarActionInput[], rowWidth: number) {
  const tree = renderBar(<GameBottomBar actions={actions} menuItems={MENU_ITEMS} />);
  layoutRow(tree, rowWidth);
  act(() => {
    pressByLabel(tree, '菜单').props.onPress();
  });
  return tree;
}

/**
 * 求一个节点的**有效** pointerEvents —— 严格按 RN 的真实判定来，不看样式。
 *
 * 依据 RN 0.81.5 自己的类型声明（ViewPropTypes.d.ts:199-200）：
 * 「since pointerEvents does not affect layout/appearance ... we opt to
 * **not include pointerEvents on style**」。
 * 即：pointerEvents 只有作为 **prop** 时才生效；写在 style 里是**死代码**，
 * 节点会回落默认值 auto（可命中）。
 *
 * 因此本辅助函数只认 prop：写错地方（塞进 style）的守卫会立刻暴露成 'auto'，
 * 而不是被测试的宽松实现糊弄过去——宁可误报，不可漏报。
 */
function effectivePointerEvents(node: TestRenderer.ReactTestInstance): string {
  const prop = node.props?.pointerEvents;
  return typeof prop === 'string' ? prop : 'auto';
}

describe('GameBottomBar 按键回调契约', () => {
  it('非菜单键按下时各自触发自己的 onPress，且互不串台', () => {
    const hint = jest.fn();
    const undo = jest.fn();
    const restart = jest.fn();
    const actions: GameBottomBarActionInput[] = [
      { key: 'hint', icon: 'lightbulb', label: '提示', onPress: hint },
      { key: 'undo', icon: 'rotate-left', label: '悔棋', onPress: undo },
      { key: 'restart', icon: 'rotate-right', label: '重开', onPress: restart },
    ];

    const tree = renderBar(<GameBottomBar actions={actions} />);

    act(() => {
      pressByLabel(tree, '悔棋').props.onPress();
    });

    // 核心回归点：点「悔棋」必须真的跑到 handleUndo
    expect(undo).toHaveBeenCalledTimes(1);
    // 且不能误触发同栏其它键
    expect(hint).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();

    act(() => {
      pressByLabel(tree, '提示').props.onPress();
    });
    expect(hint).toHaveBeenCalledTimes(1);
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it('禁用态按键不触发 onPress', () => {
    const hint = jest.fn();
    const actions: GameBottomBarActionInput[] = [
      { key: 'hint', icon: 'lightbulb', label: '提示', disabled: true, onPress: hint },
    ];

    const tree = renderBar(<GameBottomBar actions={actions} />);

    act(() => {
      pressByLabel(tree, '提示').props.onPress();
    });

    expect(hint).not.toHaveBeenCalled();
  });

  it('菜单键只切换弹出列表，不触发其它按键的回调', () => {
    const undo = jest.fn();
    const onFlip = jest.fn();
    const menuItems: GameMenuItem[] = [
      { key: 'flip', icon: 'arrows-rotate', label: '翻转棋盘', onPress: onFlip },
    ];
    const actions: GameBottomBarActionInput[] = [
      { key: 'menu', icon: 'bars', label: '菜单' },
      { key: 'undo', icon: 'rotate-left', label: '悔棋', onPress: undo },
    ];

    const tree = renderBar(<GameBottomBar actions={actions} menuItems={menuItems} />);

    act(() => {
      pressByLabel(tree, '菜单').props.onPress();
    });

    // 菜单键不串台
    expect(undo).not.toHaveBeenCalled();

    // 弹出列表项可达且能触发
    act(() => {
      pressByLabel(tree, '翻转棋盘').props.onPress();
    });
    expect(onFlip).toHaveBeenCalledTimes(1);
  });

  it('BOTTOM_BAR_HEIGHT 为正数（布局预算按此常量预留底栏高度）', () => {
    expect(BOTTOM_BAR_HEIGHT).toBeGreaterThan(0);
  });

  describe('弹出列表宽度按像素自适应（2026-10 线上问题：窄屏文案溢出）', () => {
    it('窄屏下卡片有像素下限，不会被压到窄于最小可读宽度', () => {
      // 320pt 机型、4 个按键：槽宽 80px，纯「两槽」=160px 已窄于可读宽度，下限必须生效。
      const tree = openMenu(NARROW_ACTIONS, 320);
      expect(cardWidth(tree)).toBeGreaterThanOrEqual(POPUP_MIN_CARD_WIDTH);
    });

    it('宽屏下不超过行宽的 78%（不会横贯整屏）', () => {
      // 640pt、2 个按键：槽宽 320px，「两槽」=640px 会被 78% 上限夹住。
      const tree = openMenu(WIDE_ACTIONS, 640);
      expect(cardWidth(tree)).toBeLessThanOrEqual(640 * POPUP_MAX_CARD_FRACTION);
    });

    it('卡片完整落在按钮行内，不会越出左/右边界', () => {
      for (const rowWidth of [320, 400, 640, 900]) {
        const tree = openMenu(NARROW_ACTIONS, rowWidth);
        const { left, width } = cardBox(tree);
        // 最小宽度下限可能把卡片推到左边界，但绝不允许越界或反向
        expect(left).toBeGreaterThanOrEqual(0);
        expect(left + width).toBeLessThanOrEqual(rowWidth + 0.001);
      }
    });

    it('指向三角始终正对菜单键，且不越过卡片左右圆角', () => {
      const rowWidth = 400;
      const tree = openMenu(NARROW_ACTIONS, rowWidth);
      const arrow = tree.root.findByProps({ testID: 'game-bottom-bar-popup-arrow' });
      const arrowStyle = StyleSheet.flatten(arrow.props.style) as Record<string, unknown>;
      const arrowLeft = (arrowStyle.left as number) + (arrowStyle.marginLeft as number);
      const { left, width } = cardBox(tree);

      // 菜单键中心
      const anchorCenter = (rowWidth / NARROW_ACTIONS.length) / 2;
      // 三角中心落在卡片内，且尽量贴近菜单键中心
      expect(arrowLeft).toBeGreaterThanOrEqual(left);
      expect(arrowLeft).toBeLessThanOrEqual(left + width);
      expect(Math.abs(arrowLeft - anchorCenter)).toBeLessThan(ARROW_HALF_SIZE * 2);
    });

    it('行宽变化时宽度跟随重算（旋转屏幕/窄宽宽屏切换）', () => {
      const tree = openMenu(NARROW_ACTIONS, 400);
      const before = cardWidth(tree);
      layoutRow(tree, 900);
      const after = cardWidth(tree);
      expect(after).not.toBe(before);
      expect(after).toBeLessThanOrEqual(900 * POPUP_MAX_CARD_FRACTION);
    });
  });

  /**
   * lanBattle 要求：弹出卡片宽度**固定等于按钮行宽**（与下方菜单项同宽）。
   *
   * 该页我方名角标行贴在卡片正上方，卡片宽度随按键数（等待 2 键 / 对局 4 键 /
   * 结束 3 键）忽宽忽窄时，两者的左右边界对不齐，实机看起来就是"错位"。
   * 因此新增 popupWidthMode='row'：宽度恒等于实测行宽，左右边缘与底栏严格对齐。
   */
  describe("popupWidthMode='row'：卡片固定与按钮行同宽", () => {
    function openRowMenu(actions: GameBottomBarActionInput[], rowWidth: number) {
      const tree = renderBar(
        <GameBottomBar actions={actions} menuItems={MENU_ITEMS} popupWidthMode="row" />
      );
      layoutRow(tree, rowWidth);
      act(() => {
        pressByLabel(tree, '菜单').props.onPress();
      });
      return tree;
    }

    it('宽度恒等于实测行宽，与按键数无关', () => {
      // 同一行宽下，4 键与 2 键的卡片宽度必须完全一致（槽宽不再参与）
      const narrow = openRowMenu(NARROW_ACTIONS, 400);
      const wide = openRowMenu(WIDE_ACTIONS, 400);
      expect(cardWidth(narrow)).toBe(400);
      expect(cardWidth(wide)).toBe(400);
    });

    it('卡片左右边缘与按钮行严格对齐（left 恒为 0）', () => {
      for (const rowWidth of [320, 400, 640, 900]) {
        const tree = openRowMenu(NARROW_ACTIONS, rowWidth);
        const { left, width } = cardBox(tree);
        expect(left).toBe(0);
        expect(width).toBe(rowWidth);
        expect(left + width).toBe(rowWidth);
      }
    });

    it("'auto' 模式仍保持原自适应行为（未被 row 模式改写）", () => {
      // 回归护栏：默认行为必须仍是「两槽 + 上下限夹取」，否则人机/回放页观感回退
      const auto = openMenu(NARROW_ACTIONS, 400);
      expect(cardWidth(auto)).not.toBe(400);
    });

    it('指向三角仍正对菜单键，且不越过卡片边界', () => {
      const rowWidth = 400;
      const tree = openRowMenu(NARROW_ACTIONS, rowWidth);
      const arrow = tree.root.findByProps({ testID: 'game-bottom-bar-popup-arrow' });
      const arrowStyle = StyleSheet.flatten(arrow.props.style) as Record<string, unknown>;
      const arrowLeft = (arrowStyle.left as number) + (arrowStyle.marginLeft as number);
      const anchorCenter = (rowWidth / NARROW_ACTIONS.length) / 2;

      expect(arrowLeft).toBeGreaterThanOrEqual(0);
      expect(arrowLeft).toBeLessThanOrEqual(rowWidth);
      expect(Math.abs(arrowLeft - anchorCenter)).toBeLessThan(ARROW_HALF_SIZE * 2);
    });
  });

  describe('收起后的弹层必须彻底不参与命中测试（2026-10 线上问题：底栏上方隐形按钮）', () => {
    /**
     * 线上症状：菜单收起后，底栏正上方仍有一块看不见但能点的区域，
     * 点它会走 onPress → 退出对局 → 弹「保存对局」确认框。
     *
     * 根因：弹层为播退场动画而常驻挂载（PopupMenu 只在 items 为空时才 return null），
     * 收起时靠 `opacity` 隐藏——但 opacity 不参与命中测试。更关键的是 RN 0.81
     * 明确**不把 pointerEvents 当样式属性**（ViewPropTypes.d.ts:199-200
     * 「we opt to not include pointerEvents on style」），于是
     * `visible && styles.cardRowLive` 在收起时等于什么都没给，
     * 行节点回落 RN 默认值 auto → 隐形但可点。
     *
     * 修复：把所有「可命中」开关从 style 挪到 prop，并上提到真正管住整棵子树的卡片节点，
     * 收起时给 pointerEvents="none"（子节点也随之不命中），不再依赖每行各自记得加 visible &&。
     */

    /** 展开 → 再收起，返回收起后的渲染树 */
    function openThenCloseMenu(actions: GameBottomBarActionInput[] = NARROW_ACTIONS, rowWidth = 400) {
      const tree = openMenu(actions, rowWidth);
      act(() => {
        pressByLabel(tree, '菜单').props.onPress();
      });
      return tree;
    }

    it('收起后弹层内每个可命中节点都是 none（含遮罩与每一行）', () => {
      const tree = openThenCloseMenu();

      const card = tree.root.findByProps({ testID: 'game-bottom-bar-popup-card' });
      const backdrop = tree.root.findAll(
        (n) => typeof n.type !== 'string' && n.props.accessibilityLabel === '关闭菜单'
      )[0];
      if (!backdrop) throw new Error('未找到弹层遮罩');

      // 逐个核对弹层内全部带命中语义的节点。漏掉任何一个，隐形按钮就会换个形态复活：
      // · 遮罩整屏溢出（top:-2×屏高），回落 auto 会吞掉整个棋盘，影响面最大；
      // · 「退出对局」行回落 auto 就是本次线上那块隐形按钮。
      const nodes = [card, backdrop, ...MENU_ITEMS.map((item) => pressByLabel(tree, item.label))];
      for (const node of nodes) {
        expect(effectivePointerEvents(node)).toBe('none');
      }
    });

    it('展开时仍然正常可命中（修复不得把弹层打瞎）', () => {
      const onFlip = jest.fn();
      const menuItems: GameMenuItem[] = [
        { key: 'flip', icon: 'arrows-rotate', label: '翻转棋盘', onPress: onFlip },
      ];
      const tree = renderBar(<GameBottomBar actions={NARROW_ACTIONS} menuItems={menuItems} />);
      layoutRow(tree, 400);

      act(() => {
        pressByLabel(tree, '菜单').props.onPress();
      });

      const card = tree.root.findByProps({ testID: 'game-bottom-bar-popup-card' });
      const backdrop = tree.root.findAll(
        (n) => typeof n.type !== 'string' && n.props.accessibilityLabel === '关闭菜单'
      )[0];
      if (!backdrop) throw new Error('未找到弹层遮罩');

      expect(effectivePointerEvents(card)).toBe('box-none');
      expect(effectivePointerEvents(backdrop)).toBe('auto');
      expect(effectivePointerEvents(pressByLabel(tree, '翻转棋盘'))).toBe('auto');

      act(() => {
        pressByLabel(tree, '翻转棋盘').props.onPress();
      });
      expect(onFlip).toHaveBeenCalledTimes(1);
    });
  });

  describe('弹层行内「图标 + 文案」连成一体（2026-10 线上问题：图标文字割裂）', () => {
    /** 弹出列表里的某一行：行容器 / 文案 / 图标占位，三个节点 */
    function popupRowParts(tree: TestRenderer.ReactTestRenderer, key: string, label: string) {
      const row = tree.root.findAll(
        (n) => typeof n.type !== 'string' && n.props.accessibilityLabel === label
      )[0];
      if (!row) throw new Error(`未找到弹层行：${label}`);
      const labelHost = tree.root.findAll(
        (n) => typeof n.type === 'string' && n.props.children === label
      )[0];
      if (!labelHost) throw new Error(`未找到文案节点：${label}`);
      const iconFrame = tree.root.findAll((n) => n.props.testID === `game-bottom-bar-popup-icon-${key}`)[0];
      if (!iconFrame) throw new Error(`未找到图标占位节点：${key}`);
      return { row, labelHost, iconFrame };
    }

    it('文案不得用 flex:1 撑满剩余宽度（那会让图标与文字之间裂开缝隙）', () => {
      const tree = openMenu(NARROW_ACTIONS, 400);
      const { labelHost } = popupRowParts(tree, 'exit', '退出对局');
      const s = styleOf(labelHost);
      // flex:1 / '100%' 会让文案横向铺满，图标被推到最左 → 割裂
      expect(s.flex).not.toBe(1);
      expect(s.width).toBeUndefined();
      expect(s.textAlign).not.toBe('center');
    });

    it('行本身居中且图标与文案之间只有固定间距', () => {
      const tree = openMenu(NARROW_ACTIONS, 400);
      const { row } = popupRowParts(tree, 'exit', '退出对局');
      const s = styleOf(row);
      // 整组（图标+文字）居中，而不是只让文字居中
      expect(s.justifyContent).toBe('center');
      expect(s.alignItems).toBe('center');
      expect(s.flexDirection).toBe('row');
      // 图标与文字之间是紧凑的固定间距，不是被拉开的空白
      expect(typeof s.gap).toBe('number');
      expect(s.gap as number).toBeGreaterThan(0);
      expect(s.gap as number).toBeLessThanOrEqual(12);
    });

    it('图标占位宽度固定，保证菜单内多行文案左右对齐成一条线', () => {
      const tree = openMenu(NARROW_ACTIONS, 400);
      const { iconFrame } = popupRowParts(tree, 'exit', '退出对局');
      const s = styleOf(iconFrame);
      expect(typeof s.width).toBe('number');
      expect(s.alignItems).toBe('center');
      expect(s.justifyContent).toBe('center');
    });
  });
});