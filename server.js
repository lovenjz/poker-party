const express = require('express');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));

// 全局房间存储：roomId -> Room
const rooms = new Map();

const SUITS = ['♠', '♥', '♣', '♦'];
const VALUES = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

function createDeck() {
  const deck = [];
  for (const s of SUITS) {
    for (const v of VALUES) {
      deck.push(`${v}${s}`);
    }
  }
  // 洗牌 Fisher-Yates
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

class Room {
  constructor(id) {
    this.id = id;
    this.players = []; // { id, name, chips, currentBet, cards, folded, ws }
    this.dealerIdx = 0;
    this.currentTurnIdx = 0;
    this.pot = 0;
    this.currentMaxBet = 0;
    this.communityCards = [];
    this.deck = [];
    this.phase = 'WAITING'; // WAITING, PREFLOP, FLOP, TURN, RIVER, SHOWDOWN
    this.smallBlind = 5;
    this.bigBlind = 10;
  }

  startNewHand() {
    if (this.players.length < 2) return;
    this.deck = createDeck();
    this.pot = 0;
    this.communityCards = [];
    this.phase = 'PREFLOP';
    this.currentMaxBet = this.bigBlind;

    this.players.forEach((p) => {
      p.cards = [this.deck.pop(), this.deck.pop()];
      p.folded = false;
      p.currentBet = 0;
    });

    // 扣除小盲和大盲
    const sbIdx = (this.dealerIdx + 1) % this.players.length;
    const bbIdx = (this.dealerIdx + 2) % this.players.length;

    const sbPlayer = this.players[sbIdx];
    const bbPlayer = this.players[bbIdx];

    sbPlayer.chips -= this.smallBlind;
    sbPlayer.currentBet = this.smallBlind;
    this.pot += this.smallBlind;

    bbPlayer.chips -= this.bigBlind;
    bbPlayer.currentBet = this.bigBlind;
    this.pot += this.bigBlind;

    // 翻牌前由大盲左手边第一个人开始
    this.currentTurnIdx = (this.dealerIdx + 3) % this.players.length;
    this.broadcastState();
  }

  nextTurn() {
    const active = this.players.filter(p => !p.folded);
    // 仅剩一人未弃牌直接获胜
    if (active.length === 1) {
      active[0].chips += this.pot;
      this.phase = 'WAITING';
      this.dealerIdx = (this.dealerIdx + 1) % this.players.length;
      this.broadcastState();
      return;
    }

    // 找下一个未弃牌的玩家
    let nextIdx = (this.currentTurnIdx + 1) % this.players.length;
    while (this.players[nextIdx].folded) {
      nextIdx = (nextIdx + 1) % this.players.length;
    }
    this.currentTurnIdx = nextIdx;

    // 检查本轮下注是否都平齐
    const allMatched = this.players
      .filter(p => !p.folded)
      .every(p => p.currentBet === this.currentMaxBet || p.chips === 0);

    if (allMatched) {
      this.advancePhase();
    } else {
      this.broadcastState();
    }
  }

  advancePhase() {
    this.players.forEach(p => (p.currentBet = 0));
    this.currentMaxBet = 0;

    if (this.phase === 'PREFLOP') {
      this.phase = 'FLOP';
      this.communityCards.push(this.deck.pop(), this.deck.pop(), this.deck.pop());
    } else if (this.phase === 'FLOP') {
      this.phase = 'TURN';
      this.communityCards.push(this.deck.pop());
    } else if (this.phase === 'TURN') {
      this.phase = 'RIVER';
      this.communityCards.push(this.deck.pop());
    } else if (this.phase === 'RIVER') {
      this.phase = 'SHOWDOWN';
      const winner = this.players.find(p => !p.folded);
      if (winner) winner.chips += this.pot;
      this.phase = 'WAITING';
      this.dealerIdx = (this.dealerIdx + 1) % this.players.length;
    }

    this.currentTurnIdx = (this.dealerIdx + 1) % this.players.length;
    while (this.players[this.currentTurnIdx].folded) {
      this.currentTurnIdx = (this.currentTurnIdx + 1) % this.players.length;
    }
    this.broadcastState();
  }

  broadcastState() {
    this.players.forEach((p) => {
      if (p.ws.readyState === WebSocket.OPEN) {
        p.ws.send(JSON.stringify({
          type: 'GAME_STATE',
          roomId: this.id,
          phase: this.phase,
          pot: this.pot,
          currentMaxBet: this.currentMaxBet,
          communityCards: this.communityCards,
          currentTurnPlayerId: this.players[this.currentTurnIdx]?.id,
          self: {
            id: p.id,
            name: p.name,
            chips: p.chips,
            cards: p.cards,
            currentBet: p.currentBet,
            isTurn: this.players[this.currentTurnIdx]?.id === p.id
          },
          players: this.players.map(other => ({
            id: other.id,
            name: other.name,
            chips: other.chips,
            currentBet: other.currentBet,
            folded: other.folded,
            cardCount: other.cards.length
          }))
        }));
      }
    });
  }
}

wss.on('connection', (ws) => {
  let userSession = { roomId: null, playerId: null };

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      if (data.type === 'JOIN_ROOM') {
        const { roomId, name } = data;
        let room = rooms.get(roomId);
        if (!room) {
          room = new Room(roomId);
          rooms.set(roomId, room);
        }

        const playerId = 'u_' + Math.random().toString(36).substring(2, 8);
        const player = {
          id: playerId,
          name: name || '玩家',
          chips: 1000,
          currentBet: 0,
          cards: [],
          folded: false,
          ws
        };

        room.players.push(player);
        userSession = { roomId, playerId };
        room.broadcastState();
      }

      if (data.type === 'START_GAME') {
        const room = rooms.get(userSession.roomId);
        if (room) room.startNewHand();
      }

      if (data.type === 'ACTION') {
        const room = rooms.get(userSession.roomId);
        if (!room || room.phase === 'WAITING') return;

        const player = room.players.find(p => p.id === userSession.playerId);
        if (!player || room.players[room.currentTurnIdx].id !== player.id) return;

        const { action, amount } = data;

        if (action === 'fold') {
          player.folded = true;
          room.nextTurn();
        } else if (action === 'call') {
          const needed = room.currentMaxBet - player.currentBet;
          const toPay = Math.min(needed, player.chips);
          player.chips -= toPay;
          player.currentBet += toPay;
          room.pot += toPay;
          room.nextTurn();
        } else if (action === 'raise') {
          const raiseTotal = Number(amount);
          const additional = raiseTotal - player.currentBet;
          if (additional > 0 && player.chips >= additional) {
            player.chips -= additional;
            player.currentBet = raiseTotal;
            room.pot += additional;
            room.currentMaxBet = raiseTotal;
            room.nextTurn();
          }
        }
      }
    } catch (err) {
      console.error('Error handling message:', err);
    }
  });

  ws.on('close', () => {
    if (userSession.roomId) {
      const room = rooms.get(userSession.roomId);
      if (room) {
        room.players = room.players.filter(p => p.id !== userSession.playerId);
        if (room.players.length === 0) {
          rooms.delete(userSession.roomId);
        } else {
          room.broadcastState();
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
