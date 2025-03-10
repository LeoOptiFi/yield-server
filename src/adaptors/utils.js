const superagent = require('superagent');
const { request, gql } = require('graphql-request');
const { chunk } = require('lodash');
const sdk = require('@defillama/sdk');
const { default: BigNumber } = require('bignumber.js');

exports.formatChain = (chain) => {
  if (chain && chain.toLowerCase() === 'xdai') return 'xDai';
  return chain.charAt(0).toUpperCase() + chain.slice(1);
};

const getFormatter = (symbol) => {
  if (symbol.includes('USD+')) return /[_:\/]/g;
  return /[_+:\/]/g;
};

// replace / with - and trim potential whitespace
exports.formatSymbol = (symbol) =>
  symbol.replace(getFormatter(symbol), '-').replace(/\s/g, '').trim();

exports.getData = async (url, query = null) => {
  if (query !== null) {
    res = await superagent.post(url).send(query);
  } else {
    res = await superagent.get(url);
  }
  res = res.body;
  return res;
};

// retrive block based on unixTimestamp array
exports.getBlocksByTime = async (timestamps, chainString) => {
  const chain = chainString === 'avalanche' ? 'avax' : chainString;
  const blocks = [];
  for (const timestamp of timestamps) {
    const response = await superagent.get(
      `https://coins.llama.fi/block/${chain}/${timestamp}`
    );
    blocks.push(response.body.height);
  }
  return blocks;
};

const getLatestBlockSubgraph = async (url) => {
  // const queryGraph = gql`
  //   {
  //     indexingStatusForCurrentVersion(subgraphName: "<PLACEHOLDER>") {
  //       chains {
  //         latestBlock {
  //           number
  //         }
  //       }
  //     }
  //   }
  // `;
  const queryGraph = gql`
    {
      _meta {
        block {
          number
        }
      }
    }
  `;

  // const blockGraph = await request(
  //   'https://api.thegraph.com/index-node/graphql',
  //   queryGraph.replace('<PLACEHOLDER>', url.split('name/')[1])
  // );
  const blockGraph = await request(
    `https://api.thegraph.com/subgraphs/name/${url.split('name/')[1]}`,
    queryGraph
  );

  // return Number(
  //   blockGraph.indexingStatusForCurrentVersion.chains[0].latestBlock.number
  // );
  return Number(blockGraph._meta.block.number);
};

// func which queries subgraphs for their latest block nb and compares it against
// the latest block from https://coins.llama.fi/block/, if within a certain bound -> ok, otherwise
// will break as data is stale
exports.getBlocks = async (chainString, tsTimeTravel, urlArray) => {
  const timestamp =
    tsTimeTravel !== null
      ? Number(tsTimeTravel)
      : Math.floor(Date.now() / 1000);

  const offset = 86400;
  const timestampPrior = timestamp - offset;
  let [block, blockPrior] = await this.getBlocksByTime(
    [timestamp, timestampPrior],
    chainString
  );

  // in case of standard run, we ping the subgraph and check its latest block
  // ideally its synced with the block from getBlocksByTime. if the delta is too large
  // throwing an error
  if (tsTimeTravel === null) {
    const blocksPromises = [];
    for (const url of urlArray.filter((el) => el !== null)) {
      blocksPromises.push(getLatestBlockSubgraph(url));
    }
    blocks = await Promise.all(blocksPromises);
    // we use oldest block
    blockGraph = Math.min(...blocks);
    // calc delta
    blockDelta = Math.abs(block - blockGraph);

    // check delta (keeping this large for now)
    const thr = chainString === 'ethereum' ? 300 : 3000;
    if (blockDelta > thr) {
      console.log(`block: ${block}, blockGraph: ${blockGraph}`);
      throw new Error(`Stale subgraph of ${blockDelta} blocks!`);
    }

    block = blockGraph;
  }
  return [block, blockPrior];
};

// calculate tvl in usd based on subgraph data.
// reserveUSD field from subgraphs can be unreliable, using defillama price api instead
exports.tvl = async (dataNow, networkString) => {
  // changing the string for avax so it matches the defillama price api
  networkString = networkString === 'avalanche' ? 'avax' : networkString;
  // make copy
  const dataNowCopy = dataNow.map((el) => ({ ...el }));

  // extract unique token id's
  const ids = [];
  for (const e of dataNowCopy) {
    ids.push([
      `${networkString}:${e.token0.id}`,
      `${networkString}:${e.token1.id}`,
    ]);
  }
  let idsSet = [...new Set(ids.flat())];

  // pull token prices
  let prices = await this.getData('https://coins.llama.fi/prices', {
    coins: idsSet,
  });
  prices = prices.coins;

  // calc tvl
  for (const el of dataNowCopy) {
    let price0 = prices[`${networkString}:${el.token0.id}`]?.price;
    let price1 = prices[`${networkString}:${el.token1.id}`]?.price;

    if (price0 !== undefined && price1 !== undefined) {
      tvl = Number(el.reserve0) * price0 + Number(el.reserve1) * price1;
    } else if (price0 !== undefined && price1 === undefined) {
      tvl = Number(el.reserve0) * price0 * 2;
    } else if (price0 === undefined && price1 !== undefined) {
      tvl = Number(el.reserve1) * price1 * 2;
    } else {
      tvl = 0;
    }

    el['totalValueLockedUSD'] = tvl;
  }

  return dataNowCopy;
};

