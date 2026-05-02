import { NextResponse } from "next/server";

const BACKEND = process.env.BACKEND_URL ?? "http://127.0.0.1:8000";

export async function POST(req: Request) {
  const json = await req.text();
  const res = await fetch(`${BACKEND}/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: json
  });

  const body = await res.text();
  const out = new NextResponse(body, {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" }
  });

  const setCookie = res.headers.get("set-cookie");
  if (setCookie) out.headers.set("set-cookie", setCookie);
  return out;
}

