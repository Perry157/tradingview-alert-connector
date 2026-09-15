import {
	BECH32_PREFIX,
	IndexerClient,
	CompositeClient,
	Network,
	SubaccountClient,
	ValidatorConfig,
	LocalWallet,
	OrderSide,
	OrderType,
	IndexerConfig,
	ITwapParameters
} from '@dydxprotocol/v4-client-js';
import { dydxV4OrderParams, AlertObject, OrderResult } from '../../types';
import { _sleep, doubleSizeIfReverseOrder } from '../../helper';
import 'dotenv/config';
import config from 'config';
import { AbstractDexClient } from '../abstractDexClient';

// Buffer (seconds) added on top of the configured TWAP duration when setting
// the parent order's good-til-time, so it doesn't expire on-chain before its
// final slice has a chance to trigger.
const TWAP_GOOD_TIL_BUFFER_SECONDS = 60;

// How often the background monitor polls the indexer for this order's
// status while a TWAP order is executing.
const TWAP_MONITOR_POLL_INTERVAL_MS = 15000;

export class DydxV4Client extends AbstractDexClient {
	async getIsAccountReady() {
		const subAccount = await this.getSubAccount();
		if (!subAccount) return false;

		console.log('dydx v4 account: ' + JSON.stringify(subAccount, null, 2));
		return (Number(subAccount.freeCollateral) > 0) as boolean;
	}

	async getSubAccount() {
		try {
			const client = this.buildIndexerClient();
			const localWallet = await this.generateLocalWallet();
			if (!localWallet) return;
			const response = await client.account.getSubaccount(
				localWallet.address,
				0
			);

			return response.subaccount;
		} catch (error) {
			console.error(error);
		}
	}

	async buildOrderParams(alertMessage: AlertObject) {
		const orderSide =
			alertMessage.order == 'buy' ? OrderSide.BUY : OrderSide.SELL;

		const latestPrice = alertMessage.price;
		console.log('latestPrice', latestPrice);

		let orderSize: number;
		if (alertMessage.sizeByLeverage) {
			const account = await this.getSubAccount();

			orderSize =
				(Number(account.equity) * Number(alertMessage.sizeByLeverage)) /
				latestPrice;
		} else if (alertMessage.sizeUsd) {
			orderSize = Number(alertMessage.sizeUsd) / latestPrice;
		} else {
			orderSize = alertMessage.size;
		}

		orderSize = doubleSizeIfReverseOrder(alertMessage, orderSize);

		const market = alertMessage.market.replace(/_/g, '-');

		const orderParams: dydxV4OrderParams = {
			market,
			side: orderSide,
			size: Number(orderSize),
			price: Number(alertMessage.price)
		};
		console.log('orderParams for dydx', orderParams);
		return orderParams;
	}

