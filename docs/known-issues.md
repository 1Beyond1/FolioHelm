# FolioHelm Known Issues

状态：持续更新（2026-11-22）。Schwab API Gate 不阻塞 Mock / Local Portfolio 版本其余工作。

## 当前仍存在的问题

### FH-API-GATE-001 — Schwab Developer Portal 仍不可访问

- 严重程度：P1（外部）
- 现状：用户访问官方门户时得到 Akamai Access Denied；本项目按约束没有继续访问、抓取或绕过。
- 影响：OAuth、真实只读、Preview、Place/Cancel/Replace、实时行情和自动化条款都不能实现或承诺。
- 处理：保持 `API Gate Pending`。以后只能由官方门户/书面支持取得 A 级契约后恢复 Phase 0。

### FH-NOTARY-001 — 远端公证（Notary）服务与实盘对账尚未接入

- 严重程度：P1（仅对未来真实订单）
- 现状：桌面端已完整接入 Rust AES-256-GCM 加密 SQLite 金库与 Ed25519 签名哈希证据链（支持导入/导出/验签与 20 MB 硬上限），Rust 层保留了隐私最小化 Commitment/Receipt 原语，但未启用任何远端公证服务，且当前证据记录仍只对应 Mock Demo 与 Local Portfolio (CSV + Paper) 演练。
- 影响：当前导出的证据是本地防篡改演练/导入审计记录，不是券商官方对账单或远端第三方公证证明。
- 处理：真实写能力前完成远端公证集成、实盘订单双证据绑定与独立安全审查。

### FH-FX-001 — 多币种组合跨币种汇总与再平衡需权威汇率源

- 严重程度：P2（Fail-Safe 设计约束）
- 现状：当用户导入含多结算币种（如 USD + HKD / CNY）的券商 CSV 时，FolioHelm 遵循 Fail-Safe 原则按币种分项小计，禁止跨币种盲目相加，并自动暂停跨币种资产占比图与跨币种再平衡测算。
- 影响：跨币种总资产合并视图与跨币种再平衡需等待后续引入可审计的定点 FX 汇率源。
- 处理：保持 Fail-Safe 币种隔离，绝不私自使用硬编码或无来源汇率。

### FH-UX-004 — 部分设置页风控开关仍属于演练/策略偏好，未接入实盘执行门槛

- 严重程度：P2（仅对未来实盘接入语义）
- 现状：桌面端 `protections`、自动化策略、`workspace_preferences` 与再平衡目标权重现已迁移至 AES-256-GCM 加密 SQLite 金库；手动锁屏与空闲自动锁屏（App Lock）已在 Rust 侧真实擦除会话密钥并写入 `SessionLocked` 签名证据。但最大订单金额、价格偏差、账户允许列表开关仍仅作用于本地演练展示，尚未绑定真实券商适配器。
- 影响：用户不能把演练配置误认为已连接真实券商风控网关。
- 处理：真实适配器接入前，必须在可信 Rust 域层强制执行每项风控策略并独立审查。

### FH-RELEASE-001 — WiX/NSIS 安装包在部分受限权限 Windows 环境可能触发权限拒绝

- 严重程度：P2（外部环境）
- 现状：前端、Rust 和便携版 Windows EXE 可稳定构建；在受限环境打包 WiX/NSIS 安装器时曾出现 `os error 5`（Access denied）。
- 影响：当前优先保留便携版构建与 SHA-256 校验；MSI/NSIS 安装器需在标准权限 Windows 环境执行。
- 处理：继续保留 portable 目标与校验清单，绝不把未签名 EXE 伪装成签名安装器。

## 已修复并验证的问题

### FH-PERSIST-001（桌面端已解决）— AES-256-GCM 加密 SQLite 金库与全量设置/订单持久化

桌面端已彻底取代明文 `localStorage` 持久化：使用内置 `rusqlite`（`WAL` + `PRAGMA secure_delete = ON`）结合 AES-256-GCM（随机 96-bit Nonce + `schema_version|table|record_id` AAD）与 OS Credential Manager（Windows Credential Manager / OS Keyring）+ `Zeroizing` 内存擦除。持仓快照、纸上模拟订单（`vault_save_paper_order`/`vault_load_paper_orders`）、安全设置/工作区偏好/自动化配置/再平衡目标（`vault_save_setting`/`vault_load_setting`）、延迟行情缓存（`hydrateCachedPublicQuotes`）与 Ed25519 证据链均已全量加密落盘，并支持旧浏览器明文配置无损迁移及重启后保持 `local-csv` 模式与缓存行情。浏览器预览模式保留向后兼容降级。

