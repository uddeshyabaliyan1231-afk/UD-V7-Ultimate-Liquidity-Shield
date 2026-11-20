
const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const BASE = "https://public.coindcx.com";
const API = "https://api.coindcx.com";

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

const EXCLUDED = new Set([
  "BTC","ETH","SOL","BNB","XRP","ADA","DOGE","TRX","TON","LTC",
  "BCH","DOT","LINK","AVAX","SHIB","USDC","USDT","BUSD","DAI"
]);

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJSON(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "UD-V7-Scanner/1.1" }
    });

    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function baseCoin(pair) {
  return String(pair).replace(/^B-/, "").replace(/_USDT$/, "");
}

function validPair(pair) {
  if (typeof pair !== "string") return false;

  const coin = baseCoin(pair);

  return pair.endsWith("_USDT") &&
    !EXCLUDED.has(coin) &&
    !coin.includes("USD") &&
    !coin.includes("BTC") &&
    !coin.includes("ETH");
}

async function getPairs() {
  const url =
    API +
    "/exchange/v1/derivatives/futures/data/active_instruments?margin_currency_short_name[]=USDT";

  const data = await getJSON(url);

  if (!Array.isArray(data)) {
    throw new Error("CoinDCX active instruments response invalid");
  }

  return data.filter(validPair);
}

// Fetch completed 5-minute and 1-hour candles.
// 15-minute candles are built from three 5-minute candles.
async function getCandles(pair, resolution, count = 120) {
  const now = Math.floor(Date.now() / 1000);
  const mins = resolution === "5" ? 5 : 60;
  const from = now - mins * 60 * count;

  const url =
    BASE +
    "/market_data/candlesticks?pair=" +
    encodeURIComponent(pair) +
    "&from=" + from +
    "&to=" + now +
    "&resolution=" + resolution +
    "&pcode=f";

  const json = await getJSON(url);
  const rows = Array.isArray(json) ? json : json.data;

  if (!Array.isArray(rows)) {
    throw new Error("Candle response format invalid for " + pair);
  }

  const intervalMs = mins * 60 * 1000;

  return rows.map(c => {
    let time = Number(c.time);
    if (time < 1e12) time *= 1000;

    return {
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
      volume: Number(c.volume),
      time
    };
  }).filter(c =>
    c.open > 0 &&
    c.high > 0 &&
    c.low > 0 &&
    c.close > 0 &&
    Number.isFinite(c.volume) &&
    c.time + intervalMs <= Date.now()
  ).sort((a, b) => a.time - b.time);
}

function make15m(c5) {
  const groups = new Map();

  for (const c of c5) {
    const bucket = Math.floor(c.time / 900000) * 900000;

    if (!groups.has(bucket)) groups.set(bucket, []);
    groups.get(bucket).push(c);
  }

  return [...groups.entries()]
    .filter(([, g]) => g.length === 3)
    .map(([time, g]) => ({
      time,
      open: g[0].open,
      high: Math.max(...g.map(x => x.high)),
      low: Math.min(...g.map(x => x.low)),
      close: g[2].close,
      volume: g.reduce((s, x) => s + x.volume, 0)
    }))
    .sort((a, b) => a.time - b.time);
}

function ema(values, period) {
  if (values.length < period) return null;

  const k = 2 / (period + 1);

  let v =
    values.slice(0, period).reduce((a, b) => a + b, 0) /
    period;

  for (let i = period; i < values.length; i++) {
    v = values[i] * k + v * (1 - k);
  }

  return v;
}

function stochRSI(closes, period = 14) {
  if (closes.length < period * 3) return null;

  const rsi = [];

  for (let i = period; i < closes.length; i++) {
    let gain = 0;
    let loss = 0;

    for (let j = i - period + 1; j <= i; j++) {
      const d = closes[j] - closes[j - 1];

      if (d > 0) gain += d;
      else loss -= d;
    }

    const ag = gain / period;
    const al = loss / period;

    rsi.push(
      al === 0 ? 100 : 100 - (100 / (1 + ag / al))
    );
  }

  const window = rsi.slice(-period);
  const lo = Math.min(...window);
  const hi = Math.max(...window);

  return hi === lo
    ? 50
    : ((window[window.length - 1] - lo) / (hi - lo)) * 100;
}

