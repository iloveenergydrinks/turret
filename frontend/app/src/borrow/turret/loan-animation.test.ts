// @vitest-environment jsdom
import * as THREE from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLoanAnimation, LOAN_STEP_SECONDS } from "./loan-animation";
import { createTurretModel } from "./model";
import { createThemedModel } from "./themes";

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    fillRect() {}, beginPath() {}, arc() {}, stroke() {}, fillText() {},
  } as unknown as CanvasRenderingContext2D);
});
afterEach(() => vi.restoreAllMocks());

describe("loan doorway clearance", () => {
  it.each(["p2p", "nfts", "pools"] as const)("keeps the %s entrance open for the keeper and carried collateral", (theme) => {
    const model = createThemedModel(theme);
    model.updateMatrixWorld(true);
    const walls: THREE.Object3D[] = [];
    model.traverse(object => { if (object.name.startsWith("Limestone masonry")) walls.push(object); });
    for (const x of [-.25, 0, .25]) {
      const ray = new THREE.Raycaster(new THREE.Vector3(x,.73,2),new THREE.Vector3(0,0,-1),0,1.35);
      expect(ray.intersectObjects(walls).length).toBe(0);
    }
  });
  it("leaves an actual passage through the masonry", () => {
    const model = createTurretModel();
    model.updateMatrixWorld(true);
    const masonry = model.children.filter((child) => child.name.startsWith("Limestone masonry"));
    for (const x of [-.25, 0, .25]) {
      const ray = new THREE.Raycaster(new THREE.Vector3(x, .73, 2), new THREE.Vector3(0, 0, -1), 0, 1.35);
      expect(ray.intersectObjects(masonry).length, `Doorway is blocked at x=${x}`).toBe(0);
    }
    const wall = new THREE.Raycaster(new THREE.Vector3(.65, .73, 2), new THREE.Vector3(0, 0, -1), 0, 1.35);
    expect(wall.intersectObjects(masonry).length, "Wall beside the doorway must remain solid").toBeGreaterThan(0);
  });

  it("keeps every transfer within the characters' hands, including when the tower rotates", () => {
    const parent = new THREE.Group();
    parent.rotation.y = .8;
    parent.position.set(2, 0, -1);
    const animation = createLoanAnimation(parent);
    const cargoPosition = new THREE.Vector3(), handPosition = new THREE.Vector3();
    const sockets = [parent.getObjectByName("Borrower carry socket")!, parent.getObjectByName("Turret attendant carry socket")!];
    for (let sample = 0; sample < 400; sample++) {
      animation.update(sample * LOAN_STEP_SECONDS * 4 / 400);
      parent.updateMatrixWorld(true);
      const cargo = parent.getObjectByName("Carried collateral")!.visible
        ? parent.getObjectByName("Carried collateral")! : parent.getObjectByName("Carried USDG")!;
      cargo.getWorldPosition(cargoPosition);
      const nearestHand = Math.min(...sockets.map((socket) => {
        socket.getWorldPosition(handPosition);
        return cargoPosition.distanceTo(handPosition);
      }));
      expect(nearestHand, `Unsupported cargo at sample ${sample}`).toBeLessThan(.065);
    }
    animation.dispose();
  });

  it("does not drift sideways when the keeper finishes exiting", () => {
    const parent = new THREE.Group();
    const animation = createLoanAnimation(parent);
    const keeper = parent.getObjectByName("Turret attendant")!;
    const previous = new THREE.Vector3();
    animation.update(LOAN_STEP_SECONDS * 1.30);
    previous.copy(keeper.position);
    let sidewaysTravel = 0;
    for (let sample = 1; sample <= 100; sample++) {
      animation.update(LOAN_STEP_SECONDS * (1.30 + sample * .001));
      const dx = keeper.position.x - previous.x;
      const dz = keeper.position.z - previous.z;
      sidewaysTravel += Math.abs(dx * Math.cos(keeper.rotation.y) - dz * Math.sin(keeper.rotation.y));
      previous.copy(keeper.position);
    }
    animation.dispose();
    expect(sidewaysTravel, "Keeper moves sideways while still facing out of the doorway").toBeLessThan(.01);
  });

  it("routes the people and carried assets through the portal during all four steps", () => {
    const parent = new THREE.Group();
    const animation = createLoanAnimation(parent);
    const point = new THREE.Vector3();
    const collisions: string[] = [];
    for (let sample = 0; sample < 400; sample++) {
      const time = sample * (LOAN_STEP_SECONDS * 4 / 400);
      animation.update(time);
      parent.updateMatrixWorld(true);
      parent.traverseVisible((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        const vertices = object.geometry.getAttribute("position");
        for (let i = 0; i < vertices.count; i++) {
          point.fromBufferAttribute(vertices, i).applyMatrix4(object.matrixWorld);
          const radius = Math.hypot(point.x, point.z);
          if (radius < .97 || radius > 1.20 || point.y > 1.50) continue;
          const inArch = point.y <= .99 || point.x ** 2 + (point.y - .99) ** 2 < .40 ** 2;
          if (point.z < 0 || Math.abs(point.x) >= .40 || point.y < .31 || !inArch) {
            collisions.push(`t=${time.toFixed(2)} position=${point.toArray().map((n) => n.toFixed(2)).join(",")}`);
            break;
          }
        }
      });
    }
    animation.dispose();
    expect(collisions.slice(0, 8), `${collisions.length} person or asset/wall collisions`).toEqual([]);
  });
});
