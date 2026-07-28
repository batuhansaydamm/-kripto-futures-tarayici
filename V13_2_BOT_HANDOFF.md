# V13.2 Tarayıcı → Binance Bot Handoff

## Scope

This branch adds a separate backend execution layer to the existing single-file V13.2 scanner. The scanner's LONG / SHORT / NO TRADE analysis logic is not moved or changed in this phase.

## Fixed first-phase decisions

- Exchange: Binance USDⓈ-M Futures Testnet
- Total trade attempts: 5
- Margin per trade: 50 USDT
- Leverage: x10
- Margin mode: ISOLATED
- Position mode: ONE-WAY
- Maximum simultaneous positions: 1
- Runtime: cloud/VPS, managed from a phone through an authenticated backend API
- Entry: MARKET after a validated radar signal
- API secrets: backend environment variables only
- Live trading: disabled; this branch refuses `BINANCE_ENV=live` and `LIVE_TRADING=true`

## Implemented safety gates

- Symbol must be TRADING, PERPETUAL and USDT quoted.
- Quantity and stop price are normalized using exchangeInfo stepSize/tickSize.
- minNotional and quantity bounds are checked.
- One-way mode is verified.
- ISOLATED and x10 are configured before entry.
- Duplicate `signalId` values are rejected.
- Local persistent counters survive restarts.
- Binance open positions are reconciled on startup.
- A real exchange STOP_MARKET close-position order is sent immediately after entry.
- The stop order is queried back and must be NEW/PARTIALLY_FILLED.
- If stop verification fails, a reduce-only market emergency close is sent and the kill switch is enabled.
- Maximum total trades and maximum open positions are separate gates.
- Daily loss, consecutive loss and API-error circuit-breaker fields are present.
- API keys are excluded by `.gitignore` and represented only in `.env.example`.

## API

All `/api/*` routes require:

```http
Authorization: Bearer <BOT_CONTROL_TOKEN>
```

### Status

```http
GET /api/status
```

### Kill switch

```http
POST /api/kill-switch
Content-Type: application/json

{"enabled": true}
```

### Submit validated signal

```http
POST /api/signals
Content-Type: application/json

{
  "signalId": "radar-BTCUSDT-20260728T110000Z",
  "symbol": "BTCUSDT",
  "side": "LONG",
  "stopPrice": 115000
}
```

The frontend must never receive or send Binance credentials. It sends only the validated signal payload to this backend.

## Deployment

```bash
cd bot
cp .env.example .env
# Fill Testnet keys and BOT_CONTROL_TOKEN.
npm install
npm run check
npm start
```

A Dockerfile is included. Mount `/app/data` as persistent storage in the cloud so the five-trade counter and kill-switch state survive redeployments.

## Before any real-money phase

1. Validate Testnet entry, stop, emergency-close and restart reconciliation.
2. Add TP1/TP2/runner lifecycle and realized-PnL accounting from Binance execution events.
3. Add a signed server-to-server radar webhook or move the radar scheduler into the backend.
4. Add database-backed idempotency instead of a JSON file for multi-instance deployments.
5. Run a complete dry-run radar cycle.
6. Confirm IP whitelist, no withdrawal permission, rate-limit backoff and time drift behavior.
7. Create a separate live deployment configuration that still defaults to disabled.
