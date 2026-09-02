# Overlay de Corações + Ranking — TikTok Live

Um overlay para OBS que conecta na sua live do TikTok em tempo real, conta
os corações (likes) recebidos e mostra um ranking ao vivo de quem mais te
apoiou — para incentivar a galera a competir. Pode rodar no seu PC ou
hospedado de graça na nuvem (nenhum dado passa por servidor de terceiros
além do host que você mesmo escolher).

Como funciona: um servidorzinho Node.js se conecta na live pelo seu
`@usuario` (biblioteca `tiktok-live-connector`, a mesma tecnologia usada
por ferramentas como a Tikfinity) e envia os eventos em tempo real para
uma página HTML que você adiciona como **Browser Source** no OBS.

## 1. Pré-requisitos

- Para rodar no seu PC: [Node.js](https://nodejs.org) versão 18+.
- Para hospedar na nuvem (recomendado): nenhum requisito local, só uma
  conta grátis no GitHub e no Render (passo a passo abaixo).
- Estar **ao vivo no TikTok** no momento de conectar (a biblioteca só lê
  lives que já estão no ar).

## 2. Como usar (escolha uma opção)

### Opção A — Rodar no seu PC

Abra um terminal na pasta do projeto e rode:

```bash
npm install
```

Depois, copie o arquivo de exemplo de configuração:

```bash
cp .env.example .env
```

Abra o `.env` e preencha `TIKTOK_USERNAME` com o seu usuário do TikTok
(sem o @). Exemplo:

```
TIKTOK_USERNAME=meucanal
```

Com a sua live já no ar, rode:

```bash
npm start
```

Se aparecer `[OK] Conectado na live de @seuusuario`, está tudo certo. Se
der erro de conexão, o servidor tenta de novo automaticamente a cada
alguns segundos (o erro mais comum é o usuário ainda não estar ao vivo,
ou estar digitado errado).

No OBS, use `http://localhost:8082/overlay.html?transparent=1` como
Browser Source (veja a seção 4 mais abaixo).

### Opção B — Hospedar de graça na nuvem (recomendado: você não roda nada)

Assim o overlay fica sempre disponível numa URL fixa, e você só abre o
OBS — nada de terminal, nada de "montar servidor" antes de cada live.
Vamos usar o [Render](https://render.com), que tem um plano gratuito
para esse tipo de app. Leva uns 10 minutos, uma vez só.

**Passo 1 — Colocar o código no GitHub** (sem precisar usar terminal)

1. Crie uma conta grátis em [github.com](https://github.com) (se ainda
   não tiver).
2. Clique em **New repository**, dê um nome (ex: `tiktok-hearts-overlay`)
   e deixe como **Public** ou **Private**, tanto faz. Crie o repositório.
3. Na página do repositório, clique em **Add file → Upload files**.
4. Arraste a pasta `tiktok-hearts-overlay` inteira (com `server.js`,
   `public/`, `package.json`, `render.yaml` etc — **não** precisa
   arrastar a pasta `node_modules` se existir) para a área de upload.
5. Clique em **Commit changes**.

**Passo 2 — Criar o serviço no Render**

1. Crie uma conta grátis em [render.com](https://render.com) (dá pra
   entrar direto com sua conta do GitHub).
2. Clique em **New +** → **Blueprint**.
3. Selecione o repositório que você acabou de criar. O Render vai ler o
   arquivo `render.yaml` deste projeto automaticamente e já configurar
   tudo (build, start, health check).
4. Quando pedir as variáveis de ambiente, preencha `TIKTOK_USERNAME`
   com o seu usuário do TikTok (sem @). Deixe `EULER_API_KEY` em branco,
   a não ser que você tenha uma (veja seção 6).
5. Clique em **Apply** / **Create**. Aguarde o deploy (a primeira vez
   demora alguns minutos).
6. Quando terminar, o Render te dá uma URL fixa, algo como:
   `https://tiktok-hearts-overlay.onrender.com`

Pronto — essa URL fica valendo para sempre. Sempre que quiser assistir
ao ranking, é só usar essa URL no OBS (seção 4). Você não precisa mais
rodar nada no seu computador.

**Sobre o plano gratuito do Render:** ele "dorme" depois de ~15 minutos
sem receber requisições, e demora uns 30-60 segundos pra "acordar" na
próxima vez que alguém acessa. Na prática, isso quase não atrapalha:
assim que o OBS abre o Browser Source ele já manda a primeira
requisição e acorda o serviço; e enquanto o overlay fica aberto
recebendo eventos, ele se mantém acordado sozinho. Se quiser garantir
que ele já esteja "quente" antes de começar a live, duas opções
simples:
- Abra a URL do overlay no seu navegador ~1 minuto antes de começar a
  transmitir; ou
- Cadastre a URL `https://SEU-APP.onrender.com/health` num monitor
  gratuito como o [UptimeRobot](https://uptimerobot.com) pra pingar a
  cada 5 minutos e o serviço nunca dormir.

Depois de configurado, atualizar o código no futuro é só subir os
arquivos novos no GitHub (mesmo Passo 1) — o Render republica sozinho.

## 3. Testar sem estar ao vivo

Para ajustar posição e tamanho no OBS antes da live, rode em modo demo
(gera corações e um ranking falsos). Localmente:

```bash
npm run demo
```

No Render, defina a variável de ambiente `DEMO` como `true`
temporariamente no painel do serviço (aba **Environment**) e depois
volte para `false`.

## 4. Adicionar no OBS

1. No OBS, adicione uma fonte **Navegador (Browser Source)**.
2. URL:
   - Se estiver rodando local: `http://localhost:8082/overlay.html?transparent=1`
   - Se hospedou no Render: `https://SEU-APP.onrender.com/overlay.html?transparent=1`
3. Largura: `380`, Altura: `420` (ajuste como quiser).
4. Marque "Atualizar navegador quando a cena ativar" se quiser.

O parâmetro `?transparent=1` deixa o fundo transparente, então o overlay
aparece flutuando sobre o seu jogo/câmera sem caixa preta atrás.

Parâmetros opcionais na URL:

- `?rows=10` — quantas pessoas aparecem no ranking (padrão: 10, máximo
  recomendado: 10). Só aparecem as posições que já têm gente — se só
  uma pessoa mandou corações, só a posição 1 aparece; se três
  mandaram, aparecem as posições 1, 2 e 3, e assim por diante.
- Pode combinar: `?transparent=1&rows=5`

## 5. Sobre estabilidade ("o Tikfinity não funcionava")

A conexão com lives do TikTok não é uma API oficial — todas as
ferramentas (Tikfinity incluso) dependem de engenharia reversa do
serviço interno da TikTok, por isso volta e meia dá instabilidade. Este
projeto:

- Reconecta automaticamente sozinho se cair.
- Roda local, então você pode ver os logs no terminal e entender
  exatamente o que está acontecendo (usuário errado, live offline,
  limite de conexão, etc).
- Se você fizer lives grandes/frequentes e sentir bastante instabilidade,
  dá pra pegar uma chave gratuita em https://www.eulerstream.com e colocar
  em `EULER_API_KEY` no `.env` — isso aumenta o limite de reconexões.

## 6. Zerar o placar

O contador soma enquanto o servidor estiver rodando. Para zerar (por
exemplo, no início de cada live):

- **Rodando local:** pare o servidor com `Ctrl+C` e rode `npm start` de
  novo — ele sempre começa do zero.
- **Hospedado no Render (ou qualquer servidor que fica sempre ligado):**
  abra uma vez, no navegador, a URL do overlay com `&reset=1` no final,
  por exemplo:
  `https://SEU-APP.onrender.com/overlay.html?reset=1` — isso zera o
  contador e o ranking na hora. Depois volte a usar a URL normal (sem
  `reset=1`) no OBS, senão ela zera toda vez que o Browser Source
  recarregar.

## Estrutura do projeto

```
tiktok-hearts-overlay/
├── server.js           # conecta na TikTok e envia dados via websocket
├── public/
│   └── overlay.html    # a página que você usa no Browser Source do OBS
├── package.json
└── .env.example         # copie para .env e configure seu usuário
```
