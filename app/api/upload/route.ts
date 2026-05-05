import { NextResponse } from "next/server";

// Edge runtime streams the request body directly to the backend — no 4.5 MB serverless limit.
export const runtime = "edge";

const BACKEND = process.env.BACKEND_URL ?? "http://127.0.0.1:8000";

export async function POST(req: Request) {
  const cookie = req.headers.get("cookie") ?? "";
  const incoming = await req.formData();
  const file = incoming.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing file" }, { status: 400 });
  }

  const out = new FormData();
  out.append("file", file, file.name);

  const res = await fetch(`${BACKEND}/upload`, {
    method: "POST",
    body: out,
    headers: cookie ? { cookie } : undefined
  });
  const body = await res.text();
  return new NextResponse(body, {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" }
  });
}
