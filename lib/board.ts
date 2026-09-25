export type BoardStock = {
  ticker: string;
  name: string;
  changePct: number;
  badge: string;
  reason: string;
  spark: string;
};

export type BoardFallback = "missing_key" | "upstream" | null;

export type BoardResponse = {
  dateLabel: string;
  isoDate: string;
  source: "live" | "mock";
  fallback: BoardFallback;
  maxScale: number;
  gainers: BoardStock[];
  losers: BoardStock[];
};

export function maxScaleFor(changes: number[]) {
  const peak = Math.max(0, ...changes.map((value) => Math.abs(value)));
  return Math.ceil(peak / 10) * 10;
}

export function marketDate(session: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).formatToParts(session);

  const grab = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";

  const isoDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(session);

  return {
    dateLabel: `${grab("day")} ${grab("month").toUpperCase()} ${grab("year")}`,
    isoDate,
  };
}

export function formatChange(pct: number) {
  const rounded = Number(pct.toFixed(1));
  const body = Math.abs(rounded).toFixed(1);
  if (rounded > 0) return `+${body}%`;
  if (rounded < 0) return `-${body}%`;
  return "0.0%";
}

export function mockBoard(fallback: Exclude<BoardFallback, null>): BoardResponse {
  const gainers: BoardStock[] = [
    {
      ticker: "NVDA",
      name: "NVIDIA Corporation",
      changePct: 14.6,
      badge: "",
      reason: "Hyperscaler orders reset the GPU demand curve into the close.",
      spark: "M0 32 C 18 30, 32 22, 48 18 C 64 14, 78 8, 100 4",
    },
    {
      ticker: "MU",
      name: "Micron Technology, Inc.",
      changePct: 8.4,
      badge: "",
      reason: "Spot DRAM tightness reprices the memory complex across the session.",
      spark: "M0 30 C 20 28, 36 22, 52 18 C 68 14, 82 12, 100 8",
    },
    {
      ticker: "COST",
      name: "Costco Wholesale Corporation",
      changePct: 4.2,
      badge: "",
      reason: "Membership renewal rates and higher tickets beat a tired tape.",
      spark: "M0 26 C 22 25, 40 20, 58 18 C 74 16, 88 14, 100 12",
    },
  ];
  const losers: BoardStock[] = [
    {
      ticker: "LRCX",
      name: "Lam Research Corporation",
      changePct: -9.1,
      badge: "",
      reason: "Foundry capex slips and etch tool orders get cut again.",
      spark: "M0 6 C 18 8, 34 16, 50 22 C 66 28, 82 34, 100 36",
    },
    {
      ticker: "INTC",
      name: "Intel Corporation",
      changePct: -6.7,
      badge: "",
      reason: "Foundry losses widen again as the manufacturing roadmap slips further.",
      spark: "M0 10 C 20 12, 36 18, 52 24 C 68 30, 84 34, 100 36",
    },
    {
      ticker: "SBUX",
      name: "Starbucks Corporation",
      changePct: -4.8,
      badge: "",
      reason: "China comps fade while store labor costs keep biting margins.",
      spark: "M0 12 C 22 14, 40 18, 56 22 C 72 26, 86 30, 100 32",
    },
  ];

  return {
    dateLabel: "NO SESSION",
    isoDate: "undated",
    source: "mock",
    fallback,
    maxScale: maxScaleFor([...gainers, ...losers].map((stock) => stock.changePct)),
    gainers,
    losers,
  };
}
