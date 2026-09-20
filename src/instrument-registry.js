/**
 * Market Instrument Registry
 * 
 * Central registry describing each instrument, region, asset class,
 * provider symbols, timezone/session, and acceptable freshness rules.
 * 
 * Used by the provider router in sources.js to normalize quote retrieval.
 */

// Freshness thresholds (in minutes)
const FRESHNESS = {
  INTRADAY_MAX: 20,       // Max age for LIVE_INTRADAY
  TODAY_CLOSE_MAX: 1200,  // 20 hours - covers today's close in most timezones
  PREVIOUS_SESSION_MAX: 5760, // 4 days - handles weekends/holidays
};

// Session states
const SESSION_STATE = {
  PRE_OPEN: 'PRE_OPEN',
  OPEN: 'OPEN',
  CLOSED: 'CLOSED',
  HOLIDAY: 'HOLIDAY',
  WEEKEND: 'WEEKEND',
  UNKNOWN: 'UNKNOWN',
};

// Data status values
const DATA_STATUS = {
  LIVE_INTRADAY: 'LIVE_INTRADAY',
  TODAY_CLOSE: 'TODAY_CLOSE',
  PREVIOUS_SESSION: 'PREVIOUS_SESSION',
  STALE: 'STALE',
  UNAVAILABLE: 'UNAVAILABLE',
  HISTORICAL: 'HISTORICAL',
  DEMO: 'DEMO',
};

/**
 * Global market instruments with provider chain configuration
 */
