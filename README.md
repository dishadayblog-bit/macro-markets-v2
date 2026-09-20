# Macro & Markets Intelligence

A reliable, source-traceable, session-aware macro and market intelligence dashboard where no stale, historical, demo, or fallback value is presented as live/current data.

## Overview

This project provides a comprehensive financial intelligence dashboard covering:
- **Indian Markets**: Nifty 50, Sensex, Midcap/Smallcap, G-Sec yields, USD/INR, FII/DII flows
- **Global Markets**: S&P 500, Nasdaq, Dow, Nikkei, Hang Seng, US Treasuries, FX, Commodities
- **Macro Data**: FRED economic indicators, World Bank GDP data
- **Policy Watch**: RBI and SEBI official releases
- **AI Intelligence**: OpenAI-powered analysis with deterministic fallback

## Quick Start

```bash
# Install dependencies
npm install

# Set up environment variables
cp .env.example .env
# Edit .env with your API keys

# Run locally
npm start
# Dashboard available at http://localhost:8787

# Run tests
npm test
```

## Architecture

```
Frontend (public/index.html)
    ↓ fetch
Vercel API Routes (api/*.js)
    ↓
Service Layer (api/_service.js)
    ↓
Source Engines (src/sources.js)
    ├── Indian Market Engine (NSE, Yahoo, Investing.com)
    ├── Global Market Engine (Twelve Data → Finnhub → Alpha Vantage → Yahoo)
    ├── Macro Engine (FRED, World Bank)
    ├── Policy Engine (RBI RSS, SEBI scraping)
    └── News Engine (RSS feeds)
    ↓
Session Engine (src/sessions.js) + Instrument Registry (src/instrument-registry.js)
    ↓
Validated Snapshot → Persistence (Vercel KV / in-memory)
    ↓
Frontend renders with full metadata (dataStatus, sessionStatus, source, timestamp)
```

## Key Features

### Data Integrity
- **No fake live numbers**: Every displayed value carries provenance metadata
- **Explicit data status**: LIVE_INTRADAY, TODAY_CLOSE, PREVIOUS_SESSION, STALE, UNAVAILABLE
- **Session-aware**: Markets know when they're OPEN, CLOSED, WEEKEND, HOLIDAY, or PRE_OPEN
- **Quote validation**: Rejects malformed, zero, NaN, or suspicious values before display

### Provider Router
- **Multi-provider chain**: Twelve Data → Finnhub → Alpha Vantage → Yahoo Finance fallback
- **Per-source timeouts**: 75s for markets, 30s for other sources (no aggressive global timeout)
- **AbortController**: Timeouts actually cancel network requests
- **Controlled concurrency**: Configurable parallel requests to avoid rate limits

### Non-Destructive Refresh
- **Instrument-by-instrument**: Successful instruments update even when others fail
- **Section isolation**: Global market updates never overwrite Indian market data
- **Merge, don't replace**: New data merges with existing; stale data is never marked LIVE

### Persistence
- **Vercel KV**: Durable snapshot storage across serverless invocations (when configured)
- **In-memory fallback**: Works without KV but honestly reports non-durability
- **Change detection**: Accumulates change history across refreshes

## Project Structure

```
├── api/                    # Vercel serverless API routes
│   ├── health.js          # Health check endpoint
│   ├── macro-data.js      # Main data endpoint (GET /api/macro-data)
│   ├── refresh.js         # Refresh endpoint (POST/GET /api/refresh)
│   ├── source-status.js   # Source health endpoint
│   ├── _service.js        # Service layer (orchestration)
│   └── _store.js          # Persistence (KV / memory)
├── src/
│   ├── sources.js         # All data fetching engines
│   ├── sessions.js        # Market session state engine
│   ├── instrument-registry.js  # Instrument definitions & metadata
│   ├── intelligence.js    # AI analysis layer (OpenAI + fallback)
│   ├── server.js          # Local dev server
│   └── refresh.js         # Local refresh runner
├── data/
│   ├── macro-data.json    # Seed data (historical baseline)
│   └── refresh-history.json
├── public/
│   └── index.html         # Dashboard frontend (single-file)
├── tests/
│   └── run-tests.js       # Test suite (33 tests)
├── package.json
├── vercel.json
└── .env.example
```

## Environment Variables

See `.env.example` for all supported variables. Key ones:

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | Optional | AI intelligence layer |
| `TWELVE_DATA_API_KEY` | Recommended | Primary global market provider |
| `FRED_API_KEY` | Recommended | US macro data |
| `KV_REST_API_URL` + `KV_REST_API_TOKEN` | Recommended | Durable persistence |
| `CRON_SECRET` | Production | Protect refresh endpoint |

## Deployment

See [DEPLOYMENT.md](./docs/DEPLOYMENT.md) for full Vercel deployment guide.

```bash
# Deploy to Vercel
vercel --prod
```

## Documentation

- [ARCHITECTURE.md](./docs/ARCHITECTURE.md) — System design and data flow
- [DATA-SOURCES.md](./docs/DATA-SOURCES.md) — Provider hierarchy and coverage
- [MARKET-DATA-SPEC.md](./docs/MARKET-DATA-SPEC.md) — Quote schema and session model
- [DEPLOYMENT.md](./docs/DEPLOYMENT.md) — Vercel setup and cron configuration
- [TESTING.md](./docs/TESTING.md) — Test results and failure simulations
- [ENVIRONMENT.md](./docs/ENVIRONMENT.md) — Variable reference and secret handling

## License

Private project. All market data subject to provider terms of service.
