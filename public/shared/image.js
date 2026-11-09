// Pictures the person picks from their computer or phone, made small and uniform in the browser before upload.
// No library: an <img> or ImageBitmap drawn on a canvas.

function load(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file isn’t a picture this browser can open.')); };
    img.src = url;
  });
}

function toCanvas(img, maxSide) {
  const w0 = img.naturalWidth || img.width || 1024, h0 = img.naturalHeight || img.height || 1024;
  const k = Math.min(1, maxSide / Math.max(w0, h0));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w0 * k)); c.height = Math.max(1, Math.round(h0 * k));
  return c;
}
const base64Of = (dataUrl) => dataUrl.slice(dataUrl.indexOf(',') + 1);

/**
 * A photo for the set builder or as a reference: JPEG, at most 1568 px on the long side (Claude's sweet spot; it reads
 * no more detail above that), on white where the picture had transparency. → { dataUrl, base64, mediaType, width, height }
 */
export async function photoToJpeg(file, { maxSide = 1568, quality = 0.86 } = {}) {
  const { img, url } = await load(file);
  try {
    const c = toCanvas(img, maxSide), g = c.getContext('2d');
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, c.width, c.height);
    g.drawImage(img, 0, 0, c.width, c.height);
    const dataUrl = c.toDataURL('image/jpeg', quality);
    return { dataUrl, base64: base64Of(dataUrl), mediaType: 'image/jpeg', width: c.width, height: c.height };
  } finally { URL.revokeObjectURL(url); }
}

/**
 * A logo exactly as supplied (PNG or SVG), as a PNG that keeps its transparency, at most `size` px on the long side.
 * SVGs are drawn at that size, so the edges stay sharp. → { dataUrl, base64, mediaType, width, height }
 */
export async function logoToPng(file, { size = 2048 } = {}) {
  const isSvg = file.type === 'image/svg+xml' || /\.svg$/i.test(file.name || '');
  const { img, url } = await load(file);
  try {
    // an SVG without width/height reports 0 or 150 px: scale it up to the target instead of down
    const w0 = img.naturalWidth || 300, h0 = img.naturalHeight || 150;
    const k = isSvg ? size / Math.max(w0, h0) : Math.min(1, size / Math.max(w0, h0));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w0 * k)); c.height = Math.max(1, Math.round(h0 * k));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const dataUrl = c.toDataURL('image/png');
    return { dataUrl, base64: base64Of(dataUrl), mediaType: 'image/png', width: c.width, height: c.height };
  } finally { URL.revokeObjectURL(url); }
}

/** A data: URL as a Blob, for uploads. */
export function blobOf(dataUrl) {
  const [head, b64] = dataUrl.split(',');
  const bin = atob(b64), bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: head.slice(5, head.indexOf(';')) });
}
