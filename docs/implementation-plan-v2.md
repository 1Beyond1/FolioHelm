# FolioHelm 完整实施方案 v2

状态：产品与架构决策已确认；Phase 1 工程底座与 Mock 客户端正在实施。

权威性：本文件取代 implementation-plan-v1.md。后续主模型和 Luna Max 必须以本文件及其后续明确修订为准。

配套文件：user-decisions-v1.md 是已确认决策的短版摘要。Schwab 能力、数据和限流证据单独记录在 schwab-api-capability-matrix-v1.md。

## 0. 已确定事项

以下事项已经由用户明确或根据安全要求锁定，不重复征询：

- 项目名称暂用 FolioHelm。
- 产品是本地优先的开源桌面客户端。
- 每位用户自行申请 Charles Schwab Developer App 并使用自己的凭据。
- 项目不提供共享 API、云端代理、托管 Token 或在线账户服务。
- UI 以 design-preview 中已确认的黑白、灰黑层次和荧光绿版本为唯一视觉基线。
- 支持深色与浅色主题，但深色主题先达到完整视觉质量。
- 热力图支持活跃模式与收益模式，收益模式支持百分比和美元切换。
- 负收益使用受控的低饱和莓红，不使用高饱和纯红作为品牌色。
- 桌面框架改为 Tauri 2；前端 React + TypeScript；特权核心 Rust。
- 资金安全优先于一键操作、发布速度、安装包体积和功能数量。
- 真实下单默认关闭，必须经过只读、Preview 和安全审查后逐级开放。
- 首发平台为 Windows；macOS 和 Linux 不进入首发范围。
- 界面首次启动跟随系统语言，支持简体中文和英文，未知语言回退英文。
- 开源许可证使用 Apache License 2.0。
- 当前不购买 Windows Authenticode 代码签名；是否购买是发布时的信誉与供应链选择，不是交易正确性的证明。
- 首个真实交易版本不开放自动策略、定时执行、无人值守或高频交易；这些能力保留为后续独立安全阶段，不作永久排除。
- 证据采用“双端对照”：本机保存加密的完整事件链；可选远端只保存经过设备签名的链头 Commitment 并返回签名 Receipt，不集中上传原始交易数据。

## 1. 产品定义

FolioHelm 是一个面向 Charles Schwab 个人账户用户的本地证券资产与交易终端。

核心价值：

1. 用比券商原界面更直观的方式展示资产、持仓、收益和活动。
2. 用本地派生数据提供组合收益热力图和年度行为回顾。
3. 在不托管用户凭据的前提下提供更清晰的订单预览与确认流程。
4. 让用户可以审查源代码、自行构建并使用自己的 Developer App。

FolioHelm 不做：

- 账户托管。
- 共享行情服务。
- 未经用户明确创建、模拟验证、风险限额和单独启用的后台交易。
- 荐股、投资建议或 AI 买卖决策。
- 资金划转、入金、出金或银行卡操作。
- 抓取 Schwab 网页补齐 API。
- 绕过地区、账户、Developer App 或市场数据资格限制。
- 在远程服务器保存用户账户、持仓、交易或凭据。

### 1.1 四种运行与发布形态

这些名称只描述软件能碰到多深的数据和权限，不要求用户理解开发术语：

1. Mock 演示：只使用内置虚构账户和行情，不连接 Schwab，不需要 API 凭据，不可能产生真实订单。用于公开展示 UI、让大家体验和做视觉回归。
2. 只读连接：连接用户自己的 Schwab Developer App，可以查看账户、余额、持仓、订单、流水和行情；构建产物在编译时不包含 Place、Cancel、Replace 命令，不能改变真实账户。
3. Preview-only：用户可以填写订单草稿，经过本地检查并请求 Schwab Preview；最终 Submit 命令不存在，因此 Preview 不会变成真实订单。
4. 实验性真实交易：仅在安全、条款、来源完整性和测试门槛通过后，单独构建包含真实交易能力的版本。Windows Authenticode 强烈推荐，但不作为“交易逻辑正确”的替代品。

公开顺序锁定为：公开 Mock 预览版 → 条款核验后的只读连接版 → Preview-only → 签名的实验性真实限价单版。源码可持续公开，但每一种官方二进制必须明确标注能力，不能只靠隐藏按钮区分。

### 1.2 “不确定就只读”的准确含义

只读不是“软件不能用”，而是仍然显示能够可靠读取的数据，但禁用会改变真实账户的动作。

当 FolioHelm 无法可靠确认账户交易权限、可用资金、可卖数量、市场时段、报价新鲜度、订单状态或当前 API 契约时：

- 账户、持仓、行情和历史数据仍可查看，并显示未知或过期原因。
- Place、Cancel、Replace 和任何后续写操作不进入可调用状态。
- UI 必须给出具体原因和恢复办法，不能只把按钮变灰。
- 不猜测缺失字段，不把缺失值当成 0，也不自动切换到另一个账户。
- 条件恢复并重新验证后才重新开放对应动作。

这是一种失败关闭策略：宁可暂时少一个交易按钮，也不在信息不完整时替用户赌。

## 2. 财产安全目标

### 2.1 主要风险

可能造成真实财产损失的路径包括：

1. 下错账户。
2. 买卖方向错误。
3. 数量、价格、有效期或标的错误。
4. 双击、重试、多实例或崩溃恢复导致重复订单。
5. 网络超时后订单已经到达 Schwab，但客户端误判失败。
6. 使用过期报价、持仓、购买力或交易时段状态。
7. Token、Secret 或账号进入前端、日志、崩溃报告或依赖。
8. 浮点数、货币单位、证券精度或时区计算错误。
9. WebView 中的 XSS 越权调用 Rust 命令。
10. 安装包、更新包、依赖或构建流水线被篡改。
11. Schwab API 字段、错误结构或业务语义发生变化。
12. 用户把风险提示误解为软件对结果的保证。

### 2.2 安全目标

- 不允许前端直接接触 Access Token、Refresh Token 或数据库密钥。
- 不允许前端任意联网、任意读写文件、启动命令或访问数据库。
- 不允许没有有效 Preview 的真实 Submit。
- 不允许写请求因网络错误自动重试。
- 不允许在订单状态不明确时再次提交相同订单。
- 不允许测试、CI、Mock 或开发构建调用真实订单写接口。
- 不允许关键字段缺失时回退为 0、空字符串或默认账户。
- 不允许金额和数量进入二进制浮点数运算。
- 不允许来源和完整性无法验证的官方构建启用真实交易。
- 不允许缺失安全存储时把 Token 或数据库密钥降级为明文。

### 2.3 不作虚假承诺

任何能提交真实订单的软件都不能承诺零风险。FolioHelm 的目标是通过权限隔离、精确计算、两阶段确认、持久化 Journal、故障注入和发布门槛降低错误概率，并在结果不明确时优先停止而不是猜测。

## 3. UI 与产品体验

### 3.1 视觉 Token

