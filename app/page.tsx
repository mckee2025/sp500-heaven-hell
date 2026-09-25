"use client";

import { BoardCard } from "@/components/board-card";
import { mockBoard, type BoardResponse } from "@/lib/board";
import { useCallback, useEffect, useRef, useState } from "react";

const POSTER_SIZE = 800;

function tickerFromLogo(src: string) {
  try {
    const url = new URL(src);
    const symbol = url.pathname.match(/\/logos\/symbol\/([^/]+)/);
    if (symbol) return decodeURIComponent(symbol[1]);
    const fallback = url.pathname.match(/\/image-stock\/([^/.]+)/);
    if (fallback) return decodeURIComponent(fallback[1]);
  } catch {
    return "";
  }
  return "";
}

function rasterizeSvg(svg: string, size: number, ratio: number) {
  return new Promise<string>((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = size * ratio;
      canvas.height = size * ratio;
      const context = canvas.getContext("2d");
      if (!context) {
        reject(new Error("canvas"));
        return;
      }
      context.fillStyle = "#070b10";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/png"));
    };
    image.onerror = () => reject(new Error("svg"));
    image.src = svg;
  });
}

function rasterizeLogo(image: HTMLImageElement) {
  if (!image.naturalWidth) return image.src;
  const canvas = document.createElement("canvas");
  canvas.width = 80;
  canvas.height = 80;
  const context = canvas.getContext("2d");
  if (!context) return image.src;
  context.drawImage(image, 0, 0, 80, 80);
  try {
    return canvas.toDataURL("image/png");
  } catch {
    return image.src;
  }
}

async function inlineLogos(node: HTMLElement) {
  const images = [...node.querySelectorAll("img")];
  const originals = images.map((image) => image.currentSrc || image.src);

  await Promise.all(
    images.map(async (image) => {
      const ticker = tickerFromLogo(image.currentSrc || image.src);
      if (!ticker) return;
      const response = await fetch(`/api/logo/${encodeURIComponent(ticker)}`);
      if (!response.ok) return;
      const blob = await response.blob();
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
      await new Promise<void>((resolve) => {
        image.onload = () => resolve();
        image.onerror = () => resolve();
        image.src = dataUrl;
        if (image.complete && image.naturalWidth > 0) resolve();
      });
      image.src = rasterizeLogo(image);
    }),
  );

  return () => {
    images.forEach((image, index) => {
      image.src = originals[index];
    });
  };
}

export default function HomePage() {
  const cardRef = useRef<HTMLDivElement>(null);
  const [board, setBoard] = useState<BoardResponse>(() => mockBoard("missing_key"));
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [message, setMessage] = useState("正在同步今日榜单…");
  const [scale, setScale] = useState(1);

  const refresh = useCallback(async () => {
    setLoading(true);
    setMessage("正在拉取今日行情…");

    try {
      const response = await fetch("/api/board", {
        cache: "no-store",
        signal: AbortSignal.timeout(55000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = (await response.json()) as BoardResponse;
      if (
        !Array.isArray(payload?.gainers) ||
        payload.gainers.length < 3 ||
        !Array.isArray(payload?.losers) ||
        payload.losers.length < 3
      ) {
        throw new Error("incomplete board");
      }
      setBoard(payload);
      setMessage(statusCopy(payload));
    } catch {
      setBoard(mockBoard("upstream"));
      setMessage("网络异常，已回退到演示海报。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const fit = () => {
      const available = Math.min(window.innerWidth - 32, POSTER_SIZE);
      setScale(Math.max(0.42, available / POSTER_SIZE));
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  async function downloadPng() {
    const node = cardRef.current;
    if (!node) return;
    setExporting(true);
    setMessage("正在导出 1:1 高清 PNG…");
    const restoreLogos = await inlineLogos(node);
    try {
      const { toSvg } = await import("html-to-image");
      const svg = await toSvg(node, {
        width: POSTER_SIZE,
        height: POSTER_SIZE,
        backgroundColor: "#070b10",
      });
      const dataUrl = await rasterizeSvg(svg, POSTER_SIZE, 3);
      const link = document.createElement("a");
      link.href = dataUrl;
      link.download = `sp500-heaven-hell-${board.isoDate}.png`;
      link.click();
      setMessage("海报已下载。");
    } catch {
      setMessage("PNG 导出失败，请再试一次。");
    } finally {
      restoreLogos();
      setExporting(false);
    }
  }

  const frame = POSTER_SIZE * scale;

  return (
    <main className="min-h-screen bg-[#05070b] px-4 py-10 text-zinc-100">
      <div className="mx-auto flex w-full max-w-[860px] flex-col items-center">
        <div className="mb-6 grid w-full max-w-[800px] gap-3 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
            className="inline-flex h-12 items-center justify-center gap-2 rounded-md border border-emerald-400/40 bg-emerald-400/10 px-4 font-medium text-emerald-100 transition hover:bg-emerald-400/20 disabled:cursor-wait disabled:opacity-60"
          >
            <span aria-hidden className={loading ? "inline-block animate-spin" : ""}>
              🔄
            </span>
            刷新今日数据
          </button>
          <button
            type="button"
            onClick={() => void downloadPng()}
            disabled={exporting || loading}
            className="inline-flex h-12 items-center justify-center gap-2 rounded-md border border-white/15 bg-white/5 px-4 font-medium text-zinc-100 transition hover:bg-white/10 disabled:cursor-wait disabled:opacity-60"
          >
            <span aria-hidden>📸</span>
            下载 1:1 高清 PNG 海报
          </button>
        </div>
        <p className="mb-4 text-center font-mono text-[12px] text-zinc-500">{message}</p>

        <div
          className="overflow-hidden shadow-[0_24px_80px_rgba(0,0,0,0.55)]"
          style={{ width: frame, height: frame }}
        >
          <div
            style={{
              width: POSTER_SIZE,
              height: POSTER_SIZE,
              transform: `scale(${scale})`,
              transformOrigin: "top left",
            }}
          >
            <BoardCard ref={cardRef} board={board} />
          </div>
        </div>
      </div>
    </main>
  );
}

function statusCopy(board: BoardResponse) {
  if (board.source === "live") return `今日榜已更新 · [SCALE: ±${board.maxScale}%]`;
  if (board.fallback === "upstream") return "行情或模型请求失败，已回退到演示数据。";
  return "未配置 Gemini API Key，当前展示演示数据。";
}
