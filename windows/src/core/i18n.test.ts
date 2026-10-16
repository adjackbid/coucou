// Every piece of text the person sees comes in both languages. This test reads
// the sources and fails on a Chinese string that is not one half of a
// tr()/trf() pair, on an English label written straight into the page, on a
// pair left with "TODO" in it, and on numbers or dates formatted in a fixed
// locale instead of the one in use.

import { describe, expect, it } from "vitest";
import { fill, setLang, tr, trf } from "./i18n";


/**
 * Folders and files not moved to tr() yet. Each one leaves this list as it is
 * done. VITE_I18N_ALL=1 checks them anyway, to see what is left.
 */
const PENDING: string[] = import.meta.env.VITE_I18N_ALL ? [] : [];

/** Files whose strings are data, not interface text. */
const SKIP = new Set(["core/i18n.ts"]);

/** English that is the same in both languages. */
const SAME_IN_BOTH = new Set([
  "Agent Center", "Mochi", "Claude", "Claude Code", "Copilot CLI", "Copilot", "Antigravity", "Codex", "Gemini CLI",
  "GitHub", "Vercel", "Stripe", "n8n", "Resend", "Notion", "Cal.com", "Teamwork", "Agents", "Relay",
  "OpenAI", "OpenRouter", "Ollama", "LM Studio", "Azure OpenAI", "Node.js", "Git", "PowerShell", "WinGet", "npm",
  "ACP", "API", "MCP", "VS Code", "English", "中文", "Leader", "EN", "Agent", "Token", "PDF",
]);

type Tok = { t: "str" | "id" | "p"; v: string; line: number };

/** A small TypeScript tokenizer: strings (template parts included), identifiers, punctuation. */
function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  let line = 1;
  const regexAfter = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^", "return", "typeof", "case", "=>", ""]);
  const last = () => {
    const tk = out[out.length - 1];
    return tk ? (tk.t === "str" ? "x" : tk.v) : "";
  };
  function readTemplate(): void {
    // At the opening backtick.
    i++;
    let buf = "";
    const start = line;
    while (i < src.length && src[i] !== "`") {
      if (src[i] === "\\") { buf += src.slice(i, i + 2); i += 2; continue; }
      if (src[i] === "$" && src[i + 1] === "{") {
        out.push({ t: "str", v: buf, line: start });
        buf = "";
        i += 2;
        let depth = 1;
        const inner = i;
        while (i < src.length && depth > 0) {
          const c = src[i];
          if (c === "`") { const end = skipTemplate(i); i = end; continue; }
          if (c === '"' || c === "'") { i = skipString(i); continue; }
          if (c === "{") depth++;
          else if (c === "}") depth--;
          if (c === "\n") line++;
          i++;
        }
        const expr = src.slice(inner, i - 1);
        for (const tk of tokenize(expr)) out.push({ ...tk, line: tk.line + start - 1 });
        out.push({ t: "p", v: "${}", line });
        continue;
      }
      if (src[i] === "\n") line++;
      buf += src[i++];
    }
    i++;
    out.push({ t: "str", v: buf, line: start });
  }
  function skipString(at: number): number {
    const q = src[at];
    let j = at + 1;
    while (j < src.length && src[j] !== q) j += src[j] === "\\" ? 2 : 1;
    return j + 1;
  }
  function skipTemplate(at: number): number {
    let j = at + 1;
    let depth = 0;
    while (j < src.length) {
      const c = src[j];
      if (c === "\\") { j += 2; continue; }
      if (depth === 0 && c === "`") return j + 1;
      if (c === "$" && src[j + 1] === "{") { depth++; j += 2; continue; }
      if (depth > 0 && c === "}") depth--;
      j++;
    }
    return j;
  }
  while (i < src.length) {
    const c = src[i];
    if (c === "\n") { line++; i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const body = src.slice(i, end < 0 ? src.length : end + 2);
      line += body.split("\n").length - 1;
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const end = skipString(i);
      out.push({ t: "str", v: src.slice(i + 1, end - 1), line });
      i = end;
      continue;
    }
    if (c === "`") { readTemplate(); continue; }
    if (c === "/" && regexAfter.has(last())) {
      // A regular expression literal.
      let j = i + 1;
      let cls = false;
      while (j < src.length && src[j] !== "\n") {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === "[") cls = true;
        else if (src[j] === "]") cls = false;
        else if (src[j] === "/" && !cls) break;
        j++;
      }
      i = j + 1;
      while (/[a-z]/.test(src[i] ?? "")) i++;
      out.push({ t: "p", v: "regex", line });
      continue;
    }
    const id = /^[A-Za-z_$][\w$]*/.exec(src.slice(i, i + 64));
    if (id) { out.push({ t: "id", v: id[0], line }); i += id[0].length; continue; }
    const arrow = src.slice(i, i + 2) === "=>";
    out.push({ t: "p", v: arrow ? "=>" : c, line });
    i += arrow ? 2 : 1;
  }
  return out;
}

