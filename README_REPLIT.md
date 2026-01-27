Quick Replit import instructions

1. Go to https://replit.com and log in.
2. Click Create → Import from ZIP and upload `webar-replit.zip` (or drag the files into a new Node repl).
3. Confirm `package.json` has `"start": "node server.js"` (already present).
4. Click Run — Replit will install dependencies and start the server. Use the provided public URL to test `/` and `/upload`.

Notes:
- Uploaded files are stored in `public/uploads` inside the repl.
- For persistent, production-grade uploads use S3; ask me and I'll modify `server.js`.
