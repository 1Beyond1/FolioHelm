# FolioHelm 实施方案 v1（已归档）

> 本版本采用 Electron，已经被 `implementation-plan-v2.md` 取代。保留此文件仅用于追踪决策演变，后续开发不得以本文件为实施依据。

状态：供产品与工程评审，尚未进入正式开发。

视觉基线：以 `design-preview/` 中已经确认的桌面首页为唯一视觉来源。后续页面延续其黑色底、灰黑层级、白色信息和荧光绿主交互，不擅自换成常规券商后台或通用 SaaS 仪表盘。

## 1. 产品定位

FolioHelm 是一个本地优先、开源、用户自带 Charles Schwab Developer API 凭据的桌面证券终端。

它不是：

- 托管用户凭据的在线服务；
- 行情或账户数据中转站；
- 自动交易机器人；
- 投资建议或荐股服务；
- 绕过 Schwab 资格、授权、风控或使用条款的工具。

每位用户自行申请自己的 Schwab App，自行完成 OAuth 授权，账户数据和令牌只保留在自己的电脑上。FolioHelm 仓库不提供共享 API Key、共享代理或内置 Schwab 账号。

## 2. 产品原则

1. 先保证资金和订单安全，再追求操作速度。
2. UI 可以简洁，但账户、行情和订单状态不能模糊。
3. Renderer 除用户首次输入 App Secret 的瞬时过程外，不保存、缓存或再次接收 App Secret；Access Token 和 Refresh Token 永远不进入 Renderer。
4. 所有金额和数量使用十进制定点语义，不能依赖 JavaScript 浮点数做交易计算。
5. 所有实时信息必须展示新鲜度：实时、延迟、缓存、离线或未知。
6. 所有派生收益必须展示数据质量：精确、估算或缺失。
7. 下单请求不因网络错误自动重试。
8. 自动化测试永远不调用真实下单接口。
9. 默认无遥测、无云同步、无远程脚本、无广告。
10. 未经确认，不扩大首版资产类别和订单类型。

### 2.1 资金安全威胁模型

FolioHelm 不托管资金，真正能造成财产损失的主要路径是：

1. 错误订单：方向、账户、标的、数量、价格或有效期错误。
2. 重复订单：双击、重试、崩溃恢复或多实例并发导致重复提交。
3. 状态误判：请求超时后订单已经到达券商，客户端却当成失败。
4. 过期信息：使用旧报价、旧持仓或旧购买力确认订单。
5. 凭据泄露：Token、Secret、完整账号进入 Renderer、日志、Fixture 或恶意依赖。
6. 供应链攻击：被篡改的安装包、更新包、依赖或构建流水线获得本机权限。
7. 权限扩大：UI 漏洞通过过宽 IPC 调用任意主进程能力。
8. 计算错误：浮点数、货币单位、小数位、时区或现金流分类错误。
9. 用户误触：页面过于追求“一键下单”，没有把订单事实讲清楚。
10. API 漂移：Schwab 字段或业务规则变化后被静默解释成 0 或默认值。

我们不能承诺零风险，但每一条路径都必须至少有两层独立防线，并且真实下单功能默认关闭。

### 2.2 不可破坏的交易不变量

以下规则不是 UI 建议，而是 Trading Core 的硬约束：

- 没有有效 Preview，不能 Submit。
- Submit 的规范化订单哈希必须与 Preview 完全一致。
- Preview、确认 Nonce 和会话解锁凭证都必须短时有效且单次使用。
- 账户、持仓和报价超过允许的新鲜度后，不能 Submit。
- 任何写请求结果不明确时，不能自动重试。
- 同一订单指纹处于 `submitting` 或 `unknown` 时，不能再次提交。
- 正在确认的账户必须与当前账户一致，账户切换立即使 Preview 失效。
- 卖出数量不能超过经刷新后的可用多头持仓。
- 首个真实交易版本不能卖空、不能使用保证金增强、不能交易期权。
- App 启动、唤醒、网络恢复、Token 刷新和 Streaming 重连都不能触发订单提交。
- 开发、测试和 CI 构建不能触达真实 Place/Cancel/Replace。
- 任何金额或数量进入 `number` 浮点运算都视为缺陷。

## 3. UI 冻结规则

### 3.1 已确认的品牌语言

- 页面背景：接近纯黑 `#050505`。
- 主卡片：`#141414`，抬升层 `#1A1A1A`，弱层 `#202020`。
- 主文本：偏暖白 `#F5F5F1`。
- 次文本：`#8B8B87` / `#B7B7B2`。
- 主交互与品牌色：荧光绿 `#B7FF22`。
- 正收益辅助色：`#57E68A`。
- 负收益语义色：低饱和莓红，基准 `#E85C87`；现有原型中的 `#FF5B8F` 只用于极少量高强调文本，不用于大面积背景。
- 不使用蓝色作为默认主按钮，不加入玻璃拟态泛光，不堆叠过量描边。

### 3.2 热力图双模式

热力图顶部增加一个紧凑分段切换：

- `活跃`：展示每天发生的订单、成交、股息、入金/出金等事件数量。
- `收益`：展示每天的组合收益，可在 `%` 和 `$` 之间切换。

切换模式时只替换热力图的数据、图例、摘要和 Tooltip，不改变卡片尺寸，避免整个首页跳动。

### 3.3 活跃模式

- 0 次：`#282828`。
- 1 级：`#354A1D`。
- 2 级：`#597E1C`。
- 3 级：`#82BD1B`。
- 4 级：`#B7FF22`。
- 分级依据采用当年非零天数的分位数，不写死“4 次一定是最高级”，避免重度和轻度用户的图都失真。
- Tooltip 显示日期、总事件数以及订单/成交/股息/资金流水拆分。

