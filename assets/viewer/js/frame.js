// ---- frame loop -------------------------------------------------------------
// every visual state change eases toward its target over ~1-2s: node size,
//  alpha, color, edge/overlay/spine/hull opacities, billboards — no snaps.
// This module is the ONLY reader of eased current-values; everything else
// writes targets.
import { state } from './state.js';
import { EASE_CAM, EASE_NODE, EASE_COL, EASE_MAT } from './config.js';
import { view, gfx } from './scene.js';
import { orbit, applyCam, tickHover } from './controls.js';
import { hier } from './hierarchy.js';
import { bills, disposeBill } from './billboards.js';
import { popQueue, nowS } from './search.js';
import * as dof from './dof.js';

export function startFrameLoop(){ requestAnimationFrame(frame); }

function frame(){
  requestAnimationFrame(frame);
  const t=nowS();
  tickHover();
  // ease camera
  orbit.theta+=(orbit.thTarget-orbit.theta)*EASE_CAM;
  orbit.phi+=(orbit.phiTarget-orbit.phi)*EASE_CAM;
  orbit.radius+=(orbit.rTarget-orbit.radius)*EASE_CAM;
  orbit.target.lerp(orbit.targetGoal, 0.08);
  // drain pop queue
  for(let p=popQueue.length-1;p>=0;p--){
    if(t>=popQueue[p].at){ const i=popQueue[p].i;
      if(gfx.popV&&i<gfx.popV.length) gfx.popV[i]=1.0;
      popQueue.splice(p,1); }
  }
  // ease node size/alpha/color + pulse hits + decay pops
  const pts=view.pts;
  if(pts){
    const N=gfx.nodes.length, sz=pts.geometry.attributes.aSize.array, al=pts.geometry.attributes.aAlpha.array;
    const col=pts.geometry.attributes.color.array;
    const {focus, hover}=state;
    const hitSet=state.hits&&state.hits.set.size>0?state.hits.set:null;
    for(let i=0;i<N;i++){
      let st=gfx.sizeT[i];
      if(i===focus) st+= Math.sin(t*3.2)*0.22+0.12;                    // focus heartbeat
      else if(i===hover) st+= Math.sin(t*2.6)*0.14+0.08;               // hover breath
      else if(hitSet&&hitSet.has(i)) st+= Math.sin(t*4.5+i)*0.16;      // match shimmer
      if(gfx.popV[i]>0.001){ st+=gfx.popV[i]*1.6; gfx.popV[i]*=0.94; } // pop spike
      sz[i]+=(st-sz[i])*EASE_NODE; al[i]+=(gfx.alphaT[i]-al[i])*EASE_NODE;
    }
    for(let i=0;i<N*3;i++) col[i]+=(gfx.colT[i]-col[i])*EASE_COL;
    pts.geometry.attributes.aSize.needsUpdate=true;
    pts.geometry.attributes.aAlpha.needsUpdate=true;
    pts.geometry.attributes.color.needsUpdate=true;
  }
  // eased edge opacities: base links, focus overlay, hover overlay, spines
  if(view.lines) view.lines.material.opacity+=(gfx.lineOpT-view.lines.material.opacity)*EASE_MAT;
  if(view.focusLines) view.focusLines.material.opacity+=(gfx.focusOpT-view.focusLines.material.opacity)*EASE_MAT;
  if(view.hoverLines) view.hoverLines.material.opacity+=(gfx.hoverOpT-view.hoverLines.material.opacity)*EASE_MAT;
  if(hier.spineBase) hier.spineBase.material.opacity+=(0.14-hier.spineBase.material.opacity)*EASE_MAT;
  if(hier.docEmphLines) hier.docEmphLines.material.opacity+=(hier.docEmphT-hier.docEmphLines.material.opacity)*EASE_MAT;
  // hierarchy shells: base presence + parent-chain emphasis + ingest flash
  for(const c of hier.containers){
    if(c.flash>0.003) c.flash*=0.96;
    c.mesh.material.opacity+=((0.045+c.emph*0.05+c.flash*0.20)-c.mesh.material.opacity)*EASE_MAT;
    c.wire.material.opacity+=((0.055+c.emph*0.30+c.flash*0.28)-c.wire.material.opacity)*EASE_MAT;
    c.label.material.opacity+=((0.42+c.emph*0.5)-c.label.material.opacity)*EASE_MAT;
  }
  for(const h of hier.srcHulls)
    h.mesh.material.opacity+=((0.035+h.emph*0.22)-h.mesh.material.opacity)*EASE_MAT;
  // billboards fade in/out; drop them once fully faded and unwanted
  bills.forEach(b=>{
    const m=b.sp.material;
    m.opacity+=(b.t*0.92-m.opacity)*EASE_MAT;
    if(b.t===0&&m.opacity<0.02){ disposeBill(b); bills.delete(b.i); }
  });
  // focus halo follows + pulses
  const halo=view.halo, focus=state.focus;
  if(focus>=0&&gfx.nodes[focus]){
    halo.position.set(...gfx.nodes[focus].p);
    const s=1.7+Math.sin(t*3.2)*0.22; halo.scale.setScalar(s);
    halo.material.opacity += (0.85-halo.material.opacity)*EASE_MAT;
  } else halo.material.opacity += (0-halo.material.opacity)*EASE_MAT;
  applyCam();
  dof.tick();
  if(state.dofOn && dof.ready()) dof.render();
  else view.renderer.render(view.scene, view.camera); // byte-identical pre-DoF path
}