- 页面背景：#050505。
- 主卡片：#141414。
- 抬升层：#1A1A1A。
- 弱层：#202020。
- 主文本：#F5F5F1。
- 次文本：#8B8B87 和 #B7B7B2。
- 品牌与主交互：#B7FF22。
- 正收益辅助色：#57E68A。
- 负收益辅助色：#E85C87。
- 分割线使用极低透明度白色，不使用厚重边框。
- 字体优先 Inter、SF Pro、Segoe UI 和系统字体。

### 3.2 一级导航

1. Home：资产、组合曲线、快捷入口、热力图、持仓和近期活动。
2. Markets：搜索、自选、报价、市场状态与数据新鲜度。
3. Instrument：标的详情、价格图、持仓、相关订单和交易入口。
4. Portfolio：账户分布、持仓、现金、收益和流水。
5. Orders：工作中、部分成交、已成交、已取消、被拒绝和状态未知。
6. Trade：订单草稿、Preview、独立确认窗口和结果。
7. Settings：连接、安全、风险限额、数据、日志、主题和语言。

### 3.3 全局状态

任何页面都必须能看到：

- 当前账户别名与掩码。
- API 已连接、需重授权、离线或错误。
- 市场开盘、闭市、盘前盘后或未知。
- 行情实时、延迟、缓存或未知。
- 最后同步时间。
- 交易已锁定或本次会话已解锁。
- 是否存在 Unknown Order 需要处理。

单个绿色圆点不能代表所有系统都正常。

### 3.4 语言与地区格式

- 首次启动读取 Windows 用户首选语言，而不是根据 IP 或 Schwab 账户地区推断。
- `zh-CN`、`zh-SG` 和明确的简体中文首选项使用简体中文；其他已支持语言使用其对应翻译；未知语言回退英文。
- Settings 可以随时覆盖系统语言，并支持“跟随系统”“English”“简体中文”。
- GitHub README、Release 截图和商店素材默认使用英文，便于国际开源协作。
- 金额、日期、时间和小数展示遵循界面 Locale；Symbol、订单枚举和发送给 Broker 的十进制值使用稳定的领域格式，不受 Locale 影响。
- 所有风险警告和强制确认文本必须完整翻译；缺失翻译时回退英文，不能显示空白按钮或截断关键含义。

## 4. 热力图

### 4.1 模式

热力图卡片提供：

- 活跃：每日订单、成交、股息和资金流水数量。
- 收益百分比：每日组合收益率。
- 收益美元：每日组合美元盈亏。

切换只改变数据、图例、摘要和 Tooltip，不改变卡片尺寸。

### 4.2 活跃色阶

- 0：#282828。
- 1 级：#354A1D。
- 2 级：#597E1C。
- 3 级：#82BD1B。
- 4 级：#B7FF22。

非零天数采用当年分位数分档，不用固定次数阈值。

### 4.3 收益色阶

正收益：

- #354A1D
- #597E1C
- #82BD1B
- #B7FF22

负收益：

- #3A232C
- #6F3146
- #A83E62
- #E85C87

无数据或非交易日：

- #1B1B1B

接近 0：

- #2A2A2A

亏损格增加轻微内侧短线或纹理，不能只靠颜色表达正负。

### 4.4 数据质量

每个收益单元格包含：

- exact：存在可信期初、期末和外部现金流。
- estimated：根据流水、成交和历史价格重建。
- incomplete：缺失价格、公司行动或复杂资产，无法可靠计算。

incomplete 显示灰色虚线，不显示虚假 0%。

### 4.5 收益公式

美元盈亏使用包含现金的账户总权益：

~~~text
daily_pnl =
  ending_portfolio_value
  - beginning_portfolio_value
  - net_external_cash_flow
~~~

百分比收益采用 Modified Dietz：

~~~text
return =
  (EMV - BMV - sum(CF))
  / (BMV + sum(weight_i * CF_i))
~~~

- 入金和出金属于外部现金流。
- 股息、利息和价格变化属于投资回报。
- weight 是现金流发生后到期末的剩余时间占比。
- 分母为 0 或数据不足时返回 null。
- 日期使用 America/New_York 交易日。
- 计算结果带 calculation_version，公式升级后可重算。

## 5. 功能范围

### 5.1 只读 MVP

- Schwab Developer App 配置向导。
- OAuth 授权和重授权。
- 多账户读取与账户别名。
- 总权益、现金、购买力和当日变化。
- 股票与 ETF 持仓。
- 报价、历史价格和标的搜索。
- 自选列表。
- 当前订单、历史订单、成交和交易流水。
- 本地快照。
- 活跃与收益热力图。
- 离线缓存与数据新鲜度。
- Mock 模式。
- 脱敏诊断导出。

### 5.2 Preview 阶段

- 股票与 ETF。
- Buy 和卖出现有多头持仓。
- Market 与 Limit 草稿。
- 本地规则检查。
- Schwab Preview。
- 自然语言订单摘要。
- Market 只允许 Preview，不允许真实 Submit。

### 5.3 首个真实交易版本

- Regular Session。
- Limit Order。
- 股票与 ETF。
- 买入和卖出现有多头。
- Day；GTC 仅在当前官方契约和账户能力确认后开放。
- Place 和 Cancel。
- Replace 在状态语义和故障路径完整验证后开放。

### 5.4 暂不支持

- Market 的真实提交。
- 期权和多腿策略。
- 卖空。
- 主动使用保证金借款。
- Stop、Stop Limit、OCO、OTO。
- 扩展时段。
- 自动策略、定时执行、无人值守和高频交易不进入首个真实交易版本，转入后续独立阶段。
- 资金划转。

### 5.5 未来自动化分级

用户没有永久排除自动策略、定时下单、无人值守和高频能力。产品决定是分层推进，不把风险完全不同的功能混在一个“自动交易”开关里：

1. A0 自动提醒与草稿：规则或时间触发后只生成本地草稿和通知，不访问订单写接口。
2. A1 自动 Preview：规则触发后刷新账户与行情、运行 TradingPolicy 并请求 Preview；必须由用户在当次有效期内手动确认 Submit。
3. A2 有界无人值守：只在 Schwab 当前条款允许、模拟与故障测试充分、用户单独启用后，按策略硬限额自动提交；默认关闭，不随普通真实交易解锁而开启。
4. A3 高频或快速 Cancel / Replace：作为独立可行性研究。必须证明 API 限流、延迟、行情资格、执行语义和本地设备可靠性满足需求；不能把零售桌面客户端宣传成低延迟交易系统。

不存在“保证绝对不出错”的工程证明。若用户把“零错误”作为必要条件，则 A2 和 A3 不上线；只能在可量化的残余风险、损失上限和停机行为经过独立评审后，由用户决定是否接受。

### 5.6 A2 / A3 的最低门槛

