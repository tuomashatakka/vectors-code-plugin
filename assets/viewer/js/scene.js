// ---- renderer / scene / graph meshes ---------------------------------------
// Owns the WebGL renderer, the Points cloud, base links and the focus/hover
// edge overlays. All visual values written here are TARGETS — frame.js is the
// only module that eases current values toward them.
import * as THREE from 'three';
import { state, bus, lookup } from './state.js';
import { HOT, ACCENT, colorOf } from './config.js';
import { orbit } from './controls.js';

export const view = {
  renderer:null, scene:null, camera:null, halo:null, nodeMat:null,
  pts:null, lines:null, focusLines:null, hoverLines:null,
};

// shared graph-visual state: arrays are style TARGETS, eased in frame.js
export const gfx = {
  nodes:[], adjacency:{}, maxDeg:1,
  sizeT:null, alphaT:null, popV:null, baseCol:null, colT:null,
  lineOpT:0.6, focusOpT:0, hoverOpT:0,
};

const _c = new THREE.Color();
const _white = new THREE.Color('#ffffff');

// soft round glow texture (for the focus halo sprite)
function glowTex(){
  const s=128, cvs=document.createElement('canvas'); cvs.width=cvs.height=s;
  const g=cvs.getContext('2d'); const rg=g.createRadialGradient(s/2,s/2,0,s/2,s/2,s/2);
  rg.addColorStop(0,'rgba(255,255,255,1)'); rg.addColorStop(.25,'rgba(255,255,255,.5)');
  rg.addColorStop(1,'rgba(255,255,255,0)'); g.fillStyle=rg; g.fillRect(0,0,s,s);
  const t=new THREE.CanvasTexture(cvs); t.needsUpdate=true; return t;
}

export function initScene(cv){
  // Deliberate legacy config: reproduce r128's raw-sRGB pipeline (no color
  //  management, no tone mapping, linear output) so the additive-glow balance
  //  of the ported shaders doesn't drift under three 0.178.
  THREE.ColorManagement.enabled = false;
  const renderer = new THREE.WebGLRenderer({canvas:cv, antialias:true, alpha:false});
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x070809, 0.052);
  // near=0.5 (was 0.1) — depth precision for the bokeh depth target
  const camera = new THREE.PerspectiveCamera(55, 1, 0.5, 300);
  camera.layers.enable(1); // layer 1 = halo/billboards/labels overlay

  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map:glowTex(), color:new THREE.Color(HOT), transparent:true, opacity:0,
    blending:THREE.AdditiveBlending, depthWrite:false, depthTest:false }));
  halo.scale.setScalar(0); halo.layers.set(1); scene.add(halo);

  // ---- glow-point shader (per-node size + alpha, round soft disc) ----------
  const nodeMat = new THREE.ShaderMaterial({
    uniforms:{ uPx:{value:Math.min(devicePixelRatio,2)}, uScale:{value:320.0} },
    vertexColors:true, transparent:true, depthWrite:false,
    blending:THREE.AdditiveBlending,
    vertexShader:`
      attribute float aSize; attribute float aAlpha;
      varying vec3 vCol; varying float vA;
      uniform float uPx; uniform float uScale;
      void main(){
        vCol=color; vA=aAlpha;
        vec4 mv=modelViewMatrix*vec4(position,1.0);
        gl_PointSize=aSize*uScale*uPx/max(0.001,-mv.z);
        gl_Position=projectionMatrix*mv;
      }`,
    fragmentShader:`
      varying vec3 vCol; varying float vA;
      void main(){
        vec2 uv=gl_PointCoord-0.5; float d=length(uv);
        if(d>0.5) discard;
        float disc=smoothstep(0.50,0.33,d);
        float core=smoothstep(0.20,0.0,d);
        vec3 col=vCol*(0.78+0.46*core)+core*0.26;
        gl_FragColor=vec4(col, disc*vA);
      }`,
  });

  view.renderer=renderer; view.scene=scene; view.camera=camera;
  view.halo=halo; view.nodeMat=nodeMat;

  bus.on('graph', renderGraph);
  bus.on('selection', onSelection);
  bus.on('hover', onHover);
  bus.on('search', ()=>restyle());
}

function disposeMesh(m){ if(m){ view.scene.remove(m); m.geometry.dispose(); } }

