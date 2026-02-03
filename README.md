# WEBAR - Dragon's Forge

Minimal demo to upload GLB/GLTF models and serve an AR-enabled viewer using `model-viewer`.

## Requirements
- Node.js (16+)

## Install & Run Locally

```bash
npm install
npm start
```

## How to use
- Open `http://localhost:3000` and upload a `.glb` or `.gltf` file (optional audio).
- After upload you get a share URL and QR code.
- Visitors open the URL on a phone; `model-viewer` will enable AR on supported devices.

## Deployment (Render.com)

This project is ready to be deployed on [Render.com](https://render.com).

1. Create a [Render account](https://render.com/).
2. Click **New +** -> **Web Service**.
3. Select **Build and deploy from a Git repository**.
4. Connect this repository: `https://github.com/ltkietsheep204-maker/Web3_UploadAR360-`
5. Settings:
    - **Name**: `webar-demo` (or any name)
    - **Runtime**: `Node`
    - **Build Command**: `npm install`
    - **Start Command**: `node server.js`
6. Click **Create Web Service**.

> **⚠️ WARNING for Free Hosting:**
> On the free tier of Render (and similar services), files uploaded to the server (images/models) will be **deleted** when the server restarts (spins down after inactivity).
> For permanent storage, you would need to integrate a cloud storage service like Cloudinary or AWS S3.
- iOS Quick Look requires `.usdz` for native AR; converting `.glb`→`.usdz` is outside this demo.
- For robust markerless Web AR across many devices, consider WebXR + three.js or a commercial SDK (e.g., 8th Wall).
- This demo stores files on the server filesystem; for production, use cloud storage and authentication.
