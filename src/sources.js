const { GLOBAL_INSTRUMENTS, INDIAN_INSTRUMENTS, DATA_STATUS } = require('./instrument-registry');
const { getSessionState, classifyQuoteDataStatus, reconcileSessionState, sessionLabel, dataStatusLabel } = require('./sessions');

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/139.0 Safari/537.36';
const DEFAULT_TIMEOUT_MS = 15000;

async function fetchText(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    const { timeoutMs, ...fetchOptions } = options;
    const response = await fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
      headers: {
        'User-Agent': DEFAULT_USER_AGENT,
        'Accept': 'text/html,application/xml,application/rss+xml,application/json;q=0.9,*/*;q=0.8',
        'Cache-Control': 'no-cache',
        ...(fetchOptions.headers || {}),
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJSON(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    const { timeoutMs, ...fetchOptions } = options;
    const response = await fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
      headers: {
        'User-Agent': DEFAULT_USER_AGENT,
        'Accept': 'application/json',
        'Cache-Control': 'no-cache',
        ...(fetchOptions.headers || {}),
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function stripTags(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ').trim();
}

function parseRSS(xml, limit = 12) {
  const items = [];
  const itemRe = /<item[\s\S]*?<\/item>/gi;
  const tag = (item, name) => {
    const m = item.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'));
    return m ? stripTags(m[1]) : '';
  };
  for (const item of xml.match(itemRe) || []) {
    const title = tag(item, 'title');
    const link = tag(item, 'link') || tag(item, 'guid');
    const pubDate = tag(item, 'pubDate') || tag(item, 'dc:date');
    const description = tag(item, 'description');
    if (title) items.push({ title, link, publishedAt: pubDate || null, summary: description });
    if (items.length >= limit) break;
  }
  return items;
}

async function rssFeed(url, label, limit = 12) {
  try {
    const xml = await fetchText(url);
    return { source: label, items: parseRSS(xml, limit), error: null, fetchedAt: new Date().toISOString() };
  } catch (error) {
    return { source: label, items: [], error: error.name === 'AbortError' ? `Timeout fetching ${label}` : error.message, fetchedAt: new Date().toISOString() };
  }
}

// ---------- RBI ----------
async function fetchRBI() {
  const feeds = [
    ['https://rbi.org.in/pressreleases_rss.xml', 'RBI Press Releases'],
    ['https://rbi.org.in/notifications_rss.xml', 'RBI Notifications'],
  ];
  const results = await Promise.all(feeds.map(([url, label]) => rssFeed(url, label, 10)));
  const stories = results.flatMap(r => r.items.map(item => ({
    title: item.title,
    priority: 'important',
    whatHappened: item.summary || item.title,
    why: 'Official RBI publication; review the linked release or circular for applicability and effective dates.',
    next: item.link ? `Primary source: ${item.link}` : 'Review the official RBI publication.',
    source: r.source,
    publishedAt: item.publishedAt,
    url: item.link,
  }))).slice(0, 20);
  return { stories, sources: results.map(r => r.source), errors: results.filter(r => r.error).map(r => r.error) };
}

// ---------- SEBI ----------
function parseSEBIListing(html, limit = 20) {
  const rows = [];
  const rowRe = /<tr[\s\S]*?<\/tr>/gi;
  for (const row of html.match(rowRe) || []) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m => stripTags(m[1]));
    if (cells.length < 3) continue;
    const date = cells[0];
    const title = cells[cells.length - 1];
    const type = cells[cells.length - 2] || '';
    if (/\d{2} [A-Za-z]{3} \d{4}/.test(date) && title && title.toLowerCase() !== 'title') {
      const linkMatch = row.match(/href=["']([^"']+)["']/i);
      let url = linkMatch ? linkMatch[1] : '';
      if (url.startsWith('/')) url = 'https://www.sebi.gov.in' + url;
      rows.push({ date, type, title, url });
    }
    if (rows.length >= limit) break;
  }
  if (!rows.length) {
    const text = stripTags(html);
    const re = /(\d{2} [A-Za-z]{3} \d{4})\s+(Press Releases|Circulars|Reports|Speeches|Orders|Regulations)\s+(.{15,180}?)(?=\d{2} [A-Za-z]{3} \d{4}|$)/g;
    let m;
    while ((m = re.exec(text)) && rows.length < limit) rows.push({ date: m[1], type: m[2], title: m[3].trim(), url: '' });
  }
  return rows;
}

async function fetchSEBI() {
  const url = 'https://www.sebi.gov.in/sebiweb/home/HomeAction.do?doListingAll=yes&sid=6&smid=0&ssid=0';
  try {
    const html = await fetchText(url);
    const rows = parseSEBIListing(html, 25);
    const stories = rows.map(r => ({
      title: r.title,
      priority: /circular|regulation|board|derivative|settlement/i.test(r.title) ? 'important' : 'watch',
      whatHappened: `${r.type}: ${r.title}`,
      why: 'Official SEBI publication; assess affected entities, effective dates and market implications.',
      next: 'Open the official SEBI publication and verify the operative details.',
      source: 'SEBI', publishedAt: r.date, url: r.url,
    }));
    return { stories, source: 'SEBI', errors: [] };
  } catch (error) {
    return { stories: [], source: 'SEBI', errors: [error.name === 'AbortError' ? 'Timeout fetching SEBI' : error.message] };
  }
}

// ---------- Quote validation ----------

/**
 * Validate that a quote object has the minimum required fields
 * to be displayed. Rejects malformed or suspicious values.
 */
function isValidQuote(quote) {
  if (!quote) return false;
  if (typeof quote.last !== 'number' || !Number.isFinite(quote.last)) return false;
  if (quote.last <= 0) return false;
  if (typeof quote.changePct === 'number' && Math.abs(quote.changePct) > 100) return false; // Suspicious >100% move
  return true;
}

// ---------- Data status classification (legacy compat) ----------
function classifyDataStatus(quoteStatus, ageMinutes) {
  if (ageMinutes == null || Number.isNaN(ageMinutes)) return DATA_STATUS.UNAVAILABLE;
  if (quoteStatus === 'INTRADAY' && ageMinutes <= 20) return DATA_STATUS.LIVE_INTRADAY;
  if (ageMinutes <= 20 * 60) return DATA_STATUS.TODAY_CLOSE;
  if (ageMinutes <= 4 * 24 * 60) return DATA_STATUS.PREVIOUS_SESSION;
  return DATA_STATUS.STALE;
}

function sessionStatusFor(marketState) {
  switch (marketState) {
    case 'REGULAR': return 'MARKET_OPEN';
    case 'PRE': return 'PRE_MARKET';
    case 'POST': return 'POST_MARKET';
    case 'CLOSED': return 'MARKET_CLOSED';
    default: return 'UNKNOWN';
  }
}

// ---------- Yahoo Finance ----------
async function fetchYahooChart(symbol, range = '5d', interval = '1d', opts = {}) {
  const hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
  let lastError = null;
  const paramSets = [
    'range=1d&interval=1m&includePrePost=true',
    'range=1d&interval=5m&includePrePost=true',
    `range=${encodeURIComponent(range)}&interval=1d&includePrePost=false`,
  ];
  for (const host of hosts) {
    for (const params of paramSets) {
      const url = `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?${params}&events=history&_=${Date.now()}`;
      try {
        const json = await fetchJSON(url, { timeoutMs: 15000, headers: { 'Cache-Control': 'no-cache' } });
        const r = json?.chart?.result?.[0];
        if (!r) throw new Error(`No chart result for ${symbol}`);
        const meta = r.meta || {};
        const closes = r.indicators?.quote?.[0]?.close || [];
        const timestamps = r.timestamp || [];
        const valid = closes.map((v, i) => ({ v, ts: timestamps[i] }))
          .filter(x => typeof x.v === 'number' && Number.isFinite(x.v) && typeof x.ts === 'number');
        const metaPrice = Number.isFinite(meta.regularMarketPrice) ? meta.regularMarketPrice : null;
        const metaTime = Number.isFinite(meta.regularMarketTime) ? meta.regularMarketTime : null;
        const chartPoint = valid.length ? valid[valid.length - 1] : null;
        const marketState = String(meta.marketState || '').toUpperCase();
        let last = null, ts = null, quoteStatus = 'UNAVAILABLE';
        if (metaPrice != null && metaTime != null) {
          last = metaPrice; ts = metaTime;
          quoteStatus = ['REGULAR', 'PRE', 'POST'].includes(marketState) ? 'INTRADAY' : 'LATEST CLOSE';
        } else if (chartPoint) {
          last = chartPoint.v; ts = chartPoint.ts;
          quoteStatus = params.includes('interval=1m') || params.includes('interval=5m') ? 'INTRADAY' : 'LATEST CLOSE';
        }
        if (last == null || ts == null) throw new Error(`No usable quote for ${symbol}`);
        let previous = Number.isFinite(meta.previousClose) ? meta.previousClose : null;
        if (previous == null && valid.length > 1) previous = valid[valid.length - 2].v;
        if (previous == null) previous = last;
        let normalizedLast = last, normalizedPrevious = previous;
        if (symbol === '^TNX' || symbol === '^IRX') { normalizedLast = last / 10; normalizedPrevious /= 10; }
        const changePct = previous == null ? null : ((normalizedLast - normalizedPrevious) / normalizedPrevious) * 100;
        const ageMin = Math.max(0, (Date.now() - ts * 1000) / 60000);
        const liveEligible = ['REGULAR', 'PRE', 'POST'].includes(marketState) && ageMin <= 20;
        if (quoteStatus === 'INTRADAY' && !liveEligible) quoteStatus = 'LATEST CLOSE';

        if (!isValidQuote({ last: normalizedLast, changePct })) throw new Error(`Quote validation failed for ${symbol}`);

        return {
          symbol, last: normalizedLast, previous: normalizedPrevious, changePct,
          asOf: new Date(ts * 1000).toISOString(), marketState: marketState || null,
          quoteStatus, exchangeTimezoneName: meta.exchangeTimezoneName || null,
          currency: meta.currency || null, provider: `Yahoo Finance ${host}`,
          freshnessMinutes: Number(ageMin.toFixed(1)), sourceUrl: url,
          sourceTimestampUnix: ts, verifiedLive: quoteStatus === 'INTRADAY' && ageMin <= 20,
        };
      } catch (e) { lastError = e; }
    }
  }
  throw lastError || new Error(`No market data for ${symbol}`);
}

async function fetchYahooSparkQuotes(symbols) {
  const encoded = symbols.map(encodeURIComponent).join(',');
  let lastError = null;
  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    const url = `https://${host}/v7/finance/spark?symbols=${encoded}&range=1d&interval=1m&_=${Date.now()}`;
    try {
      const json = await fetchJSON(url, { timeoutMs: 20000, headers: { 'Cache-Control': 'no-cache' } });
      const results = json?.spark?.result || [];
      const out = {};
      for (const r of results) {
        const meta = r?.meta || {};
        const response = r?.response?.[0] || {};
        const ts = Array.isArray(response.timestamp) ? response.timestamp : [];
        const closes = Array.isArray(response.indicators?.quote?.[0]?.close) ? response.indicators.quote[0].close : [];
        const valid = closes.map((v, i) => ({ v, ts: ts[i] })).filter(x => Number.isFinite(x.v) && Number.isFinite(x.ts));
        const lastPoint = valid.at(-1);
        const last = Number.isFinite(meta.regularMarketPrice) ? meta.regularMarketPrice : lastPoint?.v;
        const stamp = Number.isFinite(meta.regularMarketTime) ? meta.regularMarketTime : lastPoint?.ts;
        if (!Number.isFinite(last) || !Number.isFinite(stamp)) continue;
        let prev = Number.isFinite(meta.previousClose) ? meta.previousClose : null;
        if (prev == null && valid.length > 1) prev = valid.at(-2).v;
        if (prev == null) prev = last;
        const state = String(meta.marketState || '').toUpperCase();
        let nlast = last, nprev = prev;
        if (r.symbol === '^TNX' || r.symbol === '^IRX') { nlast /= 10; nprev /= 10; }
        const ageMin = Math.max(0, (Date.now() - stamp * 1000) / 60000);
        let status = ['REGULAR', 'PRE', 'POST'].includes(state) && ageMin <= 20 ? 'INTRADAY' : 'LATEST CLOSE';

        if (!isValidQuote({ last: nlast, changePct: null })) continue;

        out[r.symbol] = {
          symbol: r.symbol, last: nlast, previous: nprev,
          changePct: nprev ? ((nlast - nprev) / nprev) * 100 : null,
          asOf: new Date(stamp * 1000).toISOString(), marketState: state || null,
          quoteStatus: status, exchangeTimezoneName: meta.exchangeTimezoneName || null,
          currency: meta.currency || null, provider: `Yahoo Finance ${host} spark`,
          freshnessMinutes: Number(ageMin.toFixed(1)), sourceUrl: url,
          sourceTimestampUnix: stamp, verifiedLive: status === 'INTRADAY' && ageMin <= 20,
        };
      }
      if (Object.keys(out).length) return out;
      throw new Error('Yahoo spark returned no usable quotes');
    } catch (e) { lastError = e; }
  }
  throw lastError || new Error('Yahoo spark unavailable');
}

// ---------- Twelve Data ----------
async function fetchTwelveDataQuote(symbol, apiKey, opts = {}) {
  if (!apiKey) throw new Error('TWELVE_DATA_API_KEY not configured');
  const url = new URL('https://api.twelvedata.com/quote');
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('apikey', apiKey);
  url.searchParams.set('format', 'JSON');
  if (opts.exchange) url.searchParams.set('exchange', opts.exchange);
  const json = await fetchJSON(url.toString(), {
    timeoutMs: opts.timeoutMs || 20000,
    headers: { 'Authorization': `apikey ${apiKey}` },
  });
  if (!json || json.status === 'error' || json.code || json.message && !json.symbol) {
    throw new Error(json?.message || `Twelve Data returned no usable quote for ${symbol}`);
  }
  const last = Number(json.close ?? json.price ?? json.last);
  const previous = Number(json.previous_close ?? json.prev_close);
  const pct = Number(json.percent_change);
  const ts = Number(json.last_quote_at ?? json.timestamp);
  if (!Number.isFinite(last) || !Number.isFinite(ts)) throw new Error(`Twelve Data quote invalid for ${symbol}`);
  if (!isValidQuote({ last, changePct: Number.isFinite(pct) ? pct : null })) throw new Error(`Twelve Data quote validation failed for ${symbol}`);
  const marketOpen = json.is_market_open === true;
  const quoteStatus = marketOpen ? 'INTRADAY' : 'LATEST CLOSE';
  const ageMin = Math.max(0, (Date.now() - ts * 1000) / 60000);
  return {
    symbol: json.symbol || symbol,
    last,
    previous: Number.isFinite(previous) ? previous : last,
    changePct: Number.isFinite(pct) ? pct : (Number.isFinite(previous) && previous ? ((last - previous) / previous) * 100 : null),
    asOf: new Date(ts * 1000).toISOString(),
    marketState: marketOpen ? 'REGULAR' : 'CLOSED',
    quoteStatus,
    exchangeTimezoneName: json.timezone || null,
    currency: json.currency || null,
    provider: 'Twelve Data',
    freshnessMinutes: Number(ageMin.toFixed(1)),
    sourceUrl: `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(symbol)}`,
    sourceTimestampUnix: ts,
    verifiedLive: marketOpen && ageMin <= 20,
  };
}

// ---------- Finnhub ----------
async function fetchFinnhubQuote(symbol, apiKey, opts = {}) {
  if (!apiKey) throw new Error('FINNHUB_API_KEY not configured');
  const url = new URL('https://finnhub.io/api/v1/quote');
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('token', apiKey);
  const json = await fetchJSON(url.toString(), { timeoutMs: opts.timeoutMs || 18000 });
  const last = Number(json?.c);
  const previous = Number(json?.pc);
  const ts = Number(json?.t);
  if (!Number.isFinite(last) || !Number.isFinite(ts) || last === 0) throw new Error(`Finnhub quote invalid for ${symbol}`);
  const pct = Number.isFinite(previous) && previous ? ((last - previous) / previous) * 100 : Number(json?.dp);
  const ageMin = Math.max(0, (Date.now() - ts * 1000) / 60000);
  return {
    symbol, last, previous: Number.isFinite(previous) ? previous : last,
    changePct: Number.isFinite(pct) ? pct : null,
    asOf: new Date(ts * 1000).toISOString(),
    marketState: null,
    quoteStatus: ageMin <= 20 ? 'INTRADAY' : 'LATEST CLOSE',
    exchangeTimezoneName: null,
    currency: null,
    provider: 'Finnhub',
    freshnessMinutes: Number(ageMin.toFixed(1)),
    sourceUrl: `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}`,
    sourceTimestampUnix: ts,
    verifiedLive: ageMin <= 20,
  };
}

// ---------- Alpha Vantage ----------
async function fetchAlphaVantageGlobalQuote(symbol, apiKey, opts = {}) {
  if (!apiKey) throw new Error('ALPHAVANTAGE_API_KEY not configured');
  const url = new URL('https://www.alphavantage.co/query');
  url.searchParams.set('function', 'GLOBAL_QUOTE');
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('apikey', apiKey);
  const json = await fetchJSON(url.toString(), { timeoutMs: opts.timeoutMs || 18000 });
  if (json?.Note) throw new Error(`Alpha Vantage rate limit: ${json.Note}`);
  if (json?.Information) throw new Error(`Alpha Vantage: ${json.Information}`);
  const q = json?.['Global Quote'] || {};
  const last = Number(q['05. price']);
  const previous = Number(q['08. previous close']);
  const pct = Number(String(q['10. change percent'] || '').replace('%', ''));
  const date = q['07. latest trading day'];
  if (!Number.isFinite(last) || !date) throw new Error(`Alpha Vantage quote invalid for ${symbol}`);
  const ts = Date.parse(`${date}T16:00:00Z`) / 1000;
  return {
    symbol, last,
    previous: Number.isFinite(previous) ? previous : last,
    changePct: Number.isFinite(pct) ? pct : (Number.isFinite(previous) && previous ? ((last - previous) / previous) * 100 : null),
    asOf: new Date(ts * 1000).toISOString(),
    marketState: 'CLOSED', quoteStatus: 'LATEST CLOSE',
    exchangeTimezoneName: 'America/New_York', currency: 'USD',
    provider: 'Alpha Vantage (EOD)', freshnessMinutes: Number(((Date.now() - ts * 1000) / 60000).toFixed(1)),
    sourceUrl: `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(symbol)}`,
    sourceTimestampUnix: ts, verifiedLive: false,
  };
}

async function fetchAlphaVantageFx(base, quote, apiKey, opts = {}) {
  if (!apiKey) throw new Error('ALPHAVANTAGE_API_KEY not configured');
  const url = new URL('https://www.alphavantage.co/query');
  url.searchParams.set('function', 'CURRENCY_EXCHANGE_RATE');
  url.searchParams.set('from_currency', base);
  url.searchParams.set('to_currency', quote);
  url.searchParams.set('apikey', apiKey);
  const json = await fetchJSON(url.toString(), { timeoutMs: opts.timeoutMs || 18000 });
  if (json?.Note) throw new Error(`Alpha Vantage rate limit: ${json.Note}`);
  const q = json?.['Realtime Currency Exchange Rate'];
  const last = Number(q?.['5. Exchange Rate']);
  const ts = Date.parse(q?.['6. Last Refreshed'] || '');
  if (!Number.isFinite(last) || !Number.isFinite(ts)) throw new Error(`Alpha Vantage FX invalid for ${base}/${quote}`);
  return {
    symbol: `${base}/${quote}`, last, previous: last, changePct: null,
    asOf: new Date(ts).toISOString(), marketState: 'REGULAR', quoteStatus: 'INTRADAY',
    exchangeTimezoneName: null, currency: quote, provider: 'Alpha Vantage FX',
    freshnessMinutes: Number(((Date.now() - ts) / 60000).toFixed(1)),
    sourceUrl: url.toString().replace(apiKey, 'REDACTED'), sourceTimestampUnix: Math.floor(ts / 1000),
    verifiedLive: true,
  };
}

// ---------- Global Provider Router ----------
const GLOBAL_PROVIDER_CHAINS = {
  sp500: { label: 'S&P 500', twelve: ['SPX'], yahoo: '^GSPC', finnhub: [] },
  nasdaq: { label: 'Nasdaq Composite', twelve: ['IXIC'], yahoo: '^IXIC', finnhub: [] },
  dow: { label: 'Dow Jones', twelve: ['DJI'], yahoo: '^DJI', finnhub: [] },
  nikkei: { label: 'Nikkei 225', twelve: ['N225', 'NI225'], yahoo: '^N225', finnhub: [] },
  hangSeng: { label: 'Hang Seng', twelve: ['HSI'], yahoo: '^HSI', finnhub: [] },
  us10y: { label: 'US 10Y Treasury', twelve: ['US10Y', 'TNX'], yahoo: '^TNX', finnhub: [] },
  us2y: { label: 'US 2Y Treasury', twelve: ['US02Y', 'US2Y', 'IRX'], yahoo: '^IRX', finnhub: [] },
  dxy: { label: 'DXY', twelve: ['DXY'], yahoo: 'DX-Y.NYB', finnhub: [] },
  eurUsd: { label: 'EUR/USD', twelve: ['EUR/USD'], yahoo: 'EURUSD=X', finnhub: ['OANDA:EUR_USD'] },
  usdJpy: { label: 'USD/JPY', twelve: ['USD/JPY'], yahoo: 'JPY=X', finnhub: ['OANDA:USD_JPY'] },
  brent: { label: 'Brent Crude', twelve: ['BRENT'], yahoo: 'BZ=F', finnhub: [] },
  gold: { label: 'Gold', twelve: ['XAU/USD'], yahoo: 'GC=F', finnhub: [] },
  copper: { label: 'Copper', twelve: ['COPPER', 'XCU/USD'], yahoo: 'HG=F', finnhub: [] },
};

async function tryProviderQuote(key, chain, errors) {
  const primaryErrors = [];
  const secondaryErrors = [];

  // Primary: Twelve Data
  if (process.env.TWELVE_DATA_API_KEY) {
    for (const symbol of chain.twelve || []) {
      try {
        return await fetchTwelveDataQuote(symbol, process.env.TWELVE_DATA_API_KEY, { timeoutMs: 30000 });
      } catch (e) { primaryErrors.push(`${symbol}: ${e.message}`); }
    }
  }

  // Secondary: Finnhub
  if (process.env.FINNHUB_API_KEY) {
    for (const symbol of chain.finnhub || []) {
      try {
        return await fetchFinnhubQuote(symbol, process.env.FINNHUB_API_KEY, { timeoutMs: 25000 });
      } catch (e) { secondaryErrors.push(`${symbol}: ${e.message}`); }
    }
  }

  // Tertiary: Alpha Vantage EOD (never labelled live intraday)
  if (process.env.ALPHAVANTAGE_API_KEY && chain.alphaVantage) {
    try {
      return await fetchAlphaVantageGlobalQuote(chain.alphaVantage, process.env.ALPHAVANTAGE_API_KEY, { timeoutMs: 25000 });
    } catch (e) {
      errors.push(`Alpha Vantage · ${chain.label}: ${e.message}`);
    }
  }

  // Final fallback: Yahoo Finance
  if (chain.yahoo) {
    try {
      const q = await fetchYahooChart(chain.yahoo, '5d', '1d', { preferIntraday: true });
      // Note: fallback usage is tracked via the provider field on the quote object,
      // not as a warning. Provider fallback is expected behavior, not an error.
      return q;
    } catch (e) {
      errors.push(`All providers failed · ${chain.label}: ${e.message}`);
    }
  }
  return null;
}

async function fetchGlobalMarketQuotes() {
  const data = {};
  const errors = [];
  const keys = Object.keys(GLOBAL_PROVIDER_CHAINS);
  const concurrency = Math.max(1, Number(process.env.GLOBAL_MARKET_CONCURRENCY || 4));
  let cursor = 0;
  async function worker() {
    while (cursor < keys.length) {
      const key = keys[cursor++];
      const q = await tryProviderQuote(key, GLOBAL_PROVIDER_CHAINS[key], errors);
      if (q && isValidQuote(q)) data[key] = q;
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, keys.length) }, worker));

  const configured = [
    process.env.TWELVE_DATA_API_KEY && 'Twelve Data',
    process.env.FINNHUB_API_KEY && 'Finnhub',
    process.env.ALPHAVANTAGE_API_KEY && 'Alpha Vantage',
    'Yahoo Finance fallback',
  ].filter(Boolean);
  return {
    data,
    errors: [...new Set(errors)],
    provider: configured.join(' → '),
    providerOrder: configured,
    coverage: Object.fromEntries(Object.entries(data).map(([k, q]) => [k, { provider: q.provider, status: q.quoteStatus, asOf: q.asOf, freshnessMinutes: q.freshnessMinutes }])),
  };
}

