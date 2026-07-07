// ---- global reactive store -------------------------------------------------
// state is the single mutable snapshot; bus is a synchronous pub/sub; the
// exported action functions below are the ONLY places state is mutated from
// outside this module. Subscribers never emit (loop prevention).
export const state = {
  project:'', graph:null, focus:-1, hover:-1, treeSel:null,
  hits:null, inventory:null, intents:[], stale:false, dofOn:true,
};

// ---- lookup maps, rebuilt whenever the graph changes -----------------------
export const lookup = {
  idById:{},                 // chunk-uuid -> graph index
  byDocId:new Map(),         // document_id -> int[]
  bySourceKey:new Map(),     // project+'\0'+source_id -> int[]
  byProject:new Map(),       // project name -> int[]
  centroid:[0,0,0],
};

// ---- bus --------------------------------------------------------------------
const listeners = {};
export const bus = {
  on(type, fn){ (listeners[type] ??= new Set()).add(fn); return () => listeners[type].delete(fn); },
  emit(type, payload){ (listeners[type] || []).forEach(fn => fn(payload)); },
};

// ---- actions ----------------------------------------------------------------
export function setProject(name){
  state.project = name;
  state.graph = null; state.focus = -1; state.hover = -1;
  state.treeSel = null; state.hits = null;
  bus.emit('project', name);
}

export function setGraph(g){
  state.graph = g;
  const nodes = g.nodes || [];
  const idById = {}, byDocId = new Map(), bySourceKey = new Map(), byProject = new Map();
  const c = [0,0,0];
  nodes.forEach((n,i)=>{
    idById[n.id] = i;
    c[0]+=n.p[0]; c[1]+=n.p[1]; c[2]+=n.p[2];
    if(n.document_id){ const a=byDocId.get(n.document_id)||[]; a.push(i); byDocId.set(n.document_id,a); }
    if(n.project){
      const key = n.project+'\0'+(n.source_id||'');
      const s=bySourceKey.get(key)||[]; s.push(i); bySourceKey.set(key,s);
      const p=byProject.get(n.project)||[]; p.push(i); byProject.set(n.project,p);
    }
  });
  lookup.idById = idById; lookup.byDocId = byDocId;
  lookup.bySourceKey = bySourceKey; lookup.byProject = byProject;
  lookup.centroid = nodes.length ? [c[0]/nodes.length, c[1]/nodes.length, c[2]/nodes.length] : [0,0,0];
  state.focus = -1; state.hover = -1; state.treeSel = null; state.hits = null;
  bus.emit('graph', g);
}

// origins: graph|tree|search|kbd|detail
export function focusNode(i, opts={}){
  if(i==null || i<0 || !state.graph || !state.graph.nodes[i]) return;
  state.focus = i;
  state.treeSel = { level:'chunk', id: state.graph.nodes[i].id };
  bus.emit('selection', { origin: opts.origin || 'graph' });
}

export function hoverNode(i){
  if(i === state.hover) return;
  state.hover = i;
  bus.emit('hover', {});
}

// ref: {level:'chunk', graphIndex?, id?} resolves via focusNode;
// {level:'doc'|'source'|'project', id, ...} just marks the tree selection.
export function selectTree(ref){
  if(ref.level === 'chunk'){
    const i = ref.graphIndex!=null ? ref.graphIndex : lookup.idById[ref.id];
    if(i!=null) focusNode(i, { origin:'tree' });
    return;
  }
  state.treeSel = ref; state.focus = -1;
  bus.emit('selection', { origin:'tree' });
}

// result: {set:Set<int>, weights:Map<int,number>, query:string, topIdx:number}
export function applySearch(result){
  state.hits = result;
  bus.emit('search', result);
  if(result.topIdx>=0) focusNode(result.topIdx, { origin:'search' });
}

export function clearSelection(){
  state.focus = -1; state.treeSel = null; state.hits = null;
  bus.emit('selection', { origin:'clear' });
}
