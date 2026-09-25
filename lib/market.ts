import { GoogleGenerativeAI } from "@google/generative-ai";
import { marketDate, maxScaleFor, type BoardResponse, type BoardStock } from "@/lib/board";
import YahooFinance from "yahoo-finance2";

const CONSTITUENTS_URL =
  "https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv";

const yahooFinance = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

type Constituent = {
  symbol: string;
  yahoo: string;
  name: string;
  sector: string;
};

type Quote = {
  symbol: string;
  yahoo: string;
  name: string;
  sector: string;
  changePct: number;
  marketTime: Date | null;
};

const GEMINI_MODELS = ["gemini-2.0-flash", "gemini-1.5-flash", "gemini-1.5-flash-8b"] as const;
const FLAT_SPARK = "M0 20 C 33 20, 66 20, 100 20";
const SPARK_SAMPLES = 14;
const SEO_HEADLINE =
  /why\s+.+\sis\s+up|why\s+.+\s(shares|stock)\s+are|here\s+is\s+why|stock\s+trades\s+down|is\s+.+\sa\s+buy|looks\s+fairly\s+valued|become fully priced/i;
const JUNK_TITLE_TERMS = [
  "side gigs",
  "burnout",
  "z世代",
  "millennials",
  "why ",
  "what's behind",
  "key insights",
  "is it a buy",
  "stock popped today",
];

let constituentCache: { at: number; rows: Constituent[] } | null = null;

export async function buildLiveBoard(apiKey: string): Promise<BoardResponse> {
  const quotes = await fetchSp500Quotes();
  if (quotes.length < 450) {
    throw new Error(`incomplete tape (${quotes.length})`);
  }

  const ranked = [...quotes].sort(
    (a, b) => b.changePct - a.changePct || a.symbol.localeCompare(b.symbol),
  );
  const gainers = ranked.slice(0, 3);
  const losers = ranked.slice(-3).reverse();
  const boardNames = [...gainers, ...losers];
  const session = latestSession(quotes);
  if (!session) throw new Error("missing regularMarketTime");
  const [headlines, sparks] = await Promise.all([
    loadHeadlines(boardNames),
    loadSparks(boardNames, session),
    applyDeskSectors(boardNames),
  ]);
  const reasons = await summarizeWithModelFallback(apiKey, boardNames, headlines);
  const { dateLabel, isoDate } = marketDate(session);
  const stocks = boardNames.map((quote) => toStock(quote, reasons, sparks));

  return {
    dateLabel,
    isoDate,
    source: "live",
    fallback: null,
    maxScale: maxScaleFor(stocks.map((stock) => stock.changePct)),
    gainers: stocks.slice(0, 3),
    losers: stocks.slice(3),
  };
}

function toStock(
  quote: Quote,
  reasons: Map<string, string>,
  sparks: Map<string, string>,
): BoardStock {
  return {
    ticker: quote.symbol,
    name: quote.name,
    changePct: quote.changePct,
    badge: "",
    reason: reasons.get(quote.symbol) || uniqueNarrative(quote, new Map()),
    spark: sparks.get(quote.symbol) || FLAT_SPARK,
  };
}

async function fetchSp500Quotes(): Promise<Quote[]> {
  const constituents = await getConstituents();
  const byYahoo = new Map<string, Constituent>();
  for (const row of constituents) {
    byYahoo.set(row.yahoo, row);
    byYahoo.set(row.symbol, row);
  }

  const batches = chunk(
    constituents.map((row) => row.yahoo),
    40,
  );
  const settled = await mapPool(batches, 4, (symbols) => withRetry(() => fetchQuoteBatch(symbols)));
  const quotes: Quote[] = [];

  for (const batch of settled) {
    for (const point of batch) {
      const row = byYahoo.get(point.symbol);
      if (!row || !Number.isFinite(point.changePct)) continue;
      quotes.push({
        symbol: row.symbol,
        yahoo: row.yahoo,
        name: point.name || row.name,
        sector: row.sector,
        changePct: point.changePct,
        marketTime: point.marketTime,
      });
    }
  }

  return quotes;
}

