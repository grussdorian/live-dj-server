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

  urlInput.addEventListener('change', validate);
  urlInput.addEventListener('keyup', (e)=>{ if(e.key==='Enter') validate(); });
  sendButton.addEventListener('click', async ()=>{
    // if no validated track, validate first
    if(!currentTrack) await validate();
    if(!currentTrack) return;
    const r = await api('/api/request',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({uri:currentTrack.uri})});
    if(r.ok){ msg.textContent='Request sent!'; document.querySelector('.topbar a').style.display='inline-block'; currentTrack = null; preview.innerHTML=''; }
    else msg.textContent=r.error||'Failed';
  });

  async function validate(){
    const url = urlInput.value.trim(); if(!url) return;
    preview.innerHTML='Loading...'; actions.innerHTML=''; msg.textContent='';
    const res = await api('/api/validate?url='+encodeURIComponent(url));
    if(!res.ok){ preview.innerHTML=''; msg.textContent=res.error||'Invalid'; currentTrack = null; return }
    const t = res.track;
    currentTrack = t;
    preview.innerHTML = `<div class="track"><div class="thumb" style="background-image:url(${t.albumImage});background-size:cover"></div><div class="meta"><div><strong>${t.title}</strong></div><div class="muted small">${t.artists}</div></div></div>`;
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
