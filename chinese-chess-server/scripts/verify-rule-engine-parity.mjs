/**
 * 校验「两端规则引擎同源」——客户端源文件重新打包后必须与服务端部署产物**逐字节一致**。
 *
 * 背景（为什么需要这道闸门）：
 *   chinese-chess-server/ruleEngine.cjs 不是独立源码，而是把
 *   chinese-chess-client/client/utils/chess/ruleEngine.bundle.ts 用 esbuild 打包出来的产物
 *   （服务端 dist/index.js 通过 require("../ruleEngine.cjs") 加载它）。
 *   两端就此"同源"，但也意味着：
 *     - 改了客户端规则源码却忘记重新打包 → 服务端还在用旧规则（悄悄漂移）；
 *     - 重新打包时 esbuild 版本/参数变了 → 产物出现无意义差异，回归时没人看得出。
 *   这道校验把「同源」变成可自动判定的断言，挂进 pnpm validate / CI。
 *
 * 打包命令是**实测反推**出来的（在已提交的 ruleEngine.cjs 上比对到逐字节相等）：
 *   esbuild.buildSync({ entryPoints: [ruleEngine.bundle.ts], bundle: true,
 *                       format: 'cjs', platform: 'node', target: 'es2020', write: false })
 *   关键点：
 *     - target 必须是 es2020。es2018/es2019 会多生成 `var _a, _b;` 这类降级辅助变量，
 *       es2015-es2017 会换整套 __defProp/__defProps 头部 —— 都产生差异；
 *     - esbuild 版本必须与出包时一致（仓库根 pnpm.overrides 已把 esbuild 钉在 0.27.2）；
 *     - 不能加 banner（加了会在 "use strict" 之前多一行注释）。
 *
 * 用法：
 *   node scripts/verify-rule-engine-parity.mjs          # 校验，不一致则非零退出
 *   node scripts/verify-rule-engine-parity.mjs --write  # 用当前客户端源码重新生成 ruleEngine.cjs
 *
 * ⚠️ --write 会覆盖服务端规则引擎。写入后服务端**必须重启**（dist/index.js 通过
 *    require 加载它），并重新跑 pnpm -w validate。
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..');
const repoRoot = path.resolve(serverRoot, '..');
const clientRoot = path.join(repoRoot, 'chinese-chess-client');

const ENTRY = path.join(clientRoot, 'client', 'utils', 'chess', 'ruleEngine.bundle.ts');
const OUTPUT = path.join(serverRoot, 'ruleEngine.cjs');
const TARGET = 'es2020';

const write = process.argv.includes('--write');

/** 换行归一化：仓库同时存在 LF/CRLF 检出，比较时必须忽略行尾差异（打包器恒输出 LF）。 */
const normalize = (s) => s.replace(/\r\n/g, '\n');

/**
 * 归一化 esbuild 自动插入的入口注释。
 *
 * esbuild 在入口模块的 __commonJS 包裹前会写一行 `// <入口路径>`，而那个路径是
 * **相对于 esbuild 的工作目录**的：
 *   · 从仓库根打包 → `// chinese-chess-client/client/utils/chess/ruleEngine.bundle.ts`
 *   · 从 chinese-chess-client 打包 → `// client/utils/chess/ruleEngine.bundle.ts`
 * 出包时留在产物里的是前者。既然它只是注释、与规则语义无关，这里统一把该行
 * 改写成固定形式再比对——否则同一个源文件会因为"从哪个目录跑校验"而报假漂移。
 * 同时显式传 absWorkingDir: repoRoot，让默认行为下也稳定拿到长路径形式。
 */
const normalizeEntryComment = (s, entry) =>
  s.replace(
    /^\/\/ .*?(chinese-chess-client\/client\/utils\/chess\/ruleEngine\.bundle\.ts|ruleEngine\.bundle\.ts)$/m,
    `// ${entry}`
  );

