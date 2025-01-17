import { TransactionReceipt } from "@ethersproject/abstract-provider";
import { bignumberToGwei, delay } from "../utils";
import * as ethers from "ethers";
import IERC20_abi from "./contracts/IERC20.abi.json";
import * as mongoDB from "mongodb";
import { BlockList } from "net";
import {
    addBlockEntry,
    addERC20TransactionEntry, addMonitoredAddress,
    getLastBlockEntry, getMonitoredAddresses,
    updateHistEntry,
    updateTimeFrameEntry
} from "./mongo_connector";
import { BlockInfo } from "./model/BlockInfo";
import { ChainGasScannerStatus } from "./model/ChainGasScannerStatus";
import { TimeFrameStatistics } from "./model/TimeFrameStatistics";
import { MinGasBlocksHistogram } from "./model/MinGasBlocksHistogram";
import {TransactionERC20Entry} from "./model/TransactionEntry";
import {MonitoredAddress} from "./model/MonitoredAddresses";

const ERC20interface = new ethers.utils.Interface(IERC20_abi);

export class ChainGasScanner {
    blockMap = new Map<number, BlockInfo>();
    transReceiptMap = new Map<number, Array<TransactionReceipt>>();

    blockProvider: ethers.providers.JsonRpcBatchProvider;
    transactionsProvider: ethers.providers.JsonRpcBatchProvider;

    chainScannerStatus = new ChainGasScannerStatus();

    transactionReceiptsBatch = new Array<Promise<TransactionReceipt>>();

    workerProcessTransactions: Promise<void> | undefined = undefined;
    workerGetBlocks: Promise<void> | undefined = undefined;

    startingBlockNumber: number = 0;
    blockNumber: number = 0;
    blockTime: string = "";


    monitoredAddresses = new Map<string, MonitoredAddress>();

    constructor(providerRpcAddress: string, startingBlock: number) {
        console.log("ChainGasScanner " + providerRpcAddress + " " + startingBlock);
        this.blockProvider = new ethers.providers.JsonRpcBatchProvider(providerRpcAddress);
        this.transactionsProvider = new ethers.providers.JsonRpcBatchProvider(providerRpcAddress);
        this.startingBlockNumber = startingBlock;
    }

    async loadMonitoredAddresses() {
        let list = await getMonitoredAddresses();
        for (let addr of list) {
            this.monitoredAddresses.set(addr.address.toLowerCase(), addr);
        }
    }

    computeBlockHistogram(name: string, blockCount: number): MinGasBlocksHistogram {
        let mgh = new MinGasBlocksHistogram();
        mgh.name = name;
        for (let blockNo = this.blockNumber - blockCount; blockNo < this.blockNumber; blockNo += 1) {
            let bi = this.blockMap.get(blockNo);
            if (bi !== undefined) {
                mgh.blockNums.push(bi.blockNo);
                mgh.minGas.push(bi.minGas);
                mgh.blockFill.push(bi.gasUsed / bi.gasLimit);
            }
        }
        return mgh;
    }

    computeTimeFrameStatistics(name: string, blockCount: number): TimeFrameStatistics {
        let tfs = new TimeFrameStatistics();
        tfs.name = name;
        for (let blockNo = this.blockNumber - blockCount; blockNo < this.blockNumber; blockNo += 1) {
            let bi = this.blockMap.get(blockNo);

            if (bi !== undefined) {
                if (tfs.firstBlockTime == "") {
                    tfs.firstBlockTime = bi.blockTime;
                }
                tfs.lastBlockTime = bi.blockTime;
                tfs.blockCount += 1;
                if (bi.transCount != 0) {
                    tfs.transCount += bi.transCount;
                    if (tfs.minGas == 0.0) {
                        tfs.minGas = bi.minGas;
                    }
                    if (bi.minGas < tfs.minGas) {
                        tfs.minGas = bi.minGas;
                    }
                    if (bi.minGas > tfs.maxMinGas) {
                        tfs.maxMinGas = bi.minGas;
                    }
                }
            }
        }
        return tfs;
    }

