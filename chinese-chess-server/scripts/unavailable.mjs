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
    '  ⚠️ 红字警告：dist/index.js 是**手工改动过的构建产物**，由 scripts/patch-dist.mjs',
    '     注入 6 条幂等补丁（脚本头部逐条说明 + 各自丢失时会出现的症状）：',
    '       1) 长将长捉超限不拦截落子      丢失→客户端能走的着法被服务端 400「禁着，请变招」拒绝',
    '       2) 畸形 FEN 行宽校验           丢失→WASM 越界写内存，4 个 worker 全崩、/ai/move 返回 500',
    '       3) 初始局面上传收紧            丢失→对局可被伪造的整局局面覆盖，终局状态也能被直接写入',
    '       4) 请求体驱动的终局副作用      丢失→第 3 条之外的另一处同源问题',
    '       5) 被拒动作回推权威状态        丢失→被拒绝的动作客户端无感知，乐观更新永久留在界面上',
    '       6) 房间名最小空缺优先          丢失→自动房间名只增不减，销毁后的编号不复用',
    '     重新构建 / 换版本覆盖 dist/index.js 之后，必须立刻执行：',
    '         node scripts/patch-dist.mjs',
    '     pnpm start 每次启动前会自动跑 `patch-dist.mjs --check`，任一条缺失都拒绝启动。',
    '     同一道校验还挂在：pack.ps1/pack.sh server（出包前，失败则阻塞出包）、',
    '     pnpm install 的 postinstall、pnpm verify —— 任一环节丢补丁都会非零退出。',
    '     只有第 1 条的标记可能被单独剥离，用 `node scripts/patch-dist.mjs --restore-marker` 修复。',
    '',
  ].join('\n'),
);

process.exit(1);
