// ---- hierarchy visuals: project shells > source hulls > document spines ----
// Content-shaped wraps around clusters, per-source wireframes and per-document
// ordinal polylines. Emphasis values are TARGETS eased in frame.js.
import * as THREE from 'three';
import { state, bus } from './state.js';
import { projColor, ACCENT } from './config.js';
import { view } from './scene.js';
import { labelSprite } from './billboards.js';

export const hier = {
  containers:[], containerByProj:{},
  srcHulls:[], srcHullByKey:{},
  spineBase:null, docEmphLines:null, docSegs:{}, docOf:[],
  docEmphT:0,
};

const _white = new THREE.Color('#ffffff');
const _c = new THREE.Color();
const nodes = () => (state.graph && state.graph.nodes) || [];

export function initHierarchy(){
  bus.on('graph', rebuild);
  bus.on('selection', onChange);
  bus.on('hover', onChange);
  bus.on('flash', flashProject);
}
function rebuild(){ buildContainers(); buildSourceHulls(); buildDocSpines(); onChange(); }
function onChange(){ updateDocEmph(); parentEmphasis(); }

// Content-shaped wrap: a subdivided icosahedron whose vertices are pushed out
//  along the cluster's support function (max projection of the points on each
//  vertex direction) — i.e. a soft convex hull of the digested content.
export function blobGeometry(idxList, pad, detail){
  const ns=nodes(), c=[0,0,0];
  idxList.forEach(i=>{ c[0]+=ns[i].p[0]; c[1]+=ns[i].p[1]; c[2]+=ns[i].p[2]; });
  c[0]/=idxList.length; c[1]/=idxList.length; c[2]/=idxList.length;
  const geo=new THREE.IcosahedronGeometry(1, detail);
  const pos=geo.attributes.position, v=new THREE.Vector3();
  for(let vi=0; vi<pos.count; vi++){
    v.set(pos.getX(vi), pos.getY(vi), pos.getZ(vi)).normalize();
    let r=0;
    for(const i of idxList){ const p=ns[i].p;
      const d=(p[0]-c[0])*v.x+(p[1]-c[1])*v.y+(p[2]-c[2])*v.z;
      if(d>r) r=d; }
    r=Math.max(r,0.55)+pad;
    pos.setXYZ(vi, v.x*r, v.y*r, v.z*r);
  }
  geo.computeVertexNormals();
  return {geo, c};
}

function disposeContainers(){
  hier.containers.forEach(c=>{
    view.scene.remove(c.mesh); view.scene.remove(c.wire); view.scene.remove(c.label);
    c.mesh.geometry.dispose(); c.mesh.material.dispose();
    c.wire.geometry.dispose(); c.wire.material.dispose();
    c.label.material.map.dispose(); c.label.material.dispose();
  });
  hier.containers=[]; hier.containerByProj={};
}
// Level 1 of the hierarchy: one content-shaped shell + wireframe + label per
//  project cluster; only drawn when the graph spans more than one project.
//  Materials start at opacity 0 and ease in via the frame loop.
export function buildContainers(){
  disposeContainers();
  const groups={};
  nodes().forEach((n,i)=>{ if(n.project) (groups[n.project]=groups[n.project]||[]).push(i); });
  const names=Object.keys(groups);
  if(names.length<2) return;
  names.forEach(name=>{
    const idx=groups[name];
    const col=new THREE.Color(projColor(name));
    const fill=blobGeometry(idx, 0.85, 2), wireB=blobGeometry(idx, 0.9, 1);
    const mesh=new THREE.Mesh(fill.geo,
      new THREE.MeshBasicMaterial({color:col, transparent:true, opacity:0,
        side:THREE.BackSide, depthWrite:false}));
    const wire=new THREE.Mesh(wireB.geo,
      new THREE.MeshBasicMaterial({color:col, wireframe:true, transparent:true,
        opacity:0, depthWrite:false, blending:THREE.AdditiveBlending}));
    mesh.position.set(...fill.c); wire.position.set(...wireB.c);
    fill.geo.computeBoundingBox();
    const label=labelSprite(name, projColor(name));
    label.material.opacity=0;
    label.position.set(fill.c[0], fill.c[1]+fill.geo.boundingBox.max.y+0.9, fill.c[2]);
    view.scene.add(mesh); view.scene.add(wire); view.scene.add(label);
    const entry={name, mesh, wire, label, flash:0, emph:0};
    hier.containers.push(entry); hier.containerByProj[name]=entry;
  });
}
export function flashProject(name){ const c=hier.containerByProj[name]; if(c) c.flash=1; }

// Level 2: a faint content-shaped wireframe per ingest source within a project.
function disposeSourceHulls(){
  hier.srcHulls.forEach(h=>{ view.scene.remove(h.mesh); h.mesh.geometry.dispose(); h.mesh.material.dispose(); });
  hier.srcHulls=[]; hier.srcHullByKey={};
}
export function buildSourceHulls(){
  disposeSourceHulls();
  const groups={}, perProj={};
  nodes().forEach((n,i)=>{ if(!n.project) return;
    const key=n.project+'\u0000'+(n.source_id||'');
    (groups[key]=groups[key]||[]).push(i);
    (perProj[n.project]=perProj[n.project]||new Set()).add(n.source_id||''); });
  Object.keys(groups).forEach(key=>{
    const idx=groups[key]; if(idx.length<3) return;
    const proj=key.split('\u0000')[0];
    if(hier.containerByProj[proj] && perProj[proj].size<2) return; // shell already tells the story
    const col=new THREE.Color(projColor(proj)).lerp(_white, 0.25);
    const b=blobGeometry(idx, 0.4, 1);
    const mesh=new THREE.Mesh(b.geo,
      new THREE.MeshBasicMaterial({color:col, wireframe:true, transparent:true,
        opacity:0, depthWrite:false, blending:THREE.AdditiveBlending}));
    mesh.position.set(...b.c); view.scene.add(mesh);
    const entry={key, mesh, emph:0};
    hier.srcHulls.push(entry); hier.srcHullByKey[key]=entry;
  });
}