### 3.4 收益模式

收益图采用以 0 为中心的双向色阶。纯红会突兀，因此负收益使用偏紫的莓红：

| 语义 | 颜色 |
| --- | --- |
| 无数据或非交易日 | `#1B1B1B` |
| 约等于 0 | `#2A2A2A` |
| 小幅盈利 | `#354A1D` |
| 中幅盈利 | `#597E1C` |
| 较大盈利 | `#82BD1B` |
| 最大盈利档 | `#B7FF22` |
| 小幅亏损 | `#3A232C` |
| 中幅亏损 | `#6F3146` |
| 较大亏损 | `#A83E62` |
| 最大亏损档 | `#E85C87` |

额外规则：

- 莓红只出现在负数、热力单元格和必要状态中，不成为品牌按钮色。
- 为避免只靠颜色传达信息，亏损单元格增加很轻的内侧短线或斜纹；键盘聚焦时 Tooltip 明确显示负号。
- 正负强度按当年绝对收益的分位数分别计算，避免一次异常波动让其余 364 天全部挤在最浅档。
- Tooltip 显示：日期、当日盈亏金额、当日收益率、期初/期末市值、外部净现金流、数据质量。
- 摘要切换为：盈利天数、亏损天数、持平/无数据天数、当年累计收益。

### 3.5 热力图的数据真实性

Schwab 的账户接口不能被假设为提供任意历史日期的组合净值。收益热力图属于 FolioHelm 的本地派生数据，不能拿当前持仓倒推一年后伪装成精确历史。

从第一次成功连接开始，程序保存账户与持仓快照。缺失日期只能在取得完整成交/资金流水和历史收盘价后重建，并带上质量标记：

- `exact`：存在可信的期初/期末快照和完整外部现金流。
- `estimated`：根据成交、交易流水和历史价格重建。
- `incomplete`：存在期权、公司行动、缺失流水或缺失价格，无法可靠计算。

`incomplete` 单元格显示为灰色虚线，不给出看似精确的收益率。

### 3.6 每日收益算法

美元盈亏（BMV/EMV 均指包含现金在内的账户总权益，而不是只计算证券市值）：

```text
daily_pnl = ending_portfolio_value - beginning_portfolio_value - net_external_cash_flow
```

其中入金和出金是外部现金流；股息、利息和证券价格变化属于投资回报，不作为外部现金流剔除。

百分比收益优先采用 Modified Dietz：

```text
return = (EMV - BMV - sum(CF)) / (BMV + sum(weight_i * CF_i))
```

- `weight_i` 是从现金流发生时刻到计算期结束的剩余时间占比；越早发生，权重越接近 1。
- 无可靠时间时使用中点权重并标记为 `estimated`。
- 分母为 0 或数据不足时返回 `null`，不返回 0%。
- 日期归属统一使用 `America/New_York` 的交易日；Tooltip 可同时显示用户本地时间。

首版只承诺股票和 ETF 的可靠重建。期权历史估值、组合腿、公司行动和复杂税务成本基础放到后续版本。

## 4. 首版功能范围

### 4.1 MVP 必做

1. 本地欢迎页与 Schwab 连接向导。
2. App Key、App Secret 和 Callback URL 配置。
3. 系统浏览器 OAuth 登录与授权状态管理。
4. 多账户选择、账户别名和掩码显示。
5. 总资产、现金、购买力、当日变化。
6. 股票/ETF 持仓、成本、现价、市值、浮动盈亏。
7. 标的搜索、报价、历史价格、基础详情。
8. 自选列表。
9. 当前订单、历史订单、成交和交易流水。
10. 本地账户快照与活跃/收益双模式热力图。
11. Mock 模式；无需凭据即可体验全部 UI。
12. 本地日志与一键导出脱敏诊断包。

### 4.2 下单首版

Preview-only 阶段可以展示 Market 和 Limit，但首个真实交易版本只支持：

- 股票和 ETF；
- 买入与卖出已有多头持仓；
- Regular Session；
- Limit；
- Day 和 GTC，仅在当前 API 文档和账户能力确认支持时开放；
- Preview、Place、Cancel；Replace 在确认 API 语义后开放。

Market Order 等系统经过公开测试、行情新鲜度和异常成交风险评审后再开放。这样可以避免流动性不足、熔断或报价异常时出现远超预期的成交价格。

默认不支持：

- 期权、组合期权；
- 卖空和借券；
- 保证金增强功能；
- 条件单、OCO、OTO；
- 自动交易、定时交易、跟单；
- 扩展时段；
- 转账、入金和出金；
- AI 推荐买卖。

### 4.3 后续版本候选

- Stop / Stop Limit 与扩展时段。
- 期权链、Greeks 和单腿期权。
- 多腿期权和策略可视化。
- 更完整的组合归因、基准对比和税务批次。
- macOS 与 Linux 正式分发。
- 插件化 Broker Adapter，但首版不为“未来可能”提前堆抽象。

## 5. 页面与导航

### 5.1 一级页面

1. `Home`：已确认的首页；资产摘要、组合曲线、快捷操作、热力图、持仓和近期活动。
2. `Markets`：搜索、自选、报价列表、市场时段和数据新鲜度。
3. `Instrument`：标的详情、价格图、持仓摘要、相关订单和买卖入口。
4. `Portfolio`：账户分布、持仓、现金、收益和交易流水。
5. `Orders`：工作中、已成交、已取消、被拒绝、状态未知。
6. `Trade`：票据编辑、预览、确认和结果。
7. `Settings`：连接、账户别名、安全、日志、数据与外观。

### 5.2 关键全局状态

顶栏必须能同时表达：

- 当前账户；
- API 已连接/需重授权/离线；
- 市场开盘/休市；
- 行情实时/延迟/缓存；
- 交易已锁定/本次会话已解锁；
- 最后同步时间。

