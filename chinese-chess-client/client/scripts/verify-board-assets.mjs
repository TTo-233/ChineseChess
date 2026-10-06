#!/usr/bin/env node
/**
 * 棋盘资源校验（无第三方依赖，可直接进 CI）。
 *
 * 只检查**结构契约**，不比对像素——像素保真由 scripts/board_assets.py 在生成时
 * 负责并把关，这里负责防止「坏资源被提交/打包」。
 *
 * 校验项：
 *  1. 每张棋盘都是 PNG（不能是 JPG——棋盘有透明边，JPG 会产生黑晕）
 *  2. PNG colour type = 3（索引色）或 6（RGBA），不接受无 alpha 的 2（RGB）
 *  3. 索引色图必须带 tRNS chunk（否则透明边变成实色）
 *  4. 尺寸与 utils/chess/boardStyles.ts 登记的 imgWidth/imgHeight 一致
 *
 * 用法：
 *   node scripts/verify-board-assets.mjs
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const CLIENT = join(HERE, '..');
const BOARDS = join(CLIENT, 'assets', 'boards');

/** 与 utils/chess/boardStyles.ts 保持一致的登记信息。 */
const EXPECTED = {
  'board_classic_blacktop.png': [633, 699],
  'board_classic_redtop.png': [633, 699],
  'board_huali_blacktop.png': [891, 981],
  'board_huali_redtop.png': [891, 981],
  'board_xuanmo_blacktop.png': [893, 985],
  'board_xuanmo_redtop.png': [893, 985],
};

/** PNG colour type -> 是否有 alpha 通道。 */
const COLOR_TYPE = { 0: false, 2: false, 3: true, 4: true, 6: true };

function readChunks(buf) {
  const chunks = new Set();
  let off = 8; // 跳过 PNG signature
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    chunks.add(type);
    off += 12 + len; // length + type + data + crc
    if (type === 'IEND') break;
  }
  return chunks;
}

function inspect(file) {
  const buf = readFileSync(file);
  if (buf.length < 33 || buf.toString('hex', 0, 8) !== '89504e470d0a1a0a') {
    throw new Error('不是合法 PNG（signature 不符）——禁止用 JPG 存棋盘，会有黑晕');
  }
  // IHDR: width(4) height(4) bitDepth(1) colorType(1) ...
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const bitDepth = buf[24];
  const colorType = buf[25];
  const chunks = readChunks(buf);
  return { width, height, bitDepth, colorType, hasTRNS: chunks.has('tRNS') };
}

let failed = 0;
const fail = (msg) => {
  console.error(`  [FAIL] ${msg}`);
  failed++;
};

console.log('校验棋盘资源（assets/boards/）');

const onDisk = readdirSync(BOARDS).filter((f) => f.startsWith('board_'));
for (const name of Object.keys(EXPECTED).sort()) {
  const file = join(BOARDS, name);
  let info;
  try {
    info = inspect(file);
  } catch (e) {
    fail(`${name}: ${e.message}`);
    continue;
  }

  const [ew, eh] = EXPECTED[name];
  if (info.width !== ew || info.height !== eh) {
    fail(`${name}: 尺寸 ${info.width}x${info.height}，boardStyles.ts 登记的是 ${ew}x${eh}`);
  }
  if (info.colorType === 2) {
    fail(`${name}: colour type 2 (RGB) 没有 alpha 通道，透明边会变黑晕`);
  }
  if (info.colorType === 3 && !info.hasTRNS) {
    fail(`${name}: 索引色图缺少 tRNS chunk，透明边会变黑晕`);
  }
  if (!(info.colorType in COLOR_TYPE)) {
    fail(`${name}: 未知 colour type ${info.colorType}`);
  }
  console.log(
    `  [OK] ${name.padEnd(28)} ${info.width}x${info.height} ` +
      `colourType=${info.colorType} bitDepth=${info.bitDepth}` +
      (info.colorType === 3 ? ' +tRNS' : '')
  );
}

const stray = onDisk.filter((f) => !(f in EXPECTED));
if (stray.length) fail(`assets/boards/ 下有未登记的文件：${stray.join(', ')}`);

if (failed) {
  console.error(`\n棋盘资源校验失败：${failed} 项不符合标准流程。`);
  console.error('请用 `python scripts/board_assets.py build --all` 重新生成。');
  process.exit(1);
}
console.log('\n✅ 棋盘资源符合标准流程（PNG + alpha + 尺寸一致）');
