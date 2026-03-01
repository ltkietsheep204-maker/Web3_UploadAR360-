const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { nanoid } = require('nanoid');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ═══════════════════════════════════════════════════════════════════
// PERFORMANCE: Compression & Caching
// ═══════════════════════════════════════════════════════════════════
let compression;
try {
  compression = require('compression');
  app.use(compression({
    level: 6,
    threshold: 1024,
    filter: (req, res) => {
      // GLB files are already compressed binary - gzip adds very little (5-10%)
      // and strips Content-Length header → progress bar can't show accurate %
      if (req.path.match(/\.(glb)$/i)) return false;
      // Compress text-based formats normally
      if (req.path.match(/\.(gltf|fbx|json)$/i)) return true;
      return compression.filter(req, res);
    }
  }));
} catch (e) {
  console.log('compression module not found, skipping');
}

const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
const OPTIMIZED_DIR = path.join(UPLOADS_DIR, 'optimized');
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR);
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(OPTIMIZED_DIR)) fs.mkdirSync(OPTIMIZED_DIR, { recursive: true });
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({}), 'utf8');

// ═══════════════════════════════════════════════════════════════════
// OPTIMIZATION TRACKING: Know which models are currently being optimized
// ═══════════════════════════════════════════════════════════════════
const optimizingModels = new Map(); // modelFile -> { startTime, assetId }

// ═══════════════════════════════════════════════════════════════════
// OPTIMIZER SPAWN: Reusable — called on upload AND on server startup
// Uses --max-old-space-size to prevent OOM on Railway (512MB container)
// ═══════════════════════════════════════════════════════════════════
function spawnOptimizer(modelFile, assetId) {
  if (optimizingModels.has(modelFile)) {
    console.log(`⏭️ Already optimizing ${modelFile}, skip duplicate`);
    return;
  }
  const modelFullPath = path.join(UPLOADS_DIR, modelFile);
  if (!fs.existsSync(modelFullPath)) {
    console.log(`⚠️ spawnOptimizer: file not found: ${modelFile}`);
    return;
  }
  const modelSizeMB = (fs.statSync(modelFullPath).size / (1024 * 1024)).toFixed(1);
  console.log(`🔧 Optimizing ${modelFile} (${modelSizeMB}MB) for asset ${assetId}...`);
  optimizingModels.set(modelFile, { startTime: Date.now(), assetId });
  const { spawn } = require('child_process');
  // --max-old-space-size=768 → caps Node RAM at 768MB, prevents Railway OOM kill
  const child = spawn('node', ['--max-old-space-size=768', 'optimize_models.mjs', modelFullPath], {
    cwd: __dirname,
    stdio: 'inherit',
    detached: false
  });
  child.on('close', (code) => {
    optimizingModels.delete(modelFile);
    if (code === 0) {
      console.log(`✅ Optimization done: ${modelFile}`);
    } else {
      console.log(`⚠️ Optimization failed (code ${code}): ${modelFile} — original will be served`);
    }
  });
  child.on('error', (err) => {
    optimizingModels.delete(modelFile);
    console.log(`❌ Optimizer spawn error: ${err.message}`);
  });
  child.unref();
}

// ═══════════════════════════════════════════════════════════════════
// PERFORMANCE: Cache DB in memory instead of reading file every time
// ═══════════════════════════════════════════════════════════════════
let dbCache = null;
function getDB() {
  if (!dbCache) {
    dbCache = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  }
  return dbCache;
}
function saveDB(db) {
  dbCache = db;
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// ═══════════════════════════════════════════════════════════════════
// ANIMATION EXTRACTION: Parse GLB binary → get animation clip names
// No extra dependency — reads the JSON chunk directly from the binary
// ═══════════════════════════════════════════════════════════════════
function extractGLBAnimations(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    if (buf.length < 20) return [];
    if (buf.readUInt32LE(0) !== 0x46546C67) return []; // not 'glTF' magic
    const jsonLength = buf.readUInt32LE(12);
    const json = JSON.parse(buf.slice(20, 20 + jsonLength).toString('utf8'));
    return (json.animations || []).map((a, i) => ({ name: a.name || `Animation ${i}`, index: i }));
  } catch (e) {
    console.log('extractGLBAnimations error:', e.message);
    return [];
  }
}