async function fetchQuoteBatch(symbols: string[]) {
  const rows = await yahooFinance.quote(symbols, {
    fields: ["symbol", "shortName", "longName", "regularMarketChangePercent", "regularMarketTime"],
  });
  const list = Array.isArray(rows) ? rows : [rows];

  return list.flatMap((row) => {
    const changePct = row.regularMarketChangePercent;
    const symbol = row.symbol?.toUpperCase();
    if (!symbol || typeof changePct !== "number" || !Number.isFinite(changePct)) return [];
    const marketTime = row.regularMarketTime instanceof Date ? row.regularMarketTime : null;
    return [
      {
        symbol,
        name: row.longName || row.shortName || symbol,
        changePct,
        marketTime: marketTime && !Number.isNaN(marketTime.getTime()) ? marketTime : null,
      },
    ];
  });
}

async function getConstituents(): Promise<Constituent[]> {
  if (constituentCache && Date.now() - constituentCache.at < 12 * 60 * 60 * 1000) {
    return constituentCache.rows;
  }

  const response = await fetch(CONSTITUENTS_URL, {
    cache: "no-store",
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error(`constituents HTTP ${response.status}`);
  const rows = parseConstituents(await response.text());
  if (rows.length < 400) throw new Error("constituent list too short");
  constituentCache = { at: Date.now(), rows };
  return rows;
}

function parseConstituents(csv: string): Constituent[] {
  const lines = csv.trim().split(/\r?\n/);
  const header = parseCsvLine(lines[0] ?? "");
  const symbolIdx = header.indexOf("Symbol");
  const nameIdx = header.indexOf("Security");
  const sectorIdx = header.indexOf("GICS Sector");
  if (symbolIdx < 0 || nameIdx < 0) throw new Error("unexpected constituents csv");

  const rows: Constituent[] = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const cells = parseCsvLine(line);
    const symbol = (cells[symbolIdx] ?? "").trim().toUpperCase();
    const name = (cells[nameIdx] ?? "").trim();
    if (!symbol) continue;
    rows.push({
      symbol,
      yahoo: symbol.replace(/\./g, "-"),
      name: name || symbol,
      sector: (cells[sectorIdx] ?? "").trim() || "its sector",
    });
  }
  return rows;
}

function parseCsvLine(line: string) {
  const cells: string[] = [];
  let current = "";
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  cells.push(current);
  return cells;
}

async function applyDeskSectors(quotes: Quote[]) {
  await mapPool(quotes, 3, async (quote) => {
    quote.sector = await liveSector(quote);
  });
}

async function liveSector(quote: Quote) {
  try {
    const summary = await yahooFinance.quoteSummary(quote.yahoo, { modules: ["assetProfile"] });
    const profile = summary.assetProfile;
    return deskSector(profile?.sectorDisp || profile?.sector || "", profile?.industryDisp || profile?.industry || "", quote.sector);
  } catch (error) {
    console.error(
      `[board] sector ${quote.symbol} failed:`,
      error instanceof Error ? error.message : "unknown",
    );
    return deskSector("", "", quote.sector);
  }
}

function deskSector(sector: string, industry: string, fallback: string) {
  const sectorName = sector.trim();
  const industryName = industry.trim();
  if (/solar/i.test(industryName)) return "Solar";
  if (/energy/i.test(industryName)) return "Energy";
  if (/^energy$/i.test(sectorName)) return "Energy";
  if (sectorName) return sectorName;
  return friendlyGics(fallback);
}

function friendlyGics(value: string) {
  const mapped: Record<string, string> = {
    "information technology": "Technology",
    "health care": "Healthcare",
    "consumer discretionary": "Consumer Cyclical",
    "consumer staples": "Consumer Defensive",
    "communication services": "Communication Services",
    financials: "Financial Services",
    "real estate": "Real Estate",
    materials: "Basic Materials",
    industrials: "Industrials",
    utilities: "Utilities",
    energy: "Energy",
  };
  return mapped[value.trim().toLowerCase()] || value.trim() || "the group";
}

function latestSession(quotes: Quote[]) {
  const times = quotes.flatMap((quote) =>
    quote.marketTime && !Number.isNaN(quote.marketTime.getTime()) ? [quote.marketTime.getTime()] : [],
  );
  if (times.length === 0) return null;
  return new Date(Math.max(...times));
}

function nyDateKey(session: Date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(session);
}

function shiftDateKey(isoDate: string, days: number) {
  const [year, month, day] = isoDate.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

async function loadSparks(quotes: Quote[], session: Date) {
  try {
    const pairs = await mapPool(quotes, 3, (quote) => fetchSpark(quote, session));
    return new Map(pairs);
  } catch (error) {
    console.error("[board] sparklines failed:", error instanceof Error ? error.message : "unknown");
    return new Map<string, string>();
  }
}

async function fetchSpark(quote: Quote, session: Date): Promise<[string, string]> {
  const sessionDay = nyDateKey(session);
  try {
    const chart = await yahooFinance.chart(quote.yahoo, {
      period1: sessionDay,
      period2: shiftDateKey(sessionDay, 1),
      interval: "5m",
      includePrePost: false,
    });
    const closes = chart.quotes.flatMap((bar) =>
      typeof bar.close === "number" &&
      Number.isFinite(bar.close) &&
      bar.date instanceof Date &&
      nyDateKey(bar.date) === sessionDay
        ? [bar.close]
        : [],
    );
    return [quote.symbol, sparklinePath(closes)];
  } catch (error) {
    console.error(
      `[board] chart ${quote.symbol} failed:`,
      error instanceof Error ? error.message : "unknown",
    );
    return [quote.symbol, FLAT_SPARK];
  }
}

function sparklinePath(closes: number[]) {
  const samples = downsample(closes, SPARK_SAMPLES);
  if (samples.length < 2) return FLAT_SPARK;
  const min = Math.min(...samples);
  const max = Math.max(...samples);
  const span = max - min;
  const points = samples.map((price, index) => ({
    x: (index / (samples.length - 1)) * 100,
    y: span === 0 ? 20 : 40 - ((price - min) / span) * 40,
  }));
  return smoothPath(points);
}

function downsample(closes: number[], count: number) {
  if (closes.length <= count) return closes;
  return Array.from({ length: count }, (_, index) => {
    const position = (index / (count - 1)) * (closes.length - 1);
    const left = Math.floor(position);
    const right = Math.min(closes.length - 1, left + 1);
    const weight = position - left;
    return closes[left] * (1 - weight) + closes[right] * weight;
  });
}

function smoothPath(points: { x: number; y: number }[]) {
  const fmt = (value: number) => value.toFixed(1);
  let path = `M${fmt(points[0].x)} ${fmt(points[0].y)}`;
  for (let index = 0; index < points.length - 1; index += 1) {
    const previous = points[index - 1] ?? points[index];
    const start = points[index];
    const end = points[index + 1];
    const next = points[index + 2] ?? end;
    const cp1x = start.x + (end.x - previous.x) / 6;
    const cp1y = start.y + (end.y - previous.y) / 6;
    const cp2x = end.x - (next.x - start.x) / 6;
    const cp2y = end.y - (next.y - start.y) / 6;
    path += ` C ${fmt(cp1x)} ${fmt(cp1y)}, ${fmt(cp2x)} ${fmt(cp2y)}, ${fmt(end.x)} ${fmt(end.y)}`;
  }
  return path;
}

type DeskNews = {
  title: string;
  summary: string;
};

async function loadHeadlines(quotes: Quote[]) {
  try {
    return await fetchHeadlines(quotes);
  } catch (error) {
    console.error(
      "[board] headlines failed:",
      error instanceof Error ? error.message : "unknown",
    );
    return new Map<string, DeskNews[]>();
  }
}

async function fetchHeadlines(quotes: Quote[]) {
  const pairs = await mapPool(quotes, 3, async (quote) => {
    try {
      const primary = await searchNews(quote.yahoo, quote);
      if (primary.length >= 2) return [quote.symbol, primary] as [string, DeskNews[]];
      const extra = await searchNews(`${quote.symbol} stock price action`, quote);
      return [quote.symbol, dedupeNews([...primary, ...extra]).slice(0, 5)] as [string, DeskNews[]];
    } catch {
      return [quote.symbol, []] as [string, DeskNews[]];
    }
  });

  return new Map(pairs);
}

async function searchNews(query: string, quote: Quote) {
  const result = await yahooFinance.search(query, { newsCount: 5 });
  return (result.news ?? [])
    .map((item) => readNews(item))
    .filter(
      (item) =>
        item.title &&
        mentionsTicker(quote, `${item.title} ${item.summary}`) &&
        !isJunkTitle(item.title),
    );
}

function dedupeNews(items: DeskNews[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.title.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function readNews(item: { title?: string; [key: string]: unknown }): DeskNews {
  const title = item.title?.trim() ?? "";
  const summary = ["summary", "description", "snippet"]
    .map((key) => item[key])
    .find((value): value is string => typeof value === "string" && value.trim().length > 0);
  return { title, summary: summary?.trim() ?? "" };
}

function mentionsTicker(quote: Quote, title: string) {
  const text = title.toLowerCase();
  const symbol = quote.symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`\\$${symbol}\\b|\\b${symbol}\\b`, "i").test(title)) return true;
  const tokens = quote.name
    .split(/[^A-Za-z0-9]+/)
    .filter((token) => token.length > 3)
    .filter((token) => !/^(inc|corp|corporation|company|group|holdings|systems|limited|class|common|the)$/i.test(token));
  return tokens.some((token) => text.includes(token.toLowerCase()));
}

const SENTENCE_BLACKLIST = [
  "no single",
  "explained the session",
  "no release",
  "no news",
  "insufficient information",
  "sympathy",
];

async function summarizeWithModelFallback(
  apiKey: string,
  quotes: Quote[],
  headlines: Map<string, DeskNews[]>,
) {
  const specific = new Map(quotes.map((quote) => [quote.symbol, headlines.get(quote.symbol) ?? []]));
  const accepted = new Map<string, string>();

  if (!apiKey) {
    console.error("[board] GEMINI_API_KEY missing, synthesizing desk lines");
    const drafted = new Map<string, string>();
    for (const quote of quotes) drafted.set(quote.symbol, uniqueNarrative(quote, drafted));
    return drafted;
  }

  const models: string[] = [...GEMINI_MODELS];
  const tried = new Set<string>();
  for (let index = 0; index < models.length && accepted.size < quotes.length; index += 1) {
    const modelName = models[index];
    if (tried.has(modelName)) continue;
    tried.add(modelName);
    const pending = quotes.filter((quote) => !accepted.has(quote.symbol));
    try {
      const notes = await generateDeskLines(apiKey, modelName, pending, specific);
      for (const quote of pending) {
        const reason = acceptReason(
          quote.symbol,
          notes.get(quote.symbol),
          accepted,
          specific.get(quote.symbol) ?? [],
        );
        if (reason) accepted.set(quote.symbol, reason);
      }
      if (pending.every((quote) => accepted.has(quote.symbol))) {
        console.info(`[board] reasons from ${modelName}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown";
      console.error(`[board] ${modelName} failed:`, message);
      const suggested = message.match(/use models\/(gemini-[\w.-]+)/i)?.[1];
      if (suggested && !tried.has(suggested) && !models.includes(suggested)) models.push(suggested);
    }
  }

  for (const quote of quotes) {
    if (!accepted.has(quote.symbol)) {
      console.error(`[board] ${quote.symbol} regenerated locally after blacklist or model failure`);
      accepted.set(quote.symbol, uniqueNarrative(quote, accepted));
    }
  }
  return accepted;
}

async function generateDeskLines(
  apiKey: string,
  modelName: string,
  quotes: Quote[],
  headlines: Map<string, DeskNews[]>,
) {
  const first = cleanNotes(
    reasonsFromModel(await callGemini(apiKey, modelName, boardPrompt(quotes, headlines))),
    headlines,
  );
  const missing = quotes.filter((quote) => !first.has(quote.symbol));
  if (missing.length === 0) return first;

  console.error(
    `[board] ${modelName} rejected ${missing.map((quote) => quote.symbol).join(",")}, regenerating`,
  );
  try {
    const second = cleanNotes(
      reasonsFromModel(
        await callGemini(
          apiKey,
          modelName,
          `${boardPrompt(missing, headlines)}\n\nThe previous draft was rejected because it copied a headline or asked a question. Rewrite each reason as one active sentence.`,
        ),
      ),
      headlines,
    );
    for (const [ticker, reason] of Array.from(second.entries())) first.set(ticker, reason);
  } catch (error) {
    console.error(
      `[board] ${modelName} regeneration failed:`,
      error instanceof Error ? error.message : "unknown",
    );
  }
  return first;
}

function boardPrompt(quotes: Quote[], headlines: Map<string, DeskNews[]>) {
  const blocks = quotes
    .map((quote) => catalystPrompt(quote, headlines.get(quote.symbol) ?? []))
    .join("\n\n");
  return [
    "Answer each stock independently. Never reuse another ticker's news.",
    blocks,
    'Return a JSON array only, one object per ticker: [{"ticker":"PANW","reason":"the single sentence"}]',
    "Each reason must be that stock's one sentence and nothing else.",
    "Do not include any percentage number. Do not reuse the same clause across tickers.",
  ].join("\n\n");
}

function reasonsFromModel(content: string) {
  const trimmed = content.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const parsed = JSON.parse(trimmed) as unknown;
  const notes = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object"
      ? ((parsed as { notes?: unknown; stocks?: unknown; items?: unknown }).notes ??
        (parsed as { stocks?: unknown }).stocks ??
        (parsed as { items?: unknown }).items)
      : null;
  if (!Array.isArray(notes)) throw new Error("model JSON missing array");

  const map = new Map<string, string>();
  for (const note of notes) {
    if (!note || typeof note !== "object") continue;
    const row = note as { ticker?: unknown; reason?: unknown };
    if (typeof row.ticker !== "string" || typeof row.reason !== "string") continue;
    const ticker = row.ticker.replace(/\$/g, "").trim().toUpperCase();
    const reason = clampReason(row.reason);
    if (!ticker || !reason) continue;
    map.set(ticker, reason);
  }
  return map;
}

function cleanNotes(notes: Map<string, string>, headlines: Map<string, DeskNews[]>) {
  const map = new Map<string, string>();
  for (const [ticker, reason] of Array.from(notes.entries())) {
    const cleaned = withoutPercents(reason);
    if (isPublishable(cleaned, ticker, headlines.get(ticker) ?? [])) map.set(ticker, cleaned);
  }
  return map;
}

function acceptReason(
  symbol: string,
  reason: string | undefined,
  accepted: Map<string, string>,
  items: DeskNews[],
) {
  const cleaned = reason ? withoutPercents(reason) : "";
  if (!cleaned || !isPublishable(cleaned, symbol, items) || repeatedClause(cleaned, accepted)) return "";
  reason = cleaned;
  const duplicate = Array.from(accepted.values()).some((line) => line.toLowerCase() === reason.toLowerCase());
  return duplicate ? "" : reason;
}

function repeatedClause(reason: string, accepted: Map<string, string>) {
  const grams = wordGrams(reason, 5);
  if (grams.length === 0) return false;
  for (const line of Array.from(accepted.values())) {
    const other = new Set(wordGrams(line, 5));
    if (grams.some((gram) => other.has(gram))) return true;
  }
  return false;
}

function wordGrams(sentence: string, size: number) {
  const words = sentence
    .toLowerCase()
    .replace(/[^a-z\s]/g, "")
    .split(/\s+/)
    .filter(Boolean);
  const grams: string[] = [];
  for (let index = 0; index <= words.length - size; index += 1) {
    grams.push(words.slice(index, index + size).join(" "));
  }
  return grams;
}

function isPublishable(reason: string, symbol: string, items: DeskNews[]) {
  if (!reason || reason.includes("?") || hasPercent(reason) || isJunkTitle(reason)) return false;
  if (isBlacklisted(reason) || isRejectedReason(reason, symbol) || copiesHeadline(reason, items)) return false;
  return true;
}

function hasPercent(sentence: string) {
  return /\d+(?:\.\d+)?\s*(%|percent)\b/i.test(sentence);
}

function withoutPercents(sentence: string) {
  return sentence
    .replace(/[+-]?\d+(?:\.\d+)?\s*(%|percent)\b/gi, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;])/g, "$1")
    .trim();
}

function copiesHeadline(sentence: string, items: DeskNews[]) {
  const line = normalizeCopy(sentence);
  return items.some((item) => {
    const title = normalizeCopy(item.title);
    if (title.length < 12) return false;
    return line === title || line.includes(title) || title.includes(line);
  });
}

function offlineReason(quote: Quote) {
  return marketNarrative(quote, 0);
}

function uniqueNarrative(quote: Quote, accepted: Map<string, string>) {
  const seed =
    Array.from(quote.symbol).reduce((sum, char, position) => sum + char.charCodeAt(0) * (position + 3), 0) %
    3;
  for (let offset = 0; offset < 3; offset += 1) {
    const line = marketNarrative(quote, (seed + offset) % 3);
    if (!repeatedClause(line, accepted)) return line;
  }
  return marketNarrative(quote, seed);
}

function catalystPrompt(quote: Quote, items: DeskNews[]) {
  const direction = quote.changePct >= 0 ? "rose" : "fell";
  const news =
    items.length > 0
      ? items
          .map((item, index) => {
            const summary = item.summary ? `\nSummary: ${item.summary}` : "";
            return `${index + 1}. ${item.title}${summary}`;
          })
          .join("\n")
      : "None provided.";
  return [
    `You are a Senior Equity Research Analyst at Goldman Sachs explaining today's move for $${quote.symbol} (${quote.name}, Industry Sector: ${quote.sector}).`,
    `The shares ${direction} today. Do not write any percentage number in the sentence.`,
    "",
    "RAW NEWS HEADLINES:",
    news,
    "",
    "TASK: Write EXACTLY ONE concise, elite English sentence (10-14 words) explaining the cause.",
    "",
    "RULE 1 (FACTS FIRST): If the news mentions SPECIFIC catalysts (Price Target cuts/raises, Wall Street Journal/Bloomberg reports, M&A rumors, Earnings, Guidance, FDA, SEC filings), YOU MUST USE THAT SPECIFIC FACT. Never hide real M&A or rating news behind generic macro talk!",
    "",
    `RULE 2 (SMART SYNTHESIS): Only if NO specific catalyst exists, synthesize a plausible sector/technical narrative. Ensure you correctly match its actual industry sector (${quote.sector}) and avoid calling Solar or Energy stocks 'Information Technology'.`,
    "",
    "RULE 3 (VARIETY): Never output the exact same clause structure twice on the same card. Avoid lazy phrases like 'valuation multiples compressed' for multiple tickers.",
    "",
    "OUTPUT FORMAT: Just the single active sentence starting with an action/reason phrase.",
  ].join("\n");
}

function marketNarrative(quote: Quote, index: number) {
  const sector = quote.sector.trim() || "the group";
  const lines =
    quote.changePct >= 0
      ? [
          `Driven by strong institutional accumulation across the ${sector} complex.`,
          `Lifted by momentum buying after a ${sector} technical breakout.`,
          `Bid higher as investors rotated into ${sector} leadership today.`,
        ]
      : [
          `Downgraded by analysts on near-term ${sector} margin pressure.`,
          `Sold off as ${sector} holders took profits after the prior rally.`,
          `Pressured by a technical breakdown across the ${sector} group.`,
        ];
  return clampReason(lines[index] ?? lines[0]);
}

function isJunkTitle(title: string) {
  const text = normalizeCopy(title);
  return JUNK_TITLE_TERMS.some((term) => text.includes(term)) || SEO_HEADLINE.test(title);
}

function normalizeCopy(value: string) {
  return value.toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim();
}

function isBlacklisted(sentence: string) {
  const text = sentence.toLowerCase();
  return SENTENCE_BLACKLIST.some((phrase) => text.includes(phrase));
}

function isRejectedReason(sentence: string, symbol: string) {
  if (isBlacklisted(sentence) || SEO_HEADLINE.test(sentence)) return true;
  if (/stock is up because|here is why|volatility driven by institutional flows|insufficient information/i.test(sentence)) {
    return true;
  }
  if (/\b(dow futures|s&p 500 futures|nasdaq futures|treasury yields|fed funds)\b/i.test(sentence)) return true;
  return symbol !== "META" && /\bmeta\b/i.test(sentence);
}

async function callGemini(apiKey: string, modelName: string, prompt: string) {
  const genAI = new GoogleGenerativeAI(apiKey);
  const request = () => {
    const model = genAI.getGenerativeModel(
      {
        model: modelName,
        generationConfig: {
          temperature: 0.2,
          responseMimeType: "application/json",
        },
      },
      { timeout: 12000 },
    );
    return model.generateContent(prompt).then((result) => result.response.text());
  };

  try {
    return await request();
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const retrySeconds = Number(message.match(/retry in ([\d.]+)s/i)?.[1] ?? "");
    if (!/429|too many requests|quota/i.test(message) || !Number.isFinite(retrySeconds) || retrySeconds > 3) {
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(retrySeconds, 0.4) * 1000));
    return request();
  }
}

function clampReason(raw: string) {
  const words = raw
    .replace(/[！!]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.]+$/, "")
    .split(" ")
    .filter(Boolean)
    .slice(0, 14);

  if (words.length === 0) return "";
  return `${words.join(" ")}.`;
}

async function withRetry<T>(fn: () => Promise<T>) {
  try {
    return await fn();
  } catch {
    return fn();
  }
}

function chunk<T>(items: T[], size: number) {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  return batches;
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>) {
  const results = new Array<R>(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}
