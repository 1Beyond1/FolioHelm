# FolioHelm Known Issues

状态：持续更新（2026-08-10）。Schwab API Gate 不阻塞 Mock / Local 版本其余工作。

## 当前仍存在的问题

### FH-STATE-001 — 页面状态还没有统一的加载/错误组件

- 严重程度：P2
- 现状：Mock Broker 已覆盖空账户、亏损、过期、断网、重新授权、限流、超时和 Unknown 场景；页面仍主要使用同步本地快照，尚未抽取统一 Loading/Error/Retry 组件。
- 影响：未来接入真实只读数据时，需要在不重复请求的前提下统一呈现加载、缓存、错误和恢复状态。
- 处理：保留确定性 Scenario Provider；真实适配器进入前补统一状态容器。

### FH-PERSIST-001 — 当前持久化是本地 Storage，不是加密数据库

- 严重程度：P1（仅对未来真实账户能力）
- 现状：偏好、Mock/Paper/Dry Run 状态和当前证据日志使用版本化浏览器 localStorage；没有 SQLCipher Repository、事务或崩溃恢复。
- 影响：当前 Mock 不包含真实账户数据；任何真实券商能力都不能建立在这个持久化层上。
- 处理：API Gate 之后单独做 Windows Credential Manager、加密数据库、迁移和恢复审查。

### FH-EVIDENCE-001 — 完整 Rust/SQLCipher/远端公证链尚未接入应用

- 严重程度：P1（仅对未来真实订单）
- 现状：前端有 SHA-256 Hash Chain、验证、导入、导出和敏感字段拒绝；Rust 有 Ed25519/Commitment 原语，但完整证据尚未与加密订单事务绑定，也没有远端公证服务。
- 影响：当前导出的证据是 Mock 辅助记录，不是券商对账单或绝对事实证明。
- 处理：真实写能力前完成本地完整事件、设备签名、双证据设计和独立审查。

### FH-RELEASE-001 — WiX/NSIS 安装包在当前环境被权限拒绝

- 严重程度：P2（外部环境）
- 现状：前端、Rust 和独立 Windows EXE 已构建；最终 WiX/NSIS bundler 曾返回 `os error 5`（Access denied）。
- 影响：当前可交付便携版 EXE；MSI/NSIS 安装器需在有权限的 Windows 环境重新构建。
- 处理：继续保留 portable 目标和 SHA-256；不把 unsigned EXE 伪装成签名安装器。

### FH-API-GATE-001 — Schwab Developer Portal 仍不可访问

- 严重程度：P1（外部）
- 现状：用户访问官方门户时得到 Akamai Access Denied；本项目按约束没有继续访问、抓取或绕过。
- 影响：OAuth、真实只读、Preview、Place/Cancel/Replace、实时行情和自动化条款都不能实现或承诺。
- 处理：保持 `API Gate Pending`。以后只能由官方门户/书面支持取得 A 级契约后恢复 Phase 0。

## 已修复并验证的问题

### FH-ARCH-001 / FH-DATA-002 — 页面数据统一

Mock Broker 现在是账户、报价、持仓、订单、热力图和派生首页数据的单一来源。首页、市场、个股、投资组合、订单和交易窗口会读取当前快照；场景切换会反映到页面。验证：`npm test`、浏览器跨页面检查。

### FH-DOMAIN-001 — 金融核心值改用 Decimal

Money、Price、Quantity、Percent 和 Mock 订单金额计算使用 BigInt/Decimal 领域类型。展示层可以转换为 number 做排序和 SVG 布局，但不能用它进行金融核心计算。验证：前端测试和 Rust 测试通过。

### FH-UX-001 — System/Dark/Light 主题

设置页提供跟随系统、深色和明亮模式，并进行本地持久化。浏览器实测三种模式可切换。

### FH-STATE-002 / FH-TRADE-001 — Mock 状态机与安全交易弹窗

Ticket → Safety check → Mock preview → Demo receipt 已由 Mock Broker 驱动；Preview 绑定 Draft Hash、一次性消费，场景失败会阻止流程，Unknown 明确禁止重下。真实 Broker 写能力仍被 API Gate 阻断。

### FH-AUTO-001 — Mock/Paper/Dry Run 自动化

已实现模式选择、允许列表、单笔/每日预算、并发与速率边界、幂等键、Kill Switch 和本地运行日志；Real Trading 仍不可用。

### FH-I18N-001 — 首页活动和图表领域文案本地化

已修复：中文首页活动、持仓单位、热力图月份、图表时间标签和交易步骤不再出现误导性的英文残留。`Mock`、`Paper Trading`、`Dry Run`、`API` 等模式/协议名称保留为产品术语。

### FH-UX-002 / FH-UX-003 — Modal、键盘和 900px 响应式收口

交易/搜索/设置层已测试关闭按钮、Escape、Ctrl+K 和 body scroll；Tauri 最小窗口为 900×680，浏览器 900px 检查未出现文档级横向溢出。仍需随着新页面继续回归。

### FH-DATA-003 / FH-A11Y-001 — 热力图未来日期与键盘焦点

As-of 日期之后的格子为 `no-data`，不再生成虚构收益；热力图使用 grid/roving tabindex，鼠标和键盘都能查看日期。

## 严重程度

- `P0`：可能造成真实资金、凭据、证据或用户数据损失；只暂停受影响路径，其他独立工作继续。
- `P1`：核心功能、领域正确性或未来真实交易发布缺口。
- `P2`：明显的产品、可访问性、持久化或安装质量问题。
- `P3`：低风险视觉和文案细节。
