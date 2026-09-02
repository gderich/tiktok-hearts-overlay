import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import http from 'node:http';
import { Server } from 'socket.io';
import { TikTokLiveConnection } from 'tiktok-live-connector';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT) || 8080;
const SETTINGS_FILE = path.join(__dirname, 'streamer.json');
const DEMO = String(process.env.DEMO || '').toLowerCase() === 'true';
const RESET_TOKEN = String(process.env.RESET_TOKEN || '').trim();
const EULER_API_KEY = String(process.env.EULER_API_KEY || '').trim();
const MAX_RANKING = 50;
const MAX_RECENT_LIKES = 25;

function cleanUsername(value) { return String(value || '').trim().replace(/^@+/, '').replace(/[^a-zA-Z0-9._]/g, ''); }
function loadUsername() {
  try { if (fs.existsSync(SETTINGS_FILE)) { const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); const name = cleanUsername(saved.username); if (name) return name; } }
  catch (err) { console.warn('[AVISO] Erro lendo streamer.json:', err?.message || err); }
  return cleanUsername(process.env.TIKTOK_USERNAME);
}
function saveUsername(name) { try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ username: name }, null, 2)); } catch (err) { console.warn('[AVISO] Nao consegui salvar o streamer:', err?.message || err); } }

let username = loadUsername();
let connection = null;
let reconnectTimer = null;
let statsTimer = null;
let connecting = false;
let reconnectDelay = 5000;
let lastError = null;
let lastEvent = null;
let decodedEvents = 0;
let likeEvents = 0;
let lastLikeSource = null;
let lastLikeDebug = null;
let lastTikTokTotal = 0;
const processedLikeIds = new Set();
const recentLikes = [];

const state = { connected: false, username, totalHearts: 0, viewerCount: 0, leaderboard: new Map(), lastLikeAt: 0 };
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'overlay.html')));
app.get('/settings', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'settings.html')));
app.get('/api/config', (_req, res) => res.json({ username, connected: state.connected, demo: DEMO, hasEulerApiKey: Boolean(EULER_API_KEY), lastError }));
app.get('/health', (_req, res) => res.json({
  ok: true,
  connected: state.connected,
  username,
  totalHearts: state.totalHearts,
  users: state.leaderboard.size,
  lastLikeAt: state.lastLikeAt,
  lastError,
  lastEvent,
  decodedEvents,
  likeEvents,
  lastLikeSource,
  lastLikeDebug,
  lastTikTokTotal,
  recentLikes
}));

// Proxy de avatar: evita bloqueios do CDN do TikTok no navegador/OBS e mantem o URL fora do HTML.
app.get('/avatar', async (req, res) => {
  try {
    const raw = String(req.query.url || '').trim();
    const target = new URL(raw);
    const host = target.hostname.toLowerCase();
    const allowed = host === 'tiktokcdn.com' || host.endsWith('.tiktokcdn.com') || host === 'tiktok.com' || host.endsWith('.tiktok.com');
    if (!allowed) return res.status(400).end();
    const response = await fetch(target, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!response.ok) return res.status(response.status).end();
    const contentType = response.headers.get('content-type') || 'image/webp';
    if (!contentType.startsWith('image/')) return res.status(415).end();
    const buffer = Buffer.from(await response.arrayBuffer());
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=3600');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.end(buffer);
  } catch (err) {
    console.warn('[AVISO] Falha ao buscar avatar:', err?.message || err);
    return res.status(404).end();
  }
});

