import * as THREE from "three";
import { createCompanion } from "./companion";
import { createCollectible } from "./themes";
import type { BorrowTab } from "../BorrowExperienceContext";

export const LOAN_STEP_SECONDS = 7;

/** Illustrative collateral and USDG transfers, separate from any wallet state. */
export function createLoanAnimation(parent: THREE.Group, theme: BorrowTab = "p2p") {
  const textureCanvas = document.createElement("canvas");
  textureCanvas.width = 256; textureCanvas.height = 256;
  const context = textureCanvas.getContext("2d")!;
  context.fillStyle = "#e2dbc9";
  context.fillRect(0, 0, 256, 256);
  context.strokeStyle = "#84785e";
  context.lineWidth = 4;
  context.beginPath(); context.arc(128, 128, 108, 0, Math.PI * 2); context.stroke();
  context.fillStyle = "#39342a";
  context.font = "500 48px sans-serif";
  context.textAlign = "center"; context.textBaseline = "middle";
  context.fillText("USDG", 128, 132);
  const texture = new THREE.CanvasTexture(textureCanvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const coinMetal = new THREE.MeshStandardMaterial({ color: 0xb7a781, metalness: .45, roughness: .35 });
  const coinFace = new THREE.MeshStandardMaterial({ map: texture, roughness: .5, metalness: .12 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x595951, metalness: .25, roughness: .45 });
  const inset = new THREE.MeshStandardMaterial({ color: 0xded8c6, metalness: .3, roughness: .45 });
  function coin(face: THREE.Material, radius: number) {
    const group = new THREE.Group();
    const edge = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, .075, 48), face === coinFace ? coinMetal : dark);
    edge.rotation.x = Math.PI / 2;
    edge.castShadow = true;
    group.add(edge);
    const disk = new THREE.Mesh(new THREE.CircleGeometry(radius * .96, 48), face);
    disk.position.z = .039;
    group.add(disk);
    return group;
  }
  const assets = new THREE.Group();
  for (let i = 0; i < (theme === "nfts" ? 0 : 3); i++) {
    const token = coin(dark, .225);
    token.position.set(i * -.045, i * .035, i * -.085);
    const mark = new THREE.Mesh(new THREE.BoxGeometry(.115, .115, .014), inset);
    mark.rotation.z = Math.PI / 4;
    mark.position.z = .048;
    token.add(mark);
    assets.add(token);
  }
  if (theme === "nfts") assets.add(createCollectible());
  const dollars = coin(coinFace, .29);
  // Extra coin represents the interest included in repayment.
  const interest = coin(coinFace, .17);
  dollars.add(interest);
  interest.position.set(.22, -.16, .08);
  assets.name = "Carried collateral";
  dollars.name = "Carried USDG";
  assets.scale.setScalar(.47);
  dollars.scale.setScalar(.47);
  interest.position.set(.13, -.09, -.09);
  const borrower = createCompanion("Borrower", 0x667d9d, "borrower");
  const attendant = createCompanion("Turret attendant", 0x7e8d70, "keeper");
  parent.add(borrower.root, attendant.root, assets, dollars);
  const home = new THREE.Vector3(-1.48, 0, 2.13);
  const meeting = new THREE.Vector3(-.64, 0, 2.05);
  const desk = new THREE.Vector3(0, 0, 2.05);
  const inside = new THREE.Vector3(0, .32, -.38);
  const ease = (t: number) => { const x = THREE.MathUtils.clamp(t, 0, 1); return x * x * (3 - 2 * x); };
  const section = (t: number, start: number, end: number) => ease((t - start) / (end - start));
  const moving = (t: number, start: number, end: number) => {
    const x = THREE.MathUtils.clamp((t - start) / (end - start), 0, 1);
    return Math.sin(x * Math.PI);
  };
  const borrowerSocket = new THREE.Vector3(), attendantSocket = new THREE.Vector3();
  const borrowerRotation = new THREE.Quaternion(), attendantRotation = new THREE.Quaternion();
  const parentRotation = new THREE.Quaternion();
  const borrowerDistance = home.distanceTo(meeting);
  const passageDistance = desk.z - inside.z;
  // Exit straight to the meeting point, stop, then turn toward the borrower.
  function passage(progress: number) {
    attendant.root.position.lerpVectors(desk, inside, progress);
    const travelled = desk.z - attendant.root.position.z;
    attendant.root.position.y = .135 * section(travelled, 0, .23)
      + .085 * section(travelled, .23, .45)
      + .085 * section(travelled, .45, .67)
      + .015 * section(travelled, .67, .85);
  }
  return {
    update(time: number) {
      const phase = Math.floor(time / LOAN_STEP_SECONDS) % 4;
      const t = (time % LOAN_STEP_SECONDS) / LOAN_STEP_SECONDS;
      const inbound = phase === 0 || phase === 2;
      const exchange = inbound ? section(t, .32, .48) : section(t, .50, .64);
      const reach = inbound
        ? section(t, .25, .32) * (1 - section(t, .48, .55))
        : section(t, .43, .50) * (1 - section(t, .64, .71));
      const approach = inbound ? section(t, .02, .30) : 1 - section(t, .73, .97);
      borrower.root.position.lerpVectors(home, meeting, approach);
      borrower.root.rotation.y = inbound ? Math.PI / 2 : Math.PI / 2 + Math.PI * section(t, .65, .73);
      // Reset the outward-facing borrower at home by turning during the opening beat.
      if (inbound) borrower.root.rotation.y = Math.PI * 1.5 - Math.PI * section(t, 0, .05);
      const transit = inbound ? section(t, .57, .94) : 1 - section(t, .03, .40);
      passage(transit);
      attendant.root.rotation.y = inbound
        ? -Math.PI / 2 - Math.PI / 2 * section(t, .49, .57)
        : -Math.PI * (1 - section(t, 0, .025)) - Math.PI / 2 * section(t, .40, .48);
      const borrowerCarry = inbound ? 1 - exchange : exchange;
      borrower.pose((inbound ? approach : 1 - approach) * borrowerDistance, moving(t, inbound ? .02 : .73, inbound ? .30 : .97),
        Math.max(borrowerCarry, reach), reach, time);
      attendant.pose((inbound ? transit : 1 - transit) * passageDistance, moving(t, inbound ? .57 : .03, inbound ? .94 : .40),
        Math.max(1 - borrowerCarry, reach), reach, time);
      assets.visible = phase === 0 || phase === 3;
      dollars.visible = !assets.visible;
      interest.visible = phase === 2;
      const cargo = assets.visible ? assets : dollars;
      // Carry props in the hands, with only a short hand-to-hand transfer between the two sockets.
      parent.updateWorldMatrix(true, true);
      borrower.socket.getWorldPosition(borrowerSocket);
      attendant.socket.getWorldPosition(attendantSocket);
      parent.worldToLocal(borrowerSocket); parent.worldToLocal(attendantSocket);
      cargo.position.lerpVectors(attendantSocket, borrowerSocket, borrowerCarry);
      parent.getWorldQuaternion(parentRotation).invert();
      borrower.socket.getWorldQuaternion(borrowerRotation).premultiply(parentRotation);
      attendant.socket.getWorldQuaternion(attendantRotation).premultiply(parentRotation);
      cargo.quaternion.copy(attendantRotation).slerp(borrowerRotation, borrowerCarry);
      return phase;
    },
    dispose() { texture.dispose(); },
  };
}
