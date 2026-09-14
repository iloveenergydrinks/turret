import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { carveDoorway, DOORWAY } from "./doorway";

const TAU = Math.PI * 2;

/** A curved, bevelled masonry block, with real inner and outer faces. */
function masonry(inner: number, outer: number, angle: number, span: number, height: number) {
  const shape = new THREE.Shape();
  const start = angle - span / 2;
  const end = angle + span / 2;
  shape.moveTo(Math.sin(start) * outer, Math.cos(start) * outer);
  for (let i = 1; i <= 5; i++) {
    const a = start + span * i / 5;
    shape.lineTo(Math.sin(a) * outer, Math.cos(a) * outer);
  }
  shape.lineTo(Math.sin(end) * inner, Math.cos(end) * inner);
  for (let i = 1; i <= 5; i++) {
    const a = end - span * i / 5;
    shape.lineTo(Math.sin(a) * inner, Math.cos(a) * inner);
  }
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: height - .014, bevelEnabled: true, bevelSize: .006,
    bevelThickness: .007, bevelSegments: 1, steps: 1, curveSegments: 5,
  });
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

/** Original mesh model inspired by the existing engraved turret illustration. */
export function createTurretModel(rows = 14) {
  const crownOffset = (rows - 14) * .197;
  const model = new THREE.Group();
  model.name = "Turret — limestone watchtower";
  const batches: THREE.BufferGeometry[][] = Array.from({ length: 7 }, () => []);
  const stone = [0xc6bead, 0xbeb6a6, 0xd1c9b9, 0xcac2b1, 0xb8b09f, 0xd7cebd, 0xc2baaa]
    .map((color) => new THREE.MeshStandardMaterial({ color, roughness: .88, metalness: 0 }));
  let counter = 0;
  const addStone = (geometry: THREE.BufferGeometry, shade?: number) => {
    batches[shade ?? ((counter++ * 13 + Math.floor(counter / 7)) % 7)]!.push(geometry);
  };
  const ring = (inner: number, outer: number, y: number, height: number, count: number, offset = 0, doorway = false) => {
    for (let i = 0; i < count; i++) {
      const geometry = masonry(inner, outer, TAU * (i + offset) / count, TAU / count - .008, height);
      geometry.translate(0, y, 0);
      addStone(doorway ? carveDoorway(geometry) : geometry);
    }
  };
  // Low stepped plinth, then fourteen staggered courses of individually cut stone.
  ring(.82, 1.37, 0, .14, 24);
  ring(.82, 1.29, .145, .16, 24, .5);
  for (let row = 0; row < rows; row++) {
    ring(.99, 1.17 - row * .0018, .31 + row * .197, .189, 26, row % 2 ? .5 : 0, true);
  }
  // Corbels support the projecting crown. Their stepped profile catches the light.
  for (let i = 0; i < 24; i++) {
    const angle = TAU * i / 24;
    for (let step = 0; step < 3; step++) {
      const geometry = masonry(1.09, 1.20 + step * .06, angle, .115, .11);
      geometry.translate(0, 2.73 + crownOffset + step * .105, 0);
      addStone(geometry, 2);
    }
  }
  ring(.99, 1.39, 3.045 + crownOffset, .13, 28);
  ring(1.10, 1.36, 3.185 + crownOffset, .19, 28, .5);
  ring(1.08, 1.39, 3.38 + crownOffset, .075, 28);
  for (let i = 0; i < 12; i++) {
    const angle = TAU * i / 12;
    const block = masonry(1.10, 1.36, angle, .27, .30);
    block.translate(0, 3.46 + crownOffset, 0);
    addStone(block, i % 7);
    const cap = masonry(1.075, 1.395, angle, .29, .07);
    cap.translate(0, 3.768 + crownOffset, 0);
    addStone(cap, 2);
  }

  const darkMaterial = new THREE.MeshStandardMaterial({ color: 0x292723, roughness: 1 });
  const innerMaterial = new THREE.MeshStandardMaterial({ color: 0x777061, roughness: 1 });
  const floor = new THREE.Mesh(new THREE.CylinderGeometry(1.09, 1.09, .10, 48), innerMaterial);
  floor.position.y = 3.16 + crownOffset;
  floor.receiveShadow = true;
  model.add(floor);

  function arch(angle: number, base: number, radius: number, straight: number, passage = false) {
    const group = new THREE.Group();
    group.rotation.y = angle;
    const shape = new THREE.Shape();
    shape.moveTo(-radius, 0);
    shape.lineTo(radius, 0);
    shape.lineTo(radius, straight);
    shape.absarc(0, straight, radius, 0, Math.PI, false);
    shape.closePath();
    const inset = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: .045, bevelEnabled: false, curveSegments: 20 }), darkMaterial);
    // The entrance's darkness sits deep inside the tower, not on the exterior wall.
    inset.position.set(0, base, passage ? .20 : 1.168);
    group.add(inset);
    const trim = .105;
    const back = passage ? DOORWAY.back : 1.16;
    const depth = 1.32 - back;
    // Radiating voussoirs form the arched lintel; the jambs use separate blocks.
    for (let i = 0; i < 9; i++) {
      const a = Math.PI * i / 9 + .014;
      const b = Math.PI * (i + 1) / 9 - .014;
      const sector = new THREE.Shape();
      sector.moveTo(Math.cos(a) * radius, Math.sin(a) * radius);
      sector.absarc(0, 0, radius, a, b, false);
      sector.lineTo(Math.cos(b) * (radius + trim), Math.sin(b) * (radius + trim));
      sector.absarc(0, 0, radius + trim, b, a, true);
      sector.closePath();
      const geometry = new THREE.ExtrudeGeometry(sector, { depth, bevelEnabled: true, bevelSize: .005, bevelThickness: .005, bevelSegments: 1 });
      geometry.translate(0, base + straight, back);
      geometry.rotateY(angle);
      addStone(geometry, (i + 2) % 7);
    }
    const jambCount = Math.max(2, Math.ceil(straight / .19));
    for (const side of [-1, 1]) {
      for (let i = 0; i < jambCount; i++) {
        const geometry = new THREE.BoxGeometry(trim, straight / jambCount - .009, depth).toNonIndexed();
        geometry.translate(side * (radius + trim / 2), base + straight * (i + .5) / jambCount, back + depth / 2);
        geometry.rotateY(angle);
        addStone(geometry, (i + 1) % 7);
      }
    }
    const sill = new THREE.BoxGeometry((radius + trim) * 2 + .08, .075, .25).toNonIndexed();
    sill.translate(0, base - .035, 1.22);
    sill.rotateY(angle);
    addStone(sill, 2);
    model.add(group);
  }
  arch(0, DOORWAY.base, DOORWAY.radius, DOORWAY.spring - DOORWAY.base, true);
  for (const angle of [-.85, .85, Math.PI - .85, Math.PI + .85]) arch(angle, 1.88 + crownOffset * .5, .12, .40);
  // Entry steps locate the building on the ground instead of floating it.
  for (let i = 0; i < 3; i++) {
    const step = new THREE.BoxGeometry(.80 + i * .09, .08, .25).toNonIndexed();
    step.translate(0, .265 - i * .085, 1.31 + i * .22);
    addStone(step, 2);
  }

  // Merge the many stones into seven material batches to keep draw calls bounded.
  batches.forEach((geometries, index) => {
    const geometry = mergeGeometries(geometries);
    geometries.forEach((part) => part.dispose());
    if (!geometry) return;
    const mesh = new THREE.Mesh(geometry, stone[index]);
    mesh.name = `Limestone masonry ${index + 1}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    model.add(mesh);
  });
  return model;
}
