use arboard::{Clipboard, ImageData as ClipboardImageData};
use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::{DateTime, Utc};
use image::{codecs::png::PngEncoder, ImageEncoder, ImageFormat};
use serde::{Deserialize, Serialize};
use std::{
    borrow::Cow,
    collections::hash_map::DefaultHasher,
    fs,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State, WindowEvent,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use uuid::Uuid;

mod paste;

const HISTORY_FILE: &str = "history.json";
const MAX_PREVIEW_CHARS: usize = 180;
const MAX_CAPTURE_CHARS: usize = 250_000;
const AUTOSTART_ARG: &str = "--autostart";
const PACKAGE_CANDIDATES: &[&str] = &["clip-nest", "clipnest"];
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ClipboardKind {
    Text,
    Image,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum UiLocale {
    Tr,
    En,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum UiTheme {
    Light,
    Dark,
    System,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum DefaultView {
    Picker,
    Manager,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum WindowAnchor {
    Center,
    Mouse,
    Fixed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ClipboardItem {
    id: String,
    content: String,
    preview: String,
    kind: ClipboardKind,
    favorite: bool,
    created_at: DateTime<Utc>,
    copied_at: DateTime<Utc>,
    copy_count: u32,
    source: String,
    size: usize,
    image_width: Option<usize>,
    image_height: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Settings {
    #[serde(default = "default_max_items")]
    max_items: usize,
    #[serde(default = "default_poll_interval_ms")]
    poll_interval_ms: u64,
    #[serde(default = "default_auto_trim")]
    auto_trim: bool,
    #[serde(default = "default_locale")]
    locale: UiLocale,
    #[serde(default = "default_theme")]
    theme: UiTheme,
    #[serde(default = "default_view")]
    default_view: DefaultView,
    #[serde(default = "default_window_anchor")]
    window_anchor: WindowAnchor,
    #[serde(default = "default_ui_scale")]
    ui_scale: u16,
    #[serde(default)]
    shortcut: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ClipboardSnapshot {
    items: Vec<ClipboardItem>,
    settings: Settings,
}

#[derive(Debug)]
struct ClipboardStore {
    items: Vec<ClipboardItem>,
    settings: Settings,
    path: PathBuf,
    is_loaded: bool,
}

#[derive(Clone)]
struct ClipboardState(Arc<Mutex<ClipboardStore>>);

#[derive(Clone)]
struct TrayAnchorState(Arc<Mutex<Option<(f64, f64)>>>);

#[derive(Clone)]
struct QuitState(Arc<AtomicBool>);

/// Tray icon'u drop olmaktan korur — app ömrü boyunca tutulur
#[allow(dead_code)]
struct TrayIconHolder(tauri::tray::TrayIcon);

pub struct PreviousWindow(pub Mutex<Option<String>>);

#[derive(Clone)]
enum ClipboardPayload {
    Text(String),
    Image {
        data_url: String,
        width: usize,
        height: usize,
    },
}

#[derive(Clone)]
enum ClipboardFingerprint {
    None,
    Text(String),
    Image(u64),
}

fn default_max_items() -> usize {
    200
}

fn default_poll_interval_ms() -> u64 {
    800
}

fn default_auto_trim() -> bool {
    true
}

fn default_locale() -> UiLocale {
    UiLocale::Tr
}

fn default_view() -> DefaultView {
    DefaultView::Picker
}

fn default_theme() -> UiTheme {
    UiTheme::System
}

fn default_window_anchor() -> WindowAnchor {
    WindowAnchor::Center
}

fn default_ui_scale() -> u16 {
    100
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            max_items: default_max_items(),
            poll_interval_ms: default_poll_interval_ms(),
            auto_trim: default_auto_trim(),
            locale: default_locale(),
            theme: default_theme(),
            default_view: default_view(),
            window_anchor: default_window_anchor(),
            ui_scale: default_ui_scale(),
            shortcut: String::new(),
        }
    }
}

fn load_settings(settings_path: &Path, history_path: &Path) -> Settings {
    if settings_path.exists() {
        if let Ok(content) = fs::read_to_string(settings_path) {
            if let Ok(settings) = serde_json::from_str::<Settings>(&content) {
                return settings;
            }
        }
    }
    if history_path.exists() {
        if let Ok(content) = fs::read_to_string(history_path) {
            if let Ok(snapshot) = serde_json::from_str::<ClipboardSnapshot>(&content) {
                return snapshot.settings;
            }
        }
    }
    Settings::default()
}

fn load_items(history_path: &Path) -> Vec<ClipboardItem> {
    if history_path.exists() {
        if let Ok(content) = fs::read_to_string(history_path) {
            if let Ok(items) = serde_json::from_str::<Vec<ClipboardItem>>(&content) {
                return items;
            }
            if let Ok(snapshot) = serde_json::from_str::<ClipboardSnapshot>(&content) {
                return snapshot.items;
            }
        }
    }
    Vec::new()
}

impl ClipboardStore {
    fn snapshot(&self) -> ClipboardSnapshot {
        ClipboardSnapshot {
            items: self.items.clone(),
            settings: self.settings.clone(),
        }
    }

    fn save(&self) -> Result<(), String> {
        let path = self.path.clone();
        let settings_path = path.with_file_name("settings.json");
        let snapshot = self.snapshot();
        
        std::thread::spawn(move || {
            if let Some(parent) = path.parent() {
                let _ = fs::create_dir_all(parent);
            }
            if let Ok(settings_content) = serde_json::to_string(&snapshot.settings) {
                let _ = fs::write(settings_path, settings_content);
            }
            if let Ok(items_content) = serde_json::to_string(&snapshot.items) {
                let _ = fs::write(path, items_content);
            }
        });
        Ok(())
    }

    fn upsert_text(&mut self, content: String, source: &str) -> bool {
        let prepared = prepare_content(content, self.settings.auto_trim);
        if prepared.is_empty() || prepared.chars().count() > MAX_CAPTURE_CHARS {
            return false;
        }

        let now = Utc::now();
        if let Some(index) = self.items.iter().position(|item| item.kind == ClipboardKind::Text && item.content == prepared) {
            let mut item = self.items.remove(index);
            item.copied_at = now;
            item.copy_count = item.copy_count.saturating_add(1);
            item.source = source.to_string();
            self.items.insert(0, item);
        } else {
            self.items.insert(0, ClipboardItem::new_text(prepared, source, now));
        }

        self.trim();
        true
    }

    fn upsert_image(&mut self, data_url: String, width: usize, height: usize, byte_size: usize, source: &str) -> bool {
        let now = Utc::now();
        if let Some(index) = self.items.iter().position(|item| item.kind == ClipboardKind::Image && item.content == data_url) {
            let mut item = self.items.remove(index);
            item.copied_at = now;
            item.copy_count = item.copy_count.saturating_add(1);
            item.source = source.to_string();
            self.items.insert(0, item);
        } else {
            self.items
                .insert(0, ClipboardItem::new_image(data_url, width, height, byte_size, source, now));
        }

        self.trim();
        true
    }

    fn trim(&mut self) {
        if self.items.len() <= self.settings.max_items {
            return;
        }

        let mut favorites = Vec::new();
        let mut regular = Vec::new();
        for item in self.items.drain(..) {
            if item.favorite {
                favorites.push(item);
            } else {
                regular.push(item);
            }
        }

        let remaining = self.settings.max_items.saturating_sub(favorites.len());
        regular.truncate(remaining);
        favorites.extend(regular);
        favorites.sort_by(|a, b| b.copied_at.cmp(&a.copied_at));
        self.items = favorites;
    }
}

impl ClipboardItem {
    fn new_text(content: String, source: &str, now: DateTime<Utc>) -> Self {
        let preview = make_preview(&content);
        let size = content.len();
        Self {
            id: Uuid::new_v4().to_string(),
            content,
            preview,
            kind: ClipboardKind::Text,
            favorite: false,
            created_at: now,
            copied_at: now,
            copy_count: 1,
            source: source.to_string(),
            size,
            image_width: None,
            image_height: None,
        }
    }

    fn new_image(content: String, width: usize, height: usize, size: usize, source: &str, now: DateTime<Utc>) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            preview: format!("{width}×{height} görsel"),
            content,
            kind: ClipboardKind::Image,
            favorite: false,
            created_at: now,
            copied_at: now,
            copy_count: 1,
            source: source.to_string(),
            size,
            image_width: Some(width),
            image_height: Some(height),
        }
    }
}

fn app_data_path(app: &tauri::App) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| dirs::data_local_dir().unwrap_or_else(std::env::temp_dir).join("ClipNest"))
        .join(HISTORY_FILE)
}

fn prepare_content(content: String, auto_trim: bool) -> String {
    if auto_trim {
        content.trim().to_string()
    } else {
        content
    }
}

fn make_preview(content: &str) -> String {
    let compact = content.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut preview: String = compact.chars().take(MAX_PREVIEW_CHARS).collect();
    if compact.chars().count() > MAX_PREVIEW_CHARS {
        preview.push('…');
    }
    preview
}

fn emit_items(app: &AppHandle, items: &[ClipboardItem]) {
    let _ = app.emit("clipboard://changed", items);
}

fn is_autostart_launch() -> bool {
    std::env::args().any(|arg| arg == AUTOSTART_ARG)
}

fn fingerprint_image(bytes: &[u8], width: usize, height: usize) -> u64 {
    let mut hasher = DefaultHasher::new();
    width.hash(&mut hasher);
    height.hash(&mut hasher);
    bytes.hash(&mut hasher);
    hasher.finish()
}

fn encode_png_data_url(bytes: &[u8], width: usize, height: usize) -> Result<String, String> {
    let mut png = Vec::new();
    let encoder = PngEncoder::new(&mut png);
    encoder
        .write_image(bytes, width as u32, height as u32, image::ColorType::Rgba8.into())
        .map_err(|error| error.to_string())?;
    Ok(format!("data:image/png;base64,{}", STANDARD.encode(png)))
}

fn decode_image_data_url(data_url: &str) -> Result<(Vec<u8>, usize, usize), String> {
    let (_, encoded) = data_url
        .split_once(',')
        .ok_or_else(|| "Görsel verisi çözülemedi".to_string())?;
    let png = STANDARD.decode(encoded).map_err(|error| error.to_string())?;
    let image = image::load_from_memory_with_format(&png, ImageFormat::Png).map_err(|error| error.to_string())?;
    let rgba = image.to_rgba8();
    let width = rgba.width() as usize;
    let height = rgba.height() as usize;
    Ok((rgba.into_raw(), width, height))
}

fn copy_payload_to_clipboard(payload: &ClipboardPayload) -> Result<(), String> {
    let mut clipboard = Clipboard::new().map_err(|error| error.to_string())?;
    match payload {
        ClipboardPayload::Text(content) => clipboard.set_text(content.clone()).map_err(|error| error.to_string()),
        ClipboardPayload::Image {
            data_url,
            width,
            height,
        } => {
            let (rgba, _, _) = decode_image_data_url(data_url)?;
            clipboard
                .set_image(ClipboardImageData {
                    width: *width,
                    height: *height,
                    bytes: Cow::Owned(rgba),
                })
                .map_err(|error| error.to_string())
        }
    }
}

fn paste_to_focused_app(app: AppHandle, payload: ClipboardPayload) -> Result<(), String> {
    copy_payload_to_clipboard(&payload)?;

    let prev_window_state = app.state::<PreviousWindow>();
    let window_id = prev_window_state
        .0
        .lock()
        .map(|mut value| value.take())
        .unwrap_or(None)
        .or_else(|| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.hide();
                let _ = window.set_always_on_top(false);
            }
            thread::sleep(Duration::from_millis(100));
            paste::capture_active_window()
        });

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
        let _ = window.set_always_on_top(false);
    }

    if let Some(id) = window_id {
        paste::focus_and_paste(&id)?;
    }

    Ok(())
}

