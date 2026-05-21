/**
 * copy/exchangeContracts.js
 * Canonical on-chain exchange event definitions for copy-trade monitoring.
 *
 * We intentionally isolate raw contract details here so the feed implementation
 * can stay focused on lifecycle and normalization instead of ABI trivia.
 */
import { ethers } from 'ethers';
import {
  CTF_EXCHANGE_ADDRESS,
  CTF_EXCHANGE_ADDRESS_V2,
  NEG_RISK_CTF_EXCHANGE,
  NEG_RISK_CTF_EXCHANGE_V2,
} from '../config.js';

const ORDER_FILLED_V1_ABI = [
  'event OrderFilled(bytes32 indexed orderHash,address indexed maker,address indexed taker,uint256 makerAssetId,uint256 takerAssetId,uint256 makerAmountFilled,uint256 takerAmountFilled,uint256 fee)',
];

const ORDER_FILLED_V2_ABI = [
  'event OrderFilled(bytes32 indexed orderHash,address indexed maker,address indexed taker,uint8 side,uint256 tokenId,uint256 makerAmountFilled,uint256 takerAmountFilled,uint256 fee,bytes32 builder,bytes32 metadata)',
];

const v1Interface = new ethers.Interface(ORDER_FILLED_V1_ABI);
const v2Interface = new ethers.Interface(ORDER_FILLED_V2_ABI);

export const ORDER_SIDE = {
  BUY: 0,
  SELL: 1,
};

export const WATCHED_EXCHANGES = [
  {
    key: 'neg-risk-v1',
    version: 'v1',
    address: NEG_RISK_CTF_EXCHANGE,
    interface: v1Interface,
    orderFilledTopic: v1Interface.getEvent('OrderFilled').topicHash,
  },
  {
    key: 'binary-v1',
    version: 'v1',
    address: CTF_EXCHANGE_ADDRESS,
    interface: v1Interface,
    orderFilledTopic: v1Interface.getEvent('OrderFilled').topicHash,
  },
  {
    key: 'binary-v2',
    version: 'v2',
    address: CTF_EXCHANGE_ADDRESS_V2,
    interface: v2Interface,
    orderFilledTopic: v2Interface.getEvent('OrderFilled').topicHash,
  },
  {
    key: 'neg-risk-v2',
    version: 'v2',
    address: NEG_RISK_CTF_EXCHANGE_V2,
    interface: v2Interface,
    orderFilledTopic: v2Interface.getEvent('OrderFilled').topicHash,
  },
];

export function makerTopic(address) {
  return ethers.zeroPadValue(address, 32).toLowerCase();
}

function normalizeV1(decoded) {
  const makerAssetId = decoded.makerAssetId;
  const takerAssetId = decoded.takerAssetId;
  const isBuy = makerAssetId === 0n && takerAssetId !== 0n;

  return {
    isBuy,
    maker: decoded.maker,
    taker: decoded.taker,
    tokenId: isBuy ? takerAssetId.toString() : makerAssetId.toString(),
    makerAmountFilled: decoded.makerAmountFilled,
    takerAmountFilled: decoded.takerAmountFilled,
    fee: decoded.fee,
  };
}

function normalizeV2(decoded) {
  return {
    isBuy: Number(decoded.side) === ORDER_SIDE.BUY,
    maker: decoded.maker,
    taker: decoded.taker,
    tokenId: decoded.tokenId.toString(),
    makerAmountFilled: decoded.makerAmountFilled,
    takerAmountFilled: decoded.takerAmountFilled,
    fee: decoded.fee,
  };
}

export function decodeOrderFilledLog(exchange, log) {
  const decoded = exchange.interface.decodeEventLog('OrderFilled', log.data, log.topics);
  const normalized = exchange.version === 'v2'
    ? normalizeV2(decoded)
    : normalizeV1(decoded);

  return {
    exchange: exchange.key,
    exchangeVersion: exchange.version,
    exchangeAddress: exchange.address,
    orderHash: decoded.orderHash,
    ...normalized,
  };
}
