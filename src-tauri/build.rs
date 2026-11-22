use std::{env, path::PathBuf};

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=tauri.conf.json");
    println!("cargo:rerun-if-changed=capabilities/main.json");
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/icon.png");

    let manifest_dir =
        PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is not set"));
    let icon_path = manifest_dir.join("icons").join("icon.ico");
    let windows = tauri_build::WindowsAttributes::new().window_icon_path(icon_path);
    let codegen = tauri_build::CodegenContext::new()
        .config_path(manifest_dir.join("tauri.conf.json"))
        .capability(manifest_dir.join("capabilities").join("main.json"));
    let attributes = tauri_build::Attributes::new()
        .windows_attributes(windows)
        .codegen(codegen);
    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}
