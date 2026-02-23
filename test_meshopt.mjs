import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions';
import { MeshoptEncoder } from 'meshoptimizer';

async function testMeshopt() {
    await MeshoptEncoder.ready;
    const io = new NodeIO()
        .registerExtensions(ALL_EXTENSIONS)
        .registerDependencies({ 'meshopt.encoder': MeshoptEncoder });

    console.log('Reading 180MB mobile file...');
    const doc = await io.read('public/uploads/optimized/5fB5Wf1I-model.mobile.glb');

    // Create meshopt extension
    console.log('Applying Meshopt Compression...');
    doc.createExtension(EXTMeshoptCompression)
        .setRequired(true)
        // You can set encoder options here if needed, but defaults are usually good
        .setEncoderOptions({ method: MeshoptEncoder.filter });

    console.log('Writing to test output...');
    await io.write('test_meshopt.glb', doc);
    console.log('Done!');
}

testMeshopt().catch(console.error);