- Schwab 当前书面条款明确允许对应自动化方式。
- 取得当前订单与 Streaming 限流、SLA 或无 SLA 事实；不能拿历史 120 次/分钟推导高频能力。
- 策略使用受限、确定性的规则模型；不允许任意脚本、插件、远程代码或 LLM 直接调用 Submit。
- 同一策略先通过历史回放、Mock、故障注入和至少 30 个自然日 Paper / Shadow 运行；没有 Schwab Sandbox 时，Shadow 只记录“本来会下什么”，绝不真实提交。
- 首次真实启用采用用户设置的极小单笔、极小日累计、最大持仓增量、最大订单数和最大价格偏离；自动化专用限额不能通过普通安全设置关闭。
- 每个策略有独立 Allowlist、交易时段、到期日、版本 Hash 和一键 Kill Switch；修改规则后必须重新模拟并重新授权。
- 心跳丢失、电脑休眠、网络切换、Streaming 断线、行情过期、账户未知、429、5xx、Token 刷新、系统时钟跳变或 Order Unknown 时立即停止产生新订单。
- 任何写请求都不自动重试；前一个订单未确定或未对账时，不允许策略继续对同一账户产生可能重复的意图。
- 定时规则以 America/New_York 交易日、节假日和夏令时处理；Windows 休眠期间错过的任务默认跳过，不在唤醒后补下。
- 自动化必须单独接受风险说明，并在 UI 持续显示策略正在运行、剩余额度、最后心跳和下一动作。
- A2 上线前必须进行独立安全审查和小额人工 Canary；A3 还需要专门的执行系统评审，不能由 Luna Max 独立实现。

### 5.7 Schwab API 能力边界

当前公开资料能支持的能力面包括：OAuth、账户哈希、余额、持仓、订单读取、交易流水、报价、历史 K 线、标的搜索与基本面、期权链、市场时间、涨跌榜、订单 Preview / Place / Cancel / Replace，以及行情和账户活动 Streaming。详细的证据等级、限制和 FolioHelm 取舍见 `docs/schwab-api-capability-matrix-v1.md`。

但 Schwab 完整当前文档位于登录后的 Developer Portal。公开第三方客户端文档只能用于确定技术探索方向，不能作为真实交易的最终契约。Phase 0 必须用用户获批 App 后可见的当前官方资料逐项确认：

- Individual / Commercial 产品对开源分发和用户自带凭据的定义。
- 账户、行情、Preview 和订单端点的当前 Schema。
- 当前非订单限流、用户注册时配置的订单限流及其作用域。
- Callback URL、Token 生命周期和 Streaming 限制。
- 市场数据展示、缓存、截图和再分发约束。
- Preview 对费用、拒单原因和账户能力的覆盖范围。

在这些项目未确认前，可以开发 Mock 和只读适配器，但不能把真实交易标记为可发布。

## 6. 技术栈

### 6.1 总体选型

前端：

- React。
- TypeScript strict。
- Vite。
- CSS Modules。
- 原生 SVG。
- TanStack Query。
- React 内建状态优先；只有出现明确跨页面临时状态需求时才引入 Zustand。
- Zod 仅校验从 Rust IPC 返回给前端的 View Model。

核心：

- Tauri 2。
- Rust stable，使用 rust-toolchain.toml 固定经过验证的工具链。
- Tokio。
- Reqwest，使用 rustls TLS。
- Serde / serde_json。
- Thiserror。
- Rust Decimal。
- Rusqlite + SQLCipher。
- Keyring Core 与明确的平台 Credential Store。
- Secrecy / Zeroize。
- Tracing，但强制脱敏。
- URL、UUID 和时间库。

测试：

- Rust cargo test。
- Clippy，warnings 视为错误。
- Rustfmt。
- cargo-deny。
- cargo-audit。
- Vitest。
- React Testing Library。
- Playwright。
- cargo-nextest 可在基础流程稳定后引入。

### 6.2 为什么采用 Tauri

- 前端 WebView 与 Rust 核心天然形成信任边界。
- Capability、Permission 和 Scope 能按窗口限制命令。
- 网络、数据库、凭据和交易逻辑可以完全留在 Rust。
- 系统 WebView 的安全更新由操作系统分发，不把 Chromium 打进应用。
- 安装包和运行内存更小。
- Rust 类型和所有权有利于实现精确、可审查的交易状态机。

### 6.3 Tauri 不等于自动安全

- Rust 核心和插件拥有本机权限，错误实现仍会造成严重问题。
- 自定义命令若只注册而不建立 AppManifest/Permission/Capability，可能暴露过宽。
- Capability 叠加会合并权限。
- WebView 仍可能出现 XSS。
- 系统 WebView 存在平台差异。
- 第三方 Rust/NPM 依赖仍然属于供应链风险。

因此必须执行本方案的命令白名单、独立确认窗口、CSP、Isolation、依赖审计和签名发布。

### 6.4 不使用的前端插件

前端不安装或不授予以下能力：

- HTTP Plugin。
- SQL Plugin。
- File System Plugin。
- Shell Plugin。
- Process Plugin。
- Store Plugin。
- Stronghold JavaScript Guest API。
- 任意远程 URL IPC。

需要的网络、数据库、文件导出和凭据功能由 Rust 中的窄命令完成。

## 7. 进程、窗口和权限

### 7.1 窗口划分

main：

- 只读组合、行情、订单列表和草稿编辑。
- 可以请求 Preview。
- 不能直接调用真实 Submit。

trade-confirmation：

- 由 Rust 在有效 Preview 后创建。
- 只展示 Rust 提供的不可变订单摘要。
- 仅有读取当前 Confirmation、确认 Submit 和取消 Confirmation 三个权限。
- 禁止导航、外链、文件、网络和其他应用命令。
- 关闭后 Nonce 失效。

connection：

- 只用于首次输入 App Key、App Secret 和发起 OAuth。
- 不具备交易权限。
- 关闭后表单和临时 Secret 立即销毁。

diagnostics：

- 只能生成和保存脱敏诊断包。
- 不具备账户、Token 或交易命令。

### 7.2 AppManifest

build.rs 必须显式声明所有可从 WebView 调用的应用命令。未列入 AppManifest 的命令不得出现在生产包。

### 7.3 Permission

每个应用命令建立独立 Permission TOML：

- allow-get-dashboard
- allow-get-portfolio
- allow-get-heatmap
- allow-search-instruments
- allow-create-preview
- allow-get-confirmation
- allow-confirm-submit
- allow-cancel-confirmation
- allow-list-orders
- allow-cancel-order
- allow-save-credentials
- allow-start-oauth
- allow-disconnect
- allow-export-diagnostics

高权限命令不加入 default Permission Set。

### 7.4 Capability

- main capability 只引用读取和 Preview 权限。
- trade-confirmation capability 才引用 confirm-submit。
- connection capability 只引用连接命令。
- diagnostics capability 只引用脱敏导出。
- 禁止窗口通配符。
- 禁止 remote capability。
- 禁止 dangerousRemoteDomainIpcAccess。
- 禁止同一窗口加入多个会扩大权限的 Capability。

### 7.5 Runtime Validation

Capability 只是第一道门。每个 Rust Command 还要验证：

- 调用窗口 label。
- payload schema。
- 当前账户。
- 会话状态。
- 单次 Nonce。
- 数据新鲜度。
- 本地风险限额。
- TradingPolicy。
- Order Journal。

### 7.6 Isolation 与 CSP

