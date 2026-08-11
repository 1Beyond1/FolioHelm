# FolioHelm：Luna Max 完整续作交接书 v1

更新时间：2026-08-10 00:54（Asia/Shanghai）

这份文件是后续 Luna Max 的第一入口。目标是让能力较低、成本较低的模型在不重新猜测产品方向的情况下，继续完成明确、机械、可验证的工作；同时把可能造成经济损失的功能隔离在硬性门槛之后。

## 0. 给 Luna 的第一条指令

把下面整段原样交给 Luna：

~~~text
你正在继续 `<repo-root>` 项目。先完整阅读：
1. docs/luna-handoff-v1.md
2. docs/user-decisions-v1.md
3. docs/implementation-plan-v2.md
4. docs/schwab-api-capability-matrix-v1.md
5. docs/architecture-decisions/ADR-0001-dual-evidence-journal.md
6. docs/security/evidence-threat-model-v1.md

先做只读检查，不要立刻重构：
- 确认 cwd 是 `<repo-root>`。
- 用 rg --files 查看结构；不要广泛扫描 `<user-profile>`。
- 运行 npm test、npm run build、cargo fmt --check、cargo test --locked、cargo clippy --locked --all-targets --all-features -- -D warnings。
- 检查 src-tauri\target\release\foliohelm.exe 是否存在。
- 汇报实际结果、失败命令和当前文件状态。

当前阶段只允许 Mock 数据和本地 UI；禁止连接 Schwab、禁止加入真实 Token、禁止实现或调用 Place/Cancel/Replace、禁止放宽 CSP/Capability、禁止自动重试写请求、禁止添加遥测或远端上传。

完成基线检查后，按本交接书“FH-LUNA-101”开始。一次只完成一个工作包。每个工作包完成后必须运行指定测试并汇报修改文件、测试结果、未解决问题。不要自行跨到下一个高风险阶段。
~~~

## 1. 产品目标与已经确认的方向

FolioHelm 是一个非官方、开源、本地优先的 Charles Schwab Windows 桌面客户端。用户未来自行申请 Schwab Developer App，自行在本机连接；项目不提供共享 API、不托管 Token、不托管账户或交易正文。

已经确认：

- 平台先做 Windows。
- 技术栈是 Tauri 2 + React + TypeScript + Rust。
- UI 是黑色/深灰背景、白色信息层级、neon lime 点缀、简约高级、偏 OKX 的信息密度和节奏，但不复制商标或具体素材。
- 首次启动跟随 Windows 系统语言；未支持语言回退 English；内置 English/简体中文。
- Apache-2.0。
- 当前不购买 Authenticode；公开构建必须明确 unsigned，并提供 SHA-256、构建记录、SBOM/Attestation（后续）。
- 未来允许研究自动策略、定时和无人值守，但绝不能为了“功能多”绕过安全、API 限流或条款。
- 无法承诺“绝对不出错”。目标是失败关闭、限制最坏损失、保留可核对证据。

## 2. 当前真实状态

当前不是只有主页。已经完成一套可交互 Mock 终端，但没有真实 Schwab 能力。

已实现页面和链路：

| Route | 页面 | 当前能力 |
| --- | --- | --- |
| `home` | 首页 | 组合总值、区间图、快捷入口、持仓、近期活动、年度活动/每日收益热力图 |
| `markets` | 市场 | 虚构指数、搜索过滤、自选列表、涨跌榜、进入个股和交易 |
| `instrument` | 个股 | 虚构报价、周期图、持仓摘要、关键统计、虚构背景卡、进入模拟交易 |
| `portfolio` | 投资组合 | 总权益/今日/现金/购买力、配置环、收益曲线、可排序持仓 |
| `orders` | 订单 | Working/Filled/Canceled/Rejected/Unknown、搜索、展开时间线 |
| `trade` | 交易窗口 | 从首页、市场、个股、组合或订单打开 Ticket → Safety check → Mock preview → Demo receipt；底层页面保留，纯内存模拟 |
| `settings` | 设置 | 离线连接说明、语言、安全开关和高风险关闭门槛 |

