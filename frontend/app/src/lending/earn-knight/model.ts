import * as THREE from "three";
import { createCompanion } from "../../borrow/turret/companion";

/** The same mascot as Borrow, standing in place and greeting the lender. */
export function createEarnKnight() {
  const knight = createCompanion("Earn knight", 0x54534d, "borrower");
  const root = knight.root;
  root.rotation.y = .18;
  // At this larger scale, connect the gauntlets and boots to the armor.
  const armor = new THREE.MeshStandardMaterial({ color: 0x737f85, metalness: .55, roughness: .42 });
  const arms = [-1, 1].map(() => {
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(.042, .045, 1, 12), armor);
    arm.castShadow = true; arm.receiveShadow = true; knight.rig.body.add(arm); return arm;
  });
  for (const side of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(.048, .055, .14, 12), armor);
    leg.position.set(side * .095, .15, .025); leg.castShadow = true; leg.receiveShadow = true; root.add(leg);
  }
  const axis = new THREE.Vector3(0, 1, 0), shoulder = new THREE.Vector3(), direction = new THREE.Vector3();
  const ease = (value: number) => {
    const t = THREE.MathUtils.clamp(value, 0, 1);
    return t * t * (3 - 2 * t);
  };
  return {
    root,
    update(time: number) {
      knight.pose(0, 0, 0, 0, time);
      const phase = time % 10;
      const raise = ease((phase - 1.1) / .85) * (1 - ease((phase - 4.2) / .85));
      const wave = Math.sin((phase - 2) * Math.PI * 2.1) * ease((phase - 2) / .35) * (1 - ease((phase - 3.6) / .55));
      const { body, helmet, hands, cape, plume } = knight.rig;
      body.position.y = .003 * Math.sin(time * 1.5);
      body.rotation.z = -.018 * raise;
      helmet.rotation.y = -.18 + .07 * Math.sin(time * .55);
      helmet.rotation.z = -.045 * raise;
      helmet.rotation.x = .025 * Math.sin(time * .8);
      hands[1]!.position.set(.225 + .095 * raise, .345 + .31 * raise, .055 + .045 * raise);
      hands[1]!.rotation.z = raise * (-.22 + .28 * wave);
      hands[1]!.position.x += .022 * wave * raise;
      arms.forEach((arm, index) => {
        shoulder.set(index === 0 ? -.167 : .167, .455, .015);
        direction.subVectors(hands[index]!.position, shoulder);
        arm.position.copy(shoulder).addScaledVector(direction, .5);
        arm.scale.y = direction.length();
        arm.quaternion.setFromUnitVectors(axis, direction.normalize());
      });
      cape.rotation.x = -.10 + .025 * Math.sin(time * 1.5 - .55);
      plume.rotation.z = .018 * Math.sin(time * 1.5 - .8);
    },
  };
}
