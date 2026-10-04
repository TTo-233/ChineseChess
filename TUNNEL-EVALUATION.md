# 隧道切换评估：SakuraFrp 替代 Cloudflare

> 评估日期：2026-10-05　测量机器：上海电信 `ip=183.222.255.242`
> **最终结论：可以换。子域绑定已成功，`ZeroSSL` 真实 CA 证书受信任，严格校验 15/15 全通过，完整对战端到端 166 ms。**

---

## 0. 最终选定地址

| 用途 | 地址 |
|---|---|
| **✅ 正式使用** | **`https://www-preview-api.u1103143.nyat.app:16526`** |
| 备用 | `https://chess.ttocnserver.dpdns.org`（Cloudflare，保留） |

子域绑定证书（严格校验读取）：
```
Subject : CN=*.u1103143.nyat.app
Issuer  : C=AT, O=ZeroSSL GmbH, CN=ZeroSSL RSA DV SSL CA 2
SAN     : DNS:*.u1103143.nyat.app, DNS:u1103143.nyat.app
有效期  : 2026-10-04 → 2027-01-02
authorized = true        ← 真实公共 CA 证书
```

进程演进记录：

| 阶段 | 地址 | 握手 p50 | ack p50 | 可见 p50 | 一次来回 |
|---|---|---|---|---|---|
| ① Cloudflare（现状） | `chess.ttocnserver.dpdns.org` | 1151 ms | 457 ms | 735 ms | ≥1200 ms |
| ② 自签隧道（不可用） | `frp-net.com:16526` | 207 ms | 82 ms | 77 ms | 159 ms |
| **③ 子域绑定（已定）** | **`www-preview-api.u1103143.nyat.app:16526`** | **217 ms** | **84 ms** | **82 ms** | **166 ms** |

②→③ 说明：换证书**没有损失任何延迟**，且从"必须放行自签"变成"标准 TLS 即可"。

---

## 1. 实测结果：新隧道 vs Cloudflare

### 1.0 子域绑定地址的严格校验结果（决定性证据）

全程**不设置 `rejectUnauthorized:false`**，与 React Native / 浏览器行为完全一致：

```
TLS 握手         : 628ms（首次，含 DNS + OCSP/CRL 拉取），后续 112–141ms
authorized       : true          ← 证书链校验通过
authError        : (无)
协议             : TLSv1.3
Subject          : CN=*.u1103143.nyat.app
Issuer           : C=AT, O=ZeroSSL GmbH, CN=ZeroSSL RSA DV SSL CA 2
SAN              : DNS:*.u1103143.nyat.app, DNS:u1103143.nyat.app
HTTP /health     : 200 {"status":"ok"}   x-powered-by: Express
WS /api/v1/lan/ws: 101 Switching Protocols  Sec-WebSocket-Accept: LhjOWpZ98GxWzQIu35C6/OlOVEg=
```

**15 次连续握手，15/15 全部 `101` 且 `authorized=true`。**

### 1.1 WebSocket 握手延迟

| 指标 | nyat.app 子域（严格校验，15 次） | Cloudflare（10 次） | 对比 |
|---|---|---|---|
| TLS 阶段 p50 | 131 ms | 451–793 ms | — |
| **握手总耗时 p50** | **217 ms** | 1151 ms | **快 5.3×** |
| 握手 p90 | 460 ms | 3923 ms | **快 8.5×** |
| 最差值 max | 536 ms | 3923 ms | — |
| **抖动（max−min）** | **346 ms** | 3044 ms | **抖动减少 8.8×** |
| 成功率 | **15/15（100%）** | 10/10 | — |

> 注：15 次里有 2 次 TLS 阶段偏慢（377 / 458 ms），把极差拉到 346 ms；但 p50 仅 131 ms。这属于偶发抖动，量级仍远优于 Cloudflare 的 3044 ms。

### 1.2 完整对战端到端（同一套着法序列，可直接对表）

指标定义沿用 `LATENCY-REPORT.md`：
- **A. move ack 往返** = 我发着法 → 服务端裁决 → 回执到达
- **B. 对手走子 → 本端屏幕可见** = 真实"对方已落子我看到"

| 指标 | nyat.app 子域 | Cloudflare 基线 | 改善 |
|---|---|---|---|
| WS 握手（甲 / 乙） | **199 / 218 ms** | 441 / 1604 ms | 7.4× |
| **A. move ack p50** | **84 ms**（samples 79–86） | 457 ms | **5.4×** |
| A. move ack p90 | 86 ms | 1763 ms | 20× |
| **B. 对手走子可见 p50** | **82 ms**（samples 76–84） | 735 ms | **9.0×** |
| B. 对手走子可见 p90 | 84 ms | 1733 ms | 20× |
| **C. 一次完整来回** | **166 ms** | ≥1200 ms | **7.2×** |

**这已经不是"优化"，是量级改善。** 166 ms 的来回延迟在象棋对战里属于"完全无感"的水平。

> 注意 B（对手落子可见）在本机测得 82 ms，理论上应约等于半个 RTT——因为探针与对手端在同一台机器上，跨机实测会更高。但**基线 735 ms 同样是在本机测的**，两者同口径，可直接对比。

---

## 2. 能力矩阵：新隧道能不能跑本项目的协议

| 能力 | 结果 | 证据 |
|---|---|---|
| WS 路径 `/api/v1/lan/ws` | ✅ | `101 Switching Protocols`，`Sec-WebSocket-Accept: LhjOWpZ98GxWzQIu35C6/OlOVEg=` |
| HTTP API `/api/v1/health` | ✅ `200` + `{"status":"ok"}` + `x-powered-by: Express` | 直达 Express，未被中间层改写 |
| 建房 / 加入 / 准备 / 选边 / 开局 | ✅ 全 200 | `roomId=362814`，`sideAssigned:true`，`start → alreadyStarted:true` |
| **严格 TLS 校验（等同 RN）** | ✅ **`authorized=true`，15/15** | ZeroSSL DV 证书，SAN 含 `*.u1103143.nyat.app` |
| 明文 HTTP（`http://`） | ❌ `501 Not Implemented` | 调度器只放行 TLS。**无害**——`normalizeServerUrl` 本就强制 https |
| 旧隧道的 SNI RST 问题 | ✅ 已消失 | 旧节点 `frp-art.com` 被 RST，新节点握手正常 |

WS 全流程（建房→加入→双 ready→选边→公示 3s→start→6 步交替着法→ack/state 帧）实测跑通，说明 frp 的转发对 WebSocket 升级与长连接无任何干扰。

---

## 3. 证书阻塞项：已解决

### 3.1 原问题（`frp-net.com:16526` 直连时的状态）

```
Subject/Issuer = CN=SakuraFrp Automatic TLS sn.229612682
SAN           = DNS:frp-net.com
有效期        = 2026-10-04 → 2027-10-04
```

Node 分离报告的失败原因：
- **主机名校验单独跑 → ✅ 通过**（`tls.checkServerIdentity('frp-net.com', cert)` 无异常）
- **证书链校验 → ❌ `DEPTH_ZERO_SELF_SIGNED_CERT`**

curl/schannel 会把两者合并报成 `SEC_E_WRONG_PRINCIPAL (0x80090322)`，所以之前看到的"主机名不匹配"其实是自签名导致的假象。

### 3.2 解法与实测结果

