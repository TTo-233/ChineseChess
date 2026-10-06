# Expo App + Express.js

## 目录结构规范（严格遵循）

当前仓库是一个 monorepo（基于 pnpm 的 workspace）

- Expo 代码在 client 目录，Express.js 代码在 server 目录
- 本模板默认无 Tab Bar，可按需改造

├── client/                     # React Native 前端代码
│   ├── app/                    # Expo Router 路由目录（仅路由配置）
│   │   ├── _layout.tsx         # 根布局文件（必需，务必阅读）
│   │   └── index.tsx           # 首页
│   ├── screens/                # 页面实现目录（与 app/ 路由对应）
│   │   └── demo/               # 示例页面
│   │       └── index.tsx
│   ├── components/             # 可复用组件
│   │   └── Screen.tsx          # 页面容器组件（必用）
│   ├── hooks/                  # 自定义 Hooks
│   ├── contexts/               # React Context 代码
│   ├── utils/                  # 工具函数
│   ├── assets/                 # 静态资源
|   └── package.json            # Expo 应用 package.json
├── server/                     # 服务端代码根目录 (Express.js)
|   ├── src/
│   │   └── index.ts            # 服务端入口文件
|   └── package.json            # 服务端 package.json
├── package.json
├── .cozeproj                   # 预置脚手架脚本（禁止修改）
└── .coze                       # 配置文件（禁止修改）

## 样式方案

基于 tailwindcss 进行样式开发（底层基于 Uniwind）

写法示例：

```tsx
<View className="flex-1 bg-white dark:bg-gray-900 p-4"></View>
```

```tsx
<Text
  className="text-lg font-bold text-gray-900 dark:text-white"
  selectionColorClassName="accent-blue-500"
>
  Hello World
</Text>
```

Uniwind 官方文档：https://docs.uniwind.dev/llms.txt

## 如何进行静态校验（TSC + ESLint）

`chinese-chess-client/` 下的 pnpm workspace 只包含 `client` 一个包。
真正的服务端是仓库根下的 `chinese-chess-server/`，它是**独立目录、独立依赖**，不属于本 workspace。

```bash
# 客户端校验（等价写法：pnpm -w lint / pnpm validate / pnpm -w lint:all）
pnpm -w lint:client
```

服务端仓库现在带**完整源码**（`chinese-chess-server/src/`，TypeScript）与构建脚本 `build.js`（esbuild 0.27.2）：
`chinese-chess-server/dist/index.js` 由 `src/` 构建生成，**不要再手工改产物**。

```bash
# 在 chinese-chess-server/ 下
node build.js           # 用 src/ 重新生成 dist/index.js
node build.js --check   # 校验已提交的 dist 与重新构建的结果是否一致（不一致 exit 1）

# 服务端自身的脚本（也在 chinese-chess-server/ 下）
pnpm build     # = node build.js
pnpm dev       # = tsx watch src/index.ts
pnpm serve     # = tsx src/index.ts
pnpm lint      # = tsc --noEmit
```

**不要**使用 `pnpm -w lint:server`——该脚本已删除，因为它指向的 `chinese-chess-client/server/` 目录并不存在。

### ⚠️ 服务端 dist 由 src/ 构建生成（改逻辑改 src/，不要改 dist/）

`chinese-chess-server/dist/index.js` 是 esbuild 产物，可读源码在 `chinese-chess-server/src/`：

```
src/index.ts
src/routes/{lanGame,ai,battleWs}.ts
src/services/{pikafish,openingBook}.ts
```

历史上前身是「没有源码、只能手工往 dist 里打补丁」的部署产物，6 条加固由 `scripts/patch-dist.mjs`
注入到产物里；**现在这 6 条加固都已归位到源码，`patch-dist.mjs` 已删除**：

1. 长将长捉超限不拦截落子、不按违规次数判负
2. 畸形 FEN 行宽校验（进入 Pikafish WASM 前拦截）
3. 初始局面上传收紧（仅房内玩家、且仅在本局尚无着法时可上传）
4. 请求体驱动的终局副作用（与第 3 条同源，成对生效）
5. 被拒绝的动作也回推权威状态（避免客户端停在乐观更新）
6. 房间名最小空缺优先（自动房名复用被释放的编号）

**改完源码必须重新构建：在 `chinese-chess-server/` 下执行 `node build.js`。**
闸门挂在以下环节，`dist` 与 `src/` 不一致时会立刻以非零退出失败（CI 调用任一即可阻塞流水线）：

| 环节 | 命令 | 行为 |
| --- | --- | --- |
| 打包服务端 | `pack.ps1 server` / `pack.sh server` | 出包前 `build.js --check`，失败则**阻塞出包**（不生成 zip） |
| 安装服务端依赖 | 服务端目录下 `pnpm install` | `postinstall` 自动 `node build.js`（重新生成 dist） |
| 客户端静态校验 | `pnpm -w validate` | 先 `lint`，再 `verify-server-parity`（= `build.js --check`） |
| 单独校验 | `pnpm -w verify:server-parity` / 服务端 `pnpm verify` | 只做 `--check` |

