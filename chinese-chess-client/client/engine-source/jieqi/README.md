# 揭棋引擎（jieqi）WASM 构建说明

> 来源：`official-pikafish/Pikafish` 的 **`jieqi_old`** 分支（commit `23b9466`，2025-08-04）。
> 官方 `jieqi` 分支**已从 GitHub 消失**（`git ls-remote` 仅返回 `jieqi_old` / `master` / `tune`），
> 故选用 `jieqi_old`。其源码经核验**完整包含揭棋逻辑**（`isDark` / `PieceExchange` / `pGet` / `pCaptured`）。

## 一、产物

| 文件 | 大小 | 说明 |
|---|---|---|
| `jieqi.wasm` | 384.4 KB | 引擎本体（release，`-O2 -DNDEBUG`） |
| `jieqi.js` | 62.5 KB | Emscripten glue（`MODULARIZE`，`EXPORT_NAME=PikaJieqi`） |

### 评估函数：完整的经典启发式（非子力差）

编译时使用 `-DUSE_NNUEEVAL=0`（`jieqi_old` 的 `src/types.h:106` 本就写死为 `0`），
此时 `Eval::evaluate()` 走 `#else` 分支：

```cpp
Value v = Evaluation<NO_TRACE>(pos).value();   // evaluate.cpp
```

即 **psqt + threats + pair + space + mobility 的经典评估**
（Stockfish 2015 年代成熟实现），**不是**简单的子力差。

实测表现（P0）：初始局面 depth 6 给出 `score cp 267`，且迭代加深时评分合理波动
（267 → 277 → 255 → 260 → 262 → 241），说明评估在工作而非退化为常数。

### ⚠️ 关于 NNUE 权重：本分支默认不用

- `jieqi_old` 的 `USE_NNUEEVAL` 被**硬编码为 0**（`src/types.h:106`），
  故**即使拿到匹配的权重，默认编译产物也不会使用**；
- 权重公开渠道经调研**确认不存在**（官方论坛揭棋版块 2025-01 至今仅 3 个主题、
  零权重链接；官网无揭棋版；`Networks` 仓库仅 master 滚动网）；
- 若要启用需改宏为 1 并重新编译，但**权重仍然拿不到** ⇒ 暂不投入；
- 相较而言 `jieqi`（非 `_old`）分支的 NNUE 是活的，值得后续单独评估。

详见 `../../../../JIEQI-PIKAFISH-INTEGRATION-PLAN.md` §2.1.0c。

## 二、编译参数

```
em++ -std=c++17 -O2 -DNDEBUG -DUSE_NNUEEVAL=0 -DNO_PREFETCH -DIS_64BIT -fno-exceptions

链接：
  -s WASM=1 -s ALLOW_MEMORY_GROWTH=1 -s INITIAL_MEMORY=64MB -s STACK_SIZE=3MB
  -s EXPORTED_FUNCTIONS="['_main']"
  -s ENVIRONMENT=node,web,worker -s MODULARIZE=1 -s EXPORT_NAME=PikaJieqi
  -s EXIT_RUNTIME=0
  -s INCOMING_MODULE_JS_API="['stdin','print','printErr','locateFile','noInitialRun']"
```

⚠️ `INCOMING_MODULE_JS_API` **必须**包含 `stdin`，否则宿主传入 stdin 回调时
Emscripten 直接 `Aborted()`（实测踩过）。

## 三、单线程适配补丁（4 处，必需）

Emscripten 单线程构建（无 `-pthread`）下 `std::thread` 构造会 `abort()`。
本引擎在 4 处创建/依赖真实线程，已全部打补丁。

> 补丁**不落成 `.patch` 文件**，而由同目录的 `apply-wasm-patches.cjs`
> 以「锚点字符串 + 正则」幂等注入（上游源码是 CRLF，`git apply` 实测全部 CHECK FAILED）。
> 用法：`node apply-wasm-patches.cjs <源码目录>`，可重复执行。

| 文件 | 问题 | 修复 |
|---|---|---|
| `thread_win32_osx.h` | `typedef std::thread NativeThread` 会建真实线程 | 新增 `__EMSCRIPTEN__` 分支，提供**不建线程**的 `NativeThread` 空实现 |
| `thread.cpp` | `wait_for_search_finished()` 等 `idle_loop` 置 `searching=false`，单线程下**死锁** | 单线程下直接 `return` |
| `thread.cpp` | `start_searching()` 无人执行搜索；且置位后不复位致析构 `assert(!searching)` 失败 | 单线程下**同步执行 `search()`** 再复位 |
| `tt.cpp` | `TT::clear()` 用 `std::vector<std::thread>` 建线程清零 | 单线程下直接 `memset` 整表 |
| `thread.h` | `searching` 初值 `true`，单线程下析构断言失败 | 单线程下初值改 `false` |

> 📌 补丁均用 `#if defined(__EMSCRIPTEN__) && !defined(USE_PTHREADS)` 守卫，
> **不影响原生构建**（原生下走原路径）。

## 四、验证方式

