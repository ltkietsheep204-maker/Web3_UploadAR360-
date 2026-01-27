WEBAR Demo

Minimal demo to upload GLB/GLTF models and serve an AR-enabled viewer using `model-viewer`.

Requirements
- Node.js (16+)

Install & run

```bash
npm install
npm start
```

Usage
- Open `http://localhost:3000` and upload a `.glb` or `.gltf` file (optional audio).
- After upload you get a share URL and QR code.
- Visitors open the URL on a phone; `model-viewer` will enable AR on supported devices.

Notes & limitations
- iOS Quick Look requires `.usdz` for native AR; converting `.glb`→`.usdz` is outside this demo.
- For robust markerless Web AR across many devices, consider WebXR + three.js or a commercial SDK (e.g., 8th Wall).
- This demo stores files on the server filesystem; for production, use cloud storage and authentication.
