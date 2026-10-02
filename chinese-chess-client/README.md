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

仓库由两部分组成，它们**互不共享依赖**：

- `chinese-chess-client/` —— 客户端 monorepo，内部 pnpm workspace 只包含 `client` 一个包。
- `chinese-chess-server/` —— 服务端，**独立目录、独立 lockfile**，不在 `chinese-chess-client/` 的 pnpm workspace 内。

客户端相关命令在 `chinese-chess-client/` 下执行；服务端相关命令在 `chinese-chess-server/` 下执行。

```bash
# 客户端校验（tsc --noEmit && eslint）
cd chinese-chess-client
pnpm -w lint:client
```

`pnpm -w lint`、`pnpm -w lint:all`、`pnpm validate` 都是 `lint:client` 的等价入口（workspace 内只有 client 一个包）。

服务端目录现在带**完整源码**（`chinese-chess-server/src/`，TypeScript）与构建脚本 `build.js`（esbuild 0.27.2）：
`chinese-chess-server/dist/index.js` 由 `src/` 构建生成，**不要再手工改产物**。在 `chinese-chess-server/` 下：

```bash
node build.js           # 用 src/ 重新生成 dist/index.js
node build.js --check   # 校验已提交的 dist 与重新构建的结果是否一致（不一致 exit 1）

pnpm build     # = node build.js
pnpm dev       # = tsx watch src/index.ts
pnpm serve     # = tsx src/index.ts
pnpm lint      # = tsc --noEmit
```

> ⚠️ 不要使用 `pnpm -w lint:server`——该脚本已删除，因为它指向的 `chinese-chess-client/server/` 目录并不存在。

### ⚠️ 服务端 dist 由 src/ 构建生成（改逻辑改 src/，不要改 dist/）

`chinese-chess-server/dist/index.js` 是 esbuild 产物，可读源码在：

```
chinese-chess-server/src/index.ts
chinese-chess-server/src/routes/{lanGame,ai,battleWs}.ts
chinese-chess-server/src/services/{pikafish,openingBook}.ts
```

历史上前身是「没有源码、只能手工往 dist 里打补丁」的部署产物，6 条加固由 `scripts/patch-dist.mjs` 注入产物；
**现在这 6 条加固都已归位到源码，`patch-dist.mjs` 已删除**：

1. 长将长捉超限不拦截落子、不按违规次数判负
2. 畸形 FEN 行宽校验（进入 Pikafish WASM 前拦截）
3. 初始局面上传收紧（仅房内玩家、且仅在本局尚无着法时可上传）
4. 请求体驱动的终局副作用（与第 3 条同源，成对生效）
5. 被拒绝的动作也回推权威状态（避免客户端停在乐观更新）
6. 房间名最小空缺优先（自动房名复用被释放的编号）

**改完源码必须重新构建：在 `chinese-chess-server/` 下执行 `node build.js`。**

### 这道闸门挂在哪些地方（`dist` 与 `src/` 不一致都会立刻失败）

| 环节 | 命令 | 行为 |
| --- | --- | --- |
| 打包服务端 | `pack.ps1 server` / `pack.sh server` | 出包前 `build.js --check`，失败则**阻塞出包**（不会生成 zip） |
| 安装服务端依赖 | 服务端目录下 `pnpm install` | `postinstall` 自动 `node build.js`（重新生成 dist） |
| 客户端静态校验 | `pnpm -w validate` | 先 `lint`，再 `verify-server-parity`（= `build.js --check`） |
| 单独校验 | `pnpm -w verify:server-parity` / 服务端 `pnpm verify` | 只做 `--check` |

> 这些都是**非零退出即失败**的闸门，CI 只需调用其中任一即可阻塞流水线。
> `node dist/index.js`、`start.bat` 等直启方式不做校验，需自行确认。

## 打包规范（仓库根目录 pack.ps1 / pack.sh）

```bash
pwsh -File pack.ps1 [client|server|all]   # Windows（等价于 .\pack.ps1）
./pack.sh      [client|server|all]         # POSIX
```

- **每次打包会自动删除「该端」的历史 zip**，只删同前缀的（`chinese-chess-client_*.zip` 或
  `chinese-chess-server_*.zip`），**client 与 server 互不影响**；根目录因此始终只保留每个端
  当天的那一个包。旧包留在根目录极易被误当成最新包分发（源码改了一整天、zip 还停在前一天的
  情况本项目发生过一次），所以打完包请确认根目录 `chinese-chess-*.zip` 各只剩一个。
