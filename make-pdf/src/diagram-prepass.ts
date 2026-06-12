/**
 * Diagram + image pre-pass. Runs between "read markdown" and render() in the
 * orchestrator, and owns everything that needs the diagram-render bundle.
 *
 *   markdown ─▶ extractDiagramFences() ──▶ render() (marked+sanitize+smarty)
 *        │        fences → placeholder tokens        │
 *        │                                           ▼
 *        └─▶ renderFenceSlots() ───────────▶ substituteSlots(html, slots)
 *             one browse render tab/run              │
 *             error ⇒ diagnostic block + page reload ▼
 *                                          inlineLocalImages(html)
 *                                            data URIs, probe dims from bytes,
 *                                            downscale >2x content box @300dpi,
 *                                            remote warn / missing placeholder /
 *                                            --strict hard-fail
 *
 * Placeholders survive marked, the sanitizer, and smartypants because they are
 * plain hyphenated lowercase tokens with no quotes or HTML. Slot HTML is run
 * through the same sanitizer as user content before substitution (the bundle
 * renders with securityLevel strict — the sanitizer is the second layer).
 *
 * Reset contract (eng-review D6.2): each fence renders with a fresh
 * mermaid.render id; after ANY render error the bundle page is reloaded before
 * the next fence so a poisoned global can't corrupt diagram N+1.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

import * as browseClient from "./browseClient";
import { sanitizeUntrustedHtml } from "./render";
import { imageDims } from "./image-size";

// ─── Types ────────────────────────────────────────────────────────────

export interface DiagramFence {
  /** "mermaid" | "excalidraw" */
  lang: string;
  /** Fence body (the diagram source). */
  source: string;
  /** Optional title="..." from the fence info string (a11y label, D6.4). */
  title?: string;
  /** Optional page=landscape|portrait fence directive (image-policy override). */
  page?: "landscape" | "portrait";
  /** render=false → leave as a plain code block (escape hatch, D6.3). */
  render: boolean;
  /** Placeholder token substituted into the markdown. */
  token: string;
  /** 1-based ordinal among rendered fences (unique ids, aria fallback). */
  ordinal: number;
}

export interface FenceExtraction {
  markdown: string;
  fences: DiagramFence[];
}

export interface PrepassWarnings {
  warn: (msg: string) => void;
}

export interface PrepassImageOptions {
  /** Directory of the source markdown — relative image paths resolve here. */
  inputDir: string;
  /** Hard-fail on missing/remote images instead of warn (D6.1). */
  strict: boolean;
  /** Remote images are left untouched when network is explicitly allowed. */
  allowNetwork: boolean;
  /** Physical content-box width in inches (page width minus margins). */
  contentWidthIn: number;
  warn: (msg: string) => void;
  /** Lazily provides a ready bundle tab (only opened when needed). */
  getTab: () => RenderTab | null;
}

/** Print-resolution policy (eng-review D4): downscale rasters wider than
 * 2 × contentWidth × 300dpi down to contentWidth × 300dpi. */
const PRINT_DPI = 300;
const DOWNSCALE_FACTOR = 2;

export class StrictModeError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "StrictModeError";
  }
}

// ─── Fence extraction (pure) ──────────────────────────────────────────

const DIAGRAM_LANGS = new Set(["mermaid", "excalidraw"]);

/**
 * Extract top-level ```mermaid / ```excalidraw fences, replacing each with a
 * unique placeholder token paragraph. Backtick and tilde fences, any length
 * >= 3; closers must be at least as long as the opener (CommonMark). Fences
 * with `render=false` in the info string are left untouched.
 */
