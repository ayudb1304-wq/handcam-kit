// Both pages declare an <script type="importmap"> mapping "three" and "three/addons/" to a pinned CDN build.
// Shared modules import from here so the version is changed in exactly one place (the import maps).
export * from 'three';
export { OrbitControls } from 'three/addons/controls/OrbitControls.js';
