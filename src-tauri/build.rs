use std::{env, fs, path::PathBuf};

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=tauri.conf.json");
    println!("cargo:rerun-if-changed=capabilities/main.json");

    // tauri-build 2.6.3 always emits a Windows resource and therefore expects
    // an ICO file, even while bundling is disabled. Keep this build-only icon
    // in OUT_DIR so the repository does not need a product icon yet.
    let out_dir = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR is not set"));
    let icon_path = out_dir.join("foliohelm-build-placeholder.ico");
    fs::write(&icon_path, placeholder_ico()).expect("failed to write build-only ICO");

    // tauri_build_context! also needs to see an icon while generating the
    // compile-time context. Give that generator an OUT_DIR-local copy of the
    // project config with the temporary icon path injected.
    let manifest_dir =
        PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is not set"));
    let config_source = fs::read_to_string(manifest_dir.join("tauri.conf.json"))
        .expect("failed to read tauri.conf.json");
    let icon_json = format!(
        "\"icon\": [\"{}\"]",
        icon_path.to_string_lossy().replace('\\', "\\\\")
    );
    let frontend_dist = manifest_dir
        .parent()
        .expect("src-tauri must have a project root parent")
        .join("dist");
    let generated_config_path = out_dir.join("tauri.conf.json");
    let frontend_dist_relative = relative_path(
        generated_config_path
            .parent()
            .expect("generated Tauri config must have a parent"),
        &frontend_dist,
    );
    let frontend_dist_json = format!(
        "\"frontendDist\": \"{}\"",
        frontend_dist_relative.to_string_lossy().replace('\\', "/")
    );
    let generated_config = config_source
        .replace("\"icon\": []", &icon_json)
        .replace("\"frontendDist\": \"../dist\"", &frontend_dist_json);
    assert_ne!(
        generated_config, config_source,
        "tauri.conf.json must contain the empty icon list placeholder"
    );
    assert!(
        generated_config.contains(&frontend_dist_json),
        "generated Tauri config must use an absolute frontendDist path"
    );
    fs::write(&generated_config_path, generated_config)
        .expect("failed to write generated Tauri config");

    let windows = tauri_build::WindowsAttributes::new().window_icon_path(icon_path);
    let codegen = tauri_build::CodegenContext::new()
        .config_path(generated_config_path)
        .capability(manifest_dir.join("capabilities").join("main.json"));
    let attributes = tauri_build::Attributes::new()
        .windows_attributes(windows)
        .codegen(codegen);
    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}

fn relative_path(from: &std::path::Path, to: &std::path::Path) -> PathBuf {
    let from_components: Vec<_> = from.components().collect();
    let to_components: Vec<_> = to.components().collect();
    let common_len = from_components
        .iter()
        .zip(&to_components)
        .take_while(|(from_component, to_component)| from_component == to_component)
        .count();

    let mut relative = PathBuf::new();
    for _ in common_len..from_components.len() {
        relative.push("..");
    }
    for component in &to_components[common_len..] {
        relative.push(component.as_os_str());
    }
    relative
}

fn placeholder_ico() -> Vec<u8> {
    // A transparent 1x1 PNG wrapped in the ICO container format.
    const PNG: &[u8] = &[
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x04, 0x00, 0x00, 0x00, 0xb5,
        0x1c, 0x0c, 0x02, 0x00, 0x00, 0x00, 0x0b, 0x49, 0x44, 0x41, 0x54, 0x78, 0xda, 0x63, 0x64,
        0xf8, 0x0f, 0x00, 0x01, 0x05, 0x01, 0x01, 0x27, 0x18, 0xe3, 0x66, 0x00, 0x00, 0x00, 0x00,
        0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ];

    let image_size = u32::try_from(PNG.len()).expect("placeholder PNG is too large");
    let mut ico = Vec::with_capacity(22 + PNG.len());
    ico.extend_from_slice(&[0, 0, 1, 0, 1, 0]);
    ico.extend_from_slice(&[1, 1, 0, 0, 1, 0, 32, 0]);
    ico.extend_from_slice(&image_size.to_le_bytes());
    ico.extend_from_slice(&22u32.to_le_bytes());
    ico.extend_from_slice(PNG);
    ico
}
