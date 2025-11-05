import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// Photo Culler — strict TypeScript rebuild (no ambient DOM redefs, no 'any')
// - Loader overlay during scan/copy
// - Uses built-in lib.dom types
// - Safe feature detection without redefining Window
// - Strict typing; unknown in catches with narrowing
// - Object URL lifecycle managed

// ---------- Types ----------

type ImgItem = {
  name: string;
  path: string; // virtual path within the selected folder(s)
  handle: FileSystemFileHandle;
  url: string; // object URL for preview
  type: string; // mime type
  size: number; // bytes
  lastModified: number;
};

type Tag = {
  keep: boolean; // F/Enter
  rating?: 1 | 2 | 3 | 4 | 5; // 1..5
  reject?: boolean; // X
  notes?: string;
};

type TagMap = Record<string, Tag>; // key: item.path

// ---------- Helpers ----------

function hasDirPicker(win: Window & typeof globalThis): win is Window &
  typeof globalThis & {
    showDirectoryPicker: (options?: {
      id?: string;
      mode?: "read" | "readwrite";
    }) => Promise<FileSystemDirectoryHandle>;
  } {
  return (
    "showDirectoryPicker" in win &&
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    typeof (win as any).showDirectoryPicker === "function"
  ); // TS knows property via type guard; runtime uses 'any' but isolated here
}

async function* walkDir(
  dir: FileSystemDirectoryHandle,
  prefix = ""
): AsyncGenerator<{ path: string; handle: FileSystemHandle }> {
  // Prefer entries(): yields [name, handle]
  if ("entries" in dir && typeof dir.entries === "function") {
    for await (const [name, handle] of dir.entries() as AsyncIterableIterator<
      [string, FileSystemHandle]
    >) {
      const fullPath = prefix ? `${prefix}/${name}` : name;
      if (handle.kind === "file") {
        yield { path: fullPath, handle };
      } else if (handle.kind === "directory") {
        yield* walkDir(handle as FileSystemDirectoryHandle, fullPath);
      }
    }
    return;
  }

  // Fallback: values(): yields handles; we derive names from handle.name
  if ("values" in dir && typeof dir.values === "function") {
    for await (const handle of dir.values() as AsyncIterableIterator<FileSystemHandle>) {
      const name = handle.name;
      const fullPath = prefix ? `${prefix}/${name}` : name;
      if (handle.kind === "file") {
        yield { path: fullPath, handle };
      } else if (handle.kind === "directory") {
        yield* walkDir(handle as FileSystemDirectoryHandle, fullPath);
      }
    }
    return;
  }

  throw new Error("Directory handle is not iterable in this browser.");
}

const isImage = (name: string, type: string) => {
  const lower = name.toLowerCase();
  return (
    type.startsWith("image/") ||
    [
      ".jpg",
      ".jpeg",
      ".png",
      ".gif",
      ".webp",
      ".bmp",
      ".tiff",
      ".heic",
      ".heif",
      ".avif",
    ].some((ext) => lower.endsWith(ext))
  );
};

const LOCAL_KEY = "photo_culler_tags_v3";

function loadSavedTags(): TagMap {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    return raw ? (JSON.parse(raw) as TagMap) : {};
  } catch {
    return {};
  }
}

function saveTags(toSave: TagMap) {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(toSave));
  } catch {
    // ignore quota errors
  }
}

function downloadJSON(filename: string, data: unknown) {
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function LoaderOverlay({ message = "Working…" }: { message?: string }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center">
      <div className="bg-white rounded-2xl shadow-xl px-5 py-4 flex items-center gap-3">
        <svg
          className="animate-spin h-5 w-5"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          aria-hidden
        >
          <circle cx="12" cy="12" r="9" strokeWidth="3" opacity="0.25" />
          <path d="M21 12a9 9 0 0 1-9 9" strokeWidth="3" />
        </svg>
        <span className="text-sm text-zinc-700">{message}</span>
      </div>
    </div>
  );
}

// ---------- Component ----------