const CJK = /[㐀-鿿豈-﫿　-〿＀-￯]/;

/** Indexes of the string tokens that are one half of a tr()/trf() pair, and the pairs. */
function covered(toks: Tok[]): { cov: Set<number>; pairs: [Tok, Tok][] } {
  const cov = new Set<number>();
  const pairs: [Tok, Tok][] = [];
  for (let i = 0; i < toks.length; i++) {
    const tk = toks[i];
    if (tk.t !== "id" || (tk.v !== "tr" && tk.v !== "trf") || toks[i + 1]?.v !== "(") continue;
    if (toks[i - 1]?.v === "." || toks[i - 1]?.v === "function") continue;
    // First argument: a string (or template parts) up to the comma at depth 0.
    const args: number[][] = [[]];
    let depth = 0;
    for (let j = i + 2; j < toks.length; j++) {
      const t = toks[j];
      if (t.v === "(" || t.v === "[" || t.v === "{") depth++;
      if (t.v === ")" || t.v === "]" || t.v === "}") {
        if (depth === 0) break;
        depth--;
      }
      if (depth === 0 && t.v === ",") { if (args.length === 2) break; args.push([]); continue; }
      if (t.t === "str") args[args.length - 1].push(j);
    }
    for (const a of args.slice(0, 2)) for (const j of a) cov.add(j);
    if (args.length >= 2 && args[0].length && args[1].length) pairs.push([toks[args[0][0]], toks[args[1][0]]]);
  }
  return { cov, pairs };
}

/** String tokens passed as children to h(tag, attrs, ...children): text drawn as is. */
function hChildren(toks: Tok[]): Set<number> {
  const out = new Set<number>();
  for (let i = 0; i < toks.length; i++) {
    if (toks[i].t !== "id" || toks[i].v !== "h" || toks[i + 1]?.v !== "(" || toks[i - 1]?.v === ".") continue;
    let depth = 0;
    let arg = 0;
    for (let j = i + 2; j < toks.length; j++) {
      const t = toks[j];
      if (t.v === "(" || t.v === "[" || t.v === "{") depth++;
      if (t.v === ")" || t.v === "]" || t.v === "}") {
        if (depth === 0) break;
        depth--;
      }
      if (depth === 0 && t.v === ",") { arg++; continue; }
      // A bare string child: the token right after the comma, followed by , or ).
      if (arg >= 2 && depth === 0 && t.t === "str" && toks[j - 1]?.v === "," && (toks[j + 1]?.v === "," || toks[j + 1]?.v === ")")) out.add(j);
    }
  }
  return out;
}

/** Words that look like English but are keys, events or protocol names, not text. */
const TECHNICAL = new Set([
  "Enter", "Escape", "Tab", "Backspace", "Delete", "Shift", "Control", "Alt", "Meta", "Home", "End", "Space",
  "Error", "Bearer", "Authorization",
]);

/** Placeholders and values that are code, not words: URLs, flags, ids, key shapes, shortcuts. */
function isTechnical(v: string): boolean {
  return (
    /^https?:\/\//.test(v) ||
    /^--/.test(v) ||
    /^[a-z0-9_.-]+(…)?$/.test(v) ||          // copilot, id, sk_live_…, re_…
    /[=\\]|\{\w+\}/.test(v) ||             // KEY=VALUE, paths, {secret}
    /^[A-Z][a-z]*(\+[A-Za-z0-9]+)+$/.test(v)   // Ctrl+Shift+Space
  );
}

