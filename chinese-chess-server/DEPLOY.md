中国象棋服务端 - Windows 部署说明（Cloudflare Tunnel / 固定域名方案）
====================================
本包为【自包含部署包】：无需安装依赖、无需 pnpm install，只需 Node.js 即可运行。
（仅当需要从源码重新构建 dist 时才要装依赖，见第三节「源码与构建」。）

【关于 AI / 皮卡鱼】本服务端**不包含**任何 AI 功能。
  2026-10 已完成「服务端去 AI 化」：皮卡鱼引擎、开局库、Worker（原 ai\ 目录）与
  /api/v1/ai/* 接口全部移除，本包内已无 ai\ 目录。
  人机对战的 AI 全部跑在**客户端本地**（本地皮卡鱼，离线可用，不经过本服务器）；
  本服务端只承载**在线对局**（房间、对局同步、权威裁决）。

一、环境要求
  - Node.js 20 及以上（建议 24）。官网 https://nodejs.org/ 下载 Windows 安装包。
  - 安装后在 cmd 执行  node -v  能看到版本号即成功。

二、目录结构（解压后）
  dist\index.js         服务端程序（运行期自包含，已内置 express 等依赖）
  src\                  服务端 TypeScript 源码（index.ts / routes\{lanGame,battleWs,actionOutcome}.ts）
  build.js, tsconfig.json   esbuild 构建脚本与 TS 配置（node build.js 重新生成 dist）
  ruleEngine.cjs        规则引擎（由客户端 ruleEngine.bundle.ts 打包而来，两端同源）
  start.bat             手动启动脚本（前台运行，便于调试）
  run-server.bat        后台守护脚本（崩溃自动重启 + 写日志，供开机自启调用）
  install-autostart.bat   一键注册“开机自动启动”（需管理员，强烈推荐）
  uninstall-autostart.bat 移除开机自启任务
  scripts\              回归自检与构建校验脚本（可选）
    verify-server-hardening.cjs   加固回归（见下方第九节最后一条）
    verify-lan-disconnect.cjs     断线恢复回归
    verify-action-outcome.cjs     动作结算（跨通道广播/4xx 回推）回归
    verify-server-diff.cjs        L2 行为差分：拿一份「旧产物」与当前 dist 对跑同一串请求比对响应
    verify-rule-engine-parity.mjs 规则引擎两端同源校验
  DEPLOY.md              本说明（原 部署说明.txt）

  注：verify-server-diff.cjs 需要额外两样东西，否则会**明确报错**（刻意 fail-closed）：
    1) 一份旧产物：`--old <path>`（该文件必须放在能解析 ../ruleEngine.cjs 的位置，
       即服务端目录内或与之同级；仓库不携带出厂基线，因为 .dsh-work/ 未入库）；
    2) 空闲端口：默认 old=9091 / new=9092，而 9091 正是本服务端自己的默认端口 ——
       若你的 dev server 正在跑，请显式换端口，例如
         node scripts\verify-server-diff.cjs --old <旧产物> --new dist\index.js --old-port 9401 --new-port 9402

三、启动服务（本机手动 / 调试）
  方式1：双击 start.bat。
  方式2：在本目录打开 cmd，执行  node dist\index.js 。
  方式3（推荐）：执行  pnpm start  （等价于方式2）。
  默认端口 9091；如需修改：先执行  set PORT=8080  再  node dist\index.js 。
  本机自测：浏览器访问  http://localhost:9091/api/v1/health  返回 {"status":"ok"} 即本地正常。

  ======================== 重要：源码与构建 ========================
  【dist\index.js 由 src\ 编译生成，不要再手工改产物】
  本目录同时带可读源码与构建脚本：
    src\index.ts、src\routes\{lanGame,battleWs}.ts、src\routes\actionOutcome.ts
    build.js（esbuild 构建 + 一致性校验）、tsconfig.json
  重新构建（需要依赖，本包不含 node_modules，先 pnpm install）：
    在本目录执行    node build.js
  校验产物与源码是否一致：
    在本目录执行    node build.js --check

  下列 5 条加固都写在 src\ 里（本包历史上前身是没有源码的 dist 手工补丁，
  现已在源码层面归位；改 src 后必须重新 node build.js）：
    1) 长将长捉「规则二强制变招」：达到阈值后再走超限着法即禁着并提示，且**不按违规次数判负**
       （客户端 lanBattle 先拦一层，服务端 getMoveBanReason 做权威裁决，两端共用同一份 ruleEngine.cjs）
       丢失表现：服务端不再拦截超限着法，绕过客户端直接 POST 就能继续长将/长捉。
       ⚠️ 本条语义曾调整：旧补丁是「超限**不拦截**落子」，commit 73d10ff 起改为「超限**禁着**」。
    2) 初始局面上传收紧（仅房内玩家、且仅在本局尚无着法时可上传）
       丢失表现：任何人只要知道 6 位房间号，就能匿名改写进行中的棋盘。
    3) 请求体驱动的终局副作用（与第 2 条同源，成对生效）
    4) 被拒绝的动作也回推权威状态
       丢失表现：被拒的动作客户端无感知，乐观更新会永久留在界面上。
    5) 房间名最小空缺优先（自动房间名复用被释放的编号）
       丢失表现：销毁「房间7」后新建会得到「房间9」，空号只增不减。

  [已移除 2026-10] 畸形 FEN 行宽校验：它只存在于已删除的 /api/v1/ai/move
    （防畸形 FEN 打崩 Pikafish WASM）；服务端现已无任何接收 FEN 的接口，守护对象消失，
    保留断言只会是假绿灯（详见 verify-server-hardening.cjs 头部说明）。

  dist 与 src 不一致时，以下环节会以非零退出失败（不会再出现“补丁丢了却照样出包”）：
    打包服务端 pack.ps1 server / pack.sh server  出包前 --check，失败则阻塞出包（不生成 zip）
    安装依赖   本目录下 pnpm install            postinstall 自动 node build.js
    单独校验   pnpm verify（后端）/ pnpm -w validate（前端）   只做 --check

  直接双击 start.bat 或执行 node dist\index.js 不做一致性校验；
  改动源码后请自行执行 node build.js 重新生成 dist\index.js。
  ===================================================================

四、开机自启与崩溃自愈（强烈推荐配置）
  背景：Windows 重启/断电/系统更新后，手动双击的 start.bat 不会自动恢复，服务端会离线。
  本方案使用系统自带“任务计划程序”，无需额外安装任何软件：
  1. 右键 install-autostart.bat → 以管理员身份运行。它会创建计划任务 ChessServerAutoStart：
     开机时（无需登录桌面）自动运行 run-server.bat。
  2. run-server.bat 为守护脚本：node 进程若异常退出，会在 5 秒后自动重新拉起，
     并把运行日志写入同目录 server-watchdog.log，便于排查。
  3. 验证：重启电脑后访问  http://localhost:9091/api/v1/health  应返回 {"status":"ok"}；
     或执行  schtasks /Query /TN "ChessServerAutoStart"  查看任务状态。
  4. 取消：右键 uninstall-autostart.bat → 以管理员身份运行。
  进阶（可选，长期稳定部署）：改用 Windows 服务方式（登录前即启动、失败自动重启更完善），
     用 NSSM（https://nssm.cc/ 下载）：
       nssm install ChessServer "C:\path\to\node.exe" "C:\path\to\dist\index.js"
       nssm set ChessServer AppDirectory "C:\path\to"
       nssm start ChessServer

五、Cloudflare Tunnel（固定域名）配置 —— 让不同网络的手机能连上
  原理：服务端只在本机监听 9091，cloudflared 连接器把 http://localhost:9091 经 Cloudflare
  隧道映射为绑定固定域名的公网 HTTPS 地址（证书由 Cloudflare 签发）。无需公网 IP、无需端口映射。
  1. 到 Cloudflare Zero Trust 控制台（one.dash.cloudflare.com）→ Networks → Tunnels，
     创建一条隧道（连接器选 Cloudflared），记下安装令牌（token）。
  2. 在 Windows 服务器上安装连接器（管理员 PowerShell）：
       cloudflared.exe service install <你的token>
     这会把 cloudflared 注册为 Windows 服务，开机自动启动。
  3. 在隧道的 Public Hostname 添加固定域名（如 chess.example.com），
     Service 类型选 HTTP，URL 填 localhost:9091。
  4. 保持 cloudflared 服务运行（服务停止则客户端无法连接）。
  【重要】cloudflared 以 Windows 服务方式安装后本身即开机自启；配合第四节的“install-autostart.bat”，
     重启后「服务端 + 隧道」都会自动恢复，无需人工干预。

六、客户端对接（运行时可配置，无需重新打包客户端）
  打开 App → 在线对局大厅 → “服务器设置”，填入第五节的固定域名
  （例如  chess.example.com，可不带协议，App 会自动补全为 https），
   点“测试连接”显示连通/延迟即成功，保存后即可创建/加入房间、进行在线对局。
   说明：人机对战的 AI 现在跑在客户端本地（离线可用），不经过本服务器；
   本服务器只用于在线对局的房间、同步与权威裁决，服务器地址在此处配置即可。

七、可选环境变量（一般无需修改）
  PORT                     服务端口（默认 9091，需与 Cloudflare Tunnel 源地址端口一致）
  （2026-10 去 AI 化后，原 PIKAFISH_LIGHT_WORKERS / PIKAFISH_HEAVY_WORKERS /
   PIKAFISH_JOB_TIMEOUT_MS 三个引擎池变量已随服务端 AI 一并移除，设置它们不再有任何效果。）
  注意：开机自启任务以 SYSTEM 运行，读取的是“系统级”环境变量；如需自定义 PORT，
     请在“系统属性→环境变量→系统变量”中设置，而非仅在当前窗口 set。

八、部署验证
  本机：  http://localhost:9091/api/v1/health   返回 {"status":"ok"}
  公网：  https://<固定域名>/api/v1/health   返回 {"status":"ok"}（cloudflared 服务运行时）

九、常见问题
  - 端口被占用：提示 listen EADDRINUSE 时，改用其它 PORT（并同步改 Cloudflare Tunnel 源地址端口）。
  - （已移除）原“引擎未就绪”条目：服务端不再有 AI 引擎池；人机 AI 由客户端本地承担。
  - 客户端连不上：确认 cloudflared 服务在运行、客户端“服务器设置”填的是固定域名。
  - 域名访问异常：检查 Cloudflare Tunnel 的 Public Hostname（DNS 路由）是否正确指向该域名。
  - 服务端电脑与 cloudflared 连接器需保持开机在线，客户端才能连接。
  - 重启后服务端没起来：确认已运行“install-autostart.bat”；查看同目录 server-watchdog.log；
    确认 node 已安装并加入“系统级”PATH（任务以 SYSTEM 运行）。
  - 重启后服务端正常但客户端仍连不上：多半是 cloudflared 连接器没随开机启动，
    确认已执行  cloudflared service install，见第五节。
  - 常驻建议：优先用第四节的开机自启/服务方案；pm2 在 Windows 下不支持开机自启，
    不建议作为唯一手段。
  - 切到后台 / 换到别的标签页会不会被判负：不会立刻判负。浏览器会节流隐藏页面的定时器
    （心跳最长约 1 分钟一次，甚至冻结页面），客户端在切后台的瞬间会上报“我在后台”，
    服务端对这类玩家放宽判定：最近仍有心跳（宽容窗口 90 秒）且单次连续后台不超过 3 分钟时
    不判断线；回到前台立即补发心跳并重连，会立刻撤销断线等待。超过 3 分钟上限、或页面被
    冻结导致心跳彻底中断，则按常规判定（30 秒无心跳判定断线 + 60 秒等待后判负）。
    注：心跳阈值原为 10 秒，2026-10 放宽到 30 秒（客户端心跳周期同步放宽到 8 秒），
    以免切后台即被误判断线；判定"真断线"因此最多慢 20 秒，对休闲棋局可接受。
  - 断线恢复自检（可选）：在本目录执行  node scripts\verify-lan-disconnect.cjs
    会用虚拟时钟回归“后台节流不误判 / 保护窗口到期恢复判负 / 回前台撤销断线等待 /
    结束后房间不为后台玩家销毁 / 对局中主动离场立即裁定 / 等待阶段离场保持原语义”，
    共 25 项断言（默认端口 9099，可用 set VERIFY_PORT=xxxx 覆盖）。
  - 加固自检（可选）：在本目录执行  node scripts\verify-server-hardening.cjs
    会回归服务端权威走子、会话凭证鉴权（含房间密码仅房主可见、多字节 token 不得打崩鉴权）、
    悔棋服务端快照、旧协议下线、房间名最小空缺、长将长捉规则二禁着等场景，
    共 57 项断言（默认端口 9101，可用 set VERIFY_PORT=xxxx 覆盖）。两个自检脚本都直接
    用本目录的 dist\index.js 起进程，跑完自动退出，不会影响正在运行的服务。