export default function PhotoCullerApp() {
  const [items, setItems] = useState<ImgItem[]>([]);
  const [idx, setIdx] = useState(0);
  const [tags, setTags] = useState<TagMap>(() => loadSavedTags());
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);

  // Refs to avoid re-binding keyboard listener
  const itemsRef = useRef(items);
  const idxRef = useRef(idx);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);
  useEffect(() => {
    idxRef.current = idx;
  }, [idx]);

  // Persist tags
  useEffect(() => {
    saveTags(tags);
  }, [tags]);

  const current = items[idx];
  const currentTag: Tag | undefined = current ? tags[current.path] : undefined;

  // Cleanup object URLs on unmount or when clearing items
  useEffect(() => {
    return () => {
      for (const it of itemsRef.current) URL.revokeObjectURL(it.url);
    };
  }, []);

  const handlePickFolder = useCallback(async () => {
    if (!hasDirPicker(window)) {
      setStatus(
        "Your browser doesn’t support the File System Access API. Try Chrome/Edge or Safari on HTTPS/localhost."
      );
      return;
    }
    try {
      setLoading(true);
      setStatus("Scanning folder…");
      const dir = await window.showDirectoryPicker({ id: "source_photos" });
      const collected: ImgItem[] = [];

      for await (const { path, handle } of walkDir(dir)) {
        if (handle.kind === "file") {
          const fh = handle as FileSystemFileHandle;
          try {
            const file = await fh.getFile();
            if (!isImage(path, file.type || "")) continue;
            const url = URL.createObjectURL(file);
            collected.push({
              name: file.name,
              path,
              handle: fh,
              url,
              type: file.type || "",
              size: file.size,
              lastModified: file.lastModified,
            });
          } catch (err) {
            console.warn("Skipping file (no permission?)", path, err);
          }
        }
      }

      collected.sort((a, b) => a.path.localeCompare(b.path));
      // Revoke previous URLs before replacing
      for (const it of itemsRef.current) URL.revokeObjectURL(it.url);
      setItems(collected);
      setIdx(0);
      setStatus(`Loaded ${collected.length} image(s).`);
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Folder selection cancelled.";
      setStatus(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  // Keyboard controls (single listener)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const list = itemsRef.current;
      if (e.key === "?") {
        e.preventDefault();
        setShowHelp((s) => !s);
        return;
      }
      if (!list.length) return;

      if (e.key === "ArrowRight") {
        e.preventDefault();
        setIdx((i) => Math.min(i + 1, list.length - 1));
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        setIdx((i) => Math.max(i - 1, 0));
      } else if (e.key.toLowerCase() === "f" || e.key === "Enter") {
        e.preventDefault();
        const p = list[idxRef.current]?.path;
        if (!p) return;
        setTags((t) => ({
          ...t,
          [p]: { ...(t[p] || { keep: false }), keep: !t[p]?.keep },
        }));
      } else if (["1", "2", "3", "4", "5"].includes(e.key)) {
        e.preventDefault();
        const rating = Number(e.key) as 1 | 2 | 3 | 4 | 5;
        const p = list[idxRef.current]?.path;
        if (!p) return;
        setTags((t) => ({
          ...t,
          [p]: { ...(t[p] || { keep: false }), rating },
        }));
      } else if (e.key.toLowerCase() === "x") {
        e.preventDefault();
        const p = list[idxRef.current]?.path;
        if (!p) return;
        setTags((t) => ({
          ...t,
          [p]: { ...(t[p] || { keep: false }), reject: !t[p]?.reject },
        }));
      } else if (e.key.toLowerCase() === "n") {
        e.preventDefault();
        setIdx((i) => Math.min(i + 1, list.length - 1));
      } else if (e.key.toLowerCase() === "p") {
        e.preventDefault();
        setIdx((i) => Math.max(i - 1, 0));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const keptCount = useMemo(
    () => Object.values(tags).filter((t) => t.keep && !t.reject).length,
    [tags]
  );
  const filteredKept = useMemo(
    () => items.filter((it) => tags[it.path]?.keep && !tags[it.path]?.reject),
    [items, tags]
  );

  const exportTags = useCallback(() => {
    const payload = {
      generatedAt: new Date().toISOString(),
      total: items.length,
      kept: keptCount,
      items: items.map((it) => ({
        path: it.path,
        name: it.name,
        type: it.type,
        size: it.size,
        lastModified: it.lastModified,
        tag: tags[it.path] || {},
      })),
    };
    downloadJSON("photo-tags.json", payload);
  }, [items, tags, keptCount]);

  const copyKeptToFolder = useCallback(async () => {
    if (!filteredKept.length) {
      setStatus("No kept photos to copy.");
      return;
    }
    if (!hasDirPicker(window)) {
      setStatus("Your browser doesn’t support writing to folders.");
      return;
    }
    try {
      setLoading(true);
      setStatus("Choose destination folder…");
      const dest = await window.showDirectoryPicker({
        id: "dest_kept",
        mode: "readwrite",
      });

      let copied = 0;
      const total = filteredKept.length;
      for (const it of filteredKept) {
        try {
          const file = await it.handle.getFile();
          const destFile = await dest.getFileHandle(it.name, { create: true });
          const writable = await destFile.createWritable();
          await writable.write(file);
          await writable.close();
          copied++;
          setStatus(`Copying… ${copied}/${total}`);
        } catch (err) {
          console.warn("Failed to copy", it.path, err);
        }
      }
      setStatus(`Done. Copied ${copied} file(s).`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Copy cancelled.";
      setStatus(msg);
    } finally {
      setLoading(false);
    }
  }, [filteredKept]);

  const clearAll = useCallback(() => {
    if (!confirm("Clear loaded photos and keep saved tags?")) return;
    for (const it of items) URL.revokeObjectURL(it.url);
    setItems([]);
    setIdx(0);
  }, [items]);

  const clearLocalTags = useCallback(() => {
    if (!confirm("Erase saved tags in localStorage?")) return;
    localStorage.removeItem(LOCAL_KEY);
    setTags({});
    setStatus("Cleared saved tags.");
  }, []);

  return (
    <div className="min-h-screen w-full bg-zinc-50 text-zinc-900 flex flex-col">
      {loading && <LoaderOverlay message={status || "Working…"} />}

      {/* Header */}
      <header className="sticky top-0 z-10 bg-white/80 backdrop-blur border-b border-zinc-200">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-2">
          <h1 className="text-xl font-semibold">📸 Photo Culler</h1>
          <div className="flex-1" />
          <button
            onClick={handlePickFolder}
            className="px-3 py-1.5 rounded-2xl border shadow-sm hover:shadow bg-white"
          >
            Select Folder
          </button>
          <button
            onClick={exportTags}
            disabled={!items.length}
            className="px-3 py-1.5 rounded-2xl border shadow-sm hover:shadow bg-white disabled:opacity-50"
          >
            Export Tags JSON
          </button>
          <button
            onClick={copyKeptToFolder}
            disabled={!filteredKept.length}
            className="px-3 py-1.5 rounded-2xl border shadow-sm hover:shadow bg-white disabled:opacity-50"
          >
            Copy Kept → Folder
          </button>
          <button
            onClick={() => setShowHelp(true)}
            className="px-2 py-1.5 rounded-xl border bg-white"
          >
            ?
          </button>
        </div>
      </header>

      {/* Status bar */}
      {(status || loading) && (
        <div className="bg-amber-50 border-b border-amber-200 text-amber-900 text-sm px-4 py-2">
          <div className="max-w-6xl mx-auto">{status}</div>
        </div>
      )}

      {/* Main */}
      <main className="flex-1 max-w-6xl mx-auto w-full px-4 py-4 flex flex-col gap-4">
        {/* Summary */}
        <div className="flex items-center gap-3 text-sm text-zinc-600">
          <div>{items.length} image(s)</div>
          <div>·</div>
          <div>
            <b>{keptCount}</b> kept
          </div>
          <div>·</div>
          <div>
            Use ←/→ to navigate, F/Enter to keep, 1-5 to rate, X to reject
          </div>
        </div>

        {/* Viewer */}
        <div className="grid grid-cols-1 md:grid-cols-5 gap-4 items-start">
          {/* Large preview */}
          <div className="md:col-span-4 rounded-2xl border bg-white shadow-sm p-3 flex flex-col gap-3">
            <div className="flex items-center justify-between text-sm text-zinc-600">
              <div className="truncate">
                {current ? current.path : "No image selected"}
              </div>
              {current && (
                <div className="flex items-center gap-2">
                  {currentTag?.keep ? (
                    <span className="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 text-xs">
                      KEPT
                    </span>
                  ) : null}
                  {currentTag?.reject ? (
                    <span className="px-2 py-0.5 rounded-full bg-rose-100 text-rose-800 text-xs">
                      REJECTED
                    </span>
                  ) : null}
                  {currentTag?.rating ? (
                    <span className="px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-800 text-xs">
                      {currentTag.rating}★
                    </span>
                  ) : null}
                </div>
              )}
            </div>
            <div className="relative w-full aspect-[3/2] bg-zinc-100 rounded-xl overflow-hidden flex items-center justify-center">
              {current ? (
                <img
                  src={current.url}
                  alt={current.name}
                  className="max-w-full max-h-full object-contain select-none"
                  draggable={false}
                  onDoubleClick={() =>
                    setTags((t) => ({
                      ...t,
                      [current.path]: {
                        ...(t[current.path] || { keep: false }),
                        keep: !t[current.path]?.keep,
                      },
                    }))
                  }
                />
              ) : (
                <div className="text-zinc-500">Select a folder to begin</div>
              )}
              {/* Prev/Next click zones */}
              {current && (
                <>
                  <button
                    onClick={() => setIdx((i) => Math.max(i - 1, 0))}
                    className="absolute left-0 top-0 h-full w-1/4 opacity-0 hover:opacity-100 transition-opacity text-2xl"
                    aria-label="Previous"
                  >
                    ◀
                  </button>
                  <button
                    onClick={() =>
                      setIdx((i) => Math.min(i + 1, items.length - 1))
                    }
                    className="absolute right-0 top-0 h-full w-1/4 opacity-0 hover:opacity-100 transition-opacity text-2xl"
                    aria-label="Next"
                  >
                    ▶
                  </button>
                </>
              )}
            </div>
            {current && (
              <div className="flex items-center justify-between text-sm text-zinc-600">
                <div>
                  {idx + 1} / {items.length}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setIdx((i) => Math.max(i - 1, 0))}
                    className="px-3 py-1.5 rounded-xl border bg-white"
                  >
                    Prev
                  </button>
                  <button
                    onClick={() =>
                      setIdx((i) => Math.min(i + 1, items.length - 1))
                    }
                    className="px-3 py-1.5 rounded-xl border bg-white"
                  >
                    Next
                  </button>
                  <button
                    onClick={() =>
                      setTags((t) => ({
                        ...t,
                        [current.path]: {
                          ...(t[current.path] || { keep: false }),
                          keep: !t[current.path]?.keep,
                        },
                      }))
                    }
                    className="px-3 py-1.5 rounded-xl border bg-white"
                  >
                    {currentTag?.keep ? "Unkeep" : "Keep (F/Enter)"}
                  </button>
                  <button
                    onClick={() =>
                      setTags((t) => ({
                        ...t,
                        [current.path]: {
                          ...(t[current.path] || { keep: false }),
                          reject: !t[current.path]?.reject,
                        },
                      }))
                    }
                    className="px-3 py-1.5 rounded-xl border bg-white"
                  >
                    {currentTag?.reject ? "Unreject" : "Reject (X)"}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Sidebar */}
          <aside className="md:col-span-1 flex flex-col gap-3">
            <div className="rounded-2xl border bg-white shadow-sm p-3">
              <div className="font-medium mb-2">Session</div>
              <div className="flex flex-col gap-2 text-sm">
                <button
                  onClick={clearAll}
                  className="px-3 py-1.5 rounded-xl border bg-white"
                >
                  Clear Loaded
                </button>
                <button
                  onClick={clearLocalTags}
                  className="px-3 py-1.5 rounded-xl border bg-white"
                >
                  Clear Saved Tags
                </button>
              </div>
            </div>

            <div className="rounded-2xl border bg-white shadow-sm p-3">
              <div className="font-medium mb-2">Kept Photos</div>
              <div className="text-sm text-zinc-600 mb-2">
                {keptCount} selected
              </div>
              <div className="flex flex-col gap-2">
                <button
                  onClick={copyKeptToFolder}
                  disabled={!filteredKept.length}
                  className="px-3 py-1.5 rounded-xl border bg-white disabled:opacity-50"
                >
                  Copy Kept → Folder
                </button>
                <button
                  onClick={exportTags}
                  disabled={!items.length}
                  className="px-3 py-1.5 rounded-xl border bg-white disabled:opacity-50"
                >
                  Export Tags JSON
                </button>
              </div>
            </div>
          </aside>
        </div>

        {/* Thumbnails */}
        {items.length > 0 && (
          <div className="rounded-2xl border bg-white shadow-sm p-3">
            <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-3">
              {items.map((it, i) => {
                const t = tags[it.path];
                const active = i === idx;
                return (
                  <button
                    key={it.path}
                    onClick={() => setIdx(i)}
                    className={`relative rounded-xl overflow-hidden border ${
                      active ? "ring-2 ring-indigo-500" : ""
                    }`}
                  >
                    <img
                      src={it.url}
                      alt={it.name}
                      className="w-full h-24 object-cover"
                    />
                    <div className="absolute inset-x-0 bottom-0 text-[10px] bg-black/50 text-white px-1 truncate">
                      {it.name}
                    </div>
                    {t?.keep && !t?.reject && (
                      <span className="absolute top-1 left-1 text-[10px] px-1.5 py-0.5 rounded bg-emerald-500 text-white">
                        KEEP
                      </span>
                    )}
                    {t?.reject && (
                      <span className="absolute top-1 left-1 text-[10px] px-1.5 py-0.5 rounded bg-rose-600 text-white">
                        X
                      </span>
                    )}
                    {t?.rating && (
                      <span className="absolute top-1 right-1 text-[10px] px-1.5 py-0.5 rounded bg-indigo-600 text-white">
                        {t.rating}★
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </main>

      {/* Help modal */}
      {showHelp && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center p-4"
          onClick={() => setShowHelp(false)}
        >
          <div
            className="bg-white rounded-2xl shadow-xl p-5 max-w-lg w-full"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-lg font-semibold mb-2">Keyboard Shortcuts</div>
            <ul className="list-disc list-inside text-sm text-zinc-700 space-y-1">
              <li>
                <kbd className="px-1 border rounded">←</kbd>/
                <kbd className="px-1 border rounded">→</kbd> previous / next
              </li>
              <li>
                <kbd className="px-1 border rounded">F</kbd> or{" "}
                <kbd className="px-1 border rounded">Enter</kbd> toggle Keep
              </li>
              <li>
                <kbd className="px-1 border rounded">1</kbd>-
                <kbd className="px-1 border rounded">5</kbd> set rating
              </li>
              <li>
                <kbd className="px-1 border rounded">X</kbd> toggle Reject
              </li>
              <li>
                <kbd className="px-1 border rounded">N</kbd>/
                <kbd className="px-1 border rounded">P</kbd> next / prev
              </li>
              <li>
                <kbd className="px-1 border rounded">?</kbd> toggle this help
              </li>
            </ul>
            <div className="mt-4 text-sm text-zinc-600">
              Tip: double‑click the large preview to toggle Keep.
            </div>
            <div className="mt-4 flex justify-end">
              <button
                onClick={() => setShowHelp(false)}
                className="px-3 py-1.5 rounded-xl border bg-white"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      <footer className="text-xs text-zinc-500 px-4 py-3 border-t bg-white/60">
        <div className="max-w-6xl mx-auto">
          Built with the File System Access API. Works best on Chromium-based
          browsers over HTTPS/localhost.
        </div>
      </footer>
    </div>
  );
}