/** Text that reads as English words: "Ask", "Open terminal", "Finished.". */
function looksLikeEnglish(v: string): boolean {
  if (/^[A-Z][a-z]+$/.test(v)) return true;                 // one capitalised word
  if (/^[A-Z][a-z']*( [A-Za-z'][a-z']*)+[.…!?:]?$/.test(v)) return true; // a short phrase
  if (/[a-z]{2,} [a-z]{2,} [a-z]{2,}/.test(v) && /[A-Za-z]/.test(v[0] ?? "") && !/[{}<>=;/\\]/.test(v)) return true; // a sentence
  return false;
}

/** An import path, an object key (`"key": …`), or one side of `===` / `!==` — never shown. */
function isImportOrKeyOrComparison(toks: Tok[], i: number): boolean {
  const p1 = toks[i - 1]?.v;
  const p2 = toks[i - 2]?.v;
  const n1 = toks[i + 1]?.v;
  const n2 = toks[i + 2]?.v;
  if (p1 === "from" || p1 === "import") return true;
  if (n1 === ":" && (p1 === "{" || p1 === ",")) return true;
  if (p1 === "=" && (p2 === "=" || p2 === "!")) return true;
  if ((n1 === "=" || n1 === "!") && n2 === "=") return true;
  if (p1 === "case") return true;
  return false;
}

/**
 * Strings that end up on screen however they look: the value of a text,
 * title, placeholder or aria-label key; what is assigned to textContent,
 * title or placeholder; and the direct children of h().
 */
function labelContexts(toks: Tok[]): Set<number> {
  const out = new Set<number>();
  const KEYS = new Set(["text", "title", "placeholder", "aria-label", "label"]);
  const PROPS = new Set(["textContent", "title", "placeholder", "innerText"]);
  /** Marks the strings of the expression starting at `from`, up to , ; ) ] } at its own depth. */
  const expr = (from: number) => {
    let depth = 0;
    for (let j = from; j < toks.length; j++) {
      const t = toks[j];
      if (t.v === "(" || t.v === "[" || t.v === "{") depth++;
      else if (t.v === ")" || t.v === "]" || t.v === "}") {
        if (depth === 0) return;
        depth--;
      } else if (depth === 0 && (t.v === "," || t.v === ";")) return;
      // A nested call's own arguments are its business, except ternaries and ?? fallbacks.
      if (t.t === "str" && depth === 0) out.add(j);
    }
  };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if ((t.t === "id" || t.t === "str") && KEYS.has(t.v) && toks[i + 1]?.v === ":") expr(i + 2);
    if (t.t === "id" && PROPS.has(t.v) && toks[i - 1]?.v === "." && toks[i + 1]?.v === "=" && toks[i + 2]?.v !== "=") expr(i + 2);
  }
  for (const j of hChildren(toks)) out.add(j);
  return out;
}

/** Every source file under src/, as text, keyed by its path from src/ ("views/views.ts"). */
const RAW = import.meta.glob(["../**/*.ts", "!../**/*.test.ts", "!../**/*.d.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const sources = Object.entries(RAW)
  .map(([p, text]) => ({ path: p.startsWith("./") ? `core/${p.slice(2)}` : p.replace(/^\.\.\//, ""), text }))
  .filter((f) => !SKIP.has(f.path) && !PENDING.some((x) => f.path === x || f.path.startsWith(x)));

describe("i18n helpers", () => {
  it("picks the half for the language in use and fills values", () => {
    setLang("zh-TW");
    expect(tr("連結", "Connect")).toBe("連結");
    expect(trf("已連結 {n} 個", "{n} connected", { n: 2 })).toBe("已連結 2 個");
    setLang("en");
    expect(tr("連結", "Connect")).toBe("Connect");
    expect(trf("已連結 {n} 個", "{n} connected", { n: 2 })).toBe("2 connected");
    expect(fill("{a} and {b}", { a: 1 })).toBe("1 and {b}");
  });
});

describe("every interface string comes in both languages", () => {
  it("has no Chinese outside tr()", () => {
    const found: string[] = [];
    for (const f of sources) {
      const toks = tokenize(f.text);
      const { cov } = covered(toks);
      const lines = f.text.split("\n");
      toks.forEach((tk, i) => {
        if (/i18n-ok/.test(lines[tk.line - 1] ?? "")) return;
        if (tk.t === "str" && CJK.test(tk.v) && !cov.has(i) && !SAME_IN_BOTH.has(tk.v.trim())) {
          found.push(`${f.path}:${tk.line} ${JSON.stringify(tk.v.slice(0, 50))}`);
        }
      });
    }
    expect(found).toEqual([]);
  });

  it("has no English label written straight into the page", () => {
    const found: string[] = [];
    for (const f of sources) {
      const toks = tokenize(f.text);
      const { cov } = covered(toks);
      const ctx = labelContexts(toks);
      const lines = f.text.split("\n");
      toks.forEach((tk, i) => {
        if (tk.t !== "str" || cov.has(i) || !/[A-Za-z]{2}/.test(tk.v)) return;
        const v = tk.v.trim();
        if (SAME_IN_BOTH.has(v) || TECHNICAL.has(v) || CJK.test(v) || isTechnical(v)) return;
        if (/i18n-ok/.test(lines[tk.line - 1] ?? "")) return;
        if (isImportOrKeyOrComparison(toks, i)) return;
        if (ctx.has(i) || looksLikeEnglish(v)) found.push(`${f.path}:${tk.line} ${JSON.stringify(v.slice(0, 50))}`);
      });
    }
    expect(found).toEqual([]);
  });

  it("has no pair left half done", () => {
    const found: string[] = [];
    for (const f of sources) {
      for (const [zh, en] of covered(tokenize(f.text)).pairs) {
        if (/\bTODO\b/.test(zh.v) || /\bTODO\b/.test(en.v)) found.push(`${f.path}:${zh.line}`);
      }
    }
    expect(found).toEqual([]);
  });

  it("formats numbers and dates in the language in use", () => {
    const found: string[] = [];
    for (const f of sources) {
      f.text.split("\n").forEach((l, n) => {
        if (/["']en-US["']|toLocale\w*\(\s*undefined/.test(l)) found.push(`${f.path}:${n + 1}`);
      });
    }
    expect(found).toEqual([]);
  });
});
