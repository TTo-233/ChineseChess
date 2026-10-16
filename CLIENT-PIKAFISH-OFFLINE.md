# 客户端本地皮卡鱼离线集成

## 【真机二次定位】引擎在打包 APP 里依然起不来：真正根因（2026-10 定案）

### 一句话结论

上一轮修复把「Android 裸资源名无法被 WebView 导航」这个**症状**处理对了，
但它依赖的 `expo-asset` **根本没有被装进 APP** —— 于是新写的转换函数
一进真机就抛 `MODULE_NOT_FOUND`，两个引擎一次都没起来过。

**最值得记住的教训：手写的 `declare module` 能骗过 tsc 和单测，却骗不过 Metro 与设备。**

### 证据链（全部来自 adb 抓取的真机安装包，非推测）

| 检查项 | 结果 | 含义 |
|---|---|---|
| `require.resolve('expo-asset')` | `MODULE_NOT_FOUND` | 打包期就解析不到 |
| `client/package.json` | 无 `expo-asset` | 只是 expo 的**传递依赖** |
| pnpm 严格布局 | 未提升到 `client/node_modules` | 无法直接 import |
| APK 内 `expo.modules.asset.AssetModule` | **不存在** | 原生模块没进 dex |
| APK 内引擎资源 `assets_engines_*` | **六个齐全**（resources.arsc key pool 内） | 资源**确实打进了包** |

> 最后两行是本次定位的决定性对照：
> **资源在包里，是"用什么去读它们"出了错。**
> 这一点用 `resources.arsc` 的字符串池反查确认（该表字符串是 UTF-8，
> 一开始误按 UTF-16 搜索而误判为"资源不在包里"，这个坑值得记一笔）。

### 为什么上一版能一路绿灯

那一版为了让它「类型上可用」，给 `expo-asset` 补了一份 `declare module` shim。
结果是把这个**运行时依赖缺失**从编译期错误，降级成了运行期才炸、
又被 `try/catch` 吞掉的静默降级：

```
tsc 全绿  +  869 单测全绿  +  Chromium 探针全绿  +  构建成功
                    ↓
              真机：引擎永远「启动中」
```

### 修复

1. `expo-asset` 升为 **client 的直接依赖**（`~12.0.12`），原生模块随 prebuild 进 dex；
2. **删除** `declarations.d.ts` 里的 `declare module 'expo-asset'` shim，
   让 tsc 重新对这个包负责；
3. `resolveViaExpoAsset` 里**去掉 try/catch 兜底** —— 缺依赖属于「打包配置坏了」，
   必须以可辨识的异常冒到上层，而不是伪装成一次普通降级；
4. `nativeEngineAsset.test.ts` 新增三条例外断言守住这一层：
   `expo-asset` 必须是直接依赖、`require.resolve` 必须真的能解析、`Asset.fromModule` 必须真的存在。

> 顺带排除的方案：**不用 `expo-file-system` 自己读字节**。
> 同一份 APK 里 `expo.modules.filesystem.FileSystemModule` 同样**不存在**
> （JS 能 resolve 但没进 native 侧），走它只会把同一个坑换个包名再踩一次。

## 这是什么

把**皮卡鱼引擎**接进客户端，让 AI 走子**完全在本地运行**——
浏览器 / 手机在完全断网时也能下人机对战。

改造前：客户端的"本地 AI"是一段纯 TypeScript 的 α-β 搜索
（`AIEngine.ts`，深度 2/3/4，跑在 JS 主线程），棋力很弱；
联网才有真引擎，断网就"砍瓜切菜"。

改造后：

| 场景 | 改造前 | 改造后 |
|---|---|---|
| **人机对战** | 服务端皮卡鱼（联网）/ TS 搜索（断网） | **本地皮卡鱼**（始终同一套引擎与档位） |
| **残局闯关** | TS 搜索（很弱） | **本地皮卡鱼** |
| **提示** | TS 搜索 | **本地皮卡鱼** |
| **后台预计算** | TS 搜索占满主线程 | **本地皮卡鱼**（不占主线程） |
| 引擎起不来时 | — | 兜底回 TS 搜索（保证不卡对局） |

