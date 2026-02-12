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
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { 
  dedup, 
  draco, 
  prune, 
  textureCompress, 
  resample,
  quantize
} from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import sharp from 'sharp';
import path from 'path';
import fs from 'fs';
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
  const outputPath = path.join(OPTIMIZED_DIR, filename);
  
  // Skip if already optimized
  if (inputPath.includes('/optimized/')) return;
  
  // Skip if optimized version already exists and is newer
  if (fs.existsSync(outputPath)) {
    const inputStat = fs.statSync(inputPath);
    const outputStat = fs.statSync(outputPath);
    if (outputStat.mtimeMs > inputStat.mtimeMs) {
      console.log(`⏭  ${filename} already optimized (${formatSize(outputStat.size)})`);
      return outputPath;
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
      });

    // Read model
    console.log('   📖 Reading model...');
    const document = await io.read(inputPath);
    
    // Get texture stats before
    const root = document.getRoot();
    const textures = root.listTextures();
    console.log(`   🖼  Found ${textures.length} textures`);
    
    // Step 1: Manually resize and compress textures using sharp
    console.log('   🖼  Compressing textures...');
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
        
        // Compress to JPEG (smaller than PNG for most textures)
        // Use WebP for even better compression
        const mimeType = texture.getMimeType();
        let compressedBuffer;
        
        if (mimeType === 'image/png' && metadata.hasAlpha) {
          // Keep PNG for transparent textures, but optimize
          compressedBuffer = await img.png({ quality: TEXTURE_QUALITY, compressionLevel: 9 }).toBuffer();
          texture.setMimeType('image/png');
        } else {
          // Convert to JPEG for opaque textures
          compressedBuffer = await img.jpeg({ quality: TEXTURE_QUALITY, mozjpeg: true }).toBuffer();
          texture.setMimeType('image/jpeg');
        }
        
        const newSize = compressedBuffer.byteLength;
        texture.setImage(new Uint8Array(compressedBuffer));
        
        console.log(`      ${origDim} → resized, ${formatSize(origSize)} → ${formatSize(newSize)} (${Math.round((1 - newSize/origSize) * 100)}% smaller)`);
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

    // Step 5: Quantize vertex data
    console.log('   📐 Quantizing vertices...');
    await document.transform(quantize());

    // Step 6: Draco compression
    console.log('   🗜  Applying Draco compression...');
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

    // Write optimized file
    console.log('   💾 Writing optimized file...');
    await io.write(outputPath, document);

    const outputSize = fs.statSync(outputPath).size;
    const reduction = Math.round((1 - outputSize / inputSize) * 100);
    console.log(`   ✅ ${formatSize(inputSize)} → ${formatSize(outputSize)} (${reduction}% smaller)`);
    
    return outputPath;
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
    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
    const document = await io.read(inputPath);
    
    // Compress textures with sharp
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
        
        const compressed = await img.jpeg({ quality: TEXTURE_QUALITY, mozjpeg: true }).toBuffer();
        texture.setImage(new Uint8Array(compressed));
        texture.setMimeType('image/jpeg');
      } catch {}
    }
    
    await document.transform(dedup(), prune(), resample(), quantize());
    await io.write(outputPath, document);
    
    const outputSize = fs.statSync(outputPath).size;
    const reduction = Math.round((1 - outputSize / inputSize) * 100);
    console.log(`   ✅ (no Draco) ${formatSize(inputSize)} → ${formatSize(outputSize)} (${reduction}% smaller)`);
    return outputPath;
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
      if (result && fs.existsSync(result)) {
        totalOptimized += fs.statSync(result).size;
        successCount++;
      }
    }
    
    console.log(`\n═══════════════════════════════════════════════════════`);
    console.log(`  DONE: ${successCount}/${files.length} files optimized`);
    console.log(`  Total: ${formatSize(totalOriginal)} → ${formatSize(totalOptimized)}`);
    console.log(`  Saved: ${formatSize(totalOriginal - totalOptimized)} (${Math.round((1 - totalOptimized/totalOriginal) * 100)}%)`);
    console.log(`═══════════════════════════════════════════════════════\n`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
