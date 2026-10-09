const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

async function prepare(name, input) {
  const out = path.resolve(__dirname, '../assets/interactions');
  fs.mkdirSync(path.join(out, 'source'), { recursive: true });
  const source = path.join(out, 'source', name + '.png');
  fs.copyFileSync(input, source);
  const meta = await sharp(source).metadata();
  const { data, info } = await sharp(source).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let transparent = 0, opaque = 0;
  for (let i = 3; i < data.length; i += info.channels) {
    if (data[i] === 0) transparent++;
    if (data[i] === 255) opaque++;
  }
  if (!meta.hasAlpha || !transparent || !opaque) throw new Error(name + ': expected real transparent and opaque pixels');
  const webp = path.join(out, name + '.webp');
  await sharp(source).resize(name === 'eku-review' ? 512 : 256, name === 'eku-review' ? 512 : 256, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 86, alphaQuality: 100, effort: 6 }).toFile(webp);
  const final = await sharp(webp).metadata();
  console.log(JSON.stringify({ name, source: `${meta.width}x${meta.height}`, transparentPercent: Math.round(transparent / (info.width * info.height) * 100), webp: `${final.width}x${final.height}`, webpBytes: fs.statSync(webp).size, alpha: final.hasAlpha }));
}

(async () => {
  for (const item of process.argv.slice(2)) {
    const index = item.indexOf('=');
    if (index < 1) throw new Error('Use name=absolute-input-path');
    await prepare(item.slice(0, index), item.slice(index + 1));
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