	async placeOrder(alertMessage: AlertObject) {
		const orderParams = await this.buildOrderParams(alertMessage);
		const { client, subaccount } = await this.buildCompositeClient();

		const market = orderParams.market;
		const type = OrderType.TWAP;
		const side = orderParams.side;
		const size = orderParams.size;
		const reduceOnly = false;
		// Price is intentionally 0: for a TWAP order this tells dYdX to price
		// every slice off the live oracle price (+/- twapParameters.priceTolerance)
		// at the moment it triggers, instead of one fixed price for the whole
		// order. That's what actually spreads execution out and cuts slippage
		// vs. a single market order.
		const price = 0;

		const twap = this.getTwapConfig();
		const twapParameters: ITwapParameters = {
			duration: twap.durationSeconds,
			interval: twap.intervalSeconds,
			priceTolerance: twap.priceTolerancePpm
		};
		// The parent order has to stay alive on-chain for at least the full
		// TWAP duration, or it (and any remaining slices) get cancelled early.
		const goodTilTimeInSeconds = twap.durationSeconds + TWAP_GOOD_TIL_BUFFER_SECONDS;

		// Generate clientId once so retries below resubmit the same order
		// instead of placing duplicates.
		const clientId = this.generateRandomInt32();
		console.log(
			`Placing dYdX v4 TWAP order: market=${market} side=${side} size=${size} ` +
				`duration=${twap.durationSeconds}s interval=${twap.intervalSeconds}s ` +
				`priceTolerance=${(twap.priceTolerancePpm / 10000).toFixed(2)}% clientId=${clientId}`
		);

		let count = 0;
		const maxTries = 3;
		let broadcast = false;

		while (count <= maxTries && !broadcast) {
			try {
				const tx = await client.placeOrder(
					subaccount,
					market,
					type,
					side,
					price,
					size,
					clientId,
					undefined, // timeInForce: not used for TWAP orders
					goodTilTimeInSeconds,
					undefined, // execution: not used for TWAP orders
					undefined, // postOnly: not used for TWAP orders
					reduceOnly,
					undefined, // triggerPrice: not used for TWAP orders
					undefined, // marketInfo: resolved automatically from the indexer
					undefined, // currentHeight: resolved automatically from the validator
					undefined, // goodTilBlock: using goodTilTimeInSeconds instead
					undefined, // memo
					undefined, // broadcastMode
					twapParameters
				);
				console.log('dYdX v4 TWAP order broadcast. Transaction Result: ', tx);
				broadcast = true;
			} catch (error) {
				console.error(error);
				count++;
				if (count > maxTries) {
					throw new Error(
						`Failed to broadcast dYdX v4 TWAP order after ${maxTries} attempts: ${error}`
					);
				}
				console.log('Retrying TWAP order broadcast, attempt ' + count);
				await _sleep(5000);
			}
		}

		const orderResult: OrderResult = {
			side: orderParams.side,
			size: orderParams.size,
			orderId: String(clientId)
		};

		// Record the order as soon as it's accepted on-chain, for the full
		// intended size, rather than blocking this webhook response for up to
		// twap.durationSeconds while the slices fill. This keeps the response
		// fast (important since a TWAP can run for minutes) and matches how
		// position tracking already worked here (recorded once the order was
		// accepted). The background monitor below only logs the outcome to
		// the console - it never touches data/strategies - so a partially
		// filled TWAP can't cause position tracking to double- or under-count.
		await this.exportOrder(
			'DydxV4',
			alertMessage.strategy,
			orderResult,
			alertMessage.price,
			alertMessage.market
		);

		// Watch the order in the background without blocking the response.
		this.monitorTwapOrder(clientId, twap.durationSeconds).catch((error) => {
			console.error(`Error monitoring dYdX v4 TWAP order ${clientId}:`, error);
		});

		return orderResult;
	}

	// Reads DydxV4.Twap.* from config, with defaults matching a 5 minute /
	// 30 second-interval / 5% tolerance TWAP if the config file hasn't been
	// updated. Validates against dYdX's on-chain constraints so a bad config
	// value fails fast here instead of being rejected by the chain.
	private getTwapConfig = (): {
		durationSeconds: number;
		intervalSeconds: number;
		priceTolerancePpm: number;
	} => {
		const durationSeconds = config.has('DydxV4.Twap.durationSeconds')
			? Number(config.get('DydxV4.Twap.durationSeconds'))
			: 300;
		const intervalSeconds = config.has('DydxV4.Twap.intervalSeconds')
			? Number(config.get('DydxV4.Twap.intervalSeconds'))
			: 30;
		const priceTolerancePpm = config.has('DydxV4.Twap.priceTolerancePpm')
			? Number(config.get('DydxV4.Twap.priceTolerancePpm'))
			: 50000; // 5%

		// dYdX requires duration in [300, 86400] seconds, interval in
		// [30, 3600] seconds, and interval must evenly divide duration.
		if (durationSeconds < 300 || durationSeconds > 86400) {
			throw new Error('DydxV4.Twap.durationSeconds must be between 300 and 86400');
		}
		if (intervalSeconds < 30 || intervalSeconds > 3600) {
			throw new Error('DydxV4.Twap.intervalSeconds must be between 30 and 3600');
		}
		if (durationSeconds % intervalSeconds !== 0) {
			throw new Error(
				'DydxV4.Twap.intervalSeconds must evenly divide DydxV4.Twap.durationSeconds'
			);
		}

		return { durationSeconds, intervalSeconds, priceTolerancePpm };
	};