fn read_mouse_position() -> Option<(f64, f64)> {
    let output = Command::new("xdotool")
        .args(["getmouselocation", "--shell"])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8(output.stdout).ok()?;
    let mut x = None;
    let mut y = None;
    for line in stdout.lines() {
        if let Some(value) = line.strip_prefix("X=") {
            x = value.parse::<f64>().ok();
        }
        if let Some(value) = line.strip_prefix("Y=") {
            y = value.parse::<f64>().ok();
        }
    }

    Some((x?, y?))
}

fn show_window_for_current_settings(app: &AppHandle) {
    let clipboard_state = app.state::<ClipboardState>();
    let settings = clipboard_state
        .0
        .lock()
        .map(|store| store.settings.clone());
    let tray_anchor = app
        .state::<TrayAnchorState>()
        .0
        .lock()
        .ok()
        .and_then(|value| *value);

    if let Ok(settings) = settings {
        show_main_window(app, &settings, tray_anchor);
    }
}

fn register_global_shortcut(app: &AppHandle, shortcut: &str) -> Result<(), String> {
    let shortcut = shortcut.trim();
    if shortcut.is_empty() {
        return Ok(());
    }

    app.global_shortcut()
        .on_shortcut(shortcut, move |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                if let Ok(mut previous) = app.state::<PreviousWindow>().0.lock() {
                    *previous = paste::capture_active_window();
                }
                show_window_for_current_settings(app);
            }
        })
        .map_err(|error| error.to_string())
}

