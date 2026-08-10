# Windows 工具链

本文记录 FolioHelm Windows 开发环境的可复现检查方式。命令默认在
PowerShell 中执行；当前会话结束后通过 `$env:` 设置的变量会自动失效。

## 固定版本

项目根目录的 `rust-toolchain.toml` 固定使用：

- Rust stable `1.92.0`
- target `x86_64-pc-windows-msvc`
- `rustfmt` 组件

检查 Rustup、Rustc 和 Cargo：

```powershell
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
rustup show active-toolchain
rustc --version --verbose
cargo --version --verbose
```

预期版本为 Rustc/Cargo `1.92.0`，目标为
`x86_64-pc-windows-msvc`。

## Visual C++ Build Tools

Tauri 的 Windows MSVC 构建需要 Visual C++ Build Tools。使用 Visual Studio
Installer 自带的 `vswhere.exe` 检查已安装且完整的实例：

```powershell
$vswhere = Get-Command vswhere.exe -ErrorAction SilentlyContinue
if ($vswhere) {
    & $vswhere.Source -latest -products * `
      -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
      -format json
} else {
    & "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe" `
      -latest -products * `
      -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
      -format json
}
```

结果应包含完整、可启动的 Visual Studio 2022 Build Tools 实例，并包含
`Microsoft.VisualStudio.Component.VC.Tools.x86.x64` 工作负载。

## Cargo 检查命令

从仓库根目录执行：

```powershell
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
rustup show active-toolchain
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
```

`cargo fmt --check` 只检查格式，不修改文件。`cargo check` 验证依赖解析、
Tauri 配置生成和 Rust 编译；`cargo test` 运行 Rust 测试。

## Schannel 临时处理

如果 Cargo 在当前机器上遇到 Schannel TLS 多路复用或证书吊销检查问题，
只在当前 PowerShell 会话临时设置以下变量后重试：

```powershell
$env:CARGO_HTTP_MULTIPLEXING = "false"
$env:CARGO_HTTP_CHECK_REVOKE = "false"
cargo check --manifest-path src-tauri/Cargo.toml
```

这些变量不会修改系统安全设置；关闭当前 PowerShell 会话后失效。不要把
Token、API Key、Refresh Token 或其他 Secret 写入本文件、Cargo 配置或日志。
