import * as Web3 from 'web3';
import BigNumber from 'bignumber.js';
import {
    FeesRequest,
    FeesResponse,
    HttpClient,
    OrderbookRequest,
    OrderbookResponse,
} from '@0xproject/connect';
import {
    Order,
    SignedOrder,
    ZeroEx,
} from '0x.js';

const mainAsync = async () => {
    try {
        // Provider pointing to local TestRPC on default port 8545
        const provider = new Web3.providers.HttpProvider('http://localhost:8545');

        // Instantiate 0x.js instance
        const zeroEx = new ZeroEx(provider);

        // Instantiate relayer client pointing to a local server on port 3000
        const relayerApiUrl = 'http://localhost:3000';
        const relayerClient = new HttpClient(relayerApiUrl);

        // The number of decimals ZRX and WETH have
        const DECIMALS = 18;

        // Get contract addresses
        const WETH_ADDRESS = await zeroEx.etherToken.getContractAddressAsync();
        const ZRX_ADDRESS = await zeroEx.exchange.getZRXTokenAddressAsync();
        const EXCHANGE_ADDRESS = await zeroEx.exchange.getContractAddressAsync();

        // Get all available addresses
        const addresses = await zeroEx.getAvailableAddressesAsync();

        // Get the first address, this address is preloaded with a ZRX balance from the snapshot
        const zrxOwnerAddress = addresses[0];

        // Assign other addresses as WETH owners
        const wethOwnerAddresses = addresses.slice(1);

        // Set WETH and ZRX unlimited allowances for all addresses
        const setZrxAllowanceTxHashes = await Promise.all(addresses.map(address => {
            return zeroEx.token.setUnlimitedProxyAllowanceAsync(ZRX_ADDRESS, address);
        }));
        const setWethAllowanceTxHashes = await Promise.all(addresses.map(address => {
            return zeroEx.token.setUnlimitedProxyAllowanceAsync(WETH_ADDRESS, address);
        }));
        await Promise.all(setZrxAllowanceTxHashes.concat(setWethAllowanceTxHashes).map(tx => {
            return zeroEx.awaitTransactionMinedAsync(tx);
        }));

        // Deposit ETH and generate WETH tokens for each address in wethOwnerAddresses
        const ethToConvert = ZeroEx.toBaseUnitAmount(new BigNumber(5), DECIMALS); // Number of ETH to convert to WETH
        const depositTxHashes = await Promise.all(wethOwnerAddresses.map(address => {
            return zeroEx.etherToken.depositAsync(ethToConvert, address);
        }));
        await Promise.all(depositTxHashes.map(tx => {
            return zeroEx.awaitTransactionMinedAsync(tx);
        }));

        // Generate and submit orders with increasing ZRX/WETH exchange rate
        await Promise.all(wethOwnerAddresses.map(async (address, index) => {
            // Progrommatically determine the exchange rate based on the index of address in wethOwnerAddresses
            const exchangeRate = (index + 1) * 10; // ZRX/WETH
            const makerTokenAmount = ZeroEx.toBaseUnitAmount(new BigNumber(5), DECIMALS);
            const takerTokenAmount = makerTokenAmount.mul(exchangeRate);

            // Generate fees request for the order
            const feesRequest: FeesRequest = {
                exchangeContractAddress: EXCHANGE_ADDRESS,
                maker: address,
                taker: ZeroEx.NULL_ADDRESS,
                makerTokenAddress: WETH_ADDRESS,
                takerTokenAddress: ZRX_ADDRESS,
                makerTokenAmount,
                takerTokenAmount,
                expirationUnixTimestampSec: new BigNumber(Date.now() + 3600000),
                salt: ZeroEx.generatePseudoRandomSalt(),
            };

            // Send fees request to relayer and receive a FeesResponse instance
            const feesResponse: FeesResponse = await relayerClient.getFeesAsync(feesRequest);

            // Combine the fees request and response to from a complete order
            const order: Order = {
                ...feesRequest,
                ...feesResponse,
            };

            // Create orderHash
            const orderHash = ZeroEx.getOrderHashHex(order);

            // Sign orderHash and produce a ecSignature
            const ecSignature = await zeroEx.signOrderHashAsync(orderHash, address);

            // Append signature to order
            const signedOrder: SignedOrder = {
                ...order,
                ecSignature,
            };

            // Submit order to relayer
            await relayerClient.submitOrderAsync(signedOrder);
        }));

        // Generate orderbook request for ZRX/WETH pair
        const orderbookRequest: OrderbookRequest = {
            baseTokenAddress: ZRX_ADDRESS,
            quoteTokenAddress: WETH_ADDRESS,
        };

        // Send orderbook request to relayer and receive an OrderbookResponse instance
        const orderbookResponse: OrderbookResponse = await relayerClient.getOrderbookAsync(orderbookRequest);

        // Because we are looking to exchange our ZRX for WETH, we get the bids side of the order book
        // Sort them with the best rate first
        const bestOrders = orderbookResponse.bids.sort((orderA, orderB) => {
            const orderRateA = (new BigNumber(orderA.makerTokenAmount)).div(new BigNumber(orderA.takerTokenAmount));
            const orderRateB = (new BigNumber(orderB.makerTokenAmount)).div(new BigNumber(orderB.takerTokenAmount));
            return orderRateB.comparedTo(orderRateA);
        });

        // Calculate and print out the WETH/ZRX exchange rates
        const rates = bestOrders.map(order => {
            const rate = (new BigNumber(order.makerTokenAmount)).div(new BigNumber(order.takerTokenAmount));
            return (rate.toString() + ' WETH/ZRX');
        });
        console.log(rates);

        // Get balances before the fill
        const zrxBalanceBeforeFill = await zeroEx.token.getBalanceAsync(ZRX_ADDRESS, zrxOwnerAddress);
        const wethBalanceBeforeFill = await zeroEx.token.getBalanceAsync(WETH_ADDRESS, zrxOwnerAddress);
        console.log('ZRX Before: ' + ZeroEx.toUnitAmount(zrxBalanceBeforeFill, DECIMALS).toString());
        console.log('WETH Before: ' + ZeroEx.toUnitAmount(wethBalanceBeforeFill, DECIMALS).toString());

        // Fill up to 300 ZRX worth of orders from the relayer, starting with the orders with the best rates
        const zrxAmount = ZeroEx.toBaseUnitAmount(new BigNumber(300), DECIMALS);
        const fillOrderTxHash = await zeroEx.exchange.fillOrdersUpToAsync(bestOrders, zrxAmount, true, zrxOwnerAddress);
        await zeroEx.awaitTransactionMinedAsync(fillOrderTxHash);

        // Get balances after the fill
        const zrxBalanceAfterFill = await zeroEx.token.getBalanceAsync(ZRX_ADDRESS, zrxOwnerAddress);
        const wethBalanceAfterFill = await zeroEx.token.getBalanceAsync(WETH_ADDRESS, zrxOwnerAddress);
        console.log('ZRX After: ' + ZeroEx.toUnitAmount(zrxBalanceAfterFill, DECIMALS).toString());
        console.log('WETH After: ' + ZeroEx.toUnitAmount(wethBalanceAfterFill, DECIMALS).toString());
    } catch (err) {
        console.log(err);
    }
};

mainAsync()
    .catch(err => console.log);