import { formatChange, type BoardResponse, type BoardStock } from "@/lib/board";
import { cn } from "@/lib/utils";
import { forwardRef } from "react";

type Tone = "up" | "down";

type BoardCardProps = {
  board: BoardResponse;
};

export const BoardCard = forwardRef<HTMLDivElement, BoardCardProps>(function BoardCard(
  { board },
  ref,
) {
  const gainers = board.gainers.slice(0, 3);
  const losers = board.losers.slice(0, 3);
  const maxScale =
    board.maxScale > 0
      ? board.maxScale
      : Math.ceil(
          Math.max(0, ...[...gainers, ...losers].map((stock) => Math.abs(stock.changePct))) / 10,
        ) * 10;

  return (
    <div
      ref={ref}
      className="relative box-border flex h-[800px] w-[800px] shrink-0 flex-col overflow-hidden border border-white/10 p-6 text-zinc-100"
      style={{
        backgroundColor: "#070b10",
        backgroundImage: [
          "linear-gradient(rgba(148,163,184,0.05) 1px, transparent 1px)",
          "linear-gradient(90deg, rgba(148,163,184,0.05) 1px, transparent 1px)",
          "radial-gradient(ellipse at 18% 46%, rgba(56,182,255,0.12), transparent 42%)",
          "radial-gradient(ellipse at 82% 46%, rgba(255,0,102,0.12), transparent 42%)",
        ].join(", "),
        backgroundSize: "32px 32px, 32px 32px, 100% 100%, 100% 100%",
      }}
    >
      <CornerMarks />

      <header className="shrink-0">
        <div className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 items-center">
            <img
              src="/logo.png"
              alt="Tutudata Logo"
              className="mr-3 inline-block h-8 w-8 object-contain"
            />
            <h1 className="min-w-0 text-left font-sans text-[32px] font-black leading-none tracking-tight">
              <span className="text-slate-100">S&P 500 </span>
              <span className="text-[#38b6ff]">HEAVEN</span>
              <span className="text-slate-500"> & </span>
              <span className="text-[#ff0066]">HELL</span>
            </h1>
          </div>
          <div className="shrink-0 font-sans text-lg font-black leading-none tracking-tight text-slate-100">
            {board.dateLabel}
          </div>
        </div>
      </header>

      <div className="mt-5 grid min-h-0 flex-1 grid-cols-2 gap-4">
        <SideColumn title="TOP 3 GAINERS" tone="up" stocks={gainers} maxScale={maxScale} />
        <SideColumn title="TOP 3 LOSERS" tone="down" stocks={losers} maxScale={maxScale} />
      </div>

      <footer className="mt-3 shrink-0 text-center font-sans text-[13px] font-semibold leading-snug text-slate-100">
        Follow <span className="text-[#38b6ff]">@tutudataai</span> for daily S&P 500 Heaven & Hell updates
      </footer>
    </div>
  );
});

function SideColumn({
  title,
  tone,
  stocks,
  maxScale,
}: {
  title: string;
  tone: Tone;
  stocks: BoardStock[];
  maxScale: number;
}) {
  const up = tone === "up";

  return (
    <section className="flex min-h-0 flex-col">
      <div className="mb-2 flex shrink-0 items-baseline justify-between gap-2">
        <h2
          className={cn(
            "whitespace-nowrap font-mono text-[12px] font-bold tracking-[0.16em]",
            up ? "text-[#38b6ff]" : "text-[#ff0066]",
          )}
        >
          <span
            aria-hidden
            className={cn(
              "mr-1.5 inline-block h-2 w-2 rounded-full align-middle",
              up ? "bg-[#38b6ff] shadow-[0_0_8px_#38b6ff]" : "bg-[#ff0066] shadow-[0_0_8px_#ff0066]",
            )}
          />
          {title}
        </h2>
        <span className="whitespace-nowrap rounded-sm border border-white/15 bg-white/[0.04] px-1.5 py-px font-mono text-[10px] tracking-[0.16em] text-slate-300">
          [SCALE: ±{maxScale}%]
        </span>
      </div>
      <div className="grid min-h-0 flex-1 grid-rows-3 gap-2">
        {stocks.map((stock, index) => (
          <StockCard key={stock.ticker} stock={stock} rank={index + 1} tone={tone} maxScale={maxScale} />
        ))}
      </div>
    </section>
  );
}