const GLOBAL_INSTRUMENTS = {
  // US Equity Indices
  sp500: {
    name: 'S&P 500',
    symbol: 'SPX',
    assetClass: 'equity-index',
    region: 'US',
    currency: 'USD',
    timezone: 'America/New_York',
    market: 'NYSE',
    providers: {
      twelve: ['SPX'],
      yahoo: '^GSPC',
      finnhub: [],
    },
    freshness: FRESHNESS,
    sessionHours: { open: '09:30', close: '16:00', days: [1,2,3,4,5] },
  },
  nasdaq: {
    name: 'Nasdaq Composite',
    symbol: 'IXIC',
    assetClass: 'equity-index',
    region: 'US',
    currency: 'USD',
    timezone: 'America/New_York',
    market: 'NASDAQ',
    providers: {
      twelve: ['IXIC'],
      yahoo: '^IXIC',
      finnhub: [],
    },
    freshness: FRESHNESS,
    sessionHours: { open: '09:30', close: '16:00', days: [1,2,3,4,5] },
  },
  dow: {
    name: 'Dow Jones Industrial Average',
    symbol: 'DJI',
    assetClass: 'equity-index',
    region: 'US',
    currency: 'USD',
    timezone: 'America/New_York',
    market: 'NYSE',
    providers: {
      twelve: ['DJI'],
      yahoo: '^DJI',
      finnhub: [],
    },
    freshness: FRESHNESS,
    sessionHours: { open: '09:30', close: '16:00', days: [1,2,3,4,5] },
  },

  // Asian Equity Indices
  nikkei: {
    name: 'Nikkei 225',
    symbol: 'N225',
    assetClass: 'equity-index',
    region: 'Japan',
    currency: 'JPY',
    timezone: 'Asia/Tokyo',
    market: 'TSE',
    providers: {
      twelve: ['N225', 'NI225'],
      yahoo: '^N225',
      finnhub: [],
    },
    freshness: FRESHNESS,
    sessionHours: { open: '09:00', close: '15:00', days: [1,2,3,4,5] },
  },
  hangSeng: {
    name: 'Hang Seng Index',
    symbol: 'HSI',
    assetClass: 'equity-index',
    region: 'Hong Kong',
    currency: 'HKD',
    timezone: 'Asia/Hong_Kong',
    market: 'HKEX',
    providers: {
      twelve: ['HSI'],
      yahoo: '^HSI',
      finnhub: [],
    },
    freshness: FRESHNESS,
    sessionHours: { open: '09:30', close: '16:00', days: [1,2,3,4,5] },
  },

  // Bonds/Yields
  us10y: {
    name: 'US 10-Year Treasury Yield',
    symbol: 'TNX',
    assetClass: 'bond-yield',
    region: 'US',
    currency: 'USD',
    timezone: 'America/New_York',
    market: 'UST',
    providers: {
      twelve: ['US10Y', 'TNX'],
      yahoo: '^TNX',
      finnhub: [],
    },
    freshness: FRESHNESS,
    sessionHours: { open: '08:00', close: '17:00', days: [1,2,3,4,5] },
    // Note: Yahoo returns TNX * 10, needs normalization
    normalizer: (val) => val / 10,
  },
  us2y: {
    name: 'US 2-Year Treasury Yield',
    symbol: 'IRX',
    assetClass: 'bond-yield',
    region: 'US',
    currency: 'USD',
    timezone: 'America/New_York',
    market: 'UST',
    providers: {
      twelve: ['US02Y', 'US2Y', 'IRX'],
      yahoo: '^IRX',
      finnhub: [],
    },
    freshness: FRESHNESS,
    sessionHours: { open: '08:00', close: '17:00', days: [1,2,3,4,5] },
    normalizer: (val) => val / 10,
  },

  // FX
  dxy: {
    name: 'US Dollar Index',
    symbol: 'DXY',
    assetClass: 'fx-index',
    region: 'US',
    currency: 'USD',
    timezone: 'America/New_York',
    market: 'ICE',
    providers: {
      twelve: ['DXY'],
      yahoo: 'DX-Y.NYB',
      finnhub: [],
    },
    freshness: FRESHNESS,
    sessionHours: { open: '00:00', close: '23:59', days: [0,1,2,3,4,5,6] }, // 24/5 FX
  },
  eurUsd: {
    name: 'EUR/USD',
    symbol: 'EUR/USD',
    assetClass: 'fx',
    region: 'Global',
    currency: 'USD',
    timezone: 'UTC',
    market: 'FX',
    providers: {
      twelve: ['EUR/USD'],
      yahoo: 'EURUSD=X',
      finnhub: ['OANDA:EUR_USD'],
    },
    freshness: FRESHNESS,
    sessionHours: { open: '00:00', close: '23:59', days: [0,1,2,3,4,5] },
  },
  usdJpy: {
    name: 'USD/JPY',
    symbol: 'USD/JPY',
    assetClass: 'fx',
    region: 'Global',
    currency: 'JPY',
    timezone: 'UTC',
    market: 'FX',
    providers: {
      twelve: ['USD/JPY'],
      yahoo: 'JPY=X',
      finnhub: ['OANDA:USD_JPY'],
    },
    freshness: FRESHNESS,
    sessionHours: { open: '00:00', close: '23:59', days: [0,1,2,3,4,5] },
  },

  // Commodities
  brent: {
    name: 'Brent Crude Oil',
    symbol: 'BZ',
    assetClass: 'commodity',
    region: 'Global',
    currency: 'USD',
    timezone: 'UTC',
    market: 'ICE',
    providers: {
      twelve: ['BRENT'],
      yahoo: 'BZ=F',
      finnhub: [],
    },
    freshness: FRESHNESS,
    sessionHours: { open: '00:00', close: '23:59', days: [0,1,2,3,4] },
    unit: '$/bbl',
  },
  gold: {
    name: 'Gold',
    symbol: 'GC',
    assetClass: 'commodity',
    region: 'Global',
    currency: 'USD',
    timezone: 'America/New_York',
    market: 'COMEX',
    providers: {
      twelve: ['XAU/USD'],
      yahoo: 'GC=F',
      finnhub: [],
    },
    freshness: FRESHNESS,
    sessionHours: { open: '00:00', close: '23:59', days: [0,1,2,3,4] },
    unit: '$/oz',
  },
  copper: {
    name: 'Copper',
    symbol: 'HG',
    assetClass: 'commodity',
    region: 'Global',
    currency: 'USD',
    timezone: 'America/New_York',
    market: 'COMEX',
    providers: {
      twelve: ['COPPER', 'XCU/USD'],
      yahoo: 'HG=F',
      finnhub: [],
    },
    freshness: FRESHNESS,
    sessionHours: { open: '00:00', close: '23:59', days: [0,1,2,3,4] },
    unit: '$/lb',
  },
};

/**
 * Indian market instruments
 */