function loadEsbuild() {
  // esbuild 只被 workspace 成员 expo-app（client/package.json）声明，根 package.json 没有依赖，
  // 因此必须从 client/ 解析。pnpm 严格软链下它也只暴露给声明它的那个包，
  // 兜底再直接找 .pnpm 隔离目录里的实体（与出包时实际用到的那个版本一致）。
  const origins = [
    path.join(clientRoot, 'client', 'package.json'),
    path.join(repoRoot, 'package.json'),
  ];
  const errors = [];
  for (const origin of origins) {
    try {
      return createRequire(origin)('esbuild');
    } catch (err) {
      errors.push(`${origin}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
    }
  }
  // 兜底：直接定位 pnpm 隔离目录里的 esbuild（仓库根 overrides 已把它钉在 0.27.2）
  const isolated = path.join(clientRoot, 'node_modules', '.pnpm');
  if (fs.existsSync(isolated)) {
    const dir = fs
      .readdirSync(isolated)
      .filter((d) => d === 'esbuild' || d.startsWith('esbuild@'))
      .sort()
      .pop();
    if (dir) {
      const pkg = path.join(isolated, dir, 'node_modules', 'esbuild');
      if (fs.existsSync(pkg)) {
        try {
          return createRequire(path.join(pkg, 'package.json'))('esbuild');
        } catch (err) {
          errors.push(`${pkg}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
        }
      }
    }
  }
  console.error(
    [
      '',
      'verify-rule-engine-parity: 无法加载 esbuild。',
      ...errors.map((e) => `  ${e}`),
      '',
      '  请先在仓库根执行 pnpm install（client 依赖需就位）。',
      '',
    ].join('\n')
  );
  process.exit(1);
}

if (!fs.existsSync(ENTRY)) {
  console.error(`verify-rule-engine-parity: 找不到规则引擎入口 ${ENTRY}`);
  process.exit(1);
}
if (!fs.existsSync(OUTPUT)) {
  console.error(`verify-rule-engine-parity: 找不到服务端产物 ${OUTPUT}`);
  process.exit(1);
}

const esbuild = loadEsbuild();

let built;
try {
  const result = esbuild.buildSync({
    entryPoints: [ENTRY],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: TARGET,
    write: false,
    logLevel: 'silent',
    // 固定工作目录，使入口注释路径稳定（详见 normalizeEntryComment）
    absWorkingDir: repoRoot,
  });
  built = normalizeEntryComment(normalize(result.outputFiles[0].text), ENTRY);
} catch (err) {
  console.error(
    `verify-rule-engine-parity: 打包失败（${ENTRY}）\n  ${
      err instanceof Error ? err.message : String(err)
    }`
  );
  process.exit(1);
}

const shipped = normalizeEntryComment(normalize(fs.readFileSync(OUTPUT, 'utf8')), ENTRY);

if (built === shipped) {
  console.log(
    `verify-rule-engine-parity: 两端规则引擎同源一致（${built.length} 字节，target=${TARGET}）`
  );
  process.exit(0);
}

if (write) {
  fs.writeFileSync(OUTPUT, built, 'utf8');
  console.log(
    [
      '',
      `verify-rule-engine-parity: 已用客户端源码重新生成 ${path.relative(repoRoot, OUTPUT)}`,
      `  ${shipped.length} 字节 → ${built.length} 字节`,
      '  ⚠️ 服务端必须重启才会加载新规则引擎，并请重新执行 pnpm -w validate。',
      '',
    ].join('\n')
  );
  process.exit(0);
}

// 差异定位：给出首个不同字节的上下文，便于判断"忘了重新打包"还是"参数/版本漂移"
let i = 0;
const max = Math.min(built.length, shipped.length);
while (i < max && built[i] === shipped[i]) i += 1;
const around = (s) => JSON.stringify(s.slice(Math.max(0, i - 60), i + 60));

console.error(
  [
    '',
    'verify-rule-engine-parity: ❌ 两端规则引擎已漂移！',
    '',
    `  客户端源码：${path.relative(repoRoot, ENTRY)}`,
    `  服务端产物：${path.relative(repoRoot, OUTPUT)}`,
    `  重新打包长度 ${built.length} 字节 / 已提交 ${shipped.length} 字节，首个差异在第 ${i} 字节`,
    `    重新打包：${around(built)}`,
    `    已提交  ：${around(shipped)}`,
    '',
    '  处理方式：',
    '    - 若刚改了客户端规则源码：node scripts/verify-rule-engine-parity.mjs --write',
    '      然后**重启服务端**（dist/index.js 通过 require 加载 ruleEngine.cjs）。',
    '    - 若没改源码也报漂移：多为 esbuild 版本/参数不一致——',
    '      仓库根 pnpm.overrides 应把 esbuild 钉在 0.27.2，打包 target 必须是 es2020。',
    '',
  ].join('\n')
);
process.exit(1);
