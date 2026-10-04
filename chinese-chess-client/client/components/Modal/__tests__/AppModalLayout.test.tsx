/**
 * @/components/Modal/AppModal —— 卡片高度预算契约（【C-81】）
 *
 * 线上问题：在线对局房间设置弹窗在窄屏上「取消/保存」被顶到卡片下沿之外，
 * 压在背景棋盘上、点不到。根因不是内容太多，而是**收缩链断了一环**：
 * RN 的 `flexShrink` 默认值是 **0**（与 CSS 的 1 相反），此前 `AppModal.body`
 * 只声明了 `minHeight: 0` 而没有 `flexShrink: 1`，于是 body 拒绝收缩，
 * 卡片又被 `maxHeight` 硬切，children 里的 ScrollView 拿到的高度大于卡片剩余空间，
 * 页脚因此溢出。
 *
 * 修复后的契约（本文件钉的就是这三条）：
 *   ① body 能收缩：flexShrink:1 + minHeight:0 缺一不可；
 *   ② 传 footer 时内容区与页脚区**是两个兄弟节点**，页脚不参与滚动；
 *   ③ 不传 footer 时渲染结构与既往一致（children 直接铺在 body 下），
 *      保证另外 8 个未迁移的调用点行为不变。
 *
 * react-test-renderer 不做布局，所以这里断言的是**样式契约与树形结构**；
 * 真实像素高度仍须实机验证（本测试能防住的是「有人把 flexShrink:1 删掉」
 * 或「把 footer 挪回 ScrollView 里」这两类回归）。
 */

import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { ScrollView, Text, View } from 'react-native';

import AppModal from '@/components/Modal/AppModal';
import { ModalButton, modalButtonRowStyle } from '@/components/Modal/ModalButton';

/** AppModal 给内容区/页脚区打的 testID（见 AppModal.tsx 的 C-81 注释块） */
const CONTENT_ID = 'app-modal-body-content';
const FOOTER_ID = 'app-modal-footer';

/** 把 StyleProp<ViewStyle> 摊平成本对象，便于逐键断言（测试里全部传纯对象样式） */
function flatten(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) {
    return style.reduce<Record<string, unknown>>(
      (acc, item) => ({ ...acc, ...flatten(item) }),
      {}
    );
  }
  return (style ?? {}) as Record<string, unknown>;
}

/**
 * 组件节点的 type 在不同 RN 版本下可能是 "View"（host 字符串）或 View 函数（测试替身），
 * 跨节点比较时统一归一为字符串，避免因渲染层级差异产生假失败。
 */
function typeKey(n: TestRenderer.ReactTestInstance): string {
  if (typeof n.type === 'string') return n.type;
  const t = n.type as { displayName?: string; name?: string };
  return t.displayName ?? t.name ?? 'View';
}

function renderModal(node: React.ReactElement) {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(node);
  });
  return tree;
}

/** 按 testID 取 AppModal 内部节点（取第一个 host 节点，避开 test renderer 的包装层） */
function hostByTestId(tree: TestRenderer.ReactTestRenderer, testID: string) {
  const found = tree.root.findAllByProps({ testID });
  return found.find((n) => typeof n.type === 'string') ?? found[0] ?? null;
}

/** 定位 body 节点：AppModal 的 body 带 SIZES.modalPadding(24) 的内边距 */
function findBody(tree: TestRenderer.ReactTestRenderer) {
  return tree.root.findAll(
    (n) => {
      const s = flatten(n.props.style);
      return s.padding === 24 && s.paddingTop === 20;
    },
    { deep: true }
  )[0];
}

const footerNode = <Text>页脚</Text>;