// ---------- Indian Market Sources ----------

function normalizePct(value) {
  const n = Number(String(value ?? '').replace(/,/g, '').replace('%', '').trim());
  return Number.isFinite(n) ? n : null;
}

function normalizeNumber(value) {
  const n = Number(String(value ?? '').replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

async function fetchNseEndpoint(pathname) {
  const homeUrl = 'https://www.nseindia.com/';
  const apiUrl = `https://www.nseindia.com${pathname}`;
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/139.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-IN,en;q=0.9',
    'Referer': homeUrl,
    'Cache-Control': 'no-cache',
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 11000);
  try {
    const home = await fetch(homeUrl, { headers, signal: controller.signal });
    const cookie = home.headers.get('set-cookie') || home.headers.get('cookie') || '';
    const response = await fetch(apiUrl, {
      headers: { ...headers, ...(cookie ? { Cookie: cookie.split(',').map(x => x.split(';')[0]).join('; ') } : {}) },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`NSE API HTTP ${response.status} for ${pathname}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchFiiDiiNSE() {
  try {
    const json = await fetchNseEndpoint('/api/fiidiiTradeReact');
    const rows = Array.isArray(json) ? json : (Array.isArray(json?.data) ? json.data : []);
    const normalized = rows.map(r => ({
      date: r.date || r.tradeDate || r.timestamp || null,
      category: String(r.category || r.cat || r.type || '').toUpperCase(),
      net: normalizeNumber(r.netValue ?? r.net ?? r.netValueTraded),
    })).filter(r => r.net != null && /FII|FPI|DII/.test(r.category));
    const latestDate = normalized.map(r => r.date).find(Boolean) || null;
    const fii = normalized.find(r => /FII|FPI/.test(r.category));
    const dii = normalized.find(r => /DII/.test(r.category));
    if (!fii && !dii) throw new Error('NSE FII/DII response had no usable rows');
    const flow = (label, row) => row ? {
      name: `${label} net (latest available session)`,
      value: `${row.net >= 0 ? '+' : '-'}₹${Math.abs(row.net).toLocaleString('en-IN', { maximumFractionDigits: 2 })} cr`,
      direction: row.net >= 0 ? 'net buyers' : 'net sellers',
      asOf: latestDate,
      source: 'NSE FII/DII',
    } : null;
    return {
      flows: [flow('FII/FPI', fii), flow('DII', dii)].filter(Boolean),
      source: 'NSE FII/DII',
      asOf: latestDate || new Date().toISOString(),
      verifiedLive: true,
      errors: [],
    };
  } catch (e) {
    return { flows: [], source: 'NSE FII/DII', asOf: new Date().toISOString(), verifiedLive: false, errors: [e.message] };
  }
}

async function fetchFiiDiiFallback() {
  const url = 'https://www.indiainfoline.com/markets/fii-dii-activity';
  try {
    const html = await fetchText(url, { timeoutMs: 9000, headers: { 'Accept': 'text/html' } });
    const text = stripTags(html).replace(/\s+/g, ' ');
    const fii = text.match(/FII\s+Net\s+(-?[0-9,]+\.?[0-9]*)/i);
    const dii = text.match(/DII\s+Net\s+(-?[0-9,]+\.?[0-9]*)/i);
    return {
      flows: [
        fii && { name: 'FII net (fallback)', value: `${Number(fii[1].replace(/,/g, '')) >= 0 ? '+' : ''}₹${Math.abs(Number(fii[1].replace(/,/g, ''))).toLocaleString('en-IN')} cr`, direction: Number(fii[1].replace(/,/g, '')) >= 0 ? 'net buyers' : 'net sellers', verifiedLive: false, source: 'India Infoline fallback' },
        dii && { name: 'DII net (fallback)', value: `${Number(dii[1].replace(/,/g, '')) >= 0 ? '+' : ''}₹${Math.abs(Number(dii[1].replace(/,/g, ''))).toLocaleString('en-IN')} cr`, direction: Number(dii[1].replace(/,/g, '')) >= 0 ? 'net buyers' : 'net sellers', verifiedLive: false, source: 'India Infoline fallback' },
      ].filter(Boolean),
      source: 'India Infoline fallback', asOf: new Date().toISOString(), verifiedLive: false, errors: [],
    };
  } catch (e) {
    return { flows: [], source: 'India Infoline fallback', asOf: new Date().toISOString(), verifiedLive: false, errors: [e.message] };
  }
}

async function fetchInvestingIndex(url, name) {
  const html = await fetchText(url, { timeoutMs: 10000, headers: { 'Accept': 'text/html', 'User-Agent': 'Mozilla/5.0' } });
  const text = stripTags(html).replace(/\s+/g, ' ');
  const re = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s\\S]{0,250}Add to Watchlist\\s+([0-9]{1,3}(?:,[0-9]{3})*(?:\\.[0-9]{1,2})?)\\s+([+-]?[0-9,]+(?:\\.[0-9]+)?)\\s*\\(([+-]?[0-9.]+)%\\)', 'i');
  const m = text.match(re);
  if (!m) throw new Error(`Could not parse ${name} from Investing.com`);
  const last = normalizeNumber(m[1]);
  const changePct = normalizePct(m[3]);
  if (last == null) throw new Error(`Invalid ${name} quote from Investing.com`);
  return {
    name, last, changePct, asOf: new Date().toISOString(),
    quoteStatus: 'INTRADAY', marketState: 'REGULAR',
    freshnessMinutes: 1, verifiedLive: true,
    provider: 'Investing.com (delayed/public)',
  };
}

async function fetchIndianGsecV2() {
  const url = 'https://www.investing.com/rates-bonds/india-10-year-bond-yield';
  try {
    const html = await fetchText(url, { timeoutMs: 10000, headers: { 'Accept': 'text/html', 'User-Agent': 'Mozilla/5.0' } });
    const text = stripTags(html).replace(/\s+/g, ' ');
    const patterns = [
      /India 10-Year Bond Yield[\s\S]{0,180}([0-9]+\.[0-9]{2,3})\s*([+-]?[0-9]+\.?[0-9]*)%/i,
      /Real-time Data[^0-9]{0,50}([0-9]+\.[0-9]{2,3})/i,
    ];
    for (const re of patterns) {
      const m = text.match(re);
      if (m) return { name: 'India 10Y G-Sec', last: Number(m[1]), changePct: m[2] ? normalizePct(m[2]) : null, asOf: new Date().toISOString(), quoteStatus: 'INTRADAY', marketState: 'REGULAR', freshnessMinutes: 1, verifiedLive: true, provider: 'Investing.com (delayed/public)' };
    }
    throw new Error('Could not parse India 10Y G-Sec');
  } catch (e) {
    return null;
  }
}

async function fetchIndianMarketSet() {
  const data = {};
  const errors = [];

  // Primary: NSE official API
  try {
    const json = await fetchNseEndpoint('/api/allIndices');
    const rows = Array.isArray(json) ? json : (Array.isArray(json?.data) ? json.data : []);
    const wanted = {
      'NIFTY 50': 'nifty',
      'NIFTY MIDCAP 100': 'midcap100',
      'NIFTY SMALLCAP 100': 'smallcap100',
    };
    for (const r of rows) {
      const idx = String(r.index || r.indexSymbol || r.name || '').trim().toUpperCase();
      const key = wanted[idx];
      if (!key) continue;
      const last = normalizeNumber(r.last ?? r.lastPrice ?? r.indexValue);
      const prev = normalizeNumber(r.previousClose ?? r.prevClose);
      const pct = normalizePct(r.percentChange ?? r.percentageChange ?? r.changePercent);
      if (last == null) continue;
      if (!isValidQuote({ last, changePct: pct })) continue;
      data[key] = {
        symbol: idx,
        last,
        previous: prev,
        changePct: pct != null ? pct : (prev ? ((last - prev) / prev) * 100 : null),
        asOf: r.lastUpdateTime ? new Date(r.lastUpdateTime).toISOString() : new Date().toISOString(),
        quoteStatus: String(r.marketStatus || '').toLowerCase().includes('closed') ? 'LATEST CLOSE' : 'INTRADAY',
        marketState: String(r.marketStatus || '').toLowerCase().includes('closed') ? 'CLOSED' : 'REGULAR',
        exchangeTimezoneName: 'Asia/Kolkata', currency: 'INR',
        provider: 'NSE India official API',
        freshnessMinutes: 1,
        verifiedLive: true,
      };
    }
  } catch (e) {
    errors.push(e.message);
  }

  // Fallback: Yahoo for missing instruments
  const fallbackSymbols = { nifty: '^NSEI', sensex: '^BSESN', usdInr: 'USDINR=X' };
  const missing = Object.entries(fallbackSymbols).filter(([key]) => !data[key]);
  if (missing.length) {
    const entries = await Promise.allSettled(missing.map(async ([key, symbol]) => [key, await fetchYahooChart(symbol, '1d', '1m', { preferIntraday: true })]));
    for (const e of entries) {
      if (e.status === 'fulfilled' && isValidQuote(e.value[1])) data[e.value[0]] = e.value[1];
      else if (e.status === 'rejected') errors.push(e.reason?.message || String(e.reason));
    }
  }

  const extras = await Promise.allSettled([
    !data.midcap100 ? fetchInvestingIndex('https://www.investing.com/indices/cnx-midcap-historical-data', 'NIFTY Midcap 100') : Promise.resolve(data.midcap100),
    !data.smallcap100 ? fetchInvestingIndex('https://www.investing.com/indices/cnx-smallcap-historical-data', 'NIFTY Smallcap 100') : Promise.resolve(data.smallcap100),
    fetchFiiDiiNSE(),
    fetchIndianGsecV2(),
  ]);
  for (const e of extras) {
    if (e.status !== 'fulfilled' || !e.value) { if (e.status === 'rejected') errors.push(e.reason?.message || String(e.reason)); continue; }
    const v = e.value;
    if (Array.isArray(v.flows)) data.fiiDii = v;
    else if (v.name?.toLowerCase().includes('midcap')) data.midcap100 = v;
    else if (v.name?.toLowerCase().includes('smallcap')) data.smallcap100 = v;
    else if (v.name === 'India 10Y G-Sec') data.india10y = v;
  }

  if (!data.fiiDii?.flows?.length) {
    const fb = await fetchFiiDiiFallback();
    if (fb.flows?.length) data.fiiDii = fb;
    if (fb.errors?.length) errors.push(...fb.errors);
  }

  return { data, errors };
}

// ---------- Combined Market Fetch ----------
async function fetchMarkets() {
  const [india, global] = await Promise.all([
    fetchIndianMarketSet(),
    fetchGlobalMarketQuotes(),
  ]);
  return {
    data: india.data || {},
    errors: [...(india.errors || []), ...(global.errors || [])],
    globalQuotes: {
      data: global.data || {},
      errors: global.errors || [],
      provider: global.provider || 'No global provider returned usable quotes',
      providerOrder: global.providerOrder || [],
      coverage: global.coverage || {},
    },
    provider: `India: isolated NSE/Yahoo/Investing/IIFL feeds | Global: ${global.provider || 'unavailable'}`,
  };
}

// ---------- FRED ----------
async function fetchFREDSeries(seriesId, apiKey) {
  if (!apiKey) throw new Error('FRED_API_KEY not configured');
  const url = new URL('https://api.stlouisfed.org/fred/series/observations');
  url.searchParams.set('series_id', seriesId);
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('file_type', 'json');
  url.searchParams.set('sort_order', 'desc');
  url.searchParams.set('limit', '2');
  try {
    const json = await fetchJSON(url.toString());
    const obs = (json.observations || []).filter(x => x.value && x.value !== '.');
    if (!obs.length) throw new Error(`No FRED observation for ${seriesId}`);
    return { value: Number(obs[0].value), date: obs[0].date, previous: obs[1] ? Number(obs[1].value) : null };
  } catch (e) {
    // Redact the API key from any error messages that may contain the full URL
    const safeMsg = String(e.message || e).replace(/api_key=[^&\s]+/g, 'api_key=REDACTED');
    throw new Error(safeMsg);
  }
}

async function fetchFRED(apiKey) {
  if (!apiKey) return { data: {}, errors: ['FRED_API_KEY not configured'], source: 'FRED / Federal Reserve Bank of St. Louis' };
  const ids = { usRealGDP: 'A191RL1Q225SBE', usCPI: 'CPIAUCSL', usUnemployment: 'UNRATE', usFedFunds: 'FEDFUNDS' };
  const results = await Promise.allSettled(Object.entries(ids).map(async ([name, id]) => [name, await fetchFREDSeries(id, apiKey)]));
  const data = {}; const errors = [];
  for (const r of results) {
    if (r.status === 'fulfilled') data[r.value[0]] = r.value[1];
    else errors.push(r.reason?.message || String(r.reason));
  }
  return { data, errors, source: 'FRED / Federal Reserve Bank of St. Louis' };
}

// ---------- World Bank ----------
async function fetchWorldBank() {
  const countries = { india: 'IND', china: 'CHN', us: 'USA' };
  const results = await Promise.allSettled(Object.entries(countries).map(async ([name, code]) => {
    const j = await fetchJSON(`https://api.worldbank.org/v2/country/${code}/indicator/NY.GDP.MKTP.KD.ZG?format=json&per_page=5`);
    const latest = (j?.[1] || []).find(x => x.value !== null);
    return [name, latest ? { value: latest.value, year: latest.date, source: 'World Bank' } : null];
  }));
  const data = {}; const errors = [];
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value[1]) data[`${r.value[0]}GDPGrowth`] = r.value[1];
    else if (r.status === 'rejected') errors.push(r.reason?.message || String(r.reason));
  }
  return { data, errors, source: 'World Bank' };
}

