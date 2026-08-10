# FolioHelm：Schwab API 能力、数据与频率核验 v1

核验日期：2026-08-09

状态：公开资料调查版。当前 Schwab Developer Portal 的完整文档需要登录，故本文件用于锁定开发方向，不替代获批 App 后的官方契约核验。

## 1. 证据等级

- A：当前登录后 Schwab Developer Portal 或 Schwab 书面回复。真实交易发布的唯一最终依据；当前尚未取得。
- B：2026-08-09 可访问的 `schwab-py` 文档和当前开源客户端实现。可证明社区正在使用的端点面，但作者明确说明 Schema 可能静默变化。
- C：2023 Schwab Trader API 迁移资料的公开镜像。可解释历史设计和限流来源，只能作为历史参考。
- D：推断或待实验。不得据此开放真实交易。

主要公开参考：

- Schwab Developer Portal：https://developer.schwab.com/
- Schwab Online Services Agreement：https://www.schwab.com/legal/terms
- schwab-py HTTP Client：https://schwab-py.readthedocs.io/en/stable/client.html
- schwab-py Streaming Client：https://schwab-py.readthedocs.io/en/latest/streaming.html
- schwab-py Getting Started：https://schwab-py.readthedocs.io/en/latest/getting-started.html
- 2023 迁移资料镜像：https://kaizhu256.github.io/tdameritrade-dev-mirror/developer.tdameritrade.com/content/trader-api-schwab-integration-guide-june-2023-update.html

## 2. API 能做什么

| 能力 | 公开证据 | FolioHelm 决定 | 发布前还要确认 |
| --- | --- | --- | --- |
| OAuth 与 Developer App | B：App Key、Secret、Callback URL 和用户授权流程 | 全程在本机 Rust 完成，Token 进入 Windows Credential Manager | Callback 允许格式、PKCE、Access / Refresh 生命周期和重授权错误 |
| 账户哈希 | B：原账号映射为 API 使用的 hashValue | 原账号仅在 Rust 最小作用域存在，UI 和数据库使用别名、掩码和本地 ID | Hash 稳定性、账户移除与重新授权行为 |
| 余额、购买力、持仓 | B：账户接口返回余额，可选 positions / orders | 首页、Portfolio、持仓、卖出上限和收益快照 | 不同现金、Margin、IRA 等账户字段及权限语义 |
| 当前与历史订单 | B：按账户或全部关联账户查询，公开客户端注明查询窗口通常为最近 60 天 | Orders 页面、订单状态机、Unknown 对账 | 当前时间窗口、分页、部分成交、父子订单和所有状态字段 |
| 交易流水 | B：Trade、股息/利息、ACH、Wire、Journal 等类型，公开客户端注明通常最近 60 天 | 活跃热力图、现金流分类、收益重建 | 分页、历史深度、公司行动、税务批次与缺失类型 |
| 用户偏好与 Streaming 元数据 | B：user preferences | 只取建立 Streaming 所需字段，不复制 Schwab UI 偏好 | 字段敏感性和缓存期限 |
| 单个与批量报价 | B：quote / quotes；若账户只有延迟权限，返回也会延迟 | 自选、标的详情、组合估值；每条数据带 entitlement 与时间 | 单请求最大 Symbol 数、实时资格和字段含义 |
| 历史价格 | B：分钟、5/10/15/30 分钟、日、周等粒度 | 图表、收益重建和缓存 | 实际历史深度、复权、扩展时段、缺口和公司行动 |
| 标的搜索与基本面 | B：Symbol / Description 搜索、Fundamental projection、CUSIP | 全局搜索和标的基本资料 | 返回资产类型、OTC、不可交易标的和搜索限额 |
| Option Chain | B：合约、策略链、波动率等参数 | 可作为未来只读研究能力；首版 UI 与交易均不做期权 | Greeks、实时资格、字段和复杂策略的当前支持 |
| Market Hours | B：Equity、Option、Bond、Future、Forex 等市场时间 | 首版只使用 Equity Regular Session 判断 | 节假日、半日市、盘前盘后和时区语义 |
| Movers / Screener | B：指数与交易所涨跌/活跃榜；Streaming 也有 Screener | 非 MVP，可在 Markets 后续添加 | 数据许可、刷新限制和字段稳定性 |
| Streaming Level One | B：股票、期权、期货等实时 Bid / Ask / Last / Volume | MVP 只订阅股票/ETF Level One，取代高频 REST 轮询 | 连接数、Symbol 数、字段、心跳和 entitlement |
| Streaming OHLCV | B：股票分钟 OHLCV | 标的分钟图可用；断线明确标旧 | 补洞策略、盘后数据和 Sequence 语义 |
| Streaming Account Activity | B：公开客户端列为已确认可用 | 用于订单与账户事件通知，再以 REST 做权威对账 | 事件覆盖范围、顺序、重复、断线补偿和字段 Schema |
| Level Two Order Book | B，但公开客户端注明部分字段来自社区逆向解释 | 首版不依赖、不展示，避免把不稳定字段用于交易决策 | 只有取得 A 级文档并单独测试后再考虑 |
| Preview Order | C：迁移资料明确列出新 Preview 端点；当前多个客户端实现也存在 | Preview-only 阶段的核心，但不把 Preview 当作成交保证 | A 级确认 Endpoint、Schema、费用、警告、拒单原因、有效期和是否计入订单限额 |
| Place Order | B：按账户提交复杂 Order Spec，成功订单 ID 常在响应 Header | 首个真实版本只发手动股票/ETF Regular Session Limit | A 级 Schema、价格/数量精度、Order ID、错误和账户支持 |
| Cancel Order | B：按账户和 Order ID 取消 | 首个真实版本支持，发送前先刷新状态；不自动重试 | 部分成交、Pending Cancel、超时和 Unknown 语义 |
| Replace Order | B：旧订单取消并创建新订单 | 首版延期，直到新旧 ID、部分成交和崩溃路径验证完整 | 完整状态机和幂等/重复风险 |
| 资金划转、入金、出金 | 当前公开 Trader API 客户端面未见此能力 | 明确不做 | 不需要为 MVP 继续探索 |
| Saved Orders / Watchlists | C：2023 资料称上线时没有；当前状态未取得 A 级证据 | 自选列表本地保存，不依赖 Schwab Watchlist | 若未来对接，重新核验当前官方端点 |