- 使用 Tauri Isolation Pattern，拦截 IPC 并拒绝不符合命令形状的消息。
- Rust 仍执行完整校验，Isolation 不作为唯一防线。
- CSP 只允许本地 bundle、Tauri IPC、必要的 data image。
- 不加载 CDN、远程字体、远程脚本或远程 HTML。
- script-src 不允许 unsafe-eval。
- style-src 尽量只允许 self；若构建工具确需 nonce，由 Tauri 生成。
- frame-src、object-src 和 media-src 默认 none。
- 禁止 WebView 导航和新窗口。

## 8. 凭据与本地数据安全

### 8.1 系统凭据库

Rust 直接使用平台原生 Credential Store：

- Windows：Windows Credential Manager。
- macOS：Keychain Services。
- Linux：Secret Service；没有可信后端时真实连接和交易关闭。

不允许明文文件、LocalStorage、IndexedDB、前端 Store 或 SQLite 保存 App Secret 和 Token。

### 8.2 保存内容

系统凭据库保存：

- App Key。
- App Secret。
- Access Token。
- Refresh Token。
- SQLCipher 随机数据库密钥。

SQLite 只保存凭据引用和到期元数据，不保存明文或可直接解密的 Token。

### 8.3 内存 Secret

- Rust 使用 SecretString 或等价 Zeroize 类型。
- Debug 和 Display 不得输出 Secret。
- Secret 仅在发起 OAuth 或 HTTPS 请求的最小作用域中暴露。
- 不克隆 Token，除非调用接口无法避免。
- 作用域结束后清零内存。
- Panic、Error 和 Tracing 字段不包含 Secret。

### 8.4 SQLCipher

- 生成 256-bit 随机数据库密钥。
- 密钥保存到系统 Credential Store。
- 使用 Rusqlite 的 bundled SQLCipher 构建并在 Windows CI 验证。
- 不允许明文数据库回退。
- 启用 WAL、Foreign Keys 和 synchronous=FULL。
- 禁止加载 SQLite Extension。
- 首次启动建立加密数据库。
- 迁移前创建加密备份；迁移失败回滚。
- 用户断开账户时可选择保留匿名历史或彻底删除账户数据。

### 8.5 前端首次输入

App Secret 在用户输入时短暂存在于 connection WebView：

- 使用未持久化的受控最小表单。
- 不进入 React 全局状态、Query Cache、日志或崩溃报告。
- 提交后立即清空 DOM Value 和临时变量。
- Rust 收到后立即写入系统凭据库。
- 前端永远不能再次读取已保存 Secret。

## 9. OAuth

### 9.1 流程

1. 用户在 Schwab Developer Portal 创建自己的 App。
2. FolioHelm 显示必须填写的 Callback URL。
3. 用户输入 App Key 和 App Secret。
4. Rust 保存凭据并生成随机 state。
5. 如果 Schwab 支持 PKCE，则同时生成 verifier 和 challenge。
6. Rust 生成固定 Schwab 域名的授权 URL。
7. Rust 使用系统浏览器打开 URL；前端不能提供任意 URL。
8. Rust 本地 Callback Listener 接收 Authorization Code。
9. 严格校验 host、path、state、一次性使用和超时。
10. Rust 交换 Token 并保存到系统 Credential Store。
11. 前端只收到 ConnectionStatus。

### 9.2 Callback 技术验证

Phase 0 必须验证：

- Schwab 当前允许的 Callback URL 格式。
- localhost 与 127.0.0.1。
- 固定端口与随机端口。
- HTTP 与 HTTPS。
- 自定义 Scheme 是否允许。
- PKCE 是否支持或要求。
- Refresh Token 生命周期。
- 用户取消和拒绝授权的错误。
- App 未批准和账户权限不足的错误。

如果 Schwab 只允许固定 HTTPS Callback：

- 使用固定 loopback 端口。
- 仅监听 loopback interface。
- 证书方案必须经过独立安全评审。
- 不为方便而关闭 TLS 校验。

### 9.3 Token Refresh

- Refresh 使用 Rust 单飞锁。
- 同一时刻只有一个刷新请求。
- 401 不无限循环。
- Refresh 失败进入 reauth-required。
- Token 更新先写系统凭据库，再更新内存状态。
- Token 到期不能自动提交或恢复任何订单。

## 10. Broker Adapter

领域层不直接依赖 Schwab JSON：

~~~rust
trait BrokerAdapter {
    async fn capabilities(&self) -> Result<BrokerCapabilities>;
    async fn list_accounts(&self) -> Result<Vec<BrokerAccount>>;
    async fn account_snapshot(&self, account: &AccountId) -> Result<AccountSnapshot>;
    async fn list_orders(&self, query: OrderQuery) -> Result<Vec<BrokerOrder>>;
    async fn list_transactions(&self, query: TransactionQuery) -> Result<Vec<BrokerTransaction>>;
    async fn quotes(&self, symbols: &[Symbol]) -> Result<Vec<Quote>>;
    async fn price_history(&self, query: PriceHistoryQuery) -> Result<Vec<PriceBar>>;
    async fn preview_order(&self, draft: BrokerOrderDraft) -> Result<BrokerOrderPreview>;
    async fn place_order(&self, order: BrokerConfirmedOrder) -> Result<BrokerOrderReceipt>;
    async fn cancel_order(&self, input: CancelOrderInput) -> Result<BrokerOrderReceipt>;
}
~~~

### 10.1 模块

- schwab_auth。
- schwab_trader。
- schwab_market_data。
- schwab_streaming。
- schwab_mapper。
- schwab_error_mapper。
- mock_broker。

### 10.2 Capability 驱动 UI

BrokerCapabilities 表示：

- 支持的资产类别。
- 支持的订单类型。
- 支持的 Session。
- Preview 是否可用。
- Cancel / Replace 是否可用。
- 行情实时或延迟。
- 账户是否允许交易。

UI 只显示能力矩阵确认支持的功能。

### 10.3 HTTP

- Rust Reqwest 客户端使用 rustls。
- 只允许固定 Schwab API Host。
- 不允许重定向到非 allowlist Host。
- 设置连接、读取和总请求超时。
- 响应体设置大小上限。
- 严格处理 Content-Type。
- 记录 Request ID，但不记录 Authorization Header。
- 证书错误直接失败。

### 10.4 限流和重试

