const $ = (id) => document.getElementById(id);
const notice = $('notice');
const links = new Map();
const activeInvites = new Set();
const renewConfirmation = new Map();
const roomId = new URLSearchParams(location.search).get('room');
let endConfirmationUntil = 0;

if (!roomId) location.replace('/');

function endpoint(path) {
  return `${path}?room=${encodeURIComponent(roomId)}`;
}

function setIssueLabel(player) {
  const replacesActiveLink = activeInvites.has(player) || links.has(player);
  $(`issue${player}`).textContent = replacesActiveLink ? `RENEW PLAYER ${player} LINK` : `ISSUE PLAYER ${player} LINK`;
}

function setNotice(message, tone = '') {
  notice.textContent = message;
  notice.className = `notice ${tone}`;
}

function setPlayerState(player, state) {
  const card = $(`card${player}`);
  const label = $(`state${player}`);
  card.classList.toggle('streaming', Boolean(state.streaming));
  card.classList.toggle('connected', Boolean(state.connected) && !state.streaming);
  if (state.streaming) {
    label.textContent = 'STREAMING';
    label.className = 'card-state good';
  } else if (state.connected) {
    label.textContent = 'PHONE LINKED';
    label.className = 'card-state warn';
  } else {
    label.textContent = 'NO PHONE CONNECTED';
    label.className = 'card-state';
  }
}

function setInviteOutput(player, link) {
  const output = $(`output${player}`);
  const input = $(`link${player}`);
  const expiry = $(`expiry${player}`);
  if (!link) {
    output.hidden = true;
    input.value = '';
    expiry.textContent = '';
    setIssueLabel(player);
    return;
  }
  output.hidden = false;
  input.value = link.url;
  const seconds = Math.max(0, Math.ceil((link.expiresAt - Date.now()) / 1000));
  if (!seconds) {
    links.delete(player);
    setInviteOutput(player, null);
    return;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = String(seconds % 60).padStart(2, '0');
  expiry.textContent = `LINK EXPIRES IN ${minutes}:${remainder}`;
}

async function refreshSession({ quiet = false } = {}) {
  try {
    const response = await fetch(endpoint('/api/session'), { credentials: 'same-origin', cache: 'no-store' });
    if (response.status === 401) {
      location.replace('/');
      return;
    }
    const session = await response.json();
    if (!response.ok) throw new Error('session unavailable');
    $('roomId').textContent = session.roomId || 'ROOM UNAVAILABLE';
    $('openArena').href = `/game.html?room=${encodeURIComponent(session.roomId)}`;
    for (const player of session.players || []) setPlayerState(player.player, player);
    for (const invite of session.invites || []) {
      if (invite.active) activeInvites.add(invite.player);
      else activeInvites.delete(invite.player);
      setIssueLabel(invite.player);
      if (invite.active && !links.has(invite.player)) {
        const state = $(`state${invite.player}`);
        if (!state.classList.contains('good')) {
          state.textContent = 'ACTIVE LINK. RENEW TO REPLACE.';
          state.className = 'card-state warn';
        }
      }
    }
    if (!quiet) setNotice('ROOM CONSOLE READY.', 'good');
  } catch {
    $('hostLight').className = 'indicator bad';
    $('hostStatus').textContent = 'ROOM CHECK FAILED';
    if (!quiet) setNotice('ROOM STATUS IS NOT AVAILABLE. CHECK THE SECURE SERVER.', 'bad');
  }
}

async function issueLink(player) {
  const button = $(`issue${player}`);
  const replacesActiveLink = activeInvites.has(player) || links.has(player);
  if (replacesActiveLink && Date.now() > (renewConfirmation.get(player) || 0)) {
    renewConfirmation.set(player, Date.now() + 4_000);
    button.textContent = `CONFIRM RENEW PLAYER ${player}`;
    setNotice(`PRESS RENEW AGAIN WITHIN FOUR SECONDS. THE CURRENT PLAYER ${player} LINK WILL STOP WORKING.`, 'warn');
    window.setTimeout(() => {
      if (Date.now() > (renewConfirmation.get(player) || 0)) setIssueLabel(player);
    }, 4_100);
    return;
  }
  renewConfirmation.delete(player);
  button.disabled = true;
  setNotice(`ISSUING PLAYER ${player} LINK.`, 'warn');
  try {
    const response = await fetch(endpoint('/api/invites'), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ player }),
    });
    const invite = await response.json();
    if (!response.ok || typeof invite.joinUrl !== 'string' || !Number.isFinite(invite.expiresAt)) throw new Error('invite unavailable');
    links.set(player, { url: invite.joinUrl, expiresAt: invite.expiresAt });
    activeInvites.add(player);
    setInviteOutput(player, links.get(player));
    setIssueLabel(player);
    setNotice(`PLAYER ${player} LINK IS READY. COPY IT TO THAT PHONE.`, 'good');
    await refreshSession({ quiet: true });
  } catch {
    setNotice(`PLAYER ${player} LINK COULD NOT BE ISSUED. TRY AGAIN.`, 'bad');
  } finally {
    button.disabled = false;
  }
}

async function copyLink(player) {
  const link = links.get(player);
  if (!link) {
    setNotice('ISSUE A NEW LINK BEFORE COPYING.', 'warn');
    return;
  }
  try {
    await navigator.clipboard.writeText(link.url);
    setNotice(`PLAYER ${player} LINK COPIED.`, 'good');
  } catch {
    const input = $(`link${player}`);
    input.focus();
    input.select();
    try {
      document.execCommand('copy');
      setNotice(`PLAYER ${player} LINK COPIED.`, 'good');
    } catch {
      setNotice('COPY IS BLOCKED. SELECT THE LINK AND COPY IT MANUALLY.', 'warn');
    }
  }
}

async function endSession() {
  if (Date.now() > endConfirmationUntil) {
    endConfirmationUntil = Date.now() + 4_000;
    $('end').textContent = 'PRESS AGAIN TO END';
    setNotice('PRESS END SESSION AGAIN WITHIN FOUR SECONDS TO CONFIRM.', 'warn');
    window.setTimeout(() => {
      if (Date.now() > endConfirmationUntil) $('end').textContent = 'END SESSION';
    }, 4_100);
    return;
  }
  $('end').disabled = true;
  try {
    const response = await fetch(endpoint('/api/close'), { method: 'POST', credentials: 'same-origin' });
    if (!response.ok) throw new Error('close failed');
    location.replace('/');
  } catch {
    $('end').disabled = false;
    $('end').textContent = 'END SESSION';
    setNotice('SESSION COULD NOT BE ENDED. CHECK THE SECURE SERVER.', 'bad');
  }
}

for (const player of [1, 2]) {
  $(`issue${player}`).addEventListener('click', () => issueLink(player));
  $(`copy${player}`).addEventListener('click', () => copyLink(player));
}
$('end').addEventListener('click', endSession);

window.setInterval(() => {
  for (const [player, link] of links) setInviteOutput(player, link);
}, 1_000);
window.setInterval(() => refreshSession({ quiet: true }), 3_000);
refreshSession();