> **2026-10 服务端去 AI 化**：服务端已移除全部 AI 能力（引擎池、`/api/v1/ai/*`），
> 现只承载**在线对局**（房间、同步、权威裁决）。人机 AI 无需联网，也不再有任何
> 在线回退路径或"重连中"状态角标。

## 关键设计

### 一、难度档位单一来源

「入门/进阶/大师/提示」由 `utils/chess/pikafishTier.ts` 唯一定义，
经 `pikafishDifficulty.ts`（UI 文案）翻译成 `utils/chess/pikafish/*` 的 UCI 参数。

> 服务端仍有 AI 时，档位必须两端同步 —— 那时定义经 `ruleEngine.bundle.ts` →
> `ruleEngine.cjs` 打包到服务端，并有专门的校验脚本逐字段比对。
> 服务端不再承载 AI 后，「联网与断网棋力会不会漂移」这个问题本身已消失，
> 档位随之回归客户端自持。

所以档位定义只有一个来源：

```
client/utils/chess/pikafishTier.ts              ← 唯一来源
        │
        ├─→ 客户端 utils/chess/pikafishDifficulty.ts（UI 文案）
        └─→ 客户端 utils/chess/pikafish/*         （翻译成 UCI 参数）
```

> **2026-10 服务端去 AI 化后的变化**：此前档位要经 `ruleEngine.bundle.ts` →
> `ruleEngine.cjs` 打包到服务端，供 `services/pikafish.ts` 的 `ONLINE_DIFFICULTY`
> 读取，并由 `verify-pikafish-difficulty-parity.mjs` 逐字段比对两端。
> 服务端不再承载 AI 后，「在线与离线档位会不会漂移」这个问题本身消失了 ——
> 现在只有客户端这一份引擎，档位随之回归客户端自持，**不再需要跨端同步与校验**。
> （该校验脚本与 `ruleEngine.bundle.ts` 中的档位 re-export 均已删除。）

档位定义（当前值）：

```
easy   multiPV=2 depth=4  movetimeMs=5000  randomPick=true
medium multiPV=1 depth=8  movetimeMs=8000  randomPick=false
hard   multiPV=1 depth=12 movetimeMs=15000 randomPick=false
hint   multiPV=1 depth=8  movetimeMs=8000  randomPick=false
```

**改档位只能改 `pikafishTier.ts`**，无需重新打包任何共享产物。

> `movetimeMs` 是墙钟兜底上限：仅在极慢设备上截断，正常由 depth 收敛，
> 保证"再慢也不卡住 UI"，与旧 TS AI 的硬性时间中断职责相同。

### 二、引擎怎么在客户端跑起来

React Native 的 **Hermes 不支持 WebAssembly**，所以 WASM 引擎不能直接跑在 JS 线程上。

| 平台 | 承载 | 说明 |
|---|---|---|
| Web | Dedicated Worker | classic worker，独立事件循环，不阻塞 UI |
| Android / iOS | 屏幕外 WebView | 零尺寸、`pointerEvents=none`，仅作 JS 沙箱 |

两条路径跑的是**同一份**引擎二进制（`client/engine-source/pikafish/`），
由 `gen-pikafish-host.mjs` 打成两个产物（一个 Worker 脚本、一个离线页），
**共用同一对 wasm / nnue 资源文件**。

> 该目录 2026-10 从 `chinese-chess-server/ai/pikafish/` 迁来：它是**构建期**材料
> （生成产物 + 逐字节溯源校验），运行时不加载，因此也从客户端部署包中排除
> （`pack.ps1` / `pack.sh` 排除 `engine-source/`），产物 `assets/engines/` 随包分发。

> ⚠️ **原生端的离线页是靠 `file://` 加载的，地址由 `expo-asset` 解析**
> （不是 `Image.resolveAssetSource`，后者在打包态只给一个裸资源名，WebView 无法导航）。
> 这条是实机能否启动的关键，详见本文【真正根因】一节与
> `utils/chess/pikafish/nativeAsset.ts`。

### 三、三个实测结论（决定了整个方案）

