/**
 * 对局界面整屏背景注册表（backgroundStyles.ts）契约
 *
 * 钉住四件事：
 *   ① 命名合规：展示名 ≤ 4 字（用户 m02998 明确要求"重命名（4字以内）"）；
 *   ② 有图/无图与 tone 自洽：`'none'` 必须无图，其余必须有图；
 *   ③ 素材尺寸就是设计约定：四张图都必须是 **1080x2400**。
 *      这是整屏 `cover` 方案的成立前提 —— 比例偏离越多，在真机上被裁掉的画面越多；
 *      有人换图时尺寸不对会被这里拦住（而不是等到实机才发现构图被切掉一半）；
 *   ④ 查找/回落：未知 id 与空值一律回落到默认背景。
 *
 * 关于 ③：jest-expo 会把所有 `require('*.jpg')` 压成同一个 stub，
 * 所以资源身份无法在 mock 层校验，只能**直接读磁盘上的真实文件**解析 JPEG 头。
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  BACKGROUND_STYLES,
  DEFAULT_BACKGROUND_STYLE_ID,
  getBackgroundStyle,
  hasBackgroundImage,
  type BackgroundStyleId,
} from '@/utils/chess/backgroundStyles';

/** 与素材同目录的 1080x2400 约定 */
const EXPECTED_W = 1080;
const EXPECTED_H = 2400;

/** id -> 素材文件名（注册表里 require 的必须是这几张，改了这里会红） */
const FILES: Record<Exclude<BackgroundStyleId, 'none'>, string> = {
  shuimo: 'bg_shuimo.jpg',
  xianshan: 'bg_xianshan.jpg',
  zhuge: 'bg_zhuge.jpg',
  jiangshan: 'bg_jiangshan.jpg',
};

const ASSET_DIR = path.resolve(__dirname, '../../../assets/backgrounds');

/** 解析 JPEG 的宽高（扫到第一个 SOF 段） */
function readJpegSize(buf: Buffer): { width: number; height: number } {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('不是 JPEG（缺 SOI）');
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = buf[i + 1];
    // 无载荷的标记
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      i += 2;
      continue;
    }
    const len = buf.readUInt16BE(i + 2);
    const isSOF =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSOF) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  throw new Error('未找到 SOF 段');
}

describe('backgroundStyles 注册表', () => {
  it('id 唯一，且按 none → jiangshan → shuimo → xianshan → zhuge 排列', () => {
    const ids = BACKGROUND_STYLES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(['none', 'jiangshan', 'shuimo', 'xianshan', 'zhuge']);
  });

  it('展示名不超过 4 个字，且互不相同', () => {
    const names = BACKGROUND_STYLES.map((s) => s.name);
    for (const name of names) {
      expect(Array.from(name).length).toBeLessThanOrEqual(4);
      expect(name.length).toBeGreaterThan(0);
    }
    expect(new Set(names).size).toBe(names.length);
  });

  it("只有 'none' 没有背景图，其余每一项都必须有图", () => {
    for (const s of BACKGROUND_STYLES) {
      expect(hasBackgroundImage(s)).toBe(s.id !== 'none');
      expect(s.image == null).toBe(s.id === 'none');
    }
  });

  it('tone 取值合法，且深色图（仙山/朱阁）被正确标为 dark', () => {
    for (const s of BACKGROUND_STYLES) {
      expect(['light', 'dark']).toContain(s.tone);
    }
    expect(getBackgroundStyle('xianshan').tone).toBe('dark');
    expect(getBackgroundStyle('zhuge').tone).toBe('dark');
    expect(getBackgroundStyle('none').tone).toBe('light');
  });

  it('默认背景是纯色底（none），保证老用户升级后观感不变', () => {
    expect(DEFAULT_BACKGROUND_STYLE_ID).toBe('none');
    expect(getBackgroundStyle(DEFAULT_BACKGROUND_STYLE_ID).image).toBeNull();
  });

  it('未知 id / null / undefined 一律回落到默认背景', () => {
    expect(getBackgroundStyle('不存在的id' as BackgroundStyleId).id).toBe('none');
    expect(getBackgroundStyle(null).id).toBe('none');
    expect(getBackgroundStyle(undefined).id).toBe('none');
  });

  it('每张素材都真实存在，且正好是 1080x2400', () => {
    for (const [id, file] of Object.entries(FILES)) {
      const full = path.join(ASSET_DIR, file);
      expect(fs.existsSync(full)).toBe(true);
      const size = readJpegSize(fs.readFileSync(full));
      expect({ id, ...size }).toEqual({ id, width: EXPECTED_W, height: EXPECTED_H });
    }
  });

  it('desc 非空（弹窗卡片第二行会渲染它）', () => {
    for (const s of BACKGROUND_STYLES) {
      expect(typeof s.desc).toBe('string');
      expect(s.desc.length).toBeGreaterThan(0);
    }
  });
});