已经实际验收的交互：

- 顶部导航可进入市场、投资组合、订单、交易、设置。
- `Ctrl+K` 打开全局搜索；输入 AAPL 可进入苹果个股页。
- 模拟交易填写 AAPL 数量 2，可走完四步并得到 `DEMO-RECEIPT-AAPL-MARKET-2`，金额 US$364.80。
- 高风险保护“最大订单金额”默认开启；关闭时弹出阻塞式对话框，要求阅读到底、等待 8 秒、输入 `DISABLE`、勾选风险确认；确认按钮此前禁用。
- 当前 UI 明确展示“演示数据、未连接券商、真实交易已锁定、没有券商写入能力”。
- 交易页面没有 `Submit order`，只有 `Simulate order / 模拟订单`。
- 交易工作区现在是统一风格的模态窗口；关闭按钮、遮罩点击和 `Esc` 都只关闭窗口并回到打开前的页面，不会清空底层页面。
- 首页组合图和个股价格图均支持悬浮定位、显示悬浮处的值/价格，以及使用非被动 wheel listener 连续调整时间跨度；滚轮不会继续滚动整页。
- 顶部焦点框和交易步骤条多余滚动条已修复。

当前自动测试：

- 前端：5 个测试文件，27/27 通过。
- Rust evidence 模块：此前 11 个测试通过；Luna 必须重新运行确认，不可只相信本文件。
- 最近一次 `npm run build` 成功。

当前 Release：

- 路径：`<repo-root>\src-tauri\target\release\foliohelm.exe`
- 大小：8,679,936 bytes
- 构建时间：2026-08-10 00:52:07
- SHA-256：`06CE2019D66A76CA4A8C7760E2B340E21EBF52B55C2033F2179277E98F13B1DF`
- `FH-LUNA-101` 已通过：停止 Vite 后，使用 `npm run desktop:build` 生成的 Release 能显示完整首页，1420 端口为空，进程检查时没有 TCP 连接。
- 重要构建规则：禁止把裸 `cargo build --release` 生成的 EXE 当作可发布桌面程序；它不会执行 Tauri CLI 的前端打包流程，可能残留 `devUrl`。必须先设置 Cargo PATH，再运行 `npm run desktop:build`。
- 原生窗口的 Computer Use 状态抓取曾报 `node_repl exec context not found`，后来使用窗口句柄截图确认首页正常显示；不要使用过期窗口句柄。
- 当前 Vite 开发服务器曾在 PID 41428、`127.0.0.1:1420` 运行。PID 会变化，操作前必须重新按端口和命令行核验，不能盲杀进程。

项目当前不是 Git 仓库（`git status` 返回 not a git repository）。初始化 Git、建立 GitHub 仓库和发布均属于后续明确工作，不能误以为已有历史可回滚。

## 3. 当前关键文件

### 3.1 前端外壳

- `src/App.tsx`：页面状态和 route switch；全局 Ctrl+K；所有页面集成点。
- `src/navigation.ts`：`AppRoute`、`NavigationState`、一级导航映射。
- `src/i18n.ts`：首页/外壳中英文文案与系统语言检测。
- `src/styles.css`：全局扩展样式、导航、搜索、安全状态、热力图负收益颜色。
- `design-preview/styles.css`：最初批准的主页设计系统和大量基础 CSS；修改时谨慎，影响范围很大。
- `src/components/AppShell.tsx`：TopBar、SystemStatusBar、Footer 和内容区域。
- `src/components/TopBar.tsx`：主导航、搜索、账户、语言和设置入口。
- `src/components/SearchPalette.tsx`：纯本地全局证券搜索。
- `src/components/SystemStatusBar.tsx`：Broker/Market/Trading 能力状态。

### 3.2 功能页面