- 实时刷新与高频交易严格分开。行情高刷新使用 Schwab Streaming；首个真实交易版本不提供自动订单、策略循环、定时执行、API 触发订单或无人值守交易。未来 A2 / A3 使用独立权限、限额和发布门槛。
- 账户读取、市场数据 REST 和交易写操作使用三个独立 Token Bucket 与优先级队列；Cancel 有写队列优先级，但仍受 Broker 限额约束。
- Developer App 当前精确限额必须在获批后的官方门户核验，不把历史数字写死。历史迁移资料中的“非订单 120 次/分钟、订单 0–120 次/分钟”只作为设计参考，不作为当前承诺。
- 核验前，非订单 REST 使用保守本地预算：最多 60 次/分钟/应用、瞬时突发不超过 10；核验后有效预算取“当前官方限额、App 配置和本地安全预算”三者最小值，正常目标不超过官方限额的 80%。
- 首版手动真实交易本地硬上限为每账户 12 个订单动作/分钟，并且同一账户最多 1 个写请求在途。未来自动化不能复用或暗中提高这个 Profile；A2 / A3 必须基于当前官方能力建立新的专用预算并重新审查。
- Place、Cancel、Replace、Preview 分开计数；若官方定义把 Preview 算入订单限额，以官方定义为准。
- GET 只有在幂等语义明确时，才可对 429、连接建立失败和部分 5xx 指数退避；优先遵守 `Retry-After`，并加入抖动。
- Place、Cancel、Replace 永不因超时、断网、429 或 5xx自动重试。Place 结果不明确时进入 Unknown 并先对账。
- Token Refresh 使用单飞锁，不因多个并发 401 触发刷新风暴。
- Streaming 串行管理订阅，指数退避并加入抖动；断线时 UI 明确显示 Polling、Delayed 或 Stale，不能继续显示“实时”。
- 收到 429 时暂停对应队列，显示节流原因和下次允许时间；不能用缓存数据冒充最新数据。

### 10.5 数据刷新策略

- 当前报价、盘口摘要和分钟图优先使用 Streaming，不按每个组件分别轮询 REST。
- 账户与持仓：启动、用户手动刷新、账户活动事件和关键交易动作后刷新；正常前台兜底 60 秒，交易确认期间 15 秒，后台或最小化 5 分钟。
- 活跃订单：优先使用 Account Activity；提交中或 Unknown 状态可 5 秒兜底查询，最多持续 2 分钟；Working 订单 15 秒，其他页面 60 秒。
- 历史价格：只在 Symbol、周期或复权范围变化时拉取；按请求键缓存，不做整页周期轮询。
- 报价 REST 兜底按官方允许的最大 Symbol 数批量请求；最大数量在 Phase 0 核验，代码不能猜。
- 标的搜索至少输入 2 个字符，350 毫秒 debounce，取消已经过时的请求。
- 多个页面订阅同一 Symbol 时由单一 Streaming Registry 去重；组件卸载不直接重建整条连接。
- App 最小化、锁屏、休眠或长期无交互时停止非必要 REST，同步恢复后先标记旧数据，再分阶段刷新。
- 所有缓存对象携带 `observed_at`、`received_at`、`source`、`entitlement` 和 `freshness`，用于区分实时、延迟、缓存与未知。

## 11. Rust 领域模型

### 11.1 精确数值

- Money、Price、Quantity、Percent 使用新类型包装 Rust Decimal。
- JSON 统一使用十进制字符串。
- SQLite 统一使用规范化十进制字符串或明确 Scale 的整数。
- 禁止 f32/f64 出现在交易领域模块。
- 格式化和千分位只在 View Model 层。
- 比较、进位和数量步长按资产规则执行。

### 11.2 标识符

- AccountId 是本地 UUID。
- Broker Account Number 只在 Rust 适配器最小作用域中存在。
- 数据库保存不可逆稳定 Hash 和掩码。
- OrderIntentId、PreviewId 和 ConfirmationNonce 使用密码学安全随机值。
- 前端不能自行构造 Broker Order ID。

### 11.3 错误

稳定错误码：

- AUTH_REAUTH_REQUIRED。
- AUTH_CALLBACK_MISMATCH。
- AUTH_TOKEN_REFRESH_FAILED。
- SECURE_STORAGE_UNAVAILABLE。
- DATABASE_LOCKED。
- ACCOUNT_PERMISSION_DENIED。
- QUOTE_STALE。
- MARKET_STATUS_UNKNOWN。
- RATE_LIMITED。
- ORDER_PREVIEW_REJECTED。
- ORDER_CONFIRMATION_EXPIRED。
- ORDER_POLICY_REJECTED。
- ORDER_SUBMISSION_UNKNOWN。
- ORDER_REJECTED。
- PERFORMANCE_DATA_INCOMPLETE。

用户看到自然语言；日志看到错误码、阶段和脱敏上下文。

## 12. 本地数据模型

### 12.1 表

- schema_migrations。
- app_meta。
- settings。
- broker_connections。
- accounts。
- account_snapshots。
- position_snapshots。
- orders。
- order_events。
- order_previews。
- order_intents。
- order_reconciliation。
- transactions。
- daily_performance。
- watchlists。
- watchlist_items。
- sync_state。
- sanitized_errors。

### 12.2 order_previews

- preview_id。
- account_id。
- normalized_draft_json。
- draft_hash。
- broker_preview_summary。
- quote_timestamp。
- account_snapshot_timestamp。
- expires_at。
- consumed_at。
- invalidated_reason。

### 12.3 order_intents

- intent_id。
- preview_id。
- account_id。
- draft_hash。
- confirmation_nonce_hash。
- state。
- prepared_at。
- dispatch_started_at。
- response_received_at。
- broker_order_id。
- request_fingerprint。
- response_summary。
- last_reconciled_at。

### 12.4 daily_performance

- account_id。
- trading_date。
- beginning_portfolio_value。
- ending_portfolio_value。
- net_external_cash_flow。
- daily_pnl。
- daily_return。
- cumulative_return。
- quality。
- calculation_version。
- computed_at。

## 13. 同步和离线

### 13.1 启动

1. 解锁系统 Credential Store。
2. 解锁 SQLCipher。
3. 显示缓存并标注时间。
4. 检查 Token。
5. 同步账户和持仓。
6. 增量同步订单和流水。
7. 更新页面所需报价。
8. 更新快照和收益。
9. 建立 Streaming。

### 13.2 快照

- App 打开时保存。
- 账户发生重大变化时保存。
- 美东收盘后 App 正在运行时保存。
- 缺失日期在下次启动时尝试重建。
- 期权和缺失公司行动时标为 incomplete。

### 13.3 离线

- 可看缓存。
- 所有价格显示截至时间。
- 可编辑订单草稿。
- 不允许 Preview 或 Submit。
- 网络恢复不会自动提交草稿。
- 网络恢复会锁定交易会话并使 Preview 失效。

## 14. Trading Core

### 14.1 不变量

- 没有有效 Preview，不能 Submit。
- Submit 的 Draft Hash 必须与 Preview 完全一致。
- Preview 和 Nonce 单次使用。
- Preview 过期不能续期，只能重建。
- 账户切换使全部 Preview 失效。
- 报价、账户或持仓过期不能 Submit。
- Sell 数量不能超过刷新后的可用多头持仓。
- 未成交订单占用现金或数量。
- 相同指纹处于 submitting 或 unknown 时不能再次提交。
- App 启动、唤醒、重连和 Token Refresh 不触发交易。

### 14.2 双层守卫

TradingPolicy：

- 纯函数。
- 不联网。
- 检查账户、资产、方向、数量、价格、步长、时段、报价、持仓、购买力和限额。
- 使用大量属性测试和表驱动测试。

OrderOrchestrator：

- 检查 Preview、Hash、Nonce、窗口、会话锁和 Journal。
- 创建独立 trade-confirmation 窗口。
- 持久化 Intent。
- 调用 Broker 写接口。
- 处理 Unknown 和对账。

