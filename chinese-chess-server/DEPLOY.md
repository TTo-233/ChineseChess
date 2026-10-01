中国象棋服务端 - Windows 部署说明（Cloudflare Tunnel / 固定域名方案）
====================================
本包为【自包含部署包】：无需安装依赖、无需 pnpm install，只需 Node.js 即可运行。
打包时间：2026-09-21 10:05:23

【关于皮卡鱼】无需任何单独设置。
  皮卡鱼引擎、开局库、Worker 均已打包在本包 ai\ 目录，随 node dist\index.js 自动加载
  （2 轻量 + 2 大师共 4 实例 + 520 条开局库），不占额外端口、无需单独安装或配置。

一、环境要求
  - Node.js 20 及以上（建议 24）。官网 https://nodejs.org/ 下载 Windows 安装包。
  - 安装后在 cmd 执行  node -v  能看到版本号即成功。

二、目录结构（解压后）
  dist\index.js         服务端程序（自包含，已内置 express 等依赖）
  ai\                   皮卡鱼引擎 + 开局库 + Worker（必须与 dist 同级，勿删改/移动）
  start.bat             手动启动脚本（前台运行，便于调试）
  run-server.bat        后台守护脚本（崩溃自动重启 + 写日志，供开机自启调用）
  install-autostart.bat   一键注册“开机自动启动”（需管理员，强烈推荐）
  uninstall-autostart.bat 移除开机自启任务
  scripts\verify-lan-disconnect.cjs  断线恢复回归自检脚本（可选，见下方第九节最后一条）
  DEPLOY.md              本说明（原 部署说明.txt）

三、启动服务（本机手动 / 调试）
  方式1：双击 start.bat。
  方式2：在本目录打开 cmd，执行  node dist\index.js 。
  方式3（推荐）：执行  pnpm start  （等价于方式2，并额外做补丁校验，见下方红字警告）。
  默认端口 9091；如需修改：先执行  set PORT=8080  再  node dist\index.js 。
  本机自测：浏览器访问  http://localhost:9091/api/v1/health  返回 {"status":"ok"} 即本地正常。

  ============================ 红字警告 ============================
  【dist\index.js 是手工改动过的构建产物】
  本目录是自包含部署包：没有 src\、没有 tsconfig.json、没有 sourcemap。
  下面这些规则的实现都直接写在该文件里，由 scripts\patch-dist.mjs 注入（幂等补丁）：
    1) 长将长捉超限不拦截落子、不按违规次数判负
       丢失表现：客户端能走的着法被服务端以 400「禁着，请变招」拒绝。
    2) 畸形 FEN 行宽校验
       丢失表现：WASM 越界写内存，4 个引擎 worker 全崩、/ai/move 返回 500。
    3) 初始局面上传收紧（仅房内玩家、且仅在本局尚无着法时可上传）
       丢失表现：任何人只要知道 6 位房间号，就能匿名改写进行中的棋盘。
    4) 请求体驱动的终局副作用（与第 3 条同源，成对生效）
    5) 被拒绝的动作也回推权威状态
       丢失表现：被拒的动作客户端无感知，乐观更新会永久留在界面上。
    6) 房间名最小空缺优先（自动房间名复用被释放的编号）
       丢失表现：销毁「房间7」后新建会得到「房间9」，空号只增不减。

  每次重新构建 / 换版本 / 从其它机器拷贝 dist\index.js 覆盖之后，
  必须立刻执行：   node scripts\patch-dist.mjs
  该脚本会一次性补齐缺失的补丁（已存在的为 no-op 跳过）。

  只补第 1 条的标记（标记被单独剥离时用）：
                   node scripts\patch-dist.mjs --restore-marker

  这道闸门已挂在以下环节，任一条补丁丢失都会立刻以非零退出失败：
    启动服务   pnpm start                    启动前自动 --check，补丁丢失则拒绝启动
    打包服务端 pack.ps1 server / pack.sh server  出包前校验，失败则阻塞出包（不生成 zip）
    安装依赖   本目录下 pnpm install         postinstall 自动 --check，失败即安装失败
    单独校验   pnpm verify                   只做 --check
  用 node dist\index.js 或 start.bat 直接启动则不做校验，需自行确认。
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
  点“测试连接”显示连通/延迟即成功，保存后即可创建/加入房间并调用云端皮卡鱼。
  说明：人机对战的云端 AI 与在线对局使用同一服务器地址，均在此处配置。

七、可选环境变量（一般无需修改）
  PORT                     服务端口（默认 9091，需与 Cloudflare Tunnel 源地址端口一致）
  PIKAFISH_LIGHT_WORKERS   入门/进阶引擎实例数（默认 2）
  PIKAFISH_HEAVY_WORKERS   大师引擎实例数（默认 2）
  PIKAFISH_JOB_TIMEOUT_MS  单请求安全超时毫秒（默认 15000）
  示例：set PIKAFISH_HEAVY_WORKERS=3 && node dist\index.js
  注意：开机自启任务以 SYSTEM 运行，读取的是“系统级”环境变量；如需自定义 PORT，
     请在“系统属性→环境变量→系统变量”中设置，而非仅在当前窗口 set。

八、部署验证
  本机：  http://localhost:9091/api/v1/health   返回 {"status":"ok"}
  公网：  https://<固定域名>/api/v1/health   返回 {"status":"ok"}（cloudflared 服务运行时）
  引擎：  http://localhost:9091/api/v1/ai/stats  可看引擎池(2轻量+2大师)与开局库(520)。

九、常见问题
  - 端口被占用：提示 listen EADDRINUSE 时，改用其它 PORT（并同步改 Cloudflare Tunnel 源地址端口）。
  - 引擎未就绪：确认 ai\ 目录完整且与 dist 同级；重启服务即可。
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
    冻结导致心跳彻底中断，则按常规判定（10 秒无心跳判定断线 + 60 秒等待后判负）。
  - 断线恢复自检（可选）：在本目录执行  node scripts\verify-lan-disconnect.cjs
    会用虚拟时钟回归“后台节流不误判 / 保护窗口到期恢复判负 / 回前台撤销断线等待 /
    结束后房间不为后台玩家销毁”四项（默认端口 9099，可用 set VERIFY_PORT=xxxx 覆盖）。
