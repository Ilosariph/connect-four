import { aiMove, COLS, dropRow, emptyBoard, isFull, LEVELS, play, RED, ROWS, winAt, YELLOW } from './connect4.js';

const $ = s => document.querySelector(s);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* storage unavailable */ } },
};
// Per-tab copy of the online seat, so a second tab opening an invite link joins as the other player.
const tabSeat = {
  get() { try { return JSON.parse(sessionStorage.getItem('c4-online')); } catch { return null; } },
  set(v) { try { sessionStorage.setItem('c4-online', JSON.stringify(v)); } catch { /* storage unavailable */ } },
  del() { try { sessionStorage.removeItem('c4-online'); } catch { /* storage unavailable */ } },
};
const esc = s => String(s).replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`);
const LEVEL_NAME = { easy: 'Easy', normal: 'Normal', hard: 'Hard' };
const COLOR = { [RED]: 'red', [YELLOW]: 'yellow' };
const COLOR_NAME = { [RED]: 'Red', [YELLOW]: 'Yellow' };
const AI_DELAY = 550;
const ME = RED; // vs the computer you are always red

// ── Dark mode (defaults to the system setting) ──
const darkToggle = $('#darkToggle');
function applyDark(on) {
  document.documentElement.classList.toggle('dark', on);
  darkToggle.textContent = on ? '☀' : '☾';
}
applyDark(store.get('dark', matchMedia('(prefers-color-scheme: dark)').matches));
darkToggle.addEventListener('click', () => {
  const on = !document.documentElement.classList.contains('dark');
  applyDark(on);
  store.set('dark', on);
});

// ── State ──
const settings = { level: 'normal', name: '', aiStarter: YELLOW, localStarter: YELLOW, ...store.get('c4-settings', {}) };
const saveSettings = () => store.set('c4-settings', settings);

let mode = null; // null = menu, 'ai' | 'local' | 'online'
// Offline games (persisted): { level?, board, moves: [{ r, c, p }], starter, turn, phase: 'play' | 'over', winner, win }
const games = { ai: store.get('c4-game', null), local: store.get('c4-local', null) };
let online = null; // { ws, code, token, intent, state, connected, retry, dropping, quick }
let hoverCol = null; // column under the mouse
let cursor = 3; // keyboard column
let focused = false;
let overDismissed = false;
let confirmAct = null; // action waiting for a second click
let aiTimer = null;

// ── Board DOM ──

const discsEl = $('#discs');
const boardEl = $('#board');
const slots = [];
for (let i = 0; i < ROWS * COLS; i++) {
  const s = document.createElement('div');
  s.className = 'slot';
  discsEl.append(s);
  slots.push(s);
}
let painted = Array(ROWS * COLS).fill(0);

function paintBoard(v) {
  const board = v.board ?? emptyBoard();
  const lastIdx = v.last ? v.last.r * COLS + v.last.c : -1;
  const winIdx = new Set((v.win ?? []).map(([r, c]) => r * COLS + c));
  board.forEach((p, i) => {
    const slot = slots[i];
    if (p !== painted[i]) {
      slot.textContent = '';
      if (p) {
        const d = document.createElement('i');
        d.className = `disc ${COLOR[p]}`;
        if (i === lastIdx) {
          const r = Math.floor(i / COLS);
          d.classList.add('fall');
          d.style.setProperty('--from', `${(r + 1) * -122}%`);
          d.style.setProperty('--t', `${(0.12 + 0.18 * Math.sqrt(r + 1)).toFixed(2)}s`);
        }
        slot.append(d);
      }
    }
    const d = slot.firstChild;
    if (d) {
      d.classList.toggle('last', i === lastIdx);
      d.classList.toggle('win', winIdx.has(i));
    }
  });
  painted = board.slice();
  boardEl.classList.toggle('over', v.phase === 'over' && !!v.win);
  boardEl.classList.toggle('can-drop', !!v.canDrop);

  const col = hoverCol ?? (focused ? cursor : null);
  const preview = $('#preview');
  preview.classList.toggle('show', !!v.canDrop && col != null && dropRow(board, col) >= 0);
  preview.firstChild.className = `disc ${COLOR[v.turn] ?? 'red'}`;
  if (col != null) preview.style.setProperty('--col', col);
}

// ── Shared view model for all modes ──

function vm() {
  if (mode === 'ai' || mode === 'local') {
    const g = games[mode];
    const thinking = mode === 'ai' && g.phase === 'play' && g.turn !== ME;
    const names = mode === 'ai' ? { [RED]: 'You', [YELLOW]: `Computer · ${LEVEL_NAME[g.level]}` } : { [RED]: 'Red', [YELLOW]: 'Yellow' };
    return {
      phase: g.phase,
      board: g.board,
      last: g.moves.at(-1) ?? null,
      win: g.win,
      turn: g.turn,
      canDrop: g.phase === 'play' && !thinking,
      names,
      moves: g.moves.length,
      winner: g.winner, // piece, 0 = draw
      starter: g.starter,
    };
  }
  const s = online.state;
  if (!s) return { phase: 'connecting', board: null, names: { [RED]: '…', [YELLOW]: '…' } };
  const opp = 3 - s.myPiece;
  return {
    phase: s.phase,
    board: s.board,
    last: s.last,
    win: s.win,
    turn: s.phase === 'play' ? (s.myTurn ? s.myPiece : opp) : s.myPiece,
    canDrop: s.myTurn && !online.dropping && !s.closed,
    names: { [s.myPiece]: `${s.me.name} (you)`, [opp]: s.opp ? s.opp.name : 'waiting…' },
    moves: s.moves,
    winner: s.winner === 'draw' ? 0 : s.winner === 'me' ? s.myPiece : s.winner === 'opp' ? opp : null,
    starter: s.iStarted ? s.myPiece : opp,
  };
}

// ── Rendering ──

function render() {
  $('#menu').hidden = !!mode;
  $('#game').hidden = !mode;
  if (!mode) {
    $('#modeBadge').hidden = true;
    renderMenu();
    return;
  }
  const v = vm();
  document.body.dataset.phase = v.phase;
  $('#modeBadge').hidden = false;
  $('#modeBadge').textContent = mode === 'ai' ? `vs Computer · ${LEVEL_NAME[games.ai.level]}` : mode === 'local' ? 'Two players' : 'Online';
  for (const [id, p] of [['#p1', RED], ['#p2', YELLOW]]) {
    $(id).querySelector('span').textContent = v.names[p];
    $(id).classList.toggle('active', v.phase === 'play' && v.turn === p);
  }
  paintBoard(v);
  renderStatus(v);
  renderRoomBar();
  renderActions(v);
  renderModal(v);
}

function renderStatus(v) {
  let text = '';
  const s = mode === 'online' ? online.state : null;
  const name = p => (mode === 'online' && s && p === s.myPiece ? 'You' : v.names[p]);
  if (v.phase === 'connecting') {
    text = online.intent?.t === 'quick' ? 'Looking for an opponent…' : 'Connecting…';
  } else if (v.phase === 'wait') {
    text = online.quick ? 'Looking for an opponent…' : 'Waiting for your opponent. Send them the invite link.';
  } else if (v.phase === 'over') {
    if (v.winner === 0) text = 'Draw: the board is full.';
    else if (mode === 'local') text = `${v.names[v.winner]} wins!`;
    else if (s?.opp?.left && s.winner === 'me') text = `${s.opp.name} left the game. You win!`;
    else if (mode === 'ai' || mode === 'online') {
      const won = mode === 'ai' ? v.winner === ME : s.winner === 'me';
      text = won ? 'You win!' : mode === 'ai' ? 'The computer wins.' : `${s.opp.name} wins.`;
    }
  } else if (mode === 'local') {
    text = `${v.names[v.turn]} to move.`;
  } else if (mode === 'ai') {
    text = v.turn === ME ? (v.moves ? 'Your move.' : 'You go first.') : 'The computer is thinking…';
  } else if (!s.opp?.connected) {
    text = `${s.opp.name} disconnected. Waiting for them to come back…`;
  } else if (s.myTurn) {
    text = v.moves ? 'Your move.' : 'You go first.';
  } else {
    text = v.moves ? `${name(v.turn)} is thinking…` : `${name(v.turn)} goes first.`;
  }
  if (mode === 'online' && !online.connected && v.phase !== 'connecting') text = 'Connection lost. Reconnecting…';
  if (mode === 'online' && !online.connected && v.phase === 'connecting' && online.retry > 0) text = 'Cannot reach the server. Retrying…';
  $('#status').textContent = text;
  $('#status').classList.toggle('alert', v.phase === 'play' && !!v.canDrop && mode !== 'local');
}

function renderRoomBar() {
  const show = mode === 'online' && !!online.code && !online.quick;
  $('#roomBar').hidden = !show;
  if (!show) return;
  $('#roomCode').textContent = online.code;
  const opp = online.state?.opp;
  $('#oppStatus').textContent = !opp ? 'waiting for opponent' : opp.left ? `${opp.name} left` : opp.connected ? `${opp.name} online` : `${opp.name} offline`;
  $('#oppStatus').className = `opp-status ${opp?.connected && !opp.left ? 'on' : ''}`;
  $('#copyLink').hidden = !!opp;
}

function canUndo() {
  const g = games[mode];
  if (!g || g.phase !== 'play') return false;
  return mode === 'local' ? g.moves.length > 0 : g.moves.some(m => m.p === ME);
}

function renderActions(v) {
  const btns = [];
  const add = (act, label, accent = false, disabled = false) => {
    const confirming = confirmAct === act;
    btns.push(`<button data-act="${act}" class="${accent || confirming ? 'btn-accent' : ''}"${disabled ? ' disabled' : ''}>${confirming ? 'Sure? Click again' : label}</button>`);
  };
  const s = online?.state;
  if (mode === 'online' && !online.connected && (v.phase !== 'connecting' || online.retry > 0)) add('reconnect', 'Reconnect', true);
  if (mode === 'ai' || mode === 'local') {
    if (v.phase === 'play') {
      add('undo', 'Undo', false, !canUndo());
      add('resign', mode === 'ai' ? 'Resign' : 'New game');
    } else {
      add('again', 'Play again', true);
      add('menu', 'Menu');
    }
  } else if (v.phase === 'over') {
    if (!s.closed) add('rematch', s.me.rematch ? 'Rematch requested…' : s.opp?.rematch ? 'Accept rematch' : 'Rematch', true, s.me.rematch);
    add('menu', 'Menu');
  } else {
    add('leave', v.phase === 'connecting' ? 'Cancel' : v.phase === 'wait' ? 'Leave room' : 'Leave game');
  }
  $('#actions').innerHTML = btns.join('');
}

function renderModal(v) {
  const show = v.phase === 'over' && !overDismissed;
  $('#overModal').hidden = !show;
  if (!show) return;
  const s = online?.state;
  let title;
  let cls = 'won';
  if (v.winner === 0) {
    title = 'Draw';
    cls = '';
  } else if (mode === 'local') {
    title = `${v.names[v.winner]} wins!`;
  } else {
    const won = mode === 'ai' ? v.winner === ME : s.winner === 'me';
    title = won ? 'You win!' : 'You lose';
    cls = won ? 'won' : 'lost';
  }
  $('#overTitle').textContent = title;
  $('#overTitle').className = `modal-title ${cls}`;
  const lines = [`${v.moves} discs dropped`];
  if (mode === 'ai') lines.push(recordText(games.ai.level));
  else if (mode === 'online' && s.opp?.left) lines.push(`${esc(s.opp.name)} left the game.`);
  else if (mode === 'online' && s.opp?.rematch && !s.me.rematch) lines.push(`${esc(s.opp.name)} wants a rematch.`);
  $('#overSub').innerHTML = lines.join('<br>');
  const closed = mode === 'online' && s.closed;
  $('#againBtn').textContent = mode !== 'online' ? 'Play again' : closed ? 'Menu' : s.me.rematch ? 'Waiting…' : 'Rematch';
  $('#againBtn').disabled = mode === 'online' && !closed && s.me.rematch;
}

function recordText(level) {
  const r = store.get('c4-stats', {})[level];
  if (!r) return `No games vs ${LEVEL_NAME[level]} yet.`;
  return `Record vs ${LEVEL_NAME[level]}: ${r.w}W – ${r.l}L – ${r.d}D${r.best ? ` · fastest win ${r.best} moves` : ''}`;
}

function renderMenu() {
  document.body.dataset.phase = 'menu';
  document.querySelectorAll('#levelSeg button').forEach(b => {
    const on = b.dataset.level === settings.level;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', on);
  });
  if (document.activeElement !== $('#nameInput')) $('#nameInput').value = settings.name;
  $('#record').textContent = recordText(settings.level);
  const resume = [];
  if (games.ai?.phase === 'play') resume.push(`<button class="btn-accent wide" data-resume="ai">Continue vs Computer (${LEVEL_NAME[games.ai.level]})</button>`);
  if (games.local?.phase === 'play') resume.push(`<button class="wide" data-resume="local">Continue two-player game</button>`);
  if (online) resume.push(`<button class="btn-accent wide" data-resume="online">Back to online game${online.code ? ` · ${online.code}` : ''}</button>`);
  else {
    const saved = store.get('c4-online', null);
    if (saved) resume.push(`<button class="wide" data-resume="rejoin">Rejoin room ${esc(saved.code)}</button>`);
  }
  $('#resume').innerHTML = resume.join('');
}

// ── Dropping discs ──

function colAt(x) {
  const rect = discsEl.getBoundingClientRect();
  const c = Math.floor(((x - rect.left) / rect.width) * COLS);
  return Math.min(COLS - 1, Math.max(0, c));
}

boardEl.addEventListener('pointermove', e => {
  if (e.pointerType !== 'mouse') return;
  const c = colAt(e.clientX);
  if (c === hoverCol) return;
  hoverCol = c;
  if (mode) paintBoard(vm());
});
boardEl.addEventListener('pointerleave', () => {
  hoverCol = null;
  if (mode) paintBoard(vm());
});
boardEl.addEventListener('click', e => {
  cursor = colAt(e.clientX);
  drop(cursor);
});
boardEl.addEventListener('focus', () => { focused = boardEl.matches(':focus-visible'); if (mode) paintBoard(vm()); });
boardEl.addEventListener('blur', () => { focused = false; if (mode) paintBoard(vm()); });
boardEl.addEventListener('keydown', e => {
  const move = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
  if (move) {
    e.preventDefault();
    focused = true;
    hoverCol = null;
    cursor = Math.min(COLS - 1, Math.max(0, cursor + move));
    paintBoard(vm());
  } else if (['Enter', ' ', 'ArrowDown'].includes(e.key)) {
    e.preventDefault();
    drop(cursor);
  }
});
document.addEventListener('keydown', e => {
  if (!mode || e.target.closest('input') || e.ctrlKey || e.metaKey || e.altKey) return;
  const n = Number(e.key);
  if (Number.isInteger(n) && n >= 1 && n <= COLS) {
    cursor = n - 1;
    drop(cursor);
  }
});

function drop(c) {
  const v = vm();
  if (!v.canDrop || !v.board || dropRow(v.board, c) < 0) return;
  confirmAct = null;
  if (mode === 'online') {
    online.dropping = true;
    send({ t: 'drop', c });
    render();
    return;
  }
  move(games[mode], c);
  if (mode === 'ai' && games.ai.phase === 'play') scheduleAi();
  render();
}

/** Play column c for whoever's turn it is in an offline game. */
function move(g, c) {
  const p = g.turn;
  const r = play(g.board, c, p);
  if (r < 0) return;
  g.moves.push({ r, c, p });
  g.win = winAt(g.board, r, c);
  if (g.win || isFull(g.board)) finish(g, g.win ? p : 0);
  else g.turn = 3 - p;
  saveGame(g);
}

function undo() {
  const g = games[mode];
  if (!canUndo()) return;
  clearTimeout(aiTimer);
  for (;;) {
    const m = g.moves.pop();
    g.board[m.r * COLS + m.c] = 0;
    g.turn = m.p;
    if (mode === 'local' || m.p === ME) break;
  }
  saveGame(g);
  render();
}

// ── Offline games ──

function saveGame(g) {
  if (g === games.ai) store.set('c4-game', g);
  else if (g === games.local) store.set('c4-local', g);
}

function newGame(kind) {
  clearTimeout(aiTimer);
  // Whoever didn't start last time starts now.
  const key = kind === 'ai' ? 'aiStarter' : 'localStarter';
  settings[key] = 3 - settings[key];
  saveSettings();
  const g = { board: emptyBoard(), moves: [], starter: settings[key], turn: settings[key], phase: 'play', winner: null, win: null };
  if (kind === 'ai') g.level = settings.level;
  games[kind] = g;
  painted = Array(ROWS * COLS).fill(0);
  slots.forEach(s => { s.textContent = ''; });
  mode = kind;
  overDismissed = false;
  saveGame(g);
  if (kind === 'ai' && g.turn !== ME) scheduleAi();
  render();
}

function resume(kind) {
  mode = kind;
  overDismissed = false;
  if (kind === 'ai' && games.ai.phase === 'play' && games.ai.turn !== ME) scheduleAi();
  render();
}

function scheduleAi() {
  clearTimeout(aiTimer);
  aiTimer = setTimeout(computerMove, AI_DELAY);
}

function computerMove() {
  const g = games.ai;
  if (!g || g.phase !== 'play' || g.turn === ME) return;
  move(g, aiMove(g.board, g.turn, g.level));
  if (mode === 'ai') render();
}

function finish(g, winner) {
  g.phase = 'over';
  g.winner = winner;
  overDismissed = false;
  if (g === games.ai) {
    const stats = store.get('c4-stats', {});
    const r = stats[g.level] ?? { w: 0, l: 0, d: 0, best: 0 };
    const mine = g.moves.filter(m => m.p === ME).length;
    if (winner === ME) {
      r.w++;
      r.best = r.best ? Math.min(r.best, mine) : mine;
    } else if (winner) r.l++;
    else r.d++;
    stats[g.level] = r;
    store.set('c4-stats', stats);
  }
  if (winner && (g === games.local || winner === ME)) confetti(winner);
}

// ── Online ──

const wsUrl = () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

function send(msg) {
  if (online?.ws?.readyState === WebSocket.OPEN) online.ws.send(JSON.stringify(msg));
}

function startOnline(intent) {
  if (online) leaveOnline(false);
  online = { ws: null, code: null, token: null, intent, state: null, connected: false, retry: 0, dropping: false, quick: intent.t === 'quick' };
  mode = 'online';
  overDismissed = false;
  $('#onlineErr').hidden = true;
  connect();
  render();
}

function connect() {
  if (!online || (online.ws && online.ws.readyState <= WebSocket.OPEN)) return;
  const ws = new WebSocket(wsUrl());
  online.ws = ws;
  ws.onopen = () => {
    online.connected = true;
    online.retry = 0;
    if (online.code && online.token) send({ t: 'join', code: online.code, token: online.token });
    else if (online.intent) send(online.intent);
    render();
  };
  ws.onmessage = e => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    onServer(m);
  };
  ws.onclose = () => {
    if (!online || online.ws !== ws) return;
    online.ws = null;
    online.connected = false;
    online.dropping = false;
    online.retryTimer = setTimeout(connect, Math.min(8000, 500 * 2 ** online.retry++));
    if (mode === 'online') render();
  };
}

function reconnectNow() {
  if (!online || online.connected) return;
  clearTimeout(online.retryTimer);
  online.retry = 0;
  const ws = online.ws;
  online.ws = null;
  if (ws) { ws.onclose = null; ws.close(); }
  connect();
}

function onServer(m) {
  if (!online) return;
  if (m.t === 'room') {
    online.code = m.code;
    online.token = m.token;
    online.intent = null;
    store.set('c4-online', { code: m.code, token: m.token });
    tabSeat.set({ code: m.code, token: m.token });
    history.replaceState(null, '', `?room=${m.code}`);
  } else if (m.t === 'state') {
    const prev = online.state;
    online.state = m;
    online.dropping = false;
    if (m.phase === 'over' && prev?.phase !== 'over') {
      overDismissed = false;
      if (m.winner === 'me') confetti(m.myPiece);
    }
    if (m.phase !== prev?.phase) confirmAct = null;
  } else if (m.t === 'error') {
    if (m.gone || m.fatal) {
      const msg = m.msg;
      leaveOnline(!m.fatal);
      showOnlineError(msg);
      return;
    }
    toast(m.msg);
  }
  if (mode === 'online') render();
}

function leaveOnline(notify = true) {
  if (!online) return;
  if (notify) send({ t: 'leave' });
  const ws = online.ws;
  online = null;
  ws?.close();
  store.del('c4-online');
  tabSeat.del();
  if (location.search) history.replaceState(null, '', location.pathname);
  if (mode === 'online') mode = null;
}

function showOnlineError(msg) {
  mode = null;
  render();
  $('#onlineErr').textContent = msg;
  $('#onlineErr').hidden = false;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && online && !online.ws) connect();
});

// ── Actions ──

function act(a) {
  const needsConfirm = a === 'resign' || (a === 'leave' && vm().phase === 'play');
  if (needsConfirm && confirmAct !== a && vm().moves > 0) {
    confirmAct = a;
    render();
    return;
  }
  confirmAct = null;
  switch (a) {
    case 'undo': undo(); return;
    case 'reconnect': reconnectNow(); break;
    case 'resign':
      if (mode === 'local') return newGame('local');
      clearTimeout(aiTimer);
      if (games.ai.moves.some(m => m.p === ME)) finish(games.ai, 3 - ME);
      else {
        // Nothing played yet: just drop the game.
        games.ai.phase = 'over';
        mode = null;
      }
      saveGame(games.ai);
      break;
    case 'leave': leaveOnline(); mode = null; break;
    case 'again': newGame(mode); return;
    case 'rematch': send({ t: 'rematch' }); break;
    case 'menu':
      if (mode === 'online' && online?.state?.phase === 'over') leaveOnline();
      mode = null;
      break;
  }
  render();
}

$('#actions').addEventListener('click', e => {
  const b = e.target.closest('button[data-act]');
  if (b) act(b.dataset.act);
});

document.addEventListener('click', e => {
  if (confirmAct && !e.target.closest('#actions')) {
    confirmAct = null;
    if (mode) renderActions(vm());
  }
}, true);

$('#againBtn').addEventListener('click', () => {
  if (mode !== 'online') return newGame(mode);
  if (online.state.closed) return act('menu');
  act('rematch');
});
$('#viewBtn').addEventListener('click', () => { overDismissed = true; render(); });
$('#overModal').addEventListener('click', e => {
  if (e.target === e.currentTarget) { overDismissed = true; render(); }
});

$('#homeBtn').addEventListener('click', () => {
  clearTimeout(aiTimer);
  confirmAct = null;
  mode = null;
  render();
});

// Menu
$('#levelSeg').addEventListener('click', e => {
  const b = e.target.closest('button[data-level]');
  if (!b || !LEVELS.includes(b.dataset.level)) return;
  settings.level = b.dataset.level;
  saveSettings();
  renderMenu();
});
$('#nameInput').addEventListener('input', e => { settings.name = e.target.value.trim().slice(0, 16); saveSettings(); });
$('#aiBtn').addEventListener('click', () => newGame('ai'));
$('#localBtn').addEventListener('click', () => newGame('local'));
$('#createBtn').addEventListener('click', () => startOnline({ t: 'create', name: settings.name }));
$('#quickBtn').addEventListener('click', () => startOnline({ t: 'quick', name: settings.name }));
$('#codeInput').addEventListener('input', e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
$('#joinForm').addEventListener('submit', e => {
  e.preventDefault();
  const code = $('#codeInput').value.trim().toUpperCase();
  if (code.length !== 4) {
    showOnlineError('Room codes have 4 characters.');
    return;
  }
  joinRoom(code);
});
$('#resume').addEventListener('click', e => {
  const b = e.target.closest('button[data-resume]');
  if (!b) return;
  const kind = b.dataset.resume;
  if (kind === 'ai' || kind === 'local') resume(kind);
  else if (kind === 'online') { mode = 'online'; overDismissed = false; render(); }
  else {
    const saved = store.get('c4-online', null);
    if (saved) joinRoom(saved.code, saved);
  }
});

function joinRoom(code, saved = tabSeat.get()) {
  startOnline({ t: 'join', code, name: settings.name });
  if (saved?.code === code) {
    online.code = saved.code;
    online.token = saved.token;
  }
}

$('#copyLink').addEventListener('click', async () => {
  const url = `${location.origin}${location.pathname}?room=${online.code}`;
  try {
    await navigator.clipboard.writeText(url);
    toast('Invite link copied');
  } catch {
    toast(url);
  }
});

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

// ── Confetti ──

function confetti(piece) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const cv = $('#confetti');
  const ctx = cv.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  cv.width = innerWidth * dpr;
  cv.height = innerHeight * dpr;
  ctx.scale(dpr, dpr);
  const css = getComputedStyle(document.documentElement);
  const main = css.getPropertyValue(piece === YELLOW ? '--yellow' : '--red').trim();
  const colors = [main, main, css.getPropertyValue('--frame').trim(), '#ffffff'];
  const parts = Array.from({ length: 140 }, () => ({
    x: innerWidth / 2 + (Math.random() - 0.5) * 120,
    y: innerHeight * 0.35,
    vx: (Math.random() - 0.5) * 14,
    vy: -Math.random() * 13 - 4,
    r: 3 + Math.random() * 4,
    color: colors[Math.floor(Math.random() * colors.length)],
  }));
  const start = performance.now();
  (function frame(t) {
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    for (const p of parts) {
      p.vy += 0.35;
      p.vx *= 0.99;
      p.x += p.vx;
      p.y += p.vy;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
    if (t - start < 3500) requestAnimationFrame(frame);
    else ctx.clearRect(0, 0, innerWidth, innerHeight);
  })(start);
}

// ── Boot ──

const params = new URLSearchParams(location.search);
const roomParam = (params.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
if (roomParam.length === 4) {
  joinRoom(roomParam);
} else {
  render();
}