- `src/features/markets/MarketsPage.tsx`
- `src/features/markets/InstrumentPage.tsx`
- `src/features/markets/marketsData.ts`
- `src/features/markets/markets.css`
- `src/features/portfolio/PortfolioPage.tsx`
- `src/features/portfolio/portfolio.css`
- `src/features/orders/OrdersPage.tsx`
- `src/features/orders/orders.css`
- `src/features/trade/TradePage.tsx`
- `src/features/trade/TradePage.css`
- `src/features/settings/SettingsPage.tsx`
- `src/features/settings/SettingsPage.css`

### 3.3 Mock 与主页

- `src/mocks/portfolio.ts`：主页虚构组合数据。
- `src/components/PortfolioHero.tsx`
- `src/components/InvestingHeatmap.tsx`
- `src/components/PositionsCard.tsx`
- `src/components/ActivityCard.tsx`
- `src/components/PortfolioChart.tsx`

### 3.4 测试

- `tests/frontend/App.test.tsx`：主页和语言等基础行为。
- `tests/frontend/AppNavigation.test.tsx`：完整 App 导航、搜索到 AAPL。
- `tests/frontend/Markets.test.tsx`
- `tests/frontend/PortfolioOrders.test.tsx`
- `tests/frontend/TradeSettings.test.tsx`

### 3.5 Tauri/Rust

- `src-tauri/tauri.conf.json`：窗口、CSP、开发 URL、前端产物路径。不要随意放宽。
- `src-tauri/capabilities/main.json`：当前主窗口能力。增加权限前必须单独审查。
- `src-tauri/src/lib.rs`：当前 Tauri Builder，没有命令、网络、文件或凭据接口。
- `src-tauri/src/evidence/mod.rs`：证据哈希链、Ed25519 设备签名、公证 Commitment/Receipt、测试。
- `src-tauri/build.rs`：为当前无正式图标的构建生成最小占位 ICO 和 Tauri context。
- `src-tauri/Cargo.toml`、`Cargo.lock`：Rust 依赖已精确固定。

## 4. 永远不能被低级任务顺手破坏的安全不变量

这些规则高于“编译通过”和“界面好看”。Luna 遇到冲突必须停下汇报。

1. 当前 Mock Profile 不得拥有任何 Schwab 网络访问和真实写入命令。
2. 浏览器/React 前端永远不得读取 App Secret、Access Token、Refresh Token、Authorization Code、SQLCipher Key 或完整账号。
3. Secret 不得进入日志、测试输出、截图、Fixture、Git、Crash Report 或诊断包。
4. 真实 Place/Cancel/Replace 不允许自动重试，429 也不例外。
5. 写请求超时或响应不明确时进入 `Unknown`；先按 Broker 权威记录对账，期间禁止重下。
6. 金额、价格、数量不能使用 JS `number` 或 Rust `f64` 作为真实交易领域值；后续必须采用 decimal/newtype，并锁定序列化规则。
7. 账户、Symbol、方向、数量、价格、Preview、Nonce 任一变化都必须使旧确认失效。
8. 只有独立 `trade-confirmation` 窗口才可最终提交；主窗口不能拥有 submit 权限。
9. Preview 不是成交保证；必须有新鲜度和一次性 Nonce。
10. 可配置保护默认开启；关闭保护立即锁定会话并作废已有 Preview。
11. 核心保护不可关闭：预览新鲜度、写请求不重试、Unknown 对账、凭据隔离、账户一致、精确小数、一次性 Nonce、独立确认窗口。
12. 公证端只接收不可逆 Commitment，不接收账户、Token、订单正文、Symbol、方向、数量、价格、Order ID、余额或持仓。
13. 不新增遥测、Analytics、广告、远端日志或自动上传。
14. 不抓 Schwab 网页，不使用 Schwab Logo，不声称获得 Schwab 背书。
15. 用户资金的人工真实测试只能由用户本人明确确认、小额、Limit Order、正常交易时段执行；自动化测试绝不能触发真实订单。

## 5. 标准验证命令

所有命令在 `<repo-root>` 的 PowerShell 执行。

~~~powershell
npm test
npm run build

