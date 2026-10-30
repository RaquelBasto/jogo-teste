// ============================================================================
// CLIENTE JOGO VIGILÂNCIA E FUGA (1V1)
// ============================================================================

const SUPABASE_URL = 'https://mnldntbbxwszsuebjyif.supabase.co';
const SUPABASE_KEY = 'sb_publishable_nk13l_xSqlmrDSggSrr93Q_FLJES-Ls';
const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// Token de sessão temporário gerado e salvo no navegador
let sessionToken = localStorage.getItem('game_session_token');
if (!sessionToken) {
  sessionToken = 'sess_' + Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
  localStorage.setItem('game_session_token', sessionToken);
}

let currentMatchId = null;
let myPlayer = null;
let opponentPlayer = null;
let matchTimerInterval = null;
let realtimeChannel = null;

// Elementos da DOM
const lobbyScreen = document.getElementById('lobby-screen');
const playScreen = document.getElementById('play-screen');
const endScreen = document.getElementById('end-screen');
const statusBar = document.getElementById('status-bar');

const lobbyStatus = document.getElementById('lobby-status');
const btnJoin = document.getElementById('btn-join');
const btnQuit = document.getElementById('btn-quit');
const btnRestart = document.getElementById('btn-restart');
const btnKill = document.getElementById('btn-kill');

const roleTag = document.getElementById('role-tag');
const matchTimer = document.getElementById('match-timer');
const roomName = document.getElementById('room-name');
const roomDesc = document.getElementById('room-desc');
const doorsContainer = document.getElementById('doors-container');
const alertBanner = document.getElementById('alert-banner');
const alertText = document.getElementById('alert-text');
const encounterActions = document.getElementById('encounter-actions');
const fleeNotice = document.getElementById('flee-notice');

const endTitle = document.getElementById('end-title');
const endDesc = document.getElementById('end-desc');

btnJoin.addEventListener('click', joinOrCreateMatch);
btnQuit.addEventListener('click', quitGame);
btnRestart.addEventListener('click', resetLobby);
btnKill.addEventListener('click', executeKill);

async function joinOrCreateMatch() {
  btnJoin.disabled = true;
  lobbyStatus.innerText = 'Procurando partida disponível...';

  try {
    await ensureDefaultRooms();

    // 1. Procura partida em espera
    const { data: openMatches, error: matchErr } = await supabaseClient
      .from('matches')
      .select('*')
      .eq('status', 'waiting_players')
      .order('created_at', { ascending: true })
      .limit(1);

    if (matchErr) throw matchErr;

    if (openMatches && openMatches.length > 0) {
      // Entra como segundo jogador
      const match = openMatches[0];
      currentMatchId = match.id;
      lobbyStatus.innerText = 'Partida encontrada! Conectando...';

      const { data: players } = await supabaseClient
        .from('match_players')
        .select('*')
        .eq('match_id', currentMatchId);

      const existingRole = players && players.length > 0 ? players[0].role : 'monster';
      const myAssignedRole = existingRole === 'monster' ? 'survivor' : 'monster';

      const { data: rooms } = await supabaseClient.from('rooms').select('id');
      const oppRoom = players && players.length > 0 ? players[0].current_room_id : null;
      const initialRoom = rooms.find(r => r.id !== oppRoom)?.id || rooms[0].id;

      const { data: newPlayer, error: pErr } = await supabaseClient
        .from('match_players')
        .insert({
          match_id: currentMatchId,
          session_token: sessionToken,
          role: myAssignedRole,
          current_room_id: initialRoom
        })
        .select()
        .single();

      if (pErr) throw pErr;
      myPlayer = newPlayer;

      // Inicia a partida
      await supabaseClient
        .from('matches')
        .update({
          status: 'in_progress',
          started_at: new Date().toISOString()
        })
        .eq('id', currentMatchId);

      startGame(match.duration_limit_seconds || 300);
    } else {
      // Primeiro jogador: cria nova partida
      lobbyStatus.innerText = 'Criando partida e aguardando oponente...';

      let matchDuration = 300;
      const { data: cfg } = await supabaseClient
        .from('game_configs')
        .select('value_numeric')
        .eq('key', 'match_duration_seconds')
        .single();
      if (cfg && cfg.value_numeric) matchDuration = cfg.value_numeric;

      const { data: newMatch, error: createErr } = await supabaseClient
        .from('matches')
        .insert({
          status: 'waiting_players',
          duration_limit_seconds: matchDuration
        })
        .select()
        .single();

      if (createErr) throw createErr;
      currentMatchId = newMatch.id;

      const roles = ['monster', 'survivor'];
      const myAssignedRole = roles[Math.floor(Math.random() * roles.length)];

      const { data: rooms } = await supabaseClient.from('rooms').select('id');
      const startRoom = rooms && rooms.length > 0 ? rooms[0].id : null;

      const { data: player, error: pErr } = await supabaseClient
        .from('match_players')
        .insert({
          match_id: currentMatchId,
          session_token: sessionToken,
          role: myAssignedRole,
          current_room_id: startRoom
        })
        .select()
        .single();

      if (pErr) throw pErr;
      myPlayer = player;

      subscribeToRealtime();
    }
  } catch (err) {
    console.error('Erro no matchmaking:', err);
    lobbyStatus.innerText = 'Erro ao conectar. Tente novamente.';
    btnJoin.disabled = false;
  }
}

