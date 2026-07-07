// ---- boot + shell wiring ------------------------------------------------------
// The only module with top-level side effects.
import { state, bus, setProject, setGraph, clearSelection } from './state.js';
import { UNIT_COLORS, HOT, urlProject } from './config.js';
import { fetchProjects, fetchStatus, fetchGraph, fetchInventory, fetchIntents } from './api.js';
import { initScene, view } from './scene.js';
import { initHierarchy } from './hierarchy.js';
import { initBillboards, onResize as billsResize } from './billboards.js';
import { initControls } from './controls.js';
import { initDof, onResize as dofResize } from './dof.js';
import { startFrameLoop } from './frame.js';
import { initTree } from './tree.js';
import { initDetail, closeDoc, docOpen } from './detail.js';
import { connectEvents } from './sse.js';
import { runSearch } from './search.js';

const $=id=>document.getElementById(id);
const cv=$('c'), stage=$('stage');
const isMobile=()=>matchMedia('(max-width:768px)').matches;

// ---- data loading ---------------------------------------------------------------
const loadStatus   =()=>fetchStatus(state.project).then(s=>bus.emit('status', s)).catch(()=>{});
const loadGraph    =()=>fetchGraph(state.project).then(setGraph).catch(()=>{});
const loadIntents  =()=>fetchIntents(state.project).then(r=>{ state.intents=r.intents||[]; bus.emit('intents'); }).catch(()=>{});
const loadInventory=()=>fetchInventory(state.project).then(r=>{ if(!r.error){ state.inventory=r; bus.emit('inventory'); } }).catch(()=>{});
async function loadMore(){
  const inv=state.inventory; if(!inv) return;
  try{ const r=await fetchInventory(state.project, 200, inv.project.docs.length);
    if(!r.error){ inv.project.docs.push(...r.project.docs); bus.emit('inventory'); } }catch(_){}
}
function loadAll(){ loadStatus(); loadGraph(); loadInventory(); loadIntents(); }

// ---- legend (unit colors + kbd hints + dof chip) ---------------------------------
function buildLegend(){
  $('legend').innerHTML=Object.entries({section:'section',symbol:'symbol',
    definition:'definition',code:'code',text:'text'}).map(([k,l])=>
    `<span class="it"><span class="dot" style="background:${UNIT_COLORS[k]}"></span>${l}</span>`
  ).join('')+`<span class="it"><span class="dot" style="background:${HOT}"></span>selected</span>`
  +`<span class="it">⬡ project</span><span class="it">◇ source</span>`
  +`<span class="it">⌇ document</span><span class="it">• chunk</span>`
  +`<span class="it hint"><kbd>drag</kbd> orbit · <kbd>wheel</kbd> zoom · <kbd>click</kbd> inspect · `
  +`<kbd>↑↓←→</kbd> traverse · <kbd>/</kbd> search · <kbd>esc</kbd> clear</span>`
  +`<span class="it chip" id="dof-chip" title="depth of field">⌁ dof</span>`;
  const chip=$('dof-chip');
  const paint=()=>{ chip.classList.toggle('on', state.dofOn); };
  chip.addEventListener('click', ()=>{ state.dofOn=!state.dofOn; chip.classList.remove('degraded'); paint(); });
  bus.on('dof', ({degraded}={})=>{ if(degraded) chip.classList.add('degraded'); paint(); });
  paint();
}

// ---- divider drag ------------------------------------------------------------------
function initDivider(){
  const dv=$('divider'), root=document.documentElement;
  const saved=+localStorage.getItem('vindex.treeW');
  if(saved) root.style.setProperty('--tree-w', saved+'px');
  dv.addEventListener('pointerdown', e=>{ dv.setPointerCapture(e.pointerId); dv.classList.add('drag'); });
  dv.addEventListener('pointermove', e=>{
    if(!dv.classList.contains('drag')) return;
    const w=Math.max(220, Math.min(480, e.clientX));
    root.style.setProperty('--tree-w', w+'px'); localStorage.setItem('vindex.treeW', w);
  });
  const end=e=>{ dv.classList.remove('drag'); try{dv.releasePointerCapture(e.pointerId)}catch(_){} };
  dv.addEventListener('pointerup', end); dv.addEventListener('pointercancel', end);
  dv.addEventListener('dblclick', ()=>{ root.style.setProperty('--tree-w','300px');
    localStorage.removeItem('vindex.treeW'); });
}

// ---- mobile drawer -------------------------------------------------------------------
function toggleDrawer(force){ document.body.classList.toggle('drawer-open', force); }
$('hamburger').addEventListener('click', ()=>toggleDrawer());
$('scrim').addEventListener('click', ()=>toggleDrawer(false));

// ---- global keyboard --------------------------------------------------------------------
addEventListener('keydown', e=>{
  const q=$('q');
  if(document.activeElement===q){
    if(e.key==='Enter') runSearch(q.value);
    else if(e.key==='Escape') q.blur();
    return;
  }
  if(e.key==='/' && !e.target.closest('input,textarea')){ e.preventDefault(); q.focus(); q.select(); return; }
  if(e.key==='Escape'){ if(docOpen()) closeDoc(); else clearSelection(); return; }
  if((e.key==='d'||e.key==='D') && isMobile() && !e.target.closest('input,textarea')) toggleDrawer();
});

// ---- boot ------------------------------------------------------------------------------
initScene(cv); initHierarchy(); initBillboards(); initControls(cv);
initDof(); initTree(); initDetail(); buildLegend(); initDivider();

new ResizeObserver(()=>{
  resizeView(stage.clientWidth||innerWidth, stage.clientHeight||innerHeight);
}).observe(stage);
function resizeView(w,h){
  view.renderer.setSize(w,h,false);
  view.camera.aspect=w/h; view.camera.updateProjectionMatrix();
  dofResize(w,h); billsResize(h);
}
resizeView(stage.clientWidth||innerWidth, stage.clientHeight||innerHeight);

bus.on('project', name=>{
  const usp=new URLSearchParams(location.search);
  if(name) usp.set('project', name); else usp.delete('project');
  const qs=usp.toString();
  history.replaceState(null,'', qs?('?'+qs):location.pathname);
  if(isMobile()) toggleDrawer(false);
  loadAll();
});
bus.on('reload', ()=>{ loadStatus(); loadGraph(); loadInventory(); });
bus.on('inv-more', loadMore);

startFrameLoop();
(async()=>{
  try{
    const r=await fetchProjects();
    bus.emit('projects', r.projects||[]);
    setProject(urlProject || r.active || '');
  }catch(_){ setProject(urlProject||''); }
  connectEvents();
})();
