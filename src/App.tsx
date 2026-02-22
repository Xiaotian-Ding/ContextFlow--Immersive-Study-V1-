import React, { useEffect, useMemo, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import html2canvas from "html2canvas";

// Set up PDF.js worker
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";
pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

type Rect = { x: number; y: number; w: number; h: number };

function normalizeRect(a: { x: number; y: number }, b: { x: number; y: number }): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const w = Math.abs(a.x - b.x);
  const h = Math.abs(a.y - b.y);
  return { x, y, w, h };
}

function DimOverlay({ rect, size }: { rect: Rect | null; size: { w: number; h: number } }) {
  if (!rect || rect.w < 2 || rect.h < 2) return null;
  const { x, y, w, h } = rect;

  return (
    <svg
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: size.w,
        height: size.h,
        zIndex: 50, // below HUD
        pointerEvents: "none",
      }}
    >
      <defs>
        <mask id="hole">
          <rect x="0" y="0" width={size.w} height={size.h} fill="white" />
          <rect x={x} y={y} width={w} height={h} fill="black" rx="8" ry="8" />
        </mask>
      </defs>

      <rect x="0" y="0" width={size.w} height={size.h} fill="rgba(0,0,0,0.3)" mask="url(#hole)" />
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        fill="transparent"
        stroke="rgba(255,255,255,0.95)"
        strokeWidth="2"
        rx="8"
        ry="8"
      />
    </svg>
  );
}

type ApiResult = {
  category: string;
  confidence: number;
  summary: string;
  followups: string[];
  _debug?: any;
};

type ChatMsg = { role: "user" | "assistant"; text: string };

type Column = {
  id: string;
  title: string;
  // contextBase: 这列“固定的底稿”（来自 screenshot 识别 + 该视角的指令）
  contextBase: string;
  chat: ChatMsg[];
  input: string;
  loading: boolean;
};

function uid() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

async function cropScreenshotFromScrollContainer(el: HTMLDivElement, rect: Rect): Promise<string> {
  const canvas = await html2canvas(el, {
    backgroundColor: null,
    scale: window.devicePixelRatio || 1,
    useCORS: true,
    width: el.clientWidth,
    height: el.clientHeight,
    x: 0,
    y: 0,
    scrollX: 0,
    scrollY: 0,
  });

  const dpr = window.devicePixelRatio || 1;

  const vx = rect.x - el.scrollLeft;
  const vy = rect.y - el.scrollTop;

  if (vx + rect.w < 0 || vy + rect.h < 0 || vx > el.clientWidth || vy > el.clientHeight) {
    throw new Error("Selection is outside the visible area. Scroll to the region and try again.");
  }

  const sx = Math.max(0, vx) * dpr;
  const sy = Math.max(0, vy) * dpr;
  const sw = Math.min(rect.w, el.clientWidth - vx) * dpr;
  const sh = Math.min(rect.h, el.clientHeight - vy) * dpr;

  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.floor(sw));
  out.height = Math.max(1, Math.floor(sh));
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("Canvas context not available");

  ctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, out.width, out.height);
  return out.toDataURL("image/png");
}

const DEFAULT_PERSPECTIVES: { title: string; instruction: string }[] = [
  {
    title: "Explain",
    instruction:
      "Explain clearly and concretely. Prefer step-by-step reasoning and local evidence from the screenshot.",
  },
];

function buildContextBase(result: ApiResult, perspectiveTitle: string, perspectiveInstruction: string) {
  return [
    `You are assisting with a selected screenshot region from a PDF.`,
    `Perspective: ${perspectiveTitle}`,
    `Perspective instruction: ${perspectiveInstruction}`,
    ``,
    `Recognition Summary:`,
    result.summary,
    ``,
    `Candidate Follow-ups:`,
    (result.followups || []).map((s, i) => `${i + 1}. ${s}`).join("\n"),
  ].join("\n");
}

export default function App() {
  const pdfContainerRef = useRef<HTMLDivElement>(null);

  const [overlaySize, setOverlaySize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const updateOverlaySize = () => {
    const el = pdfContainerRef.current;
    if (!el) return;
    setOverlaySize({ w: el.scrollWidth, h: el.scrollHeight });
  };

  const [numPages, setNumPages] = useState<number>(0);

  // drag selection
  const [dragging, setDragging] = useState(false);
  const [start, setStart] = useState<{ x: number; y: number } | null>(null);
  const [end, setEnd] = useState<{ x: number; y: number } | null>(null);

  const rect = useMemo(() => {
    if (!start || !end) return null;
    return normalizeRect(start, end);
  }, [start, end]);

  // analysis result
  const [analyzing, setAnalyzing] = useState(false);
  const [result, setResult] = useState<ApiResult | null>(null);
  const [error, setError] = useState<string>("");

  // multi-column sessions
  const [columns, setColumns] = useState<Column[]>([]);
  const reqSeqRef = useRef(0); // for out-of-order protection per request wave

  useEffect(() => {
    const el = pdfContainerRef.current;
    if (!el) return;

    const onScroll = () => updateOverlaySize();
    const onResize = () => updateOverlaySize();

    el.addEventListener("scroll", onScroll);
    window.addEventListener("resize", onResize);

    updateOverlaySize();

    return () => {
      el.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  function getPointInScrollContainer(e: React.MouseEvent, el: HTMLDivElement) {
    const box = el.getBoundingClientRect();
    return {
      x: e.clientX - box.left + el.scrollLeft,
      y: e.clientY - box.top + el.scrollTop,
    };
  }

  const onMouseDown = (e: React.MouseEvent) => {
    // Right button drag = screenshot selection. Left button is kept for text selection/copy.
    if (e.button !== 2) return;
    e.preventDefault();
    if (!pdfContainerRef.current) return;
    const p = getPointInScrollContainer(e, pdfContainerRef.current);
    setDragging(true);
    setStart(p);
    setEnd(p);
  };

  const onMouseMove = (e: React.MouseEvent) => {
    if (!dragging || !pdfContainerRef.current) return;
    const p = getPointInScrollContainer(e, pdfContainerRef.current);
    setEnd(p);
  };

  const onMouseUp = async (e: React.MouseEvent) => {
    if (!dragging) return;
    if (e.button !== 2) return;
    setDragging(false);
    setError("");

    const el = pdfContainerRef.current;
    if (!el) return;
    if (!rect || rect.w < 6 || rect.h < 6) return;

    setAnalyzing(true);

    try {
      const imageDataUrl = await cropScreenshotFromScrollContainer(el, rect);

      const r = await fetch("/api/explain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageDataUrl, instruction: "" }),
      });

      const raw = await r.text();
      let data: any = null;
      try {
        data = raw ? JSON.parse(raw) : null;
      } catch {
        throw new Error(`Non-JSON response (status ${r.status}):\n${raw.slice(0, 500)}`);
      }
      if (!r.ok) throw new Error(data?.error || "Request failed");

      const apiResult: ApiResult = data;
      setResult(apiResult);

      // Create columns for perspectives
      const nextCols: Column[] = DEFAULT_PERSPECTIVES.map((p) => ({
        id: uid(),
        title: p.title,
        contextBase: buildContextBase(apiResult, p.title, p.instruction),
        chat: [],
        input: "",
        loading: false,
      }));

      setColumns(nextCols);
    } catch (e: any) {
      setError(e?.message ?? "Unknown error");
    } finally {
      setAnalyzing(false);
    }
  };

  const askInColumn = async (colId: string, text: string) => {
    setError("");
    const q = text.trim();
    if (!q) return;

    // optimistic update
    setColumns((prev) =>
      prev.map((c) =>
        c.id === colId
          ? { ...c, chat: [...c.chat, { role: "user", text: q }], input: "", loading: true }
          : c
      )
    );

    const myReq = ++reqSeqRef.current;

    // capture snapshot state safely
    const colSnapshot = columns.find((c) => c.id === colId);
    if (!colSnapshot) {
      setColumns((prev) => prev.map((c) => (c.id === colId ? { ...c, loading: false } : c)));
      return;
    }

    const historyNext: ChatMsg[] = [...colSnapshot.chat, { role: "user", text: q }];

    try {
      const r = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          context: colSnapshot.contextBase,
          question: q,
          history: historyNext.slice(-30),
        }),
      });

      const raw = await r.text();
      let data: any = null;
      try {
        data = raw ? JSON.parse(raw) : null;
      } catch {
        throw new Error(`Non-JSON response (status ${r.status}):\n${raw.slice(0, 500)}`);
      }
      if (!r.ok) throw new Error(data?.error || `Request failed (status ${r.status})`);

      if (myReq !== reqSeqRef.current) return;

      const cleaned = String(data.answer || "").replace(/\\n/g, "\n");

      setColumns((prev) =>
        prev.map((c) =>
          c.id === colId
            ? { ...c, chat: [...c.chat, { role: "assistant", text: cleaned }], loading: false }
            : c
        )
      );
    } catch (e: any) {
      setError(e?.message ?? "Unknown error");
      setColumns((prev) => prev.map((c) => (c.id === colId ? { ...c, loading: false } : c)));
    }
  };

  const endAllSessions = () => {
    setColumns([]);
    setResult(null);
    setError("");
    setStart(null);
    setEnd(null);
  };

  return (
    <div style={{ height: "100vh", width: "100vw", overflow: "hidden", background: "#111" }}>
      {/* Wrapper is relative so HUD can float above PDF */}
      <div style={{ height: "100%", position: "relative" }}>
        {/* PDF scroll container */}
        <div
          ref={pdfContainerRef}
          style={{
            height: "100%",
            overflow: "auto",
            padding: 24,
            position: "relative",
            background: "#f2f2f2",
          }}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onContextMenu={(e) => e.preventDefault()}
        >
          <Document
            file="/sample.pdf"
            loading={<div style={{ padding: 16 }}>Loading PDF…</div>}
            error={<div style={{ padding: 16 }}>Failed to load PDF (open Console)</div>}
            onLoadSuccess={(p) => {
              setNumPages(p.numPages);
              requestAnimationFrame(() => updateOverlaySize());
            }}
          >
            {Array.from({ length: numPages }, (_, i) => (
              <div key={i} style={{ marginBottom: 16 }}>
                <Page pageNumber={i + 1} scale={1.2} />
              </div>
            ))}
          </Document>

          <DimOverlay rect={rect} size={overlaySize} />
        </div>

        <div
          data-hud-root
          style={{
            position: "fixed",
            top: 16,
            right: 16,
            zIndex: 9999,
            pointerEvents: "auto",
          }}
        >
          <HUD
            analyzing={analyzing}
            error={error}
            result={result}
            columns={columns}
            setColumns={setColumns}
            askInColumn={askInColumn}
            endAllSessions={endAllSessions}
          />
        </div>
      </div>
    </div>
  );
}

function HUD(props: {
  analyzing: boolean;
  error: string;
  result: ApiResult | null;
  columns: Column[];
  setColumns: React.Dispatch<React.SetStateAction<Column[]>>;
  askInColumn: (colId: string, text: string) => Promise<void>;
  endAllSessions: () => void;
}) {
  const { analyzing, error, result, columns, setColumns, askInColumn, endAllSessions } = props;

  const addPerspective = () => {
    if (!result) return;
    const title = `Perspective ${columns.length + 1}`;
    const instruction =
      "Provide a different helpful angle. Be concrete. Use the screenshot context, not generic talk.";
    setColumns((prev) => [
      ...prev,
      {
        id: uid(),
        title,
        contextBase: buildContextBase(result, title, instruction),
        chat: [],
        input: "",
        loading: false,
      },
    ]);
  };

  return (
    <div
      style={{
        width: "min(560px, calc(100vw - 32px))",
        maxWidth: "calc(100vw - 32px)",
        maxHeight: "calc(100vh - 32px)",
        borderRadius: 16,
        border: "1px solid rgba(255,255,255,0.12)",
        background: "rgba(20,20,20,0.78)",
        backdropFilter: "blur(10px)",
        color: "#fff",
        boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Top bar */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 12,
          padding: "10px 12px",
          borderBottom: "1px solid rgba(255,255,255,0.10)",
        }}
      >
        <div style={{ display: "grid", gap: 4, minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 800, fontSize: 20, lineHeight: 1.15 }}>
            ContextFlow(Web) - Immersive Study
          </div>
          <div style={{ fontSize: 12, opacity: 0.8 }}>
            Right-drag to screenshot, left-drag to select text/copy
          </div>
        </div>

        <div
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            flexWrap: "wrap",
            justifyContent: "flex-end",
            minWidth: 0,
          }}
        >
          {result && (
            <>
              <button onClick={addPerspective} style={btnStyle(false)} title="Add a new perspective column">
                + Column
              </button>
              <button onClick={endAllSessions} style={btnStyle(false)}>
                Clear
              </button>
            </>
          )}

          <div
            style={{
              fontSize: 12,
              padding: "6px 10px",
              borderRadius: 999,
              border: "1px solid rgba(255,255,255,0.14)",
              background: analyzing ? "rgba(255,255,255,0.08)" : "transparent",
              opacity: 0.9,
            }}
          >
            {analyzing ? "Analyzing…" : result ? "Ready" : "Select region"}
          </div>
        </div>
      </div>

      {error && (
        <div style={{ padding: "10px 12px", color: "#ff9aa8", borderBottom: "1px solid rgba(255,255,255,0.10)" }}>
          {error}
        </div>
      )}

      {/* Content */}
      {!result ? (
        <div style={{ padding: 12, fontSize: 13, opacity: 0.85 }}>
          No analysis yet. Drag to select a region on the PDF.
        </div>
      ) : (
        <div style={{ padding: 12, display: "grid", gap: 12, overflowY: "auto", overflowX: "hidden" }}>
          {/* Quick summary cards */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr",
              gap: 10,
            }}
          >
            <MiniCard title="Category" text={result.category} />
            <MiniCard title="Confidence" text={String(result.confidence)} />
            <MiniCard title="Summary" text={result.summary} />
          </div>

          {/* Columns */}
          <div
            style={{
              display: "grid",
              gap: 10,
              gridTemplateColumns: "1fr",
            }}
          >
            {columns.map((c) => (
              <PerspectiveColumn
                key={c.id}
                col={c}
                onChangeInput={(v) =>
                  setColumns((prev) => prev.map((x) => (x.id === c.id ? { ...x, input: v } : x)))
                }
                onAsk={() => askInColumn(c.id, c.input)}
                onAskText={(t) => askInColumn(c.id, t)}
                onRemove={() => setColumns((prev) => prev.filter((x) => x.id !== c.id))}
              />
            ))}
          </div>

          {/* Followups quick buttons (global) */}
          <div style={{ borderTop: "1px solid rgba(255,255,255,0.10)", paddingTop: 6 }}>
            <div style={{ fontSize: 11, opacity: 0.72, marginBottom: 6 }}>Suggested follow-ups</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {(result.followups || []).slice(0, 4).map((s, i) => (
                <button
                  key={i}
                  style={{
                    padding: "5px 8px",
                    borderRadius: 999,
                    border: "1px solid rgba(255,255,255,0.14)",
                    background: "rgba(255,255,255,0.06)",
                    color: "#fff",
                    cursor: "pointer",
                    fontSize: 11,
                  }}
                  onClick={() => {
                    const explain = columns.find((x) => x.title === "Explain") || columns[0];
                    if (!explain) return;
                    askInColumn(explain.id, s);
                  }}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PerspectiveColumn(props: {
  col: Column;
  onChangeInput: (v: string) => void;
  onAsk: () => void;
  onAskText: (t: string) => void;
  onRemove: () => void;
}) {
  const { col, onChangeInput, onAsk, onAskText, onRemove } = props;

  return (
    <div
      style={{
        width: "100%",
        borderRadius: 14,
        border: "1px solid rgba(255,255,255,0.12)",
        background: "rgba(255,255,255,0.06)",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div style={{ padding: "10px 10px", display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ fontWeight: 800 }}>{col.title}</div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          <button onClick={onRemove} style={iconBtnStyle} title="Remove column">
            ✕
          </button>
        </div>
      </div>

      <div style={{ padding: "0 10px 10px 10px", display: "grid", gap: 8 }}>
        {/* First question shortcut if empty */}
        {col.chat.length === 0 && (
          <div style={{ fontSize: 12, opacity: 0.8 }}>
            Ask the first question for this perspective.
          </div>
        )}

        <div style={{ display: "flex", gap: 8 }}>
          <input
            value={col.input}
            onChange={(e) => onChangeInput(e.target.value)}
            placeholder="Type a question…"
            style={{
              flex: 1,
              padding: "10px 10px",
              borderRadius: 12,
              border: "1px solid rgba(255,255,255,0.14)",
              background: "rgba(0,0,0,0.25)",
              color: "#fff",
              outline: "none",
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (!col.loading) onAsk();
              }
            }}
          />
          <button onClick={onAsk} disabled={col.loading || !col.input.trim()} style={btnStyle(col.loading || !col.input.trim())}>
            {col.loading ? "…" : "Ask"}
          </button>
        </div>

        {/* Chat list */}
        <div
          style={{
            maxHeight: 220,
            overflow: "auto",
            paddingRight: 4,
            display: "grid",
            gap: 8,
            borderTop: "1px solid rgba(255,255,255,0.10)",
            paddingTop: 10,
          }}
        >
          {col.chat.length === 0 ? (
            <div style={{ fontSize: 12, opacity: 0.7 }}>No messages yet.</div>
          ) : (
            col.chat.map((m, i) => {
              const parts =
                m.role === "assistant"
                  ? m.text
                      .split(/\n{2,}/)
                      .map((x) => x.trim())
                      .filter(Boolean)
                  : [m.text];

              return (
                <div
                  key={i}
                  style={{
                    borderRadius: 12,
                    border: "1px solid rgba(255,255,255,0.10)",
                    background: m.role === "user" ? "rgba(255,255,255,0.10)" : "rgba(0,0,0,0.20)",
                    padding: 10,
                    lineHeight: 1.45,
                  }}
                >
                  <div style={{ fontWeight: 800, fontSize: 12, opacity: 0.85, marginBottom: 6 }}>
                    {m.role === "user" ? "You" : "Assistant"}
                  </div>
                  <div style={{ display: "grid", gap: 6 }}>
                    {parts.map((part, idx) => (
                      <div
                        key={idx}
                        style={{
                          fontSize: 13,
                          whiteSpace: "pre-wrap",
                          borderRadius: 10,
                          border: "1px solid rgba(255,255,255,0.08)",
                          background: "rgba(255,255,255,0.04)",
                          padding: "8px 10px",
                        }}
                      >
                        {part}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* tiny quick actions */}
        {col.chat.length > 0 && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              style={chipBtnStyle}
              onClick={() => onAskText("Summarize the key points in 3 bullets.")}
              disabled={col.loading}
            >
              3-bullets
            </button>
            <button
              style={chipBtnStyle}
              onClick={() => onAskText("What are the main assumptions here?")}
              disabled={col.loading}
            >
              assumptions
            </button>
            <button
              style={chipBtnStyle}
              onClick={() => onAskText("Give me a concrete next step.")}
              disabled={col.loading}
            >
              next step
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function MiniCard({ title, text }: { title: string; text: string }) {
  return (
    <div
      style={{
        borderRadius: 14,
        border: "1px solid rgba(255,255,255,0.12)",
        background: "rgba(255,255,255,0.06)",
        padding: 10,
      }}
    >
      <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: 13, lineHeight: 1.35, whiteSpace: "pre-wrap" }}>{text}</div>
    </div>
  );
}

function btnStyle(disabled: boolean) {
  return {
    padding: "10px 12px",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.14)",
    background: disabled ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.12)",
    color: "#fff",
    cursor: disabled ? "not-allowed" : "pointer",
  } as React.CSSProperties;
}

const iconBtnStyle: React.CSSProperties = {
  width: 30,
  height: 30,
  borderRadius: 10,
  border: "1px solid rgba(255,255,255,0.14)",
  background: "rgba(255,255,255,0.06)",
  color: "#fff",
  cursor: "pointer",
};

const chipBtnStyle: React.CSSProperties = {
  padding: "6px 10px",
  borderRadius: 999,
  border: "1px solid rgba(255,255,255,0.14)",
  background: "rgba(255,255,255,0.06)",
  color: "#fff",
  cursor: "pointer",
  fontSize: 12,
};
