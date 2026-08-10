# FolioHelm Mock 版本使用说明

## 当前版本是什么

FolioHelm 是一个非官方、本地优先的 Windows 界面项目，未来才可能研究
嘉信连接。本版本只有 Mock：报价、余额、持仓、订单、回执和自动化运行记录
全部是虚构数据。当前没有券商连接，也不能动用资金。

## 启动

可以直接运行发布包中的便携版 EXE，也可以启动开发预览：

```powershell
npm install
npm run dev
```

生成 Windows 独立 Mock 版本：

```powershell
npm run desktop:build:portable
```

## 安全体验路径

- 首页展示虚构账户概览、收益曲线、持仓、近期活动和投资热力图。
- 市场页提供虚构自选列表和搜索。
- 个股详情支持鼠标悬浮查看价格，滚轮连续调整时间跨度。
- 投资组合和订单页都读取同一个 Mock Broker 快照。
- 交易以弹窗呈现，流程是 Ticket → Safety check → Mock preview → Demo
  receipt；不会发送券商请求。
- 自动化仅有 Mock、Paper Trading 和 Dry Run，真实交易按钮被锁定。

## 体验故障场景

进入“设置 → Mock 场景”，可以试用空账户、亏损账户、无购买力、报价过期、
断网、超时、未知结果和对账失败。只要信息不确定，界面就应当保留查看能力
并阻止危险操作。

## 设置和本地数据

首次语言默认跟随系统；目前支持 English 和简体中文。主题支持跟随系统、深色
和明亮。可选安全保护默认开启；关闭保护必须阅读风险说明、等待倒计时并确认。

证据日志只保存本地 Mock/Paper/Dry Run 事件，导入前会验证 Hash Chain。不要把
嘉信 App Key、Secret、OAuth 验证码、Token 或真实账户资料放进日志、截图、Issue
或 Git。

## 重要提醒

当前 `API Gate Pending`。在官方契约、分发条款、凭据存储、失败处理和独立安全
审查完成前，不要把本程序当作真实交易软件，也不要输入真实 API 凭据。