const INDIAN_INSTRUMENTS = {
  nifty: {
    name: 'Nifty 50',
    symbol: 'NIFTY 50',
    assetClass: 'equity-index',
    region: 'India',
    currency: 'INR',
    timezone: 'Asia/Kolkata',
    market: 'NSE',
    providers: {
      nse: 'NIFTY 50',
      yahoo: '^NSEI',
      investing: null,
    },
    freshness: FRESHNESS,
    sessionHours: { open: '09:15', close: '15:30', days: [1,2,3,4,5] },
    preOpen: { start: '09:00', end: '09:15' },
  },
  sensex: {
    name: 'Sensex',
    symbol: 'SENSEX',
    assetClass: 'equity-index',
    region: 'India',
    currency: 'INR',
    timezone: 'Asia/Kolkata',
    market: 'BSE',
    providers: {
      nse: null, // Sensex is BSE, not NSE
      yahoo: '^BSESN',
    },
    freshness: FRESHNESS,
    sessionHours: { open: '09:15', close: '15:30', days: [1,2,3,4,5] },
    preOpen: { start: '09:00', end: '09:15' },
  },
  midcap100: {
    name: 'Nifty Midcap 100',
    symbol: 'NIFTY MIDCAP 100',
    assetClass: 'equity-index',
    region: 'India',
    currency: 'INR',
    timezone: 'Asia/Kolkata',
    market: 'NSE',
    providers: {
      nse: 'NIFTY MIDCAP 100',
      investing: 'https://www.investing.com/indices/cnx-midcap-historical-data',
    },
    freshness: FRESHNESS,
    sessionHours: { open: '09:15', close: '15:30', days: [1,2,3,4,5] },
  },
  smallcap100: {
    name: 'Nifty Smallcap 100',
    symbol: 'NIFTY SMALLCAP 100',
    assetClass: 'equity-index',
    region: 'India',
    currency: 'INR',
    timezone: 'Asia/Kolkata',
    market: 'NSE',
    providers: {
      nse: 'NIFTY SMALLCAP 100',
      investing: 'https://www.investing.com/indices/cnx-smallcap-historical-data',
    },
    freshness: FRESHNESS,
    sessionHours: { open: '09:15', close: '15:30', days: [1,2,3,4,5] },
  },
  usdInr: {
    name: 'USD/INR',
    symbol: 'USD/INR',
    assetClass: 'fx',
    region: 'India',
    currency: 'INR',
    timezone: 'Asia/Kolkata',
    market: 'Interbank',
    providers: {
      yahoo: 'USDINR=X',
    },
    freshness: FRESHNESS,
    sessionHours: { open: '09:00', close: '17:30', days: [1,2,3,4,5] },
  },
  india10y: {
    name: 'India 10-Year G-Sec',
    symbol: 'IN10Y',
    assetClass: 'bond-yield',
    region: 'India',
    currency: 'INR',
    timezone: 'Asia/Kolkata',
    market: 'RBI',
    providers: {
      investing: 'https://www.investing.com/rates-bonds/india-10-year-bond-yield',
    },
    freshness: FRESHNESS,
    sessionHours: { open: '09:00', close: '15:30', days: [1,2,3,4,5] },
    unit: '%',
  },
};

/**
 * Normalized quote interface
 * Returns a standardized quote object regardless of provider
 */
function normalizeQuote(raw, instrument) {
  if (!raw || typeof raw.last !== 'number') return null;
  
  const ageMinutes = typeof raw.freshnessMinutes === 'number' 
    ? raw.freshnessMinutes 
    : raw.asOf ? Math.max(0, (Date.now() - new Date(raw.asOf).getTime()) / 60000) : null;

  return {
    name: instrument.name,
    symbol: raw.symbol || instrument.symbol,
    level: raw.last,
    change: raw.changePct != null ? raw.changePct : null,
    changePct: raw.changePct != null ? raw.changePct : null,
    previous: raw.previous != null ? raw.previous : null,
    currency: raw.currency || instrument.currency,
    source: raw.provider || 'Unknown',
    timestamp: raw.asOf || null,
    timezone: raw.exchangeTimezoneName || instrument.timezone,
    sessionStatus: raw.marketState || null,
    dataStatus: null, // Will be set by session engine
    ageMinutes: ageMinutes,
    isLive: false, // Will be set by session engine
    verifiedLive: raw.verifiedLive || false,
    assetClass: instrument.assetClass,
    region: instrument.region,
  };
}

/**
 * Classify data status based on quote status, age, and session
 */
function classifyDataStatus(quoteStatus, ageMinutes, sessionState) {
  if (ageMinutes == null || Number.isNaN(ageMinutes)) return DATA_STATUS.UNAVAILABLE;
  if (quoteStatus === 'INTRADAY' && ageMinutes <= FRESHNESS.INTRADAY_MAX && sessionState === SESSION_STATE.OPEN) {
    return DATA_STATUS.LIVE_INTRADAY;
  }
  if (ageMinutes <= FRESHNESS.TODAY_CLOSE_MAX) return DATA_STATUS.TODAY_CLOSE;
  if (ageMinutes <= FRESHNESS.PREVIOUS_SESSION_MAX) return DATA_STATUS.PREVIOUS_SESSION;
  return DATA_STATUS.STALE;
}

module.exports = {
  GLOBAL_INSTRUMENTS,
  INDIAN_INSTRUMENTS,
  FRESHNESS,
  SESSION_STATE,
  DATA_STATUS,
  normalizeQuote,
  classifyDataStatus,
};
