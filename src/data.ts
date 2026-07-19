import { CHAR } from "unicode-icons";
import type { ClipboardItem } from "./tauri";

type PickerSection = {
  name: string;
  items: string[];
};

type EmojiRecord = {
  char: string;
  name: string;
  group: string;
};

const emojiGroupsOrder = [
  "Smileys & Emotion",
  "People & Body",
  "Animals & Nature",
  "Food & Drink",
  "Travel & Places",
  "Activities",
  "Objects",
  "Symbols",
  "Flags"
] as const;

const emojiGroupNames = {
  tr: {
    "Smileys & Emotion": "Yüzler ve Duygular",
    "People & Body": "İnsanlar ve Jestler",
    "Animals & Nature": "Hayvanlar ve Doğa",
    "Food & Drink": "Yiyecek ve İçecek",
    "Travel & Places": "Seyahat ve Mekanlar",
    Activities: "Aktiviteler",
    Objects: "Nesneler",
    Symbols: "Semboller",
    Flags: "Bayraklar"
  },
  en: {
    "Smileys & Emotion": "Smileys & Emotion",
    "People & Body": "People & Body",
    "Animals & Nature": "Animals & Nature",
    "Food & Drink": "Food & Drink",
    "Travel & Places": "Travel & Places",
    Activities: "Activities",
    Objects: "Objects",
    Symbols: "Symbols",
    Flags: "Flags"
  }
} as const;

function collectChars(source: unknown): string[] {
  if (typeof source === "string") return [source];
  if (!source || typeof source !== "object") return [];

  return Object.values(source).flatMap((value) => collectChars(value));
}

function uniqueItems(items: string[]) {
  return [...new Set(items.filter(Boolean))];
}

function uniqueEmojiItems(records: EmojiRecord[]) {
  const seenNames = new Set<string>();
  const items: string[] = [];

  for (const record of records) {
    if (seenNames.has(record.name)) continue;
    seenNames.add(record.name);
    items.push(record.char);
  }

  return items;
}

const emojiSectionsCache: Partial<Record<"tr" | "en", PickerSection[]>> = {};

const symbolSectionsByLocale: Record<"tr" | "en", PickerSection[]> = {
  tr: [
    { name: "Oklar", items: uniqueItems(collectChars(CHAR.ARROW)) },
    { name: "Para Birimi", items: uniqueItems(collectChars(CHAR.CURRENCY)) },
    { name: "Kalpler", items: uniqueItems(collectChars(CHAR.HEART)) },
    { name: "Yüz İkonları", items: uniqueItems(collectChars(CHAR.FACE)) },
    { name: "Yunan Harfleri", items: uniqueItems(collectChars(CHAR.GREEK)) }
  ],
  en: [
    { name: "Arrows", items: uniqueItems(collectChars(CHAR.ARROW)) },
    { name: "Currency", items: uniqueItems(collectChars(CHAR.CURRENCY)) },
    { name: "Hearts", items: uniqueItems(collectChars(CHAR.HEART)) },
    { name: "Face Icons", items: uniqueItems(collectChars(CHAR.FACE)) },
    { name: "Greek Letters", items: uniqueItems(collectChars(CHAR.GREEK)) }
  ]
};

export async function loadEmojiSections(locale: "tr" | "en") {
  if (emojiSectionsCache[locale]) {
    return emojiSectionsCache[locale];
  }

  const emojiDataset = (await import("emoji.json")).default as EmojiRecord[];
  const sections = emojiGroupsOrder.map((group) => ({
    name: emojiGroupNames[locale][group],
    items: uniqueEmojiItems(emojiDataset.filter((entry) => entry.group === group))
  }));

  emojiSectionsCache[locale] = sections;
  return sections;
}

export function getSymbolSections(locale: "tr" | "en") {
  return symbolSectionsByLocale[locale];
}

export const filters = [
  { id: "all", label: "Tümü" },
  { id: "text", label: "Metin" },
  { id: "image", label: "Görsel" }
] as const;

