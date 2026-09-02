import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import http from 'node:http';
import { Server } from 'socket.io';
import { TikTokLiveConnection, WebcastEvent } from 'tiktok-live-connector';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT) || 8080;
const SETTINGS_FILE = path.join(__dirname, 'streamer.json');
const DEMO = String(process.env.DEMO || '').toLowerCase() === 'true';
const RESET_TOKEN = String(process.env.RESET_TOKEN || '').trim();
const MAX_RANKING = 50;

function cleanUsername(value) {
  return String(value || '').trim().replace(/^@+/, '').replace(/[^a-zA-Z0-9._]/g, '');
}

function loadUsername() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      const name = cleanUsername(saved.username);
      if (name) return name;
    }
  } catch (err) {
    console.warn('[AVISO] Erro lendo streamer.json:', err?.message || err);
  }
  return cleanUsername(process.env.TIKTOK_USERNAME);
}

function saveUsername(name) {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ username: name }, null, 2));
  } catch (err) {
    console.warn('[AVISO] Nao consegui salvar o novo streamer:', err?.message || err);
  }
}

let username = loadUsername();
let connection = null;
let reconnectTimer = null;
let connecting = false;
let reconnectDelay = 5000;

const state = {
  connected: false,
  username,
  totalHearts: 0,
  viewerCount: 0,
  leaderboard: new Map(),
  lastLikeAt: 0,
};

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'overlay.html')));
app.get('/settings', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'settings.html')));
app.get('/api/config', (_req, res) => res.json({ username, connected: state.connected, demo: DEMO }));
app.get('/health', (_req, res) => res.json({ ok: true, connected: state.connected, username, totalHearts: state.totalHearts, users: state.leaderboard.size }));

app.post('/api/streamer', async (req, res) => {
  const requested = cleanUsername(req.body?.username);
  if (!requested || requested.length < 2) {
    return res.status(400).json({ ok: false, error: 'Informe um @username valido.' });
  }

  username = requested;
  state.username = username;
  saveUsername(username);
  resetState();

  if (!DEMO) {
    await disconnectCurrent();
    connectLive();
  }

  return res.json({ ok: true, username, message: 'Streamer alterado. Tentando conectar...' });
});

app.get('/reset', (req, res) => {
  if (!RESET_TOKEN || String(req.query.token || '') !== RESET_TOKEN) {
    return res.status(403).json({ ok: false, error: 'Token de reset invalido.' });
  }
  resetState();
  return res.json({ ok: true, message: 'Ranking zerado.' });
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' }, pingInterval: 25000, pingTimeout: 20000 });

function number(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function getRanking() {
  return [...state.leaderboard.values()].sort((a, b) => b.hearts - a.hearts).slice(0, MAX_RANKING);
}

function snapshot() {
  return { connected: state.connected, username: state.username, totalHearts: state.totalHearts, viewerCount: state.viewerCount, lastLikeAt: state.lastLikeAt, ranking: getRanking() };
}

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
  state.totalHearts = 0;
  state.viewerCount = 0;
  state.lastLikeAt = 0;
  state.leaderboard.clear();
  broadcast();
}

function scheduleReconnect(delay = reconnectDelay) {
  if (reconnectTimer || connecting || !username || DEMO) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connectLive(); }, Math.min(delay, 60000));
  reconnectDelay = Math.min(Math.round(delay * 1.5), 60000);
  console.log(`[INFO] Nova tentativa em ${Math.round(Math.min(delay, 60000) / 1000)}s.`);
}

async function disconnectCurrent() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (connection) {
    try { if (typeof connection.disconnect === 'function') await connection.disconnect(); } catch (err) { console.warn('[AVISO] Erro desconectando:', err?.message || err); }
  }
  connection = null;
  state.connected = false;
}

async function connectLive() {
  if (DEMO || !username || connecting || state.connected) return;
  connecting = true;
  try {
    connection = new TikTokLiveConnection(username);

    connection.on(WebcastEvent.LIKE, (data) => {
      // Na versao atual 2.4.x os campos do LIKE ficam diretamente em data.
      const uniqueId = data?.uniqueId || data?.user?.uniqueId;
      const nickname = data?.nickname || data?.user?.nickname || uniqueId;
      const profilePicture = data?.profilePictureUrl || data?.user?.profilePictureUrl || null;
      const hearts = number(data?.likeCount, 0);
      const totalFromTikTok = number(data?.totalLikeCount, 0);

      console.log(`[LIKE] ${uniqueId || '?'} +${hearts} | total=${totalFromTikTok}`);
      if (!uniqueId || hearts <= 0) return;

      registerHearts(uniqueId, nickname, profilePicture, hearts);
      state.totalHearts = totalFromTikTok > 0 ? Math.max(state.totalHearts, totalFromTikTok) : state.totalHearts + hearts;
      state.lastLikeAt = Date.now();
      broadcast();
    });

    connection.on(WebcastEvent.ROOM_USER, (data) => {
      state.viewerCount = number(data?.viewerCount, state.viewerCount);
      broadcast();
    });

    connection.on('disconnected', () => {
      state.connected = false;
      console.warn('[AVISO] TikTok desconectou.');
      broadcast();
      scheduleReconnect();
    });

    connection.on('error', err => console.error('[ERRO TikTok]', err?.message || err));

    const result = await connection.connect();
    state.connected = true;
    state.username = username;
    reconnectDelay = 5000;
    console.log(`[OK] Conectado em @${username}. roomId=${result.roomId}`);
    broadcast();
  } catch (err) {
    state.connected = false;
    console.error(`[FALHA] Nao consegui conectar em @${username}: ${err?.message || String(err)}`);
    broadcast();
    scheduleReconnect();
  } finally {
    connecting = false;
  }
}

io.on('connection', socket => socket.emit('state', snapshot()));

function startDemo() {
  state.connected = true;
  state.username = 'modo-demo';
  const users = [['ana.streams', 'Ana'], ['joao_rj', 'Joao RJ'], ['bia.gamer', 'Bia Gamer'], ['pedro99', 'Pedro'], ['lu_fofa', 'Lu']];
  setInterval(() => {
    const [id, nick] = users[Math.floor(Math.random() * users.length)];
    const hearts = Math.floor(Math.random() * 35) + 1;
    state.totalHearts += hearts;
    state.lastLikeAt = Date.now();
    registerHearts(id, nick, null, hearts);
    broadcast();
  }, 900);
  broadcast();
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[OK] Overlay rodando na porta ${PORT}`);
  if (DEMO) startDemo(); else connectLive();
});