    async getBlocksWorker() {
        try {
            this.blockNumber = this.startingBlockNumber;

            if (this.blockNumber <= 0) {
                this.blockNumber = await this.blockProvider.getBlockNumber();
            }

            while (true) {
                for (let blockNum of this.transReceiptMap.keys()) {
                    if (blockNum < this.blockNumber - 10) {
                        this.transReceiptMap.delete(blockNum);
                    }
                }
                for (let blockNum of this.blockMap.keys()) {
                    if (blockNum < this.blockNumber - 1200) {
                        this.blockMap.delete(blockNum);
                    }
                }

                let blockPromise = this.blockProvider.getBlock(this.blockNumber);
                let blockNumberPromise = this.blockProvider.getBlockNumber();

                let block = await blockPromise;
                let blockNumberFromNetwork = await blockNumberPromise;

                if (blockNumberFromNetwork > this.blockNumber) {
                    console.warn(`Scanner is late ${blockNumberFromNetwork - this.blockNumber} blocks`);
                }
                this.chainScannerStatus.currentBlock = blockNumberFromNetwork;
                this.chainScannerStatus.processedBlock = this.blockNumber;
                this.chainScannerStatus.lateBlocks = blockNumberFromNetwork - this.blockNumber;
                if (this.chainScannerStatus.lateBlocks > this.chainScannerStatus.maxLateBlocks) {
                    this.chainScannerStatus.maxLateBlocks = this.chainScannerStatus.lateBlocks;
                }
                this.chainScannerStatus.lastUpdate = new Date().toISOString();
                if (block == null) {
                    console.log("Too fast, no block info yet");
                    await delay(300);
                    continue;
                }

                //console.log(block);
                this.blockTime = new Date(block.timestamp * 1000).toISOString();
                this.blockNumber = block.number;

                let blockInfo = this.blockMap.get(this.blockNumber);
                if (blockInfo === undefined) {
                    blockInfo = new BlockInfo();
                    blockInfo.gasLimit = block.gasLimit.toNumber();
                    blockInfo.transCount = block.transactions.length;
                    blockInfo.blockTime = new Date(block.timestamp * 1000).toISOString();
                    if (block.baseFeePerGas) {
                        blockInfo.baseFeePrice = bignumberToGwei(block.baseFeePerGas);
                    }
                    this.blockMap.set(this.blockNumber, blockInfo);
                }

                let nextBatch = new Array<Promise<TransactionReceipt>>();


                console.log("num transactions: " + block.transactions.length);
                for (let transaction of block.transactions) {
                    if (nextBatch.length <= 3) {
                        //this.transactionsToProcess.push(transaction);
                        nextBatch.push(this.transactionsProvider.getTransactionReceipt(transaction));
                    }
                }
                //good moment to store data in db;

                const query = { name: this.chainScannerStatus.name };
                const update = { $set: this.chainScannerStatus };
                const options = { upsert: true };

                //await this.mongoDBCollection.updateOne(query, update, options);

                //wait until previous batch gets processed
                while (this.transactionReceiptsBatch.length > 0) {
                    await delay(50);
                }

                {
                    let gas_prices_array = this.transReceiptMap.get(this.blockNumber - 1);
                    let bi = this.blockMap.get(this.blockNumber - 1);
                    if (bi !== undefined && gas_prices_array !== undefined) {
                        if (gas_prices_array && gas_prices_array.length > 0) {
                            gas_prices_array.sort((a, b) => bignumberToGwei(a.effectiveGasPrice) - bignumberToGwei(b.effectiveGasPrice));
                            if (bi.minGas != bignumberToGwei(gas_prices_array[0].effectiveGasPrice)) {
                                console.log("Something went wrong bi.minGas != gas_prices_array[0]");
                            }
                            let firstTransGas = gas_prices_array[0].gasUsed.toNumber();
                            if (firstTransGas < 50000 && gas_prices_array.length > 1) {
                                bi.minGas = bignumberToGwei(gas_prices_array[1].effectiveGasPrice);
                            }
                            bi.medianGas = bignumberToGwei(gas_prices_array[Math.floor(gas_prices_array.length / 2)].effectiveGasPrice);
                        }
                        console.log(`Block no ${bi.blockNo}, minimum gas: ${bi.minGas}, gas used: ${bi.gasUsed}, gas limit: ${bi.gasLimit}, transaction count: ${bi.transCount}`);
                        await addBlockEntry(bi);
                    }
                }

                let mgh10 = this.computeBlockHistogram("hist_10_block", 10);
                await updateHistEntry(mgh10);

                let tfs10 = this.computeTimeFrameStatistics("last_10_block", 10);
                await updateTimeFrameEntry(tfs10);

                let tfs100 = this.computeTimeFrameStatistics("last_100_block", 100);
                await updateTimeFrameEntry(tfs100);

                let tfs1000 = this.computeTimeFrameStatistics("last_1000_block", 1000);
                await updateTimeFrameEntry(tfs1000);

                this.chainScannerStatus.totalTransactionCount += nextBatch.length;
                this.transactionReceiptsBatch = nextBatch;

                this.blockNumber += 1;
            }
        }
        catch (ex) {
            await delay(1000);
            console.error(ex);
        }
    }

