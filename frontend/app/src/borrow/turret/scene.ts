import * as THREE from "three";
import { createLoanAnimation } from "./loan-animation";
import { applyEngraving } from "./engraving";
import { createThemedModel, createPoolFunding } from "./themes";
import type { BorrowTab } from "../BorrowExperienceContext";

export function mountTurret(canvas: HTMLCanvasElement, onReady: () => void, onLost: () => void, initialTheme: BorrowTab = "p2p") {
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: "low-power" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.25;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-2.5, 2.5, 2.5, -2.5, .1, 40);
  camera.position.set(3.5, 4.5, 9);
  camera.lookAt(0, 1.85, 0);
  scene.add(new THREE.HemisphereLight(0xfff8eb, 0x8a8071, 2.1));
  const key = new THREE.DirectionalLight(0xfff5e4, 3.6);
  key.position.set(-3, 10, 5);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.left = -4; key.shadow.camera.right = 4;
  key.shadow.camera.top = 6; key.shadow.camera.bottom = -3;
  key.shadow.normalBias = .015;
  key.shadow.bias = -.0003;
  key.shadow.radius = 3;
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xe5ebf3, 1.1);
  fill.position.set(4, 3, -4);
  scene.add(fill);
  const createScene = (theme: BorrowTab) => {
    const tower = createThemedModel(theme);
    const loan = createLoanAnimation(tower, theme);
    const funding = theme === "pools" ? createPoolFunding(tower) : null;
    const engraving = applyEngraving(tower);
    return { tower, loan, funding, engraving, time: 0 };
  };
  const variants = new Map<BorrowTab, ReturnType<typeof createScene>>();
  let theme = initialTheme;
  let current = createScene(theme);
  variants.set(theme, current);
  scene.add(current.tower);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.ShadowMaterial({ opacity: .065 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -.016;
  ground.receiveShadow = true;
  scene.add(ground);
  let paused = false, reduced = false, visible = true, lost = false, disposed = false;
  let frame = 0, previous = 0, rotation = 0, target = 0;
  let dragging = false, dragX = 0;
  const draw = () => {
    current.tower.rotation.y = rotation;
    current.loan.update(current.time);
    current.funding?.update(current.time);
    renderer.render(scene, camera);
  };
  const tick = (now: number) => {
    frame = 0;
    if (disposed || lost || !visible || document.hidden) return;
    if (now - previous >= 1000 / 30) {
      const delta = Math.min((now - previous) / 1000, .05);
      previous = now;
      if (!paused && !reduced && !dragging) current.time += delta;
      const next = target + (reduced || paused || dragging ? 0 : Math.sin(current.time * .3) * .06);
      rotation = reduced ? next : THREE.MathUtils.lerp(rotation, next, .13);
      draw();
    }
    if ((!paused && !reduced) || Math.abs(rotation - target) > .001 || dragging) frame = requestAnimationFrame(tick);
  };
  const wake = () => {
    if (!frame && visible && !document.hidden && !lost && !disposed) {
      previous = performance.now();
      frame = requestAnimationFrame(tick);
    }
  };
  const resize = () => {
    const { width, height } = canvas.getBoundingClientRect();
    if (!width || !height) return;
    const halfHeight = Math.max(2.4, (theme === "pools" ? 2.8 : 2.3) * height / width);
    camera.left = -halfHeight * width / height; camera.right = halfHeight * width / height;
    camera.top = halfHeight; camera.bottom = -halfHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
    if (!lost) draw();
  };
  const down = (event: PointerEvent) => {
    if (event.button !== 0) return;
    dragging = true; dragX = event.clientX; target = rotation;
    canvas.setPointerCapture(event.pointerId);
    canvas.dataset.dragging = "true";
    wake();
  };
  const move = (event: PointerEvent) => {
    if (!dragging) return;
    target += (event.clientX - dragX) * .009;
    dragX = event.clientX;
    wake();
  };
  const up = () => { dragging = false; canvas.dataset.dragging = "false"; wake(); };
  const keyboard = (event: KeyboardEvent) => {
    if (!["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) return;
    event.preventDefault();
    target = event.key === "Home" ? 0 : target + (event.key === "ArrowLeft" ? -.25 : .25);
    wake();
  };
  const visibility = () => {
    if (document.hidden) { cancelAnimationFrame(frame); frame = 0; }
    else wake();
  };
  const contextLost = () => { lost = true; cancelAnimationFrame(frame); frame = 0; onLost(); };
  canvas.addEventListener("pointerdown", down);
  canvas.addEventListener("pointermove", move);
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", up);
  canvas.addEventListener("lostpointercapture", up);
  canvas.addEventListener("keydown", keyboard);
  canvas.addEventListener("webglcontextlost", contextLost);
  document.addEventListener("visibilitychange", visibility);
  const observer = new IntersectionObserver(([entry]) => {
    visible = Boolean(entry?.isIntersecting);
    if (visible) wake(); else { cancelAnimationFrame(frame); frame = 0; }
  });
  observer.observe(canvas);
  const sizeObserver = new ResizeObserver(resize);
  sizeObserver.observe(canvas);
  resize();
  onReady();
  wake();
  return {
    setTheme(next: BorrowTab) {
      if (next === theme || disposed || lost) return;
      let variant = variants.get(next);
      if (!variant) { variant = createScene(next); variants.set(next, variant); }
      scene.remove(current.tower);
      current = variant; theme = next;
      scene.add(current.tower);
      resize(); wake();
    },
    setMotion(nextPaused: boolean, nextReduced: boolean) {
      // Freeze at the current orientation instead of snapping back when paused.
      if ((nextPaused && !paused) || (nextReduced && !reduced)) target = rotation;
      paused = nextPaused; reduced = nextReduced; wake();
    },
    dispose() {
      disposed = true; cancelAnimationFrame(frame);
      observer.disconnect(); sizeObserver.disconnect();
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", up);
      canvas.removeEventListener("lostpointercapture", up);
      canvas.removeEventListener("keydown", keyboard);
      canvas.removeEventListener("webglcontextlost", contextLost);
      document.removeEventListener("visibilitychange", visibility);
      const materials = new Set<THREE.Material>();
      // Cached variants keep their own loan-cycle time between tab switches.
      variants.forEach(variant => {
        variant.engraving(); variant.loan.dispose();
        scene.add(variant.tower);
      });
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose();
          (Array.isArray(object.material) ? object.material : [object.material]).forEach((material) => materials.add(material));
        }
      });
      materials.forEach((material) => material.dispose());
      key.shadow.map?.dispose();
      renderer.dispose();
    },
  };
}