## 3. 能读到哪些数据，以及对应产品功能

### 3.1 账户与组合

可预期读取：关联账户、余额、现金、购买力、持仓数量、成本相关字段、当前订单和部分账户类型信息。

可实现：

- 总资产、现金和账户分布。
- 股票/ETF 持仓、数量、当前估值和未实现盈亏。
- 账户切换、别名和掩码。
- 卖出现有多头时的本地数量上限。

限制：不同账户的购买力和 Margin 字段不能共用一套猜测规则；任何字段未知时，该账户仍可展示，但不开放真实交易。

### 3.2 行情与标的

可预期读取：Bid、Ask、Last、成交量、日内高低、昨收、净变化、52 周高低、部分基本面、历史 OHLCV、市场时间和 Option Chain。

可实现：

- 自选、搜索、标的详情、价格图和市场状态。
- 实时/延迟/缓存/未知标签。
- 组合当前估值和限价偏离检查。

限制：行情可能延迟、顺序不完整或中断。Schwab 当前协议也明确不保证市场信息准确、及时、完整或顺序正确，因此交易确认不能只凭一个 Last Price；必须显示数据时间和资格。

### 3.3 订单与流水

可预期读取：订单状态、时间、方向、数量、价格、成交信息、交易流水、股息/利息、ACH、Wire、Journal 等类别。

可实现：

- Orders 页面和订单生命周期。
- 最近活动和活跃热力图。
- 外部现金流分类、股息和日收益重建。
- App 崩溃或超时后的订单对账。

限制：公开客户端显示订单和流水查询通常围绕最近 60 天，长期收益热力图不能假设 API 随时返回多年完整流水。FolioHelm 要从用户开始使用后持续保存本地加密快照，并把缺失历史标记为 estimated 或 incomplete。

## 4. 高频刷新、自动化与高频交易不是一件事

FolioHelm 支持“看起来实时”的行情界面；自动化和高频交易不进入首个真实交易版本，但保留后续评估：

- 高频刷新：通过 WebSocket Streaming 接收行情和账户活动，适合 UI 更新，不消耗每个 Tick 的 REST 请求。
- 自动化：提醒、草稿、Preview、定时规则和有界无人值守执行可以分级实现，每一级使用不同权限和风险门槛。
- 高频交易：算法连续 Place / Cancel / Replace 或低延迟决策，需要明确的 Broker 支持、限流、执行语义和可靠基础设施；当前资料不足以承诺可行。

原因不仅是 API 限流，还包括订单结果不明确、网络延迟、行情 entitlement、市场数据许可、部分成交、Cancel / Replace 竞态和个人桌面设备可靠性。即使 Broker 允许较高请求数，也不代表客户端适合做 HFT。无法保证绝对零错误；如果残余风险和最坏损失无法被明确限制，相关级别就不发布。

## 5. 限流事实与本地策略

### 5.1 当前能说到什么程度

