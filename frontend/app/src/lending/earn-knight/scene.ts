import * as THREE from "three";
import { applyEngraving } from "../../borrow/turret/engraving";
import { createEarnKnight } from "./model";

export function mountEarnKnight(canvas: HTMLCanvasElement, onReady: () => void, onLost: () => void) {
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: "low-power" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.setClearColor(0, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.25;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-.8, .8, .8, -.8, .1, 20);
  camera.position.set(1.4, 1.3, 5);
  camera.lookAt(0, .54, 0);
  scene.add(new THREE.HemisphereLight(0xfff8eb, 0x8a8071, 2.1));
  const light = new THREE.DirectionalLight(0xfff5e4, 3.6);
  light.position.set(-3, 7, 5);
  light.castShadow = true;
  light.shadow.mapSize.set(512, 512);
  Object.assign(light.shadow.camera, { left: -1.2, right: 1.2, top: 1.8, bottom: -1, near: .1, far: 15 });
  light.shadow.normalBias = .006;
  light.shadow.bias = -.0003;
  light.shadow.radius = 3;
  scene.add(light);
  const fill = new THREE.DirectionalLight(0xe5ebf3, 1.1);
  fill.position.set(4, 3, -4); scene.add(fill);
  const knight = createEarnKnight();
  scene.add(knight.root);
  const disposeEngraving = applyEngraving(knight.root);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), new THREE.ShadowMaterial({ opacity: .09 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -.008;
  ground.receiveShadow = true;
  scene.add(ground);
  let time = 0, previous = 0, frame = 0;
  let paused = false, reduced = false, visible = true, lost = false, disposed = false, ready = false;
  const draw = () => { knight.update(time); renderer.render(scene, camera); };
  const tick = (now: number) => {
    frame = 0;
    if (disposed || lost || !visible || document.hidden) return;
    if (now - previous >= 1000 / 30) {
      time += Math.min((now - previous) / 1000, .05);
      previous = now;
      draw();
    }
    if (!paused && !reduced) frame = requestAnimationFrame(tick);
  };
  const wake = () => {
    if (!frame && !paused && !reduced && visible && !document.hidden && !lost && !disposed) {
      previous = performance.now(); frame = requestAnimationFrame(tick);
    }
  };
  const stop = () => { cancelAnimationFrame(frame); frame = 0; };
  const resize = () => {
    const { width, height } = canvas.getBoundingClientRect();
    if (!width || !height || disposed || lost) return;
    const half = Math.max(.67, .54 * height / width);
    camera.left = -half * width / height; camera.right = half * width / height;
    camera.top = half; camera.bottom = -half;
    camera.updateProjectionMatrix(); renderer.setSize(width, height, false); draw();
    if (!ready) { ready = true; onReady(); }
  };
  const visibility = () => { if (document.hidden) stop(); else wake(); };
  const contextLost = () => { lost = true; stop(); onLost(); };
  const intersection = new IntersectionObserver(([entry]) => { visible = !!entry?.isIntersecting; if (visible) wake(); else stop(); });
  const size = new ResizeObserver(resize);
  intersection.observe(canvas); size.observe(canvas);
  document.addEventListener("visibilitychange", visibility);
  canvas.addEventListener("webglcontextlost", contextLost);
  resize(); wake();
  return {
    setMotion(nextPaused: boolean, nextReduced: boolean) {
      paused = nextPaused; reduced = nextReduced;
      if (paused || reduced) stop(); else wake();
    },
    dispose() {
      disposed = true; stop(); intersection.disconnect(); size.disconnect();
      document.removeEventListener("visibilitychange", visibility);
      canvas.removeEventListener("webglcontextlost", contextLost);
      disposeEngraving();
      const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>();
      scene.traverse(object => {
        if (object instanceof THREE.Mesh) {
          geometries.add(object.geometry);
          (Array.isArray(object.material) ? object.material : [object.material]).forEach(material => materials.add(material));
        }
      });
      geometries.forEach(geometry => geometry.dispose()); materials.forEach(material => material.dispose());
      light.shadow.map?.dispose(); renderer.dispose();
    },
  };
}
