const createButton = document.getElementById('create');
const notice = document.getElementById('notice');

function setNotice(message, tone = '') {
  notice.textContent = message;
  notice.className = `notice ${tone}`;
}

createButton.addEventListener('click', async () => {
  if (createButton.disabled) return;
  createButton.disabled = true;
  setNotice('CREATING A SECURE ROOM.', 'warn');
  try {
    const response = await fetch('/api/rooms', {
      method: 'POST',
      credentials: 'same-origin',
    });
    const data = await response.json();
    if (!response.ok || typeof data.hostUrl !== 'string') throw new Error('room unavailable');
    // The bootstrap link is one-time and the next redirect removes it from
    // the visible URL. It is never persisted in local storage or a log.
    location.replace(data.hostUrl);
  } catch {
    createButton.disabled = false;
    setNotice('ROOM COULD NOT BE CREATED. CHECK THE SECURE SERVER, THEN TRY AGAIN.', 'bad');
  }
});
