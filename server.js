const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const BASE = "https://public.coindcx.com";
const API = "https://api.coindcx.com";

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

const EXCLUDED = new Set([
  "BTC", "ETH", "SOL", "BNB", "XRP", "ADA", "DOGE",
  "TRX", "TON", "LTC", "BCH", "DOT", "LINK", "AVAX",
  "SHIB", "USDC", "USDT", "BUSD", "DAI"
]);

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJSON(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "UD-V7-Scanner/1.0" }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function baseCoin(pair) {
  return pair.replace(/^B-/, "").replace(/_USDT$/, "");
}

function validPair(pair) {
  const coin = baseCoin(pair);
  return pair.endsWith("_USDT") &&
    !EXCLUDED.has(coin) &&
    !coin.includes("USD") &&
    !coin.includes("BTC") &&
    !coin.includes("ETH");
}

async function getPairs() {
  const url = API +
    "/exchange/v1/derivatives/futures/data/active_instruments?margin_currency_short_name[]=USDT";
  const data = await getJSON(url);
  if (!Array.isArray(data)) throw new Error("CoinDCX pairs response invalid");
  return data.filter(validPair);
}

async function getCandles(pair, resolution, count = 100) {
  const now = Math.floor(Date.now() / 1000);
  const minutes = resolution === "5" ? 5 :
    resolution === "15" ? 15 : 60;
  const from = now - minutes * 60 * count;

  const url = `${BASE}/market_data/candlesticks?pair=${encodeURIComponent(pair)}` +
    `&from=${from}&to=${now}&resolution=${resolution}&pcode=f`;

  const json = await getJSON(url);
  const rows = Array.isArray(json) ? json : json.data;
  if (!Array.isArray(rows)) throw new Error("Candle data unavailable");

  return rows.map(c => ({
    open: Number(c.open),
    high: Number(c.high),
    low: Number(c.low),
    close: Number(c.close),
    volume: Number(c.volume),
    time: Number(c.time)
  })).filter(c =>
    c.open > 0 && c.high > 0 && c.low > 0 &&
    c.close > 0 && Number.isFinite(c.volume)
  ).sort((a, b) => a.time - b.time);
}

function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let value = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    value = values[i] * k + value * (1 - k);
  }
  return value;
}

function stochRSI(closes, period = 14) {
  if (closes.length < period * 3) return null;

  const changes = [];
  for (let i = 1; i < closes.length; i++) {
    changes.push(closes[i] - closes[i - 1]);
  }

  const rsiValues = [];
  for (let i = period; i <= changes.length; i++) {
    const slice = changes.slice(i - period, i);
    let gains = 0, losses = 0;
    for (const x of slice) {
      if (x > 0) gains += x;
      else losses -= x;
    }
    const avgGain = gains / period;
    const avgLoss = losses / period;
    const rsi = avgLoss === 0 ? 100 :
      100 - 100 / (1 + avgGain / avgLoss);
    rsiValues.push(rsi);
  }

  const last = rsiValues.slice(-period);
  const min = Math.min(...last);
  const max = Math.max(...last);
  if (max === min) return 50;
  return ((last[last.length - 1] - min) / (max - min)) * 100;
}

function volumeMA(candles, period = 20) {
  if (candles.length < period * 2) return null;
  const vols = candles.map(c => c.volume);
  const recent = vols.slice(-period).reduce((a, b) => a + b, 0) / period;
  const previous = vols.slice(-period * 2, -period)
    .reduce((a, b) => a + b, 0) / period;
  return { recent, previous, rising: recent > previous };
}

function candleBody(c) {
  const range = c.high - c.low;
  if (range <= 0) return 0;
  return Math.abs(c.close - c.open) / range;
}

function wickAgainst(c, side) {
  const range = c.high - c.low;
  if (range <= 0) return 1;
  if (side === "BUY") return (c.high - c.close) / range;
  return (c.close - c.low) / range;
}

function trend(candles, side) {
  if (candles.length < 55) return false;
  const closes = candles.map(c => c.close);
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const last = closes[closes.length - 1];

  return side === "BUY"
    ? last > e20 && e20 > e50
    : last < e20 && e20 < e50;
}

function technicalSetup(c5, c15, c60) {
  if (c5.length < 60 || c15.length < 60 || c60.length < 60) return null;

  const last = c5[c5.length - 1];
  const prev = c5[c5.length - 2];
  const closes = c5.map(c => c.close);
  const vma = volumeMA(c5, 20);
  const stoch = stochRSI(closes);

  if (!vma || stoch === null || vma.recent <= 0) return null;

  const volumeGrowing = vma.rising &&
    last.volume > vma.recent * 1.15 &&
    last.volume > prev.volume;

  if (!volumeGrowing) return null;

  const body = candleBody(last);
  if (body < 0.72) return null;

  const buy = last.close > last.open &&
    stoch >= 0 && stoch <= 20 &&
    trend(c5, "BUY") &&
    trend(c15, "BUY") &&
    trend(c60, "BUY") &&
    wickAgainst(last, "BUY") <= 0.15;

  const sell = last.close < last.open &&
    stoch >= 80 && stoch <= 100 &&
    trend(c5, "SELL") &&
    trend(c15, "SELL") &&
    trend(c60, "SELL") &&
    wickAgainst(last, "SELL") <= 0.15;

  if (!buy && !sell) return null;

  return {
    side: buy ? "BUY" : "SELL",
    price: last.close,
    candleBody: Number((body * 100).toFixed(1)),
    stoch: Number(stoch.toFixed(1)),
    volumeMA: vma.recent,
    volumeRatio: Number((last.volume / vma.recent).toFixed(2))
  };
}

async function getOrderbook(pair) {
  const url = `${BASE}/market_data/v3/orderbook/${encodeURIComponent(pair)}-futures/50`;
  return await getJSON(url);
}

function orderbookCheck(book, side, price) {
  if (!book || !book.bids || !book.asks) {
    return { ok: false, reason: "Order book unavailable" };
  }

  const bids = Object.entries(book.bids)
    .map(([p, q]) => [Number(p), Number(q)])
    .filter(x => x[0] > 0 && x[1] > 0)
    .sort((a, b) => b[0] - a[0]);

  const asks = Object.entries(book.asks)
    .map(([p, q]) => [Number(p), Number(q)])
    .filter(x => x[0] > 0 && x[1] > 0)
    .sort((a, b) => a[0] - b[0]);

  if (!bids.length || !asks.length) {
    return { ok: false, reason: "Empty order book" };
  }

  const bid = bids[0][0];
  const ask = asks[0][0];
  const mid = (bid + ask) / 2;
  const spread = ((ask - bid) / mid) * 100;

  if (!Number.isFinite(spread) || spread > 0.20) {
    return { ok: false, reason: "Spread too wide" };
  }

  const bidDepth = bids.slice(0, 10).reduce((s, x) => s + x[0] * x[1], 0);
  const askDepth = asks.slice(0, 10).reduce((s, x) => s + x[0] * x[1], 0);
  const totalDepth = bidDepth + askDepth;

  if (totalDepth < 5000) {
    return { ok: false, reason: "Insufficient order-book depth" };
  }

  const ratio = bidDepth / Math.max(askDepth, 0.000001);

  if (side === "BUY" && ratio < 1.10) {
    return { ok: false, reason: "Bid support not strong enough" };
  }
  if (side === "SELL" && ratio > 0.91) {
    return { ok: false, reason: "Ask pressure not strong enough" };
  }

  return {
    ok: true,
    spread: Number(spread.toFixed(3)),
    depth: Math.round(totalDepth),
    imbalance: Number(ratio.toFixed(2))
  };
}

function nearbyRejection(candles, side, price) {
  const recent = candles.slice(-20, -1);
  if (recent.length < 10) return true;

  const highs = recent.map(c => c.high);
  const lows = recent.map(c => c.low);
  const resistance = Math.max(...highs);
  const support = Math.min(...lows);
  const distance = Math.abs(price - (side === "BUY" ? resistance : support)) / price;

  // Avoid entering directly into a nearby opposing level.
  return distance > 0.0015;
}

