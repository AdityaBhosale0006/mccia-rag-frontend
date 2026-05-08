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
  locked?: boolean;
};

type JobStatus = "queued" | "processing" | "done" | "error";

type JobState = {
  job_id: string;
  document_id: string;
  filename: string;
  status: JobStatus;
  progress: string;
  percent: number;
  error?: string;
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

function calcPercent(status: string, progress: string): number {
  if (status === "done") return 100;
  if (status === "error") return 0;
  if (status === "queued") return 8;
  const p = progress.toLowerCase();
  if (p.includes("ocr") || p.includes("parsing")) return 35;
  if (p.includes("embed") || p.includes("index")) return 75;
  return 15;
}

export default function Home() {
  const router = useRouter();
  const [docs, setDocs] = useState<Doc[]>([]);
  const [uploading, setUploading] = useState(false);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [selectedDocIds, setSelectedDocIds] = useState<Set<string>>(new Set());
  const [filesPanelOpen, setFilesPanelOpen] = useState(false);
  const [activeJobs, setActiveJobs] = useState<Map<string, JobState>>(new Map());
  const pollTimers = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());
  const [llmStats, setLlmStats] = useState<LlmStats | null>(null);
  const [llmRate, setLlmRate] = useState<{ rpm: number; tpm: number } | null>(null);
  const [messages, setMessages] = useState<ChatMsg[]>([
    {
      role: "assistant",
      content:
        "Upload one or more PDFs, then ask a question. I'll answer using the information available across all uploaded files."
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
    if (docs.length === 0 && activeJobs.size === 0) return "No PDFs uploaded yet";
    const total = docs.length + activeJobs.size;
    return `${total} PDF${total === 1 ? "" : "s"}`;
  }, [docs.length, activeJobs.size]);

  async function refreshDocs() {
    const res = await fetch(`${API_BASE}/documents`);
    if (!res.ok) return;
    const data = (await res.json()) as { documents: Doc[] };
    const fetched = data.documents ?? [];
    setDocs(fetched);
    setSelectedDocIds((prev) => {
      if (prev.size === 0) return new Set(fetched.map((d) => d.document_id));
      // auto-select newly finished docs
      const next = new Set(prev);
      for (const d of fetched) {
        if (!prev.has(d.document_id)) next.add(d.document_id);
      }
      return next;
    });
  }

  function startPolling(job_id: string, filename: string, document_id: string) {
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`${API_BASE}/upload/${job_id}`);
        if (!res.ok) return;
        const job = (await res.json()) as {
          status: string;
          progress?: string;
          document_id?: string;
          error?: string;
        };
        const status = job.status as JobStatus;
        const progress = job.progress ?? "";
        const percent = calcPercent(status, progress);
        const doc_id = job.document_id ?? document_id;

        setActiveJobs((prev) => {
          const next = new Map(prev);
          next.set(job_id, { job_id, document_id: doc_id, filename, status, progress, percent, error: job.error });
          return next;
        });

        if (status === "done" || status === "error") {
          clearInterval(timer);
          pollTimers.current.delete(job_id);
          if (status === "done") {
            await refreshDocs();
            setActiveJobs((prev) => {
              const next = new Map(prev);
              next.delete(job_id);
              return next;
            });
          }
        }
      } catch {
        // keep polling on transient network errors
      }
    }, 2000);

    pollTimers.current.set(job_id, timer);
  }

  async function handleDelete(doc_id: string) {
    if (!confirm("Delete this document? This cannot be undone.")) return;
    const res = await fetch(`${API_BASE}/documents/${doc_id}`, { method: "DELETE" });
    if (res.ok) {
      setSelectedDocIds((prev) => { const n = new Set(prev); n.delete(doc_id); return n; });
      await refreshDocs();
    } else {
      const err = await res.json().catch(() => ({}));
      alert((err as { detail?: string }).detail ?? "Failed to delete document");
    }
  }

  async function handleToggleLock(doc_id: string) {
    const res = await fetch(`${API_BASE}/documents/${doc_id}/lock`, { method: "PATCH" });
    if (res.ok) await refreshDocs();
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

  // Clean up all poll timers on unmount
  useEffect(() => {
    return () => {
      pollTimers.current.forEach((t) => clearInterval(t));
      pollTimers.current.clear();
    };
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

  async function onUpload(files: FileList | File[]) {
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const fd = new FormData();
        fd.append("file", file);
        const res = await fetch(`${API_BASE}/upload`, { method: "POST", body: fd });
        const body = await res.json().catch(() => ({})) as {
          job_id?: string;
          document_id?: string;
          status?: string;
          detail?: string;
        };
        if (res.status === 401) {
          router.replace("/signin");
          throw new Error("Not signed in");
        }
        if (!res.ok) throw new Error(body?.detail ?? `Upload failed: ${file.name}`);

        const job_id = body.job_id;
        const document_id = body.document_id ?? "";

        if (body.status === "done" || !job_id) {
          // Deduped or already complete — just refresh
          await refreshDocs();
        } else {
          // Show immediately in sidebar with 0% and start polling
          setActiveJobs((prev) => {
            const next = new Map(prev);
            next.set(job_id, {
              job_id,
              document_id,
              filename: file.name,
              status: "queued",
              progress: "Queued…",
              percent: 8,
            });
            return next;
          });
          startPolling(job_id, file.name, document_id);
        }
      }
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
        body: JSON.stringify({ question, history, document_ids })
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

  // Doc IDs currently being processed — hide from completed list to avoid duplicates
  const activeDocIds = new Set(Array.from(activeJobs.values()).map((j) => j.document_id));

  return (
    <div style={{ display: "grid", gridTemplateColumns: "320px 1fr", height: "100vh" }}>
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
            {uploading ? "Uploading…" : "Upload PDFs"}
            <input
              type="file"
              accept="application/pdf"
              multiple
              disabled={uploading}
              style={{ display: "none" }}
              onChange={(e) => {
                const files = e.target.files;
                if (files && files.length > 0) void onUpload(files);
                e.currentTarget.value = "";
              }}
            />
          </label>

          <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>

            {/* In-progress uploads */}
            {Array.from(activeJobs.values()).map((job) => (
              <div
                key={job.job_id}
                style={{
                  padding: 10,
                  borderRadius: 10,
                  border: `1px solid ${job.status === "error" ? "rgba(255,80,80,0.35)" : "rgba(72,116,255,0.3)"}`,
                  background: job.status === "error" ? "rgba(255,80,80,0.06)" : "rgba(72,116,255,0.07)"
                }}
              >
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    lineHeight: 1.3,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap"
                  }}
                  title={job.filename}
                >
                  {job.filename}
                </div>
                {job.status === "error" ? (
                  <div style={{ fontSize: 12, color: "rgba(255,110,110,0.9)", marginTop: 4 }}>
                    {job.error ?? job.progress}
                  </div>
                ) : (
                  <>
                    <div
                      style={{
                        fontSize: 11,
                        opacity: 0.65,
                        marginTop: 4,
                        display: "flex",
                        justifyContent: "space-between"
                      }}
                    >
                      <span>{job.progress}</span>
                      <span style={{ fontWeight: 700 }}>{job.percent}%</span>
                    </div>
                    <div
                      style={{
                        marginTop: 5,
                        height: 3,
                        borderRadius: 2,
                        background: "rgba(255,255,255,0.08)",
                        overflow: "hidden"
                      }}
                    >
                      <div
                        style={{
                          width: `${job.percent}%`,
                          height: "100%",
                          background: "rgba(72,116,255,0.85)",
                          borderRadius: 2,
                          transition: "width 0.6s ease"
                        }}
                      />
                    </div>
                  </>
                )}
              </div>
            ))}

            {/* Completed docs */}
            {docs
              .filter((d) => !activeDocIds.has(d.document_id))
              .map((d) => (
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
          <div style={{ fontSize: 12, opacity: 0.7 }}>Searches across all uploaded PDFs</div>
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
                    {" "}| 60s: {llmStats.rolling_60s.rpm ?? 0} RPM · {llmStats.rolling_60s.tpm_total_est ?? 0} TPM
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
                      <div
                        key={d.document_id}
                        style={{
                          display: "flex",
                          alignItems: "flex-start",
                          gap: 10,
                          padding: 10,
                          borderRadius: 12,
                          border: "1px solid rgba(255,255,255,0.08)",
                          background: checked ? "rgba(72, 116, 255, 0.14)" : "rgba(255,255,255,0.03)",
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
                          style={{ marginTop: 4, cursor: "pointer", flexShrink: 0 }}
                        />
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div style={{ fontSize: 13, fontWeight: 650, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {d.filename}
                          </div>
                          <div style={{ fontSize: 12, opacity: 0.75, marginTop: 2 }}>
                            {d.page_count ?? "?"} pages · {d.chunks_indexed ?? "?"} chunks
                            {(d.ocr_requested_pages ?? 0) > 0 && (
                              <span style={{ marginLeft: 6, opacity: 0.6 }}>
                                · OCR {d.ocr_filled_pages}/{d.ocr_requested_pages}
                              </span>
                            )}
                          </div>
                        </div>
                        <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                          <button
                            title={d.locked ? "Unlock document" : "Lock document"}
                            onClick={() => handleToggleLock(d.document_id)}
                            style={{
                              background: "none", border: "none", cursor: "pointer",
                              fontSize: 14, opacity: 0.7, padding: "2px 4px", color: "inherit"
                            }}
                          >
                            {d.locked ? "🔒" : "🔓"}
                          </button>
                          {!d.locked && (
                            <button
                              title="Delete document"
                              onClick={() => handleDelete(d.document_id)}
                              style={{
                                background: "none", border: "none", cursor: "pointer",
                                fontSize: 14, opacity: 0.7, padding: "2px 4px", color: "inherit"
                              }}
                            >
                              🗑️
                            </button>
                          )}
                        </div>
                      </div>
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
                style={{ alignSelf: m.role === "user" ? "flex-end" : "flex-start", maxWidth: "95%" }}
              >
                <div
                  style={{
                    padding: "10px 12px",
                    borderRadius: 12,
                    lineHeight: 1.4,
                    border: "1px solid rgba(255,255,255,0.10)",
                    background: m.role === "user" ? "rgba(72, 116, 255, 0.18)" : "rgba(255,255,255,0.04)"
                  }}
                >
                  {m.role === "assistant" ? (
                    <div style={{ color: "#e7eefc" }} className="md">
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
            <div style={{ marginTop: 10, maxWidth: 920, display: "flex", flexWrap: "wrap", gap: 8 }}>
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
