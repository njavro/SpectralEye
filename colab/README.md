# Sionna RT on Colab — first-time setup

This directory contains the Colab notebook that runs **NVIDIA Sionna RT** —
the high-fidelity ray-traced RF propagation engine — on a remote GPU and
exposes it to your local SpectralEye backend over an internet tunnel.

If you've never used Colab, follow each section in order. Total setup
time: **~10 minutes** the first run, ~2 minutes for subsequent sessions.

## What is Colab?

Google Colab is a free hosted Jupyter notebook service. We use it because
Sionna RT requires a CUDA GPU, which your Mac doesn't have. The notebook
runs on Google's GPU machines; your local app talks to it over an HTTPS
tunnel.

The free tier works but has tight session limits and slow / unreliable
GPU access. **Colab Pro ($10/month)** gives you a guaranteed T4 GPU and
much longer sessions — strongly recommended for a working dev loop. You
can buy it at <https://colab.research.google.com/signup>.

## What you'll need

- A Google account (free).
- Colab Pro subscription (recommended, $10/month).
- The notebook file `spectraleye_sionna.ipynb` in this directory.
- Your local SpectralEye backend running.

## Step-by-step

### 1. Open the notebook in Colab

1. Open <https://colab.research.google.com>.
2. Sign in with your Google account.
3. Click **File → Upload notebook** and pick
   `colab/spectraleye_sionna.ipynb` from this repo.
4. The notebook opens with all cells visible. Don't run anything yet.

### 2. Switch to a GPU runtime

1. Top menu: **Runtime → Change runtime type**.
2. Select **T4 GPU** (free) or **A100 GPU** (Pro+ only) under "Hardware
   accelerator".
3. Click **Save**.
4. The runtime restarts. Wait until you see "Connected" in the top right.

If you don't see GPU options, your Colab account doesn't currently have
GPU access — sign up for Pro.

### 3. Run the cells

1. Click anywhere in the first code cell (the install).
2. Press **Shift+Enter**. The cell runs (~3 minutes for first install) and
   moves you to the next cell.
3. Keep pressing **Shift+Enter** to run each subsequent cell.
4. When you reach the FastAPI cell ("Step 5"), it starts the server in the
   background and the cell finishes immediately.
5. The last cell (Step 6 — cloudflared tunnel) prints a public URL after
   ~10-30 seconds. It looks like:

   ```
   PUBLIC URL: https://random-words-1234.trycloudflare.com
   ```

### 4. Wire the URL into your local backend

1. Copy the printed URL.
2. On your local machine, edit `backend/.env` (create from
   `backend/.env.example` if it doesn't exist).
3. Add the line:
   ```
   SIONNA_REMOTE_URL=https://random-words-1234.trycloudflare.com
   ```
4. Restart the local backend:
   ```bash
   # in backend/
   source .venv/bin/activate
   uvicorn app.main:app --reload
   ```
5. The backend startup log should print `Sionna source: RemoteSionnaSource`.

### 5. Verify

1. Open the SpectralEye UI.
2. Mark an AOI and place an asset (or use Report Current Deployment).
3. Click **Show EMS Footprint** on an asset.
4. Watch the **Colab notebook output** in your browser — you should see
   `Querying OSM for buildings...` and `Sionna coverage computed in Xs`.
5. The coverage volume rendered in the SpectralEye scene now reflects
   real ray-traced values. Expect sharp shadows behind buildings and
   asymmetric lobes (multipath effects) — distinct from the smooth
   spherical mock volume.

## When the session ends

Colab idle-disconnects after ~90 minutes (longer with Pro). When that
happens:

- The cloudflared URL stops working.
- Your local backend will get connection errors when it tries `/coverage/sionna`.
- The local app falls back to the mock if `SIONNA_REMOTE_URL` is unset, but
  not if it's set and the URL is dead — backend will return 5xx errors.

To get back online:

1. In the Colab notebook, hit **Runtime → Run all** (or re-run cells).
2. Cell 6 prints a **new** URL each time.
3. Update `SIONNA_REMOTE_URL` in `backend/.env` and restart backend.

To always run with the mock when no Colab is up:

```
# .env
# SIONNA_REMOTE_URL=  (unset)
```

Backend uses MockSionnaSource transparently in that case.

## Things that can go wrong

- **"GPU not detected"** in the Imports cell → wrong runtime. Repeat Step 2.
- **Install cell takes >10 minutes** → Colab is slow, just wait. Don't
  re-run.
- **Cloudflared cell prints no URL** → cloudflared download failed. Re-run
  the install cell.
- **Local backend logs `connection refused` to the cloudflared URL** →
  the Colab session ended. Re-run notebook, get new URL.
- **Coverage volumes look wrong / empty** → Sionna scene-build failed for
  that AOI (no buildings in OSM, or scene too large). Try a smaller AOI
  centered on a denser area.
