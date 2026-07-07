// ---- live activity (SSE over /api/events, fed by pg NOTIFY) -----------------
// Translates server frames into bus traffic: 'feed' rows for the ACTIVITY
// section, 'flash' for project shells, 'stale' for the reload chip, plus pop
// cascades on in-scope remote search hits.
import { eventsURL } from './api.js';
import { state, bus, lookup } from './state.js';
import { esc, projColor } from './config.js';
import { popQueue, lastLocalSearch, nowS } from './search.js';

function showStale(){ state.stale=true; bus.emit('stale', true); }

export function handleEvent(e){
  if(!e||e.type==='hello') return;
  const P=state.project;
  const inScope = P==='*'||!e.project||e.project==='*'||e.project===P;
  const col = e.project&&e.project!=='*' ? projColor(e.project) : null;
  if(e.type==='search'){
    // the viewer's own searches already animate locally — skip the echo
    if(e.query===lastLocalSearch.q && (performance.now()-lastLocalSearch.t)<5000) return;
    bus.emit('feed', {html:`⌕ <b>${esc(e.project||'?')}</b> · ${esc(e.query||'')} · ${(e.hits||[]).length} hits`, color:col});
    if(inScope&&e.hits){ let k=0; e.hits.forEach(h=>{ const i=lookup.idById[h.id];
      if(i!=null) popQueue.push({i, at:nowS()+(k++)*0.05}); }); }
  } else if(e.type==='ingest'){
    bus.emit('feed', {html:`+ <b>${esc(e.project||'?')}</b> · ${esc(e.file||'')} · ${e.chunks||0} chunks`, color:col});
    if(inScope){ bus.emit('flash', e.project); showStale(); }
  } else if(e.type==='ingest_done'&&e.filesChanged>0){
    bus.emit('feed', {html:`✓ <b>${esc(e.project||'?')}</b> · ${e.filesChanged} files · ${e.chunks} chunks indexed`, color:col});
    if(inScope) showStale();
  }
}

export function connectEvents(){
  if(typeof EventSource==='undefined') return;
  const es=new EventSource(eventsURL());
  es.onmessage=m=>{ try{ handleEvent(JSON.parse(m.data)); }catch(_){} };
  // EventSource reconnects on its own; nothing to do on error
}