// ---------- News RSS ----------
async function fetchNewsRSS(urlsCsv = '') {
  const defaults = [['https://feeds.bbci.co.uk/news/business/rss.xml', 'BBC Business RSS']];
  const configured = String(urlsCsv || '').split(',').map(x => x.trim()).filter(Boolean).map(x => [x, x]);
  const feeds = configured.length ? configured : defaults;
  const results = await Promise.all(feeds.map(([url, label]) => rssFeed(url, label, 15)));
  const stories = results.flatMap(r => r.items.map(item => ({
    title: item.title,
    priority: 'watch',
    whatHappened: item.summary || item.title,
    why: 'News item retrieved from RSS; verify against a primary source before treating it as confirmed.',
    next: item.link ? `Read source: ${item.link}` : 'Review the source publication.',
    source: r.source,
    publishedAt: item.publishedAt,
    url: item.link,
  }))).slice(0, 40);
  return { stories, errors: results.filter(r => r.error).map(r => r.error), sources: results.map(r => r.source) };
}

// ---------- Payload building / merge logic ----------

function keyFor(item) {
  if (item && typeof item.name === 'string' && typeof item.direction === 'string') {
    const flowMatch = item.name.match(/^(FII|DII)/i);
    if (flowMatch) return `FLOW:${flowMatch[1].toUpperCase()}`;
  }
  const primary = item?.name ?? item?.title ?? item?.bank ?? item?.segment ?? item?.sector
    ?? item?.term ?? item?.event ?? item?.instrument ?? item?.commodity;
  if (primary != null) return JSON.stringify(primary);
  return `RAW:${JSON.stringify(item)}`;
}