### FH-BACKUP-LOCK-001 — `.fhvault` Argon2id 口令加密离线备份与真实手动/空闲锁屏

Rust 后端已实现 Argon2id（64 MiB / t=3 / p=1）+ 随机 128-bit 盐 + AES-256-GCM + 版本/参数 AAD 的 `.fhvault` 全库加密导出与 Fail-Closed 恢复（解密与整条 Ed25519 证据链验签全部通过后才原子替换金库，失败绝不破坏现有数据库）；证据导入统一设置 20 MB 硬上限。同步实现真实手动锁屏与可选空闲自动锁屏：锁定前写入 Ed25519 签名 `SessionLocked` 证据，随后释放并 `Zeroizing` 擦除内存会话密钥，前端卸载持仓 DOM 并渲染全屏锁屏遮罩；解锁支持 Argon2id 常量时间口令校验与指数退避防爆破，口令绝不落盘或写入日志。

### FH-QUOTES-CSV-001 — Rust 行情定点精度与并发上限加固、多币种 Fail-Safe 隔离及扩展券商 CSV

`src-tauri/src/quotes/mod.rs` 已彻底移除所有 `f64` 解析与涨跌幅计算，改用 `i128` 定点数与 `serde_json::value::RawValue` 零浮点解析；新增 512 KiB 流式响应体硬上限防 OOM、URL 白名单 `url.port().is_none()` 校验、4 并发受限批量拉取与 20 秒总超时保护。CSV 导入在复用 5 MB / 10,000 行上限与公式注入清洗前提下，新增多币种 Fail-Safe 分项隔离与 **Fidelity / Vanguard / 富途 (Futu) / 老虎 (Tiger)** 持仓 CSV 列头别名适配；全站各页面（Home/Markets/Instrument/Portfolio/Orders/Trade/SearchPalette）已完整打通非 7 只演示股（如 `VOO`/`QQQ`/`BRK.B`）的 `local-csv` 真实展示，严禁伪造历史走势或假新闻。

### FH-REBALANCE-001 — 纯 Decimal 目标仓位与只读再平衡计算器

新增 `src/domain/rebalance.ts` 与 `PortfolioPage` 多标的分配环形图及只读再平衡规划器：纯 Decimal 运算、严格校验目标权重合计 = 100%、Fail-Safe 拦截多币种跨币种测算、支持「存量调仓」与「仅新增现金买入」双模式；目标权重经加密设置持久化，单条建议可一键预填至四步纸上模拟交易单（从架构层面永久禁止自动批量下单）。

### FH-ARCH-001 / FH-DATA-002 — 页面数据统一

Mock Broker / Local Portfolio 统一作为账户、报价、持仓、订单、热力图和派生首页数据的单一来源，模式隔离清晰，场景切换与本地模拟订单实时刷新跨页面视图。

### FH-STATE-001 — 页面状态统一与恢复入口

统一覆盖空数据、过期、断网、重新授权、请求失败、限流、超时和 Unknown 状态；`DataStateNotice` 负责跨页面提示，应用级 Error Boundary 提供渲染异常恢复入口。

### FH-DOMAIN-001 — 金融核心值全链路 Decimal / 定点数

前后端金融金额、价格、股数、百分比与再平衡计算全面采用 Decimal / `i128` 定点领域类型，杜绝 IEEE-754 浮点精度漂移。

### FH-UX-001 / FH-STATE-002 / FH-TRADE-001 / FH-AUTO-001 / FH-I18N-001 / FH-UX-002~006 / FH-A11Y-001~002

三态主题、四步安全交易状态机（Draft Hash 绑定与一次性消费、Unknown 锁死对账）、Mock/Paper/Dry Run 自动化安全边界、中英文领域文案、Modal/键盘/900px 响应式、热力图未来日期防伪造、未知标的无数据兜底与 `<html lang>` / `theme-color` 同步均已验证通过。

## 严重程度

- `P0`：可能造成真实资金、凭据、证据或用户数据损失；只暂停受影响路径，其他独立工作继续。
- `P1`：核心功能、领域正确性或未来真实交易发布缺口。
- `P2`：明显的产品、可访问性、持久化或安装质量问题。
- `P3`：低风险视觉和文案细节。
