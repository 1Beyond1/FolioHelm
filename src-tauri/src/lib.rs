pub mod evidence;

pub fn run() {
    tauri::Builder::default()
        .run(tauri::tauri_build_context!())
        .expect("error while running FolioHelm application");
}
