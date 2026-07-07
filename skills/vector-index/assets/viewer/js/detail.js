// ---- node detail panel + full-document overlay -------------------------------
import { state, bus, lookup, focusNode } from './state.js';
import { colorOf, projColor, esc, hl as hlT, tokensOf } from './config.js';
import { fetchNode, fetchDoc } from './api.js';

const $=id=>document.getElementById(id);
const tokens=()=>tokensOf(state.hits&&state.hits.query);
const hl=s=>hlT(s, tokens());
let renderedFor=null; // avoid a second /api/node fetch after loadNode→focusNode

function kindBadge(ut){
  const col=colorOf(ut);
  return `<span class="badge kind" style="background:${col}">${ut||'text'}</span>`;
}
function row(n){
  const col=colorOf(n.unit_type);
  const sc = n.score!=null ? `<span class="sc">${(n.score).toFixed(2)}</span>` : '';
  const cls = n.self ? 'row self' : 'row';
  const data = n.self ? '' : `data-id="${n.id}"${n.graph_index!=null?` data-gi="${n.graph_index}"`:''}`;
  const l1 = n.chunk!=null && n.self===undefined ? n.title : (n.title||n.source);
  const sub = n.self!==undefined ? `chunk ${n.chunk} · ${n.unit_type||'text'}`
                                 : `${n.source}${n.chunk?(' · #'+n.chunk):''}`;
  return `<div class="${cls}" ${data}>
    <span class="dot" style="background:${col}"></span>
    <span class="lab"><span class="l1">${hl(l1||'')}</span><span class="l2">${esc(sub)}</span></span>
    ${sc}</div>`;
}
function refsHtml(list){
  return `<div class="refs">${list.map(r=>`<div class="ref"><span class="k">${esc(r.kind)}</span>${
    r.kind==='url'?`<a href="${esc(r.uri)}" target="_blank" rel="noopener">${esc(r.uri)}</a>`
                  :`<span class="uri">${esc(r.uri)}</span>`}</div>`).join('')}</div>`;
}

export function renderDetail(d, extra){
  extra=extra||{};
  $('detail').classList.add('show');
  $('d-title').innerHTML=hl(d.title||d.source||'');
  const b=[];
  b.push(kindBadge(d.unit_type));
  if(d.project) b.push(`<span class="badge"><span class="dot" style="background:${
    projColor(d.project)}"></span>${esc(d.project)}</span>`);
  if(d.symbol) b.push(`<span class="badge">◆ ${esc(d.symbol)}</span>`);
  if(d.char_count!=null) b.push(`<span class="badge">${d.char_count} chars</span>`);
  if(extra.rerank_score!=null) b.push(`<span class="badge">rerank ${(+extra.rerank_score).toFixed(2)}</span>`);
  if(extra.signals) b.push(`<span class="badge">${extra.signals.join('+')}</span>`);
  $('d-badges').innerHTML=b.join('');
  const S=[];
  S.push(`<div class="sec"><h2>location</h2>
    <div class="loc"><b>${esc(d.source||'?')}</b> · chunk ${d.chunk??0}${
      d.source_id?(' · src:'+esc(d.source_id)):''}</div></div>`);
  if(d.url) S.push(`<div class="sec"><h2>url</h2><div class="refs"><div class="ref">
    <a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.url)}</a></div></div></div>`);
  if(d.text) S.push(`<div class="sec"><h2>content</h2><pre class="text">${hl(d.text)}</pre></div>`);
  if(d.references&&d.references.length) S.push(`<div class="sec">
    <h2>references <span class="n">${d.references.length}</span></h2>${refsHtml(d.references)}</div>`);
  if(d.relations&&d.relations.length) S.push(`<div class="sec">
    <h2>relations <span class="n">${d.relations.length}</span></h2>${
      d.relations.map(row).join('')}</div>`);
  if(d.document&&d.document.length>1) S.push(`<div class="sec">
    <h2>document <span class="n">${d.document.length} chunks</span>${
      d.document_id?`<span class="open" data-open="${d.document_id}">⤢ open full</span>`:''}</h2>${
      d.document.map(c=>row(Object.assign({}, c))).join('')}</div>`);
  $('d-body').innerHTML=S.join('');
  // wire clickable rows + full-document opener
  $('d-body').querySelectorAll('.row[data-id]').forEach(el=>{
    el.addEventListener('click', ()=>{
      const gi=el.getAttribute('data-gi');
      if(gi!=null) focusNode(+gi, {origin:'detail'}); else loadNode(el.getAttribute('data-id'));
    });
  });
  $('d-body').querySelectorAll('[data-open]').forEach(el=>
    el.addEventListener('click', e=>{ e.stopPropagation(); openDoc(el.getAttribute('data-open')); }));
}

export async function loadNode(id, extra){
  try{
    const d=await fetchNode(id);
    if(d&&!d.error){
      renderedFor=id; renderDetail(d, extra);
      const i=lookup.idById[id]; if(i!=null) focusNode(i, {origin:'detail'});
    }
  }catch(_){}
}

function hideDetail(){ $('detail').classList.remove('show'); renderedFor=null; }

// ---- full document overlay ---------------------------------------------------
export async function openDoc(id){
  if(!id) return;
  try{
    const d=await fetchDoc(id, state.project, true);
    if(!d||d.error) return;
    $('dv-title').textContent=d.rel_path||d.title||d.id;
    $('dv-badges').innerHTML=[
      d.project?`<span class="badge"><span class="dot" style="background:${
        projColor(d.project)}"></span>${esc(d.project)}</span>`:'',
      `<span class="badge">${(d.chunks||[]).length} chunks</span>`,
      `<span class="badge">${(d.content||'').length} chars</span>`].join('');
    const S=[];
    if(d.references&&d.references.length) S.push(`<div class="sec">
      <h2>references <span class="n">${d.references.length}</span></h2>${refsHtml(d.references)}</div>`);
    S.push(`<div class="sec"><h2>content</h2><pre class="full">${hl(d.content||'')}</pre></div>`);
    $('dv-body').innerHTML=S.join('');
    $('docview').classList.add('show');
  }catch(_){}
}
export function closeDoc(){ $('docview').classList.remove('show'); }
export function docOpen(){ return $('docview').classList.contains('show'); }

export function initDetail(){
  $('dv-close').onclick=closeDoc;
  $('docview').addEventListener('click', e=>{ if(e.target===$('docview')) closeDoc(); });
  bus.on('selection', ({origin}={})=>{
    if(state.focus>=0 && state.graph){
      const n=state.graph.nodes[state.focus];
      if(!n) return;
      if(renderedFor===n.id) return; // loadNode already drew this one
      const extra = origin==='search' && state.hits && state.hits.topIdx===state.focus
        ? state.hits.topMeta : undefined;
      renderedFor=n.id;
      fetchNode(n.id).then(d=>{ if(d&&!d.error) renderDetail(d, extra); }).catch(()=>{});
    } else hideDetail();
  });
  bus.on('graph', hideDetail);
}