fn sync_global_shortcut(app: &AppHandle, previous: &str, next: &str) -> Result<(), String> {
    let previous = previous.trim();
    let next = next.trim();

    if previous == next {
        return Ok(());
    }

    if !previous.is_empty() {
        let _ = app.global_shortcut().unregister(previous);
    }

    if next.is_empty() {
        return Ok(());
    }

    match register_global_shortcut(app, next) {
        Ok(()) => Ok(()),
        Err(error) => {
            if !previous.is_empty() {
                let _ = register_global_shortcut(app, previous);
            }
            Err(error)
        }
    }
}

fn should_relayout_window(previous: &Settings, next: &Settings) -> bool {
    previous.default_view != next.default_view || previous.window_anchor != next.window_anchor
}

fn apply_window_layout(app: &AppHandle, settings: &Settings, tray_anchor: Option<(f64, f64)>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_decorations(false);
        let (width, height, min_width, min_height) = match settings.default_view {
            DefaultView::Manager => (1080.0, 720.0, 960.0, 680.0),
            DefaultView::Picker => (420.0, 640.0, 380.0, 560.0),
        };

        let _ = window.set_min_size(Some(LogicalSize::new(min_width, min_height)));
        let _ = window.set_size(LogicalSize::new(width, height));

        let mut monitor_x = 0.0;
        let mut monitor_y = 0.0;
        let mut monitor_w = 0.0;
        let mut monitor_h = 0.0;
        let mut found_monitor = false;

        // Çoklu monitör desteği için fare imlecinin bulunduğu monitörü tespit etmeye çalış
        if let Some((mouse_x, mouse_y)) = read_mouse_position() {
            if let Ok(monitors) = window.available_monitors() {
                for m in monitors {
                    let scale_factor = m.scale_factor();
                    let pos = m.position();
                    let size = m.size();
                    let m_x = pos.x as f64 / scale_factor;
                    let m_y = pos.y as f64 / scale_factor;
                    let m_w = size.width as f64 / scale_factor;
                    let m_h = size.height as f64 / scale_factor;
                    
                    if mouse_x >= m_x && mouse_x <= m_x + m_w && mouse_y >= m_y && mouse_y <= m_y + m_h {
                        monitor_x = m_x;
                        monitor_y = m_y;
                        monitor_w = m_w;
                        monitor_h = m_h;
                        found_monitor = true;
                        break;
                    }
                }
            }
        }

        // Eğer fare imleci bir monitör sınırında bulunamadıysa pencerenin olduğu veya birincil monitörü baz al
        if !found_monitor {
            if let Some(m) = window.current_monitor().ok().flatten().or_else(|| window.primary_monitor().ok().flatten()) {
                let scale_factor = m.scale_factor();
                let pos = m.position();
                let size = m.size();
                monitor_x = pos.x as f64 / scale_factor;
                monitor_y = pos.y as f64 / scale_factor;
                monitor_w = size.width as f64 / scale_factor;
                monitor_h = size.height as f64 / scale_factor;
            }
        }

        match settings.window_anchor {
            WindowAnchor::Center => {
                let _ = window.center();
            }
            WindowAnchor::Mouse => {
                if let Some((mouse_x, mouse_y)) = read_mouse_position() {
                    let mut target_x = mouse_x - width / 2.0;
                    let mut target_y = mouse_y - 36.0;
                    
                    if monitor_w > 0.0 && monitor_h > 0.0 {
                        let max_x = monitor_x + monitor_w - width;
                        target_x = target_x.clamp(monitor_x, max_x.max(monitor_x));
                        let max_y = monitor_y + monitor_h - height;
                        target_y = target_y.clamp(monitor_y, max_y.max(monitor_y));
                    }
                    let _ = window.set_position(LogicalPosition::new(target_x, target_y));
                } else {
                    let _ = window.center();
                }
            }
            WindowAnchor::Fixed => {
                let scale_factor = window
                    .current_monitor()
                    .ok()
                    .flatten()
                    .or_else(|| window.primary_monitor().ok().flatten())
                    .map(|m| m.scale_factor())
                    .unwrap_or(1.0);

                let (anchor_x, anchor_y) = if let Some((phys_x, phys_y)) = tray_anchor {
                    (phys_x / scale_factor, phys_y / scale_factor)
                } else {
                    let mut x = monitor_x + monitor_w - 120.0;
                    let mut y = monitor_y + 20.0; // GNOME/Unity top-right default

                    if let Ok(desktop) = std::env::var("XDG_CURRENT_DESKTOP") {
                        let desktop_lower = desktop.to_lowercase();
                        if !desktop_lower.contains("gnome") && !desktop_lower.contains("unity") {
                            x = monitor_x + monitor_w - 120.0;
                            y = monitor_y + monitor_h - 24.0; // KDE/XFCE/Windows bottom-right
                        }
                    }
                    (x, y)
                };

                let mut target_x = anchor_x - width / 2.0;

                let is_bottom = if monitor_h > 0.0 {
                    anchor_y > monitor_y + monitor_h / 2.0
                } else {
                    anchor_y > 540.0
                };

                let panel_height = if is_bottom {
                    (monitor_y + monitor_h - anchor_y) * 2.0
                } else {
                    (anchor_y - monitor_y) * 2.0
                };
                let panel_height = panel_height.clamp(16.0, 96.0);

                let mut target_y = if is_bottom {
                    monitor_y + monitor_h - panel_height - height - 10.0
                } else {
                    monitor_y + panel_height + 10.0
                };
                
                if monitor_w > 0.0 && monitor_h > 0.0 {
                    let margin = 8.0;
                    let min_x = monitor_x + margin;
                    let max_x = monitor_x + monitor_w - width - margin;
                    target_x = target_x.clamp(min_x, max_x.max(min_x));

                    let min_y = monitor_y + margin;
                    let max_y = monitor_y + monitor_h - height - margin;
                    target_y = target_y.clamp(min_y, max_y.max(min_y));
                }
                let _ = window.set_position(LogicalPosition::new(target_x, target_y));
            }
        }
    }
}

