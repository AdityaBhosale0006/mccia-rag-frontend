"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

const PASSWORD_RULES = ["At least 8 characters", "At least 1 letter (A–Z)", "At least 1 number (0–9)"] as const;

export default function RegisterPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = useMemo(() => email.trim().length > 3 && password.length >= 8, [email, password]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit || loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password })
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.detail ?? "Registration failed");
      router.replace("/");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Registration failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        padding: 16,
        background:
          "radial-gradient(1100px 700px at 80% 0%, rgba(72,116,255,0.22), transparent 60%), radial-gradient(900px 600px at 10% 30%, rgba(255,255,255,0.08), transparent 55%)"
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 440,
          borderRadius: 18,
          border: "1px solid rgba(255,255,255,0.12)",
          background: "rgba(0,0,0,0.25)",
          padding: 18
        }}
      >
        <div style={{ fontSize: 12, opacity: 0.7 }}>Internal PDF RAG</div>
        <div style={{ fontSize: 22, fontWeight: 750, marginTop: 6 }}>Register</div>
        <div style={{ fontSize: 13, opacity: 0.72, marginTop: 6 }}>
          Create an account to upload PDFs and chat with them.
        </div>

        <div style={{ marginTop: 14, padding: 12, borderRadius: 14, border: "1px solid rgba(255,255,255,0.10)", background: "rgba(255,255,255,0.03)" }}>
          <div style={{ fontSize: 12, opacity: 0.75, fontWeight: 650 }}>Password requirements (3)</div>
          <ul style={{ margin: "8px 0 0 18px", padding: 0, fontSize: 13, opacity: 0.78 }}>
            {PASSWORD_RULES.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>

        <form onSubmit={onSubmit} style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 14 }}>
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            type="email"
            autoComplete="email"
            placeholder="Email"
            style={{
              padding: "12px 12px",
              borderRadius: 12,
              border: "1px solid rgba(255,255,255,0.12)",
              background: "rgba(255,255,255,0.03)",
              color: "inherit",
              outline: "none"
            }}
          />
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            type="password"
            autoComplete="new-password"
            placeholder="Password"
            style={{
              padding: "12px 12px",
              borderRadius: 12,
              border: "1px solid rgba(255,255,255,0.12)",
              background: "rgba(255,255,255,0.03)",
              color: "inherit",
              outline: "none"
            }}
          />

          {error ? (
            <div style={{ fontSize: 13, color: "#ffb4b4", border: "1px solid rgba(255,180,180,0.25)", padding: 10, borderRadius: 12 }}>
              {error}
            </div>
          ) : null}

          <button
            type="submit"
            disabled={!canSubmit || loading}
            style={{
              padding: "12px 14px",
              borderRadius: 12,
              border: "1px solid rgba(255,255,255,0.12)",
              background: !canSubmit || loading ? "rgba(255,255,255,0.03)" : "rgba(72, 116, 255, 0.28)",
              color: "inherit",
              cursor: !canSubmit || loading ? "not-allowed" : "pointer",
              fontWeight: 750
            }}
          >
            {loading ? "Creating account…" : "Create account"}
          </button>
        </form>

        <div style={{ marginTop: 12, fontSize: 13, opacity: 0.78 }}>
          Already have an account? <Link href="/signin">Sign in</Link>
        </div>
      </div>
    </div>
  );
}

