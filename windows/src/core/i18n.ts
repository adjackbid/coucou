// The language the app speaks: Traditional Chinese or English.
//
// Text is written as a pair where it is used — tr("連結…", "Connect…"), the
// Chinese first — and picked when it is drawn. Rust decides the language
// (settings.language, or the Windows display language when it is "system")
// and tells every window at boot and with `lang-changed`; a window then sets
// it here and draws itself again.
//
// Product names, model ids, paths, commands, what the person typed and what an
// agent wrote are never translated. Neither is text meant for a model.

export type Lang = "zh-TW" | "en";

let current: Lang = guess();
const listeners = new Set<(l: Lang) => void>();

/**
 * Before Rust has said: `?lang=` on the page's address, else the browser's
 * language (a plain-browser preview has nothing else).
 */
function guess(): Lang {
  const asked = typeof location !== "undefined" ? new URLSearchParams(location.search).get("lang") : null;
  if (asked === "zh-TW" || asked === "en") return asked;
  const nav = typeof navigator !== "undefined" ? navigator.language : "";
  return /^zh/i.test(nav) ? "zh-TW" : "en";
}

export function lang(): Lang {
  return current;
}

export function isZh(): boolean {
  return current === "zh-TW";
}

/** Sets the language; listeners run only when it changed. */
export function setLang(next: string | null | undefined): void {
  const l: Lang = next === "zh-TW" ? "zh-TW" : next === "en" ? "en" : current;
  if (typeof document !== "undefined") document.documentElement.lang = l;
  if (l === current) return;
  current = l;
  for (const fn of listeners) fn(l);
}

/** Runs `fn` after every language change; returns the unsubscribe. */
export function onLangChange(fn: (l: Lang) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The Chinese text first, then the English. */
export function tr(zh: string, en: string): string {
  return current === "zh-TW" ? zh : en;
}

/**
 * The same with values: trf("已連結 {n} 個", "{n} connected", { n }).
 * A `{name}` without a value is left as it is.
 */
export function trf(zh: string, en: string, vars: Record<string, string | number>): string {
  return fill(tr(zh, en), vars);
}

export function fill(text: string, vars: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** A number in the language in use (thousands separators and all). */
export function num(v: number, opts?: Intl.NumberFormatOptions): string {
  return v.toLocaleString(current, opts);
}

export function date(d: Date, opts?: Intl.DateTimeFormatOptions): string {
  return d.toLocaleDateString(current, opts);
}

export function time(d: Date, opts?: Intl.DateTimeFormatOptions): string {
  return d.toLocaleTimeString(current, opts);
}

export function dateTime(d: Date, opts?: Intl.DateTimeFormatOptions): string {
  return d.toLocaleString(current, opts);
}