fn show_main_window(app: &AppHandle, settings: &Settings, tray_anchor: Option<(f64, f64)>) {
    println!("[Rust] show_main_window called");
    if let Ok(mut previous) = app.state::<PreviousWindow>().0.lock() {
        *previous = paste::capture_active_window();
    }
    apply_window_layout(app, settings, tray_anchor);
    if let Some(window) = app.get_webview_window("main") {
        println!("[Rust] Found main window, showing now...");
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_always_on_top(true);
        let _ = window.emit("window://shown", ());
    } else {
        println!("[Rust] Main window NOT found!");
    }
}

fn spawn_clipboard_watcher(app: AppHandle, state: ClipboardState) {
    thread::spawn(move || {
        let mut clipboard = match Clipboard::new() {
            Ok(clipboard) => clipboard,
            Err(_) => return,
        };
        let mut last_seen = ClipboardFingerprint::None;

        loop {
            let (is_loaded, interval) = if let Ok(store) = state.0.lock() {
                (store.is_loaded, store.settings.poll_interval_ms)
            } else {
                (false, default_poll_interval_ms())
            };

            if !is_loaded {
                thread::sleep(Duration::from_millis(100));
                continue;
            }

            if let Ok(text) = clipboard.get_text() {
                if !text.trim().is_empty() {
                    let fingerprint = ClipboardFingerprint::Text(text.clone());
                    let changed = !matches!(&last_seen, ClipboardFingerprint::Text(previous) if previous == &text);
                    if changed {
                        last_seen = fingerprint;
                        if let Ok(mut store) = state.0.lock() {
                            if store.upsert_text(text, "clipboard") {
                                let items = store.items.clone();
                                let _ = store.save();
                                drop(store);
                                emit_items(&app, &items);
                            }
                        }
                    }
                    thread::sleep(Duration::from_millis(interval.max(250)));
                    continue;
                }
            }

            if let Ok(image) = clipboard.get_image() {
                let hash = fingerprint_image(image.bytes.as_ref(), image.width, image.height);
                let changed = !matches!(&last_seen, ClipboardFingerprint::Image(previous) if *previous == hash);
                if changed {
                    last_seen = ClipboardFingerprint::Image(hash);
                    if let Ok(data_url) = encode_png_data_url(image.bytes.as_ref(), image.width, image.height) {
                        if let Ok(mut store) = state.0.lock() {
                            if store.upsert_image(data_url, image.width, image.height, image.bytes.len(), "clipboard-image") {
                                let items = store.items.clone();
                                let _ = store.save();
                                drop(store);
                                emit_items(&app, &items);
                            }
                        }
                    }
                }
            }

            thread::sleep(Duration::from_millis(interval.max(250)));
        }
    });
}

