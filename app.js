/* ===========================================================
   マイトレードダッシュボード app.js
   - Finnhub API: 株価・チャート・ニュース
   - Gemini API : 売却アドバイス / テーマ提案（AI）
   - データはすべてブラウザのlocalStorageに保存（サーバー不要）
   =========================================================== */

const LS_FINNHUB = 'td_finnhub_key';
const LS_GEMINI = 'td_gemini_key';
const LS_PORTFOLIO = 'td_portfolio';

let currentSymbol = 'NVDA';
let currentRange = 90; // days
let chart, candleSeries;
let quoteTimer = null;
const QUOTE_REFRESH_MS = 15000;   // 選択中の銘柄の価格を更新する間隔（WebSocketが使えない場合のフォールバック）
const PORTFOLIO_REFRESH_MS = 30000; // 保有銘柄の価格を更新する間隔
const SUMMARY_REFRESH_MS = 60000;   // グローバルサマリー/主要インデックスを更新する間隔

/* ---------- Finnhub WebSocket（米国株のリアルタイム価格） ---------- */
let finnhubSocket = null;
let wsSubscribedSymbol = null;
let currentPrevClose = null;

function connectFinnhubSocket() {
  const key = getFinnhubKey();
  if (!key || finnhubSocket) return;
  try {
    finnhubSocket = new WebSocket(`wss://ws.finnhub.io?token=${key}`);
    finnhubSocket.addEventListener('open', () => {
      if (!isJPSymbol(currentSymbol)) subscribeWS(currentSymbol);
    });
    finnhubSocket.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'trade' && Array.isArray(msg.data) && msg.data.length) {
          const last = msg.data[msg.data.length - 1];
          if (last.s === currentSymbol && currentPrevClose) {
            const c = last.p;
            const d = c - currentPrevClose;
            const dp = (d / currentPrevClose) * 100;
            renderChartPrice({ c, d, dp }, true);
          }
        }
      } catch { /* 不正なメッセージは無視 */ }
    });
    finnhubSocket.addEventListener('close', () => { finnhubSocket = null; startQuoteAutoRefresh(); });
    finnhubSocket.addEventListener('error', () => { finnhubSocket = null; startQuoteAutoRefresh(); });
  } catch {
    finnhubSocket = null;
  }
}

function subscribeWS(symbol) {
  if (!finnhubSocket || finnhubSocket.readyState !== WebSocket.OPEN) return;
  if (wsSubscribedSymbol) finnhubSocket.send(JSON.stringify({ type: 'unsubscribe', symbol: wsSubscribedSymbol }));
  finnhubSocket.send(JSON.stringify({ type: 'subscribe', symbol }));
  wsSubscribedSymbol = symbol;
}

/* ---------- 起動処理 ---------- */
document.addEventListener('DOMContentLoaded', () => {
  const fh = localStorage.getItem(LS_FINNHUB);
  const gm = localStorage.getItem(LS_GEMINI);
  if (!fh || !gm) {
    document.getElementById('setupOverlay').classList.remove('hidden');
  }
  document.getElementById('finnhubKeyInput').value = fh || '';
  document.getElementById('geminiKeyInput').value = gm || '';

  document.getElementById('saveKeysBtn').addEventListener('click', saveKeys);
  document.getElementById('settingsBtn').addEventListener('click', () => {
    document.getElementById('setupOverlay').classList.remove('hidden');
  });
  document.getElementById('symbolInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.value.trim()) {
      currentSymbol = e.target.value.trim().toUpperCase();
      loadChartSymbol();
    }
  });
  document.querySelectorAll('.rangeBtn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.rangeBtn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentRange = Number(btn.dataset.range);
      loadChartSymbol();
    });
  });
  document.getElementById('addHoldingBtn').addEventListener('click', addHolding);
  document.getElementById('themeBtn').addEventListener('click', loadThemeSuggestions);
  document.getElementById('analysisBtn').addEventListener('click', loadSymbolAnalysis);

  initChart();
  updateClocks();
  setInterval(updateClocks, 1000);

  loadGlobalSummary(); // Yahoo Finance経由のためAPIキー不要（ローカルサーバー起動時のみ）
  if (fh) {
    loadChartSymbol();
  }
  renderPortfolio();

  // 自動更新（ポーリング）。押しっぱなしでなくてもデータが更新され続けます。
  setInterval(loadGlobalSummary, SUMMARY_REFRESH_MS);
  setInterval(() => { refreshPortfolioPrices(); }, PORTFOLIO_REFRESH_MS);
});

