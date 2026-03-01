#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════
 * DEBUG ANIMATIONS - Check which GLB files have embedded animations
 * ═══════════════════════════════════════════════════════════════
 * 
 * Usage:
 *   node debug_animations.mjs                    # Scan all uploads
 *   node debug_animations.mjs <file.glb>         # Check specific file
 */

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
const OPTIMIZED_DIR = path.join(UPLOADS_DIR, 'optimized');
const DB_FILE = path.join(__dirname, 'data', 'db.json');

async function createIO() {
    return new NodeIO()
        .registerExtensions(ALL_EXTENSIONS)
        .registerDependencies({
            'draco3d.decoder': await draco3d.createDecoderModule(),
        });
}

function formatSize(bytes) {
    if (bytes < 1024) return bytes + 'B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB';
    return (bytes / (1024 * 1024)).toFixed(1) + 'MB';
}

async function checkFile(io, filePath, label = '') {
    try {
        const doc = await io.read(filePath);
        const root = doc.getRoot();
        const anims = root.listAnimations();
        const skins = root.listSkins();
        const meshes = root.listMeshes();

        let totalVerts = 0;
        meshes.forEach(m => m.listPrimitives().forEach(p => {
            totalVerts += p.getAttribute('POSITION')?.getCount() || 0;
        }));

        const size = fs.statSync(filePath).size;

        return {
            path: filePath,
            label,
            size,
            animations: anims.map(a => ({
                name: a.getName() || '(unnamed)',
                channels: a.listChannels().length,
                samplers: a.listSamplers().length,
                duration: a.listSamplers().reduce((max, s) => {
                    const input = s.getInput();
                    if (input) {
                        const count = input.getCount();
                        if (count > 0) {
                            const lastTime = input.getElement(count - 1, []);
                            return Math.max(max, lastTime[0] || 0);
                        }
                    }
                    return max;
                }, 0)
            })),
            skins: skins.length,
            meshes: meshes.length,
            vertices: totalVerts,
        };
    } catch (e) {
        return { path: filePath, label, error: e.message };
    }
}

async function main() {
    console.log('\n═══════════════════════════════════════════════════════');
    console.log('  🎬 ANIMATION DEBUG TOOL');
    console.log('═══════════════════════════════════════════════════════\n');

    const io = await createIO();
    const specificFile = process.argv[2];

    if (specificFile && !specificFile.startsWith('--')) {
        // Check specific file
        const fullPath = path.isAbsolute(specificFile) ? specificFile : path.join(process.cwd(), specificFile);
        console.log(`Checking: ${fullPath}\n`);

        const result = await checkFile(io, fullPath, 'INPUT');
        printResult(result);

        // Also check optimized version if it exists
        const filename = path.basename(fullPath);
        const optimizedPath = path.join(OPTIMIZED_DIR, filename);
        if (fs.existsSync(optimizedPath)) {
            console.log('\n--- Optimized Version ---');
            const optResult = await checkFile(io, optimizedPath, 'OPTIMIZED');
            printResult(optResult);
        }

        // Check mobile version
        const ext = filename.endsWith('.gltf') ? '.gltf' : '.glb';
        const baseName = filename.substring(0, filename.length - ext.length);
        const mobilePath = path.join(OPTIMIZED_DIR, `${baseName}.mobile${ext}`);
        if (fs.existsSync(mobilePath)) {
            console.log('\n--- Mobile Version ---');
            const mobResult = await checkFile(io, mobilePath, 'MOBILE');
            printResult(mobResult);
        }
        return;
    }

    // Scan all uploads
    const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    const files = fs.readdirSync(UPLOADS_DIR)
        .filter(f => f.match(/\.(glb|gltf)$/i))
        .sort();

    console.log(`Found ${files.length} model files in uploads/\n`);

    let withAnims = 0;
    let withoutAnims = 0;
    let withSkins = 0;
    let errors = 0;

    for (const file of files) {
        const filePath = path.join(UPLOADS_DIR, file);
        const result = await checkFile(io, filePath, 'ORIG');

        if (result.error) {
            console.log(`❌ ${file}: ${result.error}`);
            errors++;
            continue;
        }

        const hasAnims = result.animations.length > 0;
        const hasSkins = result.skins > 0;
        const icon = hasAnims ? '🎬' : (hasSkins ? '🦴' : '📦');

        if (hasAnims) withAnims++;
        else withoutAnims++;
        if (hasSkins) withSkins++;

        // Find DB entry for this file
        const dbEntry = Object.values(db).find(a => a.model && path.basename(a.model) === file);
        const assetId = dbEntry?.id || '?';
        const charName = dbEntry?.characterName || '';

        console.log(`${icon} ${file} (${formatSize(result.size)}) [ID: ${assetId}] ${charName}`);
        console.log(`   Meshes: ${result.meshes} | Vertices: ${result.vertices.toLocaleString()} | Skins: ${result.skins}`);

        if (hasAnims) {
            console.log(`   ✅ ${result.animations.length} Animation(s):`);
            result.animations.forEach(a => {
                console.log(`      • "${a.name}" — ${a.channels} channels, ${a.duration.toFixed(1)}s`);
            });
        } else if (hasSkins) {
            console.log(`   ⚠️  Has skeleton (${result.skins} skin) but NO animations embedded!`);
            console.log(`   💡 Fix: Re-export from Blender with "Include Animations" checked`);
            console.log(`   💡 Or: Bake Mixamo animation into model before export`);
        } else {
            console.log(`   ℹ️  Static model (no skeleton, no animations)`);
        }

        // Check optimized version
        const optPath = path.join(OPTIMIZED_DIR, file);
        if (fs.existsSync(optPath)) {
            const optResult = await checkFile(io, optPath, 'OPT');
            if (!optResult.error) {
                const optHasAnims = optResult.animations.length > 0;
                if (hasAnims && !optHasAnims) {
                    console.log(`   🔴 CRITICAL: Optimization REMOVED animations!`);
                } else if (hasAnims && optHasAnims) {
                    console.log(`   ✅ Optimized: ${optResult.animations.length} anims preserved (${formatSize(optResult.size)})`);
                } else {
                    console.log(`   📦 Optimized: ${formatSize(optResult.size)}`);
                }
            }
        }
        console.log('');
    }

    console.log('═══════════════════════════════════════════════════════');
    console.log(`  Summary:`);
    console.log(`    🎬 With animations: ${withAnims}`);
    console.log(`    🦴 With skeleton (no anim): ${withSkins - withAnims}`);
    console.log(`    📦 Static models: ${withoutAnims - (withSkins - withAnims)}`);
    console.log(`    ❌ Errors: ${errors}`);
    console.log(`    Total: ${files.length}`);
    console.log('═══════════════════════════════════════════════════════\n');
}

function printResult(result) {
    if (result.error) {
        console.log(`❌ Error: ${result.error}`);
        return;
    }

    console.log(`📁 ${result.label}: ${path.basename(result.path)} (${formatSize(result.size)})`);
    console.log(`   Meshes: ${result.meshes} | Vertices: ${result.vertices.toLocaleString()} | Skins: ${result.skins}`);

    if (result.animations.length > 0) {
        console.log(`   ✅ ${result.animations.length} Animation(s):`);
        result.animations.forEach(a => {
            console.log(`      • "${a.name}" — ${a.channels} channels, ${a.duration.toFixed(1)}s`);
        });
    } else if (result.skins > 0) {
        console.log(`   ⚠️  Has skeleton but NO animations!`);
    } else {
        console.log(`   ℹ️  Static model`);
    }
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
