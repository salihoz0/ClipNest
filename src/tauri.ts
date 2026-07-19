import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type ClipboardItem = {
  id: string;
  content: string;
  preview: string;
  kind: "text" | "image";
  favorite: boolean;
  created_at: string;
  copied_at: string;
  copy_count: number;
  source: string;
  size: number;
  image_width?: number | null;
  image_height?: number | null;
};

export type Settings = {
  max_items: number;
  poll_interval_ms: number;
  auto_trim: boolean;
  locale: "tr" | "en";
  theme: "light" | "dark" | "system";
  default_view: "picker" | "manager";
  window_anchor: "center" | "mouse" | "fixed";
  ui_scale: number;
  shortcut: string;
};

export type ClipboardSnapshot = {
  items: ClipboardItem[];
  settings: Settings;
};

const isTauri = typeof window !== "undefined" && (window as any).__TAURI_INTERNALS__ !== undefined;

// Mock data for beautiful dummy screenshots
const mockItems: ClipboardItem[] = [
  {
    id: "1",
    content: "Tauri 2.0 is a framework for building tiny, blazing fast binaries for all major desktop platforms.",
    preview: "Tauri 2.0 is a framework for building tiny, blazing fast binaries...",
    kind: "text",
    favorite: true,
    created_at: new Date().toISOString(),
    copied_at: new Date().toISOString(),
    copy_count: 5,
    source: "clipboard",
    size: 92
  },
  {
    id: "2",
    content: "git clone https://github.com/salihoz0/ClipNest.git",
    preview: "git clone https://github.com/salihoz0/ClipNest.git",
    kind: "text",
    favorite: false,
    created_at: new Date().toISOString(),
    copied_at: new Date().toISOString(),
    copy_count: 1,
    source: "clipboard",
    size: 47
  },
  {
    id: "3",
    content: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAAABmJLR0QA/wD/AP+gvaeTAAAACXBIWXMAAAsTAAALEwEAmpwYAAAAB3RJTUUHBgUTDA0hDC0sPwAAAB1pVFh0Q29tbWVudAAAAAAAQ3JlYXRlZCB3aXRoIEdJTVBkLmleAAACwElEQVR42u3dsW3CUBiFYVNDYgRGBmFkCEZgBEbghB0YgQkYoRMYgQnshCmyA0ZghA6IERiBESq6g5IipUhBOMT3S870KyNeeX2S49uOEQAAAAAAAADw7/bHegN4b/d1vQECIAACIAACIAACIAACIAACIAACIAACIAACIAACIAACIAACICCr1x+g9/64tU9/92n3d13vAARAAARAAARAAARAAARAAARAAARAAARAAARAAARAAARAAARAQDoEQL7p9q5P/tKj73u2vW/WewABEAABEAABEAABEAABEAABEAABEAABEAABEAABEAABEAABEJDmAXS/939m22P2XdeZPwACIAACIAACIAACIAACIAACIAACIAACIAACIAACIAACIAACICDNAtQ2d3/5d1xX/wYIgAAIgAAIgAAIgAAIgAAIgAAIgAAIgAAIgAAIgAAIgAAIgIA0DSDX3D2tewMCIAACIAACIAACIAACIAACIAACIAACIAACIAACIAACIAACICDNA5Tr7tO6NyAAAiAAAiAAAiAAAiAAAiAAAiAAAiAAAiAAAiAAAiAAAiAgzQLk/d3/1m5+rncAAiAAAiAAAiAAAiAAAiAAAiAAAiAAAiAAAiAAAiAAAiAAAtIsQG5r//f2s85+97HuvgEQAAEQAAEQAAEQAAEQAAEQAAEQAAEQAAEQAAEQAAEQAAEQkE4B8tr+mO0x+/XpX3v2uc5+97XeBwiAAAiAAAiAAAiAAAiAAAiAAAiAAAiAAAiAAAiAAAiAAAhItwD4t1v/9vdf9wEEQAAEQAAEQAAEQAAEQAAEQAAEQAAEQAAEQAAEQAAEQAAEpHOAHgAAAAAAAADw3x0A",
    preview: "128×128 görsel (ClipNest Logo)",
    kind: "image",
    favorite: false,
    created_at: new Date().toISOString(),
    copied_at: new Date().toISOString(),
    copy_count: 1,
    source: "clipboard-image",
    size: 2400,
    image_width: 128,
    image_height: 128
  },
  {
    id: "4",
    content: "sudo dpkg -i ClipNest_1.0.0_amd64.deb",
    preview: "sudo dpkg -i ClipNest_1.0.0_amd64.deb",
    kind: "text",
    favorite: false,
    created_at: new Date().toISOString(),
    copied_at: new Date().toISOString(),
    copy_count: 2,
    source: "clipboard",
    size: 38
  },
  {
    id: "5",
    content: "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.",
    preview: "Lorem ipsum dolor sit amet, consectetur adipiscing elit...",
    kind: "text",
    favorite: false,
    created_at: new Date().toISOString(),
    copied_at: new Date().toISOString(),
    copy_count: 3,
    source: "clipboard",
    size: 123
  }
];

