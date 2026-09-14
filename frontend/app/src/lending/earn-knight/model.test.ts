import { expect, test } from "vitest";
import { createEarnKnight } from "./model";

test("the solo mascot stays planted throughout its greeting and has no building", () => {
  const model = createEarnKnight();
  const feet = model.root.children.filter(node => node.type === "Mesh");
  const initial = feet.map(foot => foot.position.clone());
  const names: string[] = []; model.root.traverse(node => names.push(node.name));
  expect(names.some(name => /masonry|tower|turret crown/i.test(name))).toBe(false);
  for (let t = 0; t < 20; t += .1) {
    model.update(t);
    expect(model.root.position.length()).toBe(0);
    feet.forEach((foot, index) => expect(foot.position.distanceTo(initial[index]!)).toBe(0));
  }
});

test("the greeting returns smoothly to its initial pose at the loop boundary", () => {
  const model = createEarnKnight();
  const sample = (time: number) => { model.update(time); const values: number[] = []; model.root.traverse(node => values.push(...node.position.toArray(), node.rotation.x, node.rotation.y, node.rotation.z)); return values; };
  const before = sample(9.999), after = sample(10.001);
  expect(Math.max(...before.map((value, index) => Math.abs(value - after[index]!)))).toBeLessThan(.002);
});