### 14.3 确认窗口

显示：

- 账户别名和掩码。
- 买入或卖出。
- Symbol 和证券名称。
- 数量。
- Limit Price。
- 最大名义金额。
- 当前可信报价与时间。
- 限价偏离。
- 预计剩余现金或持仓。
- Session 和 Time in Force。
- 风险警告。

最终按钮写完整动作，例如：

以 182.40 美元限价买入 10 股 AAPL

不能只写“确认”。

### 14.4 Crash-safe Journal

1. 加载不可变 Preview。
2. 验证 Hash、Nonce 和有效期。
3. 刷新安全关键数据。
4. 执行 TradingPolicy。
5. SQLCipher FULL Transaction 写 prepared Intent。
6. 写 dispatch_started_at 并改为 submitting。
7. 只发送一次 Place。
8. 确定响应后保存 Broker Order ID。
9. 超时、崩溃或不明确时改为 unknown。

重启后：

- 唯一匹配：绑定现有 Broker Order。
- 无匹配：仍不自动重发。
- 多个匹配：锁定账户新增订单并要求人工处理。

### 14.5 本地风险限额

Settings > Trading Safety 中默认开启：

- 单笔最大名义金额。
- 单日累计提交金额。
- 单笔最大数量。
- 允许交易的账户。
- Limit 相对最新报价最大偏离。
- 10 分钟无操作自动锁定。
- 每笔订单使用独立确认窗口。

安全项分为两层：

1. 不可关闭的核心保护：有效 Preview 与 Draft Hash 一致、单次 Nonce、账户一致性、Decimal 精度、写请求不自动重试、Unknown 锁定与对账、关键数据新鲜度、Broker 购买力和持仓校验、凭据隔离、只有确认窗口可 Submit。
2. 用户可配置的附加保护：单笔金额、每日金额、单笔数量、限价偏离、自动锁定时长和允许交易账户白名单。它们默认开启并提供保守初始值；用户可以调整。除账户白名单外，可在完成强风险确认后关闭单项附加保护。

关闭本地金额或数量上限不等于绕过 Schwab 购买力、可卖持仓、订单 Schema 或任何不可关闭保护。设置页必须明确区分“本地提醒上限”和“Broker 最终规则”。

### 14.6 会话锁

- 每次启动默认锁定。
- 用户显式解锁。
- 10 分钟无操作自动锁定。
- 休眠、锁屏、网络切换、账户切换和重授权后锁定。
- 锁定使全部 Preview 和 Confirmation Nonce 失效。

### 14.7 关闭附加保护的强制风险确认

用户关闭任何可配置保护时：

- 使用阻塞式风险对话框，不能点击遮罩或按 Esc 跳过。
- 显示被关闭的具体保护、可能造成的具体损失场景和仍然生效的核心保护。
- 必须滚动到正文末尾，等待至少 8 秒，勾选“我理解 FolioHelm 将不再替我执行此项本地限制”。
- 对金额、数量、限价偏离和自动锁定的关闭，要求输入本地化确认短语；最终按钮写明“关闭单笔金额保护”等具体动作。
- 确认后立即锁定交易会话，使全部已有 Preview 和 Confirmation Nonce 失效。
- 只在本机加密数据库记录设置名、时间和应用版本，不记录订单值或敏感凭据。
- 重新开启保护不需要风险弹窗；恢复默认值提供单独按钮。
- 风险对话框用于防误操作，不作为免责书，也不能让不可关闭的核心保护变成可关闭。

## 15. 账户和行情新鲜度

安全关键数据设独立时钟：

- Quote Freshness。
- Account Snapshot Freshness。
- Position Freshness。
- Market Status Freshness。
- Preview Age。

阈值由 TradingPolicy 配置并在 Phase 0 用当前 API 行为验证。

任何一个安全时钟为 stale 或 unknown，首版真实 Submit 失败关闭。

## 16. 日志和隐私

### 16.1 禁止记录

- App Secret。
- Access Token。
- Refresh Token。
- Authorization Code。
- SQLCipher Key。
- 完整账号。
- 完整原始订单请求和响应。
- 用户姓名、地址或税务信息。

### 16.2 可记录

- 稳定错误码。
- 本地 Request ID。
- Broker Request ID。
- Account Hash 前缀。
- Symbol。
- 非敏感状态转换。
- 时间和版本。

### 16.3 诊断包

- 用户主动生成。
- 生成前再次脱敏。
- 展示将包含的文件。
- 默认不包含数据库。
- 不自动上传。
- 用户自行选择保存位置和发送对象。

## 17. 供应链和构建

### 17.1 Rust

- Cargo.lock 提交。
- cargo-deny 检查许可证、重复依赖和禁止来源。
- cargo-audit 检查公告。
- 禁止 Git Branch 漂移依赖；需要 Git 依赖时固定 Commit。
- unsafe_code 默认 deny；必须使用时逐处 ADR 和安全审查。
- build.rs 保持最小并审查所有构建脚本。

### 17.2 NPM

- package-lock.json 提交。
- CI 使用 npm ci。
- 前端依赖保持最小。
- 禁止 CDN 和运行时下载脚本。
- 依赖升级不自动合并。
- 高风险 install script 逐包审查。

### 17.3 CI

- GitHub Actions 固定 Commit SHA。
- 最小 permissions。
- Pull Request 来自 Fork 时不提供签名 Secret。
- CI 不包含 Schwab 凭据。
- 生成 SBOM。
- 生成 SHA-256。
- 正式发布构建产物签名；开发与明确标识的 Mock/只读预发布可以暂时未签名。
- Release Tag 保护。

### 17.4 更新

- 首个只读测试版可不启用自动更新。
- 启用后只使用 Tauri Updater。
- Update Signature 验证不能关闭。
- Endpoint 仅 HTTPS。
- 私钥离线或硬件/受控签名服务保存。
- 丢失更新私钥需要明确的恢复预案。
- 不允许降级，除非单独签名的紧急恢复流程。

### 17.5 当前签名决定

- 当前阶段不购买 Windows Authenticode 证书，先完成产品和安全工程。
- Windows Authenticode 不是运行普通 EXE 的硬要求，也不能证明没有业务 Bug；它主要证明发布者身份和文件签名后的完整性，并改善 SmartScreen 信任体验。
- 如果发布时仍不购买 Authenticode，可以发布真实交易构建，但必须先满足其他全部安全与合规门槛，并采用更严格的免费来源验证：固定 Commit 的公开 GitHub Actions 构建、SHA-256、SBOM、GitHub Artifact Attestation、不可变 Release、构建日志和可复现构建说明。
- 未签名构建必须明确显示 `Unsigned Windows build`，安装页解释 SmartScreen 和校验方法；不诱导用户无条件点击“仍要运行”。
- Mock、只读、Preview 和真实交易使用不同 Build Profile 与 Capability Manifest；用户能从 About 和发布文件名确认能力，不能只靠隐藏按钮区分。
- 首发不启用自动更新，使用手动更新。若以后启用 Tauri Updater，必须使用 Tauri 的独立更新签名密钥；该签名免费生成且验证不能关闭，与付费 Windows Authenticode 不是一回事。
- 在获得稳定用户量或准备 Microsoft Store 发布时重新评估 Authenticode / Artifact Signing。它是强烈推荐项，但不再作为真实交易发布的绝对阻断条件。
- 无论是否签名，独立安全审查、订单状态机测试和小额人工验证都不能省略。