app.post('/api/streamer', async (req, res) => {
  const requested = cleanUsername(req.body?.username);
  if (!requested || requested.length < 2) return res.status(400).json({ ok: false, error: 'Informe um @username valido.' });
  username = requested; state.username = username; saveUsername(username); resetState(); lastError = null;
  if (!DEMO) { await disconnectCurrent(); connectLive(); }
  return res.json({ ok: true, username, message: 'Streamer alterado. Tentando conectar...' });
});
app.get('/reset', (req, res) => {
  if (!RESET_TOKEN || String(req.query.token || '') !== RESET_TOKEN) return res.status(403).json({ ok: false, error: 'Token de reset invalido.' });
  resetState(); return res.json({ ok: true, message: 'Ranking zerado.' });
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' }, pingInterval: 25000, pingTimeout: 20000 });
function number(value, fallback = 0) { const n = Number(value); return Number.isFinite(n) && n >= 0 ? n : fallback; }
function getRanking() { return [...state.leaderboard.values()].sort((a,b) => b.hearts-a.hearts).slice(0, MAX_RANKING); }
function snapshot() { return { connected: state.connected, username: state.username, totalHearts: state.totalHearts, viewerCount: state.viewerCount, lastLikeAt: state.lastLikeAt, ranking: getRanking(), lastError, lastEvent, decodedEvents, likeEvents, lastLikeSource }; }
function broadcast() { io.emit('state', snapshot()); }
function registerHearts(uniqueId, nickname, profilePicture, hearts) {
  if (!uniqueId || hearts <= 0) return;
  const current = state.leaderboard.get(uniqueId) || { uniqueId, nickname: nickname || uniqueId, profilePicture: profilePicture || null, hearts: 0 };
  current.hearts += hearts;
  if (nickname) current.nickname = nickname;
  if (profilePicture) current.profilePicture = profilePicture;
  state.leaderboard.set(uniqueId, current);
}
function resetState() {
  state.totalHearts=0; state.viewerCount=0; state.lastLikeAt=0; state.leaderboard.clear();
  processedLikeIds.clear(); recentLikes.length=0; lastTikTokTotal=0; lastEvent=null; decodedEvents=0; likeEvents=0; lastLikeSource=null; lastLikeDebug=null; broadcast();
}
function scheduleReconnect(delay = reconnectDelay) {
  if (reconnectTimer || connecting || !username || DEMO) return;
  reconnectTimer = setTimeout(() => { reconnectTimer=null; connectLive(); }, Math.min(delay,60000));
  reconnectDelay = Math.min(Math.round(delay*1.5),60000);
  console.log(`[INFO] Nova tentativa em ${Math.round(Math.min(delay,60000)/1000)}s.`);
}
async function disconnectCurrent() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer=null; }
  if (statsTimer) { clearInterval(statsTimer); statsTimer=null; }
  if (connection) { try { if (typeof connection.disconnect==='function') await connection.disconnect(); } catch (err) { console.warn('[AVISO] Erro desconectando:',err?.message||err); } }
  connection=null; state.connected=false;
}
function extractRoomLikeTotal(roomInfo) {
  const candidates = [
    roomInfo?.stats?.like_count,
    roomInfo?.stats?.likeCount,
    roomInfo?.stats?.total_like_count,
    roomInfo?.stats?.totalLikeCount,
    roomInfo?.like_count,
    roomInfo?.likeCount,
    roomInfo?.total_like_count,
    roomInfo?.totalLikeCount,
    roomInfo?.data?.stats?.like_count,
    roomInfo?.data?.stats?.likeCount,
    roomInfo?.data?.stats?.total_like_count,
    roomInfo?.data?.stats?.totalLikeCount
  ];
  return Math.max(...candidates.map(value => number(value, 0)), 0);
}
async function refreshRoomStats() {
  if (!connection || !state.connected) return;
  try {
    const roomInfo = await connection.fetchRoomInfo();
    const roomLikes = extractRoomLikeTotal(roomInfo);
    const viewers = number(roomInfo?.stats?.total_user ?? roomInfo?.stats?.totalUser ?? roomInfo?.stats?.user_count ?? roomInfo?.data?.stats?.total_user, state.viewerCount);
    if (roomLikes > lastTikTokTotal) lastTikTokTotal = roomLikes;
    if (roomLikes > state.totalHearts) state.totalHearts = roomLikes;
    if (viewers > 0) state.viewerCount = viewers;
    broadcast();
  } catch (err) { console.warn('[AVISO] Nao consegui atualizar estatisticas da sala:', err?.message || err); }
}
function firstObject(...values) { return values.find(value => value && typeof value === 'object') || {}; }
function imageUrl(value) {
  if (!value) return null;
  if (typeof value === 'string') return /^https?:\/\//i.test(value) ? value : null;
  if (Array.isArray(value)) return value.map(imageUrl).find(Boolean) || null;
  if (typeof value !== 'object') return null;
  const candidates = [value.urlList, value.url_list, value.urls, value.url, value.openWebUrl, value.open_web_url, value.uri];
  for (const candidate of candidates) {
    const found = imageUrl(candidate);
    if (found) return found;
  }
  return null;
}
function extractLikeData(data) {
  const candidates = [data,data?.data,data?.likeMessage,data?.like,data?.message,data?.message?.data,data?.decodedData,data?.decodedData?.data];
  const root = candidates.find(value => value && typeof value === 'object' && (value.likeCount !== undefined || value.like_count !== undefined || value.totalLikeCount !== undefined || value.total_like_count !== undefined || value.count !== undefined || value.total !== undefined || value.user || value.uniqueId || value.displayId)) || data || {};
  const user = firstObject(root?.user,root?.data?.user,data?.user,data?.data?.user,data?.likeMessage?.user,data?.like?.user);
  const uniqueId = cleanUsername(root?.uniqueId ?? root?.displayId ?? root?.unique_id ?? root?.userId ?? root?.idStr ?? root?.id ?? user?.uniqueId ?? user?.displayId ?? user?.display_id ?? user?.unique_id ?? user?.userId ?? user?.idStr ?? user?.id ?? data?.uniqueId ?? data?.displayId ?? data?.unique_id ?? data?.userId ?? data?.idStr);
  const nickname = String(root?.nickname ?? root?.nickName ?? root?.userName ?? user?.nickname ?? user?.nickName ?? user?.displayName ?? data?.nickname ?? data?.nickName ?? uniqueId).trim();
  const profilePicture = imageUrl(root?.profilePictureUrl ?? root?.profile_picture_url ?? root?.profilePicture ?? user?.profilePictureUrl ?? user?.profile_picture_url ?? user?.avatarThumb ?? user?.avatarMedium ?? user?.avatarLarge ?? data?.profilePictureUrl ?? data?.profilePicture);
  const hearts = number(root?.likeCount ?? root?.like_count ?? root?.count ?? data?.likeCount ?? data?.like_count ?? data?.count, 0);
  const total = number(root?.totalLikeCount ?? root?.total_like_count ?? root?.total ?? data?.totalLikeCount ?? data?.total_like_count ?? data?.total, 0);
  const msgId = root?.msgId ?? root?.msg_id ?? root?.common?.msgId ?? root?.common?.msg_id ?? data?.msgId ?? data?.messageId ?? data?.common?.msgId;
  return { root, user, uniqueId, nickname, profilePicture, hearts, total, msgId };
}
function rememberLikeBatch(entry) {
  recentLikes.unshift(entry);
  if (recentLikes.length > MAX_RECENT_LIKES) recentLikes.length = MAX_RECENT_LIKES;
}
function processLike(data, source='DECODED') {
  const extracted = extractLikeData(data);
  const {root,user,uniqueId,nickname,profilePicture,hearts,total:totalFromTikTok,msgId}=extracted;

  // A mesma mensagem pode aparecer em diferentes camadas da biblioteca.
  // O projeto agora processa LIKE somente pelo decodedData; o msgId fica como protecao extra.
  const dedupeKey = msgId ? `msg:${msgId}` : `${uniqueId}:${hearts}:${totalFromTikTok}`;
  if (processedLikeIds.has(dedupeKey)) return false;
  if (processedLikeIds.size > 5000) processedLikeIds.clear();
  processedLikeIds.add(dedupeKey);

  const previousTikTokTotal = lastTikTokTotal;
  const totalDelta = previousTikTokTotal > 0 && totalFromTikTok > previousTikTokTotal ? totalFromTikTok - previousTikTokTotal : null;
  if (totalFromTikTok > lastTikTokTotal) lastTikTokTotal = totalFromTikTok;
  if (totalFromTikTok > state.totalHearts) state.totalHearts=totalFromTikTok;

  lastLikeDebug={
    source,
    rootKeys:Object.keys(root||{}).slice(0,40),
    userKeys:Object.keys(user||{}).slice(0,40),
    uniqueId:uniqueId||null,
    nickname:nickname||null,
    hearts,
    totalLikeCount:totalFromTikTok,
    totalDelta,
    msgId:msgId?String(msgId):null,
    profilePicture:profilePicture||null
  };

  likeEvents++;
  lastLikeSource=source;
  const batch = {
    at: Date.now(),
    source,
    uniqueId: uniqueId || null,
    nickname: nickname || null,
    batchCount: hearts,
    cumulativeTotal: totalFromTikTok || null,
    totalDelta,
    msgId: msgId ? String(msgId) : null,
    profilePicture: profilePicture || null
  };
  rememberLikeBatch(batch);

  console.log(`[LIKE:${source}] ${uniqueId||'?'} +${hearts} | total=${totalFromTikTok} | delta=${totalDelta ?? '?'} | avatar=${profilePicture?'yes':'no'}`);
  if (totalDelta !== null && hearts > 0 && totalDelta !== hearts) {
    console.log(`[LIKE:INFO] Delta do total (${totalDelta}) diferente do lote do usuario (${hearts}); nao atribuiremos a diferenca ao usuario.`);
  }

  // O ranking representa apenas os lotes de likes que o TikTok efetivamente
  // entregou com um usuario identificavel. Nao usamos a diferenca do total
  // cumulativo para inventar likes de um usuario.
  if (!uniqueId || hearts <= 0) {
    broadcast();
    return false;
  }

  registerHearts(uniqueId,nickname,profilePicture,hearts);
  if (totalFromTikTok <= 0) {
    state.totalHearts+=hearts;
    lastTikTokTotal=state.totalHearts;
  }
  state.lastLikeAt=Date.now();
  broadcast();
  return true;
}
async function connectLive() {
  if (DEMO || !username || connecting || state.connected) return;
  connecting=true; lastError=null; broadcast();
  try {
    const options=EULER_API_KEY?{signApiKey:EULER_API_KEY}:{}; connection=new TikTokLiveConnection(username,options);

    // IMPORTANTE: nao processar WebcastEvent.LIKE e decodedData ao mesmo tempo.
    // O decodedData contem o protobuf WebcastLikeMessage bruto e foi confirmado
    // como a fonte que entrega count/total/msgId neste projeto.
    connection.on('decodedData',(eventName,data)=>{
      decodedEvents++;
      lastEvent=String(eventName||'unknown');
      if(String(eventName||'').toLowerCase().includes('like')) processLike(data,'DECODED');
      if(decodedEvents%20===0) broadcast();
    });
    connection.on('rawData',messageTypeName=>{ lastEvent=String(messageTypeName||'unknown'); if(String(messageTypeName||'').toLowerCase().includes('like')) console.log(`[RAW LIKE] ${messageTypeName}`); });
    connection.on('websocketConnected',()=>console.log('[OK] WebSocket TikTok aberto.'));
    connection.on('roomUser',data=>{state.viewerCount=number(data?.viewerCount??data?.userCount??data?.memberCount,state.viewerCount);broadcast();});
    connection.on('disconnected',({code,reason}={})=>{state.connected=false;if(statsTimer){clearInterval(statsTimer);statsTimer=null;}lastError=`Desconectado${code?` (${code})`:''}${reason?`: ${reason}`:''}`;console.warn('[AVISO]',lastError);broadcast();scheduleReconnect();});
    connection.on('error',err=>{lastError=err?.message||String(err);console.error('[ERRO TikTok]',lastError);broadcast();});
    console.log(`[INFO] Procurando a live de @${username}...`); const live=await connection.fetchIsLive(); console.log(`[INFO] fetchIsLive @${username}: ${live}`); if(!live) throw new Error(`@${username} nao parece estar ao vivo para o TikTok neste momento. Abra a live no TikTok e tente novamente.`);
    const result=await connection.connect(); state.connected=true; state.username=username; reconnectDelay=5000; lastError=null; console.log(`[OK] Conectado em @${username}. roomId=${result.roomId}`); await refreshRoomStats(); statsTimer=setInterval(refreshRoomStats,10000); broadcast();
  } catch(err) { state.connected=false;if(statsTimer){clearInterval(statsTimer);statsTimer=null;}lastError=err?.message||String(err);console.error(`[FALHA] @${username}: ${lastError}`);broadcast();scheduleReconnect(); } finally { connecting=false; }
}
io.on('connection',socket=>socket.emit('state',snapshot()));
function startDemo(){state.connected=true;state.username='modo-demo';const users=[['ana.streams','Ana'],['joao_rj','Joao RJ'],['bia.gamer','Bia Gamer'],['pedro99','Pedro'],['lu_fofa','Lu']];setInterval(()=>{const[id,nick]=users[Math.floor(Math.random()*users.length)];const hearts=Math.floor(Math.random()*35)+1;state.totalHearts+=hearts;state.lastLikeAt=Date.now();registerHearts(id,nick,null,hearts);broadcast();},900);broadcast();}
server.listen(PORT,'0.0.0.0',()=>{console.log(`[OK] Overlay rodando na porta ${PORT}`);if(DEMO)startDemo();else connectLive();});
