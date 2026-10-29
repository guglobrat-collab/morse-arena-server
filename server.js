const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');

const BOT_TOKEN = process.env.BOT_TOKEN || 'YOUR_TELEGRAM_BOT_TOKEN';
const WEBAPP_URL = process.env.WEBAPP_URL || '[https://your-domain.com](https://your-domain.com)';
const PORT = process.env.PORT || 3000;
const PLATFORM_COMMISSION = 0.17; // 17% навар платформы в режиме «Радио-Котёл»

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// 1. Команда /start для запуска Mini App
bot.onText(/\/start(.*)/, (msg, match) => {
  const chatId = msg.chat.id;
  const startParam = (match[1] || '').trim();
  const appUrl = startParam ? `${WEBAPP_URL}?startapp=${startParam}` : WEBAPP_URL;

  bot.sendMessage(chatId, '📡 Добро пожаловать в **Морзе Арену (Morse Arena)**!\nСоревнуйся в эфире 1v1–4v4, забирай банк в «Радио-Котле» и отправляй секретные шифровки друзьям.', {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[
        { text: '🕹️ Войти в Морзе Арену', web_app: { url: appUrl } }
      ]]
    }
  });
});

// 2. API генерации платежной ссылки в Telegram Stars (валюта XTR)
app.post('/api/create-stars-invoice', async (req, res) => {
  try {
    const { title, description, payload, starsAmount } = req.body;
    const invoiceLink = await bot.createInvoiceLink(
      title,
      description,
      payload,
      '', // Для Telegram Stars provider_token всегда пустой
      'XTR',
      [{ label: title, amount: parseInt(starsAmount, 10) }]
    );
    res.json({ ok: true, invoiceLink });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Подтверждение платежей Telegram Stars
bot.on('pre_checkout_query', (query) => {
  bot.answerPreCheckoutQuery(query.id, true);
});

// 3. Мультиплеер и комнаты «Радио-Котла» (до 10 игроков, 17% комиссия)
const potRooms = new Map(); // roomId -> { stake, players: [], started: false }

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    const data = JSON.parse(raw);

    // Вход в комнату Радио-Котла (до 10 человек)
    if (data.type === 'JOIN_POT') {
      const { roomId, userId, username, stake } = data;
      if (!potRooms.has(roomId)) {
        potRooms.set(roomId, { stake, players: [], started: false });
      }
      const room = potRooms.get(roomId);

      if (room.players.length < 10 && !room.started) {
        room.players.push({ userId, username, score: 0, ws });
        const totalPool = room.stake * room.players.length;
        const rake = Math.round(totalPool * PLATFORM_COMMISSION); // 17% навар разработчика
        const netPrize = totalPool - rake;

        // Оповещаем всех участников комнаты о текущем банке
        room.players.forEach(p => {
          p.ws.send(JSON.stringify({
            type: 'POT_STATE',
            playersCount: room.players.length,
            totalPool,
            platformRake: rake,
            netPrize
          }));
        });
      }
    }

    // Обновление очков в реальном времени и проверка победителя
    if (data.type === 'SCORE_UPDATE') {
      const room = potRooms.get(data.roomId);
      if (!room) return;
      const player = room.players.find(p => p.userId === data.userId);
      if (player) {
        player.score = data.score;
        if (player.score >= 1000 && !room.started) {
          room.started = true;
          const totalPool = room.stake * room.players.length;
          const rake = Math.round(totalPool * PLATFORM_COMMISSION); // 17% комиссия
          const netPrize = totalPool - rake;

          room.players.forEach(p => {
            p.ws.send(JSON.stringify({
              type: 'POT_FINISHED',
              winnerId: player.userId,
              winnerName: player.username,
              netPrize,
              platformRake: rake
            }));
          });
          potRooms.delete(data.roomId);
        }
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Morse Arena TMA Server running on port ${PORT}`);
});