function StockCard({
  stock,
  rank,
  tone,
  maxScale,
}: {
  stock: BoardStock;
  rank: number;
  tone: Tone;
  maxScale: number;
}) {
  const up = tone === "up";
  const width = maxScale > 0 ? (Math.abs(stock.changePct) / maxScale) * 100 : 0;

  return (
    <article
      className={cn(
        "relative flex h-full min-h-[155px] flex-col justify-between overflow-hidden border-t p-3.5 shadow-[0_14px_28px_rgba(0,0,0,0.32)]",
        up
          ? "border-t-[#38b6ff]/40 bg-[linear-gradient(180deg,rgba(56,182,255,0.16),rgba(56,182,255,0.04))]"
          : "border-t-[#ff0066]/40 bg-[linear-gradient(180deg,rgba(255,0,102,0.16),rgba(255,0,102,0.04))]",
        rank === 1 &&
          (up
            ? "border-l-4 border-l-[#38b6ff] shadow-[inset_8px_0_18px_rgba(56,182,255,0.28),0_14px_28px_rgba(0,0,0,0.32)]"
            : "border-l-4 border-l-[#ff0066] shadow-[inset_8px_0_18px_rgba(255,0,102,0.28),0_14px_28px_rgba(0,0,0,0.32)]"),
      )}
    >
      <div className="relative z-10 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <BrandLogo ticker={stock.ticker} />
          <div className="min-w-0">
            <div className="whitespace-nowrap font-wide text-2xl font-black uppercase leading-none tracking-tight text-white">
              ${stock.ticker}
            </div>
            <p className="mt-1 truncate text-[11px] leading-none text-slate-400">{stock.name}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <MiniSparkline tone={tone} d={stock.spark} />
          <span
            className={cn(
              "font-sans text-3xl font-black leading-none tracking-tight",
              up ? "text-[#38b6ff]" : "text-[#ff0066]",
            )}
          >
            {formatChange(stock.changePct)}
          </span>
        </div>
      </div>
      <div className="relative z-10 my-1 flex flex-1 items-center">
        <p className="text-left text-lg font-black leading-snug tracking-tight text-slate-100">
          {stock.reason}
        </p>
      </div>
      <div className="relative z-10 mt-auto h-1.5 w-full rounded-full bg-black/45">
        <div
          className={cn("relative h-full rounded-full", up ? "bg-[#38b6ff]" : "bg-[#ff0066]")}
          style={{ width: `${width}%` }}
        >
          <span
            className={cn(
              "absolute -right-px top-1/2 h-0.5 w-0.5 -translate-y-1/2 rounded-full",
              up
                ? "bg-white shadow-[0_0_6px_2px_rgba(56,182,255,0.95)]"
                : "bg-white shadow-[0_0_6px_2px_rgba(255,0,102,0.95)]",
            )}
          />
        </div>
      </div>
    </article>
  );
}

function BrandLogo({ ticker }: { ticker: string }) {
  const primary = `https://assets.parqet.com/logos/symbol/${ticker}`;
  const fallback = `https://financialmodelingprep.com/image-stock/${ticker}.png`;

  return (
    <img
      src={primary}
      alt=""
      width={40}
      height={40}
      className="h-10 w-10 shrink-0 rounded-lg border border-slate-700/80 bg-slate-800/80 object-contain p-1"
      onError={(event) => {
        const image = event.currentTarget;
        if (image.src !== fallback) image.src = fallback;
      }}
    />
  );
}

function MiniSparkline({ tone, d }: { tone: Tone; d: string }) {
  return (
    <svg className="h-8 w-14 shrink-0" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden>
      <path
        d={d}
        fill="none"
        stroke={tone === "up" ? "#38b6ff" : "#ff0066"}
        strokeWidth="2.25"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function CornerMarks() {
  const mark = "pointer-events-none absolute h-3.5 w-3.5";
  return (
    <>
      <span className={cn(mark, "left-3 top-3 border-l border-t border-[#38b6ff]/35")} />
      <span className={cn(mark, "right-3 top-3 border-r border-t border-[#38b6ff]/35")} />
      <span className={cn(mark, "bottom-3 left-3 border-b border-l border-[#ff0066]/35")} />
      <span className={cn(mark, "bottom-3 right-3 border-b border-r border-[#ff0066]/35")} />
    </>
  );
}