fn setup_tray(app: &tauri::App) -> tauri::Result<tauri::tray::TrayIcon> {
    let show_i = MenuItemBuilder::new("Göster").id("show").build(app)?;
    let quit_i = MenuItemBuilder::new("Çıkış").id("quit").build(app)?;
    let menu = MenuBuilder::new(app)
        .item(&show_i)
        .separator()
        .item(&quit_i)
        .build()?;

    let tray = TrayIconBuilder::with_id("clipnest-tray")
        .tooltip("ClipNest")
        .icon(tauri::image::Image::from_bytes(include_bytes!("../icons/128x128.png")).expect("failed to load tray icon"))
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            match event.id.as_ref() {
                "show" => {
                    show_window_for_current_settings(app);
                }
                "quit" => {
                    app.exit(0);
                }
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            match event {
                TrayIconEvent::Click {
                    button_state,
                    position,
                    ..
                } => {
                    let app = tray.app_handle();
                    let anchor_x = position.x;
                    let anchor_y = position.y;
                    let tray_anchor_state = app.state::<TrayAnchorState>();
                    if let Ok(mut anchor) = tray_anchor_state.0.lock() {
                        *anchor = Some((anchor_x, anchor_y));
                    }

                    if button_state == MouseButtonState::Up {
                        let state = app.state::<ClipboardState>();
                        if let Ok(store) = state.0.lock() {
                            show_main_window(app, &store.settings, Some((anchor_x, anchor_y)));
                        };
                    }
                }
                TrayIconEvent::Move { position, .. } | TrayIconEvent::Enter { position, .. } => {
                    let app = tray.app_handle();
                    let tray_anchor_state = app.state::<TrayAnchorState>();
                    if let Ok(mut anchor) = tray_anchor_state.0.lock() {
                        *anchor = Some((position.x, position.y));
                    };
                }
                _ => {}
            }
        })
        .build(app)?;

    Ok(tray)
}

#[tauri::command]
fn get_snapshot(state: State<'_, ClipboardState>) -> Result<ClipboardSnapshot, String> {
    loop {
        if let Ok(store) = state.0.lock() {
            if store.is_loaded {
                return Ok(store.snapshot());
            }
        }
        thread::sleep(Duration::from_millis(5));
    }
}

#[tauri::command]
fn copy_item(id: String, state: State<'_, ClipboardState>) -> Result<Vec<ClipboardItem>, String> {
    let payload = {
        let store = state.0.lock().map_err(|error| error.to_string())?;
        let item = store
            .items
            .iter()
            .find(|item| item.id == id)
            .ok_or_else(|| "Kayıt bulunamadı".to_string())?;

        match item.kind {
            ClipboardKind::Text => ClipboardPayload::Text(item.content.clone()),
            ClipboardKind::Image => ClipboardPayload::Image {
                data_url: item.content.clone(),
                width: item.image_width.unwrap_or(0),
                height: item.image_height.unwrap_or(0),
            },
        }
    };

    copy_payload_to_clipboard(&payload)?;

    let mut store = state.0.lock().map_err(|error| error.to_string())?;
    match payload {
        ClipboardPayload::Text(content) => {
            store.upsert_text(content, "manual-copy");
        }
        ClipboardPayload::Image {
            data_url,
            width,
            height,
        } => {
            let (_, encoded) = data_url
                .split_once(',')
                .ok_or_else(|| "Görsel verisi çözülemedi".to_string())?;
            let byte_size = STANDARD.decode(encoded).map_err(|error| error.to_string())?.len();
            store.upsert_image(data_url, width, height, byte_size, "manual-copy");
        }
    }
    store.save()?;
    Ok(store.items.clone())
}

#[tauri::command]
fn create_item(content: String, source: String, state: State<'_, ClipboardState>) -> Result<Vec<ClipboardItem>, String> {
    copy_payload_to_clipboard(&ClipboardPayload::Text(content.clone()))?;
    let mut store = state.0.lock().map_err(|error| error.to_string())?;
    store.upsert_text(content, &source);
    store.save()?;
    Ok(store.items.clone())
}