function saveKeys() {
  const fh = document.getElementById('finnhubKeyInput').value.trim();
  const gm = document.getElementById('geminiKeyInput').value.trim();
  if (!fh || !gm) {
    alert('両方のAPIキーを入力してください。');
    return;
  }
  localStorage.setItem(LS_FINNHUB, fh);
  localStorage.setItem(LS_GEMINI, gm);
  document.getElementById('setupOverlay').classList.add('hidden');
  loadGlobalSummary();
  loadChartSymbol();
  renderPortfolio();
}

function getFinnhubKey() { return localStorage.getItem(LS_FINNHUB); }
function getGeminiKey() { return localStorage.getItem(LS_GEMINI); }

/* ---------- 時計・市場ステータス ---------- */
function updateClocks() {
  const now = new Date();
  document.getElementById('clockNY').textContent = now.toLocaleTimeString('ja-JP', { timeZone: 'America/New_York', hour12: false });
  document.getElementById('clockLDN').textContent = now.toLocaleTimeString('ja-JP', { timeZone: 'Europe/London', hour12: false });
  document.getElementById('clockTKY').textContent = now.toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour12: false });

  // NY時間の平日 9:30-16:00 を「市場オープン」とみなす簡易判定
  const nyStr = now.toLocaleString('en-US', { timeZone: 'America/New_York' });
  const ny = new Date(nyStr);
  const day = ny.getDay();
  const minutes = ny.getHours() * 60 + ny.getMinutes();
  const isOpen = day >= 1 && day <= 5 && minutes >= 570 && minutes <= 960;
  const statusEl = document.getElementById('marketStatus');
  const statusText = document.getElementById('marketStatusText');
  if (isOpen) {
    statusEl.classList.remove('closed');
    statusText.textContent = '市場オープン（NY）';
  } else {
    statusEl.classList.add('closed');
    statusText.textContent = '市場クローズ（NY）';
  }
}

/* ---------- グローバルサマリー / 主要インデックス ---------- */
// 各国の「実際の株価指数」をYahoo Finance経由で取得（ETFではなく指数そのものなので通貨換算の混乱がありません）
const REGIONS = [
  { label: 'USA', symbol: '^GSPC' },
  { label: 'JAPAN', symbol: '^N225' },
  { label: 'CHINA', symbol: '^HSI' },
  { label: 'EUROPE', symbol: '^STOXX50E' },
  { label: 'INDIA', symbol: '^BSESN' },
  { label: 'CANADA', symbol: '^GSPTSE' },
];
const INDICES = [
  { label: 'S&P 500', symbol: '^GSPC' },
  { label: 'NASDAQ総合', symbol: '^IXIC' },
  { label: 'NYダウ', symbol: '^DJI' },
  { label: '日経平均（円）', symbol: '^N225' },
];

/* ---------- 日本株対応（ローカルサーバー経由でYahoo Financeを中継） ---------- */
// 日本の証券コードは伝統的な4桁数字（例: 7203）に加え、2024年以降は
// 数字+英字4文字（例: 285A＝キオクシア）の新形式もあるため、両方にマッチさせる
function isJPSymbol(symbol) {
  return /^\d[0-9A-Z]{3}$/i.test(symbol) || /^\d[0-9A-Z]{3}\.T$/i.test(symbol);
}
function toYahooSymbol(symbol) {
  if (/\.T$/i.test(symbol)) return symbol.toUpperCase();
  if (isJPSymbol(symbol)) return `${symbol}.T`;
  return symbol.toUpperCase(); // 米国株など: そのままのティッカーをYahoo Financeでも使用
}

