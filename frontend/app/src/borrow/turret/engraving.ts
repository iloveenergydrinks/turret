import * as THREE from "three";

/** Ink-on-paper treatment for the live meshes, inspired by the site's engraved illustrations. */
export function applyEngraving(model: THREE.Group) {
  const treated = new Set<THREE.Material>();
  const masonry: THREE.Mesh[] = [];
  model.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    if (object.name.startsWith("Limestone masonry")) masonry.push(object);
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (!(material instanceof THREE.MeshStandardMaterial) || treated.has(material)) continue;
      treated.add(material);
      const luminance = material.color.r * .2126 + material.color.g * .7152 + material.color.b * .0722;
      const value = luminance > .12 ? Math.min(.94, luminance * 1.25) : luminance;
      material.color.setRGB(value, value, value);
      material.metalness = 0;
      material.roughness = 1;
      material.customProgramCacheKey = () => "turret-engraving-v1";
      material.onBeforeCompile = (shader) => {
        shader.vertexShader = shader.vertexShader.replace("#include <common>", `
          #include <common>
          varying vec3 vPrintPosition;
        `).replace("#include <begin_vertex>", `
          #include <begin_vertex>
          // Use object space with mesh scale: marks stay attached while the knights move.
          vPrintPosition = position * vec3(length(modelMatrix[0].xyz), length(modelMatrix[1].xyz), length(modelMatrix[2].xyz));
        `);
        shader.fragmentShader = shader.fragmentShader.replace("#include <common>", `
          #include <common>
          varying vec3 vPrintPosition;
          float engravedLine(float coordinate, float width) {
            float edge = abs(fract(coordinate) - .5);
            float aa = max(fwidth(coordinate) * .42, .025);
            return 1.0 - smoothstep(width - aa, width + aa, edge);
          }
        `).replace("#include <colorspace_fragment>", `
          #include <colorspace_fragment>
          float lightness = dot(gl_FragColor.rgb, vec3(.2126, .7152, .0722));
          float shade = clamp(1.0 - lightness, 0.0, 1.0);
          vec3 p = vPrintPosition;
          float bend = .11 * sin(p.y * 53.0 + p.x * 17.0 + p.z * 13.0);
          float hatch = engravedLine(p.y * 43.0 + (p.x + p.z) * 23.0 + bend, .10);
          float crossHatch = engravedLine(p.y * 39.0 - (p.x + p.z) * 29.0, .085);
          float grain = fract(sin(dot(floor(p * 190.0), vec3(12.9898, 78.233, 37.719))) * 43758.5453);
          float stipple = smoothstep(.95, .995, grain) * smoothstep(.07, .40, shade);
          float contour = 1.0 - smoothstep(.10, .29, abs(dot(normal, geometryViewDir)));
          float ink = shade * .28
            + hatch * smoothstep(.07, .40, shade) * .90
            + crossHatch * smoothstep(.32, .70, shade) * .65
            + stipple * .25 + contour * .43;
          ink = max(ink, smoothstep(.65, .94, shade) * .92);
          gl_FragColor.rgb = mix(vec3(.978, .974, .959), vec3(.145, .141, .131), clamp(ink, 0.0, 1.0));
        `);
      };
      material.needsUpdate = true;
    }
  });
  const outlineMaterial = new THREE.LineBasicMaterial({ color: 0x4c4942, transparent: true, opacity: .70 });
  const outlines = masonry.map((mesh) => {
    const outline = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, 27), outlineMaterial);
    outline.name = "Engraved masonry joints";
    mesh.add(outline);
    return outline;
  });
  return () => {
    outlines.forEach((outline) => { outline.geometry.dispose(); outline.removeFromParent(); });
    outlineMaterial.dispose();
  };
}