## 18. 测试

### 18.1 Rust Unit

- Decimal 精度和序列化。
- Money/Price/Quantity 新类型。
- Schwab Mapper。
- Error Mapper。
- TradingPolicy。
- Order State Machine。
- Hash 和 Nonce。
- Token Refresh 单飞。
- Rate Limit。
- Cash Flow 分类。
- Modified Dietz。
- 热力图分位数。
- 日志脱敏。
- SQL Migration。

### 18.2 Property Test

- Decimal 往返不变。
- 合法数量和价格规范化幂等。
- 任意非法状态转换均拒绝。
- 任意字段变化都会改变 Draft Hash。
- 任意重复 Nonce 只能成功一次。
- 任意入金不会被算成投资收益。

### 18.3 Frontend

- 加载、空账户、离线、错误和重授权。
- 热力图键盘与 Tooltip。
- 盈亏不只依赖颜色。
- Preview 失效。
- 大数字和长 Symbol。
- 1280x800 与 1440x1024。
- 深色与浅色 Token。

### 18.4 E2E

只使用 Mock Broker：

- 首次启动。
- Connection Window 权限。
- main 不能调用 confirm-submit。
- 只有 trade-confirmation 能调用 confirm-submit。
- 双击只产生一次 Intent。
- 多实例只保留一个交易实例。
- 超时进入 Unknown。
- 重启后先对账。
- 离线禁止提交。
- 休眠和账户切换使 Preview 失效。

### 18.5 故障注入

- DNS。
- TLS。
- 401。
- 429。
- 500。
- 连接重置。
- 请求已发送但响应丢失。
- 磁盘写满。
- SQLCipher Busy。
- 数据库损坏。
- Credential Store 暂时不可用。
- 系统时间错误。
- 进程在 Journal 每个步骤被终止。

任何场景出现自动重发、错误账户、错误数量或明文 Secret，直接阻断发布。

### 18.6 人工真实验证

- 不由自动化执行。
- 用户本人确认小额 Limit Order。
- 先 Preview。
- 记录 Broker Order ID。
- 同时在 Schwab 官方界面核对。
- 验证 Cancel 前先刷新状态。
- 完成后锁回只读，审查日志。

## 19. 开源与合规

- 不使用 Schwab Logo。
- 明确非官方产品。
- 不声称 Schwab 背书。
- 不提交凭据、真实账号或个人 Fixture。
- 不再分发行情。
- 不提供共享代理。
- 不托管用户数据。
- 不抓取网页。
- 每位用户自行获批 Developer App。
- Schwab 早期迁移资料把免费或收费分发给其他自主管理账户使用的软件都描述为 Commercial use；“用户自带 Individual 凭据”不能自动证明分发合规。
- 公开任何可连接 Schwab 的官方二进制前，必须用当前 Developer Portal 条款或 Schwab 书面回复澄清“开源、本地运行、用户自带 Developer App”的产品分类与市场数据要求。
- 许可证免责声明不能替代安全工程和法律审查。
- 真实交易公开发布前进行独立安全审计和必要法律复核。

### 19.1 经济损失与纠纷控制

- 文档、官网、README 和 UI 不得使用“零风险”“保证不亏”“保证不重复下单”或“绝对安全”等无法证明的承诺。
- 明确区分软件缺陷、Broker 拒绝/延迟、行情延迟、网络故障、用户策略损失和市场价格变化，错误信息不能把所有失败都归咎于用户或 Schwab。
- 首次启用真实交易和每次启用 A2 自动化时展示版本化风险说明；用户确认只证明其看过提示，不替代我们的安全义务，也不作为万能免责。
- 每个真实订单保存本地加密、脱敏但可核对的 Intent、Preview Hash、时间线、Broker Request ID、Order ID 和状态变化；用户可导出证据包自行与 Schwab 核对。
- 证据采用 ADR-0001 的双边结构：用户本机保存完整 SQLCipher + Hash Chain + 设备签名记录；官方或自托管公证端只保存不可逆链头 Commitment 和服务端回执，不保存交易正文。
- 不收集或远程保存用户交易日志。需要排障时由用户主动生成脱敏包，并先预览内容。
- 提供公开的安全报告渠道、漏洞披露流程、受影响版本清单和紧急停用交易能力的 Release Notice。
- 严重安全缺陷发生时，默认禁用受影响版本继续创建新订单；是否以及如何取消已存在订单必须由用户确认，不能后台擅自批量撤单。
- Apache-2.0 的无担保与责任限制条款保留，但不能假设它在所有司法辖区都消除责任；公开 A2 / A3 前进行针对金融软件分发与免责声明的专业法律复核。
- 任何发布事故都保留完整、诚实、可复现的技术时间线，不删除问题记录或修改已发布构建来掩盖错误。

## 20. 项目结构

~~~text
FolioHelm/
  design-preview/
  docs/
    implementation-plan-v2.md
    user-decisions-v1.md
    schwab-api-capability-matrix-v1.md
    architecture-decisions/
    api-notes/
    security/
  src/
    app/
    components/
    features/
      connection/
      home/
      instruments/
      markets/
      orders/
      portfolio/
      settings/
      trade/
    styles/
    contracts/
  src-tauri/
    Cargo.toml
    build.rs
    tauri.conf.json
    capabilities/
    permissions/
    src/
      auth/
      broker/
        schwab/
        mock/
      commands/
      contracts/
      diagnostics/
      domain/
      orders/
      performance/
      rate_limit/
      security/
      storage/
      streaming/
      sync/
      lib.rs
  tests/
    fixtures/
    e2e/
~~~

## 21. 开发阶段

### Phase 0：技术真实性验证

主模型负责。

产出：

- 安装并锁定 Rust/Tauri 工具链。
- Tauri AppManifest、Permission、Capability Spike。
- main 与 trade-confirmation 权限隔离 Spike。
- Schwab OAuth Callback Spike。
- 系统 Credential Store Spike。
- SQLCipher Spike。
- Schwab 只读账户与报价 Spike。
- Preview 能力验证。
- 登录后官方文档归档：端点、Schema、限流、Streaming、OAuth 和市场数据条款。
- Individual / Commercial 对开源分发与用户自带凭据的当前书面结论。
- Threat Model v1。

通过条件：

- 没有 Secret 进入前端或日志。
- main 窗口无法调用 confirm-submit。
- SQLCipher 文件不能被普通 SQLite 打开。
- OAuth 能完成或得到明确不可行结论。
- 不调用真实写接口。
- 未获得分发条款结论时，公开构建保持 Mock-only。

### Phase 1：Tauri 安全壳

主模型定义，Luna 实现机械部分。

