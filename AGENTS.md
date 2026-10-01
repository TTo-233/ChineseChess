# AGENTS.md（仓库根）

本文件约束整个仓库的协作方式。子目录另有各自的 `AGENTS.md`，进入该目录工作时以子目录的为准（例如 `chinese-chess-client/AGENTS.md` 规定了字号 token、主题、依赖安装方式等）。

## 交付物固化：每次任务收尾必须重新打包

**规则（用户 2026-10 明确要求，长期有效）**：每个任务执行完毕时，如果本次改动**触及** `chinese-chess-client/` 或 `chinese-chess-server/`，就必须重新打包对应的 zip；没有改动的那一端不必重打。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\pack.ps1 all     # 或 client / server
```

打包行为由 `pack.ps1` 保证，无需手工干预：

- **自动删除历史 zip**：只保留每个端最新那一个（`Remove-OldZip` 按前缀匹配，client 与 server 互不影响）。
- **自动剔除缓存与无用文件**：`node_modules`、`.expo`、`coverage`、`.eslintcache`、`.cache`、`.turbo`、`.parcel-cache`、`dist`/`web-build`/`build` 构建产物、`*.log`、`*.tsbuildinfo`、`.vscode`/`.idea`、OS 杂项（见 `pack.ps1` 的 `$ExcludeCommon`）。
- **出包后自检**：`Assert-NoJunk` 会扫描 zip 条目，一旦混入上述缓存/构建产物就**直接失败**，不会静默出包。

### 两个必须遵守的细节

1. **`pack.ps1` 必须存为 UTF-8 with BOM。** 本机 PowerShell 5.1 对无 BOM 的 UTF-8 脚本按 GB2312 解码，中文提示会变乱码、`throw` 的中文串也可能失真。用 edit/write 工具改完 `pack.ps1` 后要确认 BOM 还在：
   ```powershell
   $b = [System.IO.File]::ReadAllBytes("$PWD\pack.ps1"); '{0:X2} {1:X2} {2:X2}' -f $b[0],$b[1],$b[2]   # 期望 EF BB BF
   ```
   丢失时补回：
   ```powershell
   $p = "$PWD\pack.ps1"
   $t = [System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8)
   [System.IO.File]::WriteAllText($p, $t, (New-Object System.Text.UTF8Encoding($true)))
   ```
2. **服务端出包前会强制校验 dist 补丁**。`chinese-chess-server/dist/index.js` 是手工打补丁的构建产物（见 `chinese-chess-server/scripts/patch-dist.mjs`，现承载 **5 条**补丁）。补丁缺失时 `pack.ps1 server` 会阻塞并提示先执行 `node chinese-chess-server/scripts/patch-dist.mjs`。

### 已解决：中文文件名在 zip 里乱码

`chinese-chess-server/` 下原三个中文名文件（`安装开机自启.bat`、`卸载开机自启.bat`、`部署说明.txt`）在 zip 里会变成乱码文件名。原因是 Windows 自带 `tar.exe` 写 zip 时把文件名的 GBK 字节直接写入且**未置 UTF-8 标志位**（general purpose flag 的 0x800 位）。

已改为纯 ASCII 名，彻底规避：

| 原文件名 | 现文件名 |
| --- | --- |
| `安装开机自启.bat` | `install-autostart.bat` |
| `卸载开机自启.bat` | `uninstall-autostart.bat` |
| `部署说明.txt` | `DEPLOY.md` |

**约定：`chinese-chess-server/` 下不再新增中文文件名。** 该目录是给用户解压即用的部署包，文件名的可移植性优先；文档内容仍可用中文。

## 环境

本机 `node` / `pnpm` 都不在 PATH，需用 DSH 内置运行时：

- node = `C:\Users\hthot\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`
- pnpm = `...\dependencies\pnpm\bin\pnpm.mjs`（11.7.0，项目 `packageManager` 要求 9.0.0）

跑 pnpm 前必须把 node 的 bin 目录前置到 `$env:PATH`，否则 pnpm 内部 spawn `node` 会失败。

## 本地开发

```powershell
# 在 chinese-chess-client/ 下
pnpm -w dev:all      # 服务端 9091 + Expo web 5000
pnpm -w validate     # lint + verify:rules + verify:rule-engine-parity
```

`pnpm -w dev:all` 依赖 PATH 上有 `pnpm.cmd`；若没有，可分别直启：

```powershell
# 服务端（在仓库根）
$env:PORT=9091; $env:NODE_ENV='production'; node chinese-chess-server/scripts/start.mjs
# 客户端（在 chinese-chess-client/client）
$env:SERVER_PORT=9091; $env:EXPO_NO_DEPENDENCY_VALIDATION='1'; node node_modules/expo/bin/cli start --web --port 5000
```

Web 端 `/api/v1/*` 由 `chinese-chess-client/client/metro.config.js` 反代到 `SERVER_PORT` 指定的后端。
