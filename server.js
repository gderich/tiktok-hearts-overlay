import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import http from 'node:http';
import { Server } from 'socket.io';
import { TikTokLiveConnection, WebcastEvent } from 'tiktok-live-connector';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 8082;
const USERNAME = String(process.env.TIKTOK_USERNAME || '').trim().replace(/^@/, '');
const DEMO = String(process.env.DEMO || '').toLowerCase() === 'true';

const app = express();
app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'overlay.html')));
app.get('/health', (_req, res) => res.status(200).json({ ok: true }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const state = {
  connected: false,
  username: USERNAME,
  totalHearts: 0,
  viewerCount: 0,
  leaderboard: new Map(),
};

function getRanking(limit = 10) {
  return [...state.leaderboard.values()].sort((a, b) => b.hearts - a.hearts).slice(0, limit);
}

function broadcastState() {
  io.emit('state', {
    connected: state.connected,
    username: state.username,
    totalHearts: state.totalHearts,
    viewerCount: state.viewerCount,
    ranking: getRanking(10),
  });
}

function toPositiveNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function registerHearts({ uniqueId, nickname, profilePicture, hearts }) {
  if (!uniqueId) return;
  const amount = toPositiveNumber(hearts, 1);
  if (!amount) return;
  const current = state.leaderboard.get(uniqueId) || {
    uniqueId,
    nickname: nickname || uniqueId,
    profilePicture: profilePicture || null,
    hearts: 0,
  };
  current.hearts += amount;
  if (nickname) current.nickname = nickname;
  if (profilePicture) current.profilePicture = profilePicture;
  state.leaderboard.set(uniqueId, current);
}

function resetState() {
  state.totalHearts = 0;
  state.viewerCount = 0;
  state.leaderboard.clear();
  broadcastState();
}

io.on('connection', (socket) => {
  socket.emit('state', {
    connected: state.connected,
    username: state.username,
    totalHearts: state.totalHearts,
    viewerCount: state.viewerCount,
    ranking: getRanking(10),
  });
  socket.on('reset', resetState);
});

function startDemo() {
  console.log('[DEMO] Rodando em modo de demonstracao com dados falsos.');
  state.connected = true;
  state.username = 'modo-demo';
  const fakeUsers = [
    { uniqueId: 'ana.streams', nickname: 'Ana' },
    { uniqueId: 'joao_rj', nickname: 'João RJ' },
    { uniqueId: 'bia.gamer', nickname: 'Bia Gamer' },
    { uniqueId: 'pedro99', nickname: 'Pedro' },
    { uniqueId: 'lu_fofa', nickname: 'Lu' },
  ];
  setInterval(() => {
    const user = fakeUsers[Math.floor(Math.random() * fakeUsers.length)];
    const hearts = Math.floor(Math.random() * 20) + 1;
    state.totalHearts += hearts;
    registerHearts({ ...user, hearts });
    broadcastState();
  }, 1200);
  broadcastState();
}

async function startLive() {
  if (!USERNAME) {
    console.error('[ERRO] Defina TIKTOK_USERNAME nas variáveis de ambiente.');
    return;
  }

  const connectionOptions = {};
  if (process.env.EULER_API_KEY?.trim()) connectionOptions.signApiKey = process.env.EULER_API_KEY.trim();

  const connection = new TikTokLiveConnection(USERNAME, connectionOptions);
  let reconnectTimer = null;
  let reconnecting = false;

  const scheduleReconnect = (delayMs = 5000) => {
    if (reconnectTimer || reconnecting) return;
    const delay = Math.min(Math.max(delayMs, 5000), 60000);
    reconnectTimer = setTimeout(async () => {
      reconnectTimer = null;
      await connect(delay);
    }, delay);
    console.log(`[INFO] Tentando reconectar em ${Math.round(delay / 1000)}s...`);
  };

  async function connect(previousDelayMs = 5000) {
    if (reconnecting || state.connected) return;
    reconnecting = true;
    try {
      const connState = await connection.connect();
      state.connected = true;
      console.log(`[OK] Conectado na live de @${USERNAME} (roomId ${connState.roomId})`);
      broadcastState();
    } catch (err) {
      state.connected = false;
      console.error(`[FALHA] Nao consegui conectar na live de @${USERNAME}: ${err?.message || String(err)}`);
      broadcastState();
      scheduleReconnect(Math.min(previousDelayMs * 1.5, 60000));
    } finally {
      reconnecting = false;
    }
  }

  connection.on(WebcastEvent.LIKE, (data) => {
    const user = data?.user || {};
    const uniqueId = user.uniqueId || data?.uniqueId || user.userId || data?.userId;
    const nickname = user.nickname || data?.nickname || uniqueId;
    const profilePicture = user.profilePictureUrl || data?.profilePictureUrl || null;
    const hearts = toPositiveNumber(data?.likeCount ?? data?.count, 1);
    if (!uniqueId || !hearts) return;

    const totalFromEvent = toPositiveNumber(data?.totalLikeCount ?? data?.total, 0);
    state.totalHearts = totalFromEvent > state.totalHearts ? totalFromEvent : state.totalHearts + hearts;
    registerHearts({ uniqueId, nickname, profilePicture, hearts });
    broadcastState();
  });

  connection.on(WebcastEvent.ROOM_USER, (data) => {
    state.viewerCount = toPositiveNumber(data?.viewerCount ?? data?.totalUser ?? data?.total, state.viewerCount);
    broadcastState();
  });

  connection.on('disconnected', () => {
    state.connected = false;
    console.warn('[AVISO] Desconectado da live.');
    broadcastState();
    scheduleReconnect();
  });

  connection.on('error', (err) => console.error('[ERRO connection]', err?.message || err));
  await connect();
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor do overlay rodando na porta ${PORT}`);
  if (DEMO) startDemo();
  else startLive().catch((err) => console.error('[ERRO FATAL]', err));
});
