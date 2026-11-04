// The "measuring twin": the same set with every surface speckled, so the move-match scorer can track walking.
// The grey reference is too flat to track. Used as exportTake(..., { decorate: speckle }); never sent to an AI.
import * as THREE from './three.js';

let pattern = null;
function speckles() { // random grey blobs at several sizes; same seed every time so twins are reproducible
  if (pattern) return pattern;
  const c = Object.assign(document.createElement('canvas'), { width: 512, height: 512 });
  const g = c.getContext('2d');
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  g.fillStyle = '#777'; g.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 1600; i++) {
    const v = Math.floor(rnd() * 255);
    g.fillStyle = `rgb(${v},${v},${v})`;
    g.beginPath(); g.arc(rnd() * 512, rnd() * 512, 2 + rnd() * rnd() * 30, 0, Math.PI * 2); g.fill();
  }
  return (pattern = c);
}

/** ~1.5 m tiles on every mesh, unlit and unfogged. */
export function speckle(stage) {
  stage.fog = null;
  stage.traverse((o) => {
    if (!o.isMesh) return;
    o.geometry.computeBoundingBox();
    const size = o.geometry.boundingBox.getSize(new THREE.Vector3());
    const [a, b] = [size.x, size.y, size.z].sort((p, q) => q - p);
    const map = new THREE.CanvasTexture(speckles());
    map.wrapS = map.wrapT = THREE.RepeatWrapping;
    map.repeat.set(Math.max(1, a / 1.5), Math.max(1, b / 1.5));
    o.material = new THREE.MeshBasicMaterial({ map });
  });
}