$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --manifest-path src-tauri/Cargo.toml --locked
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets --all-features -- -D warnings
cargo build --manifest-path src-tauri/Cargo.toml --release --locked
~~~

依赖安全检查（工具存在时运行；没有就报告，不要悄悄安装未知脚本）：

~~~powershell
npm audit --omit=dev
cargo audit --file src-tauri/Cargo.lock
~~~

源代码安全扫描：

~~~powershell
rg -n "fetch\(|axios|XMLHttpRequest|WebSocket|localStorage|sessionStorage|indexedDB|invoke\(" src src-tauri
rg -n -i "submit order|place order|live order|real order" src tests
rg -n -i "access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|app[_ -]?secret|authorization code" src tests docs
~~~

说明：文档中出现安全术语不等于泄露；检查重点是硬编码值、日志和前端传递。

## 6. 进程安全操作规则

不要因为 `ERR_CONNECTION_REFUSED` 就乱杀全部 Node 或 WebView 进程。

开发版 debug EXE 使用 `devUrl=http://127.0.0.1:1420`，必须有 Vite；Release 应嵌入 `dist`，不应依赖 Vite。

核验 1420：

~~~powershell
$listener = Get-NetTCPConnection -LocalPort 1420 -State Listen -ErrorAction SilentlyContinue
$listener | Select-Object LocalAddress,LocalPort,OwningProcess
if ($listener) {
  Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" |
    Select-Object ProcessId,Name,ExecutablePath,CommandLine
}
~~~

只有命令行明确属于 `<repo-root>\node_modules\...\vite` 时，才可以：

~~~powershell
Stop-Process -Id <已核验 PID>
~~~

查 FolioHelm：

~~~powershell
Get-CimInstance Win32_Process -Filter "Name='foliohelm.exe'" |
  Select-Object ProcessId,ExecutablePath,CommandLine
~~~

只停止路径明确位于 `<repo-root>\src-tauri\target\debug` 或 `release` 的进程。禁止 `Stop-Process -Name node -Force` 这种宽泛操作。

## 7. 工作包 FH-LUNA-101：独立 Release 启动验收

目标：证明用户不会再次看到 `ERR_CONNECTION_REFUSED`。

允许修改：原则上不修改源码；只有发现 Release 仍指向 devUrl 才能提出修复，先汇报原因。

步骤：

1. 运行完整标准验证命令。
2. 重新构建 Release。
3. 按第 6 节精确识别并停止 FolioHelm 开发 Vite 进程；不要停止其他 Node。
4. 确认 `http://127.0.0.1:1420` 已不可访问。
5. 启动 `<repo-root>\src-tauri\target\release\foliohelm.exe`。
6. 等待窗口可响应，确认标题为 FolioHelm。
7. 在不启动 Vite 的情况下人工点击：首页 → 市场 → AAPL → 交易；首页 → 投资组合；订单；设置。
8. 关闭保护只检查弹窗，不实际关闭。
9. 模拟下单可走到 Demo receipt；确认没有网络请求和真实写能力。
10. 记录新的 EXE 大小与 SHA-256。
11. 将窗口留给用户查看；不要擅自发布。

验收：

- Vite 未监听 1420，Release 仍能显示完整 UI。
- 六个页面和搜索、模拟交易可用。
- 无 `ERR_CONNECTION_REFUSED`。
- 无外部网络请求。

最终报告格式：

~~~text
FH-LUNA-101 完成/失败
修改文件：无 / 列表
前端测试：x/x
Rust 测试：x/x
独立启动：通过/失败
EXE：绝对路径
SHA-256：...
发现的问题：...
窗口是否留给用户：是/否
~~~

## 8. 工作包 FH-LUNA-102：Mock 产品补全与设计收口

目标：把当前可交互 Mock 从“页面齐全”提升到“可公开体验”，仍然不接 Schwab。

优先顺序：