任何页面都不能仅用一个绿色圆点笼统表示“都正常”。

## 6. 技术选型

### 6.1 桌面框架

首版采用 Electron + React + TypeScript。

理由：

- 当前环境已经有成熟 Node 工具链，而 Tauri 需要额外引入 Rust 工具链。
- OAuth 回调、本地安全存储、系统浏览器、文件系统、SQLite 和打包在 Electron 主进程中更直接。
- Luna Max 更容易在清晰边界下完成 TypeScript 和前端机械实现。
- 代价是安装包和内存更大；这是首版可以接受的成本，不能用它换取安全边界和交付难度上升。

构建与打包采用 Electron Forge 的第一方 `webpack-typescript` 模板，再加入 React。暂不采用 Forge Vite 模板，因为其官方文档仍将 Vite 支持标为 experimental。等首版稳定后再评估迁移。

### 6.2 主要依赖类别

- UI：React、CSS Modules、原生 SVG。
- 异步数据：TanStack Query。
- 轻量界面状态：Zustand，只保存筛选、面板和主题等临时状态。
- 运行时校验：Zod。
- 金额与数量：Decimal.js 或同级十进制库，最终由架构评审锁定一个。
- 本地数据库：SQLite；首选 `better-sqlite3`，只允许主进程访问。
- 测试：Vitest、React Testing Library、Playwright。
- 代码质量：ESLint、Prettier、TypeScript strict。

依赖版本在脚手架阶段锁定，不在方案文档里写死“最新版本”。

### 6.3 为什么不用 Tailwind

当前 UI 的价值来自细致的比例、留白、层级和少量定制效果。CSS Modules + 设计 Token 更容易忠实保留这套语言，也能避免 Luna 把页面逐步写成模板化后台。

### 6.4 技术栈安全复核

| 方案 | 优点 | 主要风险 | 结论 |
| --- | --- | --- | --- |
| Electron + TypeScript | OAuth、系统集成、打包和团队能力最成熟；官方安全文档完整 | Chromium/Node 攻击面较大，错误 IPC 会扩大权限 | 首版采用，但执行完整加固清单 |
| Tauri + Rust | 后端内存安全、安装包小、Capability 权限模型细 | 新增 Rust 和插件链；团队陌生实现本身会制造安全风险；系统 WebView 存在平台差异 | 首版不采用，读-only MVP 后重新评估 |
| C# / WinUI | Windows 原生集成和凭据能力好 | Windows 锁定、跨平台重写、当前 UI/团队效率下降 | 不作为开源首版 |
| 浏览器/PWA | 部署简单 | App Secret、本地回调、系统安全存储和真实交易边界不理想 | 排除 |

选择 Electron 不等于把它当网页壳。生产构建的 Renderer 必须近似一个无本机权限的静态页面，所有特权集中在体积尽量小、可审计的 Main 模块。

### 6.5 数据库与数值实现

- 不使用 ORM 自动生成交易关键 SQL，采用版本化迁移和参数化语句，减少隐式转换。
- `node:sqlite` 在当前 Node 官方文档中仍处于 release candidate，首版不把资金相关数据层压在尚未稳定的 API 上。
- 首选经过兼容性 Spike 的 `better-sqlite3`，锁定精确版本并在每个 Electron 升级后重新构建和回归。
- SQLite 启用 WAL、Foreign Keys 和交易关键写入的 `synchronous=FULL`。
- 禁止动态加载 SQLite Extension。
- 订单 Journal、Preview、Intent 和 Broker Receipt 必须在事务中写入。
- 金额与数量在 API、领域对象和数据库之间保持 Decimal String；只在展示层格式化，不能先转成 `number`。
- 十进制库锁定后以属性测试覆盖进位、极小数量、极大金额和不同证券精度。

## 7. 进程和信任边界

```text
Renderer (React UI)
  │  only typed, allowlisted IPC methods
  ▼
Preload (contextBridge)
  │  schema-validated request/response
  ▼
Electron Main
  ├─ OAuth and encrypted secret store
  ├─ Schwab REST and streaming clients
  ├─ Rate limiter and retry policy
  ├─ Order orchestrator and safety state machine
  ├─ Sync/performance services
  └─ SQLite repositories and sanitized logs
```

### 7.1 Renderer

- `nodeIntegration: false`。
- `contextIsolation: true`。
- `sandbox: true`。
- 不导入 `electron`、`fs`、数据库驱动或 Schwab 客户端。
- 不接收任何 Token；App Secret 只在用户提交连接表单的瞬间存在于未持久化输入控件，发送给 Main 后立即清空。
- 不加载远程 JavaScript、远程 HTML 或 WebView。
- 所有 API 数据先经过主进程归一化和 Zod 校验。

### 7.2 Preload

只暴露类似以下的窄接口：

```ts
interface FolioHelmBridge {
  connection: {
    getStatus(): Promise<ConnectionStatus>;
    saveCredentials(input: OneTimeCredentialInput): Promise<void>;
    startOAuth(input: StartOAuthInput): Promise<OAuthStartResult>;
    disconnect(): Promise<void>;
  };
  portfolio: {
    getSummary(input: AccountQuery): Promise<PortfolioSummary>;
    getHeatmap(input: HeatmapQuery): Promise<HeatmapYear>;
  };
  trading: {
    preview(input: OrderDraft): Promise<OrderPreview>;
    submit(input: ConfirmedOrderInput): Promise<OrderSubmissionResult>;
    cancel(input: CancelOrderInput): Promise<OrderMutationResult>;
  };
}
```

禁止暴露 `ipcRenderer.send`、任意频道、任意 URL 请求或任意文件读写。

### 7.3 Main