	// Polls the indexer for this TWAP order's status until it's filled,
	// cancelled, or its window closes, purely so the outcome shows up in
	// your Render logs. Deliberately does not touch data/strategies - see
	// the comment in placeOrder() above.
	private monitorTwapOrder = async (clientId: number, durationSeconds: number) => {
		const deadline =
			Date.now() + (durationSeconds + TWAP_GOOD_TIL_BUFFER_SECONDS) * 1000;
		let lastStatus: string | undefined;

		while (Date.now() < deadline) {
			await _sleep(TWAP_MONITOR_POLL_INTERVAL_MS);

			const orders = await this.getOrders();
			const order = orders?.find((order) => order.clientId == String(clientId));
			if (!order) continue;

			lastStatus = order.status;
			if (
				order.status === 'FILLED' ||
				order.status === 'CANCELED' ||
				order.status === 'BEST_EFFORT_CANCELED'
			) {
				break;
			}
		}

		if (lastStatus === 'FILLED') {
			console.log(`dYdX v4 TWAP order ${clientId} finished: FILLED`);
		} else {
			console.error(
				`dYdX v4 TWAP order ${clientId} finished monitoring with status "${
					lastStatus ?? 'not found'
				}" instead of FILLED. Check your dYdX account to confirm how much actually filled.`
			);
		}
	};

	private buildCompositeClient = async () => {
		const validatorConfig = new ValidatorConfig(
			config.get('DydxV4.ValidatorConfig.restEndpoint'),
			'dydx-mainnet-1',
			{
				CHAINTOKEN_DENOM: 'adydx',
				CHAINTOKEN_DECIMALS: 18,
				USDC_DENOM:
					'ibc/8E27BA2D5493AF5636760E354E46004562C46AB7EC0CC4C1CA14E9E20E2545B5',
				USDC_GAS_DENOM: 'uusdc',
				USDC_DECIMALS: 6
			}
		);
		const network =
			process.env.NODE_ENV == 'production'
				? new Network('mainnet', this.getIndexerConfig(), validatorConfig)
				: Network.testnet();
		let client;
		try {
			client = await CompositeClient.connect(network);
		} catch (e) {
			console.error(e);
			throw new Error('Failed to connect to dYdX v4 client');
		}

		const localWallet = await this.generateLocalWallet();
		const subaccount = new SubaccountClient(localWallet, 0);
		return { client, subaccount };
	};

	private generateLocalWallet = async () => {
		if (!process.env.DYDX_V4_MNEMONIC) {
			console.log('DYDX_V4_MNEMONIC is not set as environment variable');
			return;
		}

		const localWallet = await LocalWallet.fromMnemonic(
			process.env.DYDX_V4_MNEMONIC,
			BECH32_PREFIX
		);
		console.log('dYdX v4 Address:', localWallet.address);

		return localWallet;
	};

	private buildIndexerClient = () => {
		const mainnetIndexerConfig = this.getIndexerConfig();
		const indexerConfig =
			process.env.NODE_ENV !== 'production'
				? Network.testnet().indexerConfig
				: mainnetIndexerConfig;
		return new IndexerClient(indexerConfig);
	};

	private getIndexerConfig = () => {
		return new IndexerConfig(
			config.get('DydxV4.IndexerConfig.httpsEndpoint'),
			config.get('DydxV4.IndexerConfig.wssEndpoint')
		);
	};

	private generateRandomInt32(): number {
		const maxInt32 = 2147483647;
		return Math.floor(Math.random() * (maxInt32 + 1));
	}

	getOrders = async () => {
		const client = this.buildIndexerClient();
		const localWallet = await this.generateLocalWallet();
		if (!localWallet) return;

		return await client.account.getSubaccountOrders(localWallet.address, 0);
	};
}