function mergeArray(baseArr, liveArr) {
  const base = Array.isArray(baseArr) ? baseArr : [];
  const live = Array.isArray(liveArr) ? liveArr : [];
  const map = new Map(base.map(x => [keyFor(x), x]));
  for (const item of live) {
    const key = keyFor(item);
    const previous = map.get(key);
    map.set(key, previous ? { ...previous, ...item } : item);
  }
  return Array.from(map.values());
}

function mergeSection(base, patch, arrayKeys = []) {
  const merged = { ...(base || {}), ...(patch || {}) };
  for (const key of arrayKeys) {
    if (Array.isArray(base?.[key]) || Array.isArray(patch?.[key])) merged[key] = mergeArray(base?.[key], patch?.[key]);
  }
  return merged;
}

/**
 * Enrich a quote with session-aware data status using the instrument registry.
 * Returns an object with dataStatus, sessionState, and isLive.
 */
function enrichWithSessionInfo(quote, instrumentKey, isIndian = false) {
  const registry = isIndian ? INDIAN_INSTRUMENTS : GLOBAL_INSTRUMENTS;
  const instrument = registry[instrumentKey];
  if (!instrument || !quote) {
    return {
      dataStatus: classifyDataStatus(quote?.quoteStatus, quote?.freshnessMinutes),
      sessionStatus: sessionStatusFor(quote?.marketState),
      isLive: quote?.verifiedLive || false,
    };
  }
  
  const classification = classifyQuoteDataStatus(quote, instrument);
  return {
    dataStatus: classification.dataStatus,
    sessionStatus: sessionLabel(classification.sessionState),
    isLive: classification.isLive,
    ageMinutes: classification.ageMinutes,
  };
}

