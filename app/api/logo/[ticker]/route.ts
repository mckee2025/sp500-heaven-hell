import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: { ticker: string } },
) {
  const ticker = params.ticker.replace(/[^A-Za-z0-9.-]/g, "").toUpperCase();
  if (!ticker) return new NextResponse(null, { status: 400 });

  const sources = [
    `https://assets.parqet.com/logos/symbol/${ticker}`,
    `https://financialmodelingprep.com/image-stock/${ticker}.png`,
  ];

  for (const url of sources) {
    try {
      const response = await fetch(url, { next: { revalidate: 60 * 60 * 24 } });
      if (!response.ok) continue;
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength < 32) continue;
      return new NextResponse(bytes, {
        headers: {
          "Content-Type": response.headers.get("content-type") || "image/png",
          "Cache-Control": "public, max-age=86400",
        },
      });
    } catch {
      continue;
    }
  }

  return new NextResponse(null, { status: 404 });
}
