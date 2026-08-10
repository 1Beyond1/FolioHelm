# FolioHelm

FolioHelm 是一个非官方的 Charles Schwab 本地优先 Windows 桌面客户端。

## 当前状态

当前版本是一套可交互的本地 Mock 交易终端，已包含首页、市场、自选列表、个股详情、投资组合、订单、四步模拟下单和安全设置。所有报价、持仓与订单都是虚构数据；当前版本不能连接券商，也不能提交真实订单。

当前可体验：

- 全局搜索与市场/个股浏览
- 投资组合、持仓、收益曲线与年度活动/收益热力图
- 首页组合图和个股价格图支持悬浮查看值/价格，以及滚轮连续调整时间跨度
- Working / Filled / Canceled / Rejected / Unknown 订单状态与时间线
- 统一风格的交易模态窗口：Ticket → Safety check → Mock preview → Demo receipt
- 默认开启的安全保护，以及关闭保护时的风险阅读、倒计时和二次确认
- 可切换的 Mock 故障场景、动态账户快照、Unknown/对账提示和本地 Dry Run 记录

明确未实现：Schwab OAuth/API、真实行情、真实下单、SQLCipher 持久化和远端证据服务。当前证据日志仅是本地 Mock 版本的浏览器存储 Hash Chain；项目不应被描述为具备真实券商或完整金融审计能力。

## 技术栈

- Tauri 2
- React
- TypeScript
- Rust

## 安全边界

- BYO Developer App：使用者负责提供并管理自己的开发者应用配置。
- 秘密不得进入前端或日志。
- 真实交易默认关闭。
- 不做自动重试。
- 遇到 `Unknown` 状态时，先对账，再继续后续操作。
- 当前自动化只能运行 Mock / Paper Trading / Dry Run；Real Trading 按钮不可用。
- 任何 API 能力、限流、行情许可和开源分发条件都必须先通过官方 `API Gate`。

## 开发

前端命令：

```bash
npm install
npm test
npm run build

# Tauri 开发模式（会启动 Vite）
npm run desktop:dev

# Windows Release（必须用这个，不能用裸 cargo build 代替）
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
npm run desktop:build
```

Rust/Tauri 项目的 Cargo manifest 位于 `src-tauri/Cargo.toml`：

```bash
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
```

`cargo build` 只验证/编译 Rust 壳，不负责执行 Tauri CLI 的前端资源打包；直接运行它生成的 EXE 可能仍依赖 `devUrl`。要生成可独立运行的 Windows Release，使用上面的 `npm run desktop:build`。

## 设计资料

- [Luna Max 完整续作交接书](docs/luna-handoff-v1.md)
- [Luna Max 当前交接书 v2](docs/luna-handoff-v2.md)
- [实现计划](docs/implementation-plan-v2.md)
- [用户决策](docs/user-decisions-v1.md)
- [ADR-0001：双证据日志](docs/architecture-decisions/ADR-0001-dual-evidence-journal.md)
- [安全策略](SECURITY.md)
- [贡献指南](CONTRIBUTING.md)
- [Mock Broker 契约](docs/mock-broker.md)
- [证据日志说明](docs/evidence-journal.md)
- [安全模型](docs/security-model.md)
- [Schwab API Gate](docs/api-gate.md)
- [测试计划](docs/test-plan.md)
- [Windows 发布清单](docs/release-checklist.md)
- [English user guide](docs/user-guide-en.md) · [中文使用说明](docs/user-guide-zh.md)

## 许可与声明

本项目采用 [Apache-2.0](LICENSE) 许可。内容不构成投资建议。FolioHelm 与 Charles Schwab 不存在隶属、赞助或认可关系。
