import { mockBoard } from "@/lib/board";
import { buildLiveBoard } from "@/lib/market";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET() {
  return respond();
}

export async function POST() {
  return respond();
}

async function respond() {
  try {
    return json(await buildLiveBoard(process.env.GEMINI_API_KEY?.trim() ?? ""));
  } catch (error) {
    console.error(
      "[board] quotes unavailable, using mock:",
      error instanceof Error ? error.message : "unknown",
    );
    return json(mockBoard("upstream"));
  }
}

function json(body: unknown) {
  return NextResponse.json(body, {
    headers: { "Cache-Control": "no-store" },
  });
}