1. 为所有页面补 Loading / Empty / Error / Offline / Reauth-required 的纯 Mock 状态切换器；状态入口只在开发/演示模式显示。
2. 统一页面标题、间距、卡片半径、表格行高、按钮层级、tooltip 和焦点样式。
3. 补 1280×800、1440×900、1440×1024 的截图验收。
4. 完成亮色主题 Token；不要复制两套 DOM，使用 CSS variables/主题属性切换。
5. 设置页加入 Theme: System / Dark / Light；首次跟随 Windows，用户覆盖值只做纯本地非敏感设置。
6. 补键盘导航、focus-visible、对比度和“不只用颜色表示盈亏”。
7. 首页热力图保持 Activity / Daily return 切换。正收益 lime；负收益使用克制的 muted berry/magenta，不用刺眼纯红；零收益灰色；Tooltip 同时给出 `+/-` 文本。
8. 统一英文公开截图文案，中文仍完整可用。

建议允许修改：`src/components/**`、`src/features/**`、`src/styles.css`、`src/i18n.ts`、`tests/frontend/**`。不要动 Rust、Tauri capability 或 CSP。

验收：

- 每个页面五类状态至少有组件测试。
- 22 个已有测试继续通过。
- 新增主题和状态测试。
- 无网络 API、Tauri invoke、localStorage 中的敏感信息。
- 视觉与已批准的首页设计语言一致。

## 9. 工作包 FH-LUNA-103：建立统一 Mock Broker 边界

目标：把散落在页面里的虚构数据迁移为统一、可替换、类型化的 Mock Broker；不连接真实网络。

先定义接口，再迁移页面。建议目录：

~~~text
src/contracts/
  broker.ts
  account.ts
  market.ts
  orders.ts
src/mocks/broker/
  MockBroker.ts
  fixtures/
  scenarios.ts
~~~

建议接口只读/模拟：

~~~ts
interface BrokerReader {
  getAccounts(): Promise<AccountSummary[]>;
  getPositions(accountId: LocalAccountId): Promise<Position[]>;
  getQuotes(symbols: Symbol[]): Promise<QuoteSnapshot[]>;
  getPriceHistory(request: PriceHistoryRequest): Promise<PriceBar[]>;
  getOrders(query: OrderQuery): Promise<OrderView[]>;
  getTransactions(query: TransactionQuery): Promise<TransactionView[]>;
}

interface MockOrderSimulator {
  preview(draft: MockOrderDraft): Promise<MockPreview>;
  simulate(previewId: MockPreviewId): Promise<MockReceipt>;
}
~~~

禁止现在创建 `placeOrder`、`cancelOrder`、`replaceOrder` 真实接口；真实写接口必须在单独 crate/module 和能力 profile 中设计。

要求：

- 每个 Fixture 明确 `fictional: true`。
- 提供 normal/empty/offline/stale/error/unknown 五类 scenario。
- React 页面通过 Provider/hook 消费，不直接 import 大块数据常量。
- 不引入 Redux 等重依赖；React Context + reducer/query state 足够时保持简单。
- 测试必须可注入固定时钟和固定 scenario，避免随机 flaky。

## 10. 工作包 FH-LUNA-104：Mock 发布工程

目标：准备 GitHub 上可公开体验的 Mock-only 源码和 unsigned Windows 构建，但不发布，先把产物准备好供用户确认。

步骤：

1. 初始化 Git 前先向用户说明“当前不是 Git 仓库”，确认是否在现有目录 `git init`。
2. `.gitignore` 必须排除 `node_modules/`、`dist/`、`src-tauri/target/`、`.env*`、日志、临时截图、任何 credential/token 文件。
3. README 说明 Mock-only、虚构数据、非官方、无投资建议、无 Schwab 连接、unsigned build。
4. 添加 `SECURITY.md`、`CONTRIBUTING.md`、`PRIVACY.md`、`THREAT_MODEL.md` 索引。
5. 添加 GitHub Actions：`npm ci`、前端测试/构建、Rust fmt/test/clippy、锁文件检查。
6. Actions 使用最小权限并固定第三方 Action commit SHA；不要使用浮动 `@main`。
7. 生成 SHA-256、CycloneDX/SPDX SBOM、构建日志和 Artifact Attestation 方案。
8. 不启用自动更新，不创建远端 Release，不推送 GitHub，除非用户明确授权这一次远端写入。

