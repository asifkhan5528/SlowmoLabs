# Put it online for friends (free, GitHub Pages)

Everything runs in the visitor's browser, so a static host is enough. There is no server to pay for.

## Before you push (optional, 1 minute)

Open `public/config.js` and set `FEEDBACK_URL` to wherever you want comments to go: a Google Form link, or your repo's
`https://github.com/<you>/slowmo-lab/issues/new` page. If you leave it empty, the "Send feedback" button copies the debug
report to the clipboard instead, which testers can paste into a message to you.

## Steps

1. On github.com create a new **public** repository named `slowmo-lab` (free accounts need a public repo for Pages). Leave it empty.
2. In this folder:
   ```
   git init -b main
   git add .
   git commit -m "Slow-Mo Lab"
   git remote add origin https://github.com/<your-username>/slowmo-lab.git
   git push -u origin main
   ```
3. In the repo go to **Settings, Pages, Build and deployment, Source** and choose **GitHub Actions**.
4. Open the **Actions** tab. The "Deploy to GitHub Pages" run builds the site, downloads the model, and publishes it.
   If the first run failed because Pages was not enabled yet, press **Re-run all jobs**.
5. When it is green, the link is `https://<your-username>.github.io/slowmo-lab/`. Send that to your friends.

Every later `git push` to `main` redeploys automatically.

## What your testers need

- Desktop Chrome or Edge (current version). Firefox and Safari do not have everything the app needs.
- A computer with a graphics card for WebGPU. Without it the app still opens but exports crawl, and says so.
- About 20 MB of data for the model on the first visit. After that it is cached.
- The page has a "Try the sample clip" button, so they can test without their own footage.

## Good to know

- The site is public: anyone with the link can open it. Videos are processed on the visitor's own computer and are never uploaded.
- GitHub Pages cannot set the cross-origin headers that let the CPU fallback use several threads. That only matters on
  computers without WebGPU, where exports are slow anyway.
- Netlify and Cloudflare Pages also work: upload the folder made by `npm run build` (`dist`). It includes a `_headers` file
  that enables those threads. Run `npm run build` first and add `models/rife49.onnx` (download it from
  https://huggingface.co/edgetools/rife) before uploading, or let the app fetch the model from Hugging Face on first use.
- To try the built site locally the way GitHub Pages serves it: `npm run build`, then `npm run preview`, then open
  http://localhost:5200/slowmo-lab/