1. **搜索是同步阻塞的**：`send('go')` 返回时 `bestmove` 已产生。
   → 必须放在 Worker / WebView 里；也意味着 `stop` **无法中途打断**，
   抢占靠"丢弃迟到结果"（代数票据保证），靠 `depth + movetime` 保证有界。
2. **NNUE 与 WASM 可完全内存注入**，全程不碰 `fs`：
   加载器留了 `getPreloadedPackage`（NNUE → MEMFS）与
   `instantiateWasm`（自行实例化）两个官方注入口，正好绕开它内部的 `fs.readFile`。
3. **工厂返回的是 `Module['ready']` 这个 Promise**，而
   `send_command` / `read_stdout` 被写在**传入的 config 对象**上。
   调用方必须持有 config 引用——这是接入时最容易踩的坑。

### 四、后台预计算（ponder）也一并迁移

提示已由本地皮卡鱼出之后，`AIEngine.precomputeHint` 的结果**根本不会被消费**，
却仍要在 JS 主线程上跑满 2500ms（实测 99.2% 占空比）——纯属浪费。

所以预计算改走本地引擎（`precomputeOfflineHint` / `takeOfflinePonder` /
`cancelOfflinePonder`），以最低优先级 `ponder` 入队，随时可被正式走子或
用户点提示抢占。`useNewGame` 的开局预计算也已切到新入口，并在换局时调用
`notifyOfflineNewGame()` 清空编排器队列，避免上一局排队的请求在新局面上"复活"。

`AIEngine.precomputeHint` 仅作为**兜底引擎**的内部路径保留
（`LegacyTsEngine` 的 hint 分支会经 `getHintMoveAsync` 复用它），
不再是页面直接调用的入口。

副作用是原先那层"闲时窗口"保护（等玩家不碰棋盘再启动）不再需要 ——
它本就是为了不让预计算抢主线程才加的；现在引擎在 Worker/WebView 里，
主线程干净。

### 五、分层

```
aiDispatcher（纯本地，无网络 / 守卫链）
   │
   ├─ getBestMoveOffline()  人机与残局走子
   └─ getHintMoveOffline()  提示（先取后台预计算，未命中再现场搜）
        │
        └─ runOffline()  ← 本地皮卡鱼 → 失败 → 兜底 TS AI
             │
             └─ offlineAiAdapter（组 FEN/历史/白名单 + 三重守卫 + 失败重试）
                  │
                  └─ OfflineEngineOrchestrator（串行队列 + 优先级 + 按类型降级）
                       ├─ PikafishOfflineEngine → Worker / WebView 承载 → Pikafish
                       └─ LegacyTsEngine → AIEngine.ts（兜底）
```

**为什么保留兜底**：本地皮卡鱼要加载 6MB 引擎 + 实例化 WASM（冷启动有耗时），
且在少数环境（资产缺失、CSP 拦 Worker、WebView 起不来）根本不可用。
若直接依赖它，一次失败就会让对局卡在「AI 回合」——玩家点不动棋子，也没有下一步。
旧 TS AI 永远可用（纯 JS、无外部资产），必须留在最后一层。

**为什么引擎的着法不能直接采信**：皮卡鱼的合法着法生成本就不含"吃将"，
且它不知道项目的长将长捉禁着。所有走法在落子前都过**同一套出口守卫**
（不送将；超限着法由调用方另行择优）。

## 目录