只有主进程可以：

- 解密凭据和 Token；
- 连接 Schwab REST/Streaming；
- 读写 SQLite；
- 打开经过 allowlist 校验的 OAuth URL；
- 发起订单相关请求；
- 生成脱敏诊断包。

所有 IPC 都校验 sender、channel、payload 和 response schema。

### 7.4 生产构建加固

生产包必须设置并自动验证以下 Electron Fuses：

- `RunAsNode: false`
- `EnableNodeOptionsEnvironmentVariable: false`
- `EnableNodeCliInspectArguments: false`
- `EnableEmbeddedAsarIntegrityValidation: true`
- `OnlyLoadAppFromAsar: true`
- `GrantFileProtocolExtraPrivileges: false`
- `EnableCookieEncryption: true`

同时执行：

- 生产环境关闭 DevTools、远程调试端口和实验性 Chromium 特性。
- `webSecurity` 永远开启，证书错误永远不忽略。
- 所有 Permission Request 默认拒绝。
- 使用自定义本地协议，不使用高权限 `file://`。
- `will-navigate` 和 `setWindowOpenHandler` 默认拒绝；系统浏览器只允许固定 Schwab OAuth 域名和文档域名。
- 使用 `app.requestSingleInstanceLock()`；第二实例不能进入交易流程。
- 休眠恢复、系统时间大幅变化、网络切换或账户切换后，交易会话立即锁定，所有 Preview 失效。
- 官方公开包必须代码签名；未签名开发包和本地调试包硬性只读。
- 在签名更新链建立前不启用自动更新；任何更新都不能下载后绕过签名校验执行。
- 构建后运行 Fuse 检查、ASAR 完整性检查和安装包哈希生成。

### 7.5 依赖和供应链

- `package-lock.json` 必须提交，CI 只运行 `npm ci`。
- 生产依赖保持最小；图标、日期格式和简单工具优先自己实现，不为了几行代码增加包。
- 依赖升级由主模型审查 Changelog、权限、安装脚本和维护状态，禁止机器人自动合并。
- 每次发布生成 SBOM、依赖许可证清单和构建产物 SHA-256。
- CI Secret 仅用于代码签名，不能包含任何 Schwab 用户凭据。
- Release Workflow 最小权限、固定 Action Commit SHA、保护 Tag；正式产物只从受保护流水线生成。
- 真实交易发布前需要一次独立安全审计；审计未通过则继续只读发布。

## 8. OAuth 与凭据

### 8.1 首次连接流程

1. 用户在 Schwab Developer Portal 创建自己的 App。
2. FolioHelm 显示需要复制到 Portal 的 Callback URL。
3. 用户本地输入 App Key 和 App Secret。
4. Renderer 使用不进入全局状态和日志的一次性表单，把输入交给 Main，随后立即清空控件和临时变量。
5. Main 使用系统安全存储加密凭据。
6. Main 在系统浏览器打开经过固定域名 allowlist 验证的授权 URL。
7. 本地回调接收 Authorization Code，校验 `state`，交换 Token。
8. Token 加密保存，Renderer 只收到连接状态和到期时间。
9. 获取账户列表，用户设置本地别名。

### 8.2 必须先做的 OAuth 技术验证

在大规模开发前，用一个独立 spike 验证：

- Schwab 当前允许的 Callback URL 形式；
- HTTP/HTTPS、localhost/127.0.0.1 和端口规则；
- 授权码、Refresh Token 生命周期和重新授权条件；
- App 尚未批准、Token 过期、用户取消授权时的错误结构；
- 空余额账户能否正常返回账户和权限信息；
- 是否存在可用的订单 Preview 能力。

上述信息以用户登录后看到的当前官方文档和真实只读响应为准，不把社区文档当成最终契约。

### 8.3 安全存储

- 使用 Electron `safeStorage` 异步 API。
- Windows 使用 DPAPI，macOS 使用 Keychain。Windows 上它主要隔离其他系统用户，不把它宣传成能抵御同一登录用户下所有恶意程序的硬件保险箱。
- Linux 如果后端为 `basic_text` 或安全存储不可用，禁止保存 Token 并禁用真实交易。
- 数据库只存密文和元数据，不存明文。
- “断开账户”删除密文、会话和本地账户映射；历史派生数据是否保留由用户明确选择。
- 日志、异常和诊断包永远不包含 Secret、Token、Authorization Code、完整账号或完整订单原始响应。

## 9. Schwab Adapter

UI 不直接依赖 Schwab JSON。先归一化为 FolioHelm 的领域类型：

```ts
interface BrokerAdapter {
  capabilities(): Promise<BrokerCapabilities>;
  listAccounts(): Promise<BrokerAccount[]>;
  getAccountSnapshot(accountId: AccountId): Promise<AccountSnapshot>;
  listOrders(query: OrderQuery): Promise<BrokerOrder[]>;
  listTransactions(query: TransactionQuery): Promise<BrokerTransaction[]>;
  getQuotes(symbols: Symbol[]): Promise<Quote[]>;
  getPriceHistory(query: PriceHistoryQuery): Promise<PriceBar[]>;
  previewOrder(draft: BrokerOrderDraft): Promise<BrokerOrderPreview>;
  placeOrder(order: BrokerConfirmedOrder): Promise<BrokerOrderReceipt>;
  cancelOrder(orderId: BrokerOrderId): Promise<void>;
  replaceOrder?(input: ReplaceOrderInput): Promise<BrokerOrderReceipt>;
}
```

`BrokerCapabilities` 必须驱动 UI。接口不支持的订单类型直接不显示，不能显示后再等 API 报错。

### 9.1 API 客户端模块