export function extractDiagramFences(markdown: string): FenceExtraction {
  const lines = markdown.split("\n");
  const out: string[] = [];
  const fences: DiagramFence[] = [];
  const runId = crypto.randomBytes(4).toString("hex");

  let i = 0;
  let openFence: { char: string; len: number; info: string; body: string[] } | null = null;
  let ordinal = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (openFence) {
      const close = matchFenceLine(line);
      if (close && close.char === openFence.char && close.len >= openFence.len && close.info === "") {
        const info = parseInfoString(openFence.info);
        if (DIAGRAM_LANGS.has(info.lang) && info.render) {
          ordinal++;
          const token = `gstack-diagram-slot-${runId}-${ordinal}`;
          fences.push({
            lang: info.lang,
            source: openFence.body.join("\n"),
            title: info.title,
            page: info.page,
            render: true,
            token,
            ordinal,
          });
          out.push("", token, "");
        } else {
          // Not a diagram fence (or render=false): replay verbatim, but strip
          // the render=false flag so it never leaks into highlighted output.
          const infoOut = info.render ? openFence.info : info.lang;
          out.push(`${openFence.char.repeat(openFence.len)}${infoOut}`);
          out.push(...openFence.body);
          out.push(line);
        }
        openFence = null;
        i++;
        continue;
      }
      openFence.body.push(line);
      i++;
      continue;
    }

    const open = matchFenceLine(line);
    if (open && open.info !== "") {
      openFence = { char: open.char, len: open.len, info: open.info, body: [] };
      i++;
      continue;
    }
    if (open) {
      // Anonymous fence (plain code block) — copy through to its closer so a
      // ```mermaid example INSIDE a plain fence is never extracted.
      out.push(line);
      i++;
      while (i < lines.length) {
        const l = lines[i];
        const close = matchFenceLine(l);
        out.push(l);
        i++;
        if (close && close.char === open.char && close.len >= open.len && close.info === "") break;
      }
      continue;
    }

    out.push(line);
    i++;
  }

  // Unclosed fence at EOF: replay verbatim (CommonMark treats it as code to EOF).
  if (openFence) {
    out.push(`${openFence.char.repeat(openFence.len)}${openFence.info}`);
    out.push(...openFence.body);
  }

  return { markdown: out.join("\n"), fences };
}