```
client/utils/chess/
  pikafishTier.ts              档位唯一来源
  pikafishDifficulty.ts        档位 + UI 文案
  pikafishUci.ts               UCI 协议纯函数（坐标/命令/解析）
  offlineEngine.ts             OfflineEngine 接口
  offlineAiTypes.ts            结果类型
  offlineAiAdapter.ts          组请求 + 三重守卫 + 取消/预热入口
  pikafish/
    index.ts                   平台装配（懒加载单例）
    pikafishLocalEngine.ts     本地引擎实现（UCI 生命周期）
    offlineOrchestrator.ts     串行队列 + 优先级 + 一次性降级
    legacyTsEngine.ts          兜底实现
    engineTransport.ts         承载层统一接口
    webWorkerTransport.ts      Web Worker 承载
    webViewTransport.ts        WebView 命令式桥（零原生依赖）
    webViewHost.tsx            屏幕外 WebView 组件（隔离 react-native-webview）
  __tests__/pikafishUci.test.ts
  __tests__/pikafishLocalEngine.test.ts
  __tests__/offlineOrchestrator.test.ts
  __tests__/offlinePonder.test.ts
  __tests__/webViewTransportBoot.test.ts
  __tests__/pikafishDifficulty.test.ts

client/assets/engines/         构建产物（勿手工编辑）
  pikafish_worker.bin          Web 端 classic Worker（0.20 MiB，靠 fetch 拉二进制）
  pikafish.page                原生端离线页（0.20 MiB，同样靠 fetch 拉二进制）
  pikafish_wasm.wasm           引擎二进制（0.48 MiB，两端共用）
  pikafish_nnue.nnue           NNUE 权重（3.91 MiB，两端共用）
  jieqi.page / jieqi_worker.bin / jieqi_wasm.wasm   揭棋（页内联 glue+wasm，0.57 MiB）

client/utils/chess/pikafish/
  nativeAsset.ts               原生资源 → file:// 可导航 URI（打包态根因修复所在）
  jieqiWebViewBridge.ts        揭棋 WebView 命令式桥

client/scripts/
  gen-pikafish-host.mjs        生成上面两个产物
  gen-jieqi-host.mjs           生成揭棋产物
  verify-pikafish-engine-assets.mjs  产物完整性校验
  verify-jieqi-engine-assets.mjs      揭棋产物完整性校验
  verify-asset-resource-names.mjs     AAPT raw 资源名唯一性校验
  verify-engine-in-chromium.mjs       在真实 Chromium 内核里端到端跑两个引擎

client/engine-source/pikafish/  引擎源二进制（构建期材料，不入部署包）
  pikafish.cjs / pikafish.wasm / data/pikafish.data
```

## 常用命令

```bash
# 重新生成引擎产物（改动 client/engine-source/pikafish 后必须执行）
pnpm -w gen:pikafish-host

# 校验
pnpm -w verify:pikafish-engine-assets
pnpm -w validate            # lint + 两端规则引擎一致性 + 引擎产物 + 全部测试
```

> 改完 `client/engine-source/pikafish/` 里的引擎文件后，
> **必须**重跑 `gen:pikafish-host`，否则客户端用的还是旧引擎。
>
> `verify:pikafish-engine-assets` 会抓住这种漏跑，覆盖三层：
>   1. `pikafish.wasm` / `pikafish.nnue` 与源二进制**逐字节**（sha256）比对；
>   2. `pikafish.html` 内嵌的 NNUE base64 解码回来后与源 NNUE 逐字节比对；
>   3. **两份产物都必须逐字符完整包含源 loader（`pikafish.cjs` 全文）**——
>      这是 2026-10 审计补上的一条：此前 worker 只有"16 个必需标记 + 无体积下限"，
>      而实测那些标记全落在文件前 3%，Emscripten loader 主体（约 195KB）在盲区里，
>      于是截断到 5%、甚至**等长替换**整段 loader 都能"校验通过"（假绿灯）。
>      而 worker 损坏只会静默降级成"基础 AI"，用户看不到任何报错。

## 工程上的几个要点

### 引擎产物为什么用 `.bin` 后缀

`pikafish.worker.bin` 内容是 JS，但后缀**不能**是 `.js`：
`.js` 属于 Metro 的 `sourceExts`，会被 Babel 转译那两段 5.5MB 的 base64
（启动慢到数十秒、内存峰值数百 MB，且**不报任何错**）。
`.bin` 已在 `metro.config.js` 登记为 `assetExt`，按原字节透传。
它只是给 `new Worker(url)` 的 URL，浏览器不关心后缀。

也**不要**用 `blockList` 挡它：blockList 的语义是"从模块图里删掉"，
会让 `require()` 直接失败。

### 为什么引擎资源要惰性 require

