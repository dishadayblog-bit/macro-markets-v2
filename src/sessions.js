/**
 * Market Session Engine
 * 
 * Determines session state for any market based on:
 * - Current time in the market's timezone
 * - Trading hours (open/close)
 * - Day of week
 * - Known holidays (basic coverage)
 * 
 * Session states: PRE_OPEN, OPEN, CLOSED, HOLIDAY, WEEKEND, UNKNOWN
 */

const { SESSION_STATE } = require('./instrument-registry');

// Known market holidays for 2025-2026 (major ones only - extend as needed)
const MARKET_HOLIDAYS = {
  'India': [
    '2025-01-26', '2025-03-14', '2025-03-31', '2025-04-10', '2025-04-14',
    '2025-04-18', '2025-05-01', '2025-05-12', '2025-08-15', '2025-08-27',
    '2025-10-02', '2025-10-20', '2025-10-21', '2025-10-22', '2025-11-05',
    '2025-11-26', '2025-12-25',
    '2026-01-26', '2026-03-04', '2026-03-20', '2026-04-02', '2026-04-03',
    '2026-04-14', '2026-05-01', '2026-08-15', '2026-10-02', '2026-10-20',
    '2026-11-11', '2026-12-25',
  ],
  'US': [
    '2025-01-01', '2025-01-20', '2025-02-17', '2025-04-18', '2025-05-26',
    '2025-06-19', '2025-07-04', '2025-09-01', '2025-11-27', '2025-12-25',
    '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25',
    '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  ],
  'Japan': [
    '2025-01-01', '2025-01-02', '2025-01-03', '2025-01-13', '2025-02-11',
    '2025-02-24', '2025-03-20', '2025-04-29', '2025-05-03', '2025-05-04',
    '2025-05-05', '2025-05-06', '2025-07-21', '2025-08-11', '2025-09-15',
    '2025-09-23', '2025-10-13', '2025-11-03', '2025-11-23', '2025-12-31',
    '2026-01-01', '2026-01-02', '2026-01-03', '2026-01-12', '2026-02-11',
    '2026-02-23', '2026-03-20', '2026-04-29', '2026-05-03', '2026-05-04',
    '2026-05-05', '2026-07-20', '2026-08-11', '2026-09-21', '2026-09-23',
    '2026-10-12', '2026-11-03', '2026-11-23', '2026-12-31',
  ],
  'Hong Kong': [
    '2025-01-01', '2025-01-29', '2025-01-30', '2025-01-31', '2025-04-04',
    '2025-04-07', '2025-04-18', '2025-04-19', '2025-04-21', '2025-05-01',
    '2025-05-05', '2025-05-24', '2025-06-10', '2025-07-01', '2025-10-01',
    '2025-10-07', '2025-10-29', '2025-12-25', '2025-12-26',
  ],
  'UK': [
    '2025-01-01', '2025-04-18', '2025-04-21', '2025-05-05', '2025-05-26',
    '2025-08-25', '2025-12-25', '2025-12-26',
    '2026-01-01', '2026-04-03', '2026-04-06', '2026-05-04', '2026-05-25',
    '2026-08-31', '2026-12-25', '2026-12-28',
  ],
};

/**
 * Get current time in a specific timezone
 */
function getTimeInTimezone(timezone, date = new Date()) {
  const str = date.toLocaleString('en-US', { timeZone: timezone });
  return new Date(str);
}

/**
 * Get the date string (YYYY-MM-DD) in a specific timezone
 */
function getDateInTimezone(timezone, date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * Get the day of week (0=Sun, 6=Sat) in a specific timezone
 */
function getDayOfWeek(timezone, date = new Date()) {
  const local = getTimeInTimezone(timezone, date);
  return local.getDay();
}

/**
 * Get hours:minutes as a comparable number (e.g. 9:15 -> 915)
 */
function getTimeMinutes(timezone, date = new Date()) {
  const local = getTimeInTimezone(timezone, date);
  return local.getHours() * 60 + local.getMinutes();
}

/**
 * Parse "HH:MM" to minutes since midnight
 */
function parseTime(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Check if a date is a holiday for a given region
 */
function isHoliday(region, timezone, date = new Date()) {
  const dateStr = getDateInTimezone(timezone, date);
  const holidays = MARKET_HOLIDAYS[region] || [];
  return holidays.includes(dateStr);
}

/**
 * Check if a day is a weekend
 */
function isWeekend(dayOfWeek) {
  return dayOfWeek === 0 || dayOfWeek === 6;
}

/**
 * Determine the session state for an instrument
 */
function getSessionState(instrument, date = new Date()) {
  if (!instrument || !instrument.sessionHours) return SESSION_STATE.UNKNOWN;

  const { timezone, region, sessionHours, preOpen } = instrument;
  const dayOfWeek = getDayOfWeek(timezone, date);
  const currentMinutes = getTimeMinutes(timezone, date);

  // Check weekend
  if (!sessionHours.days || !sessionHours.days.includes(dayOfWeek)) {
    return SESSION_STATE.WEEKEND;
  }

  // Check holiday
  if (region && isHoliday(region, timezone, date)) {
    return SESSION_STATE.HOLIDAY;
  }

  const openMin = parseTime(sessionHours.open);
  const closeMin = parseTime(sessionHours.close);

  // Check pre-open
  if (preOpen) {
    const preOpenStart = parseTime(preOpen.start);
    const preOpenEnd = parseTime(preOpen.end);
    if (currentMinutes >= preOpenStart && currentMinutes < preOpenEnd) {
      return SESSION_STATE.PRE_OPEN;
    }
  }

  // Check open
  if (currentMinutes >= openMin && currentMinutes < closeMin) {
    return SESSION_STATE.OPEN;
  }

  // Otherwise closed
  return SESSION_STATE.CLOSED;
}

/**
 * Map provider-reported market state to our session state
 * This reconciles what the provider says with what our clock says
 */
function reconcileSessionState(providerState, instrumentSessionState) {
  // Provider states from Yahoo/Finnhub: REGULAR, PRE, POST, CLOSED
  const mapped = String(providerState || '').toUpperCase();
  
  if (mapped === 'REGULAR') return SESSION_STATE.OPEN;
  if (mapped === 'PRE') return SESSION_STATE.PRE_OPEN;
  if (mapped === 'POST') return SESSION_STATE.CLOSED;
  
  // If provider says CLOSED but our clock says OPEN, trust our clock
  // (provider might be reporting after-hours for a different timezone)
  if (mapped === 'CLOSED' || mapped === '') {
    return instrumentSessionState;
  }
  
  return instrumentSessionState;
}

/**
 * Determine if a quote should be classified as LIVE_INTRADAY
 */
function isLiveIntraday(quote, instrument, sessionState) {
  if (!quote || typeof quote.last !== 'number') return false;
  if (sessionState !== SESSION_STATE.OPEN && sessionState !== SESSION_STATE.PRE_OPEN) return false;
  
  const ageMinutes = typeof quote.freshnessMinutes === 'number' 
    ? quote.freshnessMinutes 
    : quote.asOf ? Math.max(0, (Date.now() - new Date(quote.asOf).getTime()) / 60000) : null;
  
  if (ageMinutes == null || ageMinutes > 20) return false;
  
  const quoteStatus = String(quote.quoteStatus || '').toUpperCase();
  return quoteStatus === 'INTRADAY' || quoteStatus === 'REGULAR';
}

/**
 * Classify the data status of a quote considering all factors
 */
function classifyQuoteDataStatus(quote, instrument, date = new Date()) {
  if (!quote || typeof quote.last !== 'number') {
    return { dataStatus: 'UNAVAILABLE', isLive: false, sessionState: SESSION_STATE.UNKNOWN };
  }

  const instrumentSessionState = getSessionState(instrument, date);
  const providerState = quote.marketState || null;
  const effectiveSessionState = reconcileSessionState(providerState, instrumentSessionState);

  const ageMinutes = typeof quote.freshnessMinutes === 'number'
    ? quote.freshnessMinutes
    : quote.asOf ? Math.max(0, (Date.now() - new Date(quote.asOf).getTime()) / 60000) : null;

  const live = isLiveIntraday(quote, instrument, effectiveSessionState);
  
  let dataStatus;
  if (live) {
    dataStatus = 'LIVE_INTRADAY';
  } else if (ageMinutes != null && ageMinutes <= 1200) {
    dataStatus = 'TODAY_CLOSE';
  } else if (ageMinutes != null && ageMinutes <= 5760) {
    dataStatus = 'PREVIOUS_SESSION';
  } else if (ageMinutes != null) {
    dataStatus = 'STALE';
  } else {
    dataStatus = 'UNAVAILABLE';
  }

  return {
    dataStatus,
    isLive: live,
    sessionState: effectiveSessionState,
    ageMinutes,
  };
}

/**
 * Get a human-readable session label
 */
function sessionLabel(state) {
  switch (state) {
    case SESSION_STATE.PRE_OPEN: return 'Pre-Open';
    case SESSION_STATE.OPEN: return 'Open';
    case SESSION_STATE.CLOSED: return 'Closed';
    case SESSION_STATE.HOLIDAY: return 'Holiday';
    case SESSION_STATE.WEEKEND: return 'Weekend';
    default: return 'Unknown';
  }
}

/**
 * Get a human-readable data status label
 */
function dataStatusLabel(status) {
  switch (status) {
    case 'LIVE_INTRADAY': return 'Live';
    case 'TODAY_CLOSE': return "Today's Close";
    case 'PREVIOUS_SESSION': return 'Previous Session';
    case 'STALE': return 'Stale';
    case 'UNAVAILABLE': return 'Unavailable';
    case 'HISTORICAL': return 'Historical';
    case 'DEMO': return 'Demo/Reference';
    default: return status || 'Unknown';
  }
}

module.exports = {
  getSessionState,
  reconcileSessionState,
  isLiveIntraday,
  classifyQuoteDataStatus,
  isHoliday,
  isWeekend,
  getTimeInTimezone,
  getDateInTimezone,
  getDayOfWeek,
  sessionLabel,
  dataStatusLabel,
  MARKET_HOLIDAYS,
};