export const translations = {
  tr: {
    ready: "Hazır",
    search: "Ara...",
    clipboard: "Pano",
    emojis: "Emojiler",
    symbols: "Semboller",
    recent: "Son Kullanılan",
    common: "Sık Kullanılan",
    business: "İş",
    math: "Matematik",
    currency: "Para Birimi",
    arrows: "Oklar",
    all: "Tümü",
    text: "Metin",
    images: "Görsel",
    noItems: "Kayıt bulunamadı",
    records: "kayıt",
    panelCenter: "Pano Merkezi",
    compactView: "Küçük görünüm",
    fullView: "Geniş görünüm",
    settings: "Ayarlar",
    clear: "Temizle",
    live: "Canlı izleme açık",
    history: "Pano geçmişi",
    copy: "Panoya kopyala",
    paste: "Odaklı alana yapıştır",
    favorite: "Favori",
    delete: "Sil",
    selected: "Seçili kayıt",
    favoriteRecord: "Favori kayıt",
    notCaptured: "Henüz pano yakalanmadı",
    settingsSaved: "Ayarlar kaydedildi",
    pasted: "Seçim odaklı alana yapıştırıldı",
    copied: "Panoya kopyalandı",
    copiedFallback: "Panoya kopyalandı.",
    addedFallback: "Panoya eklendi.",
    language: "Dil",
    theme: "Tema",
    defaultView: "Varsayılan görünüm",
    windowPosition: "Pencere konumu",
    interfaceScale: "Arayüz ölçeği",
    maxHistory: "Maksimum geçmiş kaydı",
    speed: "Pano kontrol hızı",
    trim: "Kopyalanan metindeki kenar boşluklarını temizle",
    shortcuts: "Klavye kısayolları",
    shortcutHintOne: "Buradan global açma kısayolu kaydedebilirsin. Kaydedince ClipNest bu tuşlarla açılır.",
    shortcutHintTwo: "Pencere açıldığında bir kayda tıklamak seçili alana doğrudan yapıştırır.",
    shortcutDisabled: "Kapalı",
    shortcutRecording: "Yeni kısayol için tuşlara bas",
    shortcutRecordButton: "Kısayolu kaydet",
    shortcutClearButton: "Temizle",
    shortcutWinVButton: "Win + V (Sabit)",
    shortcutSuperHelp: "Super kullanmak istiyorsan GNOME Ayarlar > Klavye > Özel Kısayollar bölümünden ekle. Komut:",
    shortcutSaved: "Kısayol kaydedildi",
    shortcutCleared: "Kısayol kaldırıldı",
    shortcutFailed: "Kısayol kaydedilemedi",
    shortcutConflict: "Bu kısayol başka bir uygulama tarafından kullanılıyor olabilir.",
    shortcutNeedModifier: "En az bir yardımcı tuş kullan: Ctrl, Alt, Shift ya da Super.",
    save: "Kaydet",
    center: "Merkez",
    mouse: "Fare",
    fixed: "Sabit",
    small: "Küçük",
    large: "Geniş",
    turkish: "Türkçe",
    english: "English",
    light: "Açık",
    dark: "Koyu",
    system: "Sistem",
    favoritesKept: "Favoriler hariç temizle",
    imageLabel: "Görsel",
    imagePreview: "görsel",
    checkUpdates: "Güncellemeleri Kontrol Et",
    uninstallApp: "Uygulamayı Kaldır",
    uninstallConfirm: "ClipNest kaldırılacak. Emin misin?",
    uninstallConfirmTitle: "ClipNest kaldırılsın mı?",
    uninstallConfirmBody: "Uygulama, başlangıç kaydı ve yerel veriler temizlenecek.",
    uninstallConfirmAction: "Kaldır",
    uninstallProgress: "Kaldırılıyor...",
    copies: "kopyalama",
    limit: "kayıt limiti",
    favorites: "favori",
    close: "Kapat",
    minimize: "Küçült",
    cancel: "Vazgeç"
  },
  en: {
    ready: "Ready",
    search: "Search...",
    clipboard: "Clipboard",
    emojis: "Emojis",
    symbols: "Symbols",
    recent: "Recent",
    common: "Common",
    business: "Work",
    math: "Math",
    currency: "Currency",
    arrows: "Arrows",
    all: "All",
    text: "Text",
    images: "Images",
    noItems: "No items found",
    records: "items",
    panelCenter: "Clipboard Center",
    compactView: "Compact view",
    fullView: "Expanded view",
    settings: "Settings",
    clear: "Clear",
    live: "Live monitoring enabled",
    history: "Clipboard history",
    copy: "Copy to clipboard",
    paste: "Paste into focused field",
    favorite: "Favorite",
    delete: "Delete",
    selected: "Selected item",
    favoriteRecord: "Favorite item",
    notCaptured: "No clipboard content captured yet",
    settingsSaved: "Settings saved",
    pasted: "Pasted into the focused field",
    copied: "Copied to clipboard",
    copiedFallback: "Copied to clipboard.",
    addedFallback: "Added to clipboard.",
    language: "Language",
    theme: "Theme",
    defaultView: "Default view",
    windowPosition: "Window position",
    interfaceScale: "Interface scale",
    maxHistory: "Maximum history items",
    speed: "Clipboard polling speed",
    trim: "Trim whitespace around copied text",
    shortcuts: "Keyboard shortcuts",
    shortcutHintOne: "Save a global shortcut here and ClipNest will open with that key combination.",
    shortcutHintTwo: "Clicking an item after the window opens pastes it into the focused field.",
    shortcutDisabled: "Disabled",
    shortcutRecording: "Press keys for a new shortcut",
    shortcutRecordButton: "Record shortcut",
    shortcutClearButton: "Clear",
    shortcutWinVButton: "Win + V (Fixed)",
    shortcutSuperHelp: "To use Super, add it from GNOME Settings > Keyboard > Custom Shortcuts. Command:",
    shortcutSaved: "Shortcut saved",
    shortcutCleared: "Shortcut removed",
    shortcutFailed: "Shortcut could not be saved",
    shortcutConflict: "This shortcut may already be used by another application.",
    shortcutNeedModifier: "Use at least one modifier: Ctrl, Alt, Shift, or Super.",
    save: "Save",
    center: "Center",
    mouse: "Mouse",
    fixed: "Fixed",
    small: "Compact",
    large: "Expanded",
    turkish: "Türkçe",
    english: "English",
    light: "Light",
    dark: "Dark",
    system: "System",
    favoritesKept: "Clear except favorites",
    imageLabel: "Image",
    imagePreview: "image",
    checkUpdates: "Check for Updates",
    uninstallApp: "Uninstall App",
    uninstallConfirm: "ClipNest will be removed. Are you sure?",
    uninstallConfirmTitle: "Uninstall ClipNest?",
    uninstallConfirmBody: "The app, startup entry, and local data will be removed.",
    uninstallConfirmAction: "Uninstall",
    uninstallProgress: "Uninstalling...",
    copies: "copies",
    limit: "items limit",
    favorites: "favorites",
    close: "Close",
    minimize: "Minimize",
    cancel: "Cancel"
  }
} as const;

export type FilterId = (typeof filters)[number]["id"];

export function itemMatchesFilter(item: ClipboardItem, filter: FilterId) {
  if (filter === "text") return item.kind === "text";
  if (filter === "image") return item.kind === "image";
  return true;
}

export function formatTime(value: string, locale: "tr" | "en" = "tr") {
  const date = new Date(value);
  const localeCode = locale === "tr" ? "tr-TR" : "en-US";
  return new Intl.DateTimeFormat(localeCode, {
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "short"
  }).format(date);
}

export function humanSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
