import { startTransition, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { getVersion } from "@tauri-apps/api/app";
import {
  Clipboard,
  Copy,
  Download,
  Eraser,
  Heart,
  Image,
  Keyboard,
  LayoutPanelTop,
  ListFilter,
  Minimize2,
  Minus,
  Search,
  ScanText,
  Settings,
  Sigma,
  Smile,
  Star,
  Trash2,
  Type,
  X,
  CheckCircle2
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
  checkForUpdates,
  captureScreenOcr,
  installUpdate,
  ocrImageItem,
  prepareScreenOcr,
  type ClipboardItem,
  type Settings as AppSettings
} from "./tauri";
import { filters, formatTime, getSymbolSections, humanSize, itemMatchesFilter, loadEmojiSections, translations, type FilterId } from "./data";

type Tab = "clipboard" | "emojis" | "symbols";
type PickerFilter = "all" | "text" | "image";
type Labels = (typeof translations)[keyof typeof translations];
type PickerSection = { name: string; items: string[] };
type PendingUpdate = NonNullable<Awaited<ReturnType<typeof checkForUpdates>>>;

const fallbackSettings: AppSettings = {
  max_items: 200,
  poll_interval_ms: 800,
  auto_trim: true,
  locale: "tr",
  theme: "system",
  default_view: "picker",
  window_anchor: "center",
  ui_scale: 100,
  shortcut: "",
  ocr_shortcut: "Super+Shift+T"
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

type ShortcutKeyEvent = {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  getModifierState: (keyArg: string) => boolean;
};

function shortcutModifiersFromEvent(event: ShortcutKeyEvent) {
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

function shortcutFromEvent(event: ShortcutKeyEvent, activeModifiers = new Set<string>()) {
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
  const [contextMenu, setContextMenu] = useState<{ item: ClipboardItem; x: number; y: number } | null>(null);
  const [pendingUpdate, setPendingUpdate] = useState<PendingUpdate | null>(null);
  const [isCheckingUpdates, setIsCheckingUpdates] = useState(false);
  const [isInstallingUpdate, setIsInstallingUpdate] = useState(false);
  const [updateProgress, setUpdateProgress] = useState<number | null>(null);
  const [updateStatus, setUpdateStatus] = useState("");
  const ocrFlowActiveRef = useRef(false);
  const autoUpdateCheckedRef = useRef(false);
  const saveTokenRef = useRef(0);
  const deferredQuery = useDeferredValue(query);
  const t = translations[settings.locale];

  useEffect(() => {
    const closeContextMenu = () => setContextMenu(null);
    window.addEventListener("pointerdown", closeContextMenu);
    window.addEventListener("resize", closeContextMenu);
    return () => {
      window.removeEventListener("pointerdown", closeContextMenu);
      window.removeEventListener("resize", closeContextMenu);
    };
  }, []);

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

  const checkUpdates = useCallback(async (showCheckingToast = true) => {
    if (isCheckingUpdates || isInstallingUpdate) return;

    setIsCheckingUpdates(true);
    setUpdateStatus(t.updateChecking);
    if (showCheckingToast) setToast(t.updateChecking);

    try {
      const update = await checkForUpdates();
      if (!update) {
        setUpdateStatus(t.updateNone);
        if (showCheckingToast) setToast(t.updateNone);
        return;
      }

      const foundMessage = `${t.updateFound}: v${update.version}`;
      setUpdateStatus(foundMessage);
      setPendingUpdate(update);
      setToast(foundMessage);
    } catch (error) {
      console.error("Update check failed:", error);
      const detail = error instanceof Error ? error.message : String(error);
      const errorMessage = `${t.updateFailed}: ${detail}`;
      setUpdateStatus(errorMessage);
      if (showCheckingToast) setToast(errorMessage);
    } finally {
      setIsCheckingUpdates(false);
    }
  }, [isCheckingUpdates, isInstallingUpdate, t]);

  useEffect(() => {
    if (!isReady || autoUpdateCheckedRef.current) return;
    autoUpdateCheckedRef.current = true;
    const timer = window.setTimeout(() => {
      void checkUpdates(false);
    }, 1400);
    return () => window.clearTimeout(timer);
  }, [isReady, checkUpdates]);

  const cancelPendingUpdate = useCallback(async () => {
    if (!pendingUpdate || isInstallingUpdate) return;
    try {
      await pendingUpdate.close();
    } catch (error) {
      console.warn("Could not close pending update:", error);
    }
    setPendingUpdate(null);
    setUpdateStatus(t.updateCancelled);
    setToast(t.updateCancelled);
  }, [isInstallingUpdate, pendingUpdate, t]);

  const installPendingUpdate = useCallback(async () => {
    if (!pendingUpdate || isInstallingUpdate) return;

    setIsInstallingUpdate(true);
    setUpdateProgress(0);
    setUpdateStatus(t.updateInstalling);
    setToast(t.updateInstalling);

    try {
      await installUpdate(pendingUpdate, (percent) => {
        setUpdateProgress(percent);
        const progressMessage = percent === null ? t.updateDownloading : `${t.updateDownloading} %${percent}`;
        setUpdateStatus(progressMessage);
        setToast(progressMessage);
      });
      setPendingUpdate(null);
    } catch (error) {
      console.error("Update install failed:", error);
      const detail = error instanceof Error ? error.message : String(error);
      const errorMessage = `${t.updateFailed}: ${detail}`;
      setUpdateStatus(errorMessage);
      setToast(errorMessage);
    } finally {
      setIsInstallingUpdate(false);
    }
  }, [isInstallingUpdate, pendingUpdate, t]);

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

  async function changeOcrShortcut(shortcut: string) {
    const normalized = normalizeShortcut(shortcut);
    try {
      await patchSettings({ ...settings, ocr_shortcut: normalized }, normalized ? t.shortcutSaved : t.shortcutCleared);
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

  async function runImageOcr(item: ClipboardItem) {
    if (item.kind !== "image") return;
    setContextMenu(null);
    setToast(t.ocrReading);
    try {
      setItems(await ocrImageItem(item.id));
      setToast(t.ocrCopied);
    } catch (error) {
      setToast(String(error));
    }
  }

  async function beginScreenOcr() {
    setContextMenu(null);
    setToast(t.ocrPreparing);
    ocrFlowActiveRef.current = true;
    try {
      await prepareScreenOcr();
      // `hide` işleminin pencere yöneticisinde görünür hâle gelmesini bekle.
      await new Promise<void>(resolve => window.setTimeout(resolve, 400));
      setItems(await captureScreenOcr());
      setToast(t.ocrCopied);
    } catch (error) {
      setToast(String(error));
    } finally {
      ocrFlowActiveRef.current = false;
    }
  }

  function openContextMenu(event: ReactMouseEvent, item: ClipboardItem) {
    if (item.kind !== "image") return;
    event.preventDefault();
    const menuWidth = 190;
    const menuHeight = 44;
    setContextMenu({
      item,
      x: Math.min(event.clientX, window.innerWidth - menuWidth - 8),
      y: Math.min(event.clientY, window.innerHeight - menuHeight - 8)
    });
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
      if (ocrFlowActiveRef.current) return;
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
              <button type="button" className="ghost-icon" onClick={() => void beginScreenOcr()} title={t.screenOcr}>
                <ScanText size={16} />
              </button>
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
              onContextMenu={openContextMenu}
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
          onScreenOcr={() => void beginScreenOcr()}
          onContextMenu={openContextMenu}
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
          onOcrShortcutChange={changeOcrShortcut}
          onShowToast={setToast}
          onCheckUpdates={() => void checkUpdates()}
          isCheckingUpdates={isCheckingUpdates}
          updateStatus={updateStatus}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {pendingUpdate ? (
        <UpdateDialog
          update={pendingUpdate}
          labels={t}
          isInstalling={isInstallingUpdate}
          progress={updateProgress}
          onCancel={() => void cancelPendingUpdate()}
          onInstall={() => void installPendingUpdate()}
        />
      ) : null}

      {contextMenu && (
        <div
          className="item-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button type="button" onClick={() => void runImageOcr(contextMenu.item)}>
            <ScanText size={15} />
            {t.ocrImage}
          </button>
        </div>
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
  onDelete,
  onContextMenu
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
  onContextMenu: (event: ReactMouseEvent, item: ClipboardItem) => void;
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
            <div key={item.id} className={`compact-item ${selectedId === item.id ? "selected" : ""}`} onContextMenu={(event) => onContextMenu(event, item)}>
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
  onCopy,
  onFavorite,
  onDelete,
  onClear,
  onCompact,
  onOpenSettings,
  onScreenOcr,
  onContextMenu
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
  onCopy: (item: ClipboardItem) => void;
  onFavorite: (id: string) => void;
  onDelete: (id: string) => void;
  onClear: () => void;
  onCompact: () => void;
  onOpenSettings: () => void;
  onScreenOcr: () => void;
  onContextMenu: (event: ReactMouseEvent, item: ClipboardItem) => void;
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
            <div key={item.id} className={`history-item ${selected?.id === item.id ? "selected" : ""}`} onContextMenu={(event) => onContextMenu(event, item)}>
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
          <div className="title-area manager-title-area" data-tauri-drag-region>
            <h1 data-tauri-drag-region>{labels.history}</h1>
            <button type="button" className="screen-ocr-toolbar-button" onClick={onScreenOcr}>
              <ScanText size={16} />
              {labels.screenOcr}
            </button>
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
  onOcrShortcutChange,
  onShowToast,
  onCheckUpdates,
  isCheckingUpdates,
  updateStatus,
  onClose
}: {
  settings: AppSettings;
  labels: Labels;
  onChange: (settings: AppSettings) => void;
  onShortcutChange: (shortcut: string) => Promise<void>;
  onOcrShortcutChange: (shortcut: string) => Promise<void>;
  onShowToast: (message: string) => void;
  onCheckUpdates: () => void;
  isCheckingUpdates: boolean;
  updateStatus: string;
  onClose: () => void;
}) {
  const [recordingTarget, setRecordingTarget] = useState<"app" | "ocr" | null>(null);
  const [shortcutError, setShortcutError] = useState("");
  const [ocrShortcutError, setOcrShortcutError] = useState("");
  const [confirmUninstallOpen, setConfirmUninstallOpen] = useState(false);
  const [isUninstalling, setIsUninstalling] = useState(false);
  const [passwordModalOpen, setPasswordModalOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [appVersion, setAppVersion] = useState("");
  const shortcutButtonRef = useRef<HTMLButtonElement | null>(null);
  const ocrShortcutButtonRef = useRef<HTMLButtonElement | null>(null);
  const recordingModifiersRef = useRef<Set<string>>(new Set());
  const isRecording = recordingTarget === "app";
  const isOcrRecording = recordingTarget === "ocr";
  const shortcutLabel = isRecording ? labels.shortcutRecording : formatShortcutLabel(settings.shortcut, labels.shortcutDisabled);
  const ocrShortcutLabel = isOcrRecording ? labels.shortcutRecording : formatShortcutLabel(settings.ocr_shortcut, labels.shortcutDisabled);

  useEffect(() => {
    void getVersion()
      .then(setAppVersion)
      .catch(() => setAppVersion(""));
  }, []);

  function startRecording(target: "app" | "ocr") {
    if (target === "app") setShortcutError("");
    else setOcrShortcutError("");
    recordingModifiersRef.current.clear();
    setRecordingTarget(target);
    requestAnimationFrame(() => {
      const button = target === "app" ? shortcutButtonRef.current : ocrShortcutButtonRef.current;
      button?.focus();
    });
  }

  useEffect(() => {
    if (!recordingTarget) return;

    const setRecorderError = (message: string) => {
      if (recordingTarget === "app") setShortcutError(message);
      else setOcrShortcutError(message);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();

      if (event.repeat) return;

      const modifier = modifierFromKey(event.key);
      if (modifier) {
        recordingModifiersRef.current.add(modifier);
        setRecorderError("");
        return;
      }

      const next = shortcutFromEvent(event, recordingModifiersRef.current);
      if (next.cancelled) {
        setRecorderError("");
        recordingModifiersRef.current.clear();
        setRecordingTarget(null);
        return;
      }

      if (next.needsModifier || !next.value) {
        setRecorderError(labels.shortcutNeedModifier);
        return;
      }

      setRecorderError("");
      recordingModifiersRef.current.clear();
      const target = recordingTarget;
      setRecordingTarget(null);
      void (target === "ocr" ? onOcrShortcutChange(next.value) : onShortcutChange(next.value));
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      const modifier = modifierFromKey(event.key);
      if (modifier) recordingModifiersRef.current.delete(modifier);
    };

    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keyup", handleKeyUp, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("keyup", handleKeyUp, true);
    };
  }, [recordingTarget, labels.shortcutNeedModifier, onShortcutChange, onOcrShortcutChange]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section className="settings-modal" onClick={(event) => event.stopPropagation()}>
        <header>
          <h2>{labels.settings}</h2>
          <button type="button" className="ghost-icon" onClick={onClose} aria-label={labels.close}>
            <X size={20} />
          </button>
        </header>

        <div className="settings-section-title">{labels.appearance}</div>

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

        <div className="settings-section-title">{labels.behavior}</div>

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

        <div className="settings-section-title">{labels.historySettings}</div>

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

        <div className="settings-section-title">{labels.shortcutSettings}</div>

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
              onClick={() => startRecording("app")}
            >
              <Keyboard size={16} />
              <span>{shortcutLabel}</span>
            </button>
            <div className="shortcut-actions">
              <button
                type="button"
                className="icon-label"
                onClick={() => startRecording("app")}
              >
                {labels.shortcutRecordButton}
              </button>
              <button
                type="button"
                className="icon-label"
                onClick={() => {
                  setShortcutError("");
                  recordingModifiersRef.current.clear();
                  setRecordingTarget(null);
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
                  setRecordingTarget(null);
                  void onShortcutChange("");
                }}
              >
                {labels.shortcutClearButton}
              </button>
            </div>
          </div>
          {shortcutError ? <p className="shortcut-error">{shortcutError}</p> : null}
        </section>

        <section className="shortcut-card ocr-shortcut-card">
          <div className="shortcut-card-head">
            <div>
              <strong>{labels.screenOcr}</strong>
              <p>{labels.ocrShortcutHint}</p>
              <p className="shortcut-super-help">{labels.ocrShortcutSuperHelp}</p>
            </div>
            <span className={`shortcut-badge ${settings.ocr_shortcut ? "active" : ""}`}>{formatShortcutLabel(settings.ocr_shortcut, labels.shortcutDisabled)}</span>
          </div>
          <div className="shortcut-recorder">
            <button
              ref={ocrShortcutButtonRef}
              type="button"
              className={`shortcut-capture ${isOcrRecording ? "recording" : ""}`}
              onClick={() => startRecording("ocr")}
            >
              <ScanText size={16} />
              <span>{ocrShortcutLabel}</span>
            </button>
            <div className="shortcut-actions">
              <button type="button" className="icon-label" onClick={() => startRecording("ocr")}>
                {labels.shortcutRecordButton}
              </button>
              <button
                type="button"
                className="icon-label"
                onClick={() => {
                  setOcrShortcutError("");
                  setRecordingTarget(null);
                  void onOcrShortcutChange("Super+Shift+T");
                }}
              >
                Super + Shift + T
              </button>
              <button
                type="button"
                className="icon-label"
                onClick={() => {
                  setOcrShortcutError("");
                  setRecordingTarget(null);
                  void onOcrShortcutChange("");
                }}
              >
                {labels.shortcutClearButton}
              </button>
            </div>
          </div>
          {ocrShortcutError ? <p className="shortcut-error">{ocrShortcutError}</p> : null}
        </section>

        <div className="settings-section-title">{labels.maintenance}</div>

        <button 
          type="button" 
          className="check-updates-btn"
          disabled={isCheckingUpdates}
          onClick={onCheckUpdates}
          aria-live="polite"
        >
          {updateStatus || labels.checkUpdates || "Güncellemeleri Kontrol Et"}
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
              className="confirm-dialog password-dialog"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="password-title"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="confirm-copy">
                <h3 id="password-title">Yönetici Şifresi</h3>
                <p>
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
                className="password-input"
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

function UpdateDialog({
  update,
  labels,
  isInstalling,
  progress,
  onCancel,
  onInstall
}: {
  update: PendingUpdate;
  labels: Labels;
  isInstalling: boolean;
  progress: number | null;
  onCancel: () => void;
  onInstall: () => void;
}) {
  return (
    <div className="update-backdrop" onClick={onCancel}>
      <section
        className="update-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="update-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="update-dialog-topline">
          <div className="update-icon" aria-hidden="true">
            {isInstalling ? <Download size={20} /> : <CheckCircle2 size={20} />}
          </div>
          <div>
            <span className="update-eyebrow">ClipNest</span>
            <h3 id="update-title">{labels.updateFound}</h3>
          </div>
          <span className="update-version">v{update.version}</span>
        </div>

        <div className="update-dialog-body">
          <p>{update.body?.trim() || labels.updateInstallConfirm}</p>
          {isInstalling ? (
            <div className="update-progress-block" aria-live="polite">
              <div className="update-progress-label">
                <span>{labels.updateDownloading}</span>
                <strong>{progress === null ? "…" : `%${progress}`}</strong>
              </div>
              <div className="update-progress-track">
                <span style={{ width: `${progress ?? 0}%` }} />
              </div>
            </div>
          ) : null}
        </div>

        <div className="update-dialog-actions">
          <button type="button" className="update-secondary" disabled={isInstalling} onClick={onCancel}>
            {labels.updateLater}
          </button>
          <button type="button" className="update-primary" disabled={isInstalling} onClick={onInstall}>
            <Download size={15} />
            {labels.updateInstallAction}
          </button>
        </div>
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
      <div className="confirm-dialog confirm-clear-dialog" onClick={(e) => e.stopPropagation()}>
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