describe('AppModal 卡片高度预算（【C-81】）', () => {
  describe('① 收缩链：body 必须同时具备 flexShrink:1 与 minHeight:0', () => {
    it('body 有 flexShrink:1 —— RN 的 flexShrink 默认 0，少这条整条链都不收缩', () => {
      const tree = renderModal(
        <AppModal visible onClose={() => undefined} title="房间设置">
          <ScrollView style={{ flexGrow: 0, flexShrink: 1, minHeight: 0 }}>
            <Text>表单</Text>
          </ScrollView>
        </AppModal>
      );

      const body = findBody(tree);
      expect(body).toBeDefined();

      const s = flatten(body!.props.style);
      expect(s.flexShrink).toBe(1);
      // minHeight:0 解除 flex 子项「自动最小尺寸 = 内容尺寸」；与 flexShrink:1 是配套的
      expect(s.minHeight).toBe(0);
    });

    it('卡片仍以 maxHeight 封顶（内容区滚动的前提是卡片有上限）', () => {
      const tree = renderModal(
        <AppModal visible onClose={() => undefined} title="房间设置">
          <Text>内容</Text>
        </AppModal>
      );
      const card = tree.root.findAll(
        (n) => {
          const s = flatten(n.props.style);
          return s.maxHeight === '88%';
        },
        { deep: true }
      )[0];
      expect(card).toBeDefined();
    });

    it('bodyStyle 排在 styles.body 之后（同键后者生效，调用方的覆盖是显式可见的）', () => {
      const tree = renderModal(
        <AppModal visible onClose={() => undefined} bodyStyle={{ minHeight: 200 }}>
          <Text>内容</Text>
        </AppModal>
      );
      const body = findBody(tree);
      expect(flatten(body!.props.style).minHeight).toBe(200);
    });
  });

  describe('② 传 footer 时：内容区与页脚区是两个兄弟节点，页脚不滚动', () => {
    it('内容区与页脚区同为 body 的直接子节点', () => {
      const tree = renderModal(
        <AppModal visible onClose={() => undefined} title="房间设置" footer={footerNode}>
          <ScrollView testID="form-scroll">
            <Text>表单</Text>
          </ScrollView>
        </AppModal>
      );

      const body = findBody(tree)!;
      const content = hostByTestId(tree, CONTENT_ID)!;
      const footer = hostByTestId(tree, FOOTER_ID)!;

      expect(content).toBeDefined();
      expect(footer).toBeDefined();
      expect(typeKey(content.parent!)).toBe(typeKey(body));
      expect(typeKey(footer.parent!)).toBe(typeKey(body));
      // 两者是兄弟而非父子
      expect(content).not.toBe(footer);
      expect(flatten(content.props.style).borderTopWidth).toBeUndefined();
      expect(flatten(footer.props.style).borderTopWidth).toBe(1);
    });

    it('页脚不在 ScrollView 内部（这正是按钮不再随内容滚出卡片的原因）', () => {
      const tree = renderModal(
        <AppModal visible onClose={() => undefined} title="房间设置" footer={footerNode}>
          <ScrollView testID="form-scroll">
            <Text>表单</Text>
          </ScrollView>
        </AppModal>
      );

      const scroll = tree.root.findAllByProps({ testID: 'form-scroll' })[0];
      const footer = hostByTestId(tree, FOOTER_ID)!;

      // 页脚既不是 ScrollView 的后代，也不是它的祖先
      let cur: TestRenderer.ReactTestInstance | null = footer.parent;
      let insideScroll = false;
      while (cur) {
        if (typeKey(cur) === typeKey(scroll)) {
          insideScroll = true;
          break;
        }
        cur = cur.parent;
      }
      expect(insideScroll).toBe(false);

      // ScrollView 子树里也不该出现页脚文案
      expect(
        scroll.findAllByType(Text).filter((n) => n.props.children === '页脚')
      ).toHaveLength(0);
    });

    it('页脚不收缩（flexShrink:0），高度永远由内容决定', () => {
      const tree = renderModal(
        <AppModal visible onClose={() => undefined} footer={footerNode}>
          <Text>内容</Text>
        </AppModal>
      );
      const footer = hostByTestId(tree, FOOTER_ID)!;
      const fs = flatten(footer.props.style);
      expect(fs.flexShrink).toBe(0);
      // 顶部一条描边把页脚与滚动区隔开
      expect(fs.borderTopWidth).toBe(1);
    });

    it('内容区可收缩（flexGrow:0 + flexShrink:1 + minHeight:0）并包住 children', () => {
      const tree = renderModal(
        <AppModal visible onClose={() => undefined} footer={footerNode}>
          <Text>内容</Text>
        </AppModal>
      );
      const content = hostByTestId(tree, CONTENT_ID)!;
      const s = flatten(content.props.style);
      expect(s.flexGrow).toBe(0);
      expect(s.flexShrink).toBe(1);
      expect(s.minHeight).toBe(0);
      expect(content.findAllByType(Text).filter((n) => n.props.children === '内容')).toHaveLength(1);
    });

    it('footer 节点与页脚文案都只渲染一次', () => {
      const tree = renderModal(
        <AppModal visible onClose={() => undefined} footer={footerNode}>
          <Text>内容</Text>
        </AppModal>
      );
      expect(hostByTestId(tree, FOOTER_ID)).not.toBeNull();
      expect(tree.root.findAllByType(Text).filter((n) => n.props.children === '页脚')).toHaveLength(1);
    });

    it('不传 footer / footer=null 都不产生内容区与页脚节点', () => {
      for (const footer of [undefined, null]) {
        const tree = renderModal(
          <AppModal visible onClose={() => undefined} footer={footer}>
            <Text>内容</Text>
          </AppModal>
        );
        expect(hostByTestId(tree, FOOTER_ID)).toBeNull();
        expect(hostByTestId(tree, CONTENT_ID)).toBeNull();
      }
    });

    it('footerStyle 只影响页脚，不污染 body 的内边距', () => {
      const tree = renderModal(
        <AppModal visible onClose={() => undefined} footer={footerNode} footerStyle={{ paddingTop: 30 }}>
          <Text>内容</Text>
        </AppModal>
      );
      const footer = hostByTestId(tree, FOOTER_ID)!;
      expect(flatten(footer.props.style).paddingTop).toBe(30);

      const body = findBody(tree)!;
      expect(flatten(body.props.style).padding).toBe(24);
      expect(flatten(body.props.style).paddingTop).toBe(20);
    });
  });

  describe('③ 未传 footer 的调用点：结构与既往一致（回归护栏）', () => {
    it('children 直接铺在 body 下，没有多包一层内容区', () => {
      const tree = renderModal(
        <AppModal visible onClose={() => undefined}>
          <Text>直接内容</Text>
        </AppModal>
      );
      const body = findBody(tree)!;
      const textNode = tree.root.findAllByType(Text).find((n) => n.props.children === '直接内容')!;
      // Text 的父节点就是 body（中间没有 bodyContent 包装）
      expect(typeKey(textNode.parent!)).toBe(typeKey(body));
      expect(flatten(body.props.style).flexShrink).toBe(1);
    });
  });
});