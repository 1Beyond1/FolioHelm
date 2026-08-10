# FolioHelm Known Issues

状态：持续更新。Schwab API Gate 不阻塞 Mock / Local 版本其余工作。

## 严重程度

- `P0`：可能造成真实资金、凭据、证据或用户数据损失；只暂停受影响路径，其他独立工作继续。
- `P1`：核心功能、领域正确性或发布质量缺口。
- `P2`：明显的产品、可访问性或一致性问题。
- `P3`：低风险视觉和文案细节。

## 当前问题

### FH-ARCH-001 — Mock 数据没有统一 Broker 边界

- 发现阶段：基线静态审计
- 严重程度：P1
- 现象：首页直接导入 `MOCK_PORTFOLIO`，市场、组合、订单和交易各自维护独立数据与类型。
- 复现步骤：检查 `src/App.tsx`、`src/mocks/portfolio.ts` 和各 feature 页面。
- 预期：页面通过统一、可注入、确定性的 Mock Broker / Scenario Provider 读取同一领域状态。
- 实际：同一账户、持仓、报价和订单可能在不同页面互相矛盾。
- 影响范围：全部页面、测试、后续持久化和交易状态机。
- 当前处理：待建立 contracts、fixtures、scenario store 和统一 provider。
- 是否阻塞：不阻塞其他独立工作。
- 下一步：完成 UX 审查后实施统一 Mock Broker。

### FH-DOMAIN-001 — 金融值大量使用 JavaScript `number`

- 发现阶段：基线静态审计
- 严重程度：P1
- 现象：Money、Price、Quantity、Percent 在多个页面和 Mock 类型中使用 `number`。
- 复现步骤：搜索 `src/types.ts`、Markets、Portfolio、Orders 和 Trade 的数值字段。
- 预期：领域值使用规范化 Decimal String / 明确 Scale；展示层才格式化。
- 实际：现有 Mock 运算和排序依赖 IEEE 754 浮点数。
- 影响范围：金额、数量、收益、订单摘要和风险限额。
- 当前处理：当前没有真实写能力，因此未触达资金；迁移时先建立独立领域类型和表驱动测试。
- 是否阻塞：阻塞任何真实交易能力，不阻塞 Mock UI 收口。
- 下一步：统一 Broker 后迁移关键交易领域值。

### FH-UX-001 — 缺少完整主题系统

- 发现阶段：基线静态审计
- 严重程度：P1
- 现象：设置页没有 System / Dark / Light，CSS 主要写死深色值。
- 复现步骤：搜索 `theme`、`light`、`dark`；未找到主题状态或主题测试。
- 预期：首次跟随系统，支持英文/中文下的 System、Dark、Light，并通过 CSS Variables 切换。
- 实际：只有深色界面。
- 影响范围：全部页面和公开截图。
- 当前处理：待完成设计 Token 归一化和主题设置。
- 是否阻塞：不阻塞其他功能。
- 下一步：UX 审查后纳入页面收口工作包。

### FH-STATE-001 — 页面状态模型不完整

- 发现阶段：基线静态审计
- 严重程度：P1
- 现象：只有零散 Empty / Unknown；Loading、Error、Offline、Stale、Reauth-required 没有统一入口和组件测试。
- 复现步骤：搜索各 feature 的状态渲染和测试。
- 预期：所有核心页面支持统一五类状态，并说明被禁用动作的原因。
- 实际：多数页面只展示 normal fixture。
- 影响范围：Home、Markets、Instrument、Portfolio、Orders、Trade、Settings。
- 当前处理：待由 Scenario Provider 驱动。
- 是否阻塞：不阻塞独立静态页面工作。
- 下一步：在统一 Mock Broker 中实现确定性状态。

### FH-TRADE-001 — 交易流程仍是页面内模拟逻辑

- 发现阶段：基线静态审计
- 严重程度：P1
- 现象：交易页面使用局部状态和浮点金额，没有独立 Draft Hash、Preview、Nonce、状态机、预算占用或 Unknown 对账模型。
- 复现步骤：检查 `src/features/trade/TradePage.tsx`。
- 预期：纯领域状态机驱动 Mock 流程，字段变化使 Preview 失效，重复提交只能消费一次 Nonce。
- 实际：四步 UI 可走通，但安全语义没有领域层证明。
- 影响范围：Mock Preview、Demo Receipt、未来 Paper / Dry Run。
- 当前处理：真实交易和真实网络保持不可达。
- 是否阻塞：阻塞 Preview/Trading Profile，不阻塞 Mock UI。
- 下一步：建立交易状态机、TradingPolicy 和故障测试。

### FH-PERSIST-001 — 没有本地数据库和 Repository

- 发现阶段：基线静态审计
- 严重程度：P1
- 现象：设置、Mock 状态、订单时间线和 Evidence 均未持久化。
- 复现步骤：检查 `src-tauri/src/lib.rs` 和前端数据来源。
- 预期：版本化迁移、参数化 SQL、Foreign Keys、事务、损坏/迁移失败的失败关闭路径。
- 实际：Rust Builder 没有命令、数据库或 Repository。
- 影响范围：设置、订单、Evidence、崩溃恢复。
- 当前处理：待冻结 Schema 后实现。
- 是否阻塞：不阻塞 UX 和纯领域工作。
- 下一步：在领域模型稳定后实现本地持久化。

### FH-EVIDENCE-001 — Evidence 只有内存原语

- 发现阶段：基线静态审计
- 严重程度：P1
- 现象：Hash Chain、Ed25519、Commitment/Receipt 单元测试存在，但没有持久 Journal、导出、导入和 UI 验证流程。
- 复现步骤：检查 `src-tauri/src/evidence/mod.rs` 和 Tauri Builder。
- 预期：本地追加、验证、导出、导入、篡改检测和脱敏边界可端到端使用。
- 实际：11 个 Rust 原语测试通过，应用无法使用这些能力。
- 影响范围：审计、崩溃恢复、争议证据。
- 当前处理：保留现有原语，后续接入 Repository 和窄命令。
- 是否阻塞：不阻塞 UX。
- 下一步：持久化阶段实现。

### FH-AUTO-001 — 没有 Paper / Dry Run 自动化模块

- 发现阶段：目标差距审计
- 严重程度：P1
- 现象：没有策略模型、调度、Kill Switch、速率预算、背压、任务日志或 Shadow 执行。
- 复现步骤：检查当前目录结构和 UI。
- 预期：仅 Mock/Paper/Dry Run 的安全自动化，Real Trading 明确不可用。
- 实际：未实现。
- 影响范围：目标第十一节。
- 当前处理：等待统一领域和持久化后实现。
- 是否阻塞：不阻塞前序阶段。
- 下一步：建立 Automation Domain 和模拟执行器。

### FH-RELEASE-001 — 发布工程不完整

- 发现阶段：基线配置审计
- 严重程度：P1
- 现象：Tauri bundle 当前关闭、图标为空；缺少 CI、SBOM、发布清单、用户指南和安全文档。
- 复现步骤：检查 `src-tauri/tauri.conf.json`、根目录和 `.github/`。
- 预期：独立 unsigned Windows Mock 构建、完整标识、SHA-256、构建记录和 GitHub-ready 本地材料。
- 实际：只有可运行 Release EXE 和部分计划文档。
- 影响范围：公开体验和来源验证。
- 当前处理：不进行远端发布。
- 是否阻塞：不阻塞功能开发。
- 下一步：最终发布阶段补齐。

### FH-API-GATE-001 — Schwab Developer Portal 当前不可访问

- 发现阶段：外部依赖
- 严重程度：P1（外部）
- 现象：用户访问 Developer Portal 收到 Akamai Access Denied。
- 复现步骤：用户提供的 Reference ID；当前目标禁止继续访问门户或 API。
- 预期：取得 A 级官方契约后才实现真实连接。
- 实际：只能保留 Adapter、Fixture、能力矩阵和连接 UI 框架。
- 影响范围：OAuth、只读 Schwab、Preview、真实交易。
- 当前处理：明确标记 `API Gate Pending`。
- 是否阻塞：仅阻塞真实 Schwab 能力；不阻塞本目标其余工作。
- 下一步：用户以后通过官方渠道解决访问时再单独恢复 Phase 0。

### FH-DATA-002 — 页面之间的演示账户数据互相矛盾

- 发现阶段：Playwright UX 审查（2026-08-10）
- 严重程度：P1
- 现象：首页总值为 US$127,430.82，但首页列出的四项持仓合计已经超过该数值；投资组合页又使用另一组持仓和总权益；交易页的 AAPL 报价、搜索面板和市场页也不一致。
- 复现步骤：依次打开首页、市场、搜索、个股详情、投资组合和交易窗口，对照 AAPL/SPY 的报价及账户数字。
- 预期：所有页面从同一个可注入 Mock Broker / Scenario Store 读取同一快照；派生值由同一计算器计算。
- 实际：页面和组件各自维护 fixture，无法证明数字的一致性。
- 影响范围：所有金额、持仓、订单、收益和未来 Paper/Dry Run。
- 当前处理：纳入统一领域模型和 deterministic scenario；在统一前不允许接真实 Broker。
- 是否阻塞：阻塞真实交易和可信的模拟交易，不阻塞架构迁移。
- 下一步：建立账户、报价、持仓、订单与派生快照的单一来源，并添加交叉页面一致性测试。

### FH-UX-002 — 模态层级、Escape 和全局快捷键可能互相穿透

- 发现阶段：Playwright UX 审查（2026-08-10）
- 严重程度：P1
- 现象：连接说明 Modal 打开时按 Ctrl+K 仍可在其上叠加搜索 Modal；Escape 只关闭最上层搜索，底层连接 Modal 仍然存在；交易 Modal 的 Escape、遮罩和全局快捷键没有统一 Modal Stack 语义。
- 复现步骤：设置 → Connect → Ctrl+K → Escape。
- 预期：Modal 采用单一栈；最上层优先处理 Escape；存在阻塞 Modal 时不触发页面级快捷键；底层页面不能获得焦点。
- 实际：可以叠加不同 Modal，造成返回路径不清晰。
- 影响范围：设置、搜索、交易和所有未来确认对话框。
- 当前处理：纳入 App 级 Modal Controller，统一 Escape、焦点和 body scroll 锁定。
- 是否阻塞：不阻塞 Mock 数据迁移；阻塞最终 UX 收口。
- 下一步：先抽取通用 Modal/Confirm 机制，再补交互测试。

### FH-UX-003 — 900px 窗口发生横向溢出

- 发现阶段：Playwright UX 审查（2026-08-10）
- 严重程度：P1
- 现象：窗口缩到 900×700 后首页的图表和侧栏被裁切，顶部导航与账户状态挤压，无法在窗口内完整访问内容。
- 复现步骤：将浏览器/桌面窗口调整到 900×700，打开首页并滚动。
- 预期：Windows 桌面窗口有明确最小尺寸；在最小尺寸内无意外横向溢出，必要时组件转为单列。
- 实际：布局继续按宽屏渲染，重要内容落在视口外。
- 影响范围：Windows resize、DPI 缩放、新人首次使用。
- 当前处理：纳入响应式断点和 Tauri 最小窗口约束；不以隐藏内容代替修复。
- 是否阻塞：不阻塞领域实现，阻塞发布质量。
- 下一步：统一 CSS token 与布局断点后，在 900/1280/1440 宽度回归。

### FH-DATA-003 — 热力图把未来日期渲染成有意义的结果

- 发现阶段：Playwright UX 审查（2026-08-10）
- 严重程度：P1
- 现象：当前日期为 2026-08-10，但年度热力图继续为 8 月 11 日至 12 月 31 日生成收益和操作次数。
- 复现步骤：打开首页，切到 Activity 或 Daily return，查看当前日期之后的单元格 aria-label。
- 预期：未来日期是无数据状态；tooltip 明确“暂无数据”，不得呈现虚构的收益或操作。
- 实际：未来单元格有数值和操作文案，容易被误认为历史记录或预测。
- 影响范围：热力图、收益汇总、演示数据可信度。
- 当前处理：fixture 生成器改为按明确 as-of 日期生成；未来项使用 null/unknown 数据状态。
- 是否阻塞：不阻塞其他页面，但阻塞收益展示完成标准。
- 下一步：改造 HeatmapEntry 的 dataStatus，并测试当前日边界。

### FH-A11Y-001 — 热力图把整年每一天都放进 Tab 顺序

- 发现阶段：Playwright UX 审查（2026-08-10）
- 严重程度：P2
- 现象：年度热力图生成约 365 个 button，键盘用户需要穿过所有日期才能离开该区域。
- 复现步骤：打开首页并用 Tab 键进入“你的投资年度”。
- 预期：热力图采用 grid/roving tabindex 或单一可聚焦容器；鼠标和键盘都能查看日期，不制造过长 Tab 链。
- 实际：每个单元格都进入默认 Tab 顺序。
- 影响范围：键盘操作、屏幕阅读器和新人导航效率。
- 当前处理：保留鼠标 tooltip，同时改用可控 grid 焦点模型。
- 是否阻塞：不阻塞核心功能。
- 下一步：与未来日期/tooltip 改造一起完成。

### FH-I18N-001 — 中文页面残留英文领域文案和日期

- 发现阶段：Playwright UX 审查（2026-08-10）
- 严重程度：P2
- 现象：中文页面混用 `Apple · 100 shares`、`AAPL limit order filled`、`Connect`、`Disconnected`、`Jan` 和 `Aug 09`。
- 复现步骤：系统/应用切换到简体中文，依次打开首页、设置和订单页。
- 预期：面向用户的文案和日期全部由 i18n 与 locale formatter 控制；代码/证券名称可保留原文但不应把 UI 状态英文硬编码。
- 实际：多处字符串直接写在 Mock 和组件中。
- 影响范围：中文可用性、截图一致性、未来英文切换。
- 当前处理：统一 Mock 文案为结构化 key/字段，页面只负责本地化展示。
- 是否阻塞：不阻塞 API Gate 之外的功能开发。
- 下一步：领域数据统一后清理残留文案并添加语言快照断言。

### FH-RELEASE-001 — Windows MSI 最后打包阶段被 WiX 权限阻止

- 发现阶段：Windows Release 验证（2026-08-10）
- 严重程度：P2（外部环境）
- 现象：`npm run desktop:build` 已完成前端构建和 Tauri release 编译，并生成 `src-tauri/target/release/foliohelm.exe`；最后验证 WiX/NSIS 包时下载/解压工具均返回 `os error 5`（拒绝访问）。
- 复现步骤：在当前受限 Windows 环境运行 `npm run desktop:build`。
- 预期：同时生成可分发的 MSI/NSIS 安装包。
- 实际：独立 EXE 已生成；MSI 和 NSIS bundler 都被工具链目录权限阻止。
- 影响范围：安装包产出，不影响前端、Rust、独立 EXE 或 Mock 功能。
- 当前处理：保留已生成的独立 EXE；继续尝试不依赖 WiX 的 Windows bundle 目标，并记录构建哈希。
- 是否阻塞：不阻塞本地 Mock 体验和独立 EXE 验证；阻塞 MSI 安装包最终验收。
- 下一步：验证 NSIS/portable 目标；若仍受限，交付 EXE + SHA-256，并把安装包标为待用户本机环境重新构建。
