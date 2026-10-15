// Renders stage.html frame by frame with the installed Chrome.
//   node render.js <framesDir>                 all 1440 frames, 0000.jpg …
//   node render.js <outDir> --probe 1.5,7.2    one PNG per instant, to look at
// Needs playwright-core next to it (npm i playwright-core) and Chrome.
const { chromium } = require('playwright-core');
const fs = require('fs'), path = require('path');
const FPS = 24, DUR = 60, N = FPS * DUR;
const out = process.argv[2];
const probe = process.argv.includes('--probe') ? process.argv[process.argv.indexOf('--probe') + 1].split(',').map(Number) : null;
// --range 912-1080 re-renders only those frames (after a fix to one scene).
const range = process.argv.includes('--range') ? process.argv[process.argv.indexOf('--range') + 1].split('-').map(Number) : [0, N];
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PAGE = 'file:///' + path.resolve(__dirname, 'stage.html').replace(/\\/g, '/') + '?render=1';

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const br = await chromium.launch({ executablePath: CHROME, args: ['--allow-file-access-from-files', '--force-device-scale-factor=1', '--hide-scrollbars'] });
  const p = await br.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await p.goto(PAGE); await p.waitForFunction(() => window.ready === true, null, { timeout: 20000 });
  await p.evaluate(() => document.fonts.ready);
  const shot = async (t, file, png) => {
    const data = await p.evaluate(([t, png]) => { window.draw(t); return document.getElementById('c').toDataURL(png ? 'image/png' : 'image/jpeg', 0.93); }, [t, png]);
    fs.writeFileSync(file, Buffer.from(data.slice(data.indexOf(',') + 1), 'base64'));
  };
  if (probe) { for (const t of probe) { await shot(t, path.join(out, `t${t.toFixed(2)}.png`), true); console.log('probe', t); } }
  else { const t0 = Date.now(); for (let f = range[0]; f < range[1]; f++) { await shot(f / FPS, path.join(out, String(f).padStart(4, '0') + '.jpg'), false); if (f % 240 === 0) console.log(f, 'frames', ((Date.now() - t0) / 1000).toFixed(0) + 's'); } console.log('done', N, 'frames'); }
  await br.close();
})();