#[tauri::command]
fn paste_to_previous(
    content: String,
    kind: ClipboardKind,
    image_width: Option<usize>,
    image_height: Option<usize>,
    source: Option<String>,
    app: AppHandle,
    prev_window: State<'_, PreviousWindow>,
    state: State<'_, ClipboardState>,
) -> Result<Vec<ClipboardItem>, String> {
    let payload = match kind {
        ClipboardKind::Text => ClipboardPayload::Text(content.clone()),
        ClipboardKind::Image => {
            let width = image_width.unwrap_or(0);
            let height = image_height.unwrap_or(0);
            let (resolved_width, resolved_height) = if width == 0 || height == 0 {
                let (_, decoded_width, decoded_height) = decode_image_data_url(&content)?;
                (decoded_width, decoded_height)
            } else {
                (width, height)
            };
            ClipboardPayload::Image {
                data_url: content.clone(),
                width: resolved_width,
                height: resolved_height,
            }
        }
    };

    copy_payload_to_clipboard(&payload)?;

    let window_id = prev_window
        .0
        .lock()
        .map(|mut value| value.take())
        .map_err(|error| error.to_string())?
        .or_else(|| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.hide();
                let _ = window.set_always_on_top(false);
            }
            thread::sleep(Duration::from_millis(100));
            paste::capture_active_window()
        });

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
        let _ = window.set_always_on_top(false);
    }

    if let Some(id) = window_id {
        paste::focus_and_paste(&id)?;
    }

    let mut store = state.0.lock().map_err(|error| error.to_string())?;
    let source = source.unwrap_or_else(|| "quick-paste".to_string());
    match payload {
        ClipboardPayload::Text(text) => {
            store.upsert_text(text, &source);
        }
        ClipboardPayload::Image {
            data_url,
            width,
            height,
        } => {
            let (_, encoded) = data_url
                .split_once(',')
                .ok_or_else(|| "Gorsel verisi cozulmedi".to_string())?;
            let byte_size = STANDARD.decode(encoded).map_err(|error| error.to_string())?.len();
            store.upsert_image(data_url, width, height, byte_size, &source);
        }
    }
    store.save()?;
    Ok(store.items.clone())
}

#[tauri::command]
fn paste_item(id: String, app: AppHandle, state: State<'_, ClipboardState>) -> Result<Vec<ClipboardItem>, String> {
    let payload = {
        let store = state.0.lock().map_err(|error| error.to_string())?;
        let item = store
            .items
            .iter()
            .find(|item| item.id == id)
            .ok_or_else(|| "Kayıt bulunamadı".to_string())?;

        match item.kind {
            ClipboardKind::Text => ClipboardPayload::Text(item.content.clone()),
            ClipboardKind::Image => ClipboardPayload::Image {
                data_url: item.content.clone(),
                width: item.image_width.unwrap_or(0),
                height: item.image_height.unwrap_or(0),
            },
        }
    };

    paste_to_focused_app(app, payload.clone())?;

    let mut store = state.0.lock().map_err(|error| error.to_string())?;
    match payload {
        ClipboardPayload::Text(content) => {
            store.upsert_text(content, "quick-paste");
        }
        ClipboardPayload::Image {
            data_url,
            width,
            height,
        } => {
            let (_, encoded) = data_url
                .split_once(',')
                .ok_or_else(|| "Görsel verisi çözülemedi".to_string())?;
            let byte_size = STANDARD.decode(encoded).map_err(|error| error.to_string())?.len();
            store.upsert_image(data_url, width, height, byte_size, "quick-paste");
        }
    }
    store.save()?;
    Ok(store.items.clone())
}

#[tauri::command]
fn paste_text(content: String, source: String, app: AppHandle, state: State<'_, ClipboardState>) -> Result<Vec<ClipboardItem>, String> {
    paste_to_focused_app(app, ClipboardPayload::Text(content.clone()))?;

    let mut store = state.0.lock().map_err(|error| error.to_string())?;
    store.upsert_text(content, &source);
    store.save()?;
    Ok(store.items.clone())
}

#[tauri::command]
fn delete_item(id: String, state: State<'_, ClipboardState>) -> Result<Vec<ClipboardItem>, String> {
    let mut store = state.0.lock().map_err(|error| error.to_string())?;
    store.items.retain(|item| item.id != id);
    store.save()?;
    Ok(store.items.clone())
}

#[tauri::command]
fn clear_history(keep_favorites: bool, state: State<'_, ClipboardState>) -> Result<Vec<ClipboardItem>, String> {
    let mut store = state.0.lock().map_err(|error| error.to_string())?;
    if keep_favorites {
        store.items.retain(|item| item.favorite);
    } else {
        store.items.clear();
    }
    store.save()?;
    Ok(store.items.clone())
}

#[tauri::command]
fn toggle_favorite(id: String, state: State<'_, ClipboardState>) -> Result<Vec<ClipboardItem>, String> {
    let mut store = state.0.lock().map_err(|error| error.to_string())?;
    if let Some(item) = store.items.iter_mut().find(|item| item.id == id) {
        item.favorite = !item.favorite;
    }
    store.save()?;
    Ok(store.items.clone())
}

#[tauri::command]
fn update_settings(settings: Settings, app: AppHandle, state: State<'_, ClipboardState>) -> Result<ClipboardSnapshot, String> {
    let store = state.0.lock().map_err(|error| error.to_string())?;
    let previous_settings = store.settings.clone();
    let previous_shortcut = store.settings.shortcut.clone();
    let next_settings = Settings {
        max_items: settings.max_items.clamp(25, 1000),
        poll_interval_ms: settings.poll_interval_ms.clamp(300, 3000),
        auto_trim: settings.auto_trim,
        locale: settings.locale,
        theme: settings.theme,
        default_view: settings.default_view,
        window_anchor: settings.window_anchor,
        ui_scale: settings.ui_scale.clamp(90, 115),
        shortcut: settings.shortcut.trim().to_string(),
    };

    drop(store);
    sync_global_shortcut(&app, &previous_shortcut, &next_settings.shortcut)?;

    let mut store = state.0.lock().map_err(|error| error.to_string())?;
    store.settings = Settings {
        max_items: next_settings.max_items,
        poll_interval_ms: next_settings.poll_interval_ms,
        auto_trim: next_settings.auto_trim,
        locale: next_settings.locale,
        theme: next_settings.theme,
        default_view: next_settings.default_view,
        window_anchor: next_settings.window_anchor,
        ui_scale: next_settings.ui_scale,
        shortcut: next_settings.shortcut,
    };
    store.trim();
    store.save()?;
    let snapshot = store.snapshot();
    let saved_settings = store.settings.clone();
    drop(store);
    if should_relayout_window(&previous_settings, &saved_settings) {
        let tray_anchor_state = app.state::<TrayAnchorState>();
        let tray_anchor = tray_anchor_state.0.lock().ok().and_then(|value| *value);
        apply_window_layout(&app, &saved_settings, tray_anchor);
    }
    Ok(snapshot)
}