Metro 对 `assetExts` 里的文件在 web 上返回资源句柄，但在 Jest/node 解析器下
会把它当普通 JS 模块**执行**——而 worker 脚本顶层有 `self.onmessage = ...`，
在 Node 里直接 `ReferenceError: self is not defined`，
会连带打挂所有间接引入本模块的单测。故 `index.ts` 里必须惰性 require。

### 为什么 `react-native-webview` 被隔离在单独文件

它在 import 时就 `TurboModuleRegistry.getEnforcing('RNCWebViewModule')`，
Jest 环境无原生二进制会直接抛错。因此命令式桥（`webViewTransport.ts`）
零原生依赖，组件（`webViewHost.tsx`）只被根布局 import。

### 优先级与抢占

单实例串行，优先级 `move > hint > ponder`。
`enqueue` 会**延后一个宏任务**再 pump，让同一 tick 内到达的高优先级请求能插队
（同步 pump 会立刻取走 ponder，优先级形同虚设）。

正式 AI 走子开始前会先 `cancelOfflinePonder()`，别让后台预计算占着唯一的引擎。

### 降级只在"引擎真的不可用"时发生

只有承载/初始化层面的失败（平台不支持、Worker 起不来、WebView 页面永不加载、
引擎崩溃、启动超时）才降级，且一次会话只降一次。

**着法层面的失败不降级**：`bestmove (none)` / `CRITICAL ERROR` / 守卫拒收
多是位置相关的一次性事件，换个局面引擎就正常。为此：

- `isEngineUnavailableError()` 区分"引擎不可用"与"着法不可用"；
- `offlineAiAdapter` 对"着法不可用"做**一次去掉历史的重试**（历史含送将着法时
  皮卡鱼会拒绝重放并停在旧局面），两次都失败才抛给调用方回退兜底 AI。

### WebView 承载必须等页面就绪

`bootstrap` **不能**在 `start()` 之后立即下发：原生 WebView 加载 6MB 内联 HTML
必然是异步的，早发会被丢掉 → 启动超时 → 静默降级。因此：

- `EngineTransport.start(onReady)` 增加就绪回调；Worker 同步回调，WebView 在
  `host-loaded` 时回调；
- `webViewBridge` 对握手类消息（bootstrap/stop/dispose）做**发前排队**，
  页面就绪后按序补发（`search` 不排队——引擎未就绪时本就不该有 search）；
- WebView 路径的启动超时放宽到 45s（低端机首次渲染 6MB 内联页可能十几秒）。

## 启动性能优化（2026-10）

实测数据（本机 dev server）：

| 项 | 数值 |
|---|---|
| 原 Worker 脚本 | 6.06 MiB（内联 base64） |
| 二进制原始 | 4.39 MiB（wasm 0.48 + nnue 3.91） |
| base64 膨胀 | **+38%** |
| 拉取 6.06 MiB 耗时 | **约 3.6 s** |
| base64 解码本身 | 仅 ~6 ms（**不是**瓶颈） |

结论：瓶颈是**传输量**与**脚本解析**，不是解码。

### 采取的优化

1. **二进制拆分（Web 端）**：Worker 不再内联 base64，改为收到 `bootstrap` 后
   **并行 fetch** `pikafish.wasm` / `pikafish.nnue`。
   - Worker 脚本 6.06 MiB → **0.20 MiB**（−97%，解析几乎免费）
   - 传输 6.06 MiB → **4.59 MiB**（−24%）
   - 省掉 base64 解码与中间字符串
   - 原生端仍用「内联 base64 的 html」：inline HTML 没有可用同源 origin，
     fetch 兄弟资源会被跨源/CORS 挡住，内联是唯一稳妥选择。
   两条路径共用同一份 `UCI_CORE`，行为一致。
2. **资源缓存**：dev 中间件原本发 `Cache-Control: no-store`，导致**每次刷新都重传
   4~6MB**。改为 `no-cache` + `ETag`（内容未变返回 304；产物重新生成时 ETag 变化,
   开发不失真）。
3. **不阻塞首次走子**：引擎未就绪时最多等 800ms，之后先用兜底出棋、后台继续启动，
   就绪后下一步自动切换到皮卡鱼。
