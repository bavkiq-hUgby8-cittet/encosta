#!/usr/bin/env node
// Generate PWA icons for Touch? app
// Usage: node scripts/generate-icons.js

const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const ICONS_DIR = path.join(__dirname, '..', 'public', 'icons');

// Ensure directory exists
if (!fs.existsSync(ICONS_DIR)) {
  fs.mkdirSync(ICONS_DIR, { recursive: true });
}

// Touch? logo SVG — dark background with orange "T?" mark
// Design: rounded rect background (#050508), stylized "T?" in orange gradient
function createIconSVG(size, maskable = false) {
  const padding = maskable ? Math.round(size * 0.15) : 0;
  const innerSize = size - padding * 2;
  const fontSize = Math.round(innerSize * 0.48);
  const questionSize = Math.round(innerSize * 0.28);
  const borderRadius = maskable ? 0 : Math.round(size * 0.18);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#0a0a14"/>
      <stop offset="100%" style="stop-color:#050508"/>
    </linearGradient>
    <linearGradient id="txt" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#ff7a42"/>
      <stop offset="100%" style="stop-color:#ff9966"/>
    </linearGradient>
    <filter id="glow">
      <feGaussianBlur stdDeviation="${Math.round(size * 0.015)}" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
  </defs>
  <rect x="0" y="0" width="${size}" height="${size}" rx="${borderRadius}" fill="url(#bg)"/>
  <circle cx="${size * 0.5}" cy="${size * 0.5}" r="${innerSize * 0.35}" fill="rgba(255,107,53,0.06)"/>
  <text x="${size * 0.42}" y="${size * 0.56}" font-family="'Helvetica Neue',Arial,sans-serif" font-size="${fontSize}" font-weight="800" fill="url(#txt)" text-anchor="middle" dominant-baseline="central" filter="url(#glow)">T</text>
  <text x="${size * 0.72}" y="${size * 0.48}" font-family="'Helvetica Neue',Arial,sans-serif" font-size="${questionSize}" font-weight="700" fill="#ff9966" text-anchor="middle" dominant-baseline="central">?</text>
  <circle cx="${size * 0.5}" cy="${size * 0.82}" r="${Math.round(size * 0.02)}" fill="rgba(255,107,53,0.5)"/>
</svg>`;
}

const SIZES = [48, 72, 96, 128, 144, 192, 256, 384, 512];
const MASKABLE_SIZES = [192, 512];

async function generateIcons() {
  console.log('Generating PWA icons...');

  // Regular icons
  for (const size of SIZES) {
    const svg = createIconSVG(size, false);
    const outputPath = path.join(ICONS_DIR, `icon-${size}.png`);
    await sharp(Buffer.from(svg))
      .resize(size, size)
      .png({ quality: 100, compressionLevel: 9 })
      .toFile(outputPath);
    console.log(`  Created icon-${size}.png`);
  }

  // Maskable icons (with safe area padding)
  for (const size of MASKABLE_SIZES) {
    const svg = createIconSVG(size, true);
    const outputPath = path.join(ICONS_DIR, `maskable-${size}.png`);
    await sharp(Buffer.from(svg))
      .resize(size, size)
      .png({ quality: 100, compressionLevel: 9 })
      .toFile(outputPath);
    console.log(`  Created maskable-${size}.png`);
  }

  // Favicon (32x32)
  const faviconSvg = createIconSVG(32, false);
  const faviconPath = path.join(__dirname, '..', 'public', 'favicon.ico');
  await sharp(Buffer.from(faviconSvg))
    .resize(32, 32)
    .png()
    .toFile(faviconPath);
  console.log('  Created favicon.ico');

  // Apple touch icon (180x180)
  const appleSvg = createIconSVG(180, false);
  const applePath = path.join(ICONS_DIR, 'apple-touch-icon.png');
  await sharp(Buffer.from(appleSvg))
    .resize(180, 180)
    .png({ quality: 100 })
    .toFile(applePath);
  console.log('  Created apple-touch-icon.png');

  console.log('\nAll icons generated successfully!');
}

generateIcons().catch(console.error);
