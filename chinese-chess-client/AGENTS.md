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

服务端仓库是**已构建的部署产物**（只有 `dist/index.js`、`ruleEngine.cjs`、`ai/`，没有 `src/`、没有 `tsconfig.json`），
所以不存在可执行的服务端 lint；执行 `pnpm build` / `pnpm dev` / `pnpm serve` / `pnpm lint` 会打印一段说明
（`scripts/unavailable.mjs`），告诉你为什么不可用以及该去哪里做。服务端改动请直接重新构建部署包，
或在有 `src/` 的源码环境中校验。

**不要**使用 `pnpm -w lint:server`——该脚本已删除，因为它指向的 `chinese-chess-client/server/` 目录并不存在。

### ⚠️ 服务端 dist 是手工改动过的构建产物（改它必须重跑补丁脚本）

`chinese-chess-server/dist/index.js` 里**手工删除过一段运行时逻辑**：
服务端对「长将长捉禁着」的二次拦截与「连续 3 次违规判负」。
该改动无法回到源码（本部署包没有 `src/`、没有 sourcemap），所以被固化成幂等补丁脚本
`chinese-chess-server/scripts/patch-dist.mjs`：

```bash
node chinese-chess-server/scripts/patch-dist.mjs            # 打补丁（已打则 no-op）
node chinese-chess-server/scripts/patch-dist.mjs --check    # 只校验，缺失则 exit 1
node chinese-chess-server/scripts/patch-dist.mjs --restore-marker  # 仅补回丢失的标记（逻辑本就正确时）
```

**每次重新构建 / 换版本 / 覆盖 `dist/index.js` 之后，立刻重跑第一个命令。**
否则已删除的拦截会复活，症状是「客户端能走的着法被服务端以 400『禁着，请变招』拒绝」。

闸门挂在以下环节，任一环节丢补丁都会立刻以非零退出失败（CI 调用任一即可阻塞流水线）：

| 环节 | 命令 | 行为 |
| --- | --- | --- |
| 启动服务端 | `pnpm start`（`scripts/start.mjs`） | 启动前自动 `--check`，丢失则**拒绝启动** |
| 打包服务端 | `pack.ps1 server` / `pack.sh server` | 出包前校验，失败则**阻塞出包**（不生成 zip） |
| 安装服务端依赖 | 服务端目录下 `pnpm install` | `postinstall` 自动 `--check`，失败即安装失败 |
| 客户端静态校验 | `pnpm -w validate` | 先 `lint`，再 `--check` 服务端补丁 |
| 单独校验 | `pnpm -w verify:rules` / 服务端 `pnpm verify` | 只做 `--check` |

但 `node dist/index.js`、`start.bat` 等直启方式不做校验，需自行确认。
规则引擎本体（`ruleEngine.cjs`）由 `client/utils/chess/ruleEngine.bundle.ts` 打包而来，
`dist/index.js` 通过 `require("../ruleEngine.cjs")` 加载它——改规则请改**客户端**源码。

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