- 服务端出包前强制 `node build.js --check`（校验 `dist` 与 `src/` 是否一致），校验失败**阻塞出包**（不会生成 zip）。
- `pack.ps1` 需存为 **UTF-8 with BOM**：Windows PowerShell 5.1 在无 BOM 时按 GB2312 解码，
  中文提示会乱码。

## 如何修改主题模式（跟随系统、固定暗色、固定亮色）

默认为跟随系统，如果用户明确指定为“暗色”或“亮色”，需要修改 `client/components/ColorSchemeUpdater.tsx` 的 `DEFAULT_THEME` 变量为合适的值

## 如何定制主题 design tokens

当前项目的**设计系统**基于 tailwindcss 实现，核心入口文件为 `client/global.css`，如果需要定制主题，应该**阅读并修改 `client/global.css` 文件**

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

前后端都在 `chinese-chess-client/` 下用一条命令启动（服务端是仓库根下的独立目录，脚本会自动定位）：

```bash
pnpm -w dev:all       # 同时起服务端 + 客户端（推荐）
pnpm -w dev:server    # 只起服务端（仓库根的 chinese-chess-server/，默认 9091）
pnpm -w dev:client    # 只起 Expo web 客户端（5000），/api/v1 代理到 SERVER_PORT
```

`dev:all` 由 `scripts/dev-all.mjs` 实现：它给客户端注入 `SERVER_PORT`，
让 `client/metro.config.js` 把 `/api/v1/*` 代理到对应端口的后端。
用 `PORT=8080 pnpm -w dev:all` 可同时改两端端口（`EXPO_PORT` 改客户端端口）。

> ⚠️ 根脚本 `dev` / `build` / `start` 仍指向 `.cozeproj/scripts/*.sh`，
> 而这些脚本以 `$ROOT_DIR/server`（即 `chinese-chess-client/server/`）为工作目录——
> 该目录并不存在，服务端实际在仓库根的 `../chinese-chess-server/`。
> `.cozeproj/` 标记为禁止修改，所以这三个脚本在当前仓库结构下不可用，请改用上面的 `dev:*`。

## 互联网对战部署指南

「互联网对战」通过一台你自己控制的电脑运行对战服务端（Express，端口 9091），再借助内网穿透（如樱花穿透 / SakuraFrp）暴露到公网，手机 App 填写公网地址即可与远方的朋友对弈。对战数据为纯 HTTP 轮询（无 WebSocket），天然兼容各类 HTTP 穿透隧道。

### 1. 在本地电脑启动对战服务端

要求：已安装 Node.js 18+（`chinese-chess-server/` 是自包含部署包，**无需 pnpm install**）。

```bash
cd chinese-chess-server
pnpm start       # 等价于 npm start；启动已构建的 dist/index.js，监听 9091
```

Windows 上也可以直接双击 `start.bat`，或执行 `node dist\index.js`。

如需修改端口：`set PORT=8080 && pnpm start`（PowerShell/CMD），或 `PORT=8080 pnpm start`（macOS/Linux）。

验证：浏览器访问 `http://localhost:9091/api/v1/health` 应返回正常 JSON。

### 2. 配置樱花穿透（SakuraFrp）

1. 在樱花穿透控制台创建隧道：
   - 类型：**TCP**（或 HTTP 隧道，任选其一）
   - 本地地址：`127.0.0.1`，本地端口：`9091`
2. 启动隧道后，获得公网访问地址，例如 `cn-xxx.example.com:12345`。
3. 完整服务器地址为 `http://cn-xxx.example.com:12345`（HTTP 隧道则直接使用分配的域名）。

### 3. 在 App 中填写服务器地址

1. 打开 App → 首页「互联网对战」。
2. 点击顶部「服务器」卡片右上角的齿轮图标。
3. 输入公网地址（如 `http://cn-xxx.example.com:12345`），点击「测试连接」确认延迟正常后保存。
   - 不填时使用开发环境默认地址；填错可点「恢复默认」。
4. 回到大厅：创建房间，或输入朋友的 6 位房间码加入对局。

> 注意：双方玩家必须填写**同一个**服务器地址才能互相看到房间。

### 4. 其他说明

- 房间数据保存在服务端内存中，服务端重启后所有房间失效。
- 闲置房间自动清理：等待中 30 分钟、对局中 2 小时无活动即销毁。
- 对局中一方断线超过 60 秒判负；悔棋需对方在 30 秒内同意。