- `SchwabAuthClient`：授权 URL、Code Exchange、Refresh、Revoke/Disconnect。
- `SchwabTraderClient`：账户、持仓、订单和交易流水。
- `SchwabMarketDataClient`：报价、历史价格、期权链和交易时段。
- `SchwabStreamingClient`：实时行情、账户活动和重连。
- `SchwabResponseMapper`：把外部 JSON 转成领域模型。
- `SchwabErrorMapper`：把 HTTP/业务错误转换成稳定错误码。

### 9.2 限流与重试

- 所有请求进入 Main 的中央调度器。
- 行情、账户读取和订单使用不同队列。
- GET 可对明确的 429/5xx 使用指数退避和抖动。
- Token Refresh 采用单飞锁，避免多个请求同时刷新。
- 订单 POST 不自动重试。
- Streaming 断线后指数退避重连，并退化为标记清晰的轮询模式。
- 当前限流数字在用户 App 获批后从官方文档确认；代码使用配置和服务端响应，不把旧数字散落在业务代码里。

## 10. 本地数据模型

### 10.1 建议表

```text
schema_migrations
app_meta
settings
broker_connections
accounts
account_snapshots
position_snapshots
orders
order_events
transactions
daily_performance
watchlists
watchlist_items
sync_state
sanitized_errors
```

### 10.2 核心字段

`broker_connections`

- `id`
- `broker`
- `encrypted_app_key`
- `encrypted_app_secret`
- `encrypted_access_token`
- `encrypted_refresh_token`
- `access_token_expires_at`
- `refresh_token_expires_at`
- `created_at` / `updated_at`

`accounts`

- `id`：本地 UUID。
- `broker_connection_id`
- `broker_account_hash`：不可逆稳定映射。
- `display_alias`
- `masked_account_label`
- `account_type`
- `is_enabled`

`account_snapshots`

- `account_id`
- `captured_at`
- `trading_date`
- `cash_value`
- `market_value`
- `liquidation_value`
- `buying_power`
- `source`
- `quality`

`position_snapshots`

- `account_snapshot_id`
- `symbol`
- `asset_type`
- `quantity`
- `average_price`
- `market_price`
- `market_value`
- `unrealized_pnl`

`daily_performance`

- `account_id`
- `trading_date`
- `beginning_market_value`
- `ending_market_value`
- `net_external_cash_flow`
- `daily_pnl`
- `daily_return`
- `cumulative_return`
- `quality`
- `calculation_version`
- `computed_at`

所有金额、价格、数量和比率以十进制字符串或 SQLite 精确整数/文本形式持久化，不以 IEEE 754 `REAL` 作为资金真值。

## 11. 同步和离线策略

### 11.1 启动同步

1. 读取本地缓存，立即显示并标注缓存时间。
2. 检查安全存储和 Token 状态。
3. 刷新账户摘要和持仓。
4. 增量同步订单与交易流水。
5. 批量刷新当前页面需要的报价。
6. 更新当日快照和收益。
7. 建立 Streaming；失败则进入轮询。

### 11.2 快照

- App 打开时、账户发生重大变更时和美东收盘后尽量保存快照。
- 因为本地桌面程序可能未运行，不承诺每个自然日都有直接快照。
- 下次启动时尝试重建缺失日，并保留质量标记。
- 用户可手动“重新计算收益”，计算过程版本化且可回滚。

### 11.3 离线

- 离线可查看最后缓存的组合、订单和热力图。
- 所有价格旁显示“截至时间”。
- Trade 页面只允许编辑草稿，不允许 Preview 或 Submit。
- 恢复网络后不自动提交任何离线草稿。

## 12. 下单安全状态机

```text
draft
  -> validating
  -> previewing
  -> previewed
  -> confirming
  -> submitting
  -> submitted
  -> accepted / working
  -> partially_filled
  -> filled / canceled / rejected

任何网络结果不明确：submitting -> unknown
```

### 12.1 Draft 与 Preview

- 输入变化后立即使旧 Preview 失效。
- Preview 绑定订单草稿的规范化哈希。
- Preview 包含账户、方向、标的、数量、订单类型、限价、有效期、预估金额、费用、剩余现金/持仓、行情时间和警告。
- 行情过期或账户状态变化时必须重新 Preview。
- 卖出数量超过可用持仓、零/负数量、小数位非法、限价越界等在本地先拦截。

### 12.2 Confirm 与 Submit

- 默认每次启动都处于“交易锁定”。
- 用户显式解锁本次会话后才允许进入最终确认。
- 最终确认页显示完整、可读的自然语言订单摘要。
- Submit 只接收 `previewId + draftHash + confirmationNonce`，不重新接收任意订单字段。
- 点击后按钮立即锁定，防止双击。
- 使用本地提交指纹记录“正在提交”的订单。
- 网络超时或连接中断后进入 `unknown`，先查询近期订单和活动，绝不自动重发。

### 12.3 Cancel 与 Replace

- 操作前先刷新订单当前状态。
- Filled、Canceled、Rejected 不允许继续操作。
- Cancel 同样不做盲目自动重试。
- Replace 视为新的预览/确认流程，不能在旧订单对象上直接修改后发送。

### 12.4 双层交易守卫

真实订单必须连续通过两套独立检查：

1. `TradingPolicy`：纯函数模块，不联网，检查账户、资产类别、方向、数量、价格、持仓、购买力、限额、交易时段、数据新鲜度和功能开关。
2. `OrderOrchestrator`：有状态模块，检查 Preview Hash、Nonce、会话锁、重复指纹、Journal 和当前 Broker 状态，然后才有权调用 Adapter 的写接口。

Renderer 的按钮状态不属于安全控制。即使恶意代码直接调用 IPC，Main 里的两层守卫仍必须拒绝非法请求。

### 12.5 崩溃安全订单 Journal

提交必须遵循以下顺序：