4. **失败可重试**：启动失败进入退避重试（2s→30s，上限 6 次），只有"平台不支持"
   才永久放弃；回到前台时会立刻重试一次。

## 降级与自愈

**降级只在"引擎真的不可用"时发生**，且可自动恢复：

- 只有 `TransportStartError`（平台不支持 / Worker 构造失败）才判**永久**不可用；
- 启动超时、承载异常退出等属**可重试**：进入"启动中"，用兜底出棋，冷却后自动重试；
- 着法层面的失败（`bestmove (none)`、CRITICAL ERROR、守卫拒收）**不降级**，
  仅影响本次；适配层还会做一次"去掉历史"的重试。

状态经 `getStatus()` 暴露，界面据此显示
「本地皮卡鱼」/「皮卡鱼启动中」/「基础AI」。

## 已知限制

- **`stop` 无法中途打断**同步搜索。悔棋/重开时上层会丢弃迟到结果，
  用户感知仍是即时的，但引擎会跑完当前预算才释放。
- **移动端 WebView 可能被系统回收**，回收后承载上报 dead 并进入退避重试；
  回到前台会自动立刻重试一次。
- **引擎资源约 4.6MB 入库**（worker 0.20 + page 0.20 + wasm 0.48 + nnue 3.91，
  揭棋另计 1.0MB）；
  其中**页面本身只有 0.20MB** —— 原生端与 Web 端共用同一对二进制，
  首启实际需要传 4.59 MiB，比最早"单个 6.06MiB 内联页"的方案更小，
  且低端机上的解析/内存峰值低一个数量级。
- **测试文件不在 `tsc` 覆盖范围内**：`tsconfig.json` 显式 exclude 了
  `*.test.ts(x)`，因此接口签名变化不会被类型检查拦住（曾因此漏改一处调用）。
  改公共接口后需人工核对测试文件。

## 【真正根因】打包态拿到的不是 URL，而是 Android「裸资源名」（2026-10 定案）

> 本节是**定论**，取代下面两节里所有"产物没问题、只是 RN 接线坏了"的结论。
> 那些结论是在 **Chromium 探针**上得出的，而探针（以及 Expo 开发态）**结构上
> 看不到**本次故障，所以它们必然是假绿灯。

### 症状

打包 APP 后实机测试，两个引擎**都**起不来：

- 象棋：一直「皮卡鱼启动中」，AI 一步不动；
- 揭棋：一直「基础AI」，引擎从不参与走子。

### 根因（已从 React Native 源码逐行核实，不是推测）

`require('assets/engines/pikafish.page')` 在原生端返回**数字资源 id**。把它交给
`Image.resolveAssetSource(id)` 之后走的是 RN 的 `AssetSourceResolver.defaultAsset()`，
它有两条完全不同的分支：

| 场景 | 走哪条 | 返回值 | WebView 能加载吗 |
|---|---|---|---|
| **开发态**（Metro 在跑） | `isLoadedFromServer()` | `http://localhost:8081/assets/...` | ✅ 真 URL |
| **打包态**（无 serverUrl） | `resourceIdentifierWithoutScale()` | **`engines_pikafish`** | ❌ **不是 URL** |

打包态那个返回值来自 `@react-native/assets-registry/path-support.js` 的
`getAndroidResourceIdentifier()`：把资源路径去掉扩展名、小写、分隔符换 `_`、
再剔除所有非 `[a-z0-9_]` 字符。它是给
`Resources.getIdentifier(name, "raw", pkg)` 用的**资源名**，**没有 `http:`/
`file:`/`asset:` 任何 scheme**。

把它当 `source={{uri}}` 交给 Android WebView 的后果：

1. WebView 把它当**相对路径**去解析 → 加载必然失败；
2. 页面脚本压根没跑 → **`host-loaded` 永远不发**；
3. **也不会触发 `onError` / `onHttpError`** ——「没有可加载的资源」不算网络错误，
   所以承载死亡回调也不会来；
4. 引擎只能干等到启动超时（45s）→ **永久降级**到兜底 AI，界面永远显示
   「皮卡鱼启动中 / 基础AI」，且**全程没有任何报错**。

### 为什么此前所有验证都是「假绿灯」——必须记住的教训

