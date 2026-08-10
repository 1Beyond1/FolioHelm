# FolioHelm Luna Max Handoff v2

更新时间：2026-08-10（Asia/Shanghai）

## 任务边界

继续 `D:\Code-D\FolioHelm` 的 Windows Mock/Paper/Dry Run 版本。不要访问
Schwab Developer Portal，不要添加 OAuth、App Key、Secret、Access Token、
Refresh Token，不要抓取网页，不要实现或调用 Place/Cancel/Replace。

当前目标是把本地版本做成可公开体验的开源项目；真实 API 必须等待
`docs/api-gate.md` 的官方契约和独立安全审查。

## 已完成的稳定点

- `ef3236d`：Mock trading foundation and local automation
- `6013e51`：domain safety, evidence journal, and automation UI
- `67fa175`：dynamic mock views and scenario data
- `a4db880`：dynamic quote states in trading views

开始工作前先运行：

```powershell
git -c safe.directory=D:/Code-D/FolioHelm status --short --branch
git -c safe.directory=D:/Code-D/FolioHelm log --oneline -8
npm test
npm run build
```

每个稳定阶段都要：

```powershell
git -c safe.directory=D:/Code-D/FolioHelm diff --check
git -c safe.directory=D:/Code-D/FolioHelm add -A
git -c safe.directory=D:/Code-D/FolioHelm commit -m "checkpoint: describe stage"
```

不推送远程，不创建远程仓库，不提交凭据和构建私密材料。

## 当前实现

- Tauri 2 + React + TypeScript + Rust；Windows first。
- 黑白/深灰 + lime/berry 设计，System/Dark/Light。
- English/简体中文。
- 首页、市场、个股详情、投资组合、订单、交易弹窗、设置、自动化。
- 图表悬浮价格、滚轮连续时间跨度、热力图 Activity/Return/Percent/USD。
- Mock Broker 单一快照和确定性 Fault Scenarios。
- Decimal 金融类型、Preview Hash、单次消费、Unknown 和 Reconciliation。
- 本地证据 Hash Chain、验证、导入、导出、敏感字段拒绝。
- Mock/Paper/Dry Run、预算、并发、速率、幂等键、Kill Switch。
- 设置里的 Clear local demo data 会清空本地偏好、证据、自动化状态和 Mock 订单。

## 当前验证基线

最近验证：

- `npm test`：6 个文件，38 个测试通过。
- `npm run build`：通过。
- `cargo fmt --manifest-path src-tauri/Cargo.toml --check`：通过。
- `cargo test --manifest-path src-tauri/Cargo.toml --locked`：11 个 Rust 测试通过。
- `cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets --all-features -- -D warnings`：通过。
- `npm run desktop:build:portable`：通过；便携 EXE 已能在无 Vite 端口时启动。
- `npm run desktop:build`：曾在 WiX/NSIS 最后打包阶段因 `os error 5` 失败，见 `docs/known-issues.md`。

## 建议后续顺序

1. 后续每次 UI 或 Mock Broker 改动后，重跑前端/Rust 基线和浏览器回归。
2. 继续补充跨页面动态快照测试，尤其是无购买力、过期报价、断网、超时和 Unknown 订单。
3. 继续保持 `docs/api-gate.md` 的官方契约门槛；在 API Gate 通过前不加入 Schwab 凭据、OAuth 或真实写入。
4. 若准备公开发布，使用有权限的 Windows 环境重新评估 WiX/NSIS 安装包，并保留 portable EXE 的精确 SHA-256。

## 不要做的事情

- 不要因为用户有 Schwab 账户或 US$1 测试预算就尝试真实 API。
- 不要把社区文档当成官方当前契约。
- 不要自动重试 Unknown/timeout 的写请求。
- 不要把 `number` 引入金融核心计算。
- 不要让“关闭安全开关”移除不可关闭的核心规则。
- 不要用安装包失败作为停止其他工作的理由；记录到 known issues 后继续。

## 完成条件

本阶段完成的定义是：独立运行的 Windows Mock 版本，页面和交互齐全，
数据来自统一 Mock Broker，测试/构建/文档/发布清单齐备，并清楚声明无
Schwab 真实连接。真实只读、Preview 和真实交易属于之后的独立阶段。
