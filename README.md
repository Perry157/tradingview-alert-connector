# Tradingview-Alert-Connector

Tradingview-Alert-Connector is a free and noncustodial tool for you to Integrate tradingView alert and execute automated trading for perpetual futures DEXes.

Currently supports [dYdX v4](https://dydx.trade/?ref=LawfulBalletF7U), [Perpetual Protocol v2](https://perp.com/), [GMX v2](https://app.gmx.io/#/trade/), [Bluefin](https://trade.bluefin.io), and [Hyperliquid](https://app.hyperliquid.xyz/join/0XIBUKI).

# Supported Exchanges

| Exchange           | Network        | Type              |
| ------------------ | -------------- | ----------------- |
| dYdX v4            | dYdX Chain     | Perpetual Futures |
| Perpetual Protocol | Optimism L2    | Perpetual Futures |
| GMX v2             | Arbitrum       | Perpetual Futures |
| Bluefin            | Sui            | Perpetual Futures |
| Hyperliquid        | Hyperliquid L1 | Perpetual Futures |

# Docs

https://tv-connector.gitbook.io/docs/

# Video Tutorial

Perpetual Protocol:
https://youtu.be/YqrOZW_mnUM

# Prerequisites

- TradingView Account at least Pro plan

https://www.tradingview.com/gopro/

- DEX(e.g. dYdX v4) account with collateral already in place

# Installation

```bash
git clone https://github.com/junta/tradingview-alert-connector.git
cd tradingview-alert-connector
npm install --force
```

# Quick Start

- rename .env.sample to .env
- fill environment variables in .env (see [full tutorial](https://tv-connector.gitbook.io/docs/setuup/running-on-local-pc#steps))

### Environment Variables

See `.env.sample` for all available environment variables for each exchange.

### with Docker

```bash
docker-compose build
docker-compose up -d
```

### without Docker

```bash
yarn start
```

# TradingView Alert Format

Set your TradingView alert webhook URL to your server's address (e.g., `http://your-server:3000/`) and use JSON format for the alert message:

### Order Sizing Options

Instead of a fixed `size`, you can use:

- `"sizeUsd": 1000` - Size in USD value (converted to base asset at current price)
- `"sizeByLeverage": 2` - Percentage of account equity as leverage

# TWAP Orders (dYdX v4)

Orders sent to dYdX v4 are placed as native TWAP orders instead of market orders, so a signal's full size is broken into slices and spread out over a few minutes instead of hitting the book all at once. Each slice is priced off dYdX's live oracle price at the moment it triggers, within a configurable tolerance, rather than at one fixed price for the whole order.

This is configured in `config/*.yaml` under `DydxV4.Twap`:

```yaml
DydxV4:
  Twap:
    durationSeconds: 300 # total time to spread the order over (5 min)
    intervalSeconds: 30 # time between slices (10 slices)
    priceTolerancePpm: 50000 # max price drift per slice, in ppm (50000 = 5%)
```

`durationSeconds` must be between 300 and 86400 (dYdX's protocol limits), `intervalSeconds` must be between 30 and 3600, and `intervalSeconds` must evenly divide `durationSeconds`. These settings apply to every strategy; there's currently no per-alert override.

The connector responds to the TradingView webhook as soon as the TWAP order is accepted on-chain — it doesn't block the request for the full `durationSeconds` while slices fill. It then watches the order in the background and logs whether it finished `FILLED` or was cancelled/expired, so check your Render logs (or `getOrders()`) if you want to confirm how a given signal actually filled.

**Security note:** `@dydxprotocol/v4-client-js` is pinned to an exact version (`3.6.0`) rather than a range. In early 2026, several published versions of this exact package (`1.0.31`, `1.15.2`, `1.22.1`, `3.4.1`) were compromised via a maintainer credential leak and shipped malware that stole seed phrases — this is the package that reads your `DYDX_V4_MNEMONIC`. Don't loosen this to a caret/range without checking dYdX's advisories first, and consider using a mnemonic dedicated to this bot rather than one holding significant funds.

# Testing

```bash
npm test
```

## Disclaimer

This project is hosted under an MIT OpenSource License. This tool does not guarantee users’ future profit and users have to use this tool on their own responsibility.