1. Main 重新加载不可变 Preview，校验 Hash、过期时间和单次 Nonce。
2. 重新获取或确认账户、持仓和行情新鲜度。
3. 执行 `TradingPolicy`。
4. 在 SQLite `synchronous=FULL` 事务中写入 `order_intent`，状态为 `prepared`。
5. 在同一 Journal 中写入 `dispatch_started_at`，状态改为 `submitting`。
6. 对 Schwab 只发送一次 Place 请求。
7. 收到确定响应后保存 Broker Order ID、响应摘要和状态。
8. 如果进程崩溃、超时或无法判断响应，状态固定为 `unknown`。

App 下次启动时，任何 `submitting/unknown` Intent 都会先进入对账页。程序查询 Schwab 当日订单和账户活动，按 Broker Order ID 或严格的账户、标的、方向、数量、限价和时间窗口匹配：

- 唯一匹配：绑定现有 Broker Order，继续跟踪。
- 没有匹配：仍不自动重发，由用户查看后重新创建订单。
- 多个可能匹配：显示冲突并锁定该账户的新增订单，直到用户明确处理。

### 12.6 本地风险限额

首次启用真实交易时必须配置，不能留空或选择无限：

- 单笔最大名义金额。
- 单日累计提交金额；包含从 Schwab 同步到的当日其他订单。
- 单笔最大数量。
- 允许交易的账户。
- 限价相对最新可信报价的最大偏离比例。

默认还执行：

- 未成交订单占用相应现金或可卖数量，不能重复使用同一资源。
- Cash Account 不能依赖尚未结算资金，具体规则由 Schwab 返回的购买力字段决定。
- 市场闭市、行情状态未知或报价过期时禁止首版真实提交。
- 不允许通过键盘 Enter 直接完成最终 Submit。
- 最终按钮显示动作本身，例如“以 $182.40 限价买入 10 股 AAPL”，不使用含糊的“确认”。
- 会话解锁在 10 分钟无操作、窗口锁屏、休眠、网络切换或重授权后失效。
- 用户提高风险限额后，本次已有 Preview 全部失效；降低限额立即生效。

### 12.7 真实交易上线门槛

同时满足才开启：

1. 只读功能稳定。
2. OAuth 与 Token 刷新覆盖所有错误状态。
3. Mock E2E 全通过。
4. 下单状态机单元测试全通过。
5. Preview 与真实 API 契约经过人工核验。
6. 重复提交、超时未知、Token 过期和限流场景均验证。
7. 日志脱敏审计通过。
8. Electron Fuse、ASAR 完整性和安装包签名检查通过。
9. 依赖/SBOM/发布链审计通过。
10. 独立安全审查没有未处理的高危或严重问题。
11. 用户配置本地风险限额并手动启用实验性真实交易。

第一笔真实测试必须由用户本人在界面内确认小额订单；开发自动化不执行。

## 13. 目录结构

```text
FolioHelm/
  design-preview/             # 已批准视觉原型，只作参考
  docs/
    implementation-plan-v1.md
    architecture-decisions/
    api-notes/
    security/
  src/
    main/
      auth/
      broker/
        schwab/
      ipc/
      orders/
      performance/
      rate-limit/
      storage/
      streaming/
      sync/
    preload/
    renderer/
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
    shared/
      contracts/
      domain/
      errors/
      schemas/
  tests/
    fixtures/
    unit/
    component/
    e2e/
```

## 14. 测试策略

### 14.1 单元测试

- 金额、价格和数量精度。
- Modified Dietz 和美元盈亏。
- 现金流分类。
- 热力图分位数和颜色映射。
- 时区、周末、节假日和跨年。
- Schwab 响应映射和缺失字段。
- Token 单飞刷新。
- 限流器和退避。
- 日志脱敏。
- 订单草稿哈希。
- 完整下单状态机和非法状态转换。
- TradingPolicy 的账户、持仓、限额、报价新鲜度和时段组合。
- Decimal 属性测试：任何往返转换不能改变数量、价格或名义金额。
- Nonce 单次消费、过期和并发竞争。
- Journal 在每一个可能崩溃点恢复后的状态。

### 14.2 组件测试

- 加载、空账户、错误、离线、部分数据和重授权状态。
- 热力图键盘操作、Tooltip 和色彩之外的亏损提示。
- 订单 Preview 失效规则。
- 大数字、长股票代码和不同系统缩放。

### 14.3 E2E

Playwright 只连接确定性 Mock Broker：

- 首次启动与 Mock 体验。
- 连接向导各错误分支。
- 账户切换。
- 首页响应式布局。
- 活跃/收益热力图切换。
- 搜索到订单预览。
- 双击提交只生成一次 Mock 请求。
- 两个窗口或两个实例同时确认只允许一次。
- 提交超时进入 Unknown，查询后恢复状态。
- 在 HTTP 请求发送前、发送后和响应写库前分别强制终止进程，重启后均不能自动重复提交。
- 休眠/唤醒、切换账户和修改风险限额会使 Preview 失效。
- 离线时禁止提交。

### 14.4 契约测试

- 使用脱敏后的真实响应 Fixture。
- Fixture 不进入任何凭据、账号或个人信息。
- CI 不配置真实 Schwab Secret。
- 外部响应有新字段可以忽略，关键字段缺失必须显式失败，不能静默变成 0。

### 14.5 故障注入与发布验证

- 模拟 DNS、TLS、429、401、500、连接重置、半开连接和超时。
- 模拟系统时间错误、磁盘写满、SQLite Busy、数据库损坏和安全存储暂时不可用。
- 模拟 Broker 返回成功但缺少 Order ID，以及返回错误但订单列表出现匹配订单。
- 安装包必须通过 Fuse 读取、签名校验、ASAR 完整性和病毒扫描。
- 每个发布候选版本在完全没有 Schwab 凭据的干净 Windows VM 中验证只读默认值。
- 任何故障注入测试导致自动重发、错误账户下单或错误数量，均为阻断发布的最高级缺陷。