async function fetchJPChart(symbol, range, interval) {
  const ySym = toYahooSymbol(symbol);
  const res = await fetch(`/api/jp-chart?symbol=${encodeURIComponent(ySym)}&range=${range}&interval=${interval}`);
  if (!res.ok) throw new Error('jp chart fetch failed (ローカルサーバーが起動していない可能性があります)');
  const data = await res.json();
  const result = data?.chart?.result?.[0];
  if (data.error || !result) throw new Error('jp chart data error');
  return result;
}

async function fetchJPQuote(symbol) {
  const result = await fetchJPChart(symbol, '5d', '15m');
  const meta = result.meta;
  const prevClose = meta.previousClose ?? meta.chartPreviousClose ?? meta.regularMarketPrice;
  const c = meta.regularMarketPrice;
  const d = c - prevClose;
  const dp = prevClose ? (d / prevClose) * 100 : 0;
  return { c, d, dp, h: meta.regularMarketDayHigh, l: meta.regularMarketDayLow, o: null, pc: prevClose };
}

async function fetchProxyCandles(symbol, days) {
  let range = '3mo', interval = '1d';
  if (days <= 1) { range = '5d'; interval = '15m'; }
  else if (days <= 90) { range = '3mo'; interval = '1d'; }
  else { range = '6mo'; interval = '1d'; }
  const result = await fetchJPChart(symbol, range, interval);
  const ts = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const t = [], o = [], h = [], l = [], c = [];
  for (let i = 0; i < ts.length; i++) {
    if (q.close?.[i] == null) continue; // 取引時間外の欠損データを除外
    t.push(ts[i]); o.push(q.open[i]); h.push(q.high[i]); l.push(q.low[i]); c.push(q.close[i]);
  }
  return { s: t.length ? 'ok' : 'no_data', t, o, h, l, c };
}