const mockSettings: Settings = {
  max_items: 200,
  poll_interval_ms: 800,
  auto_trim: true,
  locale: "tr",
  theme: "dark",
  default_view: "picker",
  window_anchor: "center",
  ui_scale: 100,
  shortcut: "Super+Shift+V"
};

export function getSnapshot() {
  if (!isTauri) {
    return Promise.resolve({
      items: mockItems,
      settings: mockSettings
    });
  }
  return invoke<ClipboardSnapshot>("get_snapshot");
}

export function copyItem(id: string) {
  if (!isTauri) {
    return Promise.resolve(mockItems);
  }
  return invoke<ClipboardItem[]>("copy_item", { id });
}

export function pasteItem(id: string) {
  if (!isTauri) {
    return Promise.resolve(mockItems);
  }
  return invoke<ClipboardItem[]>("paste_item", { id });
}

export function pasteToPrevious(payload: {
  content: string;
  kind: ClipboardItem["kind"];
  imageWidth?: number;
  imageHeight?: number;
  source?: string;
}) {
  if (!isTauri) {
    return Promise.resolve(mockItems);
  }
  return invoke<ClipboardItem[]>("paste_to_previous", {
    content: payload.content,
    kind: payload.kind,
    image_width: payload.imageWidth,
    image_height: payload.imageHeight,
    source: payload.source
  });
}

export function pasteText(content: string, source = "symbol") {
  if (!isTauri) {
    return Promise.resolve(mockItems);
  }
  return invoke<ClipboardItem[]>("paste_text", { content, source });
}

export function createItem(content: string, source = "manual") {
  if (!isTauri) {
    return Promise.resolve(mockItems);
  }
  return invoke<ClipboardItem[]>("create_item", { content, source });
}

export function deleteItem(id: string) {
  if (!isTauri) {
    return Promise.resolve(mockItems.filter(item => item.id !== id));
  }
  return invoke<ClipboardItem[]>("delete_item", { id });
}

export function clearHistory(keepFavorites: boolean) {
  if (!isTauri) {
    return Promise.resolve(mockItems.filter(item => item.favorite && keepFavorites));
  }
  return invoke<ClipboardItem[]>("clear_history", { keep_favorites: keepFavorites });
}

export function toggleFavorite(id: string) {
  if (!isTauri) {
    const item = mockItems.find(item => item.id === id);
    if (item) item.favorite = !item.favorite;
    return Promise.resolve([...mockItems]);
  }
  return invoke<ClipboardItem[]>("toggle_favorite", { id });
}

export function updateSettings(settings: Settings) {
  if (!isTauri) {
    return Promise.resolve({
      items: mockItems,
      settings
    });
  }
  return invoke<ClipboardSnapshot>("update_settings", { settings });
}

export function listenClipboardChange(handler: (items: ClipboardItem[]) => void) {
  if (!isTauri) {
    return Promise.resolve(() => {});
  }
  return listen<ClipboardItem[]>("clipboard://changed", (event) => handler(event.payload));
}

export function hideWindow() {
  if (!isTauri) return Promise.resolve();
  return invoke<void>("hide_window");
}

export function minimizeWindow() {
  if (!isTauri) return Promise.resolve();
  return invoke<void>("minimize_window");
}

export async function uninstallApp(password: string) {
  if (!isTauri) return Promise.resolve({ success: true });
  try {
    return await invoke<{ success: boolean }>("uninstall_app", { password });
  } catch (error) {
    console.error("Uninstall failed:", error);
    throw error;
  }
}

export function exitApp() {
  if (!isTauri) return;
  return invoke<void>("exit_app");
}

export function listenWindowShown(handler: () => void) {
  if (!isTauri) {
    return Promise.resolve(() => {});
  }
  return listen<void>("window://shown", () => handler());
}

export function appReady() {
  if (!isTauri) return Promise.resolve();
  return invoke<void>("app_ready");
}