function startGame(durationSeconds) {
  lobbyScreen.classList.add('hidden');
  endScreen.classList.add('hidden');
  playScreen.classList.remove('hidden');
  statusBar.classList.remove('hidden');

  roleTag.innerText = myPlayer.role === 'monster' ? 'Monstro' : 'Sobrevivente';
  roleTag.className = 'role-tag ' + (myPlayer.role === 'monster' ? 'role-monster' : 'role-survivor');

  startTimer(durationSeconds);
  subscribeToRealtime();
  refreshRoomData();
  refreshOpponentPosition();
}

function startTimer(duration) {
  if (matchTimerInterval) clearInterval(matchTimerInterval);
  let remaining = duration;

  const updateDisplay = () => {
    const mins = Math.floor(remaining / 60);
    const secs = remaining % 60;
    matchTimer.innerText = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  };

  updateDisplay();

  matchTimerInterval = setInterval(async () => {
    remaining--;
    updateDisplay();

    if (remaining <= 0) {
      clearInterval(matchTimerInterval);
      if (myPlayer.role === 'survivor') {
        await finishMatch('survivor', 'time_out');
      }
    }
  }, 1000);
}

async function refreshRoomData() {
  if (!myPlayer || !myPlayer.current_room_id) return;

  const { data: room } = await supabaseClient
    .from('rooms')
    .select('*')
    .eq('id', myPlayer.current_room_id)
    .single();

  if (room) {
    roomName.innerText = room.name;
    roomDesc.innerText = room.description || '';
  }

  // Busca portas conectadas
  const { data: doors } = await supabaseClient
    .from('room_doors')
    .select(`
      id,
      is_open,
      room_to:rooms!room_doors_room_to_id_fkey(id, name),
      room_from:rooms!room_doors_room_from_id_fkey(id, name)
    `)
    .or(`room_from_id.eq.${myPlayer.current_room_id},room_to_id.eq.${myPlayer.current_room_id}`);

  doorsContainer.innerHTML = '';

  if (doors && doors.length > 0) {
    doors.forEach(door => {
      const destination = door.room_from.id === myPlayer.current_room_id ? door.room_to : door.room_from;

      const button = document.createElement('button');
      button.className = 'btn-door';
      button.disabled = !door.is_open;

      button.innerHTML = `
        <span>Ir para: <strong>${destination.name}</strong></span>
        <span class="door-status-badge ${door.is_open ? 'door-open' : 'door-closed'}">
          ${door.is_open ? 'Aberta' : 'Trancada'}
        </span>
      `;

      button.onclick = () => moveToRoom(destination.id);
      doorsContainer.appendChild(button);
    });
  } else {
    doorsContainer.innerHTML = '<p style="color: #64748b;">Nenhuma porta encontrada nesta sala.</p>';
  }

  checkEncounter();
}

async function moveToRoom(targetRoomId) {
  myPlayer.current_room_id = targetRoomId;

  await supabaseClient
    .from('match_players')
    .update({ 
      current_room_id: targetRoomId,
      last_action_at: new Date().toISOString()
    })
    .eq('id', myPlayer.id);

  await supabaseClient.from('match_events').insert({
    match_id: currentMatchId,
    player_id: myPlayer.id,
    event_type: 'move',
    details: `Moveu-se para a sala ID: ${targetRoomId}`
  });

  refreshRoomData();
}

async function refreshOpponentPosition() {
  if (!currentMatchId) return;

  const { data: players } = await supabaseClient
    .from('match_players')
    .select('*')
    .eq('match_id', currentMatchId);

  if (players) {
    const opp = players.find(p => p.id !== myPlayer?.id);
    if (opp) {
      opponentPlayer = opp;
      checkEncounter();
    }
  }
}

function checkEncounter() {
  if (!myPlayer || !opponentPlayer) return;

  const sameRoom = myPlayer.current_room_id === opponentPlayer.current_room_id;

  if (sameRoom) {
    alertBanner.classList.remove('hidden');
    encounterActions.classList.remove('hidden');

    if (myPlayer.role === 'monster') {
      alertText.innerText = 'O SOBREVIVENTE ESTÁ NA MESMA SALA!';
      btnKill.classList.remove('hidden');
      fleeNotice.classList.add('hidden');
    } else {
      alertText.innerText = 'PERIGO! O MONSTRO ESTÁ NA MESMA SALA!';
      btnKill.classList.add('hidden');
      fleeNotice.classList.remove('hidden');
    }
  } else {
    alertBanner.classList.add('hidden');
    encounterActions.classList.add('hidden');
    btnKill.classList.add('hidden');
    fleeNotice.classList.add('hidden');
  }
}