    async processTransactionReceipt(transactionReceipt: TransactionReceipt) {
        let transferCount = 0;
        let addresses: { [address: string]: number } = {};
        console.log("Gas price: " + transactionReceipt.effectiveGasPrice);


        let blockNumber = transactionReceipt.blockNumber;

        let blockInfo = this.blockMap.get(blockNumber);
        if (blockInfo === undefined) {
            blockInfo = new BlockInfo();
            this.blockMap.set(blockNumber, blockInfo);
        }
        let gasPricesArray = this.transReceiptMap.get(blockNumber);
        if (gasPricesArray === undefined) {
            gasPricesArray = new Array<TransactionReceipt>();
            this.transReceiptMap.set(blockNumber, gasPricesArray);
        }

        let effectiveGasPrice = bignumberToGwei(transactionReceipt.effectiveGasPrice);
        //if gas price is lower than 1 gwei then it is special transaction (propably with zero gas)
        if (effectiveGasPrice >= 1.0) {
            gasPricesArray.push(transactionReceipt);
            if (blockInfo.minGas == 0.0) {
                blockInfo.minGas = effectiveGasPrice;
            }
            blockInfo.minGas = Math.min(blockInfo.minGas, bignumberToGwei(transactionReceipt.effectiveGasPrice));
        }
        blockInfo.blockNo = transactionReceipt.blockNumber;
        blockInfo.gasUsed += transactionReceipt.gasUsed.toNumber();
        let burnedFees = blockInfo.baseFeePrice * transactionReceipt.gasUsed.toNumber() * 1.0E-9;
        let totalFees = bignumberToGwei(transactionReceipt.effectiveGasPrice) * transactionReceipt.gasUsed.toNumber() * 1.0E-9;

        if (transactionReceipt.type == 2) {
            blockInfo.transCount2 += 1;
            blockInfo.gasUsed2 += 1;
        }
        blockInfo.burnedFees += burnedFees;
        blockInfo.totalFees += totalFees;


        /*for (let log of transactionReceipt.logs) {
            try {
                console.log(`Log parsed`)
            } catch (e) {
                //ignore
                //console.log(e);
            }
        }*/

        try {
            if (transactionReceipt.to != undefined && transactionReceipt.from != undefined)
            {
                if (transactionReceipt.to.toLowerCase() == "0x0b220b82f3ea3b7f6d9a1d8ab58930c064a2b5bf") {
                    let transactionInfo = await this.transactionsProvider.getTransaction(transactionReceipt.transactionHash);
                    for (let log of transactionReceipt.logs) {
                        try {
                            let parsed = ERC20interface.parseLog(log);
                            //console.log(JSON.stringify(parsed));
                            if (parsed.name == "Transfer") {
                                //console.log("Block number: " + blockNumber);
                                //console.log("Tx transaction: " + transactionReceipt.transactionHash);

                                let tokenFrom = parsed.args[0];
                                let tokenTo = parsed.args[1];
                                let amount = parsed.args[2];

                                if (!this.monitoredAddresses.has(transactionReceipt.from.toLowerCase())) {
                                    let ma = new MonitoredAddress();
                                    ma.address = transactionReceipt.from.toString().toLowerCase();
                                    this.monitoredAddresses.set(ma.address.toLowerCase(), ma);
                                    await addMonitoredAddress(ma);
                                }

                                let newEntry = new TransactionERC20Entry();
                                newEntry.txid = transactionReceipt.transactionHash.toString().toLowerCase();
                                newEntry.datetime = blockInfo.blockTime;
                                newEntry.nonce = transactionInfo.nonce;
                                newEntry.blockNo = transactionReceipt.blockNumber;
                                newEntry.gasUsed = transactionReceipt.gasUsed.toString();
                                newEntry.gasPrice = transactionReceipt.effectiveGasPrice.toString();
                                newEntry.gasLimit = transactionInfo.gasLimit.toString();
                                newEntry.erc20amount = amount.toString();
                                newEntry.to = transactionReceipt.to.toString().toLowerCase();
                                newEntry.from = transactionReceipt.from.toString().toLowerCase();
                                newEntry.erc20from = tokenFrom.toString().toLowerCase();
                                newEntry.erc20to = tokenTo.toString().toLowerCase();
                                await addERC20TransactionEntry(newEntry);
                                console.log(`Glm transfer from ${tokenFrom} to ${tokenTo}. Amount ${amount}`);
                            }
                        }
                        catch (ex) {
                            console.log(ex);
                        }
                    }
                } else {
                    if (this.monitoredAddresses.has(transactionReceipt.from.toLowerCase())) {
                        let newEntry = new TransactionERC20Entry();
                        newEntry.txid = transactionReceipt.transactionHash.toString().toLowerCase();
                        newEntry.datetime = blockInfo.blockTime;
                        newEntry.nonce = transactionReceipt.transactionIndex;
                        newEntry.blockNo = transactionReceipt.blockNumber;
                        newEntry.gasUsed = transactionReceipt.gasUsed.toString();
                        newEntry.gasPrice = transactionReceipt.effectiveGasPrice.toString();
                        newEntry.erc20amount = "";
                        newEntry.to = transactionReceipt.to.toString().toLowerCase();
                        newEntry.from = transactionReceipt.from.toString().toLowerCase();
                        newEntry.erc20from = "";
                        newEntry.erc20to = "";
                        await addERC20TransactionEntry(newEntry);
                    }
                }
            }
        } catch (e) {
            //ignore
            console.log(e);
        }


        if (transferCount >= 2 && transferCount <= 3) {
            for (let address in addresses) {
                //console.log(address);
            }
        }
        if (transferCount >= 2 && transferCount <= 3) {
            for (let address in addresses) {
                //console.log(address);
            }
        }
    }

