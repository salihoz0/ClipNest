use std::str::FromStr;

fn main() {
    println!("Super+V -> {:?}", tauri_plugin_global_shortcut::Shortcut::from_str("Super+V"));
    println!("Meta+V -> {:?}", tauri_plugin_global_shortcut::Shortcut::from_str("Meta+V"));
    clipnest_lib::run()
}
