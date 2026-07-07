// ---- bokeh depth-of-field ---------------------------------------------------
// Stock BokehPass builds its depth via scene.overrideMaterial=MeshDepthMaterial,
// which renders our Points at 1px and the transparent shells as solid — garbage
// depth for a glow scene where every material is depthWrite:false. GlowBokehPass
// reimplements the depth prepass: swap the points/lines onto dedicated
// packDepthToRGBA materials, hide everything that shouldn't carve depth, then
// run the stock bokeh composite untouched.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { state, bus } from './state.js';
import { urlDof } from './config.js';
import { view } from './scene.js';
import { hier } from './hierarchy.js';
import { orbit } from './controls.js';

let composer=null, bokeh=null, nodeDepthMat=null, lineDepthMat=null;
let focusDist=15;
const _fp=new THREE.Vector3();

class GlowBokehPass extends BokehPass {
  // adapted from upstream BokehPass.render — same clear/restore choreography,
  // but the depth prepass uses our own materials instead of overrideMaterial
  render(renderer, writeBuffer, readBuffer){
    const {pts, lines, halo}=view;
    const {spineBase, docEmphLines, containers, srcHulls}=hier;
    const {focusLines, hoverLines}=view;

    // 1. hide what must not carve depth (halo/billboards/labels are layer 1 —
    //    the camera skips them here anyway — shells/hulls/overlays are layer 0)
    const hidden=[];
    const hide=o=>{ if(o&&o.visible){ hidden.push(o); o.visible=false; } };
    containers.forEach(c=>{ hide(c.mesh); hide(c.wire); hide(c.label); });
    srcHulls.forEach(h=>hide(h.mesh));
    hide(halo); hide(docEmphLines); hide(focusLines); hide(hoverLines);

    // 2. swap glow materials for depth-packing ones
    const oldPts=pts&&pts.material, oldLines=lines&&lines.material, oldSpine=spineBase&&spineBase.material;
    if(pts) pts.material=nodeDepthMat;
    if(lines) lines.material=lineDepthMat;
    if(spineBase) spineBase.material=lineDepthMat;

    // 3. depth into the pass's RGBADepthPacking target (matches DEPTH_PACKING=1)
    renderer.getClearColor(this._oldClearColor);
    const oldClearAlpha=renderer.getClearAlpha();
    const oldAutoClear=renderer.autoClear;
    renderer.autoClear=false;
    renderer.setClearColor(0xffffff);
    renderer.setClearAlpha(1.0);
    renderer.setRenderTarget(this._renderTargetDepth);
    renderer.clear();
    renderer.render(this.scene, this.camera); // camera layers already 0-only

    // 4. restore
    if(pts) pts.material=oldPts;
    if(lines) lines.material=oldLines;
    if(spineBase) spineBase.material=oldSpine;
    hidden.forEach(o=>o.visible=true);

    // 5. stock bokeh composite, exactly as upstream
    this.uniforms['tColor'].value=readBuffer.texture;
    this.uniforms['nearClip'].value=this.camera.near;
    this.uniforms['farClip'].value=this.camera.far;
    if(this.renderToScreen){
      renderer.setRenderTarget(null);
      this._fsQuad.render(renderer);
    } else {
      renderer.setRenderTarget(writeBuffer);
      renderer.clear();
      this._fsQuad.render(renderer);
    }
    renderer.setClearColor(this._oldClearColor);
    renderer.setClearAlpha(oldClearAlpha);
    renderer.autoClear=oldAutoClear;
  }
}

const DEPTH_FRAG=`
  #include <packing>
  void main(){
    gl_FragColor = packDepthToRGBA(gl_FragCoord.z);
  }`;

export function initDof(){
  const {renderer, scene, camera, nodeMat}=view;

  // node depth: clone of nodeMat's vertex path (same point sizing, SHARED
  // uniforms) + round-disc discard so depth matches the visible glow discs
  nodeDepthMat=new THREE.ShaderMaterial({
    uniforms:nodeMat.uniforms, // share uPx/uScale live
    blending:THREE.NoBlending, depthWrite:true, depthTest:true,
    vertexShader:`
      attribute float aSize;
      uniform float uPx; uniform float uScale;
      void main(){
        vec4 mv=modelViewMatrix*vec4(position,1.0);
        gl_PointSize=aSize*uScale*uPx/max(0.001,-mv.z);
        gl_Position=projectionMatrix*mv;
      }`,
    fragmentShader:`
      #include <packing>
      void main(){
        if(length(gl_PointCoord-0.5)>0.4) discard;
        gl_FragColor = packDepthToRGBA(gl_FragCoord.z);
      }`,
  });
  // line depth: minimal position-only material for links + spines
  lineDepthMat=new THREE.ShaderMaterial({
    blending:THREE.NoBlending, depthWrite:true, depthTest:true,
    vertexShader:`
      void main(){ gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
    fragmentShader:DEPTH_FRAG,
  });

  // ubyte target: r152+ composers default to HalfFloat, which lets additive
  // glow accumulate past 1.0 before the final clamp — noticeably hotter than
  // the legacy direct-to-canvas path this scene was tuned for
  composer=new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.UnsignedByteType }));
  composer.setPixelRatio(Math.min(devicePixelRatio,1.5)); // perf cap while DoF is on
  composer.addPass(new RenderPass(scene, camera));
  // gentle plane: additive glow amplifies blur, so keep aperture/maxblur low —
  // at focus≈11 a node 5 units off-plane gets ~5px of blur at 1080p, no more
  bokeh=new GlowBokehPass(scene, camera, {focus:15, aperture:0.00035, maxblur:0.0045});
  composer.addPass(bokeh);
  composer.addPass(new OutputPass());

  if(urlDof==='0'){ state.dofOn=false; bus.emit('dof', {on:false}); }
}

export function onResize(w, h){ if(composer) composer.setSize(w, h); }
export const ready=()=>!!composer;

// focus easing, ticked from frame.js: ease the focal plane toward the focused
// node, else the hovered node, else the orbit target
export function tick(){
  if(!bokeh) return;
  const nodes=(state.graph&&state.graph.nodes)||[];
  const p=(state.focus>=0&&nodes[state.focus])?nodes[state.focus].p
        :(state.hover>=0&&nodes[state.hover])?nodes[state.hover].p:null;
  if(p) _fp.set(p[0],p[1],p[2]); else _fp.copy(orbit.target);
  focusDist += (view.camera.position.distanceTo(_fp)-focusDist)*0.06;
  bokeh.uniforms.focus.value=focusDist;
}

// perf degrade: rolling 60-frame FPS average; below 40 turn DoF off for good
const stamps=[];
function trackFps(){
  const t=performance.now(); stamps.push(t);
  if(stamps.length>60) stamps.shift();
  if(stamps.length===60 && 59000/(t-stamps[0])<40){
    state.dofOn=false; stamps.length=0;
    bus.emit('dof', {on:false, degraded:true});
  }
}

export function render(){
  const {renderer, scene, camera}=view;
  trackFps();
  camera.layers.set(0);          // composer sees the glow scene only
  composer.render();
  renderer.autoClear=false;      // labels/halo/billboards stay crisp on top
  renderer.clearDepth();
  camera.layers.set(1);
  renderer.render(scene, camera);
  renderer.autoClear=true;
  camera.layers.set(0); camera.layers.enable(1); // back to both for the plain path
}