    async processTransactions() {
        while (true) {
            try {
                if (this.transactionReceiptsBatch.length > 0) {
                    for (let promise of this.transactionReceiptsBatch) {

                        let transactionReceipt = await promise;
                        if (transactionReceipt == null) {
                            console.error("Cannot get transaction receipt + ");
                            continue;
                        }
                        await this.processTransactionReceipt(transactionReceipt);
                        this.chainScannerStatus.processedTransactionCount += 1;
                    }
                    let droppedTransactions = this.chainScannerStatus.totalTransactionCount - this.chainScannerStatus.processedTransactionCount;
                    this.chainScannerStatus.droppedTransactionCount = droppedTransactions;
                    console.log(`Processed vs total transaction count ${this.chainScannerStatus.processedTransactionCount}/${this.chainScannerStatus.totalTransactionCount}). Dropped count: ${droppedTransactions}`)
                    this.transactionReceiptsBatch.length = 0;
                }


                await delay(100);
                continue;
            }
            catch (e) {
                this.transactionReceiptsBatch.length = 0;
                console.error("Something went wrong, dropping transaction batch + " + e);
                await delay(100);
            }
        }
    }

    async runWorkers() {
        await this.loadMonitoredAddresses();
        this.workerProcessTransactions = this.processTransactions();
        this.workerGetBlocks = this.getBlocksWorker();
    }

}