/* ---------- 株価取得（米国株など: Finnhub / 日本株: ローカルサーバー経由） ---------- */
async function fetchQuote(symbol) {
  if (isJPSymbol(symbol)) return fetchJPQuote(symbol);
  const key = getFinnhubKey();
  const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${key}`);
  if (!res.ok) throw new Error('quote fetch failed');
  return res.json(); // { c, d, dp, h, l, o, pc }
}

async function loadGlobalSummary() {
  const badgeEl = document.getElementById('regionBadges');
  const idxEl = document.getElementById('indicesList');
  badgeEl.textContent = '読み込み中...';
  idxEl.textContent = '読み込み中...';
  try {
    const badges = await Promise.all(REGIONS.map(async r => {
      try {
        const q = await fetchJPQuote(r.symbol); // Yahoo Finance経由（指数シンボルはFinnhub無料枠では扱えないため）
        return { label: r.label, dp: q.dp };
      } catch { return { label: r.label, dp: null }; }
    }));
    badgeEl.innerHTML = badges.map(b => {
      if (b.dp === null || b.dp === undefined) return `<span class="badge">${b.label} --</span>`;
      const cls = b.dp >= 0 ? 'up' : 'down';
      const sign = b.dp >= 0 ? '+' : '';
      return `<span class="badge ${cls}">${b.label} ${sign}${b.dp.toFixed(2)}%</span>`;
    }).join('');
  } catch (e) {
    badgeEl.innerHTML = '<span class="errorText">取得に失敗しました。APIキーを確認してください。</span>';
  }

  try {
    const rows = await Promise.all(INDICES.map(async idx => {
      try {
        const q = await fetchJPQuote(idx.symbol); // Yahoo Finance経由
        return { label: idx.label, price: q.c, dp: q.dp };
      } catch { return { label: idx.label, price: null, dp: null }; }
    }));
    idxEl.innerHTML = rows.map(r => {
      if (r.price === null) return `<div class="indicesRow"><span>${r.label}</span><span>--</span><span>--</span></div>`;
      const cls = r.dp >= 0 ? 'up' : 'down';
      const sign = r.dp >= 0 ? '+' : '';
      return `<div class="indicesRow"><span>${r.label}</span><span>${r.price.toFixed(2)}</span><span class="${cls}">${sign}${r.dp.toFixed(2)}%</span></div>`;
    }).join('');
  } catch (e) {
    idxEl.innerHTML = '<span class="errorText">取得に失敗しました。</span>';
  }
}

/* ---------- チャート ---------- */
function initChart() {
  const container = document.getElementById('chartContainer');
  chart = LightweightCharts.createChart(container, {
    layout: { background: { color: 'transparent' }, textColor: '#e6edf3' },
    grid: { vertLines: { color: '#1a2740' }, horzLines: { color: '#1a2740' } },
    timeScale: { borderColor: '#1f2b42' },
    rightPriceScale: { borderColor: '#1f2b42' },
    height: 220,
  });
  candleSeries = chart.addCandlestickSeries({
    upColor: '#3fd68a', downColor: '#f0616b',
    borderVisible: false,
    wickUpColor: '#3fd68a', wickDownColor: '#f0616b',
  });
  window.addEventListener('resize', () => {
    chart.applyOptions({ width: document.getElementById('chartContainer').clientWidth });
  });
  chart.applyOptions({ width: container.clientWidth });
}

async function fetchCandles(symbol, days) {
  // Finnhubの無料プランではチャート用の過去データ(candle)が利用できないため、
  // ローカルサーバー経由でYahoo Financeからチャートデータを取得する（米国株・日本株共通）
  return fetchProxyCandles(symbol, days);
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return [];
  const rsi = [];
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  rsi.push(100 - 100 / (1 + (avgLoss === 0 ? 100 : avgGain / avgLoss)));
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    rsi.push(100 - 100 / (1 + (avgLoss === 0 ? 100 : avgGain / avgLoss)));
  }
  return rsi;
}

function drawRSISvg(rsiValues) {
  const svg = document.getElementById('rsiSvg');
  if (!rsiValues.length) { svg.innerHTML = ''; return; }
  const w = 400, h = 40;
  const step = w / (rsiValues.length - 1 || 1);
  const points = rsiValues.map((v, i) => {
    const x = i * step;
    const y = h - (v / 100) * h;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  svg.innerHTML = `
    <polyline points="${points}" fill="none" stroke="#6ea8fe" stroke-width="1.5"/>
    <line x1="0" y1="${h - 0.7 * h}" x2="${w}" y2="${h - 0.7 * h}" stroke="#f0616b" stroke-width="0.5" stroke-dasharray="3,3"/>
    <line x1="0" y1="${h - 0.3 * h}" x2="${w}" y2="${h - 0.3 * h}" stroke="#3fd68a" stroke-width="0.5" stroke-dasharray="3,3"/>
  `;
}

function renderChartPrice(q, isLive) {
  const cls = q.d >= 0 ? 'up' : 'down';
  const sign = q.d >= 0 ? '+' : '';
  const currency = isJPSymbol(currentSymbol) ? '¥' : '$';
  document.getElementById('chartPrice').innerHTML =
    `${currency}${q.c ? q.c.toFixed(2) : '--'} <span class="delta ${cls}" style="color:${q.d >= 0 ? '#3fd68a' : '#f0616b'}">${sign}${(q.d||0).toFixed(2)} (${sign}${(q.dp||0).toFixed(2)}%)</span>`;
  const updatedEl = document.getElementById('lastUpdated');
  const modeLabel = isLive ? 'リアルタイム更新中' : '自動更新中（15秒ごと）';
  if (updatedEl) updatedEl.textContent = `最終更新: ${new Date().toLocaleTimeString('ja-JP', { hour12: false })}（${modeLabel}）`;
}

async function refreshCurrentPrice() {
  try {
    const q = await fetchQuote(currentSymbol);
    renderChartPrice(q);
  } catch (e) { /* 自動更新中の一時的な失敗は無視 */ }
}

function startQuoteAutoRefresh() {
  if (quoteTimer) clearInterval(quoteTimer);
  quoteTimer = setInterval(refreshCurrentPrice, QUOTE_REFRESH_MS);
}

async function loadChartSymbol() {
  document.getElementById('chartSymbol').textContent = currentSymbol;
  document.getElementById('chartSymbolName').textContent = '';
  document.getElementById('chartPrice').textContent = '読み込み中...';
  document.getElementById('lastUpdated').textContent = '';
  document.getElementById('analysisResult').innerHTML = '';
  document.getElementById('chartError').style.display = 'none';
  if (quoteTimer) clearInterval(quoteTimer);
  if (!getFinnhubKey() && !isJPSymbol(currentSymbol)) return;

  try {
    const q = await fetchQuote(currentSymbol);
    currentPrevClose = q.pc || (q.c - q.d);
    renderChartPrice(q);

    if (!isJPSymbol(currentSymbol) && getFinnhubKey()) {
      // 米国株はFinnhubの無料WebSocketでリアルタイム更新
      if (!finnhubSocket) connectFinnhubSocket();
      else subscribeWS(currentSymbol);
    } else {
      // 日本株、またはWebSocketが使えない場合は定期的な自動更新にフォールバック
      startQuoteAutoRefresh();
    }
  } catch (e) {
    const hint = isJPSymbol(currentSymbol) ? '（ローカルサーバー未起動の可能性）' : '';
    document.getElementById('chartPrice').innerHTML = `<span class="errorText">価格の取得に失敗しました${hint}</span>`;
  }

  const chartErrorEl = document.getElementById('chartError');
  try {
    const c = await fetchCandles(currentSymbol, currentRange);
    if (c.s !== 'ok' || !c.t || !c.t.length) {
      candleSeries.setData([]); // チャートのDOM自体は壊さず、データだけ空にする
      drawRSISvg([]);
      chartErrorEl.textContent = 'チャートデータを取得できませんでした（start.commandでサーバーを起動しているか、銘柄コードが正しいかご確認ください）';
      chartErrorEl.style.display = 'block';
      return;
    }
    chartErrorEl.style.display = 'none';
    const data = c.t.map((t, i) => ({
      time: t,
      open: c.o[i], high: c.h[i], low: c.l[i], close: c.c[i],
    }));
    candleSeries.setData(data);
    drawRSISvg(calcRSI(c.c));
  } catch (e) {
    candleSeries.setData([]);
    drawRSISvg([]);
    chartErrorEl.textContent = 'チャートの取得に失敗しました';
    chartErrorEl.style.display = 'block';
  }
}

/* ---------- ポートフォリオ ---------- */
function getPortfolio() {
  try { return JSON.parse(localStorage.getItem(LS_PORTFOLIO)) || []; }
  catch { return []; }
}
function savePortfolio(list) {
  localStorage.setItem(LS_PORTFOLIO, JSON.stringify(list));
}

function addHolding() {
  const symbol = document.getElementById('newSymbol').value.trim().toUpperCase();
  const shares = Number(document.getElementById('newShares').value);
  const cost = Number(document.getElementById('newCost').value);
  if (!symbol || !shares || !cost) {
    alert('銘柄コード・株数・取得単価をすべて入力してください。');
    return;
  }
  const list = getPortfolio();
  list.push({ id: Date.now(), symbol, shares, cost });
  savePortfolio(list);
  document.getElementById('newSymbol').value = '';
  document.getElementById('newShares').value = '';
  document.getElementById('newCost').value = '';
  renderPortfolio();
}

function removeHolding(id) {
  savePortfolio(getPortfolio().filter(h => h.id !== id));
  renderPortfolio();
}

async function renderPortfolio() {
  const list = getPortfolio();
  const el = document.getElementById('portfolioList');
  if (!list.length) {
    el.innerHTML = '<div class="loadingText">保有銘柄がまだ登録されていません。下のフォームから追加してください。</div>';
    return;
  }
  el.innerHTML = list.map(h => `
    <div class="holdingCard" id="holding-${h.id}">
      <div class="holdingTop">
        <div>
          <span class="holdingSymbol">${h.symbol}</span>
          <span class="holdingMeta"> ${h.shares}株 ／ 取得単価 ${h.cost}</span>
        </div>
        <div class="holdingPL" id="pl-${h.id}">--</div>
      </div>
      <div class="holdingActions">
        <button class="ghostBtn" onclick="loadSellAdvice(${h.id})">売却アドバイスを見る（AI）</button>
        <button class="ghostBtn" onclick="removeHolding(${h.id})">削除</button>
      </div>
      <div id="advice-${h.id}"></div>
    </div>
  `).join('');

  await refreshPortfolioPrices();
}

async function refreshPortfolioPrices() {
  const list = getPortfolio();
  if (!list.length) return;
  for (const h of list) {
    if (!getFinnhubKey() && !isJPSymbol(h.symbol)) continue;
    try {
      const q = await fetchQuote(h.symbol);
      const plPct = ((q.c - h.cost) / h.cost) * 100;
      const plEl = document.getElementById(`pl-${h.id}`);
      const currency = isJPSymbol(h.symbol) ? '¥' : '$';
      if (plEl) {
        plEl.textContent = `${currency}${q.c.toFixed(2)}（${plPct >= 0 ? '+' : ''}${plPct.toFixed(2)}%）`;
        plEl.classList.remove('up', 'down');
        plEl.classList.add(plPct >= 0 ? 'up' : 'down');
      }
    } catch { /* 自動更新中の一時的な失敗は無視 */ }
  }
}

async function loadSellAdvice(id) {
  const list = getPortfolio();
  const h = list.find(x => x.id === id);
  if (!h) return;
  const box = document.getElementById(`advice-${id}`);
  if (!getGeminiKey() || !getFinnhubKey()) {
    box.innerHTML = '<div class="errorText adviceBox">APIキーが未設定です。右上の設定ボタンから登録してください。</div>';
    return;
  }
  box.innerHTML = '<div class="loadingText adviceBox">AIが分析中です...</div>';

  try {
    const [quote, candles, news] = await Promise.all([
      fetchQuote(h.symbol),
      fetchCandles(h.symbol, 60),
      fetchCompanyNews(h.symbol),
    ]);
    const closes = (candles.s === 'ok') ? candles.c : [];
    const rsi = calcRSI(closes);
    const lastRsi = rsi.length ? rsi[rsi.length - 1].toFixed(1) : '不明';
    const plPct = (((quote.c - h.cost) / h.cost) * 100).toFixed(2);
    const newsText = news.slice(0, 5).map(n => `- ${n.headline}`).join('\n') || '関連ニュースなし';

    const prompt = `あなたは個人投資家向けの情報整理アシスタントです。断定的な投資助言はせず、判断材料を整理してください。
以下は保有銘柄の情報です。

銘柄: ${h.symbol}
取得単価: ${h.cost}
現在値: ${quote.c}
含み損益: ${plPct}%
RSI(14): ${lastRsi}（70以上は買われすぎ、30以下は売られすぎの目安）
直近ニュース見出し:
${newsText}

上記を踏まえて、以下を日本語で簡潔に出力してください（150〜250文字程度）：
1. 現状の材料の整理（テクニカル・ニュース双方の観点）
2. 「利確/損切りを検討する材料」と「様子見でよい材料」をそれぞれ挙げる
最後に必ず「※最終判断はご自身で行ってください」と付け加えてください。`;

    const text = await callGemini(prompt);
    box.innerHTML = `<div class="adviceBox">${escapeHtml(text)}</div>`;
  } catch (e) {
    box.innerHTML = '<div class="errorText adviceBox">アドバイスの生成に失敗しました。しばらくしてから再度お試しください。</div>';
  }
}

/* ---------- ニュース ---------- */
async function fetchYahooCompanyNews(symbol) {
  // Yahoo Financeの検索エンドポイント経由で、銘柄名に紐づくニュースを取得（日本株にも対応）
  try {
    const ySym = toYahooSymbol(symbol);
    const res = await fetch(`/api/stock-news?symbol=${encodeURIComponent(ySym)}`);
    if (!res.ok) return [];
    const data = await res.json();
    const items = data.news || [];
    return items.map(n => ({ headline: n.title, url: n.link }));
  } catch {
    return [];
  }
}

async function fetchCompanyNews(symbol) {
  if (isJPSymbol(symbol)) return fetchYahooCompanyNews(symbol);
  const key = getFinnhubKey();
  const to = new Date();
  const from = new Date(Date.now() - 7 * 86400000);
  const fmt = d => d.toISOString().slice(0, 10);
  const url = `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(symbol)}&from=${fmt(from)}&to=${fmt(to)}&token=${key}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    if (Array.isArray(data) && data.length) return data;
  } catch { /* フォールバックへ */ }
  // Finnhubで取得できない場合はYahoo Finance経由をフォールバックとして試す
  return fetchYahooCompanyNews(symbol);
}

async function fetchGeneralNews() {
  const key = getFinnhubKey();
  const res = await fetch(`https://finnhub.io/api/v1/news?category=general&token=${key}`);
  if (!res.ok) throw new Error('news fetch failed');
  return res.json();
}

/* ---------- 検索中の銘柄をAI分析（テクニカル＋情勢） ---------- */
async function loadSymbolAnalysis() {
  const box = document.getElementById('analysisResult');
  if (!getGeminiKey()) {
    box.innerHTML = '<div class="errorText adviceBox">Gemini APIキーが未設定です。右上の設定ボタンから登録してください。</div>';
    return;
  }
  box.innerHTML = '<div class="loadingText adviceBox">AIが分析中です...</div>';

  try {
    const [quote, candles, companyNews, generalNews] = await Promise.all([
      fetchQuote(currentSymbol),
      fetchCandles(currentSymbol, 90),
      fetchCompanyNews(currentSymbol).catch(() => []),
      fetchGeneralNews().catch(() => []),
    ]);

    const closes = candles.s === 'ok' ? candles.c : [];
    const rsi = calcRSI(closes);
    const lastRsi = rsi.length ? rsi[rsi.length - 1].toFixed(1) : '不明';
    const last20 = closes.slice(-20);
    const ma20 = last20.length ? (last20.reduce((a, b) => a + b, 0) / last20.length).toFixed(2) : '不明';
    const currency = isJPSymbol(currentSymbol) ? '円' : 'ドル';

    const companyNewsText = companyNews.slice(0, 5).map(n => `- ${n.headline}`).join('\n') || 'なし（この銘柄の個別ニュースは取得できませんでした）';
    // 銘柄固有のニュースが十分にある場合は、無関係な世界情勢ニュースを渡さない（LLMが無理にこじつけて言及するのを防ぐため）
    const hasEnoughCompanyNews = companyNews.length >= 2;
    const generalNewsText = hasEnoughCompanyNews
      ? null
      : (generalNews.slice(0, 25).map(n => `- ${n.headline}`).join('\n') || 'なし');

    const worldNewsSection = generalNewsText
      ? `\n世界の市場・情勢に関する直近ニュース（参考情報。この銘柄と直接関係があるものだけ拾ってよい）:\n${generalNewsText}\n`
      : '';

    const prompt = `あなたは個人投資家向けの情報整理アシスタントです。断定的な投資助言はせず、テクニカルとニュースの両面から材料を整理してください。

銘柄: ${currentSymbol}
現在値: ${quote.c}${currency}
前日比: ${quote.dp !== undefined ? quote.dp.toFixed(2) : '不明'}%
RSI(14): ${lastRsi}（70以上は買われすぎ、30以下は売られすぎの目安）
20日移動平均（目安）: ${ma20}

この銘柄に関する直近ニュース（分析の中心にすること）:
${companyNewsText}
${worldNewsSection}
重要なルール:
- 中東情勢、ホルムズ海峡、原油価格といった地政学・マクロ経済の話題は、上記のニュースの中に「この銘柄に直接関係する」と明確に読み取れる記述がある場合を除き、絶対に言及しないこと（無関係な銘柄にも同じ地政学コメントを使い回すことは禁止）
- 書けるだけの具体的な材料が無ければ、無理に埋めず「材料が少ない」と正直に書くこと

以上を踏まえて、日本語で250〜350文字程度で次を出力してください：
1. テクニカル面から見た現状（過熱感やトレンドなど）
2. この銘柄固有のニュースから見た追い風/逆風（関連ニュースが乏しい場合はその旨を明記）
3. 総合した見立て（強気・弱気・中立のいずれかの傾向とその理由）
最後に必ず「※投資助言ではありません。最終判断はご自身で行ってください」と付け加えてください。`;

    const text = await callGemini(prompt);
    box.innerHTML = `<div class="adviceBox">${escapeHtml(text)}</div>`;
  } catch (e) {
    box.innerHTML = '<div class="errorText adviceBox">分析の生成に失敗しました。しばらくしてから再度お試しください。</div>';
  }
}

