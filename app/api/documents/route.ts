import { NextResponse } from "next/server";

const BACKEND = process.env.BACKEND_URL ?? "http://127.0.0.1:8000";

export async function GET(req: Request) {
  const cookie = req.headers.get("cookie") ?? "";
  const res = await fetch(`${BACKEND}/documents`, {
    cache: "no-store",
    headers: cookie ? { cookie } : undefined
  });
  const body = await res.text();
  return new NextResponse(body, {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" }
  });
}