| 验证手段 | 覆盖到打包态吗 | 原因 |
|---|---|---|
| Expo 开发态手测 | ❌ | Metro 在跑，走 `isLoadedFromServer()`，拿到真 http URL |
| `verify-*-engine-assets.mjs` | ❌ | 只做 sha256 / 标记 / 体积校验，**从不执行页面** |
| `verify-engine-in-chromium.mjs` | ❌ | 把页面用**本地 http server** 喂给浏览器 —— 又测了一遍"有可用 origin" |

也就是说：**没有任何一个自动化测试触及过"裸资源名"这一形态**。
这不是"运气不好"，而是验证手段与故障形态之间存在结构性盲区——
所以光"再跑一遍验证"永远发现不了它。

### 修复

1. **原生端改走 `expo-asset`**（`utils/chess/pikafish/nativeAsset.ts`）：
   它的 Android 原生实现（`AssetModule.kt` / `ResourceAsset.kt`）做的正是缺的那一步 ——
   接收裸资源名 → `Resources.getIdentifier` → `openRawResource(resId)` 把字节流
   复制进 cache → 返回 **`file://` URI**。那才是 WebView 能导航的地址。
2. **交付前设一道硬闸**：解析结果必须带 scheme，否则直接抛错。
   宁可降级，也**绝不**把无法加载的字符串递给 WebView —— 那正是本次故障的形态
   （静默失败、无任何报错）。判据见 `isNavigableUri`，由
   `__tests__/nativeEngineAsset.test.ts` 固化。
3. **引擎页来源改为异步**：`getEngineHostSource` / `getJieqiHostSource` 现在返回
   Promise，根布局用 `useState` + `useEffect` 异步挂载宿主。
   同步解析要么拿到裸资源名、要么在渲染期抛错打崩 App，两者都不可接受。
4. **原生端同时降体积**（顺手修掉的第二个真问题）：
   引擎页原本内联 wasm+NNUE 的 base64，单文件 **6.05 MiB**，WebView 要解析 6MB
   巨型字面量再 atob 出 4.4MB 二进制，低端机内存峰值高、易被系统 OOM 杀掉渲染进程。
   现改为与 Worker 同构的「小页面（**0.20 MiB**）+ fetch 两个独立二进制」，
   两个二进制与 Web 端**共用同一对文件**（不额外增大包体）。

> ⚠️ 改动 `pikafishLocalEngine.doBoot` 时踩到的一个坑：承载工厂变成异步后，
> **启动超时必须在第一个 `await` 之前起表**。否则工厂一旦挂起就永远没有超时，
> Promise 悬空，对局会卡在「AI 回合」——比超时降级严重得多。
> 同时刻意**不用 async Promise executor**（其抛出会变成永不被观察的悬空
> rejected promise），改用同步 executor + 内层 async IIFE + 显式 `.catch`。

### 真机验证状态

以上修复已通过：Chromium 内核端到端（两个引擎都跑出真实 bestmove）、
861 项单测、`tsc --noEmit`、eslint，以及全部引擎产物校验。
**打包后的真机行为仍需在设备上确认一次** —— 这一条与本节开头承认的是同一个事实：
自动化验证覆盖不到真机，只能靠一次实机冒烟。

---

## 原生端引擎无法启动：根因与验证（2026-10，已被上节取代）

### 曾经的症状

打包 APP 后实机测试：

- 象棋对局一直显示「皮卡鱼启动中」，AI 一步不动；
- 揭棋对局一直显示「基础AI」，引擎从不参与走子。

### 根因一：React ref(null) 被误判为承载死亡（Pikafish）

`webViewHost.tsx` 用的是**内联箭头 ref**：

```tsx
ref={(instance) => registerWebView(instance)}   // ❌
```

React 的 ref 语义是：回调引用变化时，**先以 `null` 调用旧 ref，再以实例调用新 ref**。
每次重渲染（根布局 `useEffect`、Provider 状态、屏幕旋转、回前台…）都会走一遍这个循环。
而当时的 `registerWebView(null)` 实现把它当成「承载加载失败」：

