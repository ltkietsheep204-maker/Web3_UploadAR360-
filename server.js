const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { nanoid } = require('nanoid');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ═══════════════════════════════════════════════════════════════════
// PERFORMANCE: Compression & Caching
// ═══════════════════════════════════════════════════════════════════
// Enable gzip compression
let compression;
try { compression = require('compression'); app.use(compression()); } catch(e) {
  console.log('compression module not found, skipping');
}

const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR);
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({}), 'utf8');

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
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB max
});

// ═══════════════════════════════════════════════════════════════════
// PERFORMANCE: Static files with aggressive caching for uploads
// ═══════════════════════════════════════════════════════════════════
app.use('/uploads', express.static(path.join(PUBLIC_DIR, 'uploads'), {
  maxAge: '7d',
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    // GLB/GLTF/FBX files - cache aggressively
    if (filePath.match(/\.(glb|gltf|fbx)$/i)) {
      res.setHeader('Cache-Control', 'public, max-age=604800');
    }
  }
}));

app.use(express.static(PUBLIC_DIR, {
  maxAge: '1h',
  etag: true
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
      createdAt: Date.now()
    };
    saveDB(db);

    const url = `${req.protocol}://${req.get('host')}/view/${id}`;
    res.json({ id, url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

app.get('/api/asset/:id', (req, res) => {
  const db = getDB();
  const asset = db[req.params.id];
  if (!asset) return res.status(404).json({ error: 'Not found' });
  res.json(asset);
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
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