function buildPayload(base, { rbi, sebi, markets, fred, worldbank, news }, now = new Date()) {
  const payload = JSON.parse(JSON.stringify(base));
  payload.updatedAt = now.toISOString();
  payload.sourceStatus = 'LIVE / PARTIAL';
  payload.refreshRun = { at: now.toISOString(), mode: 'live', generatedBy: 'Macro & Markets live ingestion' };
  payload.sources = [];

  if (rbi?.stories?.length) payload.sections['rbi-watch'] = mergeSection(payload.sections['rbi-watch'], { updatedAt: now.toISOString(), source: rbi.sources, stories: rbi.stories, liveAvailable: true }, ['stories']);
  if (sebi?.stories?.length) payload.sections['sebi-watch'] = mergeSection(payload.sections['sebi-watch'], { updatedAt: now.toISOString(), source: 'SEBI', stories: sebi.stories, liveAvailable: true }, ['stories']);

  // ---------- Global Markets (isolated from Indian Markets) ----------
  if (Object.keys(markets?.globalQuotes?.data || {}).length) {
    const m = markets.globalQuotes.data;
    const pct = x => x == null ? '—' : `${x >= 0 ? '▲' : '▼'}${Math.abs(x).toFixed(2)}%`;
    const asset = (name, key, dec = 2, suffix = '') => {
      const q = m[key];
      if (!q || !isValidQuote(q)) return null;
      const ageMin = typeof q.freshnessMinutes === 'number' ? q.freshnessMinutes : null;
      const session = enrichWithSessionInfo(q, key, false);
      return {
        name,
        level: typeof q.last === 'number' ? q.last.toLocaleString('en-IN', { maximumFractionDigits: dec }) + suffix : '—',
        change: pct(q.changePct),
        asOf: q.asOf,
        dataStatus: session.dataStatus,
        sessionStatus: session.sessionStatus,
        source: q.provider,
        timestamp: q.asOf,
        currency: q.currency || null,
        isLive: session.isLive,
        verifiedLive: q.verifiedLive || false,
        ageMinutes: session.ageMinutes,
      };
    };
    payload.sections['global-markets'] = mergeSection(payload.sections['global-markets'], {
      updatedAt: now.toISOString(), source: markets.globalQuotes.provider, liveAvailable: true,
      equities: [asset('S&P 500', 'sp500'), asset('Nasdaq', 'nasdaq'), asset('Dow Jones', 'dow'), asset('Nikkei 225', 'nikkei'), asset('Hang Seng', 'hangSeng')].filter(Boolean),
      bonds: [asset('US 10Y Treasury', 'us10y', 3, '%'), asset('US 2Y Treasury', 'us2y', 3, '%')].filter(Boolean),
      currencies: [asset('DXY', 'dxy', 3), asset('EUR/USD', 'eurUsd', 4), asset('USD/JPY', 'usdJpy', 3)].filter(Boolean),
      commodities: [asset('Brent Crude', 'brent', 2, ' $/bbl'), asset('Gold', 'gold', 2, ' $/oz'), asset('Copper', 'copper', 3, ' $/lb')].filter(Boolean),
    }, ['equities', 'bonds', 'currencies', 'commodities']);
  }

  // ---------- Indian Markets (isolated from Global Markets) ----------
  if (markets?.data && Object.keys(markets.data).length) {
    const d = markets.data;
    const pct = x => x == null ? '—' : `${x >= 0 ? '▲' : '▼'}${Math.abs(x).toFixed(2)}%`;
    const indianAsset = (name, quote, instrumentKey, dec = 2) => {
      if (!quote || typeof quote.last !== 'number' || !isValidQuote(quote)) return null;
      const session = enrichWithSessionInfo(quote, instrumentKey, true);
      return {
        name,
        level: quote.last.toLocaleString('en-IN', { maximumFractionDigits: dec }),
        change: pct(quote.changePct),
        asOf: quote.asOf,
        dataStatus: session.dataStatus,
        sessionStatus: session.sessionStatus,
        source: quote.provider,
        timestamp: quote.asOf,
        currency: 'INR',
        isLive: session.isLive,
        verifiedLive: quote.verifiedLive || false,
        ageMinutes: session.ageMinutes,
      };
    };
    const indianAssets = [
      indianAsset('Nifty 50', d.nifty, 'nifty'),
      indianAsset('Sensex', d.sensex, 'sensex'),
      indianAsset('USD/INR', d.usdInr, 'usdInr', 3),
      indianAsset('Nifty Midcap 100', d.midcap100, 'midcap100'),
      indianAsset('Nifty Smallcap 100', d.smallcap100, 'smallcap100'),
      d.india10y && isValidQuote(d.india10y) ? (() => {
        const s = enrichWithSessionInfo(d.india10y, 'india10y', true);
        return {
          name: 'India 10Y G-Sec',
          level: `${Number(d.india10y.last).toFixed(3)}%`,
          change: d.india10y.changePct == null ? '—' : pct(d.india10y.changePct),
          asOf: d.india10y.asOf,
          dataStatus: s.dataStatus,
          sessionStatus: s.sessionStatus,
          source: d.india10y.provider,
          timestamp: d.india10y.asOf,
          currency: 'INR',
          isLive: s.isLive,
          verifiedLive: d.india10y.verifiedLive || false,
          ageMinutes: s.ageMinutes,
        };
      })() : null,
    ].filter(Boolean);

    const patch = { updatedAt: now.toISOString(), liveAvailable: indianAssets.length > 0 };
    if (indianAssets.length) patch.assets = indianAssets;
    if (d.fiiDii?.flows?.length) {
      patch.flows = d.fiiDii.flows.map(f => ({ ...f, asOf: d.fiiDii.asOf, verification: d.fiiDii.source }));
      patch.source = d.fiiDii.source;
    }
    if (indianAssets.length || d.fiiDii?.flows?.length) {
      payload.sections['indian-markets'] = mergeSection(payload.sections['indian-markets'], patch, ['assets', 'flows']);
    }
  }

  // ---------- Forex & Commodities sections ----------
  const quoteFor = key => markets?.data?.[key] || markets?.globalQuotes?.data?.[key] || null;
  const marketAsset = (name, key, dec = 3, unit = '', isIndian = false) => {
    const q = quoteFor(key);
    if (!q || typeof q.last !== 'number' || !isValidQuote(q)) return null;
    const session = enrichWithSessionInfo(q, key, isIndian);
    const pctVal = q.changePct == null ? '—' : `${q.changePct >= 0 ? '▲' : '▼'}${Math.abs(q.changePct).toFixed(2)}%`;
    return {
      name,
      level: `${q.last.toLocaleString('en-IN', { maximumFractionDigits: dec })}${unit}`,
      change: pctVal,
      asOf: q.asOf,
      dataStatus: session.dataStatus,
      sessionStatus: session.sessionStatus,
      source: q.provider,
      isLive: session.isLive,
      verifiedLive: q.verifiedLive || false,
      ageMinutes: session.ageMinutes,
    };
  };
  const fxAssets = [
    marketAsset('DXY', 'dxy', 3),
    marketAsset('EUR/USD', 'eurUsd', 4),
    marketAsset('USD/JPY', 'usdJpy', 3),
    marketAsset('USD/INR', 'usdInr', 3, '', true),
  ].filter(Boolean);
  const commodityAssets = [
    marketAsset('Brent Crude', 'brent', 2, ' $/bbl'),
    marketAsset('Gold', 'gold', 2, ' $/oz'),
    marketAsset('Copper', 'copper', 3, ' $/lb'),
  ].filter(Boolean);
  if (fxAssets.length) payload.sections['forex-capital-flows'] = mergeSection(payload.sections['forex-capital-flows'], {
    updatedAt: now.toISOString(), assets: fxAssets, liveAvailable: true,
    source: [...new Set(fxAssets.map(x => x.source))],
  }, ['assets']);
  if (commodityAssets.length) payload.sections['commodities-energy'] = mergeSection(payload.sections['commodities-energy'], {
    updatedAt: now.toISOString(), assets: commodityAssets, liveAvailable: true,
    source: [...new Set(commodityAssets.map(x => x.source))],
  }, ['assets']);

  // ---------- FRED macro data ----------
  if (fred?.data && Object.keys(fred.data).length) {
    const d = fred.data;
    const indicators = [
      d.usRealGDP && { name: 'US Real GDP growth', current: `${d.usRealGDP.value}`, previous: d.usRealGDP.previous == null ? '—' : `${d.usRealGDP.previous}`, change: d.usRealGDP.previous == null ? '—' : (d.usRealGDP.value - d.usRealGDP.previous).toFixed(2), dataStatus: 'HISTORICAL', source: 'FRED' },
      d.usCPI && { name: 'US CPI index', current: `${d.usCPI.value}`, previous: d.usCPI.previous == null ? '—' : `${d.usCPI.previous}`, change: d.usCPI.previous == null ? '—' : (d.usCPI.value - d.usCPI.previous).toFixed(2), dataStatus: 'HISTORICAL', source: 'FRED' },
      d.usUnemployment && { name: 'US unemployment rate', current: `${d.usUnemployment.value}%`, previous: d.usUnemployment.previous == null ? '—' : `${d.usUnemployment.previous}%`, change: d.usUnemployment.previous == null ? '—' : `${(d.usUnemployment.value - d.usUnemployment.previous).toFixed(2)}pp`, dataStatus: 'HISTORICAL', source: 'FRED' },
      d.usFedFunds && { name: 'US Fed funds rate', current: `${d.usFedFunds.value}%`, previous: d.usFedFunds.previous == null ? '—' : `${d.usFedFunds.previous}%`, change: d.usFedFunds.previous == null ? '—' : `${(d.usFedFunds.value - d.usFedFunds.previous).toFixed(2)}pp`, dataStatus: 'HISTORICAL', source: 'FRED' },
    ].filter(Boolean);
    payload.sections['global-economy'] = mergeSection(payload.sections['global-economy'], { updatedAt: now.toISOString(), source: 'FRED', liveAvailable: true, indicators }, ['indicators', 'stories', 'gdpForecasts']);
  }

  if (worldbank?.data && Object.keys(worldbank.data).length) {
    const indicators = Object.entries(worldbank.data).map(([k, v]) => ({ name: k, current: `${v.value}%`, previous: '—', change: `Latest World Bank observation (${v.year})`, dataStatus: 'HISTORICAL', source: 'World Bank' }));
    payload.sections['global-economy'] = mergeSection(payload.sections['global-economy'], { updatedAt: now.toISOString(), source: [payload.sections['global-economy']?.source || '', 'World Bank'].filter(Boolean).join(', '), liveAvailable: true, indicators }, ['indicators', 'stories', 'gdpForecasts']);
  }

  if (news?.stories?.length) payload.sections['geopolitics-markets'] = mergeSection(payload.sections['geopolitics-markets'], { updatedAt: now.toISOString(), source: news.sources, liveAvailable: true, stories: news.stories }, ['stories']);

  payload.sections['rbi-watch'] ||= { updatedAt: now.toISOString(), source: 'RBI', stories: [], liveAvailable: false };
  payload.sections['sebi-watch'] ||= { updatedAt: now.toISOString(), source: 'SEBI', stories: [], liveAvailable: false };

  payload.dataQuality = {
    liveSections: Object.entries(payload.sections).filter(([, v]) => v?.liveAvailable).map(([k]) => k),
    staleSections: Object.entries(payload.sections).filter(([, v]) => v?.liveAvailable === false).map(([k]) => k),
    warnings: [...new Set([...(rbi?.errors || []), ...(sebi?.errors || []), ...(markets?.errors || []), ...(fred?.errors || []), ...(worldbank?.errors || []), ...(news?.errors || [])])]
      .map(w => String(w)
        .replace(/api_key=[^&\s]+/g, 'api_key=REDACTED')
        .replace(/apikey=[^&\s]+/g, 'apikey=REDACTED')
        .replace(/token=[^&\s]+/g, 'token=REDACTED')
      ),
  };
  payload.sources = [
    ...(rbi?.sources || []),
    ...(sebi?.source ? ['SEBI'] : []),
    ...(Object.keys(markets?.data || {}).length ? ['India market feeds (NSE official + Yahoo Finance + Investing.com)'] : []),
    ...(Object.keys(markets?.globalQuotes?.data || {}).length ? [`Global market feed: ${markets.globalQuotes.provider || 'provider chain'}`] : []),
    ...(Object.keys(fred?.data || {}).length ? ['FRED'] : []),
    ...(Object.keys(worldbank?.data || {}).length ? ['World Bank'] : []),
    ...(news?.stories?.length ? (news.sources || []) : []),
  ];

  // Never convert source warnings into analyst changes
  payload.changes = Array.isArray(payload.changes) ? payload.changes.filter(c => c?.title !== 'Source warning' && c?.section !== 'data-refresh') : [];
  return payload;
}

module.exports = { fetchRBI, fetchSEBI, fetchMarkets, fetchFRED, fetchWorldBank, fetchNewsRSS, buildPayload, isValidQuote };
