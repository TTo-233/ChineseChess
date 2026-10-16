#!/usr/bin/env node
/**
 * 校验 assets/ 下不存在「AAPT 资源名冲突」
 *
 * ============================================================================
 * 【为什么必须有这个校验（真实构建失败换来的）】
 *
 * Android 构建时，Metro 会把 client/assets 下的文件打进
 * `android/app/build/generated/res/createBundleReleaseJsAndAssets/raw/`，
 * 随后 :app:mergeReleaseResources 交给 AAPT2 处理。
 *
 * AAPT 生成 raw 资源名的规则是：**去掉最后一个扩展名后的完整相对路径**，
 * 并把非法字符换成下划线。于是——
 *
 *     assets/engines/jieqi.wasm  → raw/assets_engines_jieqi
 *     assets/engines/jieqi.page  → raw/assets_engines_jieqi      ← 同名！
 *
 * 立刻触发：
 *     ERROR: [raw/assets_engines_jieqi] ...: Resource and asset merger:
 *            Duplicate resources
 *     Execution failed for task ':app:mergeReleaseResources'
 *
 * ⚠️ 这个失败**非常晚**才出现（用户实测在 Run gradlew 阶段跑了近 6 分钟才炸），
 * 而且**任何 JS/TS 校验都发现不了**——产物字节完全正常，两个 verify-*-engine-assets
 * 也是绿的。所以必须在出包前用本脚本拦。
 *
 * ============================================================================
 * 【规则】
 *
 * 对 assets/ 下每个**文件**（跳过 _source/ 与 _icon.ios 等平台特例目录）：
 *   resourceName = 相对路径去掉最后一个扩展名，分隔符与非法字符统一替换为 '_'
 * 任何两个不同文件算出同一个 resourceName 即为冲突，直接 exit 1。
 *
 * 已知的历史坑（已修复，改名时勿回退）：
 *   pikafish.html / pikafish.wasm / pikafish.nnue  → 三者曾全叫 raw/assets_engines_pikafish
 *   jieqi.html   / jieqi.wasm                       → 二者曾全叫 raw/assets_engines_jieqi
 * 现统一改用 .page / .wasm / .nnue / .bin 四种互不相同的扩展名。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientRoot = path.resolve(here, '..');
const ASSETS_DIR = path.join(clientRoot, 'assets');

function collectFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      collectFiles(path.join(dir, entry.name), out);
    } else if (entry.isFile()) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

/**
 * AAPT 的 raw 资源名算法。
 *
 * 规则（依据实测报错里的真实资源名反推）：
 *   assets/engines/jieqi.wasm → raw/assets_engines_jieqi
 *   assets/engines/jieqi.html → raw/assets_engines_jieqi   ← 两者完全相同
 * 即：**相对 assets/ 的路径 → 去掉最后一个扩展名 → 路径分隔符与非法字符换成 '_'**。
 *
 * ⚠️ 关键含义：被剥离的是「最后一个点之后的任意后缀」，**与后缀本身是什么无关**。
 *    所以 `jieqi.page` 与 `jieqi.wasm` 依然同名——改扩展名**解决不了**这个问题，
 *    必须让「扩展名之前的那一段（stem）」彼此不同。
 *    这也是本脚本存在的意义：靠人肉记住这条规则必然复发。
 */
function aaptResourceName(relPathFromAssets) {
  const normalized = relPathFromAssets.split(path.sep).join('/');
  const lastSlash = normalized.lastIndexOf('/');
  const dirPart = lastSlash === -1 ? '' : normalized.slice(0, lastSlash);
  const fileName = normalized.slice(lastSlash + 1);
  const dot = fileName.lastIndexOf('.');
  // 没有扩展名或以点开头（".gitignore" 之类）时，AAPT 保留整名
  const baseName = dot > 0 ? fileName.slice(0, dot) : fileName;
  return `${dirPart}/${baseName}`.replace(/[^a-zA-Z0-9_/]/g, '_').split('/').join('_');
}

/** 仅用于人看的资源名（报错里更贴近实际，直接沿用 raw/ 前缀） */
function displayName(resourceName) {
  return `raw/${resourceName}`;
}

if (!fs.existsSync(ASSETS_DIR)) {
  console.error(`verify-asset-resource-names: 找不到 ${ASSETS_DIR}`);
  process.exit(1);
}

const files = collectFiles(ASSETS_DIR).filter(Boolean);
const byResourceName = new Map();
for (const abs of files) {
  const rel = path.relative(ASSETS_DIR, abs);
  const name = aaptResourceName(rel);
  const list = byResourceName.get(name) ?? [];
  list.push(rel.split(path.sep).join('/'));
  byResourceName.set(name, list);
}

const conflicts = [];
for (const [name, list] of byResourceName) {
  if (list.length > 1) conflicts.push({ name, list: list.sort() });
}

console.log('[verify-asset-resource-names] 校验 assets/ 的 AAPT 资源名唯一性');
console.log(`  扫描 ${files.length} 个资源文件，${byResourceName.size} 个不同 raw 资源名`);

if (conflicts.length > 0) {
  console.error('verify-asset-resource-names: 发现资源名冲突（Android 构建会失败）：');
  for (const c of conflicts) {
    console.error(`\n  ✗ ${displayName(c.name)}  被 ${c.list.length} 个文件同时占用：`);
    for (const f of c.list) console.error(`      - assets/${f}`);
  }
  console.error(
    '\n原因：AAPT 以「去掉最后一个扩展名后的路径」作为 raw 资源名，\n' +
      '      因此**扩展名不同、但去掉扩展名后同路径**的文件会互相覆盖\n' +
      '      （Duplicate resources），构建在 :app:mergeReleaseResources 失败。\n' +
      '\n修复：让文件名在**扩展名之前**就彼此不同（改 stem，不是改扩展名）。\n' +
      '      例如 jieqi.page + jieqi.wasm → jieqi_offline.page + jieqi.wasm。'
  );
  process.exit(1);
}

console.log('verify-asset-resource-names: 资源名无冲突 ✓');
process.exit(0);