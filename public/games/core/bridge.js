/**
 * TouchGames PostMessage Bridge v1.0
 *
 * Ponte de comunicacao entre o jogo (iframe) e o app pai (index.html).
 * Incluir em todo jogo: <script src="/games/core/bridge.js"></script>
 *
 * API:
 *   bridge.broadcastMove(move)       — envia jogada ao oponente
 *   bridge.submitResult(result)      — envia resultado final
 *   bridge.updateGameState(state)    — salva estado (retomar depois)
 *   bridge.awardStars(amount,reason) — premia estrelas
 *   bridge.logEvent(name, data)      — analytics
 *   bridge.onOpponentMove = fn       — recebe jogada do oponente
 *   bridge.onOpponentDisconnected    — oponente saiu
 *   bridge.onGameClose               — app fechando o jogo
 */
(function(){
  'use strict';

  var params = new URLSearchParams(window.location.search);

  var bridge = {
    sessionId: params.get('sessionId') || null,
    userId: params.get('userId') || null,
    opponentId: params.get('opponentId') || null,
    gameId: params.get('gameId') || window.location.pathname.split('/').pop().replace('.html',''),
    isReady: false,
    _listeners: {},

    // ── Jogo → Parent ──

    broadcastMove: function(move){
      this._send('game-move',{move:move, sessionId:this.sessionId, timestamp:Date.now()});
    },

    submitResult: function(result){
      this._send('game-result',Object.assign({sessionId:this.sessionId, timestamp:Date.now()}, result));
    },

    updateGameState: function(state){
      this._send('game-state-update',{state:state, sessionId:this.sessionId, timestamp:Date.now()});
    },

    awardStars: function(amount, reason){
      this._send('award-stars',{amount:amount, reason:reason||'game', sessionId:this.sessionId});
    },

    logEvent: function(name, data){
      this._send('log-event',{eventName:name, data:data||{}, timestamp:Date.now()});
    },

    requestClose: function(){
      this._send('game-request-close',{sessionId:this.sessionId});
    },

    // ── Parent → Jogo (override no jogo) ──

    onOpponentMove: function(move){ /* override */ },
    onOpponentDisconnected: function(){ /* override */ },
    onGameClose: function(){ /* override */ },
    onGameStart: function(data){ /* override */ },

    // ── Internos ──

    _send: function(type, data){
      if(window.parent && window.parent !== window){
        window.parent.postMessage({type:type, data:data, source:'touchgame'}, '*');
      }
    },

    _handleMessage: function(event){
      if(event.source !== window.parent) return;
      var msg = event.data;
      if(!msg || !msg.type) return;

      switch(msg.type){
        case 'opponent-move':
          if(bridge.onOpponentMove) bridge.onOpponentMove(msg.data.move);
          break;
        case 'opponent-disconnected':
          if(bridge.onOpponentDisconnected) bridge.onOpponentDisconnected();
          break;
        case 'game-close':
          if(bridge.onGameClose) bridge.onGameClose();
          break;
        case 'game-start':
          if(bridge.onGameStart) bridge.onGameStart(msg.data);
          break;
        case 'response':
          var cb = bridge._listeners[msg.data.callId];
          if(cb){cb(msg.data.response); delete bridge._listeners[msg.data.callId];}
          break;
      }
    },

    _init: function(){
      window.addEventListener('message', this._handleMessage, false);
      this.isReady = true;
      this._send('game-ready',{gameId:this.gameId, sessionId:this.sessionId});
    }
  };

  bridge._init();
  window.touchBridge = bridge;
})();