function volumeMA(candles, period = 20) {
  if (candles.length < period * 2 + 1) return null;

  const v = candles.map(x => x.volume);

  const recent =
    v.slice(-period - 1, -1).reduce((a, b) => a + b, 0) /
    period;

  const previous =
    v.slice(-period * 2 - 1, -period - 1)
      .reduce((a, b) => a + b, 0) / period;

  return {
    recent,
    previous,
    rising: recent > previous
  };
}

function candleBody(c) {
  const range = c.high - c.low;
  return range > 0
    ? Math.abs(c.close - c.open) / range
    : 0;
}

function trend(candles, side, strict = true) {
  if (candles.length < 55) return false;

  const closes = candles.map(c => c.close);
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const last = closes[closes.length - 1];

  if (side === "BUY") {
    return strict
      ? last > e20 && e20 > e50
      : last > e20;
  }

  return strict
    ? last < e20 && e20 < e50
    : last < e20;
}

function technicalSetup(c5, c15, c60) {
  if (
    c5.length < 55 ||
    c15.length < 55 ||
    c60.length < 55
  ) {
    return { reason: "Insufficient completed candles" };
  }

  const last = c5[c5.length - 1];
  const closes = c5.map(c => c.close);
  const vma = volumeMA(c5, 20);
  const stoch = stochRSI(closes);

  if (!vma || stoch === null || vma.recent <= 0) {
    return { reason: "Indicator history insufficient" };
  }

  const volRatio = last.volume / vma.recent;

  if (!vma.rising) {
    return { reason: "Volume MA not rising" };
  }

  if (volRatio < 1.05) {
    return { reason: "Current volume below confirmation threshold" };
  }

  const body = candleBody(last);

  if (body < 0.55) {
    return { reason: "Candle body too weak" };
  }

  const buy =
    last.close > last.open &&
    stoch <= 25 &&
    trend(c5, "BUY", false) &&
    trend(c15, "BUY", true) &&
    trend(c60, "BUY", true);

  const sell =
    last.close < last.open &&
    stoch >= 75 &&
    trend(c5, "SELL", false) &&
    trend(c15, "SELL", true) &&
    trend(c60, "SELL", true);

  if (!buy && !sell) {
    return {
      reason: "Momentum / multi-timeframe direction not aligned"
    };
  }

  const against = buy
    ? (last.high - last.close) / (last.high - last.low || 1)
    : (last.close - last.low) / (last.high - last.low || 1);

  if (against > 0.25) {
    return { reason: "Opposing wick rejection" };
  }

  return {
    setup: {
      side: buy ? "BUY" : "SELL",
      price: last.close,
      candleBody: Number((body * 100).toFixed(1)),
      stoch: Number(stoch.toFixed(1)),
      volumeRatio: Number(volRatio.toFixed(2))
    }
  };
}

async function getOrderbook(pair) {
  const url =
    BASE +
    "/market_data/v3/orderbook/" +
    encodeURIComponent(pair) +
    "-futures/50";

  return getJSON(url);
}

function orderbookCheck(book, side) {
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

  const spread = (ask - bid) / mid * 100;

  if (!Number.isFinite(spread) || spread > 0.30) {
    return { ok: false, reason: "Spread too wide" };
  }

  const bd = bids.slice(0, 10)
    .reduce((s, x) => s + x[0] * x[1], 0);

  const ad = asks.slice(0, 10)
    .reduce((s, x) => s + x[0] * x[1], 0);

  const depth = bd + ad;

  if (depth < 1000) {
    return { ok: false, reason: "Insufficient order-book depth" };
  }

  const ratio = bd / Math.max(ad, 0.000001);

  if (side === "BUY" && ratio < 1.02) {
    return { ok: false, reason: "Bid support not confirmed" };
  }

  if (side === "SELL" && ratio > 0.98) {
    return { ok: false, reason: "Ask pressure not confirmed" };
  }

  return {
    ok: true,
    spread: Number(spread.toFixed(3)),
    depth: Math.round(depth),
    imbalance: Number(ratio.toFixed(2))
  };
}

