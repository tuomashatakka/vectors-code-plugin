// ---- eased spherical orbit + pointer/pinch/pan/wheel + picking --------------
// Writes TARGETS only (orbit.thTarget/phiTarget/rTarget/targetGoal); frame.js
// eases the current values and calls applyCam()/tickHover() every frame.
import * as THREE from 'three';
import { state, bus, focusNode, hoverNode, clearSelection } from './state.js';
import { view, gfx } from './scene.js';

export const orbit = {
  radius:15, theta:0.6, phi:1.05,
  rTarget:15, thTarget:0.6, phiTarget:1.05,
  target:new THREE.Vector3(), targetGoal:new THREE.Vector3(),
  dragging:false,
};

const _cp=new THREE.Vector3();
export function applyCam(){
  const {camera}=view, t=orbit.target;
  _cp.set(t.x+orbit.radius*Math.sin(orbit.phi)*Math.cos(orbit.theta),
          t.y+orbit.radius*Math.cos(orbit.phi),
          t.z+orbit.radius*Math.sin(orbit.phi)*Math.sin(orbit.theta));
  camera.position.copy(_cp); camera.lookAt(t);
}

// ---- picking ----------------------------------------------------------------
const ray=new THREE.Raycaster(); ray.params.Points.threshold=0.45;
const _ndc=new THREE.Vector2(), _right=new THREE.Vector3(), _up=new THREE.Vector3();
let cv=null, mx=-1, my=-1, hoverDirty=false;

// NDC math is canvas-relative — the canvas no longer fills the window
function ndcFrom(clientX, clientY){
  const r=cv.getBoundingClientRect();
  _ndc.set(((clientX-r.left)/r.width)*2-1, -((clientY-r.top)/r.height)*2+1);
  return _ndc;
}
function pick(clientX, clientY){
  if(!view.pts) return -1;
  ray.setFromCamera(ndcFrom(clientX, clientY), view.camera);
  const hit=ray.intersectObject(view.pts);
  if(!hit.length) return -1;
  hit.sort((a,b)=>a.distanceToRay-b.distanceToRay); // nearest to the ray wins
  return hit[0].index;
}
// hover peek runs from the frame loop, throttled by the dirty flag
export function tickHover(){
  if(!hoverDirty||orbit.dragging) return;
  hoverDirty=false;
  if(!view.pts) return;
  const nh = mx>=0 ? pick(mx,my) : -1;
  if(nh!==state.hover){ cv.style.cursor=nh>=0?'pointer':''; hoverNode(nh); }
}

// ---- pointers: 1 = orbit, 2 = pinch zoom + midpoint pan ----------------------
const pointers=new Map(); // pointerId -> {x,y,downX,downY}
let pinchD0=0;

export function initControls(canvas){
  cv=canvas;
  cv.addEventListener('pointerdown', e=>{
    cv.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, {x:e.clientX, y:e.clientY, downX:e.clientX, downY:e.clientY});
    if(pointers.size===1) orbit.dragging=true;
    if(pointers.size===2){ const [a,b]=[...pointers.values()]; pinchD0=Math.hypot(a.x-b.x,a.y-b.y); }
  });
  const drop=e=>{ pointers.delete(e.pointerId); orbit.dragging=pointers.size>0;
    try{cv.releasePointerCapture(e.pointerId)}catch(_){}}
  cv.addEventListener('pointerup', drop);
  cv.addEventListener('pointercancel', drop);
  cv.addEventListener('pointermove', e=>{
    const p=pointers.get(e.pointerId);
    if(!p){ mx=e.clientX; my=e.clientY; hoverDirty=true; return; }
    if(pointers.size===1){
      // orbit
      orbit.thTarget -= (e.clientX-p.x)*0.005;
      orbit.phiTarget = Math.max(0.18, Math.min(2.96, orbit.phiTarget-(e.clientY-p.y)*0.005));
    } else if(pointers.size===2){
      const other=[...pointers.values()].find(q=>q!==p);
      const mx0=(p.x+other.x)/2, my0=(p.y+other.y)/2;
      p.x=e.clientX; p.y=e.clientY;
      const mx1=(p.x+other.x)/2, my1=(p.y+other.y)/2;
      const d1=Math.hypot(p.x-other.x, p.y-other.y);
      if(pinchD0>0&&d1>0){ // pinch zoom
        orbit.rTarget=Math.max(3.5, Math.min(90, orbit.rTarget*pinchD0/d1));
        pinchD0=d1;
      }
      // midpoint-delta pan along the camera basis
      const dx=mx1-mx0, dy=my1-my0, k=orbit.radius*0.0016;
      view.camera.matrix.extractBasis(_right,_up,_cp);
      orbit.targetGoal.addScaledVector(_right,-dx*k).addScaledVector(_up, dy*k);
      return;
    }
    p.x=e.clientX; p.y=e.clientY;
  });
  cv.addEventListener('wheel', e=>{ e.preventDefault();
    // trackpad pinch arrives as ctrlKey wheel — same zoom path
    orbit.rTarget = Math.max(3.5, Math.min(90, orbit.rTarget*(1+Math.sign(e.deltaY)*0.09)));
  }, {passive:false});

  // click vs drag: 6px disambiguation + selection-lock semantics
  // (pointerup clears the pointer map before click fires — keep the last down point)
  const _lastDown={x:0,y:0};
  cv.addEventListener('pointerdown', e=>{ _lastDown.x=e.clientX; _lastDown.y=e.clientY; });
  cv.addEventListener('click', e=>{
    if(!view.pts) return;
    const last=[...pointers.values()].pop();
    const downX=last?last.downX:_lastDown.x, downY=last?last.downY:_lastDown.y;
    if(Math.hypot(e.clientX-downX, e.clientY-downY)>6) return; // orbit drag, not a click
    const idx=pick(e.clientX, e.clientY);
    if(state.focus>=0){ // selection locked: empty-space click deselects, node clicks are ignored
      if(idx<0) clearSelection();
      return;
    }
    if(idx>=0) focusNode(idx, {origin:'graph'});
  });

  cv.addEventListener('pointerleave', ()=>{ mx=my=-1; hoverDirty=true; });

  // canvas keyboard: arrows traverse the focused node's relations
  cv.addEventListener('keydown', e=>{
    if(e.key==='Escape'){ e.stopPropagation(); clearSelection(); return; }
    const nb=gfx.adjacency[state.focus]||[];
    if(!nb.length) return;
    if(['ArrowRight','ArrowDown'].includes(e.key)){
      e.preventDefault(); focusNode(nb[(nb._i=((nb._i||0)+1)%nb.length)], {origin:'kbd'});
    }
    if(['ArrowLeft','ArrowUp'].includes(e.key)){
      e.preventDefault(); focusNode(nb[(nb._i=((nb._i||0)-1+nb.length)%nb.length)], {origin:'kbd'});
    }
  });

  bus.on('graph', ()=>{ pointers.clear(); orbit.dragging=false; });
}