/* ---------- テーマ提案 ---------- */
async function loadThemeSuggestions() {
  const el = document.getElementById('themeResult');
  if (!getFinnhubKey() || !getGeminiKey()) {
    el.innerHTML = '<div class="errorText">APIキーが未設定です。右上の設定ボタンから登録してください。</div>';
    return;
  }
  el.innerHTML = '<div class="loadingText">最新ニュースを分析中です...</div>';

  try {
    const news = await fetchGeneralNews();
    const headlines = news.slice(0, 20).map(n => `- ${n.headline}`).join('\n');

    const prompt = `以下は本日の市場関連ニュースの見出し一覧です。

${headlines}

これらから読み取れる「注目テーマ」を最大3つ選び、それぞれについて関連する米国上場銘柄のティッカーを2〜3個、理由とともに提案してください。
出力は必ず次のJSON形式のみで、他の文章は含めないでください：

[
  {"theme": "テーマ名", "reason": "なぜ今注目されているかの簡潔な説明（日本語）", "tickers": [{"symbol":"TICKER","note":"一言コメント"}]}
]`;

    const raw = await callGemini(prompt);
    const jsonStr = raw.replace(/```json|```/g, '').trim();
    const themes = JSON.parse(jsonStr);

    el.innerHTML = themes.map(t => `
      <div class="themeCard">
        <h3>${escapeHtml(t.theme)}</h3>
        <div class="tickers">${(t.tickers || []).map(tk => `<span class="ticker">${escapeHtml(tk.symbol)}</span>`).join('')}</div>
        <p>${escapeHtml(t.reason)}</p>
        ${(t.tickers || []).map(tk => tk.note ? `<p style="margin-top:4px;">・${escapeHtml(tk.symbol)}: ${escapeHtml(tk.note)}</p>` : '').join('')}
      </div>
    `).join('');
  } catch (e) {
    el.innerHTML = '<div class="errorText">テーマ提案の生成に失敗しました。しばらくしてから再度お試しください。</div>';
  }
}

/* ---------- Gemini呼び出し ---------- */
async function callGemini(prompt) {
  const key = getGeminiKey();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });
  if (!res.ok) throw new Error('gemini fetch failed');
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '応答を取得できませんでした。';
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
