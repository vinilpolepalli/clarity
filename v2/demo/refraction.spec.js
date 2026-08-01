// Proves the glass genuinely refracts rather than merely frosting.
// A straight vertical line runs behind a glass panel. Outside the panel it must
// sit where it was drawn; inside the panel's divergent edge zone it must be
// displaced. If the SVG filter were ignored, both would be identical.
const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');

test('glass displaces the backdrop (real refraction, not just blur)', async () => {
  test.setTimeout(120000);
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env } });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await win.goto('file://' + path.join(__dirname, 'refraction-probe.html'));
  await win.waitForTimeout(700);

  const png = await win.screenshot();

  // Decode via Electron's nativeImage (no image libs in this environment) and
  // find the darkest column on a given row.
  const findLine = async (buf, rows) =>
    app.evaluate(async ({ nativeImage }, { b64, rows }) => {
      const img = nativeImage.createFromBuffer(Buffer.from(b64, 'base64'));
      const { width, height } = img.getSize();
      const bmp = img.getBitmap(); // BGRA
      return rows.map((y) => {
        if (y >= height) return null;
        let bestX = -1;
        let best = 255;
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          const lum = (bmp[i] + bmp[i + 1] + bmp[i + 2]) / 3;
          if (lum < best) { best = lum; bestX = x; }
        }
        return best < 120 ? bestX : null; // only count an actual dark line
      });
    }, { b64: buf.toString('base64'), rows });

  // y=60 is above the panel (untouched); y=300 is inside its left edge zone.
  const [outside, inside] = await findLine(png, [60, 300]);
  console.log(`REFRACTION line x: outside=${outside} inside=${inside}`);

  expect(outside, 'line not found above the panel').not.toBeNull();
  expect(inside, 'line not found inside the panel').not.toBeNull();

  const shift = Math.abs(inside - outside);
  console.log(`REFRACTION displacement = ${shift}px`);
  expect(shift, 'backdrop was not displaced — the filter is being ignored').toBeGreaterThanOrEqual(3);

  await app.close();
});
