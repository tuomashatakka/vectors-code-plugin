// ---- unit-type palette (shared JS + CSS) ---------------------------------
export const UNIT_COLORS = {
  section:'#6b96e8', symbol:'#a87fe8', definition:'#6eb5e8',
  code:'#8ec45a', text:'#8899b0', '':'#8899b0',
};
export const HOT = '#e0556a';
export const ACCENT = '#6eb5e8';
export const colorOf = ut => UNIT_COLORS[ut] ?? UNIT_COLORS[''];

// deterministic per-project hue (containers, labels, activity feed)
export function projColor(name){
  let h=0; const s=String(name||'');
  for(let i=0;i<s.length;i++) h=(h*31+s.charCodeAt(i))>>>0;
  return 'hsl('+(h%360)+',52%,60%)';
}

// ---- easing: long, clearly visible state transitions -----------------------
// per-frame exponential coefficients: node/color settle ~1.5-2s, materials ~1s
export const EASE_CAM = 0.12;
export const EASE_NODE = 0.035;
export const EASE_COL = 0.04;
export const EASE_MAT = 0.045;

// ---- text helpers ---------------------------------------------------------
export function esc(s){ return (s||'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
export function tokensOf(q){ return (q||'').toLowerCase().split(/\s+/).filter(t=>t.length>1); }
// highlight `tokens` (from tokensOf) inside escaped text s
export function hl(s, tokens){
  const h=esc(s); if(!tokens||!tokens.length) return h;
  const re=new RegExp('('+tokens.map(t=>t.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|')+')','gi');
  return h.replace(re,'<mark>$1</mark>');
}

// ---- URL params -------------------------------------------------------------
const _params = new URLSearchParams(location.search);
export const urlProject = _params.get('project') || '';
export const urlDof = _params.get('dof');