function cleanAnimDisplayName(name) {
  let n = name.replace(/ Retarget$/, '');                    // strip " Retarget"
  const pipe = n.lastIndexOf('|');
  if (pipe !== -1) n = n.slice(pipe + 1);                    // strip "Armature|mixamo.com|" prefix
  n = n.replace(/^Layer0$/, 'Hoạt cảnh 1');                  // Layer0 → Hoạt cảnh 1
  n = n.replace(/^Layer0\.(\d+)$/, (_, d) => `Hoạt cảnh ${parseInt(d) + 2}`); // Layer0.001 → Hoạt cảnh 3
  return n.trim() || name;
}

function deduplicateAnimations(rawAnims) {
  if (!rawAnims.length) return [];
  // Only keep Retarget clips (they are re-baked to the model's actual skeleton)
  const retargetAnims = rawAnims.filter(a => a.name.endsWith(' Retarget'));
  // If no Retarget clips exist, fall back to all clips
  const useAnims = retargetAnims.length > 0 ? retargetAnims : rawAnims;
  return useAnims.map(a => ({ clipIndex: a.index, name: a.name, displayName: cleanAnimDisplayName(a.name) }));
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, UPLOADS_DIR);
  },
  filename: function (req, file, cb) {
    const id = req._uploadId || nanoid(8);
    const ext = path.extname(file.originalname);
    cb(null, `${id}-${file.fieldname}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 } // 500MB max
});

// ═══════════════════════════════════════════════════════════════════
// PERFORMANCE: Smart model serving - prefer optimized version
// Handles both /uploads/:file AND /uploads/optimized/:file
// ═══════════════════════════════════════════════════════════════════
function serveModelFile(req, res, next) {
  const filename = req.params.filename || req.params[0];
  if (!filename || !filename.match(/\.(glb|gltf)$/i)) return next();

  // Determine file path - check optimized first, then original
  const optimizedPath = path.join(OPTIMIZED_DIR, filename);
  const originalPath = path.join(UPLOADS_DIR, filename);
  const filePath = fs.existsSync(optimizedPath) ? optimizedPath : originalPath;

  // LOG: Track what's being served to help debug mobile issues
  const ua = req.headers['user-agent'] || 'Unknown';
  const isMobile = /iPhone|iPad|Android/i.test(ua);
  const sizeMB = fs.existsSync(filePath) ? (fs.statSync(filePath).size / 1024 / 1024).toFixed(1) : '?';
  console.log(`📡 [${isMobile ? 'MOBILE' : 'DESKTOP'}] Serving: ${filename} (${sizeMB}MB) from ${filePath === optimizedPath ? 'OPTIMIZED' : 'ORIGINAL'} → ${req.ip}`);

  if (!fs.existsSync(filePath)) return next();

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;

  // PERF: Model files have unique IDs in filename (nanoid) → they NEVER change
  // Safe to cache immutably for 1 year — browser will never re-download
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.setHeader('Content-Type', filename.endsWith('.glb') ? 'model/gltf-binary' : 'model/gltf+json');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Last-Modified', stat.mtime.toUTCString());
  res.setHeader('X-Optimized', fs.existsSync(optimizedPath) ? 'true' : 'false');

  // Support Range requests for streaming/resume
  const range = req.headers.range;
  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunkSize = (end - start) + 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Content-Length': chunkSize,
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.setHeader('Content-Length', fileSize);
    fs.createReadStream(filePath).pipe(res);
  }
}
app.get('/uploads/optimized/:filename', serveModelFile);
app.get('/uploads/:filename', serveModelFile);

// ═══════════════════════════════════════════════════════════════════
// Static files - NO aggressive caching to prevent stale mobile files
// ═══════════════════════════════════════════════════════════════════
app.use('/uploads', express.static(path.join(PUBLIC_DIR, 'uploads'), {
  maxAge: '7d', // 1 week — upload files have unique IDs, safe to cache long
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    // Upload files have unique nanoid names → immutable for models, 1-week for others
    if (filePath.match(/\.(glb|gltf|fbx)$/i)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=604800'); // 1 week
    }
    res.setHeader('Accept-Ranges', 'bytes');
  }
}));

app.use(express.static(PUBLIC_DIR, {
  maxAge: 0,
  etag: true,
  setHeaders: (res, filePath) => {
    // Force browser to always revalidate HTML/JS files
    res.setHeader('Cache-Control', 'no-cache');
  }
}));

app.post('/upload', (req, res, next) => {
  req._uploadId = nanoid(8);
  next();
}, upload.fields([
  { name: 'model', maxCount: 1 },
  { name: 'audio', maxCount: 1 },
  { name: 'groundImage', maxCount: 1 },
  { name: 'envImage', maxCount: 1 },
  { name: 'props', maxCount: 20 }
]), (req, res) => {
  try {
    const id = req._uploadId;
    const modelFile = req.files['model'] && req.files['model'][0] ? path.basename(req.files['model'][0].filename) : null;
    const audioFile = req.files['audio'] && req.files['audio'][0] ? path.basename(req.files['audio'][0].filename) : null;
    const groundFile = req.files['groundImage'] && req.files['groundImage'][0] ? path.basename(req.files['groundImage'][0].filename) : null;
    const envFile = req.files['envImage'] && req.files['envImage'][0] ? path.basename(req.files['envImage'][0].filename) : null;
    const propsFiles = req.files['props'] ? req.files['props'].map(f => `/uploads/${path.basename(f.filename)}`) : [];

    if (!modelFile) return res.status(400).json({ error: 'Model file is required (glb/gltf).' });

    const db = getDB();

    // Parse animations safely
    let animations = [];
    if (req.body.animations) {
      try {
        const animData = Array.isArray(req.body.animations) ? req.body.animations[req.body.animations.length - 1] : req.body.animations;
        if (animData && animData !== '[]' && animData.trim()) {
          animations = JSON.parse(animData);
        }
      } catch (e) {
        console.log('Could not parse animations:', req.body.animations);
      }
    }

    // Parse effects safely
    let effects = [];
    if (req.body.effects) {
      try {
        const effectData = Array.isArray(req.body.effects) ? req.body.effects[req.body.effects.length - 1] : req.body.effects;
        if (effectData && effectData !== '[]' && effectData.trim()) {
          effects = JSON.parse(effectData);
        }
      } catch (e) {
        console.log('Could not parse effects:', req.body.effects);
      }
    }

    // Extract animations from GLB file (server-side, reliable)
    let detectedAnimations = [];
    if (modelFile && modelFile.endsWith('.glb')) {
      try {
        const rawAnims = extractGLBAnimations(path.join(UPLOADS_DIR, modelFile));
        detectedAnimations = deduplicateAnimations(rawAnims);
        if (detectedAnimations.length > 0) {
          console.log(`🎬 Detected ${rawAnims.length} clips → ${detectedAnimations.length} unique after dedup`);
        }
      } catch (e) {
        console.log('Animation detection skipped:', e.message);
      }
    }

    db[id] = {
      id,
      model: `/uploads/${modelFile}`,
      audio: audioFile ? `/uploads/${audioFile}` : null,
      groundImage: groundFile ? `/uploads/${groundFile}` : null,
      envImage: envFile ? `/uploads/${envFile}` : null,
      props: propsFiles,
      modelY: parseFloat(req.body.modelY) || 0,
      caption: req.body.caption || null,
      // Character info for AR HUD
      characterName: req.body.characterName || 'Vị Tướng',
      characterEra: req.body.characterEra || '',
      characterBio: req.body.characterBio || '',
      characterHeight: parseFloat(req.body.characterHeight) || 170,
      characterStats: {
        strength: parseInt(req.body.statStrength) || 80,
        strategy: parseInt(req.body.statStrategy) || 80,
        leadership: parseInt(req.body.statLeadership) || 80,
        defense: parseInt(req.body.statDefense) || 80
      },
      animations: detectedAnimations,
      createdAt: Date.now()
    };
    saveDB(db);

    // Auto-optimize GLB on upload — always run, no size skip
    // spawnOptimizer handles memory limit + dedup guard internally
    if (modelFile && modelFile.endsWith('.glb')) {
      const modelFullPath = path.join(UPLOADS_DIR, modelFile);
      const modelSizeMB = (fs.statSync(modelFullPath).size / (1024 * 1024)).toFixed(1);
      if (parseFloat(modelSizeMB) > 500) {
        console.log(`⏭️ ${modelFile} is ${modelSizeMB}MB — too large to optimize, serving original`);
      } else {
        spawnOptimizer(modelFile, id);
      }
    }

    const url = `${req.protocol}://${req.get('host')}/view/${id}`;
    res.json({ id, url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// MULTER ERROR HANDLER — Catches file-too-large and other multer errors
// Without this middleware, multer errors crash the Express process!
// ═══════════════════════════════════════════════════════════════════
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    console.warn(`⚠️ Multer error: ${err.code} — ${err.message}`);
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        error: 'File quá lớn! Giới hạn tối đa là 500MB. Vui lòng nén file hoặc giảm chất lượng texture trước khi upload.'
      });
    }
    if (err.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({ error: 'Quá nhiều file! Tối đa 20 props.' });
    }
    return res.status(400).json({ error: `Lỗi upload: ${err.message}` });
  }

  // Handle other errors (e.g. invalid file type)
  if (err) {
    console.error('Unexpected error:', err);
    return res.status(500).json({ error: err.message || 'Đã xảy ra lỗi không xác định' });
  }

  next();
});

app.get('/api/asset/:id', (req, res) => {
  const db = getDB();
  const asset = db[req.params.id];
  if (!asset) return res.status(404).json({ error: 'Not found' });

  // Include optimized model path info
  const modelFile = asset.model ? path.basename(asset.model) : null;
  let modelSize = 0;
  let isOptimized = false;
  let previewModel = null;
  let mobileModel = null;

  if (modelFile) {
    const optimizedPath = path.join(OPTIMIZED_DIR, modelFile);
    const originalPath = path.join(UPLOADS_DIR, modelFile);

    const isGltf = modelFile.toLowerCase().endsWith('.gltf');
    const ext = isGltf ? '.gltf' : '.glb';
    const baseName = modelFile.substring(0, modelFile.length - ext.length);
    const previewFileName = `${baseName}.preview${ext}`;
    const previewPath = path.join(OPTIMIZED_DIR, previewFileName);
    const mobileFileName = `${baseName}.mobile${ext}`;
    const mobilePath = path.join(OPTIMIZED_DIR, mobileFileName);

    if (fs.existsSync(previewPath)) {
      previewModel = `/uploads/optimized/${previewFileName}`;
    }

    if (fs.existsSync(mobilePath)) {
      mobileModel = `/uploads/optimized/${mobileFileName}`;
    }

    if (modelFile.endsWith('.glb') && fs.existsSync(optimizedPath)) {
      modelSize = fs.statSync(optimizedPath).size;
      isOptimized = true;
      // Serve directly from optimized path (no query string - it breaks .glb detection on client)
      asset.model = `/uploads/optimized/${modelFile}`;
    } else if (fs.existsSync(originalPath)) {
      modelSize = fs.statSync(originalPath).size;
    }
  }

  // Check if this model is currently being optimized
  const isCurrentlyOptimizing = modelFile ? optimizingModels.has(modelFile) : false;
  const optimizeInfo = isCurrentlyOptimizing ? optimizingModels.get(modelFile) : null;

  res.json({
    ...asset,
    modelSize,
    isOptimized,
    previewModel,
    mobileModel,
    // Tell client if Draco decoding is needed
    needsDraco: isOptimized,
    // Tell client if optimization is in progress
    optimizing: isCurrentlyOptimizing,
    optimizeStartTime: optimizeInfo?.startTime || null
  });
});

// ═══════════════════════════════════════════════════════════════════
// API: Check optimization status (lightweight polling endpoint)
// ═══════════════════════════════════════════════════════════════════
app.get('/api/optimize-status/:id', (req, res) => {
  const db = getDB();
  const asset = db[req.params.id];
  if (!asset) return res.status(404).json({ error: 'Not found' });

  const modelFile = asset.model ? path.basename(asset.model) : null;
  if (!modelFile) return res.json({ optimizing: false, ready: false });

  let isStillOptimizing = optimizingModels.has(modelFile);

  // Check if optimized version now exists
  const optimizedPath = path.join(OPTIMIZED_DIR, modelFile);
  const optimizedExists = fs.existsSync(optimizedPath);

  // ── AUTO-HEAL: If not optimized and not running (e.g. after server restart)
  // re-trigger optimization automatically so next poll will see it complete
  if (!optimizedExists && !isStillOptimizing) {
    const originalPath = path.join(UPLOADS_DIR, modelFile);
    if (fs.existsSync(originalPath)) {
      const sizeMB = fs.statSync(originalPath).size / (1024 * 1024);
      if (sizeMB <= 500) {
        console.log(`🔄 optimize-status: re-triggering missed optimization for ${modelFile}`);
        spawnOptimizer(modelFile, asset.id || req.params.id);
        isStillOptimizing = true; // tell client to keep polling
      }
    }
  }

  // Also check for mobile model
  const ext = modelFile.toLowerCase().endsWith('.gltf') ? '.gltf' : '.glb';
  const baseName = modelFile.substring(0, modelFile.length - ext.length);
  const mobilePath = path.join(OPTIMIZED_DIR, `${baseName}.mobile${ext}`);
  const mobileExists = fs.existsSync(mobilePath);

  let optimizedSize = 0;
  let mobileSize = 0;
  if (optimizedExists) optimizedSize = fs.statSync(optimizedPath).size;
  if (mobileExists) mobileSize = fs.statSync(mobilePath).size;

  res.json({
    optimizing: isStillOptimizing,
    ready: optimizedExists,
    optimizedModel: optimizedExists ? `/uploads/optimized/${modelFile}` : null,
    mobileModel: mobileExists ? `/uploads/optimized/${baseName}.mobile${ext}` : null,
    optimizedSize,
    mobileSize,
    elapsedMs: isStillOptimizing ? Date.now() - optimizingModels.get(modelFile).startTime : 0
  });
});

app.get('/view/:id', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'viewer.html'));
});

// ═══════════════════════════════════════════════════════════════════
// API: List all uploaded models (for collection/discovery)
// ═══════════════════════════════════════════════════════════════════
app.get('/api/assets', (req, res) => {
  const db = getDB();
  const list = Object.values(db).map(a => ({
    id: a.id,
    characterName: a.characterName || 'Vị Tướng',
    characterEra: a.characterEra || '',
    characterHeight: a.characterHeight || 170,
    createdAt: a.createdAt
  }));
  res.json(list);
});

// ═══════════════════════════════════════════════════════════════════
// API: Check if user is near a historical site (for location-based unlock)
// ═══════════════════════════════════════════════════════════════════
const HISTORICAL_SITES = [
  { id: 'rach-gam', name: 'Rạch Gầm - Xoài Mút', lat: 10.35, lng: 106.52, radius: 2000 },
  { id: 'bach-dang', name: 'Sông Bạch Đằng', lat: 20.93, lng: 106.73, radius: 2000 },
  { id: 'chi-lang', name: 'Ải Chi Lăng', lat: 21.58, lng: 106.57, radius: 2000 },
  { id: 'dong-da', name: 'Gò Đống Đa', lat: 21.01, lng: 105.83, radius: 1000 },
  { id: 'nhu-nguyet', name: 'Sông Như Nguyệt', lat: 21.22, lng: 106.07, radius: 2000 },
  { id: 'van-kiep', name: 'Vạn Kiếp', lat: 21.1, lng: 106.48, radius: 2000 },
  { id: 'lam-son', name: 'Lam Sơn', lat: 20.02, lng: 105.62, radius: 2000 },
  { id: 'hoa-lu', name: 'Cố đô Hoa Lư', lat: 20.28, lng: 105.92, radius: 1500 }
];

function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

app.get('/api/nearby', (req, res) => {
  const { lat, lng } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: 'lat and lng required' });

  const userLat = parseFloat(lat);
  const userLng = parseFloat(lng);

  const nearby = HISTORICAL_SITES.map(site => {
    const dist = haversineDistance(userLat, userLng, site.lat, site.lng);
    return { ...site, distance: Math.round(dist), isNear: dist <= site.radius };
  }).sort((a, b) => a.distance - b.distance);

  res.json(nearby);
});

// ═══════════════════════════════════════════════════════════════════
// PROCESS-LEVEL ERROR HANDLERS — Keep server alive on unexpected errors
// ═══════════════════════════════════════════════════════════════════
process.on('uncaughtException', (err) => {
  console.error('🔥 Uncaught Exception (server still running):', err.message);
  console.error(err.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('🔥 Unhandled Rejection (server still running):', reason);
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);

  // ── STARTUP SCAN: Re-trigger optimization for any models missing optimized files
  // This covers the case where Railway restarted and lost in-memory state
  setTimeout(() => {
    try {
      const db = getDB();
      const pending = Object.entries(db).filter(([, asset]) => {
        if (!asset.model) return false;
        const modelFile = path.basename(asset.model);
        if (!modelFile.endsWith('.glb')) return false;
        const optimizedPath = path.join(OPTIMIZED_DIR, modelFile);
        const originalPath = path.join(UPLOADS_DIR, modelFile);
        return !fs.existsSync(optimizedPath) && fs.existsSync(originalPath);
      });
      if (pending.length === 0) {
        console.log('✅ Startup scan: all models already optimized');
        return;
      }
      console.log(`🔄 Startup scan: ${pending.length} model(s) need optimization`);
      // Stagger each optimization 8s apart to avoid RAM spikes
      pending.forEach(([id, asset], i) => {
        const modelFile = path.basename(asset.model);
        setTimeout(() => spawnOptimizer(modelFile, id), i * 8000);
      });
    } catch (e) {
      console.log('Startup scan error:', e.message);
    }
  }, 5000); // wait 5s after server is ready
});

// Set server timeout to 10 minutes for large 3D model uploads
server.timeout = 10 * 60 * 1000; // 10 minutes
server.keepAliveTimeout = 120 * 1000; // 2 minutes
server.headersTimeout = 10 * 60 * 1000 + 1000; // slightly more than server.timeout
