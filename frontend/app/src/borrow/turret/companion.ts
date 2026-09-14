import * as THREE from "three";

/** A pocket-sized Turret knight. Oversized greathelm, short cape, and mitten gauntlets. */
export function createCompanion(name: string, color: number, variant: "borrower" | "keeper") {
  const root = new THREE.Group();
  root.name = name;
  const body = new THREE.Group();
  root.add(body);
  const steel = new THREE.MeshStandardMaterial({ color: 0xb6bdc0, metalness: .58, roughness: .39 });
  const edge = new THREE.MeshStandardMaterial({ color: 0x737f85, metalness: .55, roughness: .42 });
  const cloth = new THREE.MeshStandardMaterial({ color, roughness: .91, side: THREE.DoubleSide });
  const dark = new THREE.MeshStandardMaterial({ color: 0x202a30, roughness: .75 });
  const ivory = new THREE.MeshStandardMaterial({ color: 0xe8dec1, roughness: .6 });
  const eyesMaterial = new THREE.MeshBasicMaterial({ color: 0xfaf0d4 });
  const sphere = new THREE.SphereGeometry(1, 20, 14);
  function mesh(owner: THREE.Object3D, geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number) {
    const part = new THREE.Mesh(geometry, material);
    part.position.set(x, y, z);
    part.castShadow = true;
    part.receiveShadow = true;
    owner.add(part);
    return part;
  }
  function oval(owner: THREE.Object3D, material: THREE.Material, position: number[], scale: number[]) {
    const part = mesh(owner, sphere, material, position[0]!, position[1]!, position[2]!);
    part.scale.set(scale[0]!, scale[1]!, scale[2]!);
    return part;
  }
  const torso = mesh(body, new THREE.CapsuleGeometry(.145, .12, 5, 16), steel, 0, .365, 0);
  torso.scale.z = .80;
  mesh(body, new THREE.CylinderGeometry(.115, .115, .065, 16), edge, 0, .52, 0);
  // A small tabard carries the battlement motif; the silhouette does most of the branding.
  const tabard = mesh(body, new THREE.BoxGeometry(.20, .23, .027), cloth, 0, .354, .116);
  const crest = new THREE.Shape();
  crest.moveTo(-.045, -.042); crest.lineTo(.045, -.042); crest.lineTo(.045, .040);
  crest.lineTo(.021, .040); crest.lineTo(.021, .017); crest.lineTo(.009, .017);
  crest.lineTo(.009, .040); crest.lineTo(-.009, .040); crest.lineTo(-.009, .017);
  crest.lineTo(-.021, .017); crest.lineTo(-.021, .040); crest.lineTo(-.045, .040); crest.closePath();
  mesh(tabard, new THREE.ShapeGeometry(crest), ivory, 0, .015, .015);
  // A curved cloth panel hangs from a shoulder pivot so the hem follows each step.
  const cape = new THREE.Group();
  cape.position.set(0, .50, -.10);
  body.add(cape);
  const capeGeometry = new THREE.PlaneGeometry(.32, .34, 8, 6);
  const capeVertices = capeGeometry.getAttribute("position");
  for (let index = 0; index < capeVertices.count; index++) {
    const x = capeVertices.getX(index), y = capeVertices.getY(index);
    const drop = (.17 - y) / .34;
    capeVertices.setXYZ(index, x * (.70 + .30 * drop), y - .17,
      -.07 * drop - .025 * Math.cos(x / .16 * Math.PI * 2) * drop);
  }
  capeGeometry.computeVertexNormals();
  mesh(cape, capeGeometry, cloth, 0, 0, 0);
  for (const side of [-1, 1]) {
    oval(body, steel, [side * .167, .455, 0], [.080, .066, .091]);
  }
  const helmet = new THREE.Group();
  helmet.position.y = .715;
  body.add(helmet);
  mesh(helmet, new THREE.CapsuleGeometry(.214, .12, 8, 24), steel, 0, 0, 0);
  // Curved visor and breathing slit sit on the helmet, rather than floating in front of it.
  mesh(helmet, new THREE.CylinderGeometry(.217, .217, .066, 32, 1, true, -1.17, 2.34), dark, 0, .008, 0);
  mesh(helmet, new THREE.CylinderGeometry(.218, .218, .115, 8, 1, true, -.075, .15), dark, 0, -.067, 0);
  mesh(helmet, new THREE.TorusGeometry(.214, .010, 5, 32), edge, 0, -.061, 0).rotation.x = Math.PI / 2;
  const eyes = [-1, 1].map((side) => oval(helmet, eyesMaterial, [side * .064, .008, .210], [.019, .011, .008]));
  for (const side of [-1, 1]) {
    oval(helmet, edge, [side * .207, -.022, .018], [.025, .025, .026]);
  }
  // One broad swept plume reads clearly at hero size; both knights share the same design.
  const plume = new THREE.Group();
  plume.position.set(0, .226, -.008);
  helmet.add(plume);
  oval(plume, cloth, [0, .020, -.045], [.045, .087, .124]).rotation.x = -.40;
  oval(plume, cloth, [0, -.004, -.135], [.041, .066, .079]).rotation.x = -.65;
  const feet = [-1, 1].map((side) => oval(root, edge, [side * .102, .057, .050], [.088, .057, .128]));
  const hands = [-1, 1].map((side) => oval(body, steel, [side * .225, .345, .055], [.065, .075, .069]));
  const socket = new THREE.Object3D();
  socket.name = `${name} carry socket`;
  body.add(socket);
  return {
    root, socket,
    rig: { body, helmet, hands, cape, plume, feet },
    pose(distance: number, walking: number, carrying: number, reach = 0, time = 0) {
      const stride = distance * 23;
      const bounce = Math.abs(Math.sin(stride)) * walking;
      body.position.y = .013 * bounce;
      body.rotation.z = .045 * Math.sin(stride) * walking;
      helmet.rotation.y = (variant === "borrower" ? -.28 : .75) * (1 - walking);
      helmet.rotation.x = .075 * reach;
      cape.rotation.x = -.10 - .13 * walking + .08 * Math.sin(stride - .6) * walking;
      cape.rotation.z = -.055 * Math.sin(stride - .6) * walking;
      plume.rotation.x = .09 * Math.sin(stride - .45) * walking;
      const blinkPhase = (time + (variant === "borrower" ? 0 : 2.3)) % 4.7;
      const blink = blinkPhase < .18 ? Math.sin(blinkPhase / .18 * Math.PI) : 0;
      eyes.forEach((eye) => { eye.scale.y = .011 * (1 - .91 * blink); });
      feet.forEach((foot, index) => {
        const step = Math.sin(stride + index * Math.PI) * walking;
        foot.position.y = .057 + .036 * Math.max(0, step);
        foot.position.z = .050 + .062 * step;
        foot.rotation.x = -.12 * step;
      });
      socket.position.set(0, .45, .255 + .045 * reach);
      hands.forEach((hand, index) => {
        const side = index === 0 ? -1 : 1;
        hand.position.set(side * (.225 - .12 * carrying), .345 + .105 * carrying,
          .055 + (.20 + .045 * reach) * carrying);
        hand.rotation.x = -.25 * carrying;
      });
    },
  };
}
