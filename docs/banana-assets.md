# Banana & monkey imagery for Monkeyland

Ways to get banana (or monkey) pictures for the app without shipping large assets.

## 1. **Emoji (no assets)**

- Use Unicode: 🍌 🐵 🦍
- Already used in the header (🍌). Safe, no licensing, works everywhere.

## 2. **Free stock / CC0**

- **Unsplash** – [unsplash.com/s/photos/banana](https://unsplash.com/s/photos/banana) (free, high-res).
- **Pexels** – [pexels.com/search/banana](https://pexels.com/search/banana).
- **Pixabay** – [pixabay.com/images/search/banana](https://pixabay.com/images/search/banana).
- **OpenMoji** – [openmoji.org](https://openmoji.org) – CC-BY-SA banana/monkey SVGs.

Download, optionally resize/optimize, and put under `public/` (e.g. `public/banana.svg`, `public/banana.png`).

## 3. **AI image generation**

- **Cursor / IDE** – You can ask the AI to generate an image (e.g. “simple banana icon, flat style”) and save it under `public/`.
- **DALL·E, Midjourney, Stable Diffusion, etc.** – Generate “banana icon flat design” or “stylized banana logo”, then export and add to `public/`.

## 4. **Inline SVG (current favicon)**

- `public/favicon.svg` is already a simple banana icon (no external images).
- You can copy or adapt that SVG for in-app use (e.g. in a component or as a small logo).

## 5. **Using an image in the UI**

Reference from HTML/React:

- From `public/`: `<img src="/banana.png" alt="Banana" />`
- Or import in a component: `import banana from './banana.png'` and use the imported path.

For a consistent “Monkeyland” look, prefer simple, flat banana or monkey icons rather than photorealistic images.