## 15. 错误和诊断

稳定错误码示例：

- `AUTH_REAUTH_REQUIRED`
- `AUTH_CALLBACK_MISMATCH`
- `TOKEN_REFRESH_FAILED`
- `ACCOUNT_PERMISSION_DENIED`
- `QUOTE_STALE`
- `RATE_LIMITED`
- `ORDER_PREVIEW_REJECTED`
- `ORDER_SUBMISSION_UNKNOWN`
- `ORDER_REJECTED`
- `SECURE_STORAGE_UNAVAILABLE`
- `PERFORMANCE_DATA_INCOMPLETE`

用户界面显示人话，日志记录错误码、阶段和 Request ID。两者都不显示 Secret、Token 或完整账号。

## 16. 开源与合规边界

- 仓库使用中性品牌，不使用 Schwab Logo，不暗示官方背书。
- README 明确“非 Charles Schwab 官方产品”。
- 不提交 API Key、Secret、Token、真实账户 Fixture 或截图中的个人信息。
- 不提供共享行情缓存、云端代理或市场数据再分发。
- 不通过抓取 Schwab 网页补齐 API 缺失能力。
- 每位用户必须通过官方 Developer Portal 获取许可。
- 在公开发布可下单版本前，针对“用户自带凭据的开源客户端分发”向 Schwab 获取书面澄清或确认当前 API 条款允许。
- 首个公开版本可以先只读；真实交易能力在合规和安全门槛通过后单独标记为实验功能。

## 17. 分阶段实施

### Phase 0：架构与 API 真实性验证

负责人：主模型。

产出：

- 当前 Schwab 文档能力矩阵。
- OAuth Callback Spike。
- 脱敏响应结构。
- ADR：Electron、构建工具、数据库、十进制库。
- 风险清单和合规待确认项。

验收：能完成 OAuth、读取账户/报价并退出；不写订单；没有秘密出现在 Renderer 或日志。

### Phase 1：安全桌面壳与 Mock 模式

负责人：主模型制定边界，Luna Max 机械实现。

产出：

- Electron/React/TypeScript 脚手架。
- Main/Preload/Renderer 边界。
- CSP、自定义本地协议、窗口导航限制。
- Mock Broker。
- 测试、Lint、类型检查和打包命令。

验收：安装包可启动；Renderer 无 Node 权限；无真实 API；所有检查通过。

### Phase 2：把已批准 UI 迁入正式应用

负责人：主模型做视觉审查，Luna Max 转组件。

产出：

- Design Token。
- App Shell、Sidebar/Topbar、Card、Segment、Metric、Heatmap、Position Row。
- 1280×800 和 1440×1024 视觉快照。
- 深色主题完整；亮色主题只建立 Token 接口，暂不牺牲深色完成度。

验收：与批准截图并排比较无明显风格漂移，无横向溢出，键盘焦点清楚。

### Phase 3：安全存储与本地数据库

负责人：主模型定义 schema 和迁移，Luna Max 按 SQL 实现。

产出：

- `safeStorage` 封装。
- SQLite migration/repository。
- 日志脱敏器。
- 数据删除和诊断导出。

验收：数据库无明文 Secret/Token；迁移可重复；安全存储不可用时真实交易被锁死。

### Phase 4：只读 Schwab 功能

负责人：主模型负责 OAuth、接口契约和错误映射；Luna Max 实现已定类型的 Mapper、Repository 和 UI。

产出：

- 连接向导。
- 账户、持仓、报价、自选、订单历史和流水。
- 缓存、增量同步、离线状态。
- 数据新鲜度和重授权提示。

验收：空账户、有持仓账户、断网、Token 过期和限流均有明确状态；无订单写操作。

### Phase 5：热力图与收益引擎

负责人：主模型锁定公式和质量规则；Luna Max 按测试向量实现。

产出：

- 快照调度。
- 现金流分类。
- Daily Performance 计算和版本化。
- 活跃/收益、%/$ 切换。
- 缺失/估算状态。

验收：固定样例与手工计算一致；入金不会被算成盈利；缺失数据不会显示虚假 0%。

### Phase 6：Preview-only 交易

负责人：主模型负责订单领域模型、安全状态机和 API 契约；Luna Max 做票据 UI、只读状态和测试。

产出：

- 股票/ETF Market/Limit 草稿与 Preview；Market 在此阶段仍不可真实提交。
- 本地校验。
- Preview 页面。
- Quote Staleness 和 Preview 失效。

验收：整个应用不存在可达的 Place Order 调用；Preview 变更后必失效。

### Phase 7：实验性真实交易

负责人：主模型直接实现或逐行审查所有写接口代码。

产出：

- 会话交易锁。
- 首版只开放 Regular Session Limit Order。
- Confirm/Submit。
- 双层交易守卫、本地风险限额和崩溃安全 Journal。
- Unknown Resolution。
- Order Center、Cancel 和经验证后的 Replace。

验收：重复点击、进程崩溃、超时、断网、刷新 Token、限流、多实例和状态竞争测试通过；签名/完整性/独立安全审查通过；用户本人完成小额人工测试。

### Phase 8：开源发布

产出：

- README、Threat Model、隐私说明和 Developer App 配置指南。
- Windows 签名与安装包。
- SBOM、依赖审计和 Release Checklist。
- GitHub Issue/PR 模板，禁止提交凭据。

验收：新用户只读文档即可完成 Mock 模式；真实接入路径不要求把凭据发给项目维护者。

## 18. Luna Max 执行协议

