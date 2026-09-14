import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { createTurretModel } from "./model";
import { carveDoorway } from "./doorway";
import { createCompanion } from "./companion";
import type { BorrowTab } from "../BorrowExperienceContext";

/** A framed, sculpted collectible, visible both on the vault and in the knight's hands. */
export function createCollectible() {
  const group = new THREE.Group();
  const frame = new THREE.MeshStandardMaterial({ color: 0x514b40, roughness: .7 });
  const paper = new THREE.MeshStandardMaterial({ color: 0xe4dece, roughness: .9 });
  const ink = new THREE.MeshStandardMaterial({ color: 0x696358, roughness: .8 });
  const box = (w: number, h: number, d: number, x: number, y: number, z: number, material: THREE.Material) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    mesh.position.set(x, y, z); mesh.castShadow = true; group.add(mesh); return mesh;
  };
  box(.48, .58, .045, 0, 0, 0, paper);
  for (const side of [-1, 1]) {
    box(.045, .65, .085, side * .26, 0, .012, frame);
    box(.56, .045, .085, 0, side * .303, .012, frame);
  }
  // A little knight portrait in relief, matching the mascot rather than an arbitrary token.
  box(.19, .19, .04, 0, .07, .045, ink);
  box(.21, .025, .015, 0, .09, .075, frame);
  box(.025, .08, .018, 0, .04, .076, frame);
  box(.25, .12, .03, 0, -.12, .042, ink);
  group.name = "Framed knight collectible";
  return group;
}

function createVault() {
  const model = new THREE.Group();
  model.name = "Turret — square collectible vault";
  const stone = new THREE.MeshStandardMaterial({ color: 0xc6bead, roughness: .9 });
  const parts: THREE.BufferGeometry[] = [];
  const block = (w: number, h: number, d: number, x: number, y: number, z: number, door = false) => {
    let geometry = new THREE.BoxGeometry(w, h, d).toNonIndexed();
    geometry.translate(x, y, z);
    if (door) geometry = carveDoorway(geometry);
    parts.push(geometry);
  };
  block(2.55,.14,2.45,0,.07,0);
  block(2.38,.16,2.28,0,.225,0);
  for (let row = 0; row < 12; row++) {
    const y = .31 + row * .197 + .09;
    for (let col = 0; col < 6; col++) {
      const x = -1.10 + (col + .5) * 2.20 / 6;
      block(.355,.183,.22,x,y,1.0,true);
      block(.355,.183,.22,x,y,-1.0);
      const z = -.88 + (col + .5) * 1.76 / 6;
      block(.22,.183,.282,-1.0,y,z);
      block(.22,.183,.282,1.0,y,z);
    }
  }
  block(2.45,.16,2.35,0,2.75,0);
  block(2.30,.20,2.20,0,2.92,0);
  for (const x of [-1,1]) for (const z of [-1,1]) {
    block(.45,.52,.45,x,3.18,z);
    block(.53,.09,.53,x,3.49,z);
  }
  // A central slate pyramid gives this keep a recognisable gallery/vault silhouette.
  const roof = new THREE.Mesh(new THREE.ConeGeometry(1.13,.80,4), new THREE.MeshStandardMaterial({color:0x777063,roughness:1}));
  roof.position.y=3.20; roof.rotation.y=Math.PI/4; roof.castShadow=true; model.add(roof);
  for (let i=0;i<3;i++) block(.80+i*.09,.08,.25,0,.265-i*.085,1.31+i*.22);
  const wall = new THREE.Mesh(mergeGeometries(parts),stone);
  parts.forEach(g=>g.dispose()); wall.name="Limestone masonry vault"; wall.castShadow=true;wall.receiveShadow=true;model.add(wall);
  const dark = new THREE.Mesh(new THREE.PlaneGeometry(.78,1.10),new THREE.MeshStandardMaterial({color:0x292723}));
  dark.position.set(0,.86,.20);model.add(dark);
  const artwork = createCollectible(); artwork.scale.setScalar(1.2);artwork.position.set(0,2.10,1.16);model.add(artwork);
  return model;
}

export function createThemedModel(theme: BorrowTab) {
  if (theme === "nfts") return createVault();
  const tower = createTurretModel(theme === "pools" ? 10 : 14);
  if (theme === "pools") {
    tower.name = "Turret — shared treasury";
    for (const side of [-1,1]) {
      const wing = createTurretModel(10);
      wing.scale.set(.46,.64,.46);wing.position.set(side*1.36,0,-.48);tower.add(wing);
    }
  }
  return tower;
}

/** A lender places USDG into the shared treasury while the borrower uses the main entrance. */
export function createPoolFunding(parent: THREE.Group) {
  const lender = createCompanion("Pool lender",0x7e8d70,"borrower");
  const stone = new THREE.MeshStandardMaterial({color:0xc4bbaa,roughness:1});
  const metal = new THREE.MeshStandardMaterial({color:0x9e947c,roughness:.65});
  const bowl = new THREE.Mesh(new THREE.CylinderGeometry(.40,.29,.33,20,1,true),stone);
  bowl.position.set(1.76,.29,1.38);bowl.castShadow=true;parent.add(bowl,lender.root);
  const floor = new THREE.Mesh(new THREE.CylinderGeometry(.30,.30,.05,20),metal);
  floor.position.set(1.76,.16,1.38);parent.add(floor);
  const coin = new THREE.Mesh(new THREE.CylinderGeometry(.105,.105,.04,28),metal);
  coin.rotation.x=Math.PI/2;coin.castShadow=true;parent.add(coin);
  const stored = Array.from({length:5},(_,i)=>{
    const c = new THREE.Mesh(new THREE.CylinderGeometry(.13,.13,.04,28),metal);
    c.position.set(1.76+(i%2?-.10:.08),.21+Math.floor(i/2)*.042,1.38+(i%2?.06:-.06));parent.add(c);return c;
  });
  const hand = new THREE.Vector3();
  const start = new THREE.Vector3(2.24,0,2.10), end = new THREE.Vector3(1.76,0,1.93);
  return {
    update(time:number) {
      const t=(time%8)/8;
      const smooth=(x:number)=>{x=THREE.MathUtils.clamp(x,0,1);return x*x*(3-2*x);};
      const approach=smooth(t/.3)*(1-smooth((t-.70)/.3));
      lender.root.position.lerpVectors(start,end,approach);
      const heading = Math.atan2(end.x-start.x,end.z-start.z);
      lender.root.rotation.y = t < .30 ? heading : t < .40
        ? THREE.MathUtils.lerp(heading,-Math.PI,smooth((t-.30)/.10))
        : t < .60 ? -Math.PI : THREE.MathUtils.lerp(-Math.PI,heading-Math.PI,smooth((t-.60)/.10));
      const reaching=smooth((t-.30)/.15)*(1-smooth((t-.60)/.10));
      lender.pose((t>.7?1-approach:approach)*start.distanceTo(end),t<.3||t>.7?Math.sin(approach*Math.PI):0,t<.52?1:0,reaching,time);
      parent.updateWorldMatrix(true,true);lender.socket.getWorldPosition(hand);parent.worldToLocal(hand);
      coin.position.copy(hand);
      const deposit=smooth((t-.45)/.10);
      if(t>.45)coin.position.lerp(new THREE.Vector3(1.76,.30,1.38),deposit);
      coin.visible=t<.56;
      stored.forEach((c,i)=>{c.visible=i<3||t>.53;});
    },
  };
}
