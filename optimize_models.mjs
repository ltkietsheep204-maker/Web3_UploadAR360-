#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════
 * MODEL OPTIMIZER - Compress GLB files for fast web loading
 * ═══════════════════════════════════════════════════════════════
 * 
 * Reduces 163MB GLB → ~5-20MB by:
 *   1. Draco mesh compression (geometry ~90% smaller)
 *   2. Texture compression (resize to max 1024px, convert to WebP/JPEG)
 *   3. MeshOpt quantization
 *   4. Remove unused data
 * 
 * Usage:
 *   node optimize_models.js                    # Optimize all uploads
 *   node optimize_models.js <file.glb>         # Optimize specific file
 *   node optimize_models.js --max-texture 512  # Use smaller textures (for mobile)
 */

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRDracoMeshCompression, EXTMeshoptCompression } from '@gltf-transform/extensions';
import {
  dedup,
  draco,
  prune,
  textureCompress,
  resample,
  quantize,
  weld,
  simplify
} from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import sharp from 'sharp';
import path from 'path';
import fs from 'fs';
import { MeshoptSimplifier, MeshoptEncoder } from 'meshoptimizer';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
const OPTIMIZED_DIR = path.join(__dirname, 'public', 'uploads', 'optimized');

// Config
const MAX_TEXTURE_SIZE = parseInt(process.argv.find(a => a.startsWith('--max-texture'))?.split('=')[1] || '') || 1024;
const TEXTURE_QUALITY = 80; // JPEG/WebP quality

async function optimizeModel(inputPath) {
  const filename = path.basename(inputPath);
  const isGltf = inputPath.toLowerCase().endsWith('.gltf');
  const ext = isGltf ? '.gltf' : '.glb';
  const baseName = filename.substring(0, filename.length - ext.length);

  const outputPath = path.join(OPTIMIZED_DIR, filename);
  const mobilePath = path.join(OPTIMIZED_DIR, `${baseName}.mobile${ext}`);
  const previewPath = path.join(OPTIMIZED_DIR, `${baseName}.preview${ext}`);

  // Skip if already optimized
  if (inputPath.includes('/optimized/')) return;

  // Skip if all optimized versions exist and are newer
  if (fs.existsSync(outputPath) && fs.existsSync(mobilePath) && fs.existsSync(previewPath)) {
    const inputStat = fs.statSync(inputPath);
    const outputStat = fs.statSync(outputPath);
    if (outputStat.mtimeMs > inputStat.mtimeMs) {
      console.log(`⏭  ${filename} already optimized & mobile/preview generated`);
      return { outputPath, mobilePath, previewPath };
    }
  }

  const inputSize = fs.statSync(inputPath).size;
  console.log(`\n🔧 Optimizing: ${filename} (${formatSize(inputSize)})`);
  console.log(`   Max texture: ${MAX_TEXTURE_SIZE}px, Quality: ${TEXTURE_QUALITY}%`);

  try {
    // Initialize IO with Draco support
    const io = new NodeIO()
      .registerExtensions(ALL_EXTENSIONS)
      .registerDependencies({
        'draco3d.decoder': await draco3d.createDecoderModule(),
        'draco3d.encoder': await draco3d.createEncoderModule(),
        'meshopt.encoder': MeshoptEncoder
      });

    // Read model
    console.log('   📖 Reading model...');
    const document = await io.read(inputPath);

    // Get texture stats before
    const root = document.getRoot();
    const textures = root.listTextures();
    console.log(`   🖼  Found ${textures.length} textures`);

    // Step 1: Compress textures using sharp (High-Res WebP)
    console.log('   🖼  Compressing textures to High-Res WebP...');
    for (const texture of textures) {
      const imageData = texture.getImage();
      if (!imageData || imageData.byteLength === 0) continue;

      try {
        const buffer = Buffer.from(imageData);
        let img = sharp(buffer);
        const metadata = await img.metadata();

        if (!metadata.width || !metadata.height) continue;

        const origSize = imageData.byteLength;
        const origDim = `${metadata.width}x${metadata.height}`;

        // Resize if larger than max
        if (metadata.width > MAX_TEXTURE_SIZE || metadata.height > MAX_TEXTURE_SIZE) {
          img = img.resize(MAX_TEXTURE_SIZE, MAX_TEXTURE_SIZE, {
            fit: 'inside',
            withoutEnlargement: true
          });
        }

        // Convert to WebP for massive space savings & rendering performance
        const compressedBuffer = await img.webp({
          quality: TEXTURE_QUALITY,
          effort: 4
        }).toBuffer();

        const newSize = compressedBuffer.byteLength;
        texture.setImage(new Uint8Array(compressedBuffer));
        texture.setMimeType('image/webp');

        console.log(`      ${origDim} → resized, WebP ${formatSize(origSize)} → ${formatSize(newSize)} (${Math.round((1 - newSize / origSize) * 100)}% smaller)`);
      } catch (texErr) {
        console.log(`      ⚠ Could not compress texture: ${texErr.message}`);
      }
    }

    // Step 2: Deduplicate
    console.log('   🔄 Deduplicating...');
    await document.transform(dedup());

    // Step 3: Prune unused data
    console.log('   ✂️  Pruning unused data...');
    await document.transform(prune());

    // Step 4: Resample animations
    console.log('   🎬 Resampling animations...');
    await document.transform(resample());

    // Step 5: Weld duplicate vertices (reduces 993k → ~300k for typical models)
    console.log('   🔗 Welding duplicate vertices...');
    let totalVertsBefore = 0;
    document.getRoot().listMeshes().forEach(m => m.listPrimitives().forEach(p => {
      const pos = p.getAttribute('POSITION');
      if (pos) totalVertsBefore += pos.getCount();
    }));
    await document.transform(weld({ tolerance: 0.0001 }));
    let totalVertsAfter = 0;
    document.getRoot().listMeshes().forEach(m => m.listPrimitives().forEach(p => {
      const pos = p.getAttribute('POSITION');
      if (pos) totalVertsAfter += pos.getCount();
    }));
    console.log(`   📊 Vertices: ${totalVertsBefore.toLocaleString()} → ${totalVertsAfter.toLocaleString()} (${Math.round((1 - totalVertsAfter / totalVertsBefore) * 100)}% reduction)`);

    // Step 5b: Simplify if vertex count is slightly high for DESKTOP (>500k)
    const MAX_DESKTOP_VERTICES = 500000;
    if (totalVertsAfter > MAX_DESKTOP_VERTICES) {
      const ratio = MAX_DESKTOP_VERTICES / totalVertsAfter;
      console.log(`   ✂️  Simplifying HD mesh: ${totalVertsAfter.toLocaleString()} vertices exceeds desktop recommended limit`);
      await MeshoptSimplifier.ready;
      await document.transform(
        simplify({ simplifier: MeshoptSimplifier, ratio, error: 0.01 })
      );
    }

    // Step 6: Quantize vertex data
    // CRITICAL: Exclude JOINTS and WEIGHTS from quantization!
    // Quantizing these destroys the vertex→bone binding, making animations
    // play (bones move) but the mesh stays frozen (vertices don't follow bones)
    console.log('   📐 Quantizing vertices (preserving skin data)...');
    await document.transform(quantize({
      excludeAttributes: ['JOINTS_0', 'JOINTS_1', 'WEIGHTS_0', 'WEIGHTS_1']
    }));

    // Step 7: Compression
    // CRITICAL: Draco compression DESTROYS skin data (JOINTS/WEIGHTS) for animated models!
    // Bones animate correctly but mesh vertices don't follow → model appears frozen.
    // Solution: Use Meshopt for animated models, Draco for static models.
    const hasAnimations = root.listAnimations().length > 0;
    const hasSkins = root.listSkins().length > 0;

    if (hasAnimations || hasSkins) {
      console.log(`   🎬 Animated/skinned model detected — using Meshopt (Draco would break skinning)`);
      await MeshoptEncoder.ready;
      document.createExtension(EXTMeshoptCompression)
        .setRequired(true)
        .setEncoderOptions({ method: MeshoptEncoder.filter });
    } else {
      console.log('   🗜  Static model — applying Draco compression...');
      await document.transform(
        draco({
          method: 'edgebreaker',
          encodeSpeed: 5,
          decodeSpeed: 5,
          quantizePosition: 14,
          quantizeNormal: 10,
          quantizeTexcoord: 12,
          quantizeColor: 8,
        })
      );
    }

    // Write optimized High-Res file (Desktop)
    console.log('   💾 Writing optimized High-Res file (Desktop)...');
    await io.write(outputPath, document);

    const outputSize = fs.statSync(outputPath).size;
    const reduction = Math.round((1 - outputSize / inputSize) * 100);
    console.log(`   ✅ Original -> High-Res WebP: ${formatSize(inputSize)} → ${formatSize(outputSize)} (${reduction}% smaller)`);

    // ═══════════════════════════════════════════════════════════════
    // MOBILE OPTIMIZATION - Aggressive simplification for iOS RAM limits
    // ═══════════════════════════════════════════════════════════════
    console.log('   📱 Generating Mobile-Optimized Model (<100k vertices)...');
    let currentVerts = 0;
    document.getRoot().listMeshes().forEach(m => m.listPrimitives().forEach(p => {
      currentVerts += p.getAttribute('POSITION')?.getCount() || 0;
    }));

    // iOS WebGL heap crashes instantly above ~150k vertices during Draco decode
    const MAX_MOBILE_VERTS = 100000;
    if (currentVerts > MAX_MOBILE_VERTS) {
      const mobileRatio = MAX_MOBILE_VERTS / currentVerts;
      console.log(`      ✂️ Simplifying ${currentVerts.toLocaleString()} → ~${MAX_MOBILE_VERTS.toLocaleString()} vertices`);
      await MeshoptSimplifier.ready;
      await document.transform(
        simplify({ simplifier: MeshoptSimplifier, ratio: mobileRatio, error: 0.05 }) // Aggressive error tolerance for mobile
      );
    }

    // Scale textures down to 512px max for mobile specifically
    for (const texture of textures) {
      const imageData = texture.getImage();
      if (!imageData || imageData.byteLength === 0) continue;
      try {
        const buffer = Buffer.from(imageData);
        let img = sharp(buffer);
        const metadata = await img.metadata();
        if (metadata.width > 512 || metadata.height > 512) {
          img = img.resize(512, 512, { fit: 'inside', withoutEnlargement: true });
          const compressed = await img.webp({ quality: 70 }).toBuffer();
          texture.setImage(new Uint8Array(compressed));
        }
      } catch (e) { }
    }

    // 🔴 CRITICAL iOS CRASH FIX: Remove Draco compression before saving mobile model
    // Draco saves bandwidth but decompresses entire geometry into massive float32 arrays
    // inside the JS heap, which instantly crashes iOS WebGL limits on Safari.
    // By saving WITHOUT draco, the browser can map the buffer directly to GPU
    // without crossing JS heap limits.
    const dracoExtension = document.createExtension(KHRDracoMeshCompression);
    dracoExtension.dispose();

    // Instead of Draco, apply Meshopt Compression! 
    // Meshopt massively shrinks file size but decodes instantaneously directly to WebGL memory.
    console.log('   🗜 Applying Meshopt compression to reduce file size without decode RAM spike...');
    await MeshoptEncoder.ready;
    document.createExtension(EXTMeshoptCompression)
      .setRequired(true)
      .setEncoderOptions({ method: MeshoptEncoder.filter });

    // Write Mobile file (No Draco, Yes Meshopt)
    await io.write(mobilePath, document);
    const mobileSize = fs.statSync(mobilePath).size;
    console.log(`   ✅ Mobile Model generated (NO DRACO): ${formatSize(mobileSize)}`);

    // ═══════════════════════════════════════════════════════════════
    // PREVIEW OPTIMIZATION
    // ═══════════════════════════════════════════════════════════════
    console.log('   👻 Generating ultra-low-res Preview Model (< 1MB)...');
    for (const texture of textures) {
      const imageData = texture.getImage();
      if (!imageData || imageData.byteLength === 0) continue;

      try {
        const buffer = Buffer.from(imageData);
        let img = sharp(buffer);
        const metadata = await img.metadata();
        if (!metadata.width) continue;

        // Compress everything down to 128px maximum for the preview mesh
        img = img.resize(128, 128, { fit: 'inside', withoutEnlargement: true });

        // Ultra-low quality WebP for preview
        const compressedBuffer = await img.webp({ quality: 30, effort: 1 }).toBuffer();
        texture.setImage(new Uint8Array(compressedBuffer));
      } catch (e) { }
    }

    // Write Preview file
    await io.write(previewPath, document);
    const previewSize = fs.statSync(previewPath).size;
    console.log(`   ✅ Preview Model generated: ${formatSize(previewSize)}`);

    // Discard preview if it's too large and not significantly smaller than the HD version
    // If geometry is the bottleneck, scaling textures won't help much.
    if (previewSize > 2 * 1024 * 1024 && previewSize > outputSize * 0.5) {
      console.log(`   ⏭  Preview model is ${formatSize(previewSize)}, not small enough. Discarding preview to save bandwidth.`);
      fs.unlinkSync(previewPath);
      return { outputPath, mobilePath };
    }

    return { outputPath, mobilePath, previewPath };
  } catch (err) {
    console.error(`   ❌ Failed to optimize ${filename}:`, err.message);

    // Fallback: if Draco fails, try without it
    if (err.message.includes('draco') || err.message.includes('Draco')) {
      console.log('   🔄 Retrying without Draco...');
      return await optimizeWithoutDraco(inputPath, outputPath, inputSize);
    }
    return null;
  }
}

async function optimizeWithoutDraco(inputPath, outputPath, inputSize) {
  try {
    const io = new NodeIO()
      .registerExtensions(ALL_EXTENSIONS)
      .registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
    const document = await io.read(inputPath);

    // Compress textures with sharp WebP
    const textures = document.getRoot().listTextures();
    for (const texture of textures) {
      const imageData = texture.getImage();
      if (!imageData || imageData.byteLength === 0) continue;

      try {
        const buffer = Buffer.from(imageData);
        let img = sharp(buffer);
        const metadata = await img.metadata();
        if (!metadata.width) continue;

        if (metadata.width > MAX_TEXTURE_SIZE || metadata.height > MAX_TEXTURE_SIZE) {
          img = img.resize(MAX_TEXTURE_SIZE, MAX_TEXTURE_SIZE, { fit: 'inside', withoutEnlargement: true });
        }

        const compressed = await img.webp({ quality: TEXTURE_QUALITY }).toBuffer();
        texture.setImage(new Uint8Array(compressed));
        texture.setMimeType('image/webp');
      } catch { }
    }

    // CRITICAL: Exclude JOINTS/WEIGHTS from quantize to preserve skin/animation data
    const hasAnimFallback = document.getRoot().listAnimations().length > 0;
    const hasSkinFallback = document.getRoot().listSkins().length > 0;
    await document.transform(dedup(), prune(), resample(), quantize({
      excludeAttributes: ['JOINTS_0', 'JOINTS_1', 'WEIGHTS_0', 'WEIGHTS_1']
    }));

    // Use Meshopt for animated/skinned models, no compression for others
    if (hasAnimFallback || hasSkinFallback) {
      console.log('   🎬 (Fallback) Animated model — using Meshopt instead of Draco');
      await MeshoptEncoder.ready;
      document.createExtension(EXTMeshoptCompression)
        .setRequired(true)
        .setEncoderOptions({ method: MeshoptEncoder.filter });
    }
    await io.write(outputPath, document);

    const outputSize = fs.statSync(outputPath).size;
    const reduction = Math.round((1 - outputSize / inputSize) * 100);
    console.log(`   ✅ (no Draco) Original -> High-Res: ${formatSize(inputSize)} → ${formatSize(outputSize)} (${reduction}% smaller)`);

    // Generate preview
    for (const texture of textures) {
      const imageData = texture.getImage();
      if (!imageData) continue;
      try {
        const buffer = Buffer.from(imageData);
        const compressed = await sharp(buffer).resize(128, 128, { fit: 'inside' }).webp({ quality: 30 }).toBuffer();
        texture.setImage(new Uint8Array(compressed));
      } catch { }
    }
    const previewPath = outputPath.replace(/\.(glb|gltf)$/i, '.preview.$1');
    await io.write(previewPath, document);

    const previewSize = fs.statSync(previewPath).size;
    if (previewSize > 2 * 1024 * 1024 && previewSize > outputSize * 0.5) {
      console.log(`   ⏭  Preview model is ${formatSize(previewSize)}, not small enough. Discarding preview.`);
      fs.unlinkSync(previewPath);
      return { outputPath };
    }

    return { outputPath, previewPath };
  } catch (err) {
    console.error(`   ❌ Fallback also failed:`, err.message);
    return null;
  }
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB';
  return (bytes / (1024 * 1024)).toFixed(1) + 'MB';
}

async function main() {
  // Ensure optimized directory exists
  if (!fs.existsSync(OPTIMIZED_DIR)) {
    fs.mkdirSync(OPTIMIZED_DIR, { recursive: true });
  }

  const specificFile = process.argv[2];

  if (specificFile && !specificFile.startsWith('--')) {
    // Optimize specific file
    const fullPath = path.isAbsolute(specificFile) ? specificFile : path.join(process.cwd(), specificFile);
    await optimizeModel(fullPath);
  } else {
    // Optimize all GLB files in uploads
    const files = fs.readdirSync(UPLOADS_DIR)
      .filter(f => f.match(/\.(glb|gltf)$/i))
      .map(f => path.join(UPLOADS_DIR, f));

    console.log(`\n═══════════════════════════════════════════════════════`);
    console.log(`  MODEL OPTIMIZER - ${files.length} files to process`);
    console.log(`  Max texture: ${MAX_TEXTURE_SIZE}px | Quality: ${TEXTURE_QUALITY}%`);
    console.log(`═══════════════════════════════════════════════════════`);

    let totalOriginal = 0, totalOptimized = 0, successCount = 0;

    for (const file of files) {
      const origSize = fs.statSync(file).size;
      totalOriginal += origSize;

      const result = await optimizeModel(file);
      if (result && result.outputPath && fs.existsSync(result.outputPath)) {
        totalOptimized += fs.statSync(result.outputPath).size;
        successCount++;
      }
    }

    console.log(`\n═══════════════════════════════════════════════════════`);
    console.log(`  DONE: ${successCount}/${files.length} files optimized`);
    console.log(`  Total: ${formatSize(totalOriginal)} → ${formatSize(totalOptimized)}`);
    console.log(`  Saved: ${formatSize(totalOriginal - totalOptimized)} (${Math.round((1 - totalOptimized / totalOriginal) * 100)}%)`);
    console.log(`═══════════════════════════════════════════════════════\n`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