Luna Max 只接收窄、确定、可验收的工作包。一个任务一般控制在 1 至 6 个文件，完成后由主模型审查 diff、运行检查，再发下一包。

### 18.1 Luna 适合做

- 按指定模板搭脚手架。
- 把批准的 HTML/CSS 迁成 React 组件。
- 按给定接口写 Mapper、Repository 和 Fixture。
- 按给定 SQL 写迁移。
- 按列出的测试向量补测试。
- 修复明确的 TypeScript、Lint 和布局问题。
- 运行构建、测试、截图并报告。

### 18.2 Luna 不得自行决定

- 更换框架、数据库、状态库或依赖。
- 修改安全边界或扩大 Preload API。
- 设计 OAuth、Secret、Token 存储方式。
- 修改收益公式、现金流分类或质量规则。
- 修改订单状态机或重试策略。
- 连接真实账户或调用真实写接口。
- 添加遥测、云服务、发布、部署或自动更新。
- 在未批准的文件范围内顺手重构。

### 18.3 每个工作包必须包含

```text
任务编号：FH-XXX
模型：gpt-5.6-luna，reasoning_effort=max
目标：一句话说明唯一产出
先读：准确文件列表
允许修改：准确文件/目录
禁止修改：准确文件/目录
已锁定决策：框架、接口、数据和视觉规则
实现步骤：按顺序列出
边界情况：逐项列出
验收标准：可观察、可测试
必须运行：命令列表
禁止运行：真实 API、下单、发布等
交付报告：文件、测试、剩余问题，不写空泛总结
```

### 18.4 第一批建议工作包

`FH-001`：创建 Electron Forge webpack-typescript + React 空壳，仅建立进程边界和命令，不迁 UI。

`FH-002`：实现安全 BrowserWindow、CSP、自定义协议、导航/新窗口限制和最小 contextBridge，并补安全测试。

`FH-003`：迁移 Design Token、字体、App Shell 和静态首页，不接业务状态。

`FH-004`：拆出 Home 的纯展示组件，输入全部由 typed props 提供。

`FH-005`：实现确定性的 Mock Broker 与首页 Fixture，包括空账户、盈利、亏损、断网和重授权状态。

`FH-006`：实现热力图视觉和交互，只使用给定的 `HeatmapYear` 数据，不写收益算法。

`FH-007`：建立 Vitest/RTL/Playwright，完成首页和热力图测试。

`FH-008`：按主模型给出的 SQL 实现 SQLite migration 和 repository。

`FH-009`：按主模型给出的测试向量实现 Performance Engine。

`FH-010`：按已锁定领域类型实现只读 Schwab Response Mapper；不发网络请求。

OAuth、Token、IPC 特权接口、Place/Cancel/Replace 以及 Unknown Resolution 不作为 Luna 的独立设计任务。

## 19. 主模型的职责

主模型负责：

- 每项架构决策和 ADR。
- Schwab 当前文档与真实响应核验。
- 安全威胁模型。
- OAuth 和凭据边界。
- 领域模型与 API Contract。
- 数据库 schema。
- 收益公式和测试向量。
- 下单状态机和写接口代码审查。
- 视觉验收与产品取舍。
- 把 Luna 的结果整合、测试和拒绝不合格实现。

主模型不能把“审查 Luna 输出”退化成只看它的口头总结，必须看实际 diff 和测试输出。

## 20. 当前必须先确认的决策

在正式开发前，只需用户确认以下产品取舍：

1. 首发平台：Windows 优先。
2. 首发交易资产：股票/ETF。
3. 首个真实交易版本：Limit，Regular Session；Market 先保留为 Preview-only。
4. 首发路径：只读 -> Preview -> 实验性真实下单。
5. 收益热力图：活跃/收益双模式，收益含 `%/$`。
6. 负收益色：受控莓红，不使用纯红。
7. 默认本地、无账号云、无遥测。

确认后才进入 `FH-001`，不会提前接真实 API 或写下单功能。

## 21. 主要风险与应对

| 风险 | 后果 | 应对 |
| --- | --- | --- |
| Schwab 对开源分发的条款不明确 | 项目无法合规公开真实接入 | 发布前取得书面澄清；仓库不含凭据、不做代理、不再分发行情 |
| OAuth Callback 规则与桌面端冲突 | 无法稳定授权 | Phase 0 独立 Spike，未通过不扩建业务 |
| 本地程序关闭导致快照缺失 | 收益热力图不完整 | 重建 + 质量标记，不伪造精度 |
| 订单 POST 超时但已成交 | 重复订单 | 不自动重试，进入 Unknown 并查询确认 |
| Electron Renderer 被 XSS 利用 | 凭据/本机风险 | 本地内容、CSP、Sandbox、Context Isolation、窄 IPC、无远程代码 |
| Secret 被日志或 Fixture 泄露 | 账户安全事故 | 集中脱敏、提交扫描、CI 无真实凭据 |
| 外部 API 字段变化 | 数值错误或页面误导 | Zod 边界校验、Adapter、契约 Fixture、稳定错误码 |
| Luna 擅自扩大实现 | 架构漂移或安全漏洞 | 小工作包、文件 allowlist、每包审 diff 和测试 |

## 22. 参考约束

- Schwab Developer Portal: https://developer.schwab.com/
- Schwab Online Services Agreement: https://www.schwab.com/legal/terms
- Electron Security: https://www.electronjs.org/docs/latest/tutorial/security
- Electron Context Isolation: https://www.electronjs.org/docs/latest/tutorial/context-isolation
- Electron safeStorage: https://www.electronjs.org/docs/latest/api/safe-storage
- Electron Forge Templates: https://www.electronforge.io/
- Electron Forge Vite status: https://www.electronforge.io/templates/vite
