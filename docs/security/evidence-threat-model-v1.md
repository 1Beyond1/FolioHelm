# Evidence Journal Threat Model v1

状态：实现前基线

## 保护资产

- 订单意图与用户确认内容。
- Preview 与实际 Submit 的一致性。
- Place、Cancel、Replace 的发送时间和结果。
- Broker Request ID、Order ID 和状态转换。
- 事件顺序、完整性和来源设备。
- Device Signing Key、SQLCipher Key、Schwab Token 和 App Secret。

## 信任边界

1. React WebView：不可信展示层，不能读取 Journal、Signing Key 或 Token。
2. Rust Core：验证并生成 Evidence Event，唯一能够追加 Journal 的应用层。
3. SQLCipher：本地完整事件和回执。
4. Windows Credential Manager：Device Signing Key 与 SQLCipher Key。
5. Optional Notary：只看 Commitment，不看事件正文。
6. Schwab：Broker 订单与行情的外部事实来源。

## 主要威胁与控制

| 威胁 | 控制 |
| --- | --- |
| 修改本地事件 | SHA-256 Hash Chain、Ed25519 签名、远端链头 Commitment |
| 删除中间事件 | 序号连续性和 Previous Hash 验证失败 |
| 删除尾部事件 | 远端最高 Checkpoint 高于本地链头时报警 |
| 重放旧证据 | Event ID、Intent ID、Sequence、Checkpoint Receipt ID |
| 伪造另一设备 | 每设备独立 Ed25519 Key；导出包含公钥与签名 |
| WebView 注入伪证据 | WebView 无 Journal 追加命令；Rust 只从领域事件生成记录 |
| 日志泄露 Secret | 证据 Schema 禁止 Token、Secret、Authorization Code 和数据库密钥 |
| 公证端泄露 | 端上只保存 Commitment，不保存事件正文和 Broker 标识 |
| 公证端伪造回执 | Receipt 使用服务端签名；客户端固定受信公钥 |
| 公证端不可用 | 本地继续；离线队列；不影响对已经发送订单的对账，不自动重试写请求 |
| 本地时钟回拨 | 同时记录 Sequence、Boot Session、Broker 时间和 Notary 时间；本地时间只作为声明 |
| 整台设备先被攻陷 | 明确为剩余风险；远端旧 Checkpoint 和 Broker 记录用于交叉核对 |

## 禁止进入远端 Commitment 的字段

- 姓名、地址、邮箱、电话和税务信息。
- 原始账号、Schwab Account Hash 和本地账户别名。
- Symbol、CUSIP、方向、数量、价格、金额和持仓。
- Broker Order ID、Request ID、Strategy 内容。
- Access Token、Refresh Token、App Secret、Authorization Code。
- 原始订单或 API 请求/响应。

## 必测属性

- 任意一个本地事件字节变化都会改变 Payload Hash 或 Entry Hash。
- 任意删除、插入、重复或重排都会使整链验证失败。
- 使用错误公钥或错误签名验证失败。
- 修改 Previous Hash、Sequence、Schema Version 或 App Version 验证失败。
- Empty Chain 合法；第一条必须是 Sequence 1 和 Genesis Hash。
- Checkpoint 不包含禁止字段。
- Notary 离线不会触发订单重发。
- 导出后重新导入可独立验证，不需要 Schwab Token。
