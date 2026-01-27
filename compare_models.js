const fs = require('fs');

function analyzeGLB(filePath) {
  const buffer = fs.readFileSync(filePath);
  console.log('\n📦 File:', filePath.split('/').pop());
  console.log('Size:', (buffer.length / 1024 / 1024).toFixed(2), 'MB');

  const chunk0Length = buffer.readUInt32LE(12);
  const jsonStr = buffer.toString('utf8', 20, 20 + chunk0Length);
  const gltf = JSON.parse(jsonStr);

  console.log('Generator:', gltf.asset?.generator || 'Unknown');
  console.log('Nodes:', gltf.nodes?.length || 0);
  console.log('Meshes:', gltf.meshes?.length || 0);
  console.log('Skins:', gltf.skins?.length || 0);
  console.log('Animations:', gltf.animations?.length || 0);

  if (gltf.skins && gltf.skins.length > 0) {
    console.log('\n✅ MODEL IS RIGGED!');
    gltf.skins.forEach((skin, i) => {
      console.log('  Skin ' + i + ': ' + (skin.joints?.length || 0) + ' bones');
    });
  } else {
    console.log('\n❌ NO RIGGING - Static mesh only');
  }
}

// Analyze both models
console.log('='.repeat(60));
analyzeGLB('/Users/2apple_mgn_63_ram16/Desktop/WEBAR/public/animations/ornate+armored+warrior+3d+model.glb');

console.log('\n' + '='.repeat(60));
analyzeGLB('/Users/2apple_mgn_63_ram16/Desktop/WEBAR/public/uploads/warrior 3d model rigged.glb');