function nearbyRejection(candles, side, price) {
  const recent = candles.slice(-21, -1);

  if (recent.length < 10) return false;

  const level = side === "BUY"
    ? Math.max(...recent.map(c => c.high))
    : Math.min(...recent.map(c => c.low));

  return Math.abs(price - level) / price > 0.0008;
}

function buildSignal(pair, s, b) {
  const e = s.price;
  const r = 0.006;

  const sl = s.side === "BUY"
    ? e * (1 - r)
    : e * (1 + r);

  const t1 = s.side === "BUY"
    ? e * 1.008
    : e * 0.992;

  const t2 = s.side === "BUY"
    ? e * 1.014
    : e * 0.986;

  return {
    pair,
    coin: baseCoin(pair),
    side: s.side,
    entry: Number(e.toPrecision(8)),
    stopLoss: Number(sl.toPrecision(8)),
    target1: Number(t1.toPrecision(8)),
    target2: Number(t2.toPrecision(8)),
    candleBody: s.candleBody,
    stochRSI: s.stoch,
    volumeRatio: s.volumeRatio,
    spread: b.spread,
    orderBookDepth: b.depth,
    orderBookImbalance: b.imbalance,
    time: new Date().toISOString()
  };
}

const scanState = {
  running: false,
  scanning: false,
  lastScan: null,
  pairsScanned: 0,
  signals: [],
  errors: [],
  rejects: {},
  status: "Ready"
};

let scanTimer = null;
let requestedLimit = 100;

function reject(reason) {
  scanState.rejects[reason] =
    (scanState.rejects[reason] || 0) + 1;
}

async function scanOne(pair) {
  try {
    const [c5, c60] = await Promise.all([
      getCandles(pair, "5", 220),
      getCandles(pair, "60", 100)
    ]);

    const c15 = make15m(c5);
    const result = technicalSetup(c5, c15, c60);

    if (!result.setup) {
      reject(result.reason);
      return null;
    }

    if (!nearbyRejection(
      c5,
      result.setup.side,
      result.setup.price
    )) {
      reject("Too close to recent opposing level");
      return null;
    }

    const book = await getOrderbook(pair);
    const check = orderbookCheck(book, result.setup.side);

    if (!check.ok) {
      reject(check.reason);
      return null;
    }

    return buildSignal(pair, result.setup, check);

  } catch (e) {
    scanState.errors.push(pair + ": " + e.message);
    reject("API / data error");
    return null;
  }
}

async function runScan() {
  if (scanState.scanning) return;

  scanState.scanning = true;
  scanState.status = "Scanning";
  scanState.errors = [];
  scanState.rejects = {};

  try {
    const pairs = await getPairs();
    const selected = pairs.slice(0, requestedLimit);
    const results = [];

    let index = 0;

    async function worker() {
      while (index < selected.length) {
        const pair = selected[index++];
        const signal = await scanOne(pair);

        if (signal) results.push(signal);

        await sleep(120);
      }
    }

    await Promise.all(
      Array.from({ length: 4 }, () => worker())
    );

    scanState.pairsScanned = selected.length;
    scanState.signals = results.sort(
      (a, b) => b.volumeRatio - a.volumeRatio
    );

    scanState.lastScan = new Date().toISOString();

    scanState.status = results.length
      ? "Trade-ready signals found"
      : "No trade-ready setup";

    const reasons = Object.entries(scanState.rejects)
      .sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => reason + ": " + count);

    scanState.errors = [
      ...scanState.errors,
      ...reasons
    ].slice(0, 30);

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

  res.json({
    ok: true,
    status: "Scanner started",
    limit: requestedLimit
  });
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
  res.json({
    ok: true,
    name: "UD V7 Ultimate Liquidity Shield",
    version: "1.1"
  });
});

app.listen(PORT, () => {
  console.log("UD V7 running on port " + PORT);
});
