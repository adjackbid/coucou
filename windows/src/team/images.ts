// Pictures where the work is talked about. A member that makes an image says
// where it put it — in what it writes, in the tool it ran, in what it hands
// in — and the person should see the picture there, not a path to go and
// find. Any text a screen shows can carry a row of thumbnails for the
// pictures it names; a thumbnail opens the picture in the window itself,
// with the system's viewer and Explorer a click away.
//
// Only pictures inside the team's work folder are read (team_preview, which
// also caps their size): a path an agent wrote elsewhere shows no thumbnail.

import "./images.css";
import { Bridge, IS_TAURI } from "../core/bridge";
import { tr, trf } from "../core/i18n";
import { h } from "../views/dom";

const EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;
/** Thumbnails are drawn this wide at most (twice the size they are shown at). */
const THUMB_PX = 360;
/** A picture named again after this long is read again: agents overwrite their drafts. */
const FRESH_MS = 20_000;

export function isImage(locator: string): boolean {
  return EXT.test(locator.trim());
}

/**
 * The picture files a text names — `D:\out\a.png`, `out/a.png`,
 * `file:///D:/out/a.png`, in quotes, backticks or a Markdown link — in the
 * order they come, each once, at most `max`.
 */
export function imagePaths(text: string, max = 6): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  // Paths with spaces are not told apart from the words around them; the rest are.
  for (const raw of text.split(/[\s"'`<>|()[\]{}「」『』（）【】，。、；：！？,;!?*]+/u)) {
    let p = raw.replace(/[.:]+$/u, "");
    if (!EXT.test(p)) continue;
    if (/^file:\/\//i.test(p)) {
      p = p.replace(/^file:\/\/\/?/i, "");
      try {
        p = decodeURIComponent(p);
      } catch {
        /* as it was */
      }
    }
    if (/^https?:/i.test(p)) continue;
    // `路徑:D:\out\a.png` — the path starts at its drive.
    const drive = p.search(/[A-Za-z]:[\\/]/);
    if (drive > 0) p = p.slice(drive);
    const key = norm(p);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  // A Markdown link names a picture twice, `[a.png](file:///D:/out/a.png)`: the full path is enough.
  const isAbsolute = (x: string) => /^[A-Za-z]:[\\/]/.test(x);
  const absolute = out.filter(isAbsolute).map(norm);
  return out.filter((x) => isAbsolute(x) || !absolute.some((a) => a.endsWith(`\\${norm(x).replace(/^\.\\/, "")}`))).slice(0, max);
}

/** A path as compared: backslashes, any case. */
export function picKey(path: string): string {
  return norm(path);
}

function norm(path: string): string {
  return path.replace(/\//g, "\\").toLowerCase();
}

const fileName = (path: string) => path.split(/[\\/]/).pop() || path;

// ── Thumbnails ────────────────────────────────────────────────────────────────

const thumbs = new Map<string, { at: number; url: Promise<string | null> }>();

/** A stand-in picture for the browser preview of the window, where no file can be read. */
function demoPicture(path: string): string {
  let n = 0;
  for (const ch of path) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = n % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},70%,62%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360},60%,30%)"/></linearGradient></defs><rect width="480" height="360" fill="url(#g)"/><circle cx="360" cy="90" r="40" fill="rgba(255,255,255,.55)"/><path d="M0 300 L140 170 L250 260 L330 200 L480 320 L480 360 L0 360Z" fill="rgba(0,0,0,.35)"/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** The picture's bytes as a URL the page can show, whole. */
async function full(team: string, path: string): Promise<string> {
  if (!IS_TAURI) return demoPicture(path);
  const bytes = await Bridge.teamPreview(team, path);
  return URL.createObjectURL(new Blob([bytes]));
}

/** A small copy of the picture, made once in a while: a screen may show many. */
function thumb(team: string, path: string): Promise<string | null> {
  const key = `${team}|${path.replace(/\//g, "\\").toLowerCase()}`;
  const got = thumbs.get(key);
  if (got && performance.now() - got.at < FRESH_MS) return got.url;
  const url = (async () => {
    if (!IS_TAURI) return import.meta.env.DEV ? demoPicture(path) : null;
    try {
      const bytes = await Bridge.teamPreview(team, path);
      const bitmap = await createImageBitmap(new Blob([bytes]));
      const scale = Math.min(1, THUMB_PX / bitmap.width);
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      const small = await new Promise<Blob | null>((done) => canvas.toBlob(done, "image/webp", 0.85));
      return small ? URL.createObjectURL(small) : null;
    } catch {
      // Outside the work folder, too large, gone, or not a picture after all.
      return null;
    }
  })();
  thumbs.set(key, { at: performance.now(), url });
  return url;
}

/**
 * A row of thumbnails for `paths`, each opening the picture large. Pictures
 * that cannot be shown drop out; a row left empty hides itself.
 */
export function thumbRow(team: string, paths: string[]): HTMLElement | null {
  const list = paths.filter(isImage);
  if (!list.length) return null;
  const row = h("div", { class: "pics" });
  const gone = (el: HTMLElement) => {
    el.remove();
    if (!row.querySelector(".pic")) row.remove();
  };
  list.forEach((path, i) => {
    const img = h("img", { alt: fileName(path), draggable: "false" }) as HTMLImageElement;
    const tile = h(
      "button",
      {
        type: "button",
        class: "pic loading",
        "data-pic": norm(path),
        title: trf("{name} · 按一下放大", "{name} · click to enlarge", { name: fileName(path) }),
        onClick: (e: Event) => {
          e.stopPropagation();
          openImage(team, list, i);
        },
      },
      img,
      h("span", { class: "pic-name", text: fileName(path) }),
    );
    row.append(tile);
    void thumb(team, path).then((url) => {
      if (!url) return gone(tile);
      img.src = url;
      tile.classList.remove("loading");
    });
  });
  return row;
}

/** Just the small picture, for a button of its own (a deliverable); it leaves if it cannot be shown. */
export function thumbImg(team: string, path: string, className = "thumb-img"): HTMLImageElement {
  const img = h("img", { class: `${className} loading`, alt: "", draggable: "false" }) as HTMLImageElement;
  void thumb(team, path).then((url) => {
    if (!url) return img.remove();
    img.src = url;
    img.classList.remove("loading");
  });
  return img;
}

/** Thumbnails for the pictures a text names; null when it names none. */
export function thumbsFor(team: string, ...texts: (string | undefined | null)[]): HTMLElement | null {
  return thumbRow(team, imagePaths(texts.filter(Boolean).join("\n")));
}

// ── Large ─────────────────────────────────────────────────────────────────────

let viewer: { close: () => void } | null = null;

/**
 * Shows a picture over the window: `list` and `at` let ← and → go through the
 * others it came with. Esc, ✕ or a click beside it closes it.
 */
export function openImage(team: string, list: string | string[], at = 0) {
  const paths = (Array.isArray(list) ? list : [list]).filter(isImage);
  if (!paths.length) return;
  viewer?.close();
  let i = Math.max(0, Math.min(at, paths.length - 1));
  let url: string | null = null;

  const img = h("img", { class: "lightbox-img", alt: "", draggable: "false" }) as HTMLImageElement;
  const name = h("b", { class: "lightbox-name" });
  const where = h("span", { class: "lightbox-path" });
  const count = h("span", { class: "lightbox-count" });
  const problem = h("p", { class: "lightbox-problem" });
  const prev = h("button", { type: "button", class: "lightbox-nav prev", "aria-label": tr("上一張", "Previous"), onClick: (e: Event) => (e.stopPropagation(), show(i - 1)) }, "‹");
  const next = h("button", { type: "button", class: "lightbox-nav next", "aria-label": tr("下一張", "Next"), onClick: (e: Event) => (e.stopPropagation(), show(i + 1)) }, "›");

  const show = (n: number) => {
    i = (n + paths.length) % paths.length;
    const path = paths[i];
    name.textContent = fileName(path);
    where.textContent = path;
    count.textContent = paths.length > 1 ? `${i + 1} / ${paths.length}` : "";
    prev.hidden = next.hidden = paths.length < 2;
    problem.textContent = "";
    img.classList.add("loading");
    const asked = i;
    full(team, path).then(
      (got) => {
        if (asked !== i) return URL.revokeObjectURL(got);
        if (url?.startsWith("blob:")) URL.revokeObjectURL(url);
        url = got;
        img.src = got;
        img.classList.remove("loading");
      },
      (err) => {
        if (asked !== i) return;
        img.removeAttribute("src");
        problem.textContent = trf("看不到這張圖:{why}", "Can't show this picture: {why}", { why: String(err instanceof Error ? err.message : err).replace(/^Error:\s*/, "") });
      },
    );
  };

  const act = (what: () => Promise<unknown>) => (e: Event) => {
    e.stopPropagation();
    what().catch((err) => (problem.textContent = String(err instanceof Error ? err.message : err).replace(/^Error:\s*/, "")));
  };
  const box = h(
    "div",
    { class: "lightbox", role: "dialog", "aria-modal": "true", "aria-label": tr("圖片", "Picture"), onClick: () => close() },
    h("div", { class: "lightbox-stage" }, prev, img, next),
    h(
      "div",
      { class: "lightbox-bar", onClick: (e: Event) => e.stopPropagation() },
      h("div", { class: "lightbox-title" }, name, count, where),
      problem,
      h(
        "div",
        { class: "lightbox-actions" },
        h("button", { type: "button", class: "btn plain", title: tr("用 Windows 預設的看圖程式開啟", "Open in the Windows default image viewer"), onClick: act(() => (IS_TAURI ? Bridge.teamOpenImage(team, paths[i]) : Promise.resolve())) }, tr("用預設程式開啟", "Open in default app")),
        h("button", { type: "button", class: "btn plain", title: tr("在檔案總管中選取這個檔案", "Select this file in File Explorer"), onClick: act(() => (IS_TAURI ? Bridge.teamOpen(team, paths[i]) : Promise.resolve())) }, tr("在檔案總管中顯示", "Show in File Explorer")),
        h("button", { type: "button", class: "btn plain", "aria-label": tr("關閉", "Close"), onClick: () => close() }, tr("關閉", "Close")),
      ),
    ),
  );
  img.addEventListener("click", (e) => e.stopPropagation());

  const keys = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
    else if (e.key === "ArrowLeft" && paths.length > 1) show(i - 1);
    else if (e.key === "ArrowRight" && paths.length > 1) show(i + 1);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  function close() {
    document.removeEventListener("keydown", keys, true);
    box.remove();
    if (url?.startsWith("blob:")) URL.revokeObjectURL(url);
    viewer = null;
  }
  document.addEventListener("keydown", keys, true);
  document.body.append(box);
  viewer = { close };
  show(i);
}
