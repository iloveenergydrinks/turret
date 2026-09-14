import * as THREE from "three";

export const DOORWAY = { radius: .40, base: .31, spring: .99, back: .58 } as const;

type Vertex = { position: THREE.Vector3; normal: THREE.Vector3; uv: THREE.Vector2 };

/** Subtract the convex arched passage from front masonry, preserving its stone faces. */
export function carveDoorway(geometry: THREE.BufferGeometry) {
  geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  const { radius, base, spring, back } = DOORWAY;
  if (box.max.z < back || box.min.x > radius || box.max.x < -radius
    || box.max.y < base || box.min.y > spring + radius) return geometry;

  // A convex prism with a 24-segment semicircular roof; positive distances are inside.
  const planes = [
    new THREE.Plane(new THREE.Vector3(1, 0, 0), radius),
    new THREE.Plane(new THREE.Vector3(-1, 0, 0), radius),
    new THREE.Plane(new THREE.Vector3(0, 1, 0), -base),
    new THREE.Plane(new THREE.Vector3(0, 0, 1), -back),
  ];
  for (let i = 0; i <= 24; i++) {
    const angle = Math.PI * i / 24;
    planes.push(new THREE.Plane(new THREE.Vector3(-Math.cos(angle), -Math.sin(angle), 0), radius + Math.sin(angle) * spring));
  }
  const positions: number[] = [], normals: number[] = [], uvs: number[] = [];
  const emit = (polygon: Vertex[]) => {
    for (let i = 1; i < polygon.length - 1; i++) {
      for (const vertex of [polygon[0]!, polygon[i]!, polygon[i + 1]!]) {
        positions.push(...vertex.position.toArray());
        normals.push(...vertex.normal.toArray());
        uvs.push(...vertex.uv.toArray());
      }
    }
  };
  const attributes = geometry.attributes;
  for (let i = 0; i < attributes.position!.count; i += 3) {
    let polygon: Vertex[] = [i, i + 1, i + 2].map((index) => ({
      position: new THREE.Vector3().fromBufferAttribute(attributes.position!, index),
      normal: new THREE.Vector3().fromBufferAttribute(attributes.normal!, index),
      uv: new THREE.Vector2(attributes.uv!.getX(index), attributes.uv!.getY(index)),
    }));
    if (planes.some((plane) => polygon.every((vertex) => plane.distanceToPoint(vertex.position) < 0))) {
      emit(polygon);
      continue;
    }
    for (const plane of planes) {
      const inside: Vertex[] = [], outside: Vertex[] = [];
      for (let j = 0; j < polygon.length; j++) {
        const a = polygon[j]!;
        const b = polygon[(j + 1) % polygon.length]!;
        const da = plane.distanceToPoint(a.position);
        const db = plane.distanceToPoint(b.position);
        (da >= 0 ? inside : outside).push(a);
        if ((da >= 0) !== (db >= 0)) {
          const t = da / (da - db);
          const intersection = {
            position: a.position.clone().lerp(b.position, t),
            normal: a.normal.clone().lerp(b.normal, t).normalize(),
            uv: a.uv.clone().lerp(b.uv, t),
          };
          inside.push(intersection); outside.push(intersection);
        }
      }
      emit(outside);
      polygon = inside;
      if (polygon.length < 3) break;
    }
    // Anything remaining lies inside the opening and is discarded.
  }
  const carved = new THREE.BufferGeometry();
  carved.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  carved.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  carved.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.dispose();
  return carved;
}
