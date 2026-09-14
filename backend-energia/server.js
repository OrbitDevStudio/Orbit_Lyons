// ============================================================================
// ENDPOINT: Consulta de Bono Social en Energía XXI
// ============================================================================

/**
 * Consulta el estado de la solicitud del Bono Social en Energía XXI
 * a partir del DNI y el CUPS.
 *
 * @param {import('puppeteer').Page} page - Página de Puppeteer ya inicializada.
 * @param {string} dni - DNI/NIF del titular.
 * @param {string} cupsNormalizado - CUPS ya normalizado (con sufijo 1P/0F).
 * @returns {Promise<{activo:boolean, estadoText:string, grado?:string, fechaExpiracion?:string}>}
 */
async function scrapeBonoSocial(page, dni, cupsNormalizado) {
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log('[Energía XXI console]', msg.text());
  });
  page.on('pageerror', (err) => console.log('[Energía XXI pageerror]', err.message));

  // URL oficial del formulario de consulta de estado del Bono Social
  const CONSULTA_URL = 'https://www.energiaxxi.com/consulta-bono-social-mr.html';

  console.log('[BonoSocial] Navegando al formulario de consulta...');
  await page.goto(CONSULTA_URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await randomDelay(2000, 4000);

  // Aceptar cookies si aparece el banner
  try {
    const cookieSelectors = [
      'button:has-text("Aceptar")',
      'button:has-text("Aceptar todas")',
      'button[id*="cookie" i]',
      'button[class*="cookie" i]',
    ].join(', ');
    const btn = await page.$(cookieSelectors);
    if (btn) {
      await btn.click();
      await randomDelay(800, 1500);
    }
  } catch (_) {
    /* sin banner */
  }

  // --- Rellenar DNI ---
  console.log('[BonoSocial] Rellenando DNI...');
  const dniSelector = [
    'input[name*="dni" i]',
    'input[id*="dni" i]',
    'input[placeholder*="DNI" i]',
    'input[placeholder*="NIF" i]',
    'input[placeholder*="documento" i]',
  ].join(', ');

  const { context: dniCtx } = await findInFrames(page, dniSelector, 15000);
  const dniInput = await dniCtx.waitForSelector(dniSelector, { visible: true, timeout: 10000 });
  await dniInput.click({ clickCount: 3 });
  await dniCtx.keyboard.press('Backspace');
  await randomDelay(300, 600);
  await dniInput.type(dni, { delay: 80 + Math.random() * 60 });
  await randomDelay(500, 900);

  // --- Rellenar CUPS ---
  console.log('[BonoSocial] Rellenando CUPS...');
  const cupsSelector = [
    'input[name*="cups" i]',
    'input[id*="cups" i]',
    'input[placeholder*="CUPS" i]',
  ].join(', ');

  const { context: cupsCtx } = await findInFrames(page, cupsSelector, 15000);
  const cupsInput = await cupsCtx.waitForSelector(cupsSelector, { visible: true, timeout: 10000 });
  await cupsInput.click({ clickCount: 3 });
  await cupsCtx.keyboard.press('Backspace');
  await randomDelay(300, 600);
  await cupsInput.type(cupsNormalizado, { delay: 80 + Math.random() * 60 });
  await randomDelay(500, 900);

  // --- Pulsar botón de consultar ---
  console.log('[BonoSocial] Pulsando botón de consulta...');
  const submitSelector = [
    'button:has-text("Consultar")',
    'button:has-text("Buscar")',
    'button:has-text("Ver estado")',
    'button[type="submit"]',
  ].join(', ');

  try {
    const { element: submitBtn } = await findInFrames(page, submitSelector, 10000);
    await submitBtn.click();
  } catch (_) {
    // Si no hay botón, probamos con Enter
    await cupsInput.press('Enter');
  }

  // --- Esperar a que aparezca el resultado ---
  console.log('[BonoSocial] Esperando resultado...');
  await Promise.race([
    page.waitForFunction(
      () => {
        const txt = document.body.innerText.toLowerCase();
        return (
          txt.includes('asignado') ||
          txt.includes('no asignado') ||
          txt.includes('documentación') ||
          txt.includes('vulnerable') ||
          txt.includes('bono social')
        );
      },
      { timeout: 25000 }
    ),
    delay(25000),
  ]);

  await randomDelay(1500, 2500);

  // --- Extraer el estado ---
  const resultado = await page.evaluate(() => {
    const texto = document.body.innerText;

    // Determinar si está activo o no
    const activo =
      /bono social asignado/i.test(texto) ||
      /concedido/i.test(texto) ||
      /vulnerable/i.test(texto) && !/no cumple/i.test(texto);

    // Extraer un texto descriptivo
    let estadoText = 'Estado desconocido.';
    const lineas = texto.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    const idx = lineas.findIndex((l) =>
      /asignado|no asignado|documentación|vulnerable|bono social/i.test(l)
    );

    if (idx !== -1) {
      estadoText = lineas.slice(idx, idx + 3).join(' ');
    }

    // Extraer grado de vulnerabilidad si está presente
    let grado = null;
    const matchGrado = texto.match(/(vulnerable\s+severo|vulnerable)/i);
    if (matchGrado) grado = matchGrado[1];

    // Extraer fecha de expiración si está presente
    let fechaExpiracion = null;
    const matchFecha = texto.match(/(\d{1,2}\/\d{1,2}\/\d{4})/);
    if (matchFecha) fechaExpiracion = matchFecha[1];

    return { activo, estadoText, grado, fechaExpiracion };
  });

  // Si no se detectó correctamente, devolvemos un mensaje genérico
  if (!resultado.estadoText || resultado.estadoText === 'Estado desconocido.') {
    resultado.estadoText =
      'No se pudo determinar el estado. Revisa el DNI y el CUPS, o inténtalo de nuevo.';
  }

  return resultado;
}

// ---------------------------------------------------------------------------
// Endpoint: /api/bono-social
// ---------------------------------------------------------------------------
app.post('/api/bono-social', async (req, res) => {
  const { dni, cups } = req.body;

  // Validaciones básicas
  if (!dni || typeof dni !== 'string') {
    return res.status(400).json({ success: false, error: 'DNI no proporcionado.' });
  }
  if (!cups || typeof cups !== 'string') {
    return res.status(400).json({ success: false, error: 'CUPS no proporcionado.' });
  }

  // Normalizar CUPS (reutilizamos la función que ya existe en tu server.js)
  let cupsNormalizado;
  try {
    cupsNormalizado = normalizarCUPS(cups);
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }

  let browser;

  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1366,768',
      ],
      defaultViewport: { width: 1366, height: 768 },
    });

    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
    });

    const resultado = await scrapeBonoSocial(page, dni, cupsNormalizado);

    return res.json({
      success: true,
      dni,
      cups: cupsNormalizado,
      activo: resultado.activo,
      estadoText: resultado.estadoText,
      grado: resultado.grado,
      fechaExpiracion: resultado.fechaExpiracion,
    });
  } catch (error) {
    console.error('[BonoSocial] Error:', error);
    return res.status(500).json({
      success: false,
      error: 'Error al consultar el Bono Social. Inténtalo de nuevo más tarde.',
      detalle: error.message,
    });
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (_) {
        /* ignorar */
      }
    }
  }
});