// ---- graph (re)build --------------------------------------------------------
export function renderGraph(g){
  disposeMesh(view.pts); disposeMesh(view.lines);
  disposeMesh(view.focusLines); disposeMesh(view.hoverLines);
  const nodes = gfx.nodes = g.nodes||[];
  gfx.adjacency={}; gfx.lineOpT=0.6; gfx.focusOpT=0; gfx.hoverOpT=0;
  const N=nodes.length;
  const aPos=new Float32Array(N*3), aCol=new Float32Array(N*3);
  const aSize=new Float32Array(N), aAlpha=new Float32Array(N);
  gfx.sizeT=new Float32Array(N); gfx.alphaT=new Float32Array(N);
  gfx.popV=new Float32Array(N); gfx.baseCol=new Float32Array(N*3); gfx.colT=new Float32Array(N*3);
  nodes.forEach((n,i)=>{
    aPos[i*3]=n.p[0]; aPos[i*3+1]=n.p[1]; aPos[i*3+2]=n.p[2];
    _c.set(colorOf(n.unit_type)); _c.toArray(gfx.baseCol,i*3); _c.toArray(aCol,i*3); _c.toArray(gfx.colT,i*3);
    aSize[i]=gfx.sizeT[i]=1.0; aAlpha[i]=gfx.alphaT[i]=0.92;
  });
  const geo=new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(aPos,3));
  geo.setAttribute('color',    new THREE.BufferAttribute(aCol,3));
  geo.setAttribute('aSize',    new THREE.BufferAttribute(aSize,1));
  geo.setAttribute('aAlpha',   new THREE.BufferAttribute(aAlpha,1));
  view.pts=new THREE.Points(geo, view.nodeMat); view.pts.frustumCulled=false; view.scene.add(view.pts);

  // links — vertex colors fade by similarity weight
  const lp=[], lc=[];
  (g.links||[]).forEach(([a,b,w])=>{
    if(a>=N||b>=N) return;
    (gfx.adjacency[a]=gfx.adjacency[a]||[]).push(b); (gfx.adjacency[b]=gfx.adjacency[b]||[]).push(a);
    const wn=Math.max(0.12, Math.min(1,(w||0.4)));
    for(const k of [a,b]){
      lp.push(nodes[k].p[0],nodes[k].p[1],nodes[k].p[2]);
      _c.set(colorOf(nodes[k].unit_type)).multiplyScalar(0.34*wn+0.06);
      lc.push(_c.r,_c.g,_c.b);
    }
  });
  const lgeo=new THREE.BufferGeometry();
  lgeo.setAttribute('position', new THREE.Float32BufferAttribute(lp,3));
  lgeo.setAttribute('color',    new THREE.Float32BufferAttribute(lc,3));
  view.lines=new THREE.LineSegments(lgeo, new THREE.LineBasicMaterial(
    {vertexColors:true, transparent:true, opacity:0.6, depthWrite:false,
     blending:THREE.AdditiveBlending}));
  view.lines.frustumCulled=false; view.scene.add(view.lines);

  // focused/hovered edge overlays — preallocated for the max degree, redrawn on change
  gfx.maxDeg=1; for(const key in gfx.adjacency) gfx.maxDeg=Math.max(gfx.maxDeg, gfx.adjacency[key].length);
  const fgeo=new THREE.BufferGeometry();
  fgeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(gfx.maxDeg*2*3),3));
  fgeo.setDrawRange(0,0);
  view.focusLines=new THREE.LineSegments(fgeo, new THREE.LineBasicMaterial(
    {color:HOT, transparent:true, opacity:0, depthWrite:false,
     blending:THREE.AdditiveBlending}));
  view.focusLines.frustumCulled=false; view.scene.add(view.focusLines);
  const hgeo=new THREE.BufferGeometry();
  hgeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(gfx.maxDeg*2*3),3));
  hgeo.setDrawRange(0,0);
  view.hoverLines=new THREE.LineSegments(hgeo, new THREE.LineBasicMaterial(
    {color:ACCENT, transparent:true, opacity:0, depthWrite:false,
     blending:THREE.AdditiveBlending}));
  view.hoverLines.frustumCulled=false; view.scene.add(view.hoverLines);

  // scope retune: all-projects scope pulls the fog + camera way out
  const ext=nodes.reduce((m,n)=>Math.max(m,Math.abs(n.p[0]),Math.abs(n.p[1]),Math.abs(n.p[2])),1);
  view.scene.fog.density = ext>9 ? 0.016 : 0.052;
  if(ext>9) orbit.rTarget=Math.min(84, ext*2.3);
  orbit.targetGoal.set(...lookup.centroid);
  restyle();
}

// ---- selection/hover plumbing ------------------------------------------------
function onSelection({origin}={}){
  restyle();
  updateHoverEdges();
  if(state.focus>=0 && gfx.nodes[state.focus]){
    // fly the camera to the selected node (port of setFocus)
    orbit.targetGoal.set(...gfx.nodes[state.focus].p);
    orbit.rTarget=Math.min(orbit.rTarget, 11);
  } else if(origin==='clear'){
    orbit.targetGoal.set(...lookup.centroid); // ease back home
  }
}
function onHover(){ updateHoverEdges(); restyle(); }

