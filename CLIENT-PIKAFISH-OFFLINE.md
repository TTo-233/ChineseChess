# 客户端本地皮卡鱼离线集成

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
由 `gen-pikafish-host.mjs` 打成两个自包含产物。

> 该目录 2026-10 从 `chinese-chess-server/ai/pikafish/` 迁来：它是**构建期**材料
> （生成产物 + 逐字节溯源校验），运行时不加载，因此也从客户端部署包中排除
> （`pack.ps1` / `pack.sh` 排除 `engine-source/`），产物 `assets/engines/` 随包分发。

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
  pikafish.worker.bin          Web 端 classic Worker（约 6.06 MiB）
  pikafish.html                原生端离线页（约 6.05 MiB）

client/scripts/
  gen-pikafish-host.mjs        生成上面两个产物
  verify-pikafish-engine-assets.mjs  产物完整性校验

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
- **引擎资源约 10.9MB 入库**（worker 0.2 + wasm 0.48 + nnue 3.91 + html 6.06）；
  比优化前的 12.1MB 略小，且 Web 端首启传输从 6.06MB 降到 4.59MB。
- **原生端尚未真机验证**（需要 `expo prebuild` + development build，
  仓内目前是 managed workflow、没有 `android/`、`ios/`、EAS 配置）。
- **测试文件不在 `tsc` 覆盖范围内**：`tsconfig.json` 显式 exclude 了
  `*.test.ts(x)`，因此接口签名变化不会被类型检查拦住（曾因此漏改一处调用）。
  改公共接口后需人工核对测试文件。

## 许可证

Pikafish 引擎为 **GPL-3.0**，NNUE 权重受**独立于 GPL** 的皮卡鱼官方协议约束
（未经许可不得商用）。两个产物头部都保留了声明。

本项目为内部娱乐用途。若要商用或上架，需先取得 NNUE 商用授权，
并评估 GPL 对分发形态的要求（**非法律意见**）。
