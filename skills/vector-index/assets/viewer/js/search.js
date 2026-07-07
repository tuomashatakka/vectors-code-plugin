// ---- search -----------------------------------------------------------------
import { fetchSearch } from './api.js';
import { state, bus, lookup, applySearch } from './state.js';

export const nowS=()=>performance.now()/1000;
export const popQueue=[];                    // {i, at} — drained by frame.js
export const lastLocalSearch={q:'', t:0};    // for the SSE own-search dedup

// hit → graph index: prefer the server's graph_index, then the id lookup,
// then an attach hint (chunk id of an in-graph neighbour for off-graph hits
// that arrive with a raw p position)
function normalizeHit(h){
  if(typeof h.graph_index==='number') return h.graph_index;
  const i=lookup.idById[h.id]; if(i!=null) return i;
  if(h.attach!=null){
    if(typeof h.attach==='number') return h.attach;
    const j=lookup.idById[h.attach]; if(j!=null) return j;
  }
  return null;
}

export async function runSearch(q){
  q=(q||'').trim(); if(!q) return;
  lastLocalSearch.q=q; lastLocalSearch.t=performance.now();
  bus.emit('search-busy', true);
  try{
    const r=await fetchSearch(q, state.project);
    const res=r.results||[];
    const hits=new Set(), weights=new Map(); let topIdx=-1, topMeta=null;
    // min-max normalize within the result set — score is a rerank logit when
    // reranked, so it can be negative
    const scores=res.map(h=>h.score||0), lo=Math.min(...scores), span=Math.max(...scores)-lo;
    res.forEach(h=>{ const i=normalizeHit(h); h._gi=i; // annotate for the RESULTS tree section
      if(i!=null&&!hits.has(i)){ hits.add(i); weights.set(i, span>0?((h.score||0)-lo)/span:1);
        if(topIdx<0){ topIdx=i; topMeta={rerank_score:h.rerank_score, signals:h.signals}; } } });
    // staggered "pop" animation across the matched nodes (cascade)
    let k=0; hits.forEach(i=>{ popQueue.push({i, at:nowS()+(k++)*0.035}); });
    applySearch({set:hits, weights, query:q, topIdx, topMeta, n:res.length, results:res});
  }catch(_){ /* server hiccup — leave the previous state alone */
  }finally{ bus.emit('search-busy', false); }
}