注意：Git init 是本地可逆性/历史的重要步骤，但远端建库、push、release 是独立外部写操作，不能从“开源项目”自动推断为已授权。

## 11. Schwab 连接前的 Phase 0：只能核验，不能猜

在用户的 Developer App 获批并提供登录后官方文档之前，不实现真实 Schwab 网络层。

必须从当前官方 Developer Portal 或 Schwab 书面回复确认：

- Individual/Commercial 对“开源、本地运行、每位用户自带 App”的当前分类。
- OAuth callback、是否 PKCE、Access/Refresh 生命周期、轮换、撤销、重授权。
- 全部只读端点、Schema、错误结构、分页、时间窗口。
- Quote 批量上限、Streaming 连接/订阅上限、heartbeat、sequence、重连。
- 市场数据 entitlement、延迟标记、缓存、截图、再分发限制。
- Preview 当前端点、响应、费用/警告/拒绝、有效期、是否计入订单限额。
- Place/Cancel/Replace 的订单桶限额、HTTP 状态、Order ID、未知结果语义。
- 自动策略、定时、无人值守、高频是否允许。

归档只能保存脱敏后的字段和结论，不能把用户 Token/App Secret 放进文档或对话。

## 12. 工作包 FH-LUNA-201：Windows Credential Manager Spike

这是高风险基础设施。Luna 可以做 Spike 和测试，但不得把它直接接入真实交易。

要求：

- Secret 只由 Rust 接收并写 Windows Credential Manager。
- 前端只拿到 `connected/disconnected/reauth-required` 等状态，不拿 Secret。
- Secret 使用 `secrecy`/零化边界，Debug 不输出。
- 删除/替换凭据需要明确用户动作。
- 日志测试扫描 Token 模式。
- 不允许 Secret 落入 SQLite、localStorage、配置 JSON 或 URL query。
- 失败时保持断开和只读，不回退明文文件。

阻断：如果 Credential Manager 不可用，不得启用真实连接。

## 13. 工作包 FH-LUNA-202：SQLCipher Spike

也是高风险基础设施。必须先冻结 Schema 和密钥流程。

本地数据库未来保存：非敏感设置、账户别名、本地 ID、行情缓存、订单/流水视图、收益快照、完整证据 Journal。Token/Secret 不在数据库。

要求：

- SQLCipher key 随机生成，只存 Credential Manager。
- 数据库不能被普通 SQLite 打开。
- migration 可事务回滚、版本化、可备份恢复。
- Busy、磁盘写满、损坏、密钥丢失、升级中断都有测试。
- 证据 Journal append-only；修改、删除、重排可被 Hash Chain + Ed25519 检测。
- 不允许“加密失败就明文继续”。

## 14. 工作包 FH-LUNA-301：只读 Schwab Profile

只有 Phase 0 官方契约核验和分发分类通过后开始。

构建 Profile 必须物理隔离：

- `mock`：无 Schwab 网络，无 Secret 输入，无写命令。
- `readonly`：OAuth、账户、持仓、行情、订单、流水；编译时没有 Place/Cancel/Replace。
- `preview`：增加 Preview；没有最终 submit。
- `trading-experimental`：最后增加受限 Limit Place/Cancel。

只读刷新预算以官方限额为上限，并采用更保守本地预算：

- Streaming 用于 UI 行情和账户活动，集中单连接、订阅去重。
- Quotes REST 兜底前台约 15 秒、后台停止。
- 账户/持仓正常 60 秒、交易确认期 15 秒、后台 5 分钟。
- Working 订单 Account Activity + 15 秒兜底。
- Unknown 5 秒对账最多 2 分钟，之后降频但保持锁定。
- 搜索至少 2 字符、350ms debounce、取消旧请求。
- 429 读请求可按官方 Retry-After/退避；写请求永不自动重试。