- React/TS/Vite。
- Rust Core。
- 窗口划分。
- AppManifest、Permission、Capability。
- CSP 和 Isolation。
- Mock Broker。
- Lint、Test、Build。

### Phase 2：迁移批准 UI

Luna 为主，主模型视觉验收。

- Design Token。
- Home。
- 热力图。
- 持仓。
- 活动。
- 空、错、离线、加载状态。
- 视觉截图。

### Phase 3：安全存储和数据库

主模型定义安全和 Schema，Luna 实现明确 Repository。

- Credential Store。
- SQLCipher。
- Migration。
- Repository。
- Sanitized Logging。
- Diagnostics。

### Phase 4：只读 Schwab

主模型负责 OAuth、HTTP、契约和错误边界；Luna 实现固定 Mapper 与 UI。

- 连接向导。
- 账户和持仓。
- 报价和历史价格。
- 自选。
- 订单和流水。
- 缓存、同步和离线。

### Phase 5：收益引擎

主模型锁定公式和测试向量；Luna 按测试实现。

- 快照。
- Cash Flow。
- Daily Performance。
- 数据质量。
- 双模式热力图。

### Phase 6：公开 Mock 与只读预发布

公开 Mock 不等待 Schwab 凭据；只读连接构建必须等待当前分发条款核验。

- README、Threat Model、Privacy 和 Developer App Guide。
- Windows unsigned pre-release 标识、SBOM 和 SHA-256。
- Mock 构建不包含 Schwab Secret 输入和真实网络能力。
- 只读构建在编译时不包含 Preview / Place / Cancel / Replace。

### Phase 7：Preview-only

主模型实现 TradingPolicy 基线和领域契约；Luna 实现 Trade UI。

- Draft。
- Validation。
- Preview。
- 独立确认窗口，但 Submit Command 为 Mock。
- Quote Freshness。

### Phase 8：内部实验性 Limit Trading

核心写接口由主模型实现或逐行审查。

- Session Lock。
- Risk Limits。
- Real Submit。
- Journal。
- Unknown Reconciliation。
- Cancel。
- Replace 延后。
- 签名和独立安全审查。

### Phase 9：公开实验交易版本

只有合规、构建来源可验证、安全审计、故障注入和人工小额测试全部通过后才进入。首版只提供 Regular Session 的股票/ETF 手动 Limit Order；自动化按 A0 → A1 → A2 推进，A3 高频能力单独判断可行性。Windows Authenticode 推荐但非绝对要求。

### Phase 10：自动化安全阶段

- A0 自动提醒与草稿。
- A1 自动 Preview、人工 Submit。
- A2 Shadow Mode、专用风险限额、Kill Switch 和小额 Canary。
- A2 只有在条款、审计和测试通过后才可能公开。
- A3 高频可行性研究可以得出“不适合此 API / 架构”的正式结论，不以必须实现为成功标准。

## 22. 主模型与 Luna Max

### 22.1 主模型负责

- 架构和 ADR。
- 当前 Schwab 文档核验。
- Tauri 权限边界。
- Credential Store。
- OAuth。
- SQLCipher Key 流程。
- Rust 领域类型。
- Decimal 和收益公式。
- TradingPolicy。
- OrderOrchestrator。
- Place/Cancel/Replace。
- Journal 与 Unknown。
- Threat Model。
- 依赖和发布审查。
- Luna Diff 和测试结果审查。

### 22.2 Luna 负责

- React UI。
- CSS Modules。
- 组件和 Story/Fixture。
- 热力图渲染。
- Mock 数据。
- 明确类型下的普通 Rust DTO。
- 按给定字段实现 Mapper。
- 按给定 SQL 实现 Migration/Repository。
- 按给定向量补测试。
- 文档、格式、编译和普通错误修复。

### 22.3 Luna 禁止

- 自行增加 Tauri Plugin 或 Capability。
- 修改 AppManifest。
- 设计凭据存储。
- 修改 Decimal 规则。
- 修改收益公式。
- 修改 TradingPolicy。
- 修改订单状态机。
- 调用真实 API 写操作。
- 放宽 CSP。
- 增加 remote IPC。
- 添加遥测、云服务或发布。

### 22.4 工作包模板

每个任务必须包含：

- 任务编号。
- 唯一目标。
- 先读文件。
- 允许修改文件。
- 禁止修改文件。
- 已锁定接口。
- 实现步骤。
- 边界情况。
- 验收标准。
- 必须运行的命令。
- 禁止运行的命令。
- 最终报告格式。

一个工作包控制在 1 到 6 个主要文件，完成后由主模型检查实际 Diff。

### 22.5 首批任务

- FH-001：Tauri React TS 空壳。
- FH-002：AppManifest/Permission/Capability 基线。
- FH-003：main 与 trade-confirmation 权限测试。
- FH-004：Design Token 和 App Shell。
- FH-005：迁移 Home 静态 UI。
- FH-006：Mock Broker。
- FH-007：热力图组件。
- FH-008：前端测试和视觉回归。
- FH-009：SQLCipher Migration，必须使用主模型给定 SQL。
- FH-010：只读 Schwab Mapper，禁止网络。

OAuth、Credential Store、真实写接口和 Unknown 不作为 Luna 独立设计任务。

## 23. 发布阻断条件

出现以下任意一项，不发布真实交易：

- Schwab 分发条款未澄清。
- OAuth Callback 不稳定。
- 安全 Credential Store 不可用。
- SQLCipher 无法可靠打包。
- 前端能读取 Token。
- main 窗口能绕过确认窗口提交。
- 写请求存在自动重试。
- Crash Test 可能重复订单。
- Decimal 测试失败。
- Unknown 无法可靠锁定。
- CSP 或 Capability 过宽。
- 官方构建来源或完整性无法通过 Authenticode、Artifact Attestation / Hash 与发布记录中的至少一套受信链路验证。
- 更新签名私钥管理未建立。
- 独立安全审查存在高危或严重问题。

## 24. 参考

- Tauri Security: https://v2.tauri.app/security/
- Tauri Capabilities: https://v2.tauri.app/security/capabilities/
- Tauri Permissions: https://v2.tauri.app/security/permissions/
- Tauri Command Scopes: https://v2.tauri.app/security/scope/
- Tauri Runtime Authority: https://v2.tauri.app/security/runtime-authority/
- Tauri CSP: https://v2.tauri.app/security/csp/
- Tauri Isolation Pattern: https://v2.tauri.app/concept/inter-process-communication/isolation/
- Tauri Project Setup: https://v2.tauri.app/start/create-project/
- Tauri Updater: https://v2.tauri.app/plugin/updater/
- Tauri Distribution: https://v2.tauri.app/distribute/
- Keyring Rust: https://docs.rs/keyring/latest/keyring/
- Rusqlite: https://docs.rs/crate/rusqlite/latest
- Rust Decimal: https://docs.rs/rust_decimal/latest/rust_decimal/
- Secrecy: https://docs.rs/secrecy/latest/secrecy/
- Schwab Developer Portal: https://developer.schwab.com/
- Schwab Online Services Agreement: https://www.schwab.com/legal/terms
- Schwab API capability notes: schwab-api-capability-matrix-v1.md