- C 级历史资料写明：Individual 和 Commercial 的非订单请求为每应用 120 次/分钟；订单相关为每账户 0–120 次/分钟，并在 App 注册时选择。
- B 级当前 `schwab-py` Getting Started 仍展示订单限额字段，并建议普通用户填写 120；它同时说明 Place、Cancel、Replace 超过该限额会被节流或拒绝。
- A 级当前官方数字尚未从登录门户取得。因此 120 不能作为 2026 当前保证，也不能硬编码。

### 5.2 FolioHelm 的保守默认

- 核验前非订单 REST 本地上限：60 次/分钟/应用，突发 10。
- 核验后运行预算：`min(当前官方限额 × 80%, App 实际配置, FolioHelm 本地预算)`。
- 真实订单动作：每账户最多 12 次/分钟、同时最多 1 个写请求在途；Cancel 有队列优先级。
- Place、Cancel、Replace 不自动重试；429 也不例外。
- Preview 是否进入订单桶，等待 A 级文档确认。
- Streaming 订阅集中管理并去重，不允许每个 React 组件独立开连接。

### 5.3 建议刷新频率

| 数据 | 主路径 | REST 兜底 |
| --- | --- | --- |
| 股票/ETF 报价 | Streaming Level One | 批量请求；只在 Streaming 不可用时，前台约 15 秒一次，后台停止 |
| 分钟图 | Streaming OHLCV | 切换 Symbol / 周期时拉取历史，不持续整段重拉 |
| 账户与持仓 | 启动、用户刷新、账户事件 | 正常 60 秒；交易确认期间 15 秒；后台 5 分钟 |
| 提交中或 Unknown 订单 | Account Activity + REST 对账 | 5 秒一次，最多 2 分钟；之后降低频率并保持 Unknown 锁定 |
| Working 订单 | Account Activity | 15 秒 |
| 已结束订单与流水 | 增量同步 | 60 秒或页面进入时 |
| 标的搜索 | REST | 至少 2 字符，350 毫秒 debounce，取消旧请求 |
| 历史收益 | 本地加密快照 | 启动增量和收盘后重算，不高频拉全量 |

这些是 FolioHelm 首版手动交易的保守预算，不是 Schwab 官方 SLA。Phase 0 应根据当前官方限额和真实 App 行为调整，但不得放宽“写请求不自动重试”。未来自动化必须使用独立 Profile，不能直接复用或放大首版限额。

## 6. 条款与开源分发的关键风险

- Schwab 当前 Online Services Agreement 限制未经批准的软件访问、未经书面批准的商业用途，以及公开或商业分发 Schwab 内容；Market Information 也不保证及时、完整或顺序正确。
- 2023 迁移资料把“免费或收费地把应用分发给其他自主管理账户使用”都描述为 Commercial use。
- 因此，“项目不提供服务器、用户各自申请 Individual API 并填入本机”在技术上可行，也能显著减少凭据托管风险，但不能自动证明开源分发属于 Individual use。

产品决定：

1. 可以先开发并公开 Mock 源码与演示构建。
2. 公开带 Schwab 连接能力的官方二进制前，必须查看当前登录门户条款或取得 Schwab 书面澄清。
3. 不再分发行情、不提供共享 API、不托管 Token、不抓取 Schwab 网页、不使用 Schwab Logo。
4. README 明确 FolioHelm 非 Schwab 官方产品，用户必须拥有并遵守自己的 Developer App 权限。

## 7. Phase 0 官方核验清单

用户的 Developer App 获批后，由主模型执行并归档脱敏结果：

- [ ] Product 名称、Individual / Commercial 定义和开源分发条件。
- [ ] 所有 MVP Endpoint、HTTP Method、Host、Schema 和错误结构。
- [ ] Preview 的 Endpoint、响应、费用、警告、拒单和限流归类。
- [ ] 非订单、订单、Streaming 的限额、作用域、Header 和 429 行为。
- [ ] 单次 Quote 最大 Symbol 数和 Streaming 最大订阅数。
- [ ] OAuth Callback、PKCE、Token 生命周期、Refresh 和撤销。
- [ ] 行情实时/延迟 entitlement 及本地缓存、截图、日志和再分发限制。
- [ ] Account Activity 的顺序、重复、补偿和断线行为。
- [ ] 股票/ETF Limit Place、Cancel、部分成交和 Unknown 的真实小额人工测试计划。
- [ ] 自动策略、定时执行、无人值守和高频订单操作的当前条款、专用限流与明确允许范围。

任何勾选项不能由社区文档代替 A 级证据；如果官方文档仍不明确，向 Schwab Developer Support 获取书面回复。
