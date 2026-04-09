'use strict';

const WebSocket = require('ws'); // Ensure you run 'npm install ws'
const config = require('../config');
const { calcScore } = require('../protocol/encoder');

class Leaderboard {
  constructor() {
    this.entries = [];
    this.lastUpdate = 0;
    
    // Initialize the WebSocket server on a specific port from your config
    this.wss = new WebSocket.Server({ port: config.WS_PORT || 8181 });
    
    this.wss.on('connection', (ws) => {
      // Send current leaderboard immediately upon connection
      if (this.entries.length > 0) {
        ws.send(JSON.stringify({ type: 'leaderboard', data: this.entries }));
      }
    });
  }

  /**
   * Broadcasts data to all currently connected and open clients
   */
  broadcast(data) {
    const message = JSON.stringify({ type: 'leaderboard', data });
    this.wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  }

  update(snakes) {
    const now = Date.now();
    if (now - this.lastUpdate < config.LEADERBOARD_INTERVAL) return false;
    this.lastUpdate = now;

    const scored = [];
    for (const snake of snakes) {
      if (!snake.alive || snake.isBot) continue;
      scored.push({
        snakeId: snake.id, // Only send essential ID to save bandwidth
        score: calcScore(snake.sct, snake.fam),
        sct: snake.sct,
        fam: snake.fam,
        cv: snake.skin,
      });
    }

    scored.sort((a, b) => b.score - a.score);
    this.entries = scored.slice(0, config.LEADERBOARD_SIZE);

    // Push the updated leaderboard to all connected users
    this.broadcast(this.entries);
    
    return true;
  }

  getRank(snakeId) {
    for (let i = 0; i < this.entries.length; i++) {
      if (this.entries[i].snakeId === snakeId) return i + 1;
    }
    return this.entries.length + 1;
  }

  getMyPosition(snakeId) {
    for (let i = 0; i < this.entries.length; i++) {
      if (this.entries[i].snakeId === snakeId) return i + 1;
    }
    return 0;
  }
}

module.exports = Leaderboard;