但 `node dist/index.js`、`start.bat` 等直启方式不做校验，需自行确认。
规则引擎本体（`ruleEngine.cjs`）由 `client/utils/chess/ruleEngine.bundle.ts` 打包而来，
`dist/index.js` 通过 `require("../ruleEngine.cjs")` 加载它——改规则请改**客户端**源码。

### 规则引擎「两端同源」校验（改规则源码后必跑）

`ruleEngine.cjs` 是 `ruleEngine.bundle.ts` 的**打包产物**，两端"同源"是约定而非机制，
很容易漂移（改了客户端源码忘记重新打包，服务端就还在跑旧规则，且没有任何报错）。

```bash
pnpm -w verify:rule-engine-parity                              # 校验；漂移则 exit 1
node chinese-chess-server/scripts/verify-rule-engine-parity.mjs --write   # 重新生成 ruleEngine.cjs
```

校验方式是**在内存里重新打包并逐字节比对**已提交的 `ruleEngine.cjs`。打包参数是实测反推的，
不能随便改：

- `bundle: true, format: 'cjs', platform: 'node', target: 'es2020'`，**不加 banner**；
- esbuild 版本必须与出包时一致——仓库 `package.json` 的 `pnpm.overrides` 已把 esbuild 钉在 **0.27.2**；
- `target` 换 `es2019`/`es2018` 会多出 `var _a, _b;` 降级变量，`es2017` 及更低会换掉整套 `__defProp` 头部，都会造成假漂移。

`--write` 覆盖 `ruleEngine.cjs` 之后，**必须重启服务端**（`dist/index.js` 是 `require` 加载它，不会热更）。

## 棋盘背景图标准处理流程（固定流程，禁止手工转格式）

棋盘图**一律**由脚本从设计源图生成，**不要**手工用图片工具另存、更不要直接存成 JPG。

```bash
# 在 chinese-chess-client/client 下
python scripts/board_assets.py build --all          # 批量：assets/boards/_source/ -> assets/boards/
python scripts/board_assets.py build --src raw.png --style huali --blacktop   # 单张
node   scripts/verify-board-assets.mjs               # 校验资源结构（已接入 pnpm -w validate）
```

| 环节 | 约定 |
| --- | --- |
| 设计源图 | 放 `client/assets/boards/_source/`，命名 `<style>_<blacktop\|redtop>.png`（24 位 RGBA，**带透明边**） |
| 产物 | `client/assets/boards/board_<style>_<blacktop\|redtop>.png`，**索引色 PNG（colour type 3）+ tRNS** |
| 尺寸 | 必须与 `utils/chess/boardStyles.ts` 登记的 `imgWidth/imgHeight` 一致，换尺寸要同步改那里 |
| 引用 | `boardStyles.ts` 的 `require()` 路径；新增/改名资源要同步改这里 |
| 入包 | `_source/` 由 `pack.ps1`/`pack.sh` 排除，不随部署包分发 |

### 为什么必须走这个流程（都是实际踩过的坑）

- **绝不能存 JPG**：棋盘四周有一圈透明边（棋盘要浮在 App 背景上，`classic` 棋盘本身就是
  带透明的 RGBA PNG）。JPG 没有 alpha 通道，透明边会被压成实色，线上就会出现**一圈黑边**。
  本项目已经因此翻车过一次：把 RGBA 源图 `convert("RGB")` 存成 JPG，`convert` 会把全透明像素
  压成**纯黑**，棋盘四周立刻出现黑晕。
- **为什么是索引色 PNG**：24 位无损 PNG 实测 5.8MB，索引色 815KB（**-86%**），肉眼无差别。
- **为什么必须 FASTOCTREE**：这是防黑晕的核心。量化时若只在**不透明像素**上聚类再对每簇
  alpha 取平均，全透明像素会被并进 `alpha≈215` 的簇，透明边以 84% 不透明度渲染——**又变回黑晕**；
  直接对 RGB 做 Floyd–Steinberg 抖动同样会把透明像素分到 `alpha≈255` 的簇。
  `FASTOCTREE` 在 **R,G,B,A 四维**聚类，alpha 参与距离计算，全透明像素**结构上不可能**
  与可见像素共用调色板项。
- **为什么不抖动**：试过 numpy 版 Floyd–Steinberg，渐变断层虽消失，但木纹上出现明显斑驳噪点，
  花梨木 PSNR 从 34dB 掉到 17dB。按实际显示尺寸看不出断层（放大裁切图上的「banding」是
  最近邻放大的假象），故默认不抖动。