function matchFenceLine(line: string): { char: string; len: number; info: string } | null {
  const m = line.match(/^ {0,3}(`{3,}|~{3,})\s*(.*)$/);
  if (!m) return null;
  return { char: m[1][0], len: m[1].length, info: m[2].trim() };
}

/** Parse a fence info string: `mermaid`, `mermaid render=false`,
 *  `mermaid title="Auth flow"`, `mermaid page=landscape`. */
export function parseInfoString(info: string): {
  lang: string; render: boolean; title?: string; page?: "landscape" | "portrait";
} {
  const lang = (info.match(/^\S+/)?.[0] ?? "").toLowerCase();
  const render = !/\brender\s*=\s*false\b/i.test(info);
  const title = info.match(/\btitle\s*=\s*"([^"]*)"/i)?.[1]
    ?? info.match(/\btitle\s*=\s*'([^']*)'/i)?.[1];
  const pageRaw = info.match(/\bpage\s*=\s*(landscape|portrait)\b/i)?.[1]?.toLowerCase();
  const page = pageRaw === "landscape" || pageRaw === "portrait" ? pageRaw : undefined;
  return { lang, render, title, page };
}

// ─── Slot substitution (pure) ─────────────────────────────────────────

/**
 * Replace placeholder tokens in rendered HTML with their final slot HTML.
 * marked wraps the bare token line in <p>…</p>; replace the wrapper too so
 * the figure isn't nested inside a paragraph.
 */
export function substituteSlots(html: string, slots: Map<string, string>): string {
  let s = html;
  for (const [token, slotHtml] of slots) {
    const wrapped = new RegExp(`<p>\\s*${token}\\s*</p>`, "g");
    if (wrapped.test(s)) {
      s = s.replace(new RegExp(`<p>\\s*${token}\\s*</p>`, "g"), slotHtml);
    } else {
      s = s.split(token).join(slotHtml);
    }
  }
  return s;
}

/**
 * Visible diagnostic block for a failed fence render — never silent raw code
 * (eng-review: explicit error blocks). Sanitizer-safe: all dynamic content is
 * HTML-escaped.
 */
export function buildDiagnosticBlock(fence: DiagramFence, errorMessage: string): string {
  const excerpt = fence.source.split("\n").slice(0, 8).join("\n");
  const truncated = fence.source.split("\n").length > 8 ? "\n…" : "";
  return [
    `<figure class="diagram diagram-error" role="img" aria-label="${escapeAttr(diagramLabel(fence))} (failed to render)">`,
    `<figcaption class="diagram-error-title">Diagram failed to render (${escapeHtml(fence.lang)})</figcaption>`,
    `<pre class="diagram-error-detail">${escapeHtml(errorMessage.trim())}\n\n${escapeHtml(excerpt + truncated)}</pre>`,
    `</figure>`,
  ].join("\n");
}

/** Wrap a rendered SVG in an accessible figure (D6.4). */
export function buildDiagramFigure(fence: DiagramFence, svg: string): string {
  const label = diagramLabel(fence);
  const cleanSvg = sanitizeUntrustedHtml(svg);
  const captioned = fence.title
    ? `\n<figcaption class="diagram-caption">${escapeHtml(fence.title)}</figcaption>`
    : "";
  const pageAttr = fence.page ? ` data-gstack-page="${fence.page}"` : "";
  return [
    `<figure class="diagram" role="img" aria-label="${escapeAttr(label)}"${pageAttr}>`,
    `<!-- gstack-diagram-source lang=${escapeAttr(fence.lang)}`,
    escapeHtmlComment(fence.source),
    `-->`,
    cleanSvg,
    captioned,
    `</figure>`,
  ].join("\n");
}

function diagramLabel(fence: DiagramFence): string {
  return fence.title ?? `diagram ${fence.ordinal}`;
}

// ─── Render tab (bundle page lifecycle) ───────────────────────────────

const PAYLOAD_TMP_DIR = process.platform === "win32" ? os.tmpdir() : "/tmp";
const READY_TIMEOUT_MS = 20_000;

export class RenderTab {
  private constructor(
    public readonly tabId: number,
    private readonly stagedBundlePath: string,
  ) {}

  /**
   * Open a tab and load the diagram-render bundle. The bundle HTML is staged
   * under /tmp (content-addressed, reused across runs — load-html only reads
   * inside its safe dirs) and loaded by PATH, not --from-file: a 9MB JSON
   * round-trip per run would be pure waste.
   */
  static open(): RenderTab {
    const bundleSrc = resolveBundlePath();
    const html = fs.readFileSync(bundleSrc);
    const sha = crypto.createHash("sha256").update(html).digest("hex").slice(0, 16);
    const staged = path.join(PAYLOAD_TMP_DIR, `gstack-diagram-render-${sha}.html`);
    if (!fs.existsSync(staged)) {
      // Concurrent-safe: write to a unique temp name, then atomic rename.
      const tmp = `${staged}.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
      fs.writeFileSync(tmp, html);
      try {
        fs.renameSync(tmp, staged);
      } catch {
        fs.unlinkSync(tmp); // another process won the race — theirs is identical
      }
    }
    const tabId = browseClient.newtab();
    const tab = new RenderTab(tabId, staged);
    tab.loadBundle();
    return tab;
  }

  /** (Re)load the bundle page — also the reset path after a render error. */
  loadBundle(): void {
    browseClient.loadHtmlFile({ file: this.stagedBundlePath, tabId: this.tabId });
    const ready = browseClient.waitForExpression({
      expression: "document.getElementById('status') !== null && document.getElementById('status').textContent === 'ready'",
      tabId: this.tabId,
      timeoutMs: READY_TIMEOUT_MS,
    });
    if (!ready) {
      throw new Error(
        "diagram-render bundle did not become ready in the browse tab " +
        `(${READY_TIMEOUT_MS}ms). Check \`browse js "window.__errors"\` on tab ${this.tabId}.`,
      );
    }
  }

  /**
   * Call one of the bundle's async window functions with JSON-safe string
   * args. Errors come back as a recognizable ERR: prefix so a render failure
   * is data, not a thrown browse exit.
   */
  call(fn: string, ...args: Array<string | number>): string {
    const argList = args.map((a) => JSON.stringify(a)).join(",");
    const expression =
      `window.${fn}(${argList})` +
      `.then(r => "OK:" + r)` +
      `.catch(e => "ERR:" + String((e && e.message) || e))`;
    const result = this.js(expression);
    if (result.startsWith("OK:")) return result.slice(3);
    if (result.startsWith("ERR:")) throw new RenderCallError(result.slice(4));
    throw new RenderCallError(`unexpected bundle result: ${result.slice(0, 200)}`);
  }

  private js(expression: string): string {
    // Large payloads (scene JSON, SVG text, data URIs) blow past argv limits —
    // browseClient.js shells out with the expression as an argv element, so
    // stage anything big through a tmp file the page can fetch? No: file URLs
    // are unreachable from the page. Instead, chunk through a window buffer.
    if (expression.length <= 100_000) {
      return browseClient.js({ expression, tabId: this.tabId });
    }
    return this.jsViaBuffer(expression);
  }

  /**
   * argv-safe path for big expressions: ship the expression into the page in
   * 64KB chunks (window.__exprBuf), then eval it there. Used for multi-MB
   * data URIs (photo downscaling) where a single argv would exceed OS limits.
   */
  private jsViaBuffer(expression: string): string {
    browseClient.js({ expression: "window.__exprBuf = ''", tabId: this.tabId });
    const CHUNK = 64_000;
    for (let i = 0; i < expression.length; i += CHUNK) {
      const chunk = expression.slice(i, i + CHUNK);
      browseClient.js({
        expression: `window.__exprBuf += ${JSON.stringify(chunk)}, window.__exprBuf.length`,
        tabId: this.tabId,
      });
    }
    // Eval the buffer as a single expression so the resulting promise is the
    // statement value browse awaits. The buffer resets at the next call.
    return browseClient.js({
      expression: `(0, eval)(window.__exprBuf)`,
      tabId: this.tabId,
    });
  }

  close(): void {
    try {
      browseClient.closetab(this.tabId);
    } catch {
      // best-effort: orchestrator finally path
    }
  }
}

