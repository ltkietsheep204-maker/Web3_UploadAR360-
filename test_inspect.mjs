import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import { MeshoptDecoder } from 'meshoptimizer';

async function main() {
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      'draco3d.decoder': await draco3d.createDecoderModule(),
      'meshopt.decoder': MeshoptDecoder
    });
  const doc = await io.read('public/uploads/optimized/5fB5Wf1I-model.mobile.glb');
  const root = doc.getRoot();
  console.log('Animations:', root.listAnimations().length);
  root.listAnimations().forEach((a, i) => console.log(' Animation', i, a.getName(), 'channels:', a.listChannels().length));
}
main();