`board_assets.py` 生成时会回读校验，`alpha==0` 像素误差超阈值直接**中止且不落盘**；
`verify-board-assets.mjs` 再检查 PNG colour type / tRNS / 尺寸，已挂进 `pnpm -w validate`，
把棋盘图存成 JPG 或丢了 alpha 都会让校验失败、阻塞出包。

## 打包规范（仓库根目录 pack.ps1 / pack.sh）

```bash
pwsh -File pack.ps1 [client|server|all]   # Windows（等价于 .\pack.ps1）
./pack.sh      [client|server|all]         # POSIX
```

- **每次打包会自动删除「该端」的历史 zip**：只删同前缀的（`chinese-chess-client_*.zip` 或
  `chinese-chess-server_*.zip`），**client 与 server 互不影响**。仓库根目录因此始终只保留
  每个端当天的这一个包。这条是硬性要求：旧包如果留在根目录，极易被误当成最新包分发出去
  （本项目就发生过一次：源码改了一整天，根目录的 zip 还停在前一天，所有修复都不在里面）。
  打完包请确认根目录 `chinese-chess-*.zip` 各只剩一个。
- 服务端出包前强制 `node build.js --check`（校验 `dist` 与 `src/` 是否一致），校验失败**阻塞出包**（不生成 zip）。
- `pack.ps1` 必须存为 **UTF-8 with BOM**：本机是 Windows PowerShell 5.1，无 BOM 时它按 GB2312
  （codepage 936）解码，中文提示会变成乱码。用现代 pwsh (7+) 则无此问题。

## 如何修改主题模式（跟随系统、固定暗色、固定亮色）

默认为跟随系统，如果用户明确指定为“暗色”或“亮色”，需要修改 `client/components/ColorSchemeUpdater.tsx` 的 `DEFAULT_THEME` 变量为合适的值

## 如何定制主题 design tokens

当前项目的**设计系统**基于 tailwindcss 实现，核心入口文件为 `client/global.css`，如果需要定制主题，应该**阅读并修改 `client/global.css` 文件**

## 字体大小规范

**字号字阶的唯一来源是 `client/utils/typography.ts` 导出的 `FONT` 常量**，颜色/圆角/边框等 token 才在 `client/global.css` 中定义。

写任何文字样式时，`fontSize` 必须取自 `FONT.xxx`：

| 角色 | 用途 |
| --- | --- |
| `FONT.micro` (10) | 角标、徽标、极小状态标签（数字角标、准备状态小标签、棋盘按比例缩放的角标除外） |
| `FONT.caption` (12) | 说明文字、副标题、状态芯片、表单提示与错误提示 |
| `FONT.body` (14) | 正文、列表主文本、按钮文字、表单标签、卡片标题 |
| `FONT.control` (16) | 输入框文字与只读值、分区标题、主按钮 |
| `FONT.title` (18) | 页面主标题、弹窗标题 |
| `FONT.display` (20) | 结果标题、强调数字 |
| `FONT.displayLg` (24) | 结算主结果 |
| `FONT.hero` (36) | 首页品牌标题 |
| `FONT.countdown` (80) / `FONT.countdownCard` (48) | 全屏揭示 / 卡片内倒计时数字（数字展示特例，不参与正文字阶） |

禁止在 `StyleSheet` 中直接写 `fontSize: 14` 这类裸数字。新增或修改文字样式时先在 `FONT` 中确认是否有合适的角色，没有再新增并同步更新本表。

两种例外：按棋盘尺寸等比缩放的动态字号（棋子/让子/被吃数量角标）由棋盘组件自行计算；表情等图形符号的字号按图形尺寸定。两者都需在样式旁注明原因。

## 路由及 Tab Bar 实现规范

### 方案一：无 Tab Bar（Stack 导航）

适用于线性流程应用，采用简化的目录结构：

```
client/app/
├── _layout.tsx         # 根布局（Stack 导航配置）
├── index.tsx           # 应用入口
├── detail.tsx          # 详情页（通过 params 传递数据）
└── +not-found.tsx      # 404 页面
```

**根布局配置** `client/app/_layout.tsx`：

以下仅为代码片段供写法参考

```tsx
<Stack screenOptions={{ headerShown: false }}>
  <Stack.Screen name="index" />
  <Stack.Screen name="detail" />
</Stack>
```

**应用入口** `client/app/index.tsx`：
```tsx
export { default } from "@/screens/home";
```
> **禁止事项**：无 Tab Bar 场景下，不得创建 `(tabs)` 目录。

### 方案二：有 Tab Bar（Tabs 导航）

