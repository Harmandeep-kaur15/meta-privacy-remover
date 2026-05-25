MetaGuard — Local Privacy Cleaner

Overview

MetaGuard is a local-first privacy tool that inspects and removes hidden metadata from images, videos, PDFs, and Office documents. All processing happens on your machine; files are not uploaded to third-party services.

Quick start (Windows)

1. Install dependencies:

```powershell
npm install
```

2. Start the local server:

```powershell
npm start
# server listens on http://localhost:3000
```

3. Open the app in your browser at `http://localhost:3000` (recommended) or open `index.html` directly and click "Open Local Server" to toggle API mode.

Notes on features and options

- `enableBlur` (Auto-Blur Faces): accepted by the frontend and passed to the server, but AI-based face detection and blurring is not implemented in this offline distribution. Requesting blur will be logged and skipped. Implementing local AI blur requires adding a face-detection + image-processing model (e.g., OpenCV + a face detector or a lightweight ONNX model).

- Selective metadata controls:
  - `removeGPS`, `removeDevice`, `removeDateTime`, `removeAuthor` — these control whether metadata is stripped for images, PDFs, and Office documents. When all options are unchecked the server will return the original file unchanged.
  - `removeAnnotations` — for PDFs, this flattens and removes annotation dictionaries and AcroForms when requested.

Troubleshooting

- If the browser is opened from `file://`, the app will default `apiBase` to `http://localhost:3000`. Start the local server before using the clean/upload features.
- Large files: the server accepts files up to 150 MB by default (see the multer limits in `server.js`).

Where to next

- To enable offline AI blur, add a lightweight face detector library and a blur pipeline to `server.js` (not included).
- Improve PDF image support for non-JPEG embedded images (JPX/Flate) by adding conversion handlers.

Static deployment / run without localhost

- If you want to avoid starting a local server every time, deploy the site as a static website.
- Recommended hosts: GitHub Pages, Netlify, or Vercel.
- With a static host, you only need to upload the repo once and then open the hosted URL in any browser.
- If you still want local access without a server, open `index.html` directly in the browser, but note that server/API features may not work unless the backend is running.

Example GitHub Pages steps:
1. Create a GitHub repository and push this project.
2. In GitHub repo settings, enable Pages from the `main` branch and set the publish folder to `/`.
3. Open the generated GitHub Pages URL in your browser.

Example Netlify/Vercel steps:
1. Connect your GitHub repo to Netlify or Vercel.
2. Set the build command to `npm install` (if needed) and the publish directory to the repo root.
3. Deploy and use the provided URL.

Files changed in this session

- `server.js` — option mapping, PDF fixes, and resilient stream handling
- `index.html` — UI note about blur
- `styles.css` — tip-card icon styles
- `assets/` — added several `tip_*.svg` icons