#[tauri::command]
fn uninstall_app(password: String, app: AppHandle) -> Result<serde_json::Value, String> {
    if !cfg!(target_os = "linux") {
        return Err("Uygulamayı kaldırmak yalnızca Linux'ta desteklenir".to_string());
    }

    cleanup_user_remnants()?;

    let packages = installed_package_names()?;
    if packages.is_empty() {
        return Ok(serde_json::json!({ "success": true }));
    }

    let dpkg = find_executable(&["/usr/bin/dpkg", "/bin/dpkg"])
        .ok_or_else(|| "dpkg bulunamadı".to_string())?;
    let sudo = find_executable(&["/usr/bin/sudo", "/bin/sudo"])
        .ok_or_else(|| "sudo bulunamadı".to_string())?;

    let mut child = Command::new(sudo)
        .arg("-S")
        .arg(dpkg)
        .arg("--purge")
        .args(&packages)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|error| format!("sudo çalıştırılamadı: {}", error))?;

    if let Some(mut stdin) = child.stdin.take() {
        use std::io::Write;
        let _ = stdin.write_all(password.as_bytes());
        let _ = stdin.write_all(b"\n");
    }

    let output = child
        .wait_with_output()
        .map_err(|error| format!("Kaldırma başarısız: {}", error))?;

    if output.status.success() {
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(300));
            app.exit(0);
        });
        Ok(serde_json::json!({ "success": true }))
    } else {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let error = String::from_utf8_lossy(&output.stderr);
        Err(format!("Kaldırma başarısız: {}{}", stdout, error))
    }
}

fn installed_package_names() -> Result<Vec<String>, String> {
    let output = Command::new("dpkg-query")
        .args(["-W", "-f=${binary:Package}\n"])
        .args(PACKAGE_CANDIDATES)
        .output()
        .map_err(|error| format!("Paket sorgulanamadı: {}", error))?;

    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(ToOwned::to_owned)
        .collect())
}

fn find_executable(candidates: &'static [&'static str]) -> Option<&'static str> {
    candidates.iter().copied().find(|path| Path::new(path).exists())
}

fn cleanup_user_remnants() -> Result<(), String> {
    remove_gnome_shortcut()?;

    if let Some(config_dir) = dirs::config_dir() {
        for path in [
            config_dir.join("autostart").join("ClipNest.desktop"),
            config_dir.join("autostart").join("clipnest.desktop"),
            config_dir.join("autostart").join("io.github.salihoz.clipnest.desktop"),
            config_dir.join("ClipNest"),
            config_dir.join("clipnest"),
            config_dir.join("io.github.salihoz.clipnest"),
        ] {
            remove_path_if_exists(&path)?;
        }
    }

    if let Some(data_dir) = dirs::data_local_dir() {
        for path in [
            data_dir.join("ClipNest"),
            data_dir.join("clipnest"),
            data_dir.join("io.github.salihoz.clipnest"),
            data_dir.join("applications").join("ClipNest.desktop"),
            data_dir.join("applications").join("clipnest.desktop"),
            data_dir.join("applications").join("io.github.salihoz.clipnest.desktop"),
        ] {
            remove_path_if_exists(&path)?;
        }
    }

    if let Some(cache_dir) = dirs::cache_dir() {
        for path in [
            cache_dir.join("ClipNest"),
            cache_dir.join("clipnest"),
            cache_dir.join("io.github.salihoz.clipnest"),
        ] {
            remove_path_if_exists(&path)?;
        }
    }

    Ok(())
}

fn remove_path_if_exists(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }

    if path.is_dir() {
        fs::remove_dir_all(path).map_err(|error| format!("{} silinemedi: {}", path.display(), error))
    } else {
        fs::remove_file(path).map_err(|error| format!("{} silinemedi: {}", path.display(), error))
    }
}

fn remove_gnome_shortcut() -> Result<(), String> {
    let schema = "org.gnome.settings-daemon.plugins.media-keys";
    let output = Command::new("gsettings")
        .args(["get", schema, "custom-keybindings"])
        .output();

    let Ok(output) = output else {
        return Ok(());
    };

    if !output.status.success() {
        return Ok(());
    }

    let current = String::from_utf8_lossy(&output.stdout);
    let mut bindings = parse_gsettings_string_list(&current);
    let candidates = [
        "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/clipnest/",
        "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/io-github-salihoz-clipnest/",
    ];

    for binding in bindings.clone() {
        if candidates.contains(&binding.as_str()) || gnome_binding_points_to_clipnest(&binding) {
            reset_gnome_binding(&binding);
            bindings.retain(|item| item != &binding);
        }
    }

    let next = format!(
        "[{}]",
        bindings
            .iter()
            .map(|binding| format!("'{}'", binding.replace('\'', "\\'")))
            .collect::<Vec<_>>()
            .join(", ")
    );

    let status = Command::new("gsettings")
        .args(["set", schema, "custom-keybindings", &next])
        .status()
        .map_err(|error| format!("GNOME kısayolu temizlenemedi: {}", error))?;

    if status.success() {
        Ok(())
    } else {
        Err("GNOME kısayolu temizlenemedi".to_string())
    }
}

