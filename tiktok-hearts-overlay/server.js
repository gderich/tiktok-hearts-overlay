require('dotenv').config();
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { TikTokLiveConnection, WebcastEvent } = require('tiktok-live-connector');

const PORT = process.env.PORT || 8082;
const USERNAME = (process.env.TIKTOK_USERNAME || '').replace('@', '').trim();
const DEMO = String(process.env.DEMO).toLowerCase() === 'true';

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
// usado pelo Render (health check) e por serviços de "keep-alive" para
// evitar que o servidor gratuito hiberne por inatividade
app.get('/health', (req, res) => res.status(200).send('ok'));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// ---------- Estado da live (fica tudo em memoria) ----------
const state = {
  connected: false,
  username: USERNAME,
  totalHearts: 0,
  viewerCount: 0,
  // uniqueId -> { uniqueId, nickname, profilePicture, hearts }
  leaderboard: new Map(),
};

function getRanking(limit = 10) {
  return [...state.leaderboard.values()]
    .sort((a, b) => b.hearts - a.hearts)
    .slice(0, limit);
}

function broadcastState(extra = {}) {
  io.emit('state', {
    connected: state.connected,
    username: state.username,
    totalHearts: state.totalHearts,
    viewerCount: state.viewerCount,
    ranking: getRanking(10),
    ...extra,
  });
}

function registerHearts({ uniqueId, nickname, profilePicture, hearts }) {
  if (!uniqueId) return;
  const current = state.leaderboard.get(uniqueId) || {
    uniqueId,
    nickname: nickname || uniqueId,
    profilePicture: profilePicture || null,
    hearts: 0,
  };
  current.hearts += hearts;
  if (nickname) current.nickname = nickname;
  if (profilePicture) current.profilePicture = profilePicture;
  state.leaderboard.set(uniqueId, current);
}

// Envia o estado atual assim que um cliente (o overlay) se conecta
io.on('connection', (socket) => {
  broadcastState();
  socket.on('reset', () => {
    // permite zerar o placar pelo proprio overlay (ex: no inicio de cada live)
    state.totalHearts = 0;
    state.leaderboard.clear();
    broadcastState();
  });
});

// ---------- Modo demonstracao (sem conectar na TikTok de verdade) ----------
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

// ---------- Conexao real com a TikTok LIVE ----------
async function startLive() {
  if (!USERNAME) {
    console.error(
      '\n[ERRO] Defina TIKTOK_USERNAME no arquivo .env (copie .env.example para .env primeiro).\n'
    );
    process.exit(1);
  }

  const connectionOptions = {};
  if (process.env.EULER_API_KEY) {
    connectionOptions.signApiKey = process.env.EULER_API_KEY;
  }

  const connection = new TikTokLiveConnection(USERNAME, connectionOptions);

  function connect(retryDelayMs = 5000) {
    connection
      .connect()
      .then((connState) => {
        state.connected = true;
        console.log(`[OK] Conectado na live de @${USERNAME} (roomId ${connState.roomId})`);
        broadcastState();
      })
      .catch((err) => {
        state.connected = false;
        console.error(
          `[FALHA] Nao consegui conectar na live de @${USERNAME}: ${err.message}`
        );
        console.error(`Tentando novamente em ${retryDelayMs / 1000}s... (o usuario precisa estar AO VIVO)`);
        broadcastState();
        setTimeout(() => connect(Math.min(retryDelayMs * 1.5, 60000)), retryDelayMs);
      });
  }

  // Coracoes (likes) enviados durante a live
  // Formato real do evento (lib 2.x): { count, total, user: { id, nickname,
  // displayId, avatarThumb: { urlList: [...] } }, ... }
  connection.on(WebcastEvent.LIKE, (data) => {
    const user = data.user || {};
    const uniqueId = user.displayId || user.id;
    const nickname = user.nickname || uniqueId;
    const profilePicture = user.avatarThumb?.urlList?.[0] || null;
    const hearts = data.count || 1;

    // "total" e o total oficial e cumulativo de coracoes da live (string)
    const totalFromEvent = Number(data.total);
    if (!Number.isNaN(totalFromEvent) && totalFromEvent > 0) {
      state.totalHearts = totalFromEvent;
    } else {
      state.totalHearts += hearts;
    }

    registerHearts({ uniqueId, nickname, profilePicture, hearts });
    broadcastState();
  });

  // Contagem de espectadores (bonus, mostrado no overlay)
  connection.on(WebcastEvent.ROOM_USER, (data) => {
    const viewerCount = Number(data.totalUser ?? data.total);
    if (!Number.isNaN(viewerCount)) {
      state.viewerCount = viewerCount;
      broadcastState();
    }
  });

  connection.on('disconnected', () => {
    state.connected = false;
    console.warn('[AVISO] Desconectado da live. Tentando reconectar...');
    broadcastState();
    connect();
  });

  connection.on('error', (err) => {
    console.error('[ERRO connection]', err?.message || err);
  });

  connect();
}

server.listen(PORT, () => {
  console.log(`\nServidor do overlay rodando em http://localhost:${PORT}`);
  console.log(`Adicione esta URL como Browser Source no OBS: http://localhost:${PORT}/overlay.html?transparent=1\n`);

  if (DEMO) {
    startDemo();
  } else {
    startLive();
  }
});
