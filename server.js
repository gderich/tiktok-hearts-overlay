import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import http from 'node:http';
import { Server } from 'socket.io';
import { TikTokLiveConnection, WebcastEvent } from 'tiktok-live-connector';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 8080;
const USERNAME = String(process.env.TIKTOK_USERNAME || '').trim().replace(/^@/, '');
const DEMO = String(process.env.DEMO || '').toLowerCase() === 'true';
const RESET_TOKEN = String(process.env.RESET_TOKEN || '').trim();
const MAX_RANKING = 50;

const app = express();
app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'overlay.html'));
});

app.get('/health', (_req, res) => {
  res.status(200).json({
    ok: true,
    connected: state.connected,
    username: state.username || null,
    totalHearts: state.totalHearts,
    viewers: state.viewerCount,
    users: state.leaderboard.size,
  });
});

app.get('/reset', (req, res) => {
  if (!RESET_TOKEN || req.query.token !== RESET_TOKEN) {
    return res.status(403).json({ ok: false, error: 'Token de reset invalido.' });
  }
  resetState();
  return res.json({ ok: true, message: 'Ranking zerado.' });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 25000,
  pingTimeout: 20000,
});

const state = {
  connected: false,
  username: USERNAME,
  totalHearts: 0,
  viewerCount: 0,
  leaderboard: new Map(),
  lastLikeAt: 0,
};

function number(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function getRanking() {
  return [...state.leaderboard.values()]
    .sort((a, b) => b.hearts - a.hearts)
    .slice(0, MAX_RANKING);
}

function snapshot() {
  return {
    connected: state.connected,
    username: state.username,
    totalHearts: state.totalHearts,
    viewerCount: state.viewerCount,
    lastLikeAt: state.lastLikeAt,
    ranking: getRanking(),
  };
}

function broadcast() {
  io.emit('state', snapshot());
}

function registerHearts(uniqueId, nickname, profilePicture, hearts) {
  if (!uniqueId) return;
  const amount = Math.max(0, number(hearts, 1));
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
  state.lastLikeAt = 0;
  state.leaderboard.clear();
  broadcast();
  console.log('[RESET] Ranking zerado.');
}

io.on('connection', (socket) => {
  socket.emit('state', snapshot());
});

function startDemo() {
  console.log('[DEMO] Modo demonstracao ativo.');
  state.connected = true;
  state.username = 'modo-demo';

  const users = [
    ['faladerix', 'faladerix'],
    ['ana.streams', 'Ana'],
    ['joao_rj', 'João RJ'],
    ['bia.gamer', 'Bia Gamer'],
    ['pedro99', 'Pedro'],
    ['lu_fofa', 'Lu'],
    ['mika.live', 'Mika'],
  ];

  setInterval(() => {
    const [uniqueId, nickname] = users[Math.floor(Math.random() * users.length)];
    const hearts = Math.floor(Math.random() * 35) + 1;
    state.totalHearts += hearts;
    state.lastLikeAt = Date.now();
    registerHearts(uniqueId, nickname, null, hearts);
    broadcast();
  }, 900);

  broadcast();
}

async function startLive() {
  if (!USERNAME) {
    console.error('[ERRO] Defina TIKTOK_USERNAME nas variaveis de ambiente.');
    return;
  }

  const options = {};
  if (process.env.EULER_API_KEY?.trim()) {
    options.signApiKey = process.env.EULER_API_KEY.trim();
  }

  let connection;
  try {
    connection = new TikTokLiveConnection(USERNAME, options);
  } catch (err) {
    console.error('[ERRO] Nao foi possivel criar a conexao TikTok:', err);
    return;
  }

  let reconnectTimer = null;
  let connecting = false;
  let stopped = false;
  let retryDelay = 5000;

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer || connecting || state.connected) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, retryDelay);
    console.log(`[INFO] Nova tentativa em ${Math.round(retryDelay / 1000)}s.`);
    retryDelay = Math.min(Math.round(retryDelay * 1.5), 60000);
  };

  async function connect() {
    if (stopped || connecting || state.connected) return;
    connecting = true;
    try {
      const result = await connection.connect();
      state.connected = true;
      state.username = USERNAME;
      retryDelay = 5000;
      console.log(`[OK] Conectado em @${USERNAME}. roomId=${result.roomId}`);
      broadcast();
    } catch (err) {
      state.connected = false;
      console.error(`[FALHA] TikTok @${USERNAME}: ${err?.message || String(err)}`);
      broadcast();
      scheduleReconnect();
    } finally {
      connecting = false;
    }
  }

  connection.on(WebcastEvent.LIKE, (data) => {
    const user = data?.user || {};
    const uniqueId = user.uniqueId || data?.uniqueId || user.userId || data?.userId;
    const nickname = user.nickname || data?.nickname || uniqueId;
    const profilePicture = user.profilePictureUrl || data?.profilePictureUrl || null;
    const hearts = number(data?.likeCount ?? data?.count, 1);

    if (!uniqueId || hearts <= 0) return;

    // totalLikeCount é o contador acumulado da live quando fornecido pelo TikTok.
    // O ranking, por outro lado, sempre soma o lote recebido daquele usuario.
    const eventTotal = number(data?.totalLikeCount ?? data?.total, 0);
    if (eventTotal > state.totalHearts) {
      state.totalHearts = eventTotal;
    } else {
      state.totalHearts += hearts;
    }

    state.lastLikeAt = Date.now();
    registerHearts(uniqueId, nickname, profilePicture, hearts);
    broadcast();
  });

  connection.on(WebcastEvent.ROOM_USER, (data) => {
    state.viewerCount = number(
      data?.viewerCount ?? data?.totalUser ?? data?.total,
      state.viewerCount,
    );
    broadcast();
  });

  connection.on('disconnected', () => {
    state.connected = false;
    console.warn('[AVISO] Conexao TikTok encerrada.');
    broadcast();
    scheduleReconnect();
  });

  connection.on('error', (err) => {
    console.error('[ERRO TikTok]', err?.message || err);
  });

  await connect();
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[OK] Overlay rodando na porta ${PORT}`);
  if (DEMO) startDemo();
  else startLive().catch((err) => console.error('[ERRO FATAL]', err));
});
