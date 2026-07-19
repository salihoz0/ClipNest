import { startTransition, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import {
  Clipboard,
  Copy,
  Eraser,
  Heart,
  Image,
  Keyboard,
  LayoutPanelTop,
  ListFilter,
  Maximize2,
  Minimize2,
  Minus,
  Search,
  Settings,
  Sigma,
  Smile,
  Star,
  Trash2,
  Type,
  X
} from "lucide-react";
import {
  clearHistory,
  copyItem,
  createItem,
  deleteItem,
  getSnapshot,
  listenClipboardChange,
  listenWindowShown,
  appReady,
  pasteToPrevious,
  toggleFavorite,
  uninstallApp,
  updateSettings,
  hideWindow,
  minimizeWindow,
  exitApp,
  type ClipboardItem,
  type Settings as AppSettings
} from "./tauri";
import { filters, formatTime, getSymbolSections, humanSize, itemMatchesFilter, loadEmojiSections, translations, type FilterId } from "./data";

type Tab = "clipboard" | "emojis" | "symbols";
type PickerFilter = "all" | "text" | "image";
type Labels = (typeof translations)[keyof typeof translations];
type PickerSection = { name: string; items: string[] };

const fallbackSettings: AppSettings = {
  max_items: 200,
  poll_interval_ms: 800,
  auto_trim: true,
  locale: "tr",
  theme: "system",
  default_view: "picker",
  window_anchor: "center",
  ui_scale: 100,
  shortcut: ""
};

const modifierKeyMap: Record<string, string> = {
  Shift: "Shift",
  Control: "Ctrl",
  Alt: "Alt",
  Meta: "Super",
  OS: "Super",
  Super: "Super",
  Win: "Super",
  Windows: "Super"
};

function normalizeShortcut(shortcut: string) {
  return shortcut
    .split("+")
    .map((part) => part.trim())
    .map((part) => modifierKeyMap[part] ?? part)
    .filter(Boolean)
    .join("+");
}

function keyToShortcutToken(key: string) {
  const mapped: Record<string, string> = {
    " ": "Space",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    Escape: "Esc",
    Enter: "Enter",
    Tab: "Tab",
    Backspace: "Backspace",
    Delete: "Delete"
  };

  if (mapped[key]) return mapped[key];
  if (key.length === 1) return key.toUpperCase();
  return key;
}

function modifierFromKey(key: string) {
  return modifierKeyMap[key] ?? null;
}

function shortcutModifiersFromEvent(event: React.KeyboardEvent<HTMLButtonElement>) {
  const superPressed =
    event.metaKey ||
    event.getModifierState("Meta") ||
    event.getModifierState("Super") ||
    event.key === "Meta" ||
    event.key === "OS" ||
    event.key === "Super" ||
    event.key === "Win" ||
    event.key === "Windows";

  return [
    event.ctrlKey || event.getModifierState("Control") ? "Ctrl" : null,
    event.altKey || event.getModifierState("Alt") ? "Alt" : null,
    event.shiftKey || event.getModifierState("Shift") ? "Shift" : null,
    superPressed ? "Super" : null
  ].filter(Boolean) as string[];
}

function shortcutFromEvent(event: React.KeyboardEvent<HTMLButtonElement>, activeModifiers = new Set<string>()) {
  if (event.key === "Escape") return { cancelled: true, value: "", needsModifier: false };

  const modifiers = [...new Set([...activeModifiers, ...shortcutModifiersFromEvent(event)])];

  if (modifierFromKey(event.key) || modifiers.length === 0) {
    return { cancelled: false, value: "", needsModifier: true };
  }

  return {
    cancelled: false,
    value: [...modifiers, keyToShortcutToken(event.key)].join("+"),
    needsModifier: false
  };
}

function formatShortcutLabel(shortcut: string, emptyLabel: string) {
  if (!shortcut) return emptyLabel;

  return shortcut
    .split("+")
    .map((part) => (part.length === 1 ? part.toUpperCase() : part))
    .join(" + ");
}

function prioritizeFavorites(items: ClipboardItem[]) {
  return [...items].sort((left, right) => Number(right.favorite) - Number(left.favorite));
}

export function App() {
  const [items, setItems] = useState<ClipboardItem[]>([]);
  const [settings, setSettings] = useState<AppSettings>(fallbackSettings);
  const [isReady, setIsReady] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FilterId>("all");
  const [tab, setTab] = useState<Tab>("clipboard");
  const [pickerFilter, setPickerFilter] = useState<PickerFilter>("all");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [toast, setToast] = useState<string>(translations.tr.ready);
  const [emojiSections, setEmojiSections] = useState<PickerSection[]>([]);
  const [animateEntrance, setAnimateEntrance] = useState(false);
  const saveTokenRef = useRef(0);
  const deferredQuery = useDeferredValue(query);
  const t = translations[settings.locale];

  useEffect(() => {
    getSnapshot()
      .then(async (snapshot) => {
        setItems(snapshot.items);
        setSettings(snapshot.settings);
        setSelectedId(snapshot.items[0]?.id ?? null);
        setToast(translations[snapshot.settings.locale].ready);
        setIsReady(true);
      })
      .catch((error) => {
        setToast(String(error));
        setIsReady(true);
      });

    const unlisten = listenClipboardChange((nextItems) => {
      startTransition(() => {
        setItems(nextItems);
        setSelectedId((current) => current ?? nextItems[0]?.id ?? null);
      });
    });

    const unlistenShown = listenWindowShown(() => {
      setAnimateEntrance(true);
      setQuery("");
      setTimeout(() => {
        setAnimateEntrance(false);
      }, 350);
    });

    const preventDragDrop = (e: DragEvent) => {
      e.preventDefault();
    };
    window.addEventListener('dragover', preventDragDrop);
    window.addEventListener('drop', preventDragDrop);

    return () => {
      unlisten.then((dispose) => dispose());
      unlistenShown.then((dispose) => dispose());
      window.removeEventListener('dragover', preventDragDrop);
      window.removeEventListener('drop', preventDragDrop);
    };
  }, []);

  useEffect(() => {
    document.documentElement.style.setProperty("--picker-scale", `${settings.ui_scale / 100}`);
  }, [settings.ui_scale]);

  useEffect(() => {
    if (isReady) {
      const timer = setTimeout(() => {
        void appReady();
      }, 200);
      return () => clearTimeout(timer);
    }
  }, [isReady]);

  useEffect(() => {
    if (tab !== "emojis") return;

    let cancelled = false;
    void loadEmojiSections(settings.locale).then((sections) => {
      if (!cancelled) {
        setEmojiSections(sections);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [settings.locale, tab]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      const resolved = settings.theme === "system" ? (media.matches ? "dark" : "light") : settings.theme;
      document.documentElement.dataset.theme = resolved;
    };
    applyTheme();
    media.addEventListener("change", applyTheme);
    return () => media.removeEventListener("change", applyTheme);
  }, [settings.theme]);



  const visibleItems = useMemo(() => {
    const normalizedQuery = deferredQuery.trim().toLocaleLowerCase(settings.locale === "tr" ? "tr-TR" : "en-US");
    return items
      .filter((item) => itemMatchesFilter(item, filter))
      .filter((item) => {
        if (!normalizedQuery) return true;
        const textToSearch = item.kind === "image" ? item.preview : item.content;
        return textToSearch.toLocaleLowerCase(settings.locale === "tr" ? "tr-TR" : "en-US").includes(normalizedQuery);
      });
  }, [deferredQuery, filter, items, settings.locale]);

  const orderedVisibleItems = useMemo(() => prioritizeFavorites(visibleItems), [visibleItems]);

  const pickerItems = useMemo(() => {
    return orderedVisibleItems.filter((item) => {
      if (pickerFilter === "text") return item.kind === "text";
      if (pickerFilter === "image") return item.kind === "image";
      return true;
    });
  }, [orderedVisibleItems, pickerFilter]);

  const currentView = settings.default_view;
  const selected = useMemo(() => {
    const currentItems = currentView === "picker" ? pickerItems : orderedVisibleItems;
    return currentItems.find((item) => item.id === selectedId) ?? currentItems[0] ?? null;
  }, [currentView, pickerItems, orderedVisibleItems, selectedId]);

  async function patchSettings(nextSettings: AppSettings, successMessage?: string) {
    const token = ++saveTokenRef.current;
    const snapshot = await updateSettings(nextSettings);
    if (token !== saveTokenRef.current) return;
    setSettings(snapshot.settings);
    setItems(snapshot.items);
    if (successMessage) setToast(successMessage);
  }

  async function switchView(view: AppSettings["default_view"]) {
    await patchSettings({ ...settings, default_view: view });
  }

  function changeSettings(nextSettings: AppSettings) {
    setSettings(nextSettings);
    void patchSettings(nextSettings);
  }

  async function changeShortcut(shortcut: string) {
    const normalized = normalizeShortcut(shortcut);
    const nextSettings = { ...settings, shortcut: normalized };

    try {
      await patchSettings(nextSettings, normalized ? t.shortcutSaved : t.shortcutCleared);
    } catch (error) {
      console.error(error);
      setToast(`${t.shortcutFailed}. ${t.shortcutConflict}`);
    }
  }

  async function quickPaste(item: ClipboardItem) {
    try {
      const next = await pasteToPrevious({
        content: item.content,
        kind: item.kind,
        imageWidth: item.image_width ?? undefined,
        imageHeight: item.image_height ?? undefined,
        source: "quick-paste"
      });
      setItems(next);
      setSelectedId(item.id);
      setToast(t.pasted);
      setQuery(""); // Arama sıfırlama
    } catch (error) {
      setToast(`${String(error)} ${t.copiedFallback}`);
      setItems(await copyItem(item.id));
      setQuery(""); // Arama sıfırlama
    }
  }

  async function quickPasteText(content: string, source: string) {
    try {
      const next = await pasteToPrevious({
        content,
        kind: "text",
        source
      });
      setItems(next);
      setToast(t.pasted);
      setQuery(""); // Arama sıfırlama
    } catch (error) {
      setToast(`${String(error)} ${t.addedFallback}`);
      setItems(await createItem(content, source));
      setQuery(""); // Arama sıfırlama
    }
  }

  const tabs = [
    { id: "clipboard" as const, label: t.clipboard, icon: Clipboard },
    { id: "emojis" as const, label: t.emojis, icon: Smile },
    { id: "symbols" as const, label: t.symbols, icon: Sigma }
  ];

  const symbolSections = useMemo(() => getSymbolSections(settings.locale), [settings.locale]);

  const mouseInsideRef = useRef(true);
  const lastMousePosRef = useRef({ x: 0, y: 0 });

  // Fare pencere üzerindeyken veya ayrıldığında durum takibi
  useEffect(() => {
    const handleMouseEnter = () => {
      mouseInsideRef.current = true;
    };
    const handleMouseLeave = () => {
      mouseInsideRef.current = false;
    };
    const handleMouseMove = (e: MouseEvent) => {
      lastMousePosRef.current = { x: e.clientX, y: e.clientY };
    };

    document.addEventListener("mouseenter", handleMouseEnter);
    document.addEventListener("mouseleave", handleMouseLeave);
    window.addEventListener("mousemove", handleMouseMove);
    return () => {
      document.removeEventListener("mouseenter", handleMouseEnter);
      document.removeEventListener("mouseleave", handleMouseLeave);
      window.removeEventListener("mousemove", handleMouseMove);
    };
  }, []);

  const [isFocused, setIsFocused] = useState(false);

  // Pencere odaklandığında arama metnini sıfırla, odağı kaybettiğinde gizle
  useEffect(() => {
    const handleFocus = () => {
      setQuery("");
      setIsFocused(true);
    };
    const handleBlur = () => {
      // Fare koordinatlarının gerçekte pencere sınırları dışında olup olmadığını kontrol et
      const { x, y } = lastMousePosRef.current;
      const isOutside = x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight;

      setIsFocused(false);

      // Sadece fare koordinatları gerçekten dışarıdaysa ve pencere üzerinde değilse gizle
      if (isOutside && !mouseInsideRef.current) {
        void hideWindow();
      }
    };
    if (document.hasFocus()) {
      setIsFocused(true);
    }
    window.addEventListener("focus", handleFocus);
    window.addEventListener("blur", handleBlur);
    return () => {
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("blur", handleBlur);
    };
  }, []);

  // Klavye ile gezinme mantığı (Yukarı/Aşağı, Enter, Esc)
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (settingsOpen) return;

      if (event.key === "Escape") {
        event.preventDefault();
        void hideWindow();
        return;
      }

      // Sadece clipboard (pano) görünümlerinde gezinmeye izin ver
      if (currentView === "picker" && tab !== "clipboard") return;

      const currentItems = currentView === "picker" ? pickerItems : orderedVisibleItems;
      if (currentItems.length === 0) return;

      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedId((currentId) => {
          const currentIndex = currentItems.findIndex((item) => item.id === currentId);
          const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % currentItems.length;
          return currentItems[nextIndex].id;
        });
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedId((currentId) => {
          const currentIndex = currentItems.findIndex((item) => item.id === currentId);
          const nextIndex = currentIndex === -1 ? currentItems.length - 1 : (currentIndex - 1 + currentItems.length) % currentItems.length;
          return currentItems[nextIndex].id;
        });
      } else if (event.key === "Enter") {
        const target = event.target as HTMLElement;
        if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") {
          // Arama çubuğunda Enter'a basıldığında seçili elemanı yapıştır
          event.preventDefault();
          const selectedItem = selected || currentItems[0];
          if (selectedItem) {
            void quickPaste(selectedItem);
          }
          return;
        }
        event.preventDefault();
        const selectedItem = selected || currentItems[0];
        if (selectedItem) {
          void quickPaste(selectedItem);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [settingsOpen, tab, currentView, pickerItems, orderedVisibleItems, selected, quickPaste]);

  // Seçili ögeyi otomatik kaydır (scroll-into-view)
  useEffect(() => {
    if (!selected?.id) return;
    const activeEl = document.querySelector(`.compact-item.selected, .history-item.selected`);
    if (activeEl) {
      activeEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [selected?.id]);

  if (!isReady) {
    return <main className="app-shell app-loading" />;
  }

  const isBottom = window.screenY > window.screen.height / 2;

  return (
    <main className={`app-shell ${isFocused ? "focused" : ""} ${animateEntrance ? "animate-entrance" : ""} ${isBottom ? "is-bottom" : "is-top"}`}>
      {currentView === "picker" ? (
        <section className="picker">
          <header className="picker-titlebar" data-tauri-drag-region>
            <button type="button" className="ghost-icon active" onClick={() => void switchView("manager")} title={t.fullView}>
              <LayoutPanelTop size={17} />
            </button>
            <div className="title-actions">
              <button type="button" className="ghost-icon" onClick={() => setSettingsOpen(true)} title={t.settings}>
                <Settings size={16} />
              </button>
              <button type="button" className="ghost-icon danger" onClick={() => setConfirmClear(true)} title={t.favoritesKept}>
                <Trash2 size={16} />
              </button>
              <span className="window-divider" />
              <button type="button" className="ghost-icon" onClick={minimizeWindow} title={t.minimize}>
                <Minus size={16} />
              </button>
              <button type="button" className="ghost-icon close-btn" onClick={hideWindow} title={t.close}>
                <X size={16} />
              </button>
            </div>
          </header>

          <nav className="tabbar" aria-label="ClipNest bölümleri">
            {tabs.map((entry) => {
              const Icon = entry.icon;
              return (
                <button key={entry.id} type="button" className={tab === entry.id ? "active" : ""} onClick={() => setTab(entry.id)}>
                  <Icon size={18} />
                  <span>{entry.label}</span>
                </button>
              );
            })}
          </nav>

          <div className="search compact">
            <Search size={17} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t.search} />
            {query && (
              <button type="button" className="ghost-icon" onClick={() => setQuery("")} aria-label={t.search}>
                <X size={15} />
              </button>
            )}
          </div>

          {tab === "clipboard" && (
            <ClipboardPanel
              items={pickerItems}
              selectedId={selected?.id ?? null}
              pickerFilter={pickerFilter}
              labels={{ all: t.all, text: t.text, images: t.images, noItems: t.noItems, favorite: t.favorite, delete: t.delete }}
              locale={settings.locale}
              onFilter={setPickerFilter}
              onPaste={quickPaste}
              onFavorite={async (id) => setItems(await toggleFavorite(id))}
              onDelete={async (id) => setItems(await deleteItem(id))}
            />
          )}

          {tab === "emojis" && (
            <SymbolPanel
              sections={[
                { name: t.recent, items: items.filter((item) => item.source === "emoji").slice(0, 8).map((item) => item.content) },
                ...emojiSections
              ]}
              onPick={(symbol) => quickPasteText(symbol, "emoji")}
            />
          )}

          {tab === "symbols" && <SymbolPanel sections={symbolSections} onPick={(symbol) => quickPasteText(symbol, "symbol")} />}

          <footer className="picker-footer">{items.length} {t.records}</footer>
        </section>
      ) : (
        <ManagerView
          items={items}
          visibleItems={orderedVisibleItems}
          selected={selected}
          query={query}
          filter={filter}
          settings={settings}
          labels={t}
          toast={toast}
          onQuery={setQuery}
          onFilter={setFilter}
          onSelect={setSelectedId}
          onPaste={quickPaste}
          onCopy={async (item) => {
            setItems(await copyItem(item.id));
            setToast(t.copied);
            setQuery(""); // Arama sıfırlama
          }}
          onFavorite={async (id) => setItems(await toggleFavorite(id))}
          onDelete={async (id) => setItems(await deleteItem(id))}
          onClear={() => setConfirmClear(true)}
          onCompact={() => void switchView("picker")}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      )}

      {confirmClear && (
        <ConfirmClearDialog
          onConfirm={async () => { setConfirmClear(false); setItems(await clearHistory(true)); }}
          onCancel={() => setConfirmClear(false)}
          labels={t}
        />
      )}

      {settingsOpen && (
        <SettingsModal
          settings={settings}
          labels={t}
          onChange={changeSettings}
          onShortcutChange={changeShortcut}
          onShowToast={setToast}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </main>
  );
}

function ClipboardPanel({
  items,
  selectedId,
  pickerFilter,
  labels,
  locale,
  onFilter,
  onPaste,
  onFavorite,
  onDelete
}: {
  items: ClipboardItem[];
  selectedId: string | null;
  pickerFilter: PickerFilter;
  labels: { all: string; text: string; images: string; noItems: string; favorite: string; delete: string };
  locale: "tr" | "en";
  onFilter: (filter: PickerFilter) => void;
  onPaste: (item: ClipboardItem) => void;
  onFavorite: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <section className="picker-content">
      <div className="mini-filters">
        <button type="button" className={pickerFilter === "all" ? "active" : ""} onClick={() => onFilter("all")}>
          <ListFilter size={13} />
          {labels.all}
        </button>
        <button type="button" className={pickerFilter === "text" ? "active" : ""} onClick={() => onFilter("text")}>
          <Type size={13} />
          {labels.text}
        </button>
        <button type="button" className={pickerFilter === "image" ? "active" : ""} onClick={() => onFilter("image")}>
          <Image size={13} />
          {labels.images}
        </button>
      </div>

      {items.length === 0 ? (
        <div className="empty compact-empty">{labels.noItems}</div>
      ) : (
        <div className="compact-list">
          {items.map((item) => (
            <div key={item.id} className={`compact-item ${selectedId === item.id ? "selected" : ""}`}>
              <button type="button" className="compact-item-main" onClick={() => onPaste(item)}>
                {item.kind === "image" ? (
                  <div className="compact-image-wrap">
                    <img className="compact-image" src={item.content} alt={item.preview} />
                  </div>
                ) : (
                  <span className="compact-preview">{item.preview}</span>
                )}
                <span className="compact-meta">
                  <span>{formatTime(item.copied_at, locale)}</span>
                  <span>{humanSize(item.size)}</span>
                </span>
              </button>
              <div className="list-item-actions compact-item-actions">
                <button type="button" className={`list-icon-button ${item.favorite ? "liked" : ""}`} onClick={() => onFavorite(item.id)} title={labels.favorite}>
                  <Star size={14} fill={item.favorite ? "currentColor" : "none"} />
                </button>
                <button type="button" className="list-icon-button danger" onClick={() => onDelete(item.id)} title={labels.delete}>
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function SymbolPanel({ sections, onPick }: { sections: { name: string; items: string[] }[]; onPick: (symbol: string) => void }) {
  return (
    <section className="picker-content">
      <div className="symbol-scroll">
        {sections
          .filter((section) => section.items.length > 0)
          .map((section) => (
            <div className="symbol-section" key={section.name}>
              <h3>{section.name}</h3>
              <div className="symbol-grid">
                {section.items.map((symbol) => (
                  <button key={`${section.name}-${symbol}`} type="button" onClick={() => onPick(symbol)}>
                    {symbol}
                  </button>
                ))}
              </div>
            </div>
          ))}
      </div>
    </section>
  );
}

function ManagerView({
  items,
  visibleItems,
  selected,
  query,
  filter,
  settings,
  labels,
  toast,
  onQuery,
  onFilter,
  onSelect,
  onPaste,
  onCopy,
  onFavorite,
  onDelete,
  onClear,
  onCompact,
  onOpenSettings
}: {
  items: ClipboardItem[];
  visibleItems: ClipboardItem[];
  selected: ClipboardItem | null;
  query: string;
  filter: FilterId;
  settings: AppSettings;
  labels: Labels;
  toast: string;
  onQuery: (query: string) => void;
  onFilter: (filter: FilterId) => void;
  onSelect: (id: string) => void;
  onPaste: (item: ClipboardItem) => void;
  onCopy: (item: ClipboardItem) => void;
  onFavorite: (id: string) => void;
  onDelete: (id: string) => void;
  onClear: () => void;
  onCompact: () => void;
  onOpenSettings: () => void;
}) {
  return (
    <section className="manager">
      <aside className="manager-sidebar" data-tauri-drag-region>
        <div className="brand" data-tauri-drag-region>
          <img src="/logo.png" alt="" />
          <div data-tauri-drag-region>
            <strong>ClipNest</strong>
            <span>{labels.panelCenter}</span>
          </div>
        </div>

        <div className="search">
          <Search size={18} />
          <input value={query} onChange={(event) => onQuery(event.target.value)} placeholder={labels.search} />
          {query && (
            <button type="button" className="ghost-icon" onClick={() => onQuery("")} aria-label={labels.search}>
              <X size={15} />
            </button>
          )}
        </div>

        <div className="filters" role="tablist" aria-label={labels.history}>
          {filters.map((entry) => (
            <button key={entry.id} type="button" className={filter === entry.id ? "active" : ""} onClick={() => onFilter(entry.id)}>
              {entry.id === "all" ? labels.all : entry.id === "text" ? labels.text : labels.images}
            </button>
          ))}
        </div>

        <section className="manager-list">
          {visibleItems.map((item) => (
            <div key={item.id} className={`history-item ${selected?.id === item.id ? "selected" : ""}`}>
              <button type="button" className="history-item-main" onClick={() => onSelect(item.id)}>
                <span className="item-topline">
                  <span>{item.favorite ? <Star size={14} fill="currentColor" /> : item.kind === "image" ? <Image size={14} /> : <Clipboard size={14} />} {formatTime(item.copied_at, settings.locale)}</span>
                  <small>{humanSize(item.size)}</small>
                </span>
                {item.kind === "image" ? (
                  <span className="history-image-wrap">
                    <img className="manager-image" src={item.content} alt={item.preview} />
                  </span>
                ) : (
                  <span className="item-preview">{item.preview}</span>
                )}
              </button>
              <div className="list-item-actions history-item-actions">
                <button type="button" className={`list-icon-button ${item.favorite ? "liked" : ""}`} onClick={() => onFavorite(item.id)} title={labels.favorite}>
                  <Star size={14} fill={item.favorite ? "currentColor" : "none"} />
                </button>
                <button type="button" className="list-icon-button danger" onClick={() => onDelete(item.id)} title={labels.delete}>
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </section>
      </aside>

      <section className="manager-workspace" style={{ position: 'relative' }}>
        <header className="manager-topbar" data-tauri-drag-region>
          <div className="title-area" data-tauri-drag-region>
            <h1 data-tauri-drag-region>{labels.history}</h1>
          </div>
          <div className="toolbar">
            <button type="button" className="icon-label" onClick={onOpenSettings}>
              <Settings size={17} />
              {labels.settings}
            </button>
            <button type="button" className="icon-label danger" onClick={onClear}>
              <Eraser size={17} />
              {labels.clear}
            </button>
          </div>
          
          <div className="window-controls">
            <button type="button" className="ghost-icon" onClick={onCompact} title={labels.compactView}>
              <Minimize2 size={15} />
            </button>
            <button type="button" className="ghost-icon" onClick={minimizeWindow} title={labels.minimize}>
              <Minus size={15} />
            </button>
            <button type="button" className="ghost-icon close-btn" onClick={hideWindow} title={labels.close}>
              <X size={15} />
            </button>
          </div>
        </header>

        <section className="detail">
          {selected ? (
            <>
              <div className="detail-head">
                <div>
                  <span className="meta-line">{formatTime(selected.copied_at, settings.locale)} · {selected.copy_count} {labels.copies} · {settings.max_items} {labels.limit}</span>
                  <h2>{selected.favorite ? labels.favoriteRecord : labels.selected}</h2>
                </div>
                <div className="actions">
                  <button type="button" className="icon-button" onClick={() => onCopy(selected)} title={labels.copy}>
                    <Copy size={18} />
                  </button>
                  <button type="button" className={`icon-button ${selected.favorite ? "liked" : ""}`} onClick={() => onFavorite(selected.id)} title={labels.favorite}>
                    <Heart size={18} fill={selected.favorite ? "currentColor" : "none"} />
                  </button>
                  <button type="button" className="icon-button danger" onClick={() => onDelete(selected.id)} title={labels.delete}>
                    <Trash2 size={18} />
                  </button>
                </div>
              </div>
              {selected.kind === "image" ? <img className="detail-image" src={selected.content} alt={selected.preview} /> : <textarea className="preview-area" readOnly value={selected.content} />}
            </>
          ) : (
            <div className="empty big">{labels.notCaptured}</div>
          )}
        </section>

        <footer className="status">
          <span>{toast}</span>
          <span>{items.length} {labels.records} · {items.filter((item) => item.favorite).length} {labels.favorites}</span>
        </footer>
      </section>
    </section>
  );
}

function SettingsModal({
  settings,
  labels,
  onChange,
  onShortcutChange,
  onShowToast,
  onClose
}: {
  settings: AppSettings;
  labels: Labels;
  onChange: (settings: AppSettings) => void;
  onShortcutChange: (shortcut: string) => Promise<void>;
  onShowToast: (message: string) => void;
  onClose: () => void;
}) {
  const [isRecording, setIsRecording] = useState(false);
  const [shortcutError, setShortcutError] = useState("");
  const [confirmUninstallOpen, setConfirmUninstallOpen] = useState(false);
  const [isUninstalling, setIsUninstalling] = useState(false);
  const [passwordModalOpen, setPasswordModalOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [appVersion, setAppVersion] = useState("");
  const shortcutButtonRef = useRef<HTMLButtonElement | null>(null);
  const recordingModifiersRef = useRef<Set<string>>(new Set());
  const shortcutLabel = isRecording ? labels.shortcutRecording : formatShortcutLabel(settings.shortcut, labels.shortcutDisabled);

  useEffect(() => {
    void getVersion()
      .then(setAppVersion)
      .catch(() => setAppVersion(""));
  }, []);

  function startRecording() {
    setShortcutError("");
    recordingModifiersRef.current.clear();
    setIsRecording(true);
    requestAnimationFrame(() => shortcutButtonRef.current?.focus());
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section className="settings-modal" onClick={(event) => event.stopPropagation()}>
        <header>
          <h2>{labels.settings}</h2>
          <button type="button" className="ghost-icon" onClick={onClose} aria-label={labels.close}>
            <X size={20} />
          </button>
        </header>

        <div className="setting-block">
          <span className="setting-title">{labels.language}</span>
          <div className="segmented">
            <button type="button" className={settings.locale === "tr" ? "active" : ""} onClick={() => onChange({ ...settings, locale: "tr" })}>
              {labels.turkish}
            </button>
            <button type="button" className={settings.locale === "en" ? "active" : ""} onClick={() => onChange({ ...settings, locale: "en" })}>
              {labels.english}
            </button>
          </div>
        </div>

        <div className="setting-block">
          <span className="setting-title">{labels.theme}</span>
          <div className="segmented segmented-3">
            <button type="button" className={settings.theme === "light" ? "active" : ""} onClick={() => onChange({ ...settings, theme: "light" })}>
              {labels.light}
            </button>
            <button type="button" className={settings.theme === "dark" ? "active" : ""} onClick={() => onChange({ ...settings, theme: "dark" })}>
              {labels.dark}
            </button>
            <button type="button" className={settings.theme === "system" ? "active" : ""} onClick={() => onChange({ ...settings, theme: "system" })}>
              {labels.system}
            </button>
          </div>
        </div>

        <div className="setting-block">
          <span className="setting-title">{labels.defaultView}</span>
          <div className="segmented">
            <button type="button" className={settings.default_view === "picker" ? "active" : ""} onClick={() => onChange({ ...settings, default_view: "picker" })}>
              {labels.small}
            </button>
            <button type="button" className={settings.default_view === "manager" ? "active" : ""} onClick={() => onChange({ ...settings, default_view: "manager" })}>
              {labels.large}
            </button>
          </div>
        </div>

        <div className="setting-block">
          <span className="setting-title">{labels.windowPosition}</span>
          <div className="segmented segmented-3">
            <button type="button" className={settings.window_anchor === "center" ? "active" : ""} onClick={() => onChange({ ...settings, window_anchor: "center" })}>
              {labels.center}
            </button>
            <button type="button" className={settings.window_anchor === "mouse" ? "active" : ""} onClick={() => onChange({ ...settings, window_anchor: "mouse" })}>
              {labels.mouse}
            </button>
            <button type="button" className={settings.window_anchor === "fixed" ? "active" : ""} onClick={() => onChange({ ...settings, window_anchor: "fixed" })}>
              {labels.fixed}
            </button>
          </div>
        </div>

        <label className="setting-row">
          <span>{labels.interfaceScale}</span>
          <small>%{settings.ui_scale}</small>
          <input
            type="range"
            min={90}
            max={115}
            step={5}
            value={settings.ui_scale}
            onChange={(event) => onChange({ ...settings, ui_scale: Number(event.target.value) })}
          />
        </label>

        <label className="setting-row">
          <span>{labels.maxHistory}</span>
          <input
            type="number"
            min={25}
            max={1000}
            value={settings.max_items}
            onChange={(event) => onChange({ ...settings, max_items: Number(event.target.value) })}
          />
        </label>

        <label className="setting-row">
          <span>{labels.speed}</span>
          <small>{settings.poll_interval_ms} ms</small>
          <input
            type="range"
            min={300}
            max={3000}
            step={100}
            value={settings.poll_interval_ms}
            onChange={(event) => onChange({ ...settings, poll_interval_ms: Number(event.target.value) })}
          />
        </label>

        <label className="toggle-row">
          <input
            type="checkbox"
            checked={settings.auto_trim}
            onChange={(event) => onChange({ ...settings, auto_trim: event.target.checked })}
          />
          {labels.trim}
        </label>

        <section className="shortcut-card">
          <div className="shortcut-card-head">
            <div>
              <strong>{labels.shortcuts}</strong>
              <p>{labels.shortcutHintOne}</p>
              <p>{labels.shortcutHintTwo}</p>
              <p className="shortcut-super-help">
                {labels.shortcutSuperHelp} <code>clipnest</code>
              </p>
            </div>
            <span className={`shortcut-badge ${settings.shortcut ? "active" : ""}`}>{formatShortcutLabel(settings.shortcut, labels.shortcutDisabled)}</span>
          </div>
          <div className="shortcut-recorder">
            <button
              ref={shortcutButtonRef}
              type="button"
              className={`shortcut-capture ${isRecording ? "recording" : ""}`}
              onClick={startRecording}
              onKeyDown={(event) => {
                if (!isRecording) return;
                event.preventDefault();
                event.stopPropagation();
                const modifier = modifierFromKey(event.key);
                if (modifier) {
                  recordingModifiersRef.current.add(modifier);
                }
                const next = shortcutFromEvent(event, recordingModifiersRef.current);
                if (next.cancelled) {
                  setShortcutError("");
                  recordingModifiersRef.current.clear();
                  setIsRecording(false);
                  return;
                }
                if (next.needsModifier || !next.value) {
                  setShortcutError(labels.shortcutNeedModifier);
                  return;
                }
                setShortcutError("");
                recordingModifiersRef.current.clear();
                setIsRecording(false);
                void onShortcutChange(next.value);
              }}
              onKeyUp={(event) => {
                if (!isRecording) return;
                const modifier = modifierFromKey(event.key);
                if (modifier) {
                  recordingModifiersRef.current.delete(modifier);
                }
              }}
            >
              <Keyboard size={16} />
              <span>{shortcutLabel}</span>
            </button>
            <div className="shortcut-actions">
              <button
                type="button"
                className="icon-label"
                onClick={startRecording}
              >
                {labels.shortcutRecordButton}
              </button>
              <button
                type="button"
                className="icon-label"
                onClick={() => {
                  setShortcutError("");
                  recordingModifiersRef.current.clear();
                  setIsRecording(false);
                  void onShortcutChange("Super+V");
                }}
              >
                {labels.shortcutWinVButton}
              </button>
              <button
                type="button"
                className="icon-label"
                onClick={() => {
                  setShortcutError("");
                  setIsRecording(false);
                  void onShortcutChange("");
                }}
              >
                {labels.shortcutClearButton}
              </button>
            </div>
          </div>
          {shortcutError ? <p className="shortcut-error">{shortcutError}</p> : null}
        </section>

        <button 
          type="button" 
          className="check-updates-btn"
          onClick={() => onShowToast("Güncelleme kontrolü yapılıyor...")}
        >
          {labels.checkUpdates || "Güncellemeleri Kontrol Et"}
        </button>

        <button 
          type="button" 
          className="exit-app-btn"
          onClick={() => void exitApp()}
        >
          {settings.locale === "tr" ? "Uygulamayı Kapat" : "Exit Application"}
        </button>

        <button 
          type="button" 
          className="uninstall-btn"
          onClick={() => setConfirmUninstallOpen(true)}
        >
          {labels.uninstallApp || "Uygulamayı Kaldır"}
        </button>

        <div className="settings-footer">
          <p>{appVersion ? `ClipNest v${appVersion}` : "ClipNest"}</p>
        </div>

        {confirmUninstallOpen ? (
          <div className="confirm-backdrop" onClick={() => setConfirmUninstallOpen(false)}>
            <section className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="uninstall-title" onClick={(event) => event.stopPropagation()}>
              <div className="confirm-icon">
                <Trash2 size={18} />
              </div>
              <div className="confirm-copy">
                <h3 id="uninstall-title">{labels.uninstallConfirmTitle}</h3>
                <p>{labels.uninstallConfirm}</p>
                <small>{labels.uninstallConfirmBody}</small>
              </div>
              <div className="confirm-actions">
                <button type="button" className="confirm-secondary" onClick={() => setConfirmUninstallOpen(false)}>
                  {labels.cancel}
                </button>
                <button
                  type="button"
                  className="confirm-danger"
                  disabled={isUninstalling}
                  onClick={() => {
                    setConfirmUninstallOpen(false);
                    setPasswordModalOpen(true);
                  }}
                >
                  {labels.uninstallConfirmAction}
                </button>
              </div>
            </section>
          </div>
        ) : null}

        {passwordModalOpen && (
          <div className="confirm-backdrop" onClick={() => { setPasswordModalOpen(false); setPassword(""); }}>
            <section
              className="confirm-dialog"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="password-title"
              onClick={(event) => event.stopPropagation()}
              style={{ minWidth: "360px", maxWidth: "420px", width: "90vw" }}
            >
              <div className="confirm-copy" style={{ textAlign: "center" }}>
                <h3 id="password-title">Yönetici Şifresi</h3>
                <p style={{ whiteSpace: "normal", lineHeight: 1.5 }}>
                  Uygulamayı kaldırmak için şifrenizi girin
                </p>
              </div>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Şifre"
                autoFocus
                onKeyDown={(e) => { if (e.key === "Enter" && password && !isUninstalling) { e.currentTarget.blur(); void (async () => {
                  setIsUninstalling(true);
                  onShowToast("Kaldırma başlatıldı...");
                  try { await uninstallApp(password); onShowToast("Uygulama kaldırılıyor..."); setPasswordModalOpen(false); setPassword(""); }
                  catch (err) { onShowToast(`${String(err)}`); setIsUninstalling(false); }
                })(); }}}
                style={{ width: "100%", padding: "12px", marginBottom: "16px", borderRadius: "8px", border: "1px solid var(--border)", background: "var(--surface)", color: "var(--text)", fontSize: "1rem", outline: "none", boxSizing: "border-box" }}
              />
              <div className="confirm-actions">
                <button type="button" className="confirm-secondary" onClick={() => { setPasswordModalOpen(false); setPassword(""); }}>
                  {labels.cancel}
                </button>
                <button
                  type="button"
                  className="confirm-danger"
                  disabled={isUninstalling || !password}
                  onClick={() => {
                    if (isUninstalling || !password) return;
                    setIsUninstalling(true);
                    onShowToast("Kaldırma başlatıldı...");
                    void uninstallApp(password)
                      .then(() => {
                        onShowToast("Uygulama kaldırılıyor...");
                        setPasswordModalOpen(false);
                        setPassword("");
                      })
                      .catch((err) => {
                        onShowToast(`${String(err)}`);
                        setIsUninstalling(false);
                      });
                  }}
                >
                  {isUninstalling ? (labels.uninstallProgress || "Kaldırılıyor...") : "Doğrula"}
                </button>
              </div>
            </section>
          </div>
        )}

      </section>
    </div>
  );
}

function ConfirmClearDialog({
  onConfirm,
  onCancel,
  labels,
}: {
  onConfirm: () => void;
  onCancel: () => void;
  labels: Labels;
}) {
  return (
    <div className="confirm-overlay" onClick={onCancel}>
      <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="confirm-header">
          <div className="confirm-icon">
            <Trash2 size={22} />
          </div>
          <h3 className="confirm-title">{labels.favoritesKept || "Geçmişi Temizle"}</h3>
        </div>
        <p className="confirm-message">
          Favoriler korunacak, geri kalan tüm kayıtlar silinecek. Bu işlem geri alınamaz.
        </p>
        <div className="confirm-actions">
          <button type="button" className="confirm-btn cancel" onClick={onCancel}>
            İptal
          </button>
          <button type="button" className="confirm-btn danger" onClick={onConfirm}>
            <Trash2 size={13} />
            Evet, Temizle
          </button>
        </div>
      </div>
    </div>
  );
}
