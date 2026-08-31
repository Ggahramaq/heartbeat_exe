import { PublicKey } from '@solana/web3.js'
import { rpcWithRetry } from './solana.mjs'

// Pyth's sponsored SOL/USD price-feed account on Solana (shard 0). The feed
// id is embedded in, and verified against, the account before its price is used.
const SOL_USD_PRICE_ACCOUNT = new PublicKey('7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE')
const PYTH_RECEIVER_PROGRAM = new PublicKey('rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ')
const SOL_USD_FEED_ID = Buffer.from('ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d', 'hex')
const MAX_PRICE_AGE_SECONDS = 120

// PriceFeedAccount serializes the Anchor discriminator, write authority,
// verification level, then PriceFeedMessage. The latter is: feed id, i64
// price, u64 confidence, i32 exponent, i64 publish time, ...
export async function getPythSolUsdPrice(connection) {
  const account = await rpcWithRetry(() => connection.getAccountInfo(SOL_USD_PRICE_ACCOUNT, 'confirmed'), 'Pyth SOL/USD read')
  if (!account || !account.owner.equals(PYTH_RECEIVER_PROGRAM)) throw new Error('Pyth SOL/USD feed account is unavailable or has an unexpected owner')
  const data = account.data
  const feedOffset = 41
  const priceOffset = feedOffset + 32
  const exponentOffset = priceOffset + 16
  const publishTimeOffset = exponentOffset + 4
  if (data.length < publishTimeOffset + 8 || data[40] !== 1 || !data.subarray(feedOffset, feedOffset + 32).equals(SOL_USD_FEED_ID)) {
    throw new Error('Pyth SOL/USD feed account failed validation')
  }
  const price = data.readBigInt64LE(priceOffset)
  const exponent = data.readInt32LE(exponentOffset)
  const publishTime = Number(data.readBigInt64LE(publishTimeOffset))
  if (price <= 0n || !Number.isFinite(publishTime) || Math.floor(Date.now() / 1000) - publishTime > MAX_PRICE_AGE_SECONDS) {
    throw new Error('Pyth SOL/USD price is stale or invalid')
  }
  return Number(price) * 10 ** exponent
}