任何字段 unknown/stale：页面仍显示可信数据和原因，但对应交易动作关闭，这就是“不确定就只读”。

## 15. 工作包 FH-LUNA-401：收益引擎

真实收益不能从当前 Mock 图里直接照抄。必须区分投资表现与外部现金流。

实现前冻结：

- Daily Performance 公式和时区/交易日边界。
- Deposit/Withdrawal/ACH/Wire/Journal/Dividend/Interest/Trade 的分类。
- 公司行动、拆股、转仓、缺失历史和最近 60 天 API 限制。
- Modified Dietz 或其他期间收益公式与测试向量。
- `estimated/incomplete/reconciled` 数据质量标签。

热力图：

- Activity 模式按操作次数/事件强度。
- Daily return 模式按收益分位数；lime 正、muted berry 负、gray 零/未知。
- 每个格子必须有日期、数值、数据质量和文字符号，不能只看颜色。

## 16. 工作包 FH-LUNA-501：Preview-only

只在官方 Preview 契约确认后。

要求：

- Draft 使用 Decimal/newtype；规范化后计算 Draft Hash。
- 本地 TradingPolicy 校验账户白名单、数量、金额、每日金额、限价偏离、时段、持仓。
- Broker Preview 与 Draft Hash、账户、报价时间绑定。
- Preview 有明确过期时间；任何字段/账户/行情权限变化使其失效。
- 一次性 Confirmation Nonce 即使在 Preview-only 也先建模和测试。
- UI 仍写 Preview，不伪装成已提交。
- Profile 编译时没有 Place/Cancel/Replace。

## 17. 工作包 FH-LUNA-601：实验性真实交易硬门槛

这部分不应该由 Luna 在无人审查下直接完成。Luna 可根据锁定规格写小模块和测试，但以下内容必须由高能力模型/独立安全人员逐行审查：

- Tauri 权限和独立确认窗口。
- OAuth/凭据和 SQLCipher key 流程。
- Decimal/newtype 与订单序列化。
- TradingPolicy。
- OrderOrchestrator 和状态机。
- Place/Cancel/Replace。
- Unknown 对账与崩溃恢复。
- Journal、公证 Commitment、日志脱敏。

首个真实范围：

- 股票/ETF。
- Regular Session。
- 手动 Limit Buy，以及卖出已有多头。
- Place 和 Cancel；Replace 延后。
- Market 只能 Preview。
- 每账户同时最多一个写请求在途。
- 本地默认最多 12 次写动作/分钟，且还必须取官方/应用配额的更小值。
- 自动化、高频、期权、卖空、主动保证金、扩展时段均不在首版。

发布阻断条件详见 `implementation-plan-v2.md` 第 23 节。任何一项不通过，不发布真实交易。

## 18. 自动化路线，不是“直接做高频”

- A0：提醒、草稿，绝不发送。
- A1：自动 Preview，人工独立确认 Submit。
- A2：有界无人值守；先 Shadow Mode，再专用额度、Kill Switch、小额 Canary、严格时段和账户白名单。
- A3：高频可行性研究。允许最终结论是“不适合 Schwab API/本地桌面架构”。

自动化不能复用手动交易的宽松假设；每一级是独立 Capability/Profile。不能以“用户关闭安全开关”为理由移除不可关闭核心保护。

## 19. 证据与纠纷处理

本地完整证据：

- Order Intent、用户确认、Draft Hash、Preview、Nonce、发送时间、Broker Request ID、响应摘要、Order ID、状态转换、Unknown 与对账过程。
- SQLCipher 加密。
- Hash Chain 防修改/删除/重排。
- Ed25519 设备签名。

远端或自托管公证：

- 只存 chain sequence、chain head hash、device public key、time、app version、device signature。
- 返回 server-signed receipt，客户端只信任 pinned notary public key。
- 不保存交易正文或账户数据。

远端公证不证明 Broker 正确，只证明某个时间前存在某个不可逆链头。争议时必须和 Schwab 官方订单记录/Request ID 对照。