export class RenderCallError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "RenderCallError";
  }
}

/** Resolve dist/diagram-render.html: env override → repo-relative (dev) → global install. */
export function resolveBundlePath(env: NodeJS.ProcessEnv = process.env): string {
  const candidates = [
    env.GSTACK_DIAGRAM_BUNDLE,
    // dev: make-pdf/src/* → repo root lib/. (In a compiled binary this is the
    // virtual /$bunfs/root and simply never exists — harmless.)
    path.resolve(import.meta.dir, "../../lib/diagram-render/dist/diagram-render.html"),
    // compiled binary at <root>/make-pdf/dist/pdf → <root>/lib/… — same shape
    // in the repo and in the ~/.claude/skills/gstack global install. argv[0]
    // is the literal string "bun" in compiled binaries; execPath is real.
    path.resolve(path.dirname(process.execPath), "../../lib/diagram-render/dist/diagram-render.html"),
    path.join(os.homedir(), ".claude/skills/gstack/lib/diagram-render/dist/diagram-render.html"),
  ].filter((p): p is string => !!p);
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(
    "diagram-render bundle not found. Tried:\n" +
    candidates.map((c) => `  - ${c}`).join("\n") +
    "\nRun `bun run build:diagram-render` (repo) or re-run ./setup (install).",
  );
}

// ─── Fence rendering ──────────────────────────────────────────────────