function buildSignal(pair, setup, bookCheck) {
  const entry = setup.price;
  const side = setup.side;
  const riskPct = 0.006;

  const sl = side === "BUY"
    ? entry * (1 - riskPct)
    : entry * (1 + riskPct);

  const t1 = side === "BUY"
    ? entry * 1.008
    : entry * 0.992;

  const t2 = side === "BUY"
    ? entry * 0.014 + entry
    : entry * 0.986;

  return {
    pair,
    coin: baseCoin(pair),
    side,
    entry: Number(entry.toPrecision(8)),
    stopLoss: Number(sl.toPrecision(8)),
    target1: Number(t1.toPrecision(8)),
    target2: Number(t2.toPrecision(8)),
    candleBody: setup.candleBody,
    stochRSI: setup.stoch,
    volumeRatio: setup.volumeRatio,
    spread: bookCheck.spread,
    orderBookDepth: bookCheck.depth,
    orderBookImbalance: bookCheck.imbalance,
    time: new Date().toISOString()
  };
}

let scanState = {
  running: false,
  scanning: false,
  lastScan: null,
  pairsScanned: 0,
  signals: [],
  errors: [],
  status: "Ready"
};

let scanTimer = null;
let requestedLimit = 100;

async function scanOne(pair) {
  try {
    const [c5, c15, c60] = await Promise.all([
      getCandles(pair, "5", 100),
      getCandles(pair, "15", 100),
      getCandles(pair, "60", 100)
    ]);

    const setup = technicalSetup(c5, c15, c60);
    if (!setup) return null;

    if (!nearbyRejection(c5, setup.side, setup.price)) return null;

    const book = await getOrderbook(pair);
    const check = orderbookCheck(book, setup.side, setup.price);
    if (!check.ok) return null;

    return buildSignal(pair, setup, check);
  } catch (e) {
    scanState.errors.push(`${pair}: ${e.message}`);
    return null;
  }
}

async function runScan() {
  if (scanState.scanning) return;
  scanState.scanning = true;
  scanState.status = "Scanning";
  scanState.errors = [];

  try {
    const pairs = await getPairs();
    const selected = pairs.slice(0, requestedLimit);
    const results = [];
    let index = 0;

    async function worker() {
      while (index < selected.length) {
        const current = selected[index++];
        const signal = await scanOne(current);
        if (signal) results.push(signal);
        await sleep(180);
      }
    }

    await Promise.all(Array.from({ length: 4 }, () => worker()));

    scanState.pairsScanned = selected.length;
    scanState.signals = results.sort((a, b) =>
      b.volumeRatio - a.volumeRatio
    );
    scanState.lastScan = new Date().toISOString();
    scanState.status = scanState.signals.length
      ? "Trade-ready signals found"
      : "No trade-ready setup";
  } catch (e) {
    scanState.status = "API error: " + e.message;
    scanState.errors.push(e.message);
  } finally {
    scanState.scanning = false;
  }
}

app.get("/api/status", (req, res) => {
  res.json(scanState);
});

app.post("/api/start", (req, res) => {
  const limit = Number(req.body.limit);
  requestedLimit = Number.isFinite(limit)
    ? Math.max(10, Math.min(500, limit))
    : 100;

  if (!scanState.running) {
    scanState.running = true;
    runScan();
    scanTimer = setInterval(runScan, 60000);
  }
  res.json({ ok: true, status: "Scanner started", limit: requestedLimit });
});

app.post("/api/stop", (req, res) => {
  scanState.running = false;
  if (scanTimer) clearInterval(scanTimer);
  scanTimer = null;
  scanState.status = "Scanner stopped";
  res.json({ ok: true });
});

app.post("/api/scan-now", async (req, res) => {
  await runScan();
  res.json(scanState);
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, name: "UD V7 Ultimate Liquidity Shield" });
});

app.listen(PORT, () => {
  console.log(`UD V7 running on port ${PORT}`);
});