### 4.1 Node 侧回归（不需要浏览器）

```powershell
# 直连引擎：跑完整 UCI 流程并断言出着
node verify.cjs
# 期望：uciok true / readyok true / bestmove h0g2 / RESULT: PASS  (exit 0)

# 编码器对拍：把我们生成的 FEN + 揭晓后缀喂给引擎
node faceoff.mjs
# 期望：3 passed, 0 failed
```

### 4.2 浏览器端到端（**接入层的真正判据**）

```powershell
# 前置：Expo Web 已启动（client/ 下 npx expo start --web --port 5000）
# 依赖：puppeteer-core（复用本机 Chrome，不下载浏览器）
npm i puppeteer-core
$env:PUPPETEER_CORE_PATH = "<path>/node_modules/puppeteer-core"   # 若装在别处
node browser-verify.mjs
# 期望：3/3 passed（初始局面 / 三手历史 / 长历史）
```

> ⚠️ **为什么必须在浏览器里验证**：wasm 加载依赖真实同源 http(s) 资源 +
> `fetch` + `instantiateStreaming`；Node 既无 `WorkerGlobalScope` 也无
> `instantiateStreaming`，无法复现该路径。详见 §五。

### 4.3 实测结果（2026-10）

| 验证 | 结果 |
| --- | --- |
| `verify.cjs`（Node 直连） | ✅ PASS，`bestmove h0g2`，nps ≈ 1.70M |
| `faceoff.mjs`（编码对拍） | ✅ 3/3 |
| `browser-verify.mjs`（浏览器 E2E） | ✅ 3/3（含带揭晓后缀的历史重放） |

---

## 五、接入关键约束（**踩坑记录，勿重复踩**）

### 5.1 wasm 必须是**独立同源资源**，不能内联

实测（headless Chrome）：

| 方式 | 结果 |
| --- | --- |
| Worker 由 `blob:` URL 创建 + `fetch(data:...)` | ❌ `TypeError: Failed to fetch`（blob worker 来源不透明） |
| 同源 Worker + `data:application/wasm;base64,...` | ❌ `CompileError: expected magic word 00 61 73 6d, found "Asse"`（data: 响应被物化为文本） |
| **同源 Worker + 独立 `.wasm` 资源（`application/wasm`）** | ✅ **成功** |

glue 只读这些 `Module` 键：`locateFile`、`noFSInit`、`stdin`、`print`、
`printErr`、`_main`、`noInitialRun`。`wasmBinary` 与 `readBinary` 是**闭包变量**，
无法从 `moduleArg` 注入；Worker 里 glue 自装的 fallback 是同步 XHR
（无法设 `responseType` ⇒ 实际不可用）。

⇒ 正确做法：`locateFile` 返回**真实同源 wasm URL**，让 glue 走
`fetch` + `instantiateStreaming`。URL 由主线程经 `postMessage` 传入
（只有主线程知道 Metro 的 hashed asset 路径）。

### 5.2 不要设 `noInitialRun`

glue 的 `run()` 会调 `callMain()` 驱动 `UCI::loop()`，并消费整段 stdin
（实测 6 条命令约 147 次 stdin 回调）。

若设 `noInitialRun`，`run()` 会跳过 `callMain`；此时手工调 `mod._main()` 会
**静默失败**——`initRuntime()`/`TTY.init()` 已接管 stdin，
`UCI::loop()` 读到 EOF 立即退出（只看到横幅，没有 `uciok`）。

### 5.3 Metro 资源 URL 形态

`assets/engines/` 下的资源**不能**用 `/assets/engines/x.bin` 直接访问（404）。
正确形态（实测）：

```
/assets/?unstable_path=assets%2Fengines%2Fjieqi.worker.bin&platform=web
/assets/?unstable_path=assets%2Fengines%2Fjieqi.wasm&platform=web
```

主线程侧由 `require()` 拿到该 URL（见 `utils/chess/pikafish/jieqiHost.ts`）。

### 5.4 其他

- `jieqi.js` 内部硬编码引用构建时的 wasm 文件名（`jieqi_r.wasm`），
  必须用 `locateFile` 覆盖；
- 源码是 **CRLF** 换行，打补丁脚本须换行无关（见 `apply-wasm-patches.cjs`）；
- emsdk 官方安装器在 Windows 上会因 `WinError 5` 失败（解压 `test/*.py` 被拦），
  需用 .NET `ZipFile` 手工解压（见 `emenv.ps1` 顶部说明）；
- 引擎的 `bestmove` **恒为 4 字符**，不带揭晓后缀——后缀只出现在我们
  **喂进去**的 `position ... moves` 里。

---

## 六、许可证

引擎为 **GPLv3**（见上游 `Copying.txt`）。本目录产物由 GPLv3 源码编译而来，
分发时需履行 GPLv3 §6 义务（提供对应源码或书面 offer）。
详见仓库根目录 `LICENSE-JIEQI-ENGINE.md`。

补丁文件本身是对 GPLv3 作品的修改，**同样以 GPLv3 提供**。