exports.aprToApy = (apr, compoundFrequency = 365) => {
  return (
    ((1 + (apr * 0.01) / compoundFrequency) ** compoundFrequency - 1) * 100
  );
};
// calculating apy based on subgraph data
exports.apy = (entry, dataPrior, version) => {
  entry = { ...entry };

  // uni v2 forks set feeTier to constant
  if (version === 'v2') {
    entry['feeTier'] = 3000;
  }

  // calc prior volume on 24h offset
  entry['volumeUSDPrior'] = dataPrior.find(
    (el) => el.id === entry.id
  )?.volumeUSD;

  // calc 24h volume
  entry['volumeUSD24h'] =
    Number(entry.volumeUSD) - Number(entry.volumeUSDPrior);

  // calc fees
  entry['feeUSD24h'] = (entry.volumeUSD24h * Number(entry.feeTier)) / 1e6;

  // annualise
  entry['feeUSD365days'] = entry.feeUSD24h * 365;

  // calc apy
  entry['apy'] = (entry.feeUSD365days / entry.totalValueLockedUSD) * 100;

  return entry;
};

exports.keepFinite = (p) => {
  if (
    !['apyBase', 'apyReward', 'apy']
      .map((f) => Number.isFinite(p[f]))
      .includes(true)
  )
    return false;

  return Number.isFinite(p['tvlUsd']);
};

exports.getPrices = async (addresses, chain) => {
  const prices = (
    await superagent.post('https://coins.llama.fi/prices').send({
      coins: chain
        ? addresses.map((address) => `${chain}:${address}`)
        : addresses,
    })
  ).body.coins;

  const pricesByAddress = Object.entries(prices).reduce(
    (acc, [address, price]) => ({
      ...acc,
      [address.split(':')[1].toLowerCase()]: price.price,
    }),
    {}
  );

  const pricesBySymbol = Object.entries(prices).reduce(
    (acc, [name, price]) => ({
      ...acc,
      [price.symbol.toLowerCase()]: price.price,
    }),
    {}
  );

  return { pricesBySymbol, pricesByAddress };
};

///////// UNISWAP V2

const calculateApy = (
  poolInfo,
  totalAllocPoint,
  rewardPerBlock,
  rewardPrice,
  reserveUSD,
  blocksPerYear
) => {
  const poolWeight = poolInfo.allocPoint / totalAllocPoint;
  const tokensPerYear = blocksPerYear * rewardPerBlock;

  return ((poolWeight * tokensPerYear * rewardPrice) / reserveUSD) * 100;
};

const calculateReservesUSD = (
  reserves,
  reservesRatio,
  token0,
  token1,
  tokenPrices
) => {
  const { decimals: token0Decimals, id: token0Address } = token0;
  const { decimals: token1Decimals, id: token1Address } = token1;
  const token0Price = tokenPrices[token0Address.toLowerCase()];
  const token1Price = tokenPrices[token1Address.toLowerCase()];

  const reserve0 = new BigNumber(reserves._reserve0)
    .times(reservesRatio)
    .times(10 ** (18 - token0Decimals));
  const reserve1 = new BigNumber(reserves._reserve1)
    .times(reservesRatio)
    .times(10 ** (18 - token1Decimals));

  if (token0Price) return reserve0.times(token0Price).times(2).div(1e18);
  if (token1Price) return reserve1.times(token1Price).times(2).div(1e18);
};

const getPairsInfo = async (pairs, url) => {
  const pairQuery = gql`
    query pairQuery($id_in: [ID!]) {
      pairs(where: { id_in: $id_in }) {
        name
        id
        token0 {
          decimals
          id
        }
        token1 {
          decimals
          id
        }
      }
    }
  `;
  const pairInfo = await Promise.all(
    chunk(pairs, 7).map((tokens) =>
      request(url, pairQuery, {
        id_in: tokens.map((pair) => pair.toLowerCase()),
      })
    )
  );

  return pairInfo
    .map(({ pairs }) => pairs)
    .flat()
    .reduce((acc, pair) => ({ ...acc, [pair.id.toLowerCase()]: pair }), {});
};

exports.uniswap = { calculateApy, calculateReservesUSD, getPairsInfo };

/// MULTICALL

const makeMulticall = async (abi, addresses, chain, params = null) => {
  const data = await sdk.api.abi.multiCall({
    abi,
    calls: addresses.map((address) => ({
      target: address,
      params,
    })),
    chain,
  });

  const res = data.output.map(({ output }) => output);

  return res;
};

exports.makeMulticall = makeMulticall;