用户已在管理面板完成[子域绑定](https://doc.natfrp.com/bestpractice/domain-bind.html)，frpc 成功从服务端加载了**真实 CA 证书**：

```
已从服务器为 www-preview-api.u1103143.nyat.app 加载证书
→ CN=*.u1103143.nyat.app, Issuer=ZeroSSL RSA DV SSL CA 2, authorized=true
```

**§1.0 已用严格校验（等同 RN/浏览器）验证 15/15 全部通过。**

### 3.3 为什么这条路是正确的架构选择

项目是 **Expo / React Native 0.81.5**，29 处网络调用全部用原生 `fetch` + 原生 `new WebSocket`，**没有 `ws` 依赖**。这意味着：

- ❌ `rejectUnauthorized: false`、`httpsAgent`、`dispatcher` —— 这些全是 Node 专有开关，**在这个架构里没有落脚点**
- ✅ 真实 CA 证书是唯一"不需要任何 hack"的方案：RN 用系统信任链，证书受公共信任即可直接连
- ✅ `normalizeServerUrl`（`serverConfig.ts:56-68`）**不硬编码任何端口**，玩家可在 App 里手填服务器地址（`lanGame/index.tsx:711` 占位符 `https://服务器地址:端口`）。**换线路需要 0 行代码改动。**

---

## 4. 路线回顾（已选定 A）

### 路线 A：子域绑定拿免费真实 CA 证书 —— ✅ **已采用**

SakuraFrp 官方文档 [子域绑定](https://doc.natfrp.com/bestpractice/domain-bind.html) 明确写：

> SakuraFrp 为所有用户提供免费的 `nyat.app` 子域名和 SSL 证书

实际执行：隧道 `自动 HTTPS` 设为 `自动` → 申请子域 → 绑定到 `Tunnel/ChineseChess` → 重启 frpc。

**优点**：证书受公共信任，RN 直接能连；不需要动系统证书库；不需要自有域名；零代码改动。
**注意**：证书有效期至 **2027-01-02**，届时需确认 SakuraFrp 是否自动续签；nyat.app 子域已开 HSTS Preloading。

### 路线 B：把 SakuraFrp 自签证书装进系统信任库 —— ❌ 未采用

```powershell
openssl s_client -connect frp-net.com:16526 -servername frp-net.com </dev/null 2>$null | `
  openssl x509 -outform PEM > frp-net.com.crt
Import-Certificate -FilePath .\frp-net.com.crt -CertStoreLocation Cert:\CurrentUser\Root
```

**为什么不采用**：① 一年到期要重装；② **每台玩家的机器都要手动装**——对"把链接发给朋友下棋"的场景是硬伤；③ Android 7+ 应用默认不信任用户安装的 CA（需 `network_security_config`，Expo 要额外原生配置），iOS 也需手动信任。

> 用户此前尝试过一次 `Import-Certificate`，但导入的 `FrpcWorkingDirectory\frp-art.com.crt` **根本不存在**（`C:\ProgramData\SakuraFrpService` 下只有 `Logs/ Temp/ config.json config.json.bak`），证书从未真正进入信任库。

### 路线 C：换成 HTTP(S) 型隧道 + 自有域名 —— ⏸ 未采用

**优点**：SakuraFrp 侧支持 `force_https`、标准 80/443。
**缺点**：需要自有域名 + ICP 备案；HTTPS 隧道做反代会改写 Header，对 WS 需额外验证。子域绑定方案已达到同等效果，无需走这条。

---

## 5. 建议结论

**可以换了，现在就换。**

```
第一步（已完成）
  └─ 子域绑定 → 真实 CA 证书 → 严格校验 15/15 通过

第二步（客户端，零代码）
  └─ 在 App 的服务器地址栏填 https://www-preview-api.u1103143.nyat.app:16526
  └─ 保留 Cloudflare 地址作为备用，玩家可自行切换

之后留意
  ├─ 证书 2027-01-02 到期，确认 SakuraFrp 是否自动续签
  ├─ 若该节点线路不佳，可在管理面板换节点；本项目无任何代码改动成本
  └─ 跨机实测（两端在异地网络）会高于本机数字，建议找位朋友实测一次
```

**为什么不必做 `ServerProfile` / `pickProfile()` 自动回退**：自动回退会掩盖"线路已死"的事实——玩家以为在正常对战，实际悄悄走了 595 ms 的备用线路，延迟问题原封不动地回来了。App 里已有手填服务器地址的入口（`lanGame/index.tsx:711`），手动切换足够，且故障时玩家能立刻知道发生了什么。

---

## 6. 遗留风险与未验证项

| 项 | 状态 |
|---|---|
| 严格校验下 TLS / HTTP / WS 全通 | ✅ 已验证，15/15 |
| 子域绑定后的端到端对战延迟 | ✅ 已实测：ack p50 84 ms、可见 p50 82 ms、来回 166 ms |
| **跨机实测**（两端在异地网络） | ⬜ **未测**。本机探针两端同源，B（对手走子可见 82 ms）理论上限约半 RTT；异地实测会更高，但相对 Cloudflare 的优势应保持 |
| **真实玩家手机实测** | ⬜ **未测**。RN 的 TLS 行为与 Node 一致，但建议在真机上跑一局确认 |
| 证书有效期 | ⚠️ 至 **2027-01-02**，需确认自动续签 |
| 隧道长期稳定性 | ⚠️ 本机 `C:\ProgramData\SakuraFrpService` 无 frpc 进程/服务，隧道应在别处运行 |

## 附录：本次使用的探针脚本（只读，未改动生产代码）

`D:\Code\ChineseChess\.perf-probe\`
- `nyat-strict.mjs` — **严格校验**（不放行自签）下读取证书 Subject/Issuer/SAN、验证 `authorized=true`、HTTP + WS 连通性
- `nyat-game.mjs` — 完整对战端到端，严格校验，与报告基线同口径对表
- `nyat-stability.mjs` — 15 次握手抽样，输出 min/p50/p90/max/极差
- `frpnet-probe.mjs` — 明文 HTTP / TLS(有无 SNI) / 正常校验 / WS 升级，四象限探测
- `frpnet-tls.mjs` — 主机名校验与证书链校验**分开**报告（定位到"唯一问题是自签名"）
- `frpnet-ws.mjs` — 建房 + WS 升级，区分"握手失败"与"连接保持"
- `frpnet-latency.mjs` — 10 次握手对比，输出 min/p50/p90/max/极差
- `frpnet-game.mjs` — 自签隧道上的完整对战端到端