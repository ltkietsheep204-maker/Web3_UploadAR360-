#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════
 * DEBUG GLB ANIMATION - Deep diagnostic for animation playback issues
 * ═══════════════════════════════════════════════════════════════
 * 
 * This script performs a comprehensive analysis of why animations
 * might not play in the WEBAR viewer. It checks:
 * 
 * 1. Animation clips exist and have valid data
 * 2. Skin/skeleton data is intact  
 * 3. Animation targets match bone hierarchy
 * 4. Vertex weights are valid (not corrupted by optimization)
 * 5. Compares original vs optimized versions
 * 
 * Usage:
 *   node debug_glb_animation.mjs <file.glb>
 *   node debug_glb_animation.mjs                  # Check all uploads
 *   node debug_glb_animation.mjs --asset <assetId> # Check specific asset
 */

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import { MeshoptDecoder } from 'meshoptimizer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
const OPTIMIZED_DIR = path.join(UPLOADS_DIR, 'optimized');
const DB_FILE = path.join(__dirname, 'data', 'db.json');

// ═══════════════════════════════════════════════════════════════
// COLORS for terminal output
// ═══════════════════════════════════════════════════════════════
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const MAGENTA = '\x1b[35m';
const CYAN = '\x1b[36m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

function formatSize(bytes) {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB';
  return (bytes / (1024 * 1024)).toFixed(1) + 'MB';
}

async function createIO() {
  await MeshoptDecoder.ready;
  return new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      'draco3d.decoder': await draco3d.createDecoderModule(),
      'meshopt.decoder': MeshoptDecoder,
    });
}

// ═══════════════════════════════════════════════════════════════
// DEEP ANALYSIS: Check a single GLB file thoroughly
// ═══════════════════════════════════════════════════════════════
async function deepAnalyze(io, filePath, label = '') {
  const filename = path.basename(filePath);
  const fileSize = fs.statSync(filePath).size;

  console.log(`\n${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}`);
  console.log(`${BOLD}  📁 ${label ? label + ': ' : ''}${filename} (${formatSize(fileSize)})${RESET}`);
  console.log(`${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}`);

  try {
    const doc = await io.read(filePath);
    const root = doc.getRoot();

    // ─── Meshes ───
    const meshes = root.listMeshes();
    let totalVerts = 0;
    let totalPrims = 0;
    meshes.forEach(m => m.listPrimitives().forEach(p => {
      totalPrims++;
      totalVerts += p.getAttribute('POSITION')?.getCount() || 0;
    }));
    console.log(`\n  ${BLUE}📊 Geometry:${RESET}`);
    console.log(`     Meshes: ${meshes.length} | Primitives: ${totalPrims} | Vertices: ${totalVerts.toLocaleString()}`);

    // ─── Nodes (scene hierarchy) ───
    const nodes = root.listNodes();
    const nodeNames = nodes.map(n => n.getName()).filter(Boolean);
    console.log(`     Nodes: ${nodes.length}`);

    // ─── Skins (skeletons) ───
    const skins = root.listSkins();
    console.log(`\n  ${BLUE}🦴 Skeleton:${RESET}`);
    if (skins.length === 0) {
      console.log(`     ${YELLOW}⚠ No skins found — model has no skeleton${RESET}`);
    } else {
      skins.forEach((skin, i) => {
        const joints = skin.listJoints();
        const jointNames = joints.map(j => j.getName());
        console.log(`     Skin[${i}]: "${skin.getName() || '(unnamed)'}" — ${joints.length} joints`);
        
        // Show first 10 joint names
        const displayJoints = jointNames.slice(0, 10);
        console.log(`     Joints: ${displayJoints.join(', ')}${jointNames.length > 10 ? ` ... (+${jointNames.length - 10} more)` : ''}`);
        
        // Check for skeleton root  
        const skeleton = skin.getSkeleton();
        if (skeleton) {
          console.log(`     Skeleton root: "${skeleton.getName()}"`);
        } else {
          console.log(`     ${YELLOW}⚠ No skeleton root node set${RESET}`);
        }
      });
    }

    // ─── Skinned mesh vertex weights analysis ───
    console.log(`\n  ${BLUE}⚖️  Skin Weights:${RESET}`);
    let hasJointsAttr = false;
    let hasWeightsAttr = false;
    let weightIssues = 0;
    let zeroWeightVerts = 0;
    let totalWeightedVerts = 0;

    meshes.forEach(mesh => {
      mesh.listPrimitives().forEach(prim => {
        const joints0 = prim.getAttribute('JOINTS_0');
        const weights0 = prim.getAttribute('WEIGHTS_0');

        if (joints0) hasJointsAttr = true;
        if (weights0) hasWeightsAttr = true;

        if (weights0) {
          const count = weights0.getCount();
          totalWeightedVerts += count;

          // Sample first 1000 vertices to check weight validity
          const sampleSize = Math.min(count, 1000);
          for (let i = 0; i < sampleSize; i++) {
            const w = weights0.getElement(i, []);
            const sum = w.reduce((a, b) => a + b, 0);
            if (sum < 0.001) zeroWeightVerts++;
            if (Math.abs(sum - 1.0) > 0.1 && sum > 0.001) weightIssues++;
          }
        }
      });
    });

    if (!hasJointsAttr && !hasWeightsAttr) {
      console.log(`     ${YELLOW}⚠ No JOINTS_0 / WEIGHTS_0 attributes — vertices not bound to skeleton${RESET}`);
    } else {
      console.log(`     JOINTS_0: ${hasJointsAttr ? GREEN + '✓ Present' : RED + '✗ Missing'}${RESET}`);
      console.log(`     WEIGHTS_0: ${hasWeightsAttr ? GREEN + '✓ Present' : RED + '✗ Missing'}${RESET}`);
      console.log(`     Weighted vertices: ${totalWeightedVerts.toLocaleString()}`);
      if (zeroWeightVerts > 0) {
        console.log(`     ${RED}⚠ Zero-weight vertices (sampled): ${zeroWeightVerts} — these won't move!${RESET}`);
      }
      if (weightIssues > 0) {
        console.log(`     ${YELLOW}⚠ Non-normalized weights (sampled): ${weightIssues}${RESET}`);
      }
      if (zeroWeightVerts === 0 && weightIssues === 0) {
        console.log(`     ${GREEN}✓ Weights look healthy${RESET}`);
      }
    }

    // ─── Animations ───
    const anims = root.listAnimations();
    console.log(`\n  ${BLUE}🎬 Animations:${RESET}`);

    if (anims.length === 0) {
      console.log(`     ${RED}✗ NO ANIMATIONS FOUND${RESET}`);
      console.log(`     ${YELLOW}💡 This is the main reason animations don't play!${RESET}`);
      console.log(`     ${DIM}   Original file might not have had animations embedded,${RESET}`);
      console.log(`     ${DIM}   or optimization may have removed them.${RESET}`);
      return {
        filename, label, fileSize, anims: 0, skins: skins.length,
        verts: totalVerts, hasJoints: hasJointsAttr, hasWeights: hasWeightsAttr,
        targetMatch: null, error: null
      };
    }

    console.log(`     ${GREEN}✓ Found ${anims.length} animation clip(s)${RESET}`);

    // Collect all joint names from skins for matching
    const allJointNames = new Set();
    skins.forEach(skin => {
      skin.listJoints().forEach(j => allJointNames.add(j.getName()));
    });

    // Collect all node names for matching
    const allNodeNames = new Set();
    nodes.forEach(n => { if (n.getName()) allNodeNames.add(n.getName()); });

    let totalTargetMatch = 0;
    let totalTargetMiss = 0;

    anims.forEach((anim, i) => {
      const channels = anim.listChannels();
      const samplers = anim.listSamplers();

      // Calculate duration
      let duration = 0;
      samplers.forEach(s => {
        const input = s.getInput();
        if (input) {
          const count = input.getCount();
          if (count > 0) {
            const lastTime = input.getElement(count - 1, []);
            duration = Math.max(duration, lastTime[0] || 0);
          }
        }
      });

      // Analyze channel targets
      const targets = new Map(); // nodeName -> [properties]
      let nullTargets = 0;
      channels.forEach(ch => {
        const targetNode = ch.getTargetNode();
        const targetPath = ch.getTargetPath(); // 'translation', 'rotation', 'scale', 'weights'
        if (targetNode) {
          const name = targetNode.getName() || '(unnamed)';
          if (!targets.has(name)) targets.set(name, []);
          targets.get(name).push(targetPath);
        } else {
          nullTargets++;
        }
      });

      // Check target matching
      let matched = 0;
      let missing = [];
      targets.forEach((props, name) => {
        if (allNodeNames.has(name)) {
          matched++;
        } else {
          missing.push(name);
        }
      });

      totalTargetMatch += matched;
      totalTargetMiss += missing.length;

      const icon = missing.length === 0 ? GREEN + '✓' : (matched === 0 ? RED + '✗' : YELLOW + '⚡');
      console.log(`\n     ${icon} [${i}] "${anim.getName() || '(unnamed)'}${RESET}"`);
      console.log(`        Channels: ${channels.length} | Samplers: ${samplers.length} | Duration: ${duration.toFixed(2)}s`);
      console.log(`        Targets: ${targets.size} unique nodes → ${GREEN}${matched} matched${RESET}, ${missing.length > 0 ? RED : DIM}${missing.length} missing${RESET}`);

      if (nullTargets > 0) {
        console.log(`        ${RED}⚠ ${nullTargets} channels have NULL target nodes!${RESET}`);
      }

      if (missing.length > 0) {
        console.log(`        ${RED}Missing targets: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ` (+${missing.length - 5} more)` : ''}${RESET}`);
      }

      // Check sampler data validity
      let emptySamplers = 0;
      let validSamplers = 0;
      samplers.forEach(s => {
        const input = s.getInput();
        const output = s.getOutput();
        if (!input || !output || input.getCount() === 0 || output.getCount() === 0) {
          emptySamplers++;
        } else {
          validSamplers++;
        }
      });
      if (emptySamplers > 0) {
        console.log(`        ${RED}⚠ ${emptySamplers} empty samplers (no keyframe data)!${RESET}`);
      }
    });

    // ─── THREE.js Compatibility Check ───
    console.log(`\n  ${BLUE}🔧 Three.js Compatibility:${RESET}`);

    // Check if animation targets use the format Three.js expects
    // Three.js AnimationMixer looks up objects by traversing the model with Object3D.getObjectByName()
    // Track names should be "boneName.property" format
    // In glTF, channels target nodes directly, and GLTFLoader converts them to Three.js tracks

    // Check for common issues
    const issues = [];

    if (anims.length > 0 && skins.length === 0) {
      issues.push('⚠ Has animations but no skins — animations may target mesh transforms instead of bones');
    }

    if (skins.length > 0 && !hasJointsAttr) {
      issues.push('🔴 Has skins but no JOINTS_0 attribute — mesh won\'t deform with skeleton');
    }

    if (skins.length > 0 && !hasWeightsAttr) {
      issues.push('🔴 Has skins but no WEIGHTS_0 attribute — mesh won\'t follow bones');
    }

    if (totalTargetMiss > totalTargetMatch && totalTargetMiss > 0) {
      issues.push('🔴 Most animation targets don\'t match model nodes — animations will play but nothing moves!');
    }

    if (zeroWeightVerts > totalWeightedVerts * 0.5) {
      issues.push('🔴 Over 50% of vertices have zero weights — most of the mesh won\'t animate');
    }

    // Check for "Retarget" clips that sometimes cause issues
    const retargetClips = anims.filter(a => (a.getName() || '').includes('Retarget'));
    if (retargetClips.length > 0) {
      issues.push(`⚠ Found ${retargetClips.length} "Retarget" clip(s) — these may conflict with original clips`);
    }

    if (issues.length === 0) {
      console.log(`     ${GREEN}✓ No compatibility issues detected${RESET}`);
    } else {
      issues.forEach(issue => console.log(`     ${issue}`));
    }

    // ─── Summary ───
    const overallOk = anims.length > 0 && skins.length > 0 && hasJointsAttr && hasWeightsAttr && totalTargetMiss === 0;
    console.log(`\n  ${BOLD}📋 Verdict:${RESET}`);
    if (overallOk) {
      console.log(`     ${GREEN}${BOLD}✓ Animation data looks correct. Issue may be in the viewer code.${RESET}`);
    } else if (anims.length === 0) {
      console.log(`     ${RED}${BOLD}✗ No animations! Model needs animations embedded or loaded separately.${RESET}`);
    } else if (!hasJointsAttr || !hasWeightsAttr) {
      console.log(`     ${RED}${BOLD}✗ Missing skin vertex data (JOINTS/WEIGHTS). Optimization may have corrupted it.${RESET}`);
    } else if (totalTargetMiss > 0) {
      console.log(`     ${YELLOW}${BOLD}⚡ Animation targets partially mismatched. Some bones won't animate.${RESET}`);
    }

    return {
      filename, label, fileSize,
      anims: anims.length, skins: skins.length,
      verts: totalVerts,
      hasJoints: hasJointsAttr, hasWeights: hasWeightsAttr,
      targetMatch: { matched: totalTargetMatch, missing: totalTargetMiss },
      error: null
    };

  } catch (e) {
    console.log(`     ${RED}✗ Error reading file: ${e.message}${RESET}`);
    return { filename, label, error: e.message };
  }
}

// ═══════════════════════════════════════════════════════════════
// COMPARE: Original vs Optimized versions
// ═══════════════════════════════════════════════════════════════
function compareResults(original, optimized, mobile, preview) {
  console.log(`\n${BOLD}${MAGENTA}═══════════════════════════════════════════════════════════════${RESET}`);
  console.log(`${BOLD}  🔍 COMPARISON: Original vs Optimized Versions${RESET}`);
  console.log(`${MAGENTA}═══════════════════════════════════════════════════════════════${RESET}\n`);

  const versions = [
    { label: 'Original', data: original },
    { label: 'Optimized (HD)', data: optimized },
    { label: 'Mobile', data: mobile },
    { label: 'Preview', data: preview },
  ].filter(v => v.data && !v.data.error);

  // Table header
  const cols = ['', 'Size', 'Verts', 'Anims', 'Skins', 'Joints', 'Weights', 'Target Match'];
  console.log(`  ${cols.map(c => c.padEnd(14)).join('')}`);
  console.log(`  ${'─'.repeat(14 * cols.length)}`);

  versions.forEach(v => {
    const d = v.data;
    const row = [
      v.label,
      formatSize(d.fileSize),
      d.verts?.toLocaleString() || '-',
      d.anims?.toString() || '0',
      d.skins?.toString() || '0',
      d.hasJoints ? '✓' : '✗',
      d.hasWeights ? '✓' : '✗',
      d.targetMatch ? `${d.targetMatch.matched}/${d.targetMatch.matched + d.targetMatch.missing}` : '-'
    ];
    console.log(`  ${row.map(c => c.padEnd(14)).join('')}`);
  });

  // Diagnose issues
  console.log(`\n  ${BOLD}🔎 Diagnosis:${RESET}`);

  if (original && !original.error) {
    if (original.anims === 0) {
      console.log(`  ${RED}  ✗ Original file has NO animations. Nothing to play.${RESET}`);
      console.log(`  ${YELLOW}  💡 Fix: Re-export from Blender/Mixamo with animations baked in.${RESET}`);
      return;
    }

    // Check if optimization removed animations
    [
      { label: 'Optimized HD', data: optimized },
      { label: 'Mobile', data: mobile },
      { label: 'Preview', data: preview }
    ].forEach(v => {
      if (!v.data || v.data.error) return;

      if (v.data.anims === 0 && original.anims > 0) {
        console.log(`  ${RED}  🔴 ${v.label}: Optimization REMOVED all animations!${RESET}`);
        console.log(`  ${YELLOW}     This is a critical bug in optimize_models.mjs${RESET}`);
      }

      if (!v.data.hasJoints && original.hasJoints) {
        console.log(`  ${RED}  🔴 ${v.label}: Optimization REMOVED JOINTS_0 attribute!${RESET}`);
        console.log(`  ${YELLOW}     Vertex-to-bone binding is destroyed. Mesh won't follow skeleton.${RESET}`);
      }

      if (!v.data.hasWeights && original.hasWeights) {
        console.log(`  ${RED}  🔴 ${v.label}: Optimization REMOVED WEIGHTS_0 attribute!${RESET}`);
        console.log(`  ${YELLOW}     Vertex weights are gone. Mesh won't deform.${RESET}`);
      }

      if (v.data.targetMatch && v.data.targetMatch.missing > 0) {
        const total = v.data.targetMatch.matched + v.data.targetMatch.missing;
        const pct = Math.round((v.data.targetMatch.missing / total) * 100);
        console.log(`  ${YELLOW}  ⚠ ${v.label}: ${pct}% animation targets don't match model nodes${RESET}`);
      }

      if (v.data.anims > 0 && v.data.hasJoints && v.data.hasWeights && v.data.targetMatch?.missing === 0) {
        console.log(`  ${GREEN}  ✓ ${v.label}: Animation data intact (${v.data.anims} clips, full target match)${RESET}`);
      }
    });
  }
}

// ═══════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════
async function main() {
  console.log(`\n${BOLD}${CYAN}═══════════════════════════════════════════════════════════════${RESET}`);
  console.log(`${BOLD}  🔬 WEBAR ANIMATION DEEP DEBUGGER${RESET}`);
  console.log(`${CYAN}═══════════════════════════════════════════════════════════════${RESET}`);

  const io = await createIO();

  // Parse args
  const args = process.argv.slice(2);
  const assetIdFlag = args.indexOf('--asset');
  
  if (assetIdFlag !== -1 && args[assetIdFlag + 1]) {
    // Check specific asset by ID
    const assetId = args[assetIdFlag + 1];
    const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    const asset = db[assetId];
    
    if (!asset) {
      console.log(`${RED}Asset "${assetId}" not found in database${RESET}`);
      process.exit(1);
    }

    console.log(`\n  Asset ID: ${assetId}`);
    console.log(`  Character: ${asset.characterName || '?'}`);
    console.log(`  Model path: ${asset.model}`);

    const modelFile = path.basename(asset.model);
    await analyzeAllVersions(io, modelFile);

  } else if (args.length > 0 && !args[0].startsWith('--')) {
    // Check specific file
    const filePath = path.isAbsolute(args[0]) ? args[0] : path.join(process.cwd(), args[0]);
    const filename = path.basename(filePath);

    const original = await deepAnalyze(io, filePath, 'ORIGINAL');

    // Check optimized versions
    const ext = filename.endsWith('.gltf') ? '.gltf' : '.glb';
    const baseName = filename.substring(0, filename.length - ext.length);

    const optPath = path.join(OPTIMIZED_DIR, filename);
    const mobilePath = path.join(OPTIMIZED_DIR, `${baseName}.mobile${ext}`);
    const previewPath = path.join(OPTIMIZED_DIR, `${baseName}.preview${ext}`);

    let optimized = null, mobile = null, preview = null;

    if (fs.existsSync(optPath)) {
      optimized = await deepAnalyze(io, optPath, 'OPTIMIZED HD');
    }
    if (fs.existsSync(mobilePath)) {
      mobile = await deepAnalyze(io, mobilePath, 'MOBILE');
    }
    if (fs.existsSync(previewPath)) {
      preview = await deepAnalyze(io, previewPath, 'PREVIEW');
    }

    if (optimized || mobile || preview) {
      compareResults(original, optimized, mobile, preview);
    }

  } else {
    // Scan all uploaded models that have skins/animations
    const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    const files = fs.readdirSync(UPLOADS_DIR)
      .filter(f => f.match(/\.(glb|gltf)$/i))
      .sort();

    console.log(`\n  Scanning ${files.length} model files...\n`);

    let animatedCount = 0;
    let brokenCount = 0;

    for (const file of files) {
      const filePath = path.join(UPLOADS_DIR, file);

      // Quick check first
      try {
        const doc = await io.read(filePath);
        const root = doc.getRoot();
        const hasAnims = root.listAnimations().length > 0;
        const hasSkins = root.listSkins().length > 0;

        if (!hasAnims && !hasSkins) continue; // Skip static models

        animatedCount++;
        console.log(`\n${BOLD}${'═'.repeat(60)}${RESET}`);
        
        // Find asset info
        const dbEntry = Object.values(db).find(a => a.model && path.basename(a.model) === file);
        if (dbEntry) {
          console.log(`  Asset: ${dbEntry.id} | ${dbEntry.characterName || 'Unnamed'}`);
        }

        await analyzeAllVersions(io, file);

      } catch (e) {
        console.log(`  ${RED}Error reading ${file}: ${e.message}${RESET}`);
      }
    }

    console.log(`\n${BOLD}═══════════════════════════════════════════════════════════════${RESET}`);
    console.log(`  Scanned: ${files.length} files | Animated: ${animatedCount} | Issues found: ${brokenCount}`);
  }
}

async function analyzeAllVersions(io, modelFile) {
  const ext = modelFile.endsWith('.gltf') ? '.gltf' : '.glb';
  const baseName = modelFile.substring(0, modelFile.length - ext.length);

  const origPath = path.join(UPLOADS_DIR, modelFile);
  const optPath = path.join(OPTIMIZED_DIR, modelFile);
  const mobilePath = path.join(OPTIMIZED_DIR, `${baseName}.mobile${ext}`);
  const previewPath = path.join(OPTIMIZED_DIR, `${baseName}.preview${ext}`);

  let original = null, optimized = null, mobile = null, preview = null;

  if (fs.existsSync(origPath)) {
    original = await deepAnalyze(io, origPath, 'ORIGINAL');
  }
  if (fs.existsSync(optPath)) {
    optimized = await deepAnalyze(io, optPath, 'OPTIMIZED HD');
  }
  if (fs.existsSync(mobilePath)) {
    mobile = await deepAnalyze(io, mobilePath, 'MOBILE');
  }
  if (fs.existsSync(previewPath)) {
    preview = await deepAnalyze(io, previewPath, 'PREVIEW');
  }

  if ((optimized || mobile || preview) && original) {
    compareResults(original, optimized, mobile, preview);
  }
}

main().catch(err => {
  console.error(`\n${RED}Fatal error:${RESET}`, err);
  process.exit(1);
});