/**
 * Render every extracted fence to its slot HTML. One bundle tab serves all
 * fences; a failed fence yields a diagnostic block and a bundle reload
 * (reset contract) before the next fence renders.
 */
export function renderFenceSlots(
  fences: DiagramFence[],
  tab: RenderTab,
  warn: (msg: string) => void,
): Map<string, string> {
  const slots = new Map<string, string>();
  for (const fence of fences) {
    try {
      let svg: string;
      if (fence.lang === "mermaid") {
        svg = tab.call("__renderMermaid", `mermaid-fence-${fence.ordinal}`, fence.source);
      } else {
        JSON.parse(fence.source); // fail fast with a JSON diagnostic, not a bundle stack
        svg = tab.call("__excalidrawToSvg", fence.source);
      }
      slots.set(fence.token, buildDiagramFigure(fence, svg));
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      warn(`diagram ${fence.ordinal} (${fence.lang}) failed to render: ${firstLine(msg)}`);
      slots.set(fence.token, buildDiagnosticBlock(fence, msg));
      // Reset contract: a poisoned page must not corrupt the next fence.
      try {
        tab.loadBundle();
      } catch (reloadErr: any) {
        warn(`bundle reload after render error failed: ${firstLine(reloadErr?.message ?? String(reloadErr))}`);
      }
    }
  }
  return slots;
}

// ─── Image inlining (eng-review D1 + D4 + D6.1) ───────────────────────

const IMG_TAG_RE = /<img\b[^>]*>/gi;
const SRC_RE = /\bsrc\s*=\s*("([^"]*)"|'([^']*)')/i;

/**
 * Inline every local <img> as a data URI, probe intrinsic dimensions from the
 * bytes, and annotate the tag with data-gstack-px-width/-height for the width
 * policy. Oversized rasters are downscaled to print resolution via the bundle
 * tab. Missing files become visible placeholders (or throw under --strict);
 * remote URLs warn (offline posture) unless --allow-network.
 */
export function inlineLocalImages(html: string, opts: PrepassImageOptions): string {
  const maxPx = Math.round(opts.contentWidthIn * PRINT_DPI * DOWNSCALE_FACTOR);
  const targetPx = Math.round(opts.contentWidthIn * PRINT_DPI);

  return html.replace(IMG_TAG_RE, (tag) => {
    const srcMatch = tag.match(SRC_RE);
    if (!srcMatch) return tag;
    const src = srcMatch[2] ?? srcMatch[3] ?? "";

    if (src.startsWith("data:")) return annotateFromDataUri(tag, src);

    if (/^[a-z][a-z0-9+.-]*:/i.test(src)) {
      // Absolute URL with a scheme (http, https, file, …)
      if (opts.allowNetwork && /^https?:/i.test(src)) return tag;
      if (/^https?:/i.test(src)) {
        const msg = `remote image not fetched (offline posture): ${src}`;
        if (opts.strict) throw new StrictModeError(msg + " — re-run without --strict or pass --allow-network");
        opts.warn(msg);
        return tag;
      }
      // file:// and friends fall through to the local path branch
      if (!src.startsWith("file:")) return tag;
    }

    const filePath = src.startsWith("file:")
      ? decodeURIComponent(new URL(src).pathname)
      : path.resolve(opts.inputDir, decodeURIComponent(src));

    if (!fs.existsSync(filePath)) {
      const msg = `image not found: ${src} (resolved to ${filePath})`;
      if (opts.strict) throw new StrictModeError(msg);
      opts.warn(msg);
      return buildMissingImagePlaceholder(src);
    }

    let buf = fs.readFileSync(filePath);
    let dims = imageDims(buf);
    let mime = dims?.mime ?? mimeFromExtension(filePath);

    // Print-resolution normalization (D4): rasters only — SVG scales free.
    if (dims && mime !== "image/svg+xml" && dims.width > maxPx) {
      const tab = opts.getTab();
      if (tab) {
        try {
          const dataUri = `data:${mime};base64,${buf.toString("base64")}`;
          const scaled = tab.call("__downscaleRaster", dataUri, targetPx, mime);
          const scaledB64 = scaled.replace(/^data:[^,]*,/, "");
          opts.warn(
            `downscaled ${path.basename(filePath)} ${dims.width}px → ${targetPx}px ` +
            `(print is ${PRINT_DPI}dpi; original exceeds ${maxPx}px content-box ceiling)`,
          );
          buf = Buffer.from(scaledB64, "base64");
          mime = scaled.slice(5, scaled.indexOf(";"));
          dims = { ...dims, height: Math.round((dims.height * targetPx) / dims.width), width: targetPx };
        } catch (err: any) {
          opts.warn(`downscale failed for ${src}, inlining at full size: ${firstLine(err?.message ?? String(err))}`);
        }
      }
    }

    const dataUri = `data:${mime};base64,${buf.toString("base64")}`;
    let newTag = tag.replace(SRC_RE, `src="${dataUri}"`);
    if (dims) {
      newTag = newTag.replace(
        /^<img\b/i,
        `<img data-gstack-px-width="${Math.round(dims.width)}" data-gstack-px-height="${Math.round(dims.height)}"`,
      );
    }
    return newTag;
  });
}

function annotateFromDataUri(tag: string, src: string): string {
  try {
    const b64 = src.slice(src.indexOf(",") + 1);
    const head = Buffer.from(b64.slice(0, 8192), "base64");
    const dims = imageDims(head);
    if (!dims) return tag;
    return tag.replace(
      /^<img\b/i,
      `<img data-gstack-px-width="${Math.round(dims.width)}" data-gstack-px-height="${Math.round(dims.height)}"`,
    );
  } catch {
    return tag;
  }
}

function buildMissingImagePlaceholder(src: string): string {
  return (
    `<span class="image-missing" role="img" aria-label="missing image">` +
    `[missing image: ${escapeHtml(src)}]</span>`
  );
}

function mimeFromExtension(p: string): string {
  switch (path.extname(p).toLowerCase()) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".svg": return "image/svg+xml";
    default: return "application/octet-stream";
  }
}

// ─── Content-box math ─────────────────────────────────────────────────

const PAGE_WIDTHS_IN: Record<string, number> = {
  letter: 8.5,
  a4: 8.27,
  legal: 8.5,
  tabloid: 11,
};

/** Parse a CSS dimension ("1in" | "72pt" | "25mm" | "2.54cm") to inches. */
export function dimToInches(dim: string | undefined, fallbackIn: number): number {
  if (!dim) return fallbackIn;
  const m = dim.trim().match(/^([0-9.]+)\s*(in|pt|cm|mm|px)?$/i);
  if (!m) return fallbackIn;
  const v = parseFloat(m[1]);
  switch ((m[2] ?? "in").toLowerCase()) {
    case "in": return v;
    case "pt": return v / 72;
    case "cm": return v / 2.54;
    case "mm": return v / 25.4;
    case "px": return v / 96;
    default: return fallbackIn;
  }
}

export function contentWidthInches(opts: {
  pageSize?: string;
  margins?: string;
  marginLeft?: string;
  marginRight?: string;
}): number {
  const pageW = PAGE_WIDTHS_IN[opts.pageSize ?? "letter"] ?? 8.5;
  const left = dimToInches(opts.marginLeft ?? opts.margins, 1);
  const right = dimToInches(opts.marginRight ?? opts.margins, 1);
  return Math.max(1, pageW - left - right);
}

// ─── tiny helpers ─────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

/** Comments may not contain `--`; encode it so the raw source survives. */
function escapeHtmlComment(s: string): string {
  return s.replace(/--/g, "-‐");
}

function firstLine(s: string): string {
  return s.split("\n")[0].slice(0, 200);
}
