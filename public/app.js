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

  // sanitize input on change/enter
  urlInput.addEventListener('change', validate);
  urlInput.addEventListener('keyup', (e)=>{ if(e.key==='Enter') validate(); });
  sendButton.addEventListener('click', async ()=>{ await sendCurrent(); });

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
  async function sendCurrent(){
    if(sending) return;
    // clear pending countdown if user manually sends
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
    if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
    if(!currentTrack) {
      await validate();
      if(!currentTrack) return;
    }
    sending = true;
    sendButton.disabled = true;
    msg.textContent = 'Sending...';
    try{
      const r = await api('/api/request',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({uri:currentTrack.uri})});
      if(r.ok){
        msg.textContent='Request sent!';
        document.querySelector('.topbar a').style.display='inline-block';
        // clear preview (album art disappears) after send
        preview.innerHTML = '';
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
    // only show album cover when track found
    preview.innerHTML = `<div class="track"><div class="thumb" style="background-image:url(${t.albumImage});background-size:cover"></div><div class="meta"><div><strong>${t.title}</strong></div><div class="muted small">${t.artists}</div></div></div>`;
    // set a 3s countdown before auto-sending; show message and disable send button
    let countdown = 3;
    msg.textContent = `Sending in ${countdown}s...`;
    sendButton.disabled = true;
    countdownInterval = setInterval(()=>{
      countdown -= 1;
      if (countdown > 0) msg.textContent = `Sending in ${countdown}s...`;
      else { clearInterval(countdownInterval); countdownInterval = null; }
    }, 1000);
    pendingTimer = setTimeout(async ()=>{
      pendingTimer = null;
      if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
      await sendCurrent();
    }, 3000);
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
