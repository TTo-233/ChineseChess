/**
 * 对局界面整屏背景注册表
 *
 * 与 `boardStyles.ts`（棋盘样式）同构：本文件只描述「有哪些背景、长什么样、对应哪张图」，
 * 不含任何持久化逻辑（持久化见 `backgroundStyleStore.ts`）。
 *
 * ## 为什么是「整屏背景」而不是「棋盘下方的一张条图」
 *
 * 棋盘在纵向预算里是**居中**的（见 `boardLayoutBudget.ts` 的 paddingTop = (host - content)/2），
 * 所以「棋盘下方」的可用高度 = 居中留白 + dynamicGap，实测在 22 台真机上跨度是 21px ~ 185px，
 * 相差 8 倍多。任何固定高度的条图都会在一半以上机型上放不下。整屏图则与具体剩余空间无关：
 * 铺满全屏、锚定底边，棋盘浮于其上。
 *
 * ## 尺寸约定
 *
 * 素材统一 **1080 x 2400 px（9:20）**，覆盖 1.78 ~ 2.22 的主流竖屏比例区间
 * （360x800 这类主流安卓基准分辨率正好 @3x）。渲染用 `resizeMode="cover"` 居中裁切，
 * 因此在比例不完全一致的机型上只裁掉上下极少一条，不会变形。
 */

import type { ImageSourcePropType } from 'react-native';

/**
 * 背景 id。
 *
 * `'none'` 是「不使用背景图」的默认态——底色沿用各屏自己的 `COLORS.bg`（米黄古纸色），
 * 即本功能上线前的既有观感，保证老用户升级后视觉不变，且随时可以退回来。
 */
export type BackgroundStyleId = 'none' | 'shuimo' | 'xianshan' | 'zhuge' | 'jiangshan';

export interface BackgroundStyle {
  id: BackgroundStyleId;
  /** 展示名（要求 4 字以内，与棋盘样式「经典 / 花梨木 / 玄墨」同一命名风格） */
  name: string;
  /** 一句话描述 */
  desc: string;
  /** 背景图资源；`null` 表示纯色底（仅 `'none'` 使用） */
  image: ImageSourcePropType | null;
  /**
   * 整体明度。
   *
   * `'dark'` 的背景图下，状态栏/页面标题的深色前景会看不清，需要把状态栏图标切成浅色
   * （`<Screen statusBarStyle="light">`）。`'none'` 是米黄纯色底，属于 `'light'`。
   */
  tone: 'light' | 'dark';
}

/**
 * 数组顺序就是「样式设置 → 背景」分页里的卡片展示顺序。
 *
 * 卡片是固定宽度 + 横向滚动（卡片宽 96 + 间距 10，可视区约 272~380px，
 * 一屏只能看到 2~3 张，见 StyleSettingsModal 的 bgRow 注释），
 * 所以越靠右越难触达：想优先让人看到的样式必须排在前面。
 */
export const BACKGROUND_STYLES: BackgroundStyle[] = [
  {
    id: 'none',
    name: '默认',
    desc: '纯色底',
    image: null,
    tone: 'light',
  },
  {
    id: 'jiangshan',
    name: '江山',
    desc: '青绿长卷',
    image: require('@/assets/backgrounds/bg_jiangshan.jpg'),
    tone: 'light',
  },
  {
    id: 'shuimo',
    name: '水墨',
    desc: '淡墨山水',
    image: require('@/assets/backgrounds/bg_shuimo.jpg'),
    tone: 'light',
  },
  {
    id: 'xianshan',
    name: '仙山',
    desc: '夜月琼楼',
    image: require('@/assets/backgrounds/bg_xianshan.jpg'),
    tone: 'dark',
  },
  {
    id: 'zhuge',
    name: '朱阁',
    desc: '红帐宫灯',
    image: require('@/assets/backgrounds/bg_zhuge.jpg'),
    tone: 'dark',
  },
];

const STYLE_MAP: Record<BackgroundStyleId, BackgroundStyle> = BACKGROUND_STYLES.reduce(
  (acc, s) => {
    acc[s.id] = s;
    return acc;
  },
  {} as Record<BackgroundStyleId, BackgroundStyle>
);

/** 默认背景：纯色底（与功能上线前的观感一致） */
export const DEFAULT_BACKGROUND_STYLE_ID: BackgroundStyleId = 'none';

export function getBackgroundStyle(
  id: BackgroundStyleId | null | undefined
): BackgroundStyle {
  return (id && STYLE_MAP[id]) || STYLE_MAP[DEFAULT_BACKGROUND_STYLE_ID];
}

/** 背景是否真的有图（`'none'` 为 false） */
export function hasBackgroundImage(style: BackgroundStyle): boolean {
  return style.image != null;
}
