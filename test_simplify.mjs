import { NodeIO } from '@gltf-transform/core';
import { simplify, weld, prune } from '@gltf-transform/functions';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptSimplifier } from 'meshoptimizer';

async function test() {
    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
    console.log('Reading...');
    const doc = await io.read('public/uploads/5fB5Wf1I-model.glb');

    await MeshoptSimplifier.ready;

    console.log('Welding with high tolerance...');
    await doc.transform(weld({ tolerance: 0.01 })); // Very aggressive weld

    let vertsAfterWeld = 0;
    doc.getRoot().listMeshes().forEach(m => m.listPrimitives().forEach(p => {
        vertsAfterWeld += p.getAttribute('POSITION')?.getCount() || 0;
    }));
    console.log('Vertices after weld:', vertsAfterWeld);

    console.log('Simplifying...');
    await doc.transform(
        simplify({ simplifier: MeshoptSimplifier, ratio: 100000 / vertsAfterWeld, error: 1.0 }),
        prune()
    );

    let vertsAfterSimplify = 0;
    doc.getRoot().listMeshes().forEach(m => m.listPrimitives().forEach(p => {
        vertsAfterSimplify += p.getAttribute('POSITION')?.getCount() || 0;
    }));
    console.log('Vertices after simplify:', vertsAfterSimplify);
}

test().catch(console.error);
