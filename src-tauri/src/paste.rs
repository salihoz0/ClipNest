use std::process::Command;

pub fn is_wayland() -> bool {
    std::env::var("WAYLAND_DISPLAY")
        .map(|value| !value.is_empty())
        .unwrap_or(false)
}

pub fn capture_active_window() -> Option<String> {
    if is_wayland() {
        None
    } else {
        let output = Command::new("xdotool").arg("getactivewindow").output().ok()?;
        let id = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if id.is_empty() {
            None
        } else {
            Some(id)
        }
    }
}

pub fn focus_and_paste(window_id: &str) -> Result<(), String> {
    if is_wayland() {
        focus_and_paste_wayland(window_id)
    } else {
        focus_and_paste_x11(window_id)
    }
}

fn focus_and_paste_x11(window_id: &str) -> Result<(), String> {
    // xdotool zincirleme komutları ile tek seferde pencereyi aktifleştirir, 0.1 sn bekler ve ctrl+v simüle eder
    let status = Command::new("xdotool")
        .args([
            "windowactivate",
            "--sync",
            window_id,
            "sleep",
            "0.1",
            "key",
            "--clearmodifiers",
            "ctrl+v",
        ])
        .status()
        .map_err(|error| format!("xdotool hatası: {}", error))?;

    if !status.success() {
        return Err("Yapıştırma simülasyonu başarısız".to_string());
    }

    Ok(())
}

fn focus_and_paste_wayland(window_id: &str) -> Result<(), String> {
    let _ = Command::new("wmctrl").args(["-ia", window_id]).status();

    // Pencerenin öne gelmesi için 80ms bekleme (yeterlidir)
    std::thread::sleep(std::time::Duration::from_millis(80));

    let socket = std::env::var("YDOTOOL_SOCKET").unwrap_or_else(|_| "/tmp/.ydotool_socket".to_string());

    Command::new("ydotool")
        .env("YDOTOOL_SOCKET", &socket)
        .args(["key", "29:1", "47:1", "47:0", "29:0"])
        .status()
        .map_err(|error| format!("ydotool hatası: {error}"))?;

    Ok(())
}

