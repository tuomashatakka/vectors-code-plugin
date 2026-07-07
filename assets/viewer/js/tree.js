// ---- left panel: switcher · search · RESULTS/INTENTS/SOURCES▸DOCS▸CHUNKS/ACTIVITY
// Never imports scene.js — the two sides meet only in state.js/config.js.
import { state, bus, lookup, setProject, selectTree } from './state.js';
import { colorOf, projColor, esc, HOT, UNIT_COLORS } from './config.js';
import { fetchDoc } from './api.js';
import { runSearch } from './search.js';
import { openDoc, loadNode } from './detail.js';

const $=id=>document.getElementById(id);
const escA=s=>esc(s).replace(/"/g,'&quot;');
let PROJECTS=[];                 // from /api/projects
const expanded=new Set();        // srcKey(proj,sid) | 'doc:<docId>'
const docChunks=new Map();       // docId -> chunks[] | 'loading'
// DOM-safe expansion key (the NUL-separated lookup key can't live in an attribute)
const NUL=String.fromCharCode(0); // separator of lookup.bySourceKey keys
const srcKey=(proj,sid)=>'src:'+encodeURIComponent(proj)+'/'+encodeURIComponent(sid);

// ---- header: project switcher + meta + stale chip ---------------------------
function swLabel(){ return '▾ '+(state.project==='*'?'⁂ all projects':(state.project||'choose project')); }
function renderSwitcher(){
  $('sw-btn').textContent=swLabel();
  const L=$('sw-list');
  L.innerHTML=(PROJECTS.length?`<div class="pj" role="option" data-p="*">
      <span class="nm">⁂ all projects</span><span class="st">every index, one mesh</span></div>`:'')
    +(PROJECTS.length?PROJECTS.map(p=>`<div class="pj" role="option" data-p="${escA(p.name)}">
      <span class="nm">${esc(p.name)}</span><span class="st">${p.chunks||0} chunks</span></div>`).join('')
    :'<div class="st" style="padding:8px">no projects — run <b>vectors index</b></div>');
  L.querySelectorAll('.pj').forEach(el=>el.addEventListener('click',()=>{
    closeSwitcher(); setProject(el.getAttribute('data-p')); }));
}
function closeSwitcher(){ $('sw-list').hidden=true; $('sw-btn').setAttribute('aria-expanded','false'); }
function setMeta(s){
  $('meta').innerHTML=`<b>${esc(s.name||'?')}</b>${s.projects!=null?' · '+s.projects+' projects':''}${
    s.documents!=null?' · '+s.documents+' docs':''} · ${s.chunks??0} chunks<br>${
    esc(s.embed_model||'')} · ${esc(s.state||'')}`;
}

// ---- RESULTS -----------------------------------------------------------------
function renderResults(){
  const el=$('sec-results'), h=state.hits;
  if(!h||!h.results||!h.results.length){ el.innerHTML=''; return; }
  // off-graph hits (no _gi) still render — activate() falls back to loadNode
  el.innerHTML=`<div class="sec-h" role="presentation">results <span class="n">${h.n} match${h.n===1?'':'es'}</span></div>`
    +h.results.map(r=>`<div class="ti${r._gi==null?' off':''}" role="treeitem" tabindex="-1" aria-selected="${r._gi!=null&&state.focus===r._gi}"
      data-kind="result" ${r._gi!=null?`data-gi="${r._gi}"`:''} data-id="${escA(r.id)}">
      <span class="dot" style="background:${colorOf(r.unit_type)}"></span>
      <span class="lab"><span class="l1">${esc(r.title||r.source||'')}</span>
      <span class="l2">${esc(r.source||'')}${r.chunk?(' · #'+r.chunk):''}</span></span>
      <span class="sc">${(r.rerank_score??r.score??0).toFixed(2)}</span></div>`).join('');
}

// ---- INTENTS -------------------------------------------------------------------
function relTime(ts){
  const d=(Date.now()-new Date(ts).getTime())/1000;
  if(!(d>=0)) return '';
  if(d<90) return Math.round(d)+'s';
  if(d<5400) return Math.round(d/60)+'m';
  if(d<129600) return Math.round(d/3600)+'h';
  return Math.round(d/86400)+'d';
}
function renderIntents(){
  const el=$('sec-intents'), list=state.intents||[];
  if(!list.length){ el.innerHTML=''; return; }
  el.innerHTML=`<div class="sec-h" role="presentation">intents <span class="n">${list.length}</span></div>`
    +list.map(t=>`<div class="ti" role="treeitem" tabindex="-1" aria-selected="false"
      data-kind="intent" data-q="${escA(t.intent_text||'')}">
      <span class="dot i-${esc(t.outcome||'unknown')}"></span>
      <span class="lab"><span class="l1">${esc(t.intent_text||'')}</span>
      <span class="l2">${t.frequency>1?('×'+t.frequency+' · '):''}${esc(t.outcome||'unknown')} · ${relTime(t.last_seen)}</span></span></div>`).join('');
}

// ---- SOURCES ▸ DOCS ▸ CHUNKS ---------------------------------------------------
function chunkRow(c){
  return `<div class="ti chunk" role="treeitem" tabindex="-1" aria-selected="false"
    data-kind="chunk" data-id="${escA(c.id)}">
    <span class="dot" style="background:${colorOf(c.unit_type)}"></span>
    <span class="lab"><span class="l1">${esc(c.title||('chunk '+c.ordinal))}</span><span class="l2">#${
      c.ordinal} · ${esc(c.unit_type||'text')}${c.token_count!=null?(' · '+c.token_count+' tok'):''}${
      c.embedded?'':' · not embedded'}</span></span></div>`;
}
function docRows(d, projName){
  const key='doc:'+d.id, exp=expanded.has(key);
  const kids=docChunks.get(d.id);
  const inner = !exp ? '' : kids==='loading' ? '<div class="loc">…</div>'
    : kids ? kids.map(chunkRow).join('') : '';
  return `<div class="ti doc" role="treeitem" tabindex="-1" aria-selected="false" aria-expanded="${exp}"
    data-kind="doc" data-key="${key}" data-id="${d.id}">
    <span class="tw">${exp?'▾':'▸'}</span>
    <span class="dot" style="background:${projColor(d.project||projName)}"></span>
    <span class="lab"><span class="l1">${esc(d.rel_path||d.title||d.id)}</span><span class="l2">${
      d.project?esc(d.project)+' · ':''}${esc(d.title||'')}${d.title?' · ':''}${d.chunks} chunks</span></span>
    <span class="op" data-open="${d.id}" title="open full document">⤢</span></div>
    <div role="group" ${exp?'':'hidden'}>${inner}</div>`;
}
function renderData(){
  const el=$('sec-data'), inv=state.inventory;
  if(!inv||!inv.project){ el.innerHTML=''; renderFooter(); return; }
  const P=inv.project, docs=P.docs||[], sources=P.sources||[];
  const S=[`<div class="sec-h" role="presentation">sources <span class="n">${sources.length}</span></div>`];
  const claimed=new Set();
  const srcBlock=(proj, sid, head)=>{
    const key=srcKey(proj, sid), exp=expanded.has(key);
    const mine=docs.filter(d=>(d.project||P.name)===proj&&(d.source_id===sid||sid===''&&!d.source_id));
    mine.forEach(d=>claimed.add(d.id));
    return `<div class="ti src" role="treeitem" tabindex="-1" aria-selected="false" aria-expanded="${exp}"
      data-kind="source" data-key="${escA(key)}" data-proj="${escA(proj)}" data-sid="${escA(sid)}">
      <span class="tw">${exp?'▾':'▸'}</span>
      <span class="dot" style="background:${projColor(proj)}"></span>${head}
      <span class="sc">${mine.length}</span></div>
      <div role="group" ${exp?'':'hidden'}>${exp?mine.map(d=>docRows(d,P.name)).join(''):''}</div>`;
  };
  sources.forEach(s=>{
    const proj=s.project||P.name;
    S.push(srcBlock(proj, s.id||'', `<span class="lab"><span class="l1">${
      s.project?esc(s.project)+' · ':''}${esc(s.id)} · ${esc(s.type)}</span><span class="l2">${
      esc(s.path)}${s.globs&&s.globs.length?(' · '+esc(s.globs.join(' '))):''}</span></span>`));
  });
  // docs whose source config isn't listed still need a home
  const orphans=docs.filter(d=>!claimed.has(d.id));
  const orphanKeys=[...new Set(orphans.map(d=>(d.project||P.name)+NUL+(d.source_id||'')))];
  orphanKeys.forEach(k=>{ const [proj,sid]=k.split(NUL);
    S.push(srcBlock(proj, sid, `<span class="lab"><span class="l1">${
      proj!==P.name?esc(proj)+' · ':''}${esc(sid||'(no source)')}</span><span class="l2">docs</span></span>`)); });
  if(docs.length<P.docs_total)
    S.push(`<button class="more" id="i-more">load more (${docs.length}/${P.docs_total})</button>`);
  el.innerHTML=S.join('');
  const more=$('i-more'); if(more) more.addEventListener('click',e=>{ e.stopPropagation(); bus.emit('inv-more'); });
  renderFooter();
}
function renderFooter(){
  const inv=state.inventory, list=(inv&&inv.global)||[];
  $('tree-foot').innerHTML=list.map(p=>`<div class="ti proj" data-p="${escA(p.name)}">
    <span class="dot" style="background:${p.name===state.project?HOT:UNIT_COLORS.definition}"></span>
    <span class="lab"><span class="l1">${esc(p.name)}</span><span class="l2">${
      p.documents} docs · ${p.chunks} chunks · ${p.embedded} embedded</span></span></div>`).join('');
  $('tree-foot').querySelectorAll('.proj').forEach(el=>
    el.addEventListener('click',()=>setProject(el.getAttribute('data-p'))));
}

// ---- ACTIVITY (SSE feed: newest top, expire ~9s) --------------------------------
function addFeed({html, color}){
  const el=$('sec-activity');
  if(!el.firstChild) el.innerHTML='<div class="sec-h" role="presentation">activity</div>';
  const row=document.createElement('div'); row.className='ev';
  if(color) row.style.borderLeftColor=color;
  row.innerHTML=html;
  el.insertBefore(row, el.children[1]||null);
  requestAnimationFrame(()=>row.classList.add('in'));
  while(el.children.length>6) el.lastChild.remove();
  setTimeout(()=>{ row.classList.add('out'); setTimeout(()=>{ row.remove();
    if(el.children.length<2) el.innerHTML=''; }, 400); }, 9000);
}

// ---- lazy chunk loading -----------------------------------------------------
async function ensureChunks(docId){
  if(docChunks.has(docId)) return;
  docChunks.set(docId,'loading'); renderData();
  try{
    const d=await fetchDoc(docId, state.project, false);
    docChunks.set(docId, d&&!d.error ? d.chunks||[] : []);
  }catch(_){ docChunks.set(docId, []); }
  renderData(); syncSelection('sync');
}

// ---- activation + expansion ---------------------------------------------------
function toggleExpand(el, force){
  const key=el.getAttribute('data-key');
  const on = force!=null ? force : !expanded.has(key);
  if(on) expanded.add(key); else expanded.delete(key);
  if(on&&el.getAttribute('data-kind')==='doc') ensureChunks(el.getAttribute('data-id'));
  renderData();
  const back=$('treebody').querySelector(`[data-key="${CSS.escape(key)}"]`);
  if(back) setRoving(back);
}
function activate(el){
  const kind=el.getAttribute('data-kind');
  if(kind==='result'){ const gi=el.getAttribute('data-gi');
    if(gi!=null) selectTree({level:'chunk', graphIndex:+gi});
    else loadNode(el.getAttribute('data-id')); }
  else if(kind==='intent'){ const q=el.getAttribute('data-q')||'';
    $('q').value=q; runSearch(q); }
  else if(kind==='source'){ toggleExpand(el);
    selectTree({level:'source', key:el.getAttribute('data-proj')+NUL+el.getAttribute('data-sid')}); }
  else if(kind==='doc'){ toggleExpand(el);
    selectTree({level:'doc', id:el.getAttribute('data-id')}); }
  else if(kind==='chunk'){ const id=el.getAttribute('data-id');
    if(lookup.idById[id]!=null) selectTree({level:'chunk', id});
    else loadNode(id); }
}

// ---- ARIA keyboard ------------------------------------------------------------
function items(){ return [...$('treebody').querySelectorAll('[role="treeitem"]')]
  .filter(el=>el.offsetParent!==null); }
function setRoving(el){
  $('treebody').querySelectorAll('[role="treeitem"]').forEach(x=>x.tabIndex=-1);
  el.tabIndex=0; el.focus();
}
function onTreeKey(e){
  const el=document.activeElement;
  if(!el||el.getAttribute('role')!=='treeitem') return;
  const list=items(), i=list.indexOf(el);
  const go=j=>{ if(list[j]) setRoving(list[j]); };
  switch(e.key){
    case 'ArrowDown': e.preventDefault(); go(i+1); break;
    case 'ArrowUp':   e.preventDefault(); go(i-1); break;
    case 'ArrowRight': e.preventDefault();
      if(el.getAttribute('aria-expanded')==='false') toggleExpand(el, true);
      else go(i+1); break;
    case 'ArrowLeft': e.preventDefault();
      if(el.getAttribute('aria-expanded')==='true') toggleExpand(el, false);
      else { const g=el.closest('[role="group"]');
        const parent=g&&g.previousElementSibling;
        if(parent&&parent.getAttribute('role')==='treeitem') setRoving(parent); }
      break;
    case 'Enter': case ' ': e.preventDefault(); activate(el); break;
    case 'Home': e.preventDefault(); go(0); break;
    case 'End':  e.preventDefault(); go(list.length-1); break;
  }
}

// ---- selection sync (expand ancestor path, aria-selected, scroll) --------------
function markSelected(sel){
  const tb=$('treebody');
  tb.querySelectorAll('[aria-selected="true"]').forEach(x=>x.setAttribute('aria-selected','false'));
  if(!sel) return null;
  const row=tb.querySelector(sel);
  if(row){ row.setAttribute('aria-selected','true'); row.tabIndex=0; }
  return row;
}
function syncSelection(origin){
  let row=null;
  if(state.focus>=0&&state.graph){
    const n=state.graph.nodes[state.focus]; if(!n) return;
    expanded.add(srcKey(n.project||'', n.source_id||''));
    if(n.document_id){ expanded.add('doc:'+n.document_id);
      // doc beyond the loaded inventory page: synthesize a row from the node
      const inv=state.inventory;
      if(inv&&inv.project&&!(inv.project.docs||[]).some(d=>d.id===n.document_id))
        (inv.project.docs=inv.project.docs||[]).push({
          id:n.document_id, source_id:n.source_id||'', rel_path:n.source,
          title:n.title, project:n.project, chunks:'…' });
      if(!docChunks.has(n.document_id)){ ensureChunks(n.document_id); return; } }
    renderData(); renderResults(); // results bake aria-selected from state.focus
    row=markSelected(`[data-kind="chunk"][data-id="${CSS.escape(n.id)}"]`)
      ||markSelected(`[data-kind="result"][data-gi="${state.focus}"]`);
  } else if(state.treeSel){
    const s=state.treeSel;
    renderData(); renderResults();
    if(s.level==='doc') row=markSelected(`[data-kind="doc"][data-id="${CSS.escape(s.id)}"]`);
    else if(s.level==='source'){ const [pp='',ss='']=s.key.split(NUL);
      row=markSelected(`[data-key="${CSS.escape(srcKey(pp,ss))}"]`); }
    else if(s.level==='project'){
      const r=$('tree-foot').querySelector(`.proj[data-p="${CSS.escape(s.id)}"]`);
      markSelected(null); if(r){ r.setAttribute('aria-selected','true'); row=r; }
    }
  } else { markSelected(null); renderResults(); return; }
  if(row&&origin!=='tree') row.scrollIntoView({block:'nearest'});
}

// ---- init ----------------------------------------------------------------------
export function initTree(){
  const tb=$('treebody');
  tb.innerHTML='<div id="sec-results"></div><div id="sec-intents"></div>'
    +'<div id="sec-data"></div><div id="sec-activity"></div>';
  tb.addEventListener('click', e=>{
    const op=e.target.closest('.op[data-open]');
    if(op){ e.stopPropagation(); openDoc(op.getAttribute('data-open')); return; }
    const el=e.target.closest('[role="treeitem"]');
    if(el){ setRoving(el); activate(el); }
  });
  tb.addEventListener('keydown', onTreeKey);
  // Tab lands on the tree container; hand focus to the roving/selected item
  tb.tabIndex=0;
  tb.addEventListener('focus', ()=>{
    const it=tb.querySelector('[role="treeitem"][tabindex="0"]')
      ||tb.querySelector('[aria-selected="true"]')||tb.querySelector('[role="treeitem"]');
    if(it) setRoving(it);
  });

  $('sw-btn').addEventListener('click', ()=>{
    const open=$('sw-list').hidden;
    $('sw-list').hidden=!open; $('sw-btn').setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('click', e=>{ if(!e.target.closest('#switcher')) closeSwitcher(); });

  $('go').addEventListener('click', ()=>runSearch($('q').value));
  bus.on('search-busy', b=>$('searchrow').classList.toggle('busy', !!b));

  $('stale').addEventListener('click', ()=>{ state.stale=false; $('stale').hidden=true; bus.emit('reload'); });
  bus.on('stale', ()=>{ $('stale').hidden=false; });

  bus.on('projects', list=>{ PROJECTS=list||[]; renderSwitcher(); });
  bus.on('project', ()=>{ expanded.clear(); docChunks.clear(); renderSwitcher();
    renderResults(); renderIntents(); renderData(); });
  bus.on('status', setMeta);
  bus.on('inventory', renderData);
  bus.on('intents', renderIntents);
  bus.on('search', ()=>renderResults());
  bus.on('selection', ({origin}={})=>syncSelection(origin));
  bus.on('feed', addFeed);
}
