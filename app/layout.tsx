import type { Metadata } from "next";
import { Providers } from "@/components/providers";

export const metadata: Metadata = {
  title: "Internal PDF RAG",
  description: "Upload PDFs and chat across all documents."
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily:
            'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"',
          background: "#0b0f17",
          color: "#e7eefc"
        }}
      >
        <style>{`
          .md :where(h2,h3) { margin: 10px 0 6px; }
          .md h2 { font-size: 16px; }
          .md h3 { font-size: 14px; opacity: 0.95; }
          .md p { margin: 6px 0; }
          .md ul, .md ol { margin: 6px 0 6px 18px; }
          .md li { margin: 4px 0; }
          .md code { background: rgba(255,255,255,0.08); padding: 2px 6px; border-radius: 8px; }
          .md pre { background: rgba(0,0,0,0.35); padding: 10px 12px; border-radius: 12px; overflow: auto; }
          .md table { border-collapse: collapse; margin: 8px 0; width: 100%; }
          .md th, .md td { border: 1px solid rgba(255,255,255,0.14); padding: 8px; vertical-align: top; }
          .md th { background: rgba(255,255,255,0.06); text-align: left; }
          .md a { color: #a9c3ff; }
          .md strong { color: #ffffff; }
        `}</style>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}

