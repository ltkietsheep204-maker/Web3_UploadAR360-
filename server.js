const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { nanoid } = require('nanoid');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR);
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({}), 'utf8');

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

const upload = multer({ storage });

app.use(express.static(PUBLIC_DIR));

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

    const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    
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
      createdAt: Date.now()
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));

    const url = `${req.protocol}://${req.get('host')}/view/${id}`;
    res.json({ id, url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

app.get('/api/asset/:id', (req, res) => {
  const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  const asset = db[req.params.id];
  if (!asset) return res.status(404).json({ error: 'Not found' });
  res.json(asset);
});

app.get('/view/:id', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'viewer.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