async function executeKill() {
  if (myPlayer.role !== 'monster') return;
  btnKill.disabled = true;

  await supabaseClient.from('match_events').insert({
    match_id: currentMatchId,
    player_id: myPlayer.id,
    event_type: 'kill_attempt',
    details: 'Monstro capturou o sobrevivente.'
  });

  await finishMatch('monster', 'killed');
}

async function finishMatch(winner, reason) {
  if (matchTimerInterval) clearInterval(matchTimerInterval);

  await supabaseClient
    .from('matches')
    .update({
      status: 'finished',
      winner: winner,
      finish_reason: reason,
      ended_at: new Date().toISOString()
    })
    .eq('id', currentMatchId);
}

async function quitGame() {
  if (!confirm('Deseja realmente desistir e encerrar a partida?')) return;

  if (myPlayer) {
    await supabaseClient
      .from('match_players')
      .update({ wants_to_quit: true })
      .eq('id', myPlayer.id);

    const winner = myPlayer.role === 'monster' ? 'survivor' : 'monster';
    await finishMatch(winner, 'surrendered');
  }
}

function showGameOver(winner, reason) {
  if (matchTimerInterval) clearInterval(matchTimerInterval);

  playScreen.classList.add('hidden');
  statusBar.classList.add('hidden');
  endScreen.classList.remove('hidden');

  const won = myPlayer && myPlayer.role === winner;

  if (won) {
    endTitle.innerText = '🏆 VOCÊ VENCEU!';
    endTitle.style.color = '#4ade80';
  } else {
    endTitle.innerText = '💀 VOCÊ PERDEU!';
    endTitle.style.color = '#ef4444';
  }

  if (reason === 'killed') {
    endDesc.innerText = won 
      ? 'Você capturou o sobrevivente com sucesso!' 
      : 'Você foi abatido pelo monstro!';
  } else if (reason === 'time_out') {
    endDesc.innerText = won 
      ? 'Você resistiu e sobreviveu ao tempo limite!' 
      : 'O tempo acabou e o sobrevivente escapou!';
  } else if (reason === 'surrendered') {
    endDesc.innerText = 'Um dos jogadores desistiu da partida.';
  } else {
    endDesc.innerText = 'Partida encerrada.';
  }
}

function resetLobby() {
  if (realtimeChannel) supabaseClient.removeChannel(realtimeChannel);
  currentMatchId = null;
  myPlayer = null;
  opponentPlayer = null;

  endScreen.classList.add('hidden');
  lobbyScreen.classList.remove('hidden');
  btnJoin.disabled = false;
  lobbyStatus.innerText = 'Pronto para buscar partida.';
}

function subscribeToRealtime() {
  if (!currentMatchId) return;

  if (realtimeChannel) {
    supabaseClient.removeChannel(realtimeChannel);
  }

  realtimeChannel = supabaseClient.channel(`match_${currentMatchId}`)
    .on('postgres_changes', {
      event: 'UPDATE',
      schema: 'public',
      table: 'matches',
      filter: `id=eq.${currentMatchId}`
    }, (payload) => {
      const match = payload.new;

      if (match.status === 'in_progress' && playScreen.classList.contains('hidden')) {
        startGame(match.duration_limit_seconds || 300);
      } else if (match.status === 'finished') {
        showGameOver(match.winner, match.finish_reason);
      }
    })
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'match_players',
      filter: `match_id=eq.${currentMatchId}`
    }, (payload) => {
      const updatedPlayer = payload.new;

      if (updatedPlayer.id !== myPlayer?.id) {
        opponentPlayer = updatedPlayer;
        checkEncounter();
      }
    })
    .subscribe();
}

async function ensureDefaultRooms() {
  const { data: existingRooms } = await supabaseClient.from('rooms').select('id').limit(1);

  if (!existingRooms || existingRooms.length === 0) {
    const { data: insertedRooms } = await supabaseClient.from('rooms').insert([
      { name: 'Saguão Principal', description: 'Um salão escuro com ecos distantes.' },
      { name: 'Biblioteca', description: 'Prateleiras altas e livros empoeirados.' },
      { name: 'Laboratório', description: 'Mesas com vidros quebrados e instrumentos estranhos.' },
      { name: 'Porão', description: 'Um local úmido, frio e sem janelas.' }
    ]).select();

    if (insertedRooms && insertedRooms.length >= 4) {
      const [r1, r2, r3, r4] = insertedRooms;
      await supabaseClient.from('room_doors').insert([
        { room_from_id: r1.id, room_to_id: r2.id, is_open: true },
        { room_from_id: r2.id, room_to_id: r3.id, is_open: true },
        { room_from_id: r3.id, room_to_id: r4.id, is_open: true },
        { room_from_id: r4.id, room_to_id: r1.id, is_open: true }
      ]);
    }
  }
}