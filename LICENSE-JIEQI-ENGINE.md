# 揭棋引擎许可与合规声明（GPLv3）

## 一、引擎来源

**项目名称**: Pikafish（中国象棋 / 揭棋 UCI 引擎）
**上游仓库**: https://github.com/official-pikafish/Pikafish
**选用分支**: `jieqi_old`
**对应 commit**: `23b9466`（2025-08-04，"Fix a bug"）
**License**: GPLv3

> **为什么是 `jieqi_old`**：官方 `jieqi` 分支**已从 GitHub 消失**
> （`git ls-remote --heads` 现仅返回 `jieqi_old` / `master` / `tune`）。
> `jieqi_old` 源码经核验完整包含揭棋逻辑
> （`isDark` / `PieceExchange` / `pGet` / `pCaptured` / `do_flip`）。

### ⚠️ 关于 AB-JChess：**经评估后未采用**

本项目在选型阶段评估过 [AB-JChess](https://github.com/lxsgx23/AB-JChess)
（GPLv3 + NNUE 权重），结论是**放弃**：其权重与 `jieqi_old` 存在**四个独立硬阻断**——
容器 magic（`ABJCHESSV11` vs `Version=0x7AF32F20`）、特征维度（34800 vs 7020）、
PSQT 桶（0 vs 8）、哈希算法（SHA-256 vs uint32 链式），任一独立成立即拒绝加载。

⇒ **本仓库不含任何 AB-JChess 代码或权重**，运行时引擎横幅为
`Pikafish ... by the Pikafish developers`，glue 工厂名 `PikaJieqi`。
（评估过程见 `JIEQI-PIKAFISH-INTEGRATION-PLAN.md` §2.1.0c 结论 4。）

---

## 二、许可证条款（GPLv3）

上游引擎受 **GNU General Public License version 3** 约束：

> This program is free software: you can redistribute it and/or modify it under
> the terms of the GNU General Public License as published by the Free Software
> Foundation, either version 3 of the License, or (at your option) any later version.

**核心义务**：

1. **源码公开**：分发二进制时需提供对应的完整源码（含构建脚本）；
2. **继承许可**：任何修改版本也必须采用 GPLv3；
3. **修改标注**：修改过的文件须保留声明并注明改动（GPLv3 §5）。

---

## 三、本项目对引擎的修改（GPLv3 §5 标注）

引擎为 **WASM 单线程**目标做了 **4 处适配补丁**——Emscripten 无 `-pthread`
构建下 `std::thread` 构造会直接 `abort()`，而上游在 4 处创建/依赖真实线程：

| 文件 | 问题 | 修复 |
| --- | --- | --- |
| `thread_win32_osx.h` | `typedef std::thread NativeThread` 会建真实线程 | 新增 `__EMSCRIPTEN__` 分支，提供**不建线程**的空实现 |
| `thread.cpp` | `wait_for_search_finished()` 等 `idle_loop` 置 `searching=false`，单线程下**死锁** | 单线程下直接 `return` |
| `thread.cpp` | `start_searching()` 无人执行搜索；且置位后不复位致析构 `assert(!searching)` 失败 | 单线程下**同步执行 `search()`** 再复位 |
| `thread.h` | `searching` 初值 `true`，单线程下析构断言失败 | 单线程下初值改 `false` |
| `tt.cpp` | `TT::clear()` 用 `std::vector<std::thread>` 建线程清零 | 单线程下直接 `memset` 整表 |

> 📌 补丁均以 `#if defined(__EMSCRIPTEN__) && !defined(USE_PTHREADS)` 守卫，
> **不影响原生构建**（原生下走原路径）。补丁文件本身是对 GPLv3 作品的修改，
> **同样以 GPLv3 提供**。

补丁**不落成 `.patch` 文件**，而是由
[`apply-wasm-patches.cjs`](./chinese-chess-client/client/engine-source/jieqi/apply-wasm-patches.cjs)
以「锚点字符串 + 正则」幂等注入（上游源码是 CRLF，`git apply` 实测全部 CHECK FAILED）。

### 关于 NNUE 权重：本产物**不使用**

编译参数含 `-DUSE_NNUEEVAL=0`（`jieqi_old` 的 `src/types.h:106` 本就写死为 `0`），
`Eval::evaluate()` 走 `#else` 分支，即 **psqt + threats + pair + space + mobility
的经典评估**（Stockfish 2015 年代成熟实现），**不是**简单子力差。

⇒ 本仓库**不包含任何 NNUE 权重文件**，故**不涉及**权重侧的单独许可约束。
（揭棋专用权重的公开渠道经调研确认不存在，详见方案 §2.1.0c。）

---

## 四、本项目履行的 GPLv3 §6 义务（源码提供）

按 GPLv3 §6，分发 `jieqi.wasm` 时提供**对应源码**。获取方式：

1. **上游源码**（对应 commit）：
   ```
   git clone -b jieqi_old https://github.com/official-pikafish/Pikafish
   git checkout 23b9466
   ```
2. **本项目补丁与构建脚本**（随仓库分发，亦可应要求书面提供）：
   ```
   chinese-chess-client/client/engine-source/jieqi/
     ├── apply-wasm-patches.cjs   # 4 处单线程适配补丁（幂等注入）
     ├── build.ps1                # 完整编译/链接参数
     ├── emenv.ps1                # emsdk 环境准备
     └── README.md                # 编译说明与踩坑记录
   ```

复现构建：按 `README.md` §二 的 `em++` 参数，先跑 `apply-wasm-patches.cjs`
打补丁，再由 `build.ps1` 编译。

> 本仓库根目录的 `pack.ps1` 会**排除** `engine-source/`（源码与产物不同包分发），
> 部署包内仅含 `assets/engines/jieqi.wasm` 与 `jieqi.worker.bin`。

---

## 五、使用范围

✅ 本项目明确声明**仅用于内部娱乐目的**，不涉及正式上架或发行；
✅ 不对用户收取任何费用；
✅ 未对引擎的棋力算法做任何修改（仅做上述 WASM 单线程适配）。

---

## 六、风险提示

⚠️ 若未来项目转为商用或开源发布，必须重新评估 GPLv3 分发义务的履行方式
（例如「聚合（aggregate）」豁免是否成立，见 FSF FAQ）。

---

## 七、参考资料

1. [Pikafish 官方仓库](https://github.com/official-pikafish/Pikafish)
2. [GPLv3 全文](https://www.gnu.org/licenses/gpl-3.0.html)
3. [FSF GPLv3 FAQ - Mere Aggregation](https://www.gnu.org/licenses/gpl-faq.html#MereAggregation)
4. [Stockfish v. ChessBase 和解案要点](https://stockfishchess.org/files/settlement_english.pdf)

---

**声明**: 本文档不构成法律意见。如有疑问，请咨询专业知识产权律师。
