"use client";

/**
 * Canvas — pure presentational renderer for ViewState.
 *
 * The component is a pure function of (viewState, images, imageBusy).
 * It never fetches, never sets state. All layout logic lives here.
 *
 * Layout routing:
 *   single / focus → one image, fit (canvas-figure / hero-image)
 *   grid           → CSS grid, up to 4 items
 *   compare        → 2-up, aligned, role labels
 *
 * Overlays:
 *   zoom           → CSS transform: scale + transform-origin on the target item
 *   marks          → absolutely-positioned annotation boxes (normalized → %)
 *   caption        → always rendered (.canvas-caption kept in DOM for e2e)
 *   imageBusy      → canvas-badge spinner
 *   pending item   → shimmer tile
 */

import { useEffect, useRef, useState } from "react";
import { ImageIcon } from "lucide-react";
import type { CarImage, CanvasItem, ViewState } from "@vox/core";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a lookup map from CarImage[] keyed by imageId. */
function buildImageMap(images: CarImage[]): Map<string, CarImage> {
  const map = new Map<string, CarImage>();
  for (const img of images) map.set(img.id, img);
  return map;
}

/**
 * Resolve a CanvasItem to a CarImage from the catalog.
 * Returns undefined for generated items without a url or for unknown ids.
 */
function resolveItem(
  item: CanvasItem,
  imageMap: Map<string, CarImage>
): { url: string; alt: string; role: string } | undefined {
  if (item.kind === "image") {
    const img = imageMap.get(item.imageId);
    if (!img) return undefined;
    return { url: img.url, alt: img.caption, role: img.role.replaceAll("_", " ") };
  }
  if (item.kind === "generated") {
    if (item.status === "ready" && item.url) {
      return { url: item.url, alt: item.prompt, role: "generated" };
    }
    return undefined; // pending / failed — caller renders shimmer
  }
  // kind === "car" — no image to resolve
  return undefined;
}

/**
 * Derive CSS transform for zoom.
 * zoom.region = [x, y, w, h] normalized 0..1.
 * We scale so the region fills the container and shift origin to its centre.
 */
function zoomTransform(region: [number, number, number, number]): {
  transform: string;
  transformOrigin: string;
} {
  const [rx, ry, rw, rh] = region;
  // Scale so the region fills the canvas: the smaller dimension drives the scale.
  const scaleX = rw > 0 ? 1 / rw : 1;
  const scaleY = rh > 0 ? 1 / rh : 1;
  const scale = Math.min(scaleX, scaleY);
  // Centre of the region in % for transform-origin.
  const originX = ((rx + rw / 2) * 100).toFixed(2);
  const originY = ((ry + rh / 2) * 100).toFixed(2);
  return {
    transform: `scale(${scale.toFixed(3)})`,
    transformOrigin: `${originX}% ${originY}%`,
  };
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** A single image tile — used by every layout. */
function ImageTile({
  url,
  alt,
  className = "",
  style,
  children,
}: {
  url: string;
  alt: string;
  className?: string;
  style?: React.CSSProperties;
  children?: React.ReactNode;
}) {
  return (
    <figure className={`canvas-figure ${className}`.trim()} style={style}>
      <img className="hero-image" src={url} alt={alt} />
      {children}
    </figure>
  );
}

/** Generating/failed tile for generated items — a clean 3-dot loader. */
function ShimmerTile({ label, failed = false }: { label?: string; failed?: boolean }) {
  return (
    <div className="canvas-shimmer">
      {!failed && <div className="canvas-shimmer-inner" />}
      {failed ? (
        <ImageIcon size={30} aria-hidden="true" />
      ) : (
        <div className="canvas-gen-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      )}
      {label && <span className="canvas-shimmer-label">{label}</span>}
    </div>
  );
}

type SpecCardRow = {
  label: string;
  value: string;
  emphasis?: "normal" | "muted" | "total";
  separatorBefore?: boolean;
};

/**
 * Types a string out character-by-character — the "salesman writing it down"
 * effect. The caret blinks while typing and DISAPPEARS once the value is fully
 * written. Calls `onDone` when finished (used to advance the sequential reveal).
 * Presentation only; the final value is always the full grounded string.
 */
function TypedText({ text, speed = 42, onDone }: { text: string; speed?: number; onDone?: () => void }) {
  const [shown, setShown] = useState("");
  const [done, setDone] = useState(false);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  useEffect(() => {
    setShown("");
    setDone(false);
    let i = 0;
    const id = window.setInterval(() => {
      i += 1;
      setShown(text.slice(0, i));
      if (i >= text.length) {
        window.clearInterval(id);
        setDone(true);
        onDoneRef.current?.();
      }
    }, speed);
    return () => window.clearInterval(id);
  }, [text, speed]);
  return (
    <span className="spec-typed">
      {shown}
      {!done && <span className="spec-caret" aria-hidden="true" />}
    </span>
  );
}

/**
 * Full-screen "notepad" of grounded facts. One row → big hero number; several
 * rows → a stacked fact sheet. Rows reveal SEQUENTIALLY — each types out, and
 * only when it finishes does the next row appear and start — so the card builds
 * line-by-line like the specialist talking through it. Earlier rows sit static
 * (no caret); the active row carries the blinking caret until it lands.
 */
function SpecCard({ title, rows }: { title?: string; rows: SpecCardRow[] }) {
  const single = rows.length === 1;
  // How many rows are visible/started. Resets to 1 whenever the card content
  // changes (keyed on a stable signature so it doesn't reset every render).
  const rowsKey = rows.map((r) => `${r.label}=${r.value}`).join("|");
  const [revealed, setRevealed] = useState(1);
  useEffect(() => {
    setRevealed(1);
  }, [rowsKey]);

  return (
    <div className={`spec-card${single ? " spec-card-single" : ""}`}>
      {title && !single && <div className="spec-card-title">{title}</div>}
      <div className="spec-rows">
        {rows.slice(0, revealed).map((row, i) => {
          const isActive = i === revealed - 1;
          return (
            <div
              className={[
                "spec-row",
                row.emphasis ? `spec-row-${row.emphasis}` : "",
                row.separatorBefore ? "spec-row-separator" : "",
              ].filter(Boolean).join(" ")}
              key={`${row.label}-${i}`}
            >
              <span className="spec-label">{row.label}</span>
              <span className="spec-value">
                {isActive ? (
                  <TypedText
                    text={row.value}
                    onDone={() => setRevealed((r) => (r < rows.length ? r + 1 : r))}
                  />
                ) : (
                  // Already-finished row: full value, no caret.
                  <span className="spec-typed">{row.value}</span>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Annotation mark boxes overlaid on an item. Normalized coords → %. */
function MarkOverlays({
  marks,
  itemIndex,
}: {
  marks: {
    itemIndex: number;
    box: [number, number, number, number];
    label: string;
    polygon?: [number, number][];
  }[];
  itemIndex: number;
}) {
  const relevant = marks.filter((m) => m.itemIndex === itemIndex);
  if (relevant.length === 0) return null;
  return (
    <>
      {relevant.map((mark, i) => {
        // Contour annotation: outline the real shape with an SVG polygon and
        // anchor the label pill at the contour's top-left, instead of a rectangle.
        if (mark.polygon && mark.polygon.length >= 3) {
          const points = mark.polygon.map(([x, y]) => `${(x * 100).toFixed(2)},${(y * 100).toFixed(2)}`).join(" ");
          const minX = Math.min(...mark.polygon.map(([x]) => x));
          const minY = Math.min(...mark.polygon.map(([, y]) => y));
          return (
            <div key={i} className="canvas-mark-outline">
              <svg className="canvas-mark-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                <polygon points={points} />
              </svg>
              <span
                className="canvas-mark-label"
                style={{ left: `${(minX * 100).toFixed(2)}%`, top: `${(minY * 100).toFixed(2)}%` }}
              >
                {mark.label}
              </span>
            </div>
          );
        }
        const [bx, by, bw, bh] = mark.box;
        return (
          <div
            key={i}
            className="canvas-mark"
            style={{
              left: `${(bx * 100).toFixed(2)}%`,
              top: `${(by * 100).toFixed(2)}%`,
              width: `${(bw * 100).toFixed(2)}%`,
              height: `${(bh * 100).toFixed(2)}%`,
            }}
          >
            <span className="canvas-mark-label">{mark.label}</span>
          </div>
        );
      })}
    </>
  );
}

// ---------------------------------------------------------------------------
// Main Canvas component
// ---------------------------------------------------------------------------

export interface CanvasProps {
  viewState: ViewState;
  images: CarImage[];
  /** When true, show the "Finding the right view…" spinner badge. */
  imageBusy?: boolean;
}

export function Canvas({ viewState, images, imageBusy = false }: CanvasProps) {
  const imageMap = buildImageMap(images);
  const { layout, items, zoom, marks, caption } = viewState;

  // Determine which item (if any) has zoom applied.
  const zoomedIndex = zoom?.itemIndex ?? -1;
  const zoomedRegion = zoom?.region as [number, number, number, number] | undefined;

  // ── Render a single item (used by single/focus and grid/compare cells) ──
  function renderItem(item: CanvasItem, index: number, extraClass = "") {
    const resolved = resolveItem(item, imageMap);
    const isZoomed = zoomedIndex === index && zoomedRegion !== undefined;
    const zoomStyle = isZoomed ? zoomTransform(zoomedRegion!) : undefined;

    if (item.kind === "generated" && (item.status === "pending" || item.status === "failed")) {
      return (
        <ShimmerTile
          key={index}
          failed={item.status === "failed"}
          label={item.status === "pending" ? "Generating your view…" : "Couldn't generate that"}
        />
      );
    }

    if (!resolved) {
      return (
        <div key={index} className={`canvas-empty-tile ${extraClass}`.trim()}>
          <ImageIcon size={28} />
        </div>
      );
    }

    // Wrapper handles zoom transform + mark overlays
    return (
      <div
        key={index}
        className={`canvas-item-wrapper ${extraClass}${isZoomed ? " is-zoomed" : ""}`.trim()}
      >
        <ImageTile
          url={resolved.url}
          alt={resolved.alt}
          style={
            isZoomed && zoomStyle
              ? { transform: zoomStyle.transform, transformOrigin: zoomStyle.transformOrigin }
              : undefined
          }
        />
        {marks && (
          <MarkOverlays marks={marks} itemIndex={index} />
        )}
      </div>
    );
  }

  // ── Layout: single / focus ───────────────────────────────────────────────
  function renderSingle() {
    const item = items[0];
    if (!item) {
      return <div className="empty-image"><ImageIcon /></div>;
    }
    const resolved = resolveItem(item, imageMap);
    const isZoomed = zoomedIndex === 0 && zoomedRegion !== undefined;
    const zoomStyle = isZoomed ? zoomTransform(zoomedRegion!) : undefined;

    if (item.kind === "generated" && (item.status === "pending" || item.status === "failed")) {
      return (
        <ShimmerTile
          failed={item.status === "failed"}
          label={item.status === "pending" ? "Generating your view…" : "Couldn't generate that"}
        />
      );
    }

    if (!resolved) {
      return <div className="empty-image"><ImageIcon /></div>;
    }

    return (
      <div className={`canvas-item-wrapper${isZoomed ? " is-zoomed" : ""}`}>
        <ImageTile
          url={resolved.url}
          alt={resolved.alt}
          style={
            isZoomed && zoomStyle
              ? { transform: zoomStyle.transform, transformOrigin: zoomStyle.transformOrigin }
              : undefined
          }
        />
        {marks && <MarkOverlays marks={marks} itemIndex={0} />}
        {/* Caption sits ON the image (anchored to the wrapper = image box) and
            stays put during zoom, since the wrapper isn't transformed — only the
            figure inside it is. */}
        {!imageBusy && captionText ? (
          <div className="canvas-caption">{captionText}</div>
        ) : null}
      </div>
    );
  }

  // ── Layout: grid (2x2, up to 4) ─────────────────────────────────────────
  function renderGrid() {
    const visible = items.slice(0, 4);
    return (
      <div className="canvas-grid">
        {visible.map((item, i) => renderItem(item, i, "canvas-grid-cell"))}
      </div>
    );
  }

  // ── Layout: compare (2-up) ───────────────────────────────────────────────
  function renderCompare() {
    const [a, b] = items;
    const labelFor = (item: CanvasItem | undefined, fallback: string) => {
      if (!item) return fallback;
      if (item.kind === "image") {
        const img = imageMap.get(item.imageId);
        return img ? img.role.replaceAll("_", " ") : fallback;
      }
      if (item.kind === "generated") return item.prompt.slice(0, 32);
      return fallback;
    };

    return (
      <div className="canvas-compare">
        <div className="canvas-compare-cell">
          {a ? renderItem(a, 0) : <div className="empty-image"><ImageIcon /></div>}
          <span className="canvas-compare-label">{labelFor(a, "Before")}</span>
        </div>
        <div className="canvas-compare-divider" aria-hidden="true" />
        <div className="canvas-compare-cell">
          {b ? renderItem(b, 1) : <div className="empty-image"><ImageIcon /></div>}
          <span className="canvas-compare-label">{labelFor(b, "After")}</span>
        </div>
      </div>
    );
  }

  // ── Layout: spec (full-screen written fact sheet, no photo) ──────────────
  function renderSpec() {
    const item = items[0];
    if (!item || item.kind !== "spec") {
      return <div className="empty-image"><ImageIcon /></div>;
    }
    return (
      <div className="canvas-spec">
        <SpecCard title={item.title} rows={item.rows} />
      </div>
    );
  }

  // ── Caption: always rendered, even when empty (e2e asserts .canvas-caption) ──
  const captionText =
    caption ??
    (() => {
      // Derive a caption from the current item's role as fallback
      const first = items[0];
      if (first?.kind === "image") {
        const img = imageMap.get(first.imageId);
        return img?.role.replaceAll("_", " ") ?? "";
      }
      return "";
    })();

  return (
    <div className="image-canvas">
      {layout === "spec"
        ? renderSpec()
        : layout === "grid" && items.length > 1
        ? renderGrid()
        : layout === "compare" && items.length > 1
        ? renderCompare()
        : renderSingle()}

      {/* Grid/compare caption sits on the canvas (multiple images, no single
          image to anchor to). Single layout renders its caption ON the image
          inside renderSingle. Spec carries its own heading. (.canvas-caption is
          still in the DOM for every image layout — the e2e selector holds.) */}
      {!imageBusy && ((layout === "grid" && items.length > 1) || (layout === "compare" && items.length > 1)) && (
        <div className="canvas-caption">{captionText}</div>
      )}

      {/* Loading badge */}
      {imageBusy && (
        <div className="canvas-badge">
          <span className="canvas-spinner" /> Finding the right view…
        </div>
      )}
    </div>
  );
}