当前 Rust evidence 模块只是原语和未来接口，不部署官方公证服务、不上传网络。

## 20. Luna 每次工作的固定格式

开始前输出：

~~~text
任务：FH-...
我已阅读：...
本次允许修改：...
本次禁止修改：...
安全边界：...
先运行的基线命令：...
~~~

实施中：

- 一次只处理一个工作包。
- 优先 `rg` / `rg --files`。
- 修改文件使用补丁；不覆盖用户已有修改。
- 不做宽泛删除、reset、checkout。
- 不把构建产物提交 Git。
- 任何需要新增依赖的任务先说明依赖、许可证、维护状态和安全影响。
- 遇到安全/契约不确定，不猜；保持 Mock/readonly 并记录 blocker。

完成后输出：

~~~text
任务：FH-...
结果：完成/部分完成/阻塞
修改文件：逐项列出
实现行为：逐项列出
未实现：逐项列出
前端测试：命令 + 结果
Rust 测试：命令 + 结果
构建：命令 + 结果
安全扫描：命令 + 结果
人工验收：做了什么
已知风险：...
建议下一工作包：只提一个
~~~

## 21. 当前最合理的执行顺序

不要从现在直接跳到 Schwab 下单。顺序如下：

1. `FH-LUNA-101` 独立 Release 启动验收。
2. `FH-LUNA-102` Mock 设计收口、状态和亮色主题。
3. `FH-LUNA-103` 统一 Mock Broker 边界。
4. `FH-LUNA-104` 本地 Git/CI/Mock 发布材料；远端写入需用户另行授权。
5. 等用户 Developer App 获批，完成 Phase 0 官方契约和分发条款核验。
6. `FH-LUNA-201/202` Credential Manager 与 SQLCipher Spike，独立审查。
7. `FH-LUNA-301` 只读 Schwab Profile。
8. `FH-LUNA-401` 真实收益引擎。
9. `FH-LUNA-501` Preview-only。
10. 安全审查、故障注入、来源验证后，才讨论 `FH-LUNA-601` 实验性 Limit Trading。
11. 真实交易稳定后按 A0/A1/A2 推进自动化；A3 单独研究。

## 22. 现在不需要用户重新决定的事项

- Windows first。
- Apache-2.0。
- 系统语言跟随 + English fallback。
- 黑/灰/白 + lime 设计方向。
- 负收益使用 muted berry/magenta，不用刺眼纯红。
- Market Order 首个真实版本仅 Preview。
- 首个真实范围是股票/ETF Regular Session 手动 Limit。
- 安全保护默认开启，可配置项关闭时强制风险门槛。
- 当前不买 Authenticode。
- 本地完整证据 + 远端最小 Commitment 双边保存。
- 当前不部署官方远端服务。

需要以后通过外部事实而不是拍脑袋决定：Schwab 当前 API 契约、限流、Preview、市场数据许可、Individual/Commercial 分类、自动化/高频条款。

## 23. 一句话完成标准

近期完成标准不是“能真下单”，而是：用户拿到一个独立运行、页面齐全、交互清晰、全部虚构数据、无券商写能力、可测试、可审计、可公开预览的 Windows Mock 版本；在此基础上再逐级增加只读、Preview 和受限真实交易能力。

## 24. 本次真实测试的硬预算边界

用户已明确授权未来真实测试阶段的累计名义金额上限为 US$1.00。该授权不得被解释为自动交易许可，也不得按订单重复计算。真实测试必须满足：

- 用户本人逐笔确认；未指定标的和订单参数时不得提交。
- 只允许用户明确指定的股票/ETF、Regular Session、手动 Limit Order。
- 禁止自动选股、仙股、OTC、期权、杠杆/反向 ETF、卖空和扩展时段。
- 应以“已提交、待定、未知”占用预算；未知状态先对账，禁止重试或继续下单。
- 整股限制、账户权限、API 契约或预算不足时，停止真实测试，不得用垃圾标的绕过限制。