// tree selections at doc/source/project level light up their member chunks
function resolveSelSet(){
  const s=state.treeSel; if(!s||s.level==='chunk') return null;
  let arr=null;
  if(s.level==='doc') arr=lookup.byDocId.get(s.id);
  else if(s.level==='source') arr=lookup.bySourceKey.get(s.key);
  else if(s.level==='project') arr=lookup.byProject.get(s.id);
  return arr&&arr.length ? new Set(arr) : null;
}

// compute per-node style targets (size/alpha/color) from focus + hover + hits
//  + tree selection; everything here is a TARGET — the frame loop eases slowly
export function restyle(){
  if(!view.pts) return;
  const nodes=gfx.nodes, N=nodes.length;
  const hitSet = state.hits && state.hits.set.size>0 ? state.hits.set : null;
  const hitWeights = hitSet ? state.hits.weights : null;
  const selSet = resolveSelSet();
  const focus=state.focus, hover=state.hover;
  const fnb=focus>=0?new Set(gfx.adjacency[focus]||[]):null;
  const hnb=hover>=0?new Set(gfx.adjacency[hover]||[]):null;
  for(let i=0;i<N;i++){
    let size=1.0, alpha=0.92; _c.fromArray(gfx.baseCol,i*3);
    if(hitSet){
      if(hitSet.has(i)){ const w=hitWeights&&hitWeights.has(i)?hitWeights.get(i):0.7;
        size=1.3+1.3*w; alpha=1.0; _c.lerp(_white,0.10+0.15*w); }
      else { size=0.72; alpha=0.20; _c.multiplyScalar(0.6); }
    }
    if(selSet){
      if(selSet.has(i)){ size=Math.max(size,1.4); alpha=1.0; }
      else { size=Math.min(size,0.72); alpha=Math.min(alpha,0.25); _c.multiplyScalar(0.6); }
    }
    if(fnb&&fnb.has(i)){ size=Math.max(size,1.4); alpha=1.0; }
    if(hnb&&hnb.has(i)){ size=Math.max(size,1.3); alpha=Math.max(alpha,0.95); }
    if(i===hover&&i!==focus){ size=Math.max(size,1.9); alpha=1.0; _c.lerp(_white,0.25); }
    if(i===focus){ size=Math.max(size,2.3); alpha=1.0; _c.set(HOT); }
    _c.toArray(gfx.colT,i*3); gfx.sizeT[i]=size; gfx.alphaT[i]=alpha;
  }
  updateFocusEdges();
}

// highlight the focused node's edges via the overlay mesh; base mesh dims —
//  all through eased opacity targets, never a snap
export function updateFocusEdges(){
  if(!view.focusLines) return;
  const focus=state.focus;
  if(focus<0||!gfx.nodes[focus]){
    gfx.focusOpT=0; gfx.lineOpT = state.hover>=0 ? 0.38 : 0.6;
    return;
  }
  const nb=gfx.adjacency[focus]||[], pos=view.focusLines.geometry.attributes.position.array;
  const fp=gfx.nodes[focus].p;
  nb.forEach((j,m)=>{ const o=m*6, np=gfx.nodes[j].p;
    pos[o]=fp[0]; pos[o+1]=fp[1]; pos[o+2]=fp[2];
    pos[o+3]=np[0]; pos[o+4]=np[1]; pos[o+5]=np[2]; });
  view.focusLines.geometry.setDrawRange(0, nb.length*2);
  view.focusLines.geometry.attributes.position.needsUpdate=true;
  gfx.focusOpT=0.9; gfx.lineOpT=0.14;
}

// hovered node's edges on their own accent overlay
export function updateHoverEdges(){
  if(!view.hoverLines) return;
  const hover=state.hover, focus=state.focus;
  const nb=(hover>=0&&hover!==focus)?(gfx.adjacency[hover]||[]):[];
  if(!nb.length||!gfx.nodes[hover]){ gfx.hoverOpT=0; return; }
  const pos=view.hoverLines.geometry.attributes.position.array, hp=gfx.nodes[hover].p;
  nb.forEach((j,m)=>{ const o=m*6, np=gfx.nodes[j].p;
    pos[o]=hp[0]; pos[o+1]=hp[1]; pos[o+2]=hp[2];
    pos[o+3]=np[0]; pos[o+4]=np[1]; pos[o+5]=np[2]; });
  view.hoverLines.geometry.setDrawRange(0, nb.length*2);
  view.hoverLines.geometry.attributes.position.needsUpdate=true;
  gfx.hoverOpT=0.65;
}
