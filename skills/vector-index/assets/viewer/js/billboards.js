// ---- billboards: key descriptor of every highlighted node -------------------
// All text sprites use sizeAttenuation:false with a pixel-derived scale so
// labels hold a constant on-screen size. With attenuation off the on-screen
// NDC height = scale.y * P11 where P11 = 1/tan(fov/2) = 1.9210 for fov 55, so
// pxScale = 2/(1.9210*stageHeightCSSpx) converts a CSS-pixel height to scale.
// The halo stays sizeAttenuation:true — it is a spatial world-unit glow.
// Everything here lives on layer 1: dof.js renders it after the composer.
import * as THREE from 'three';
import { state, bus } from './state.js';
import { view, gfx } from './scene.js';

const P11 = 1/Math.tan(55/2*Math.PI/180); // 1.9210 for fov 55
let pxScale = 2/(P11*800);                // recomputed by onResize
const registry = new Set();               // live sprites, re-scaled on resize

function applyScale(sp){
  const {w,h,screenPx}=sp.userData;
  sp.scale.set(w*(screenPx/h)*pxScale, screenPx*pxScale, 1);
}
export function onResize(stageH){
  if(!stageH) return;
  pxScale = 2/(P11*stageH);
  registry.forEach(sp=>{ if(sp.parent) applyScale(sp); else registry.delete(sp); });
}

// shared canvas-text sprite builder. opts: {fs,pad,screenPx,box}
export function makeTextSprite(text, color, opts){
  const {fs, pad, screenPx, box} = opts;
  const meas=document.createElement('canvas').getContext('2d');
  meas.font='600 '+fs+'px ui-monospace,Menlo,monospace';
  const w=Math.ceil(meas.measureText(text).width)+pad*2, h=fs+pad*2;
  const cvs=document.createElement('canvas'); cvs.width=w*2; cvs.height=h*2;
  const g=cvs.getContext('2d'); g.scale(2,2);
  if(box){
    g.fillStyle='rgba(7,9,12,0.78)'; g.fillRect(0,0,w,h);
    g.strokeStyle='rgba(110,181,232,0.35)'; g.strokeRect(0.5,0.5,w-1,h-1);
  }
  g.font='600 '+fs+'px ui-monospace,Menlo,monospace';
  g.fillStyle=color; g.textBaseline='middle'; g.fillText(text,pad,h/2+(box?1:0));
  const t=new THREE.CanvasTexture(cvs); t.needsUpdate=true;
  const sp=new THREE.Sprite(new THREE.SpriteMaterial(
    {map:t, transparent:true, opacity:0, depthWrite:false,
     depthTest:!box, sizeAttenuation:false}));
  sp.userData={w, h, screenPx};
  sp.layers.set(1); applyScale(sp); registry.add(sp);
  return sp;
}

// project shell label (fs=26 -> h=46, on-screen 26px)
export function labelSprite(text, color){
  const sp=makeTextSprite(text, color, {fs:26, pad:10, screenPx:26, box:false});
  sp.material.opacity=0.5;
  return sp;
}

// descriptor billboard (fs=20/pad=8 -> h=36, 2x supersampled, on-screen 22px)
function billSprite(text){
  const sp=makeTextSprite(text, '#dde1e9', {fs:20, pad:8, screenPx:22, box:true});
  sp.renderOrder=5;
  return sp;
}

export const bills=new Map();
export function descriptor(n){
  let t=(n.title||'').trim();
  if(!t) t=(n.snippet||'').split(/\s+/).slice(0,4).join(' ');
  t=t.split('/').pop()||t;
  return t.length>34 ? t.slice(0,33)+'…' : (t||'·');
}
export function disposeBill(b){
  view.scene.remove(b.sp); registry.delete(b.sp);
  b.sp.material.map.dispose(); b.sp.material.dispose();
}
function disposeBills(){ bills.forEach(disposeBill); bills.clear(); }

// The focused + hovered nodes and every node across their highlighted edges
//  get a descriptor billboard; unwanted ones fade out before removal.
export function updateBillboards(){
  const nodes=gfx.nodes, {focus, hover}=state;
  const want=new Map();
  const mark=(i,v)=>{ if(i==null||i<0||!nodes[i]) return; want.set(i, Math.max(want.get(i)||0, v)); };
  const spread=(i,v)=>{ mark(i,v); (gfx.adjacency[i]||[]).slice(0,10).forEach(j=>mark(j, v*0.8)); };
  if(focus>=0) spread(focus,1);
  if(hover>=0) spread(hover,0.92);
  // sibling chunks of one document share a descriptor — keep only the strongest
  const strongest=new Map();
  want.forEach((v,i)=>{ const key=descriptor(nodes[i]);
    if(!strongest.has(key)||want.get(strongest.get(key))<v) strongest.set(key,i); });
  [...want.keys()].forEach(i=>{ if(strongest.get(descriptor(nodes[i]))!==i) want.delete(i); });
  bills.forEach(b=>{ if(!want.has(b.i)) b.t=0; });
  want.forEach((v,i)=>{
    let b=bills.get(i);
    if(!b){
      const sp=billSprite(descriptor(nodes[i]));
      sp.position.set(nodes[i].p[0], nodes[i].p[1]+0.42, nodes[i].p[2]);
      view.scene.add(sp); b={i, sp, t:0}; bills.set(i,b);
    }
    b.t=v;
  });
}

export function initBillboards(){
  bus.on('graph', disposeBills);
  bus.on('selection', updateBillboards);
  bus.on('hover', updateBillboards);
}