fn parse_gsettings_string_list(value: &str) -> Vec<String> {
    value
        .split('\'')
        .enumerate()
        .filter_map(|(index, part)| {
            if index % 2 == 1 {
                Some(part.to_string())
            } else {
                None
            }
        })
        .collect()
}

fn gnome_binding_points_to_clipnest(binding: &str) -> bool {
    let schema = format!("org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:{binding}");
    for key in ["name", "command"] {
        if let Ok(output) = Command::new("gsettings").args(["get", &schema, key]).output() {
            let value = String::from_utf8_lossy(&output.stdout).to_lowercase();
            if value.contains("clipnest") || value.contains("clip-nest") {
                return true;
            }
        }
    }

    false
}

fn reset_gnome_binding(binding: &str) {
    let schema = format!("org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:{binding}");
    for key in ["name", "command", "binding"] {
        let _ = Command::new("gsettings").args(["reset", &schema, key]).status();
    }
}

#[tauri::command]
fn minimize_window(window: tauri::Window) {
    let _ = window.minimize();
}

#[tauri::command]
fn hide_window(window: tauri::Window) {
    let _ = window.hide();
}

#[tauri::command]
fn exit_app(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn app_ready(app: AppHandle) {
    let clipboard_state = app.state::<ClipboardState>();
    let settings = clipboard_state
        .0
        .lock()
        .map(|store| store.settings.clone());
    let is_autostart = is_autostart_launch();
    
    if let Ok(settings) = settings {
        if !is_autostart {
            show_main_window(&app, &settings, None);
        }
    }
}

pub fn run() {
    std::env::remove_var("DESKTOP_STARTUP_ID");
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
                show_window_for_current_settings(app);
            }))
            .plugin(tauri_plugin_autostart::init(
                tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                Some(vec![AUTOSTART_ARG]),
            ));
    }

    builder
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }

            match event {
                WindowEvent::CloseRequested { api, .. } => {
                    if window.state::<QuitState>().0.load(Ordering::Relaxed) {
                        return;
                    }

                    api.prevent_close();
                    let _ = window.hide();
                }
                _ => {}
            }
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            let history_file_path = app_data_path(app);
            let settings_file_path = history_file_path.with_file_name("settings.json");

            // 1. Settings'i senkronize olarak hızlıca yükle (anında yüklenir)
            let settings = load_settings(&settings_file_path, &history_file_path);

            // 2. ClipboardStore'u boş öğelerle ama yüklenen ayarlarla ilklendir
            let store = ClipboardStore {
                items: Vec::new(),
                settings: settings.clone(),
                path: history_file_path.clone(),
                is_loaded: false,
            };
            let state = ClipboardState(Arc::new(Mutex::new(store)));
            let tray_anchor_state = TrayAnchorState(Arc::new(Mutex::new(None)));
            let quit_state = QuitState(Arc::new(AtomicBool::new(false)));
            let previous_window = PreviousWindow(Mutex::new(None));
            app.manage(state.clone());
            app.manage(tray_anchor_state.clone());
            app.manage(quit_state.clone());
            app.manage(previous_window);
            // Tray icon'u TrayIconHolder ile yönetilen state'e al — drop olmaz
            let tray_icon = setup_tray(app)?;
            app.manage(TrayIconHolder(tray_icon));

            // 3. Kısayolu kaydet ve pencere yerleşimini hemen uygula
            let _ = register_global_shortcut(&app.handle(), &settings.shortcut);
            apply_window_layout(&app.handle(), &settings, None);

            // 4. Geçmiş öğelerini arka planda asenkron olarak yükle
            let app_handle = app.handle().clone();
            let state_clone = state.clone();
            let history_path_clone = history_file_path.clone();
            thread::spawn(move || {
                let items = load_items(&history_path_clone);
                if let Ok(mut store) = state_clone.0.lock() {
                    store.items = items.clone();
                    store.is_loaded = true;
                    // Ayarlar ile geçmişi ayırmak ve dosyayı yeni formatta kaydetmek için bir kez tetikle
                    let _ = store.save();
                    emit_items(&app_handle, &items);
                }
            });

            #[cfg(all(desktop, not(debug_assertions)))]
            {
                use tauri_plugin_autostart::ManagerExt;

                let autostart_manager = app.autolaunch();
                if autostart_manager.is_enabled().ok() != Some(true) {
                    let _ = autostart_manager.enable();
                }
            }

            spawn_clipboard_watcher(app.handle().clone(), state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_snapshot,
            create_item,
            copy_item,
            paste_to_previous,
            paste_item,
            paste_text,
            delete_item,
            clear_history,
            toggle_favorite,
            update_settings,
            uninstall_app,
            minimize_window,
            hide_window,
            exit_app,
            app_ready
        ])
        .run(tauri::generate_context!())
        .expect("error while running ClipNest");
}