采用路由分组实现底部导航栏：
```
client/app/
├── _layout.tsx              # 根布局
├── (tabs)/
│   ├── _layout.tsx          # Tab 导航配置
│   ├── index.tsx            # 默认 Tab（必须存在）
│   ├── discover.tsx         # 发现页
│   └── profile.tsx          # 个人中心
├── detail.tsx               # Tab 外的独立页面（通过 params 传递数据）
└── +not-found.tsx
```
> **⚠️ [CRITICAL]**： `app/index.tsx` 优先级高于 `(tabs)/index.tsx`，会导致首页无 Tab Bar。**当有(tabs)/index.tsx时必须删除 `app/index.tsx`**。

**根布局配置** `client/app/_layout.tsx`：

以下仅为代码片段供写法参考

```tsx
<Stack screenOptions={{ headerShown: false }}>
  <Stack.Screen name="(tabs)" />
  <Stack.Screen name="detail" />
</Stack>
```

**应用入口** `client/app/(tabs)/index.tsx`：
```tsx
export { default } from "@/screens/home";
```

**Tab 布局配置** `client/app/(tabs)/_layout.tsx`：

```tsx
import { Tabs } from 'expo-router';
import { Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FontAwesome6 } from '@expo/vector-icons';
import { useCSSVariable } from 'uniwind';

export default function TabLayout() {
  const insets = useSafeAreaInsets();
  const [background, muted, accent, border] = useCSSVariable([
    '--color-background',
    '--color-muted',
    '--color-accent',
    '--color-border',
  ]) as string[];

  let tabBarStyle = {
    backgroundColor: background,
    borderTopWidth: 1,
    borderTopColor: border,
  };

  // 用于修复 Web 上高度异常的问题（这个 if 逻辑必须添加）
  if (Platform.OS === 'web') {
    tabBarStyle = {
      ...tabBarStyle,
      height: 'auto',
    }
  }

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle,
        tabBarActiveTintColor: accent,
        tabBarInactiveTintColor: muted,
      }}
    >
      {/* name 必须与文件名完全一致 */}
      <Tabs.Screen
        name="index"
        options={{
          title: '首页',
          tabBarIcon: ({ color }) => (
            <FontAwesome6 name="house" size={20} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="discover"
        options={{
          title: '发现',
          tabBarIcon: ({ color }) => (
            <FontAwesome6 name="compass" size={20} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: '我的',
          tabBarIcon: ({ color }) => (
            <FontAwesome6 name="user" size={20} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}
```

**Tab 页面文件** `client/app/(tabs)/index.tsx`：
```tsx
export { default } from "@/screens/home";
```

### 注意事项

在改动 `client/app/_layout.tsx` 前，必须先阅读该文件，再进行修改操作

以下是需要保留的重要逻辑

- 保留 global.css 引入（tailwindcss 生效的关键）
- 保留 Provider 的使用

## 依赖管理与模块导入规范

### 依赖安装
**禁止**使用 `npm` 或 `yarn`，按目录区分安装命令：

| 目录 | 安装命令 | 说明 |
|------|----------|------|
| `client/` | `npx expo install <package>` | Expo 会自动选择与 SDK 兼容的版本 |
| `server/` | `pnpm add <package>` | 使用 pnpm 管理后端依赖 |

```bash
# client 目录（Expo 项目）
cd client && npx expo install expo-camera expo-image-picker

# server 目录（Express 项目）
cd server && pnpm add axios cors
```

**网络问题处理**：`npx expo install` 可能因网络原因失败，失败时重试 2 次，仍失败则改用 `pnpm add` 安装

## Expo 开发规范

### 路径别名

Expo 配置了 `@/` 路径别名指向 `client/` 目录：

```tsx
// 正确
import { Screen } from '@/components/Screen';

// 避免相对路径
import { Screen } from '../../../components/Screen';
```

## 本地开发

在 `chinese-chess-client/` 下执行：

```bash
pnpm -w dev:all       # 同时起服务端 + 客户端（推荐）
pnpm -w dev:server    # 只起服务端（仓库根的 chinese-chess-server/，默认 9091）
pnpm -w dev:client    # 只起 Expo web 客户端（5000），/api/v1 代理到 SERVER_PORT
```

`dev:all` 由 `scripts/dev-all.mjs` 实现：它给客户端注入 `SERVER_PORT`，
让 `client/metro.config.js:104-105` 把 `/api/v1/*` 代理到对应端口的后端。
用 `PORT=8080 pnpm -w dev:all` 可同时改两端端口。

> ⚠️ 根脚本 `dev` / `build` / `start` 仍指向 `.cozeproj/scripts/*.sh`，
> 而这些脚本以 `$ROOT_DIR/server`（即 `chinese-chess-client/server/`）为工作目录——
> 该目录并不存在，服务端实际在仓库根的 `../chinese-chess-server/`。
> `.cozeproj/` 标记为禁止修改，所以这三个脚本在当前仓库结构下不可用，请改用上面的 `dev:*`。
