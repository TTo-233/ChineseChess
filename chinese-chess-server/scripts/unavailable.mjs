/**
 * 显式失败提示：说明这个部署包里哪些脚本不可用、为什么、以及该去哪里做。
 *
 * 背景：`chinese-chess-server/` 是**自包含部署包**，只包含 `dist/index.js` 构建产物，
 * 没有 `src/`、没有 `tsconfig.json`、没有 `build.js`。因此源码版模板里的
 * `build`（node build.js）、`dev`（tsx watch src/index.ts）、`serve`（tsx src/index.ts）、
 * `lint`（tsc --noEmit）全部指向不存在的文件，跑了只会报一个难以定位的 ENOENT / tsc 帮助文本。
 * 与其留着一个静默失败的入口，不如显式说明。
 *
 * 用 Node 而不是 shell 内联命令，是为了让 Windows(cmd) 和 POSIX 两种 shell 下行为一致。
 */

import process from 'node:process';

const name = process.env.npm_lifecycle_event || process.argv[2] || '未知脚本';

console.error(
  [
    '',
    `[chinese-chess-server] \`pnpm ${name}\` 在当前目录不可用。`,
    '',
    '  原因：chinese-chess-server/ 是自包含部署包，只包含 dist/index.js 构建产物，',
    '        没有 src/、tsconfig.json、build.js，所以不存在可执行的 build / dev / serve / lint。',
    '',
    '  可用的命令：',
    '    pnpm start    启动已构建的服务端（跨平台，默认端口 9091，端口由 PORT 环境变量覆盖）',
    '',
    '  需要改服务端逻辑时：请在具备 src/ 的源码环境中修改并校验后，重新构建部署包覆盖 dist/index.js。',
    '  需要改规则引擎时：重新打包 chinese-chess-client/client/utils/chess/ruleEngine.bundle.ts',
    '                  为 ruleEngine.cjs（服务端 dist/index.js 通过 require("../ruleEngine.cjs") 加载它）。',
    '',
    '  ⚠️ 红字警告：dist/index.js 是**手工改动过的构建产物**。「长将长捉超限不拦截落子」',
    '     这条规则的实现就写在里面，patch 脚本在 scripts/patch-dist.mjs。',
    '     重新构建 / 换版本覆盖 dist/index.js 之后，必须立刻执行：',
    '         node scripts/patch-dist.mjs',
    '     否则已删除的「禁着拦截 + 连续 3 次判负」会复活，表现为',
    '     「客户端能走的着法被服务端以 400 禁着，请变招 拒绝」。',
    '     pnpm start 每次启动前会自动跑 `patch-dist.mjs --check`，补丁丢失则拒绝启动。',
    '     同一道校验还挂在：pack.ps1/pack.sh server（出包前，失败则阻塞出包）、',
    '     pnpm install 的 postinstall、pnpm verify —— 任一环节丢补丁都会非零退出。',
    '',
  ].join('\n'),
);

process.exit(1);