// Level 3: document spines — ordinal-ordered polylines through each document's
//  sampled chunks, plus a bright overlay for the focused/hovered document.
function disposeSpines(){
  if(hier.spineBase){ view.scene.remove(hier.spineBase); hier.spineBase.geometry.dispose(); hier.spineBase.material.dispose(); hier.spineBase=null; }
  if(hier.docEmphLines){ view.scene.remove(hier.docEmphLines); hier.docEmphLines.geometry.dispose(); hier.docEmphLines.material.dispose(); hier.docEmphLines=null; }
  hier.docSegs={};
}
export function buildDocSpines(){
  disposeSpines();
  const ns=nodes(), byDoc={};
  hier.docOf=new Array(ns.length).fill(null);
  ns.forEach((n,i)=>{ if(!n.document_id) return;
    hier.docOf[i]=n.document_id; (byDoc[n.document_id]=byDoc[n.document_id]||[]).push(i); });
  const lp=[], lc=[]; let maxSegs=0;
  Object.keys(byDoc).forEach(id=>{
    const idx=byDoc[id].sort((a,b)=>(ns[a].chunk||0)-(ns[b].chunk||0));
    if(idx.length<2) return;
    const segs=[];
    for(let m=0;m<idx.length-1;m++){
      const a=ns[idx[m]].p, b=ns[idx[m+1]].p;
      lp.push(a[0],a[1],a[2],b[0],b[1],b[2]);
      segs.push(a[0],a[1],a[2],b[0],b[1],b[2]);
      _c.set(projColor(ns[idx[m]].project)).multiplyScalar(0.5);
      lc.push(_c.r,_c.g,_c.b,_c.r,_c.g,_c.b);
    }
    hier.docSegs[id]=segs; maxSegs=Math.max(maxSegs, idx.length-1);
  });
  if(!lp.length) return;
  const g1=new THREE.BufferGeometry();
  g1.setAttribute('position', new THREE.Float32BufferAttribute(lp,3));
  g1.setAttribute('color',    new THREE.Float32BufferAttribute(lc,3));
  hier.spineBase=new THREE.LineSegments(g1, new THREE.LineBasicMaterial(
    {vertexColors:true, transparent:true, opacity:0, depthWrite:false,
     blending:THREE.AdditiveBlending}));
  hier.spineBase.frustumCulled=false; view.scene.add(hier.spineBase);
  const g2=new THREE.BufferGeometry();
  g2.setAttribute('position', new THREE.BufferAttribute(new Float32Array(maxSegs*2*2*3),3));
  g2.setDrawRange(0,0);
  hier.docEmphLines=new THREE.LineSegments(g2, new THREE.LineBasicMaterial(
    {color:ACCENT, transparent:true, opacity:0, depthWrite:false,
     blending:THREE.AdditiveBlending}));
  hier.docEmphLines.frustumCulled=false; view.scene.add(hier.docEmphLines);
}
// Brighten the focused/hovered node's document spine — plus a doc-level tree
//  selection's spine when one is active.
export function updateDocEmph(){
  if(!hier.docEmphLines){ hier.docEmphT=0; return; }
  const {focus, hover, treeSel}=state, ids=[];
  const add=id=>{ if(id&&!ids.includes(id)) ids.push(id); };
  if(treeSel&&treeSel.level==='doc') add(treeSel.id);
  if(focus>=0) add(hier.docOf[focus]);
  if(hover>=0&&hover!==focus) add(hier.docOf[hover]);
  const pos=hier.docEmphLines.geometry.attributes.position.array;
  let o=0;
  ids.forEach(id=>{ const s=hier.docSegs[id]; if(!s) return;
    for(let m=0;m<s.length&&o<pos.length;m++) pos[o++]=s[m]; });
  hier.docEmphLines.geometry.setDrawRange(0, o/3);
  hier.docEmphLines.geometry.attributes.position.needsUpdate=true;
  hier.docEmphT = o>0 ? 0.75 : 0;
}
// Parent-chain emphasis: the focused/hovered node's source hull + project shell
//  glow; tree selections at source/project level light their own tier.
export function parentEmphasis(){
  hier.containers.forEach(c=>c.emph=0); hier.srcHulls.forEach(h=>h.emph=0);
  const ns=nodes(), {treeSel}=state;
  [state.focus, state.hover].forEach(i=>{ if(i==null||i<0||!ns[i]) return; const n=ns[i];
    const c=hier.containerByProj[n.project]; if(c) c.emph=1;
    const h=hier.srcHullByKey[n.project+'\u0000'+(n.source_id||'')]; if(h) h.emph=1; });
  if(treeSel&&treeSel.level==='source'){ const h=hier.srcHullByKey[treeSel.key]; if(h) h.emph=1; }
  if(treeSel&&treeSel.level==='project'){ const c=hier.containerByProj[treeSel.id]; if(c) c.emph=1; }
}