```ts
if (!instance && pageAlive) {
  pageAlive = false;        // ← 之后 send() 首行直接 return
  pendingOutbox.length = 0; // ← 排队中的 bootstrap 被丢弃
  deadCb?.('WebView 引擎承载加载失败');
}
```

`pageAlive` **只有**页面唯一一次 `host-loaded` 能置回 true，
而重渲染发生在页面加载完成**之后**，于是没有任何恢复路径：
`send()` 永久丢弃一切消息 → 引擎永远收不到 bootstrap → 界面永远「启动中」。

**修复**（`webViewTransport.ts` + `webViewHost.tsx`）：

1. ref 用 `useCallback` 稳定化，从根上消除「每渲染换 ref」；
2. `registerWebView(null)` **只清实例引用**，不再改 `pageAlive`、不再清队列；
   承载死亡改由真正的失败回调（`onError` / `onHttpError` /
   `onRenderProcessGone` / `onContentProcessDidTerminate`）与组件真卸载上报；
3. `send()` 在「页面已就绪但此刻没有注入句柄」（即 ref 的重渲染窗口）时
   **改为排队**，并在 `registerWebView(instance)` 回来的那一刻补发
   —— 避免正好撞上该窗口的 bootstrap / search 被丢进黑洞；
4. 隐藏容器从 `width:0/height:0` 改为 **1×1 + `top/left:-100`**：
   Android 的 WebView 在 0 尺寸容器里可能被跳过布局、甚至不执行页面渲染，
   表现为「页面永远不发 `host-loaded`」。

### 根因二：揭棋在原生端根本没有承载（jieqi）

`jieqiHost.isJieqiHostAvailable()` 原先直接
`return Platform.OS !== 'web' ? false : typeof Worker !== 'undefined'`，
即**原生端永久返回 false**、直接走 TS 兜底（角标显示「基础AI」）。
根因是揭棋只有 Web 端 Worker 产物，没有 WebView 产物，
而 Hermes 既没有 Worker 也没有 WASM —— 原生端无路可走。

现在补齐了 `assets/engines/jieqi.html`（自包含：glue + 内联 wasm），
并新增与 `runSessionInWorker` 对称的 `runSessionInWebView`。

### 验证方式（关键：不靠推断）

产物层面用**真实 Chromium 内核**端到端跑通，而不是只做字节级校验：

- `client/scripts/verify-*-engine-assets.mjs` 此前只做 sha256 与字符计数，
  从不执行页面 —— 产物坏掉也照样绿灯；
- 新增 CDP 探针（`client/scripts/verify-engine-in-chromium.mjs`）：
  启动 `chrome --headless`、注入 `window.ReactNativeWebView` 桩
  （**复刻原生注入时机**：页面脚本执行前）、
  经本地 http 载入产物，然后跑真实的握手与搜索。

已实测通过：

```
[probe] host-loaded ✓
[probe] ready ✓ {"type":"ready","banner":"Pikafish dev-20240226-98b20a33 …"}
[probe] bestmove ✓ h2e2 (depth 6, 5ms)
[probe] PIKAFISH.HTML 端到端验证通过
```

> ⚠️ 探针里**不能用 `while` 忙等**轮询页面状态：忙等会占死主线程，
> WASM 与引擎的回调根本跑不起来，表现为「引擎永远不 ready」的**假失败**。
> 必须用 `setTimeout`/Promise 让出线程。

因此原先「WebView 产物能不能跑」这个前提性问题到此有答案：
**产物一直是好的**。但请注意这段推理**当时的结论是不完整的**——
它只证明了"产物能跑"，没有证明"RN 侧把**打包态**资源正确地交给了 WebView"。
真正的故障正在那一环（见上文【真正根因】），而本节用的 Chromium 探针结构上
看不到它。

## 许可证

Pikafish 引擎为 **GPL-3.0**，NNUE 权重受**独立于 GPL** 的皮卡鱼官方协议约束
（未经许可不得商用）。两个产物头部都保留了声明。

本项目为内部娱乐用途。若要商用或上架，需先取得 NNUE 商用授权，
并评估 GPL 对分发形态的要求（**非法律意见**）。
