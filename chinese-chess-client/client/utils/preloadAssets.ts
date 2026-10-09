/**
 * 对局资源预加载
 *
 * 在首页空闲时预热所有棋盘样式背景图、棋子图与特效图的原生图片缓存，
 * 使进入对局、切换棋盘样式、触发吃子/将军特效时首帧即渲染，
 * 消除首次解码造成的闪烁/延迟。
 *
 * 说明：均为本地打包资源，prefetch 只是提前完成解码入缓存，不产生网络流量；
 * 全部静默失败（任一资源异常不影响应用运行）。
 */

import { Image } from 'react-native';
import { BOARD_STYLES } from '@/utils/chess/boardStyles';
import { getPieceImage, getFaceDownImage } from '@/utils/chess/pieceImages';

const EFFECT_IMAGES = [
  require('@/assets/effect_chi.png'),
  require('@/assets/effect_jiangjun.png'),
];

let preloaded = false;

function prefetchAsset(source: unknown): void {
  try {
    const resolved = Image.resolveAssetSource(source as number);
    if (resolved?.uri) {
      Image.prefetch(resolved.uri).catch(() => {
        // 单张预热失败忽略
      });
    }
  } catch {
    // 解析失败忽略
  }
}

/** 预热全部对局图片资源（幂等，重复调用只执行一次） */
export function preloadChessAssets(): void {
  if (preloaded) return;
  preloaded = true;

  // 棋盘样式背景图（每套样式两个方向）
  for (const style of BOARD_STYLES) {
    prefetchAsset(style.normalImage);
    prefetchAsset(style.flippedImage);
  }

  // 棋子图（32 子去重后 14 张唯一图）
  const seen = new Set<unknown>();
  for (let id = 0; id < 32; id++) {
    const img = getPieceImage(id);
    if (img && !seen.has(img)) {
      seen.add(img);
      prefetchAsset(img);
    }
  }

  /**
   * 揭棋暗子背面图（2 张：黑/红）。
   *
   * 必须显式登记：背面图不在 `getPieceImage` 的正面表里，
   * 漏登记不会报错，只会在揭棋首帧弹出图片未缓存导致的空白/闪烁 ——
   * 这类问题只在真机上偶发，很难靠肉眼复现，所以这里直接进预热清单。
   */
  for (const img of [getFaceDownImage(0), getFaceDownImage(16)]) {
    if (img && !seen.has(img)) {
      seen.add(img);
      prefetchAsset(img);
    }
  }

  // 吃子/将军特效图
  for (const img of EFFECT_IMAGES) {
    prefetchAsset(img);
  }
}
