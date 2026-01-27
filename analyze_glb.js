const fs = require('fs');
const path = '/Users/2apple_mgn_63_ram16/Desktop/WEBAR/public/animations/ornate+armored+warrior+3d+model.glb';

const buffer = fs.readFileSync(path);
console.log('File size:', buffer.length, 'bytes');

const magic = buffer.toString('ascii', 0, 4);
const version = buffer.readUInt32LE(4);
console.log('Magic:', magic, '| Version:', version);

const chunk0Length = buffer.readUInt32LE(12);
const jsonStr = buffer.toString('utf8', 20, 20 + chunk0Length);
const gltf = JSON.parse(jsonStr);

console.log('\n=== GLTF Structure ===');
console.log('Generator:', gltf.asset?.generator);
console.log('Nodes:', gltf.nodes?.length || 0);
console.log('Meshes:', gltf.meshes?.length || 0);
console.log('Skins:', gltf.skins?.length || 0);
console.log('Animations:', gltf.animations?.length || 0);

if (!gltf.skins || gltf.skins.length === 0) {
  console.log('\n❌ NO SKINS - Model is NOT rigged');
}

console.log('\n=== ALL NODES ===');
gltf.nodes?.forEach((node, i) => {
  console.log(i + ': ' + (node.name || 'unnamed') + (node.mesh !== undefined ? ' [MESH]' : '') + (node.children ? ' (children: ' + node.children.length + ')' : ''));
});

// Check meshes for skinned attributes
console.log('\n=== MESH PRIMITIVES ===');
gltf.meshes?.forEach((mesh, i) => {
  console.log('Mesh ' + i + ': ' + (mesh.name || 'unnamed'));
  mesh.primitives?.forEach((prim, j) => {
    const attrs = Object.keys(prim.attributes || {});
    const hasJoints = attrs.some(a => a.startsWith('JOINTS'));
    const hasWeights = attrs.some(a => a.startsWith('WEIGHTS'));
    console.log('  Primitive ' + j + ' - Joints: ' + hasJoints + ', Weights: ' + hasWeights);
    console.log('  Attributes: ' + attrs.join(', '));
  });
});
