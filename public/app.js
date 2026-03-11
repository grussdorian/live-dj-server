// Shared client JS for index, live, admin
async function api(path, opts){
  const r = await fetch(path, opts);
  return r.json();
}

// Landing page logic
if(document.getElementById('trackUrl')){
  const urlInput = document.getElementById('trackUrl');
  const sendButton = document.getElementById('sendButton');
  const preview = document.getElementById('preview');
  const actions = document.getElementById('actions');
  const msg = document.getElementById('msg');
  let currentTrack = null;

  // sanitize input on Enter (but do not validate on blur/change to avoid accidental preview)
  urlInput.addEventListener('keyup', (e)=>{ if(e.key==='Enter') validate(); });
  // if the user pastes a URL, don't auto-send — require explicit send
  urlInput.addEventListener('paste', ()=>{ suppressAutoSend = true; });
  sendButton.addEventListener('click', async ()=>{ suppressAutoSend = false; await validate(); });

  // helper to sanitize and normalize user input
  function sanitizeInput(v){
    if(!v) return '';
    v = v.trim();
    // remove surrounding <> or quotes
    v = v.replace(/^<|>$/g, '');
    v = v.replace(/^"|"$/g, '');
    v = v.replace(/^'|'$/g, '');
    return v;
  }

  // send current track if validated
  let sending = false;
  let pendingTimer = null;
  let countdownInterval = null;
  const recentlySent = new Map(); // track id -> timestamp (ms) to avoid rapid re-sends
  let suppressAutoSend = false;
  const SEND_COOLDOWN_MS = 10 * 1000;
  async function sendCurrent(){
    if(sending) return;
    // clear pending countdown if user manually sends
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
    if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
    if(!currentTrack) {
      await validate();
      if(!currentTrack) return;
    }
    // client-side dedupe: if recently sent, do not resend
    if (currentTrack && isRecentlySent(currentTrack.id)){
      msg.textContent = 'Already requested recently';
      // clear preview/input to avoid loops
      preview.innerHTML = '';
      if (urlInput) urlInput.value = '';
      currentTrack = null;
      return;
    }
    sending = true;
    sendButton.disabled = true;
    msg.textContent = 'Sending...';
    try{
      const r = await api('/api/request',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({uri:currentTrack.uri})});
      if(r.ok){
        msg.textContent='Sent!';
        const funLink = document.querySelector('.topbar a');
        if(funLink){
          funLink.style.display = 'inline-block';
          funLink.classList.add('fun-link');
          // add glowing sparkles immediately after send
          funLink.classList.add('fun-glow');
          // persist visibility and glow state across navigation
          try{ localStorage.setItem('funVisible','1'); localStorage.setItem('funGlow','1'); }catch(e){}
        }
        // clear preview (album art disappears) after send
        preview.innerHTML = '';
        // clear input to avoid re-validation loop
        if (urlInput) urlInput.value = '';
        // mark as recently sent for 10s
        try{ recentlySent.set(currentTrack.id, Date.now()); }catch(e){}
        currentTrack = null;
      } else {
        msg.textContent = r.error || 'Failed';
      }
    }catch(e){ msg.textContent = e.message || 'Failed'; }
    sending = false;
    sendButton.disabled = false;
  }

  async function validate(){
    // clear any existing pending send
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
    if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }

    const raw = urlInput.value || '';
    const url = sanitizeInput(raw);
    if(!url) return;
    preview.innerHTML='Loading...'; actions.innerHTML=''; msg.textContent='';
    const res = await api('/api/validate?url='+encodeURIComponent(url));
    if(!res.ok){ preview.innerHTML=''; msg.textContent=res.error||'Invalid'; currentTrack = null; return }
    const t = res.track;
    // normalize to spotify:track:ID
    t.uri = t.uri || ('spotify:track:'+t.id);
    currentTrack = t;
    // cleanup old recentlySent entries
    const now = Date.now();
    for (const [k, v] of Array.from(recentlySent.entries())){
      if (now - v > SEND_COOLDOWN_MS) recentlySent.delete(k);
    }
    // if this track was just sent, don't schedule another send
    if (isRecentlySent(currentTrack.id)){
      msg.textContent = 'Already requested recently';
      sendButton.disabled = false;
      return;
    }
    // only show album cover when track found
    preview.innerHTML = `<div class="track"><div class="thumb" style="background-image:url(${t.albumImage});background-size:cover"></div><div class="meta"><div><strong>${t.title}</strong></div><div class="muted small">${t.artists}</div></div></div>`;
    // set a 3s countdown before auto-sending; show simple message and disable send button
    if (!suppressAutoSend) {
      let countdown = 3;
      msg.textContent = 'Sending...';
      sendButton.disabled = true;
      countdownInterval = setInterval(()=>{ countdown -= 1; if (countdown <= 0) { clearInterval(countdownInterval); countdownInterval = null; } }, 1000);
      pendingTimer = setTimeout(async ()=>{
        pendingTimer = null;
        if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
        await sendCurrent();
      }, 3000);
    } else {
      // pasted input: do not auto-send, allow user to click Send; reset flag
      suppressAutoSend = false;
      msg.textContent = '';
      sendButton.disabled = false;
    }
  }

  function isRecentlySent(id){
    if(!id) return false;
    const ts = recentlySent.get(id);
    if(!ts) return false;
    return (Date.now() - ts) <= SEND_COOLDOWN_MS;
  }
}

// minimal socket helper for live/admin pages
if(typeof io !== 'undefined'){
  const socket = io();
  // landing page: request live
  if(document.getElementById('liveList')){
    socket.emit('get_live');
    socket.on('live_update', renderLive);
  }
  // log when admin triggers a full sync (optional)
  socket.on('requests_synced', tracks => {
    console.log('requests synced from Spotify:', tracks);
    // also refresh the requests UI if present
    if(document.getElementById('requests')) socket.emit('get_requests');
  });
  socket.on('live_synced', tracks => {
    console.log('live synced from Spotify:', tracks);
    if(document.getElementById('liveList')) socket.emit('get_live');
  });
  // admin page emits handled inside admin.html
  // helper render for live
  function renderLive(list){
    const container = document.getElementById('liveList');
    if(!container) return;
    container.innerHTML='';
    if(!list || list.length===0){ container.innerHTML='<div class="muted">No songs yet</div>'; return }
    list.forEach(item=>{
      const el = document.createElement('div'); el.className='item';
      el.innerHTML = `<div class="thumb" style="background-image:url(${item.track.albumImage});background-size:cover"></div><div class="meta"><div><strong>${item.track.title}</strong></div><div class="muted small">${item.track.artists}</div></div>`;
      container.appendChild(el);
    })
  }
  // allow other parts of this file to call renderLive if needed
  window._renderLive = renderLive;
}
