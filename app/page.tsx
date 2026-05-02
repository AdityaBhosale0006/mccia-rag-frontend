"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type Doc = {
  document_id: string;
  filename: string;
  uploaded_at: number;
  page_count?: number;
  chunks_indexed?: number;
  ocr_requested_pages?: number;
  ocr_filled_pages?: number;
};

type ChatMsg = { role: "user" | "assistant"; content: string };
type DisambiguationOption = { document_id: string; filename: string };
type LlmStats = {
  started_at?: number;
  requests_total?: number;
  tokens_est_total?: number;
  rolling_60s?: {
    window_seconds?: number;
    rpm?: number;
    tpm_input_est?: number;
    tpm_output_est?: number;
    tpm_total_est?: number;
  };
  last_request?: { ts?: number; provider?: string; model?: string; tokens_est?: number; ok?: boolean } | null;
};

const API_BASE = "/api";

export default function Home() {
  const router = useRouter();
  const [docs, setDocs] = useState<Doc[]>([]);
  const [uploading, setUploading] = useState(false);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [selectedDocIds, setSelectedDocIds] = useState<Set<string>>(new Set());
  const [filesPanelOpen, setFilesPanelOpen] = useState(false);
  const [llmStats, setLlmStats] = useState<LlmStats | null>(null);
  const [llmRate, setLlmRate] = useState<{ rpm: number; tpm: number } | null>(null);
  const [messages, setMessages] = useState<ChatMsg[]>([
    {
      role: "assistant",
      content:
        "Upload one or more PDFs, then ask a question. I’ll answer using the information available across all uploaded files."
    }
  ]);
  const [q, setQ] = useState("");
  const [sending, setSending] = useState(false);
  const [disambiguation, setDisambiguation] = useState<{
    prompt: string;
    options: DisambiguationOption[];
    lastQuestion: string;
  } | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const docsLabel = useMemo(() => {
    if (docs.length === 0) return "No PDFs uploaded yet";
    return `${docs.length} PDF${docs.length === 1 ? "" : "s"} indexed`;
  }, [docs.length]);

  async function refreshDocs() {
    const res = await fetch(`${API_BASE}/documents`);
    if (!res.ok) return;
    const data = (await res.json()) as { documents: Doc[] };
    setDocs(data.documents ?? []);
    // Default behavior: all files selected.
    setSelectedDocIds((prev) => {
      if (prev.size > 0) return prev;
      return new Set((data.documents ?? []).map((d) => d.document_id));
    });
  }

  async function refreshSession() {
    const res = await fetch(`${API_BASE}/auth/session`, { cache: "no-store" });
    if (!res.ok) {
      setUserEmail(null);
      if (res.status === 401) router.replace("/signin");
      return;
    }
    const data = (await res.json()) as { email?: string };
    setUserEmail(data.email ?? null);
  }

  useEffect(() => {
    refreshSession();
    refreshDocs();
  }, []);

  useEffect(() => {
    let cancelled = false;
    let last: { ts: number; req: number; tok: number } | null = null;

    async function poll() {
      try {
        const res = await fetch(`${API_BASE}/debug/llm-stats`, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as LlmStats;
        if (cancelled) return;
        setLlmStats(data);

        const now = Date.now();
        const req = Number(data.requests_total ?? 0);
        const tok = Number(data.tokens_est_total ?? 0);
        if (last) {
          const dtMin = Math.max(0.0001, (now - last.ts) / 60000);
          setLlmRate({
            rpm: (req - last.req) / dtMin,
            tpm: (tok - last.tok) / dtMin
          });
        }
        last = { ts: now, req, tok };
      } catch {
        // ignore
      }
    }

    void poll();
    const id = window.setInterval(poll, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  async function onUpload(file: File) {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`${API_BASE}/upload`, { method: "POST", body: fd });
      const body = await res.json().catch(() => ({}));
      if (res.status === 401) {
        router.replace("/signin");
        throw new Error("Not signed in");
      }
      if (!res.ok) throw new Error(body?.detail ?? "Upload failed");
      await refreshDocs();
    } finally {
      setUploading(false);
    }
  }

  async function send(opts?: { document_id?: string; question?: string }) {
    const question = (opts?.question ?? q).trim();
    if (!question || sending) return;
    setQ("");
    setSending(true);
    setDisambiguation(null);
    setMessages((m) => [...m, { role: "user", content: question }]);
    try {
      const history = [...messages, { role: "user" as const, content: question }].slice(-12);
      const allIds = docs.map((d) => d.document_id);
      const picked = Array.from(selectedDocIds);
      const document_ids = picked.length > 0 && picked.length < allIds.length ? picked : [];
      const res = await fetch(`${API_BASE}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question,
          history,
          document_ids
        })
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 401) {
        router.replace("/signin");
        throw new Error("Not signed in");
      }
      if (!res.ok) throw new Error(body?.detail ?? "Chat failed");
      if (body?.disambiguation?.options?.length) {
        const prompt = String(body.disambiguation.prompt ?? "Which PDF should I use?");
        const options = body.disambiguation.options as DisambiguationOption[];
        setMessages((m) => [...m, { role: "assistant", content: prompt }]);
        setDisambiguation({ prompt, options, lastQuestion: question });
      } else {
        setMessages((m) => [...m, { role: "assistant", content: body.answer ?? "" }]);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Request failed";
      setMessages((m) => [...m, { role: "assistant", content: `Error: ${msg}` }]);
    } finally {
      setSending(false);
    }
  }

  function onSendClick() {
    void send();
  }

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "320px 1fr",
        height: "100vh"
      }}
    >
      <aside
        style={{
          borderRight: "1px solid rgba(255,255,255,0.08)",
          padding: 16,
          background: "rgba(255,255,255,0.02)",
          overflow: "auto"
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ fontSize: 14, opacity: 0.8 }}>Internal PDF RAG</div>
          <div style={{ fontSize: 18, fontWeight: 650 }}>Documents</div>
          <div style={{ fontSize: 12, opacity: 0.7 }}>{docsLabel}</div>

          <label
            style={{
              marginTop: 10,
              display: "block",
              padding: "10px 12px",
              borderRadius: 10,
              border: "1px solid rgba(255,255,255,0.12)",
              background: uploading ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.04)",
              cursor: uploading ? "not-allowed" : "pointer",
              fontSize: 14
            }}
          >
            {uploading ? "Uploading…" : "Upload PDF"}
            <input
              type="file"
              accept="application/pdf"
              disabled={uploading}
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onUpload(f);
                e.currentTarget.value = "";
              }}
            />
          </label>

          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              onClick={() => setSelectedDocIds(new Set(docs.map((d) => d.document_id)))}
              disabled={docs.length === 0}
              style={{
                flex: 1,
                padding: "8px 10px",
                borderRadius: 10,
                border: "1px solid rgba(255,255,255,0.12)",
                background: docs.length === 0 ? "rgba(255,255,255,0.02)" : "rgba(255,255,255,0.03)",
                color: "inherit",
                cursor: docs.length === 0 ? "not-allowed" : "pointer",
                fontSize: 12,
                fontWeight: 700
              }}
              title="Use all PDFs for chat"
            >
              Select all
            </button>
            <button
              type="button"
              onClick={() => setSelectedDocIds(new Set())}
              disabled={docs.length === 0}
              style={{
                flex: 1,
                padding: "8px 10px",
                borderRadius: 10,
                border: "1px solid rgba(255,255,255,0.12)",
                background: docs.length === 0 ? "rgba(255,255,255,0.02)" : "rgba(255,255,255,0.03)",
                color: "inherit",
                cursor: docs.length === 0 ? "not-allowed" : "pointer",
                fontSize: 12,
                fontWeight: 700
              }}
              title="Clear selection (defaults back to all PDFs)"
            >
              Deselect all
            </button>
          </div>

          <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
            {docs.map((d) => (
              <div
                key={d.document_id}
                style={{
                  padding: 10,
                  borderRadius: 10,
                  border: "1px solid rgba(255,255,255,0.08)",
                  background: "rgba(0,0,0,0.18)"
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.3 }}>
                  {d.filename}
                </div>
                <div style={{ fontSize: 12, opacity: 0.75, marginTop: 4 }}>
                  {d.page_count ?? "?"} pages · {d.chunks_indexed ?? "?"} chunks
                </div>
                <div style={{ fontSize: 12, opacity: 0.65, marginTop: 2 }}>
                  OCR filled: {d.ocr_filled_pages ?? 0}/{d.ocr_requested_pages ?? 0}
                </div>
              </div>
            ))}
          </div>
        </div>
      </aside>

      <main style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
        <header
          style={{
            padding: 16,
            borderBottom: "1px solid rgba(255,255,255,0.08)",
            display: "flex",
            alignItems: "center",
            gap: 12
          }}
        >
          <div style={{ fontSize: 18, fontWeight: 650 }}>Chat</div>
          <div style={{ fontSize: 12, opacity: 0.7 }}>
            Searches across all uploaded PDFs
          </div>
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10, position: "relative" }}>
            {llmRate ? (
              <div
                style={{
                  fontSize: 12,
                  opacity: 0.8,
                  padding: "6px 10px",
                  borderRadius: 999,
                  border: "1px solid rgba(255,255,255,0.12)",
                  background: "rgba(255,255,255,0.02)",
                  whiteSpace: "nowrap"
                }}
                title={
                  llmStats?.rolling_60s
                    ? `Gemini-style (rolling 60s): ${llmStats.rolling_60s.rpm ?? 0} RPM, ${llmStats.rolling_60s.tpm_total_est ?? 0} TPM (est)`
                    : llmStats?.last_request
                      ? `Last: ${llmStats.last_request.provider ?? "llm"} ${llmStats.last_request.model ?? ""}`
                      : "LLM usage"
                }
              >
                {Math.round(llmRate.rpm)} req/min · {Math.round(llmRate.tpm)} tok/min
                {llmStats?.rolling_60s ? (
                  <span style={{ opacity: 0.75 }}>
                    {" "}
                    | 60s: {llmStats.rolling_60s.rpm ?? 0} RPM · {llmStats.rolling_60s.tpm_total_est ?? 0} TPM
                  </span>
                ) : null}
              </div>
            ) : null}
            <button
              type="button"
              onClick={() => setFilesPanelOpen((v) => !v)}
              style={{
                padding: "6px 10px",
                borderRadius: 999,
                border: "1px solid rgba(255,255,255,0.12)",
                background: "rgba(255,255,255,0.03)",
                color: "inherit",
                cursor: "pointer",
                fontSize: 12
              }}
              title="Choose which PDFs to use during chat"
            >
              Files: {Math.min(selectedDocIds.size, docs.length)}/{docs.length}
            </button>
            {filesPanelOpen ? (
              <div
                style={{
                  position: "absolute",
                  right: 0,
                  top: 36,
                  width: 420,
                  maxWidth: "92vw",
                  borderRadius: 14,
                  border: "1px solid rgba(255,255,255,0.12)",
                  background: "rgba(10,12,18,0.98)",
                  boxShadow: "0 20px 60px rgba(0,0,0,0.55)",
                  padding: 12,
                  zIndex: 20
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>Use these PDFs</div>
                  <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                    <button
                      type="button"
                      onClick={() => setSelectedDocIds(new Set(docs.map((d) => d.document_id)))}
                      style={{
                        padding: "6px 10px",
                        borderRadius: 999,
                        border: "1px solid rgba(255,255,255,0.12)",
                        background: "rgba(255,255,255,0.03)",
                        color: "inherit",
                        cursor: "pointer",
                        fontSize: 12
                      }}
                    >
                      Select all
                    </button>
                    <button
                      type="button"
                      onClick={() => setSelectedDocIds(new Set())}
                      style={{
                        padding: "6px 10px",
                        borderRadius: 999,
                        border: "1px solid rgba(255,255,255,0.12)",
                        background: "rgba(255,255,255,0.03)",
                        color: "inherit",
                        cursor: "pointer",
                        fontSize: 12
                      }}
                    >
                      Deselect all
                    </button>
                  </div>
                </div>

                <div style={{ marginTop: 10, maxHeight: 320, overflow: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
                  {docs.map((d) => {
                    const checked = selectedDocIds.has(d.document_id);
                    return (
                      <label
                        key={d.document_id}
                        style={{
                          display: "flex",
                          alignItems: "flex-start",
                          gap: 10,
                          padding: 10,
                          borderRadius: 12,
                          border: "1px solid rgba(255,255,255,0.08)",
                          background: checked ? "rgba(72, 116, 255, 0.14)" : "rgba(255,255,255,0.03)",
                          cursor: "pointer"
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => {
                            setSelectedDocIds((prev) => {
                              const next = new Set(prev);
                              if (next.has(d.document_id)) next.delete(d.document_id);
                              else next.add(d.document_id);
                              return next;
                            });
                          }}
                          style={{ marginTop: 2 }}
                        />
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 650, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {d.filename}
                          </div>
                          <div style={{ fontSize: 12, opacity: 0.75, marginTop: 2 }}>
                            {d.page_count ?? "?"} pages · {d.chunks_indexed ?? "?"} chunks
                          </div>
                        </div>
                      </label>
                    );
                  })}
                </div>

                <div style={{ marginTop: 10, fontSize: 12, opacity: 0.72 }}>
                  Tip: if none are ticked, chat uses <b>all</b> PDFs.
                </div>
              </div>
            ) : null}
            {userEmail ? (
              <>
                <div style={{ fontSize: 12, opacity: 0.75, maxWidth: 420, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {userEmail}
                </div>
                <button
                  type="button"
                  onClick={async () => {
                    await fetch(`${API_BASE}/auth/logout`, { method: "POST" }).catch(() => {});
                    router.replace("/signin");
                  }}
                  style={{
                    padding: "6px 10px",
                    borderRadius: 999,
                    border: "1px solid rgba(255,255,255,0.12)",
                    background: "rgba(255,255,255,0.03)",
                    color: "inherit",
                    cursor: "pointer",
                    fontSize: 12
                  }}
                >
                  Logout
                </button>
              </>
            ) : null}
          </div>
        </header>

        <div style={{ flex: 1, overflow: "auto", padding: 16 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 920 }}>
            {messages.map((m, idx) => (
              <div
                key={idx}
                style={{
                  alignSelf: m.role === "user" ? "flex-end" : "flex-start",
                  maxWidth: "95%"
                }}
              >
                <div
                  style={{
                    padding: "10px 12px",
                    borderRadius: 12,
                    lineHeight: 1.4,
                    border: "1px solid rgba(255,255,255,0.10)",
                    background:
                      m.role === "user"
                        ? "rgba(72, 116, 255, 0.18)"
                        : "rgba(255,255,255,0.04)"
                  }}
                >
                  {m.role === "assistant" ? (
                    <div
                      style={{
                        color: "#e7eefc"
                      }}
                      className="md"
                    >
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                    </div>
                  ) : (
                    <div style={{ whiteSpace: "pre-wrap" }}>{m.content}</div>
                  )}
                </div>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
        </div>

        <footer
          style={{
            padding: 16,
            borderTop: "1px solid rgba(255,255,255,0.08)",
            background: "rgba(0,0,0,0.18)"
          }}
        >
          <div style={{ display: "flex", gap: 10, maxWidth: 920 }}>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder="Ask a question…"
              style={{
                flex: 1,
                padding: "12px 12px",
                borderRadius: 12,
                border: "1px solid rgba(255,255,255,0.12)",
                background: "rgba(255,255,255,0.03)",
                color: "inherit",
                outline: "none"
              }}
            />
            <button
              onClick={onSendClick}
              disabled={sending || q.trim().length === 0}
              style={{
                padding: "12px 14px",
                borderRadius: 12,
                border: "1px solid rgba(255,255,255,0.12)",
                background:
                  sending || q.trim().length === 0
                    ? "rgba(255,255,255,0.03)"
                    : "rgba(72, 116, 255, 0.28)",
                color: "inherit",
                cursor: sending || q.trim().length === 0 ? "not-allowed" : "pointer",
                fontWeight: 650
              }}
            >
              {sending ? "Sending…" : "Send"}
            </button>
          </div>
          {disambiguation ? (
            <div
              style={{
                marginTop: 10,
                maxWidth: 920,
                display: "flex",
                flexWrap: "wrap",
                gap: 8
              }}
            >
              {disambiguation.options.map((o) => (
                <button
                  key={o.document_id}
                  type="button"
                  onClick={() => {
                    setSelectedDocIds(new Set([o.document_id]));
                    void send({ document_id: o.document_id, question: disambiguation.lastQuestion });
                  }}
                  style={{
                    padding: "8px 10px",
                    borderRadius: 999,
                    border: "1px solid rgba(255,255,255,0.14)",
                    background: "rgba(255,255,255,0.04)",
                    color: "inherit",
                    cursor: "pointer",
                    fontSize: 12
                  }}
                >
                  {o.filename}
                </button>
              ))}
            </div>
          ) : null}
          <div style={{ fontSize: 12, opacity: 0.65, marginTop: 8, maxWidth: 920 }}>
            Tip: upload multiple PDFs first, then ask questions without selecting a file.
          </div>
        </footer>
      </main>
    </div>
  );
}
