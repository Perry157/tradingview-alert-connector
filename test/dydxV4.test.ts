import { DydxV4Client } from '../src/services/dydx_v4/dydxV4Client';

jest.setTimeout(40000);

describe('dydx v4', () => {
	it('should get orders', async () => {
		const dydxV4 = new DydxV4Client();
		const order = await dydxV4.getOrders();
		console.log(order);
	});

	it('should read a valid TWAP config from config/*.yaml', () => {
		const dydxV4 = new DydxV4Client();
		// getTwapConfig is private; this is a local, network-free sanity check
		// that config/*.yaml's DydxV4.Twap block parses and validates.
		const twap = (dydxV4 as any).getTwapConfig();

		expect(twap.durationSeconds).toBeGreaterThanOrEqual(300);
		expect(twap.durationSeconds).toBeLessThanOrEqual(86400);
		expect(twap.intervalSeconds).toBeGreaterThanOrEqual(30);
		expect(twap.intervalSeconds).toBeLessThanOrEqual(3600);
		expect(twap.durationSeconds % twap.intervalSeconds).toBe(0);
		expect(twap.priceTolerancePpm).toBeGreaterThanOrEqual(0);
		expect(twap.priceTolerancePpm).toBeLessThan(1000000);
	});
});
