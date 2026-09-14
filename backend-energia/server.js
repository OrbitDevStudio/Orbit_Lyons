// server.js
// ============================================================================
// Servidor Express + Puppeteer (stealth)
// - Naturgy: dirección, potencia, consumo
// - Pepeenergy: potencia y consumo
// - Energía XXI: consulta de Bono Social
// ============================================================================

const express = require('express');
const cors = require('cors');

// Puppeteer con stealth
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

// ---------------------------------------------------------------------------
// Inicialización de Express (¡va arriba, antes de todo!)
// ---------------------------------------------------------------------------
const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares
app.use(cors());
app.use(express.json());

// ---------------------------------------------------------------------------
// Datos fijos del titular
// ---------------------------------------------------------------------------
const TITULAR = {
  nombre: 'Alfa Centauro Centauro',
  dni: '24929048S',
  telefono: '676045344',
  email: 'LEGACY333@gmail.com',
};

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------
const NATURGY_URL =
  'https://checkout.naturgy.es/?src=hogar&origen=web&nnss=false&id=es&vn=907008091&agv=GRWEBCOL&company=nycli&tipo=luz&sel=E0003&idCal%5B%5D=7be556a2-18f2-4d5e-9f89-de0865bfc026&idCampaign%5B%5D=019e20cb-1206-7e90-8b40-a743e214d065';

const PEPEENERGY_URL = 'https://www.pepeenergy.com/calculadora-luz';

const BONO_SOCIAL_URL = 'https://www.energiaxxi.com/consulta-bono-social-mr.html';

// ---------------------------------------------------------------------------
// Helpers genéricos
// ---------------------------------------------------------------------------

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay(min = 800, max = 2000) {
  return delay(min + Math.random() * (max - min));
}

/**
 * Normaliza el CUPS recibido del frontend.
 */
function normalizarCUPS(cupsRaw) {
  if (!cupsRaw || typeof cupsRaw !== 'string') {
    throw new Error('CUPS vacío o inválido.');
  }

  let cups = cupsRaw.replace(/[\s\-]/g, '').toUpperCase();

  if (!cups.startsWith('ES')) {
    cups = 'ES' + cups;
  }

  if (cups.length === 20) {
    const codDistribuidora = cups.substring(4, 8);
    cups += codDistribuidora === '0022' ? '1P' : '0F';
  }

  if (cups.length < 22 || cups.length > 24) {
    throw new Error(
      `El CUPS "${cupsRaw}" no tiene un formato válido (debe tener 20 o 22 caracteres útiles).`
    );
  }

  return cups;
}

async function waitVisible(context, selector, timeout = 20000) {
  return context.waitForSelector(selector, { visible: true, timeout });
}

async function typeHuman(context, selector, text) {
  const el = await context.waitForSelector(selector, { visible: true, timeout: 15000 });
  await el.click({ clickCount: 3 });
  await context.keyboard.press('Backspace');
  await randomDelay(200, 500);
  await el.type(text, { delay: 60 + Math.random() * 60 });
}

async function clickHuman(context, selector) {
  const el = await context.waitForSelector(selector, { visible: true, timeout: 15000 });
  const box = await el.boundingBox();
  if (box && context.mouse) {
    await context.mouse.move(
      box.x + box.width * (0.3 + Math.random() * 0.4),
      box.y + box.height * (0.3 + Math.random() * 0.4),
      { steps: 10 }
    );
    await randomDelay(200, 500);
  }
  await el.click();
  await randomDelay(400, 900);
}

async function findInFrames(page, selector, timeout = 20000) {
  const start = Date.now();

  try {
    const element = await page.waitForSelector(selector, { visible: true, timeout: 4000 });
    if (element) return { context: page, element };
  } catch (_) { /* seguir */ }

  const frames = page.frames();
  for (const frame of frames) {
    if (Date.now() - start > timeout) break;
    try {
      const element = await frame.waitForSelector(selector, { visible: true, timeout: 4000 });
      if (element) return { context: frame, element };
    } catch (_) { /* siguiente frame */ }
  }

  throw new Error(`No se encontró el selector "${selector}" en ningún frame.`);
}

async function extraerMensajeError(page) {
  try {
    return await page.evaluate(() => {
      const posibles = Array.from(
        document.querySelectorAll('div, p, span, [role="alert"], [class*="error"], [class*="Error"]')
      ).filter((el) => {
        const txt = (el.innerText || '').trim();
        return (
          txt.length > 5 &&
          txt.length < 300 &&
          /error|fallo|no se ha podido|no encontrado|inválido|no válido|no disponible/i.test(txt)
        );
      });
      return posibles.map((el) => el.innerText.trim()).join(' | ') || null;
    });
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Scraper NATURGY
// ---------------------------------------------------------------------------

async function scrapeNaturgy(page, cupsNormalizado) {
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log('[Naturgy console]', msg.text());
  });
  page.on('pageerror', (err) => console.log('[Naturgy pageerror]', err.message));

  console.log('[Naturgy] Navegando...');
  await page.goto(NATURGY_URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await randomDelay(1500, 3000);

  // Rellenar formulario del titular si aparece
  try {
    const dniSelector =
      'input[name="dni"], input[id*="dni" i], input[placeholder*="DNI" i], input[placeholder*="NIF" i]';
    await waitVisible(page, dniSelector, 8000);

    console.log('[Naturgy] Rellenando formulario del titular...');
    await typeHuman(page, dniSelector, TITULAR.dni);

    await typeHuman(
      page,
      'input[name="nombre"], input[id*="nombre" i], input[placeholder*="Nombre" i]',
      TITULAR.nombre
    );
    await typeHuman(
      page,
      'input[type="tel"], input[name*="telefono" i], input[placeholder*="Teléfono" i]',
      TITULAR.telefono
    );
    await typeHuman(
      page,
      'input[type="email"], input[name*="email" i], input[placeholder*="Correo" i]',
      TITULAR.email
    );

    await clickHuman(page, 'button[type="submit"], button');
    await page
      .waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 })
      .catch(() => {});
    await randomDelay(2000, 4000);
  } catch (_) {
    console.log('[Naturgy] Sin formulario inicial, continuamos.');
  }

  // Bono social (si aparece en Naturgy)
  try {
    const bonoSelectors = [
      'input[type="checkbox"][id*="bono" i]',
      'label:has-text("bono social")',
      'button:has-text("Consultar bono")',
      'button:has-text("Bono social")',
    ].join(', ');

    const { context: bonoCtx, element: bonoEl } = await findInFrames(page, bonoSelectors, 8000);
    console.log('[Naturgy] Interactuando con bono social...');
    await bonoEl.click();
    await randomDelay(1500, 2500);

    await Promise.race([
      bonoCtx.waitForFunction(
        () =>
          document.body.innerText.includes('derecho') ||
          document.body.innerText.includes('no cumple') ||
          document.body.innerText.includes('no tiene') ||
          document.body.innerText.includes('bono social'),
        { timeout: 20000 }
      ),
      delay(20000),
    ]);
  } catch (_) {
    console.log('[Naturgy] Sin bloque de bono social.');
  }

  // Botón Editar
  try {
    const editSelectors = [
      'button:has-text("Editar")',
      'a:has-text("Editar")',
      '[class*="edit" i]:has-text("Editar")',
      'button[aria-label*="editar" i]',
    ].join(', ');

    const { element: editBtn } = await findInFrames(page, editSelectors, 15000);
    console.log('[Naturgy] Pulsando "Editar"...');
    await editBtn.click();
    await randomDelay(1500, 2500);
  } catch (e) {
    console.log('[Naturgy] Sin botón Editar, puede estar ya abierto.');
  }

  // CUPS
  const cupsSelector =
    'input[name*="cups" i], input[id*="cups" i], input[placeholder*="CUPS" i]';

  const { context: cupsCtx } = await findInFrames(page, cupsSelector, 15000);
  const cupsInput = await cupsCtx.waitForSelector(cupsSelector, { visible: true, timeout: 10000 });
  await cupsInput.click({ clickCount: 3 });
  await cupsCtx.keyboard.press('Backspace');
  await randomDelay(300, 600);
  await cupsInput.type(cupsNormalizado, { delay: 80 + Math.random() * 80 });
  await randomDelay(500, 900);
  await cupsInput.press('Enter');

  try {
    const confirmSelectors = [
      'button:has-text("Confirmar")',
      'button:has-text("Aceptar")',
      'button:has-text("Guardar")',
      'button[type="submit"]',
    ].join(', ');
    const { element: confirmBtn } = await findInFrames(page, confirmSelectors, 5000);
    await confirmBtn.click();
  } catch (_) { /* puede que con Enter sea suficiente */ }

  // Esperar dirección
  console.log('[Naturgy] Esperando dirección...');
  await Promise.race([
    page.waitForFunction(
      () => {
        const el = document.querySelector(
          '[class*="address" i], [class*="direccion" i], [data-testid*="address" i], [data-testid*="direccion" i]'
        );
        if (el && el.innerText.trim().length > 15) return true;
        return Array.from(document.querySelectorAll('div, p, span')).some(
          (n) =>
            /calle|c\/|avenida|avda|plaza|pza|paseo|carretera/i.test(n.innerText || '') &&
            n.innerText.length < 250
        );
      },
      { timeout: 25000 }
    ),
    delay(25000),
  ]);

  const direccion = await page.evaluate(() => {
    const contenedor = document.querySelector(
      '[class*="address" i], [class*="direccion" i], [data-testid*="address" i], [data-testid*="direccion" i]'
    );
    if (contenedor && contenedor.innerText.trim().length > 10) {
      return contenedor.innerText.trim();
    }
    const posible = Array.from(document.querySelectorAll('div, p, span')).find(
      (el) =>
        /calle|c\/|avenida|avda|plaza|pza|paseo|carretera/i.test(el.innerText || '') &&
        el.innerText.length < 300
    );
    return posible ? posible.innerText.trim() : 'Dirección no encontrada';
  });

  let distribuidora = 'No disponible';
  try {
    distribuidora = await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll('div, span, p')).find((e) =>
        /distribuidora|e-distribución|i-de|UFD|Viesgo|Unión Fenosa|Endesa|Iberdrola/i.test(
          e.innerText || ''
        )
      );
      return el ? el.innerText.trim() : 'No disponible';
    });
  } catch (_) { /* ignorar */ }

  const errorFinal = await extraerMensajeError(page);
  if (errorFinal && direccion === 'Dirección no encontrada') {
    throw new Error(`Naturgy no devolvió la dirección. Mensaje: ${errorFinal}`);
  }

  return { direccion, distribuidora };
}

// ---------------------------------------------------------------------------
// Scraper PEPEENERGY
// ---------------------------------------------------------------------------

async function scrapePepeenergy(page, cupsNormalizado) {
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log('[Pepe console]', msg.text());
  });
  page.on('pageerror', (err) => console.log('[Pepe pageerror]', err.message));

  console.log('[Pepeenergy] Navegando...');
  await page.goto(PEPEENERGY_URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await randomDelay(1500, 3000);

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
  } catch (_) { /* sin banner */ }

  const cupsSelector =
    'input[name*="cups" i], input[id*="cups" i], input[placeholder*="CUPS" i]';
  const { context: cupsCtx } = await findInFrames(page, cupsSelector, 20000);

  console.log('[Pepeenergy] Escribiendo CUPS...');
  const cupsInput = await cupsCtx.waitForSelector(cupsSelector, { visible: true, timeout: 10000 });
  await cupsInput.click({ clickCount: 3 });
  await cupsCtx.keyboard.press('Backspace');
  await randomDelay(300, 600);
  await cupsInput.type(cupsNormalizado, { delay: 80 + Math.random() * 60 });
  await randomDelay(500, 900);

  const calcSelector = [
    'button:has-text("Calcular")',
    'button:has-text("Comprobar")',
    'button:has-text("Consultar")',
    'button[type="submit"]',
  ].join(', ');

  try {
    const { element: calcBtn } = await findInFrames(page, calcSelector, 10000);
    await calcBtn.click();
  } catch (_) {
    await cupsInput.press('Enter');
  }

  console.log('[Pepeenergy] Esperando resultados...');
  await Promise.race([
    page.waitForFunction(
      () => {
        const txt = document.body.innerText;
        return /kW/i.test(txt) && /kWh/i.test(txt);
      },
      { timeout: 25000 }
    ),
    delay(25000),
  ]);

  await randomDelay(1500, 2500);

  const potencia = await page.evaluate(() => {
    const candidatos = Array.from(document.querySelectorAll('div, span, p, td, li'));
    const pot = candidatos.find(
      (el) => /potencia/i.test(el.innerText || '') && /kW/i.test(el.innerText || '')
    );
    if (pot) {
      const m = pot.innerText.match(/([\d.,]+)\s*kW/i);
      if (m) return m[1].replace(',', '.');
    }
    const m = document.body.innerText.match(/([\d.,]+)\s*kW/i);
    return m ? m[1].replace(',', '.') : 'No disponible';
  });

  const consumo = await page.evaluate(() => {
    const candidatos = Array.from(document.querySelectorAll('div, span, p, td, li'));
    const cons = candidatos.find(
      (el) => /consumo/i.test(el.innerText || '') && /kWh/i.test(el.innerText || '')
    );
    if (cons) {
      const m = cons.innerText.match(/([\d.,]+)\s*kWh/i);
      if (m) return m[1].replace(',', '.');
    }
    const m = document.body.innerText.match(/([\d.,]+)\s*kWh/i);
    return m ? m[1].replace(',', '.') : 'No disponible';
  });

  return { potenciaP1: potencia, consumoAnual: consumo };
}

// ---------------------------------------------------------------------------
// Scraper BONO SOCIAL (Energía XXI)
// ---------------------------------------------------------------------------

async function scrapeBonoSocial(page, dni, cupsNormalizado) {
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log('[Energía XXI console]', msg.text());
  });
  page.on('pageerror', (err) => console.log('[Energía XXI pageerror]', err.message));

  console.log('[BonoSocial] Navegando al formulario...');
  await page.goto(BONO_SOCIAL_URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await randomDelay(2000, 4000);

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
  } catch (_) { /* sin banner */ }

  // DNI
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

  // CUPS
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

  // Botón consultar
  console.log('[BonoSocial] Pulsando consulta...');
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
    await cupsInput.press('Enter');
  }

  // Esperar resultado
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

  const resultado = await page.evaluate(() => {
    const texto = document.body.innerText;

    const asignado = /bono social asignado/i.test(texto);
    const concedido = /concedido/i.test(texto);
    const vulnerable = /vulnerable/i.test(texto) && !/no cumple/i.test(texto);
    const activo = asignado || concedido || vulnerable;

    let estadoText = 'Estado desconocido.';
    const lineas = texto.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    const idx = lineas.findIndex((l) =>
      /asignado|no asignado|documentación|vulnerable|bono social/i.test(l)
    );
    if (idx !== -1) estadoText = lineas.slice(idx, idx + 3).join(' ');

    let grado = null;
    const matchGrado = texto.match(/(vulnerable\s+severo|vulnerable)/i);
    if (matchGrado) grado = matchGrado[1];

    let fechaExpiracion = null;
    const matchFecha = texto.match(/(\d{1,2}\/\d{1,2}\/\d{4})/);
    if (matchFecha) fechaExpiracion = matchFecha[1];

    return { activo, estadoText, grado, fechaExpiracion };
  });

  if (!resultado.estadoText || resultado.estadoText === 'Estado desconocido.') {
    resultado.estadoText =
      'No se pudo determinar el estado. Revisa el DNI y el CUPS, o inténtalo de nuevo.';
  }

  return resultado;
}

// ---------------------------------------------------------------------------
// ENDPOINT: Bono Social
// ---------------------------------------------------------------------------
app.post('/api/bono-social', async (req, res) => {
  const { dni, cups } = req.body;

  if (!dni || typeof dni !== 'string') {
    return res.status(400).json({ success: false, error: 'DNI no proporcionado.' });
  }
  if (!cups || typeof cups !== 'string') {
    return res.status(400).json({ success: false, error: 'CUPS no proporcionado.' });
  }

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
      } catch (_) { /* ignorar */ }
    }
  }
});

// ---------------------------------------------------------------------------
// ENDPOINT: Consulta unificada CUPS
// ---------------------------------------------------------------------------
app.post('/api/consultar-cups', async (req, res) => {
  const { cups } = req.body;

  if (!cups || typeof cups !== 'string') {
    return res.status(400).json({ success: false, error: 'CUPS no proporcionado.' });
  }

  let cupsNormalizado;
  try {
    cupsNormalizado = normalizarCUPS(cups);
    console.log('CUPS normalizado:', cupsNormalizado);
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

    // FASE 1: NATURGY
    const pageNaturgy = await browser.newPage();
    await pageNaturgy.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
    await pageNaturgy.setExtraHTTPHeaders({
      'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
    });

    let naturgyResult = { direccion: 'No disponible', distribuidora: 'No disponible' };
    let naturgyError = null;
    try {
      naturgyResult = await scrapeNaturgy(pageNaturgy, cupsNormalizado);
    } catch (err) {
      naturgyError = err.message;
      console.error('[Naturgy] Error:', err.message);
    }

    // FASE 2: PEPEENERGY
    const pagePepe = await browser.newPage();
    await pagePepe.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
    await pagePepe.setExtraHTTPHeaders({
      'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
    });

    let pepeResult = { potenciaP1: 'No disponible', consumoAnual: 'No disponible' };
    let pepeError = null;
    try {
      pepeResult = await scrapePepeenergy(pagePepe, cupsNormalizado);
    } catch (err) {
      pepeError = err.message;
      console.error('[Pepeenergy] Error:', err.message);
    }

    const hayExito = !naturgyError || !pepeError;

    return res.json({
      success: hayExito,
      titular: TITULAR.nombre.toUpperCase(),
      cups: cupsNormalizado,
      direccion: naturgyResult.direccion,
      potenciaP1: pepeResult.potenciaP1,
      consumoAnual: pepeResult.consumoAnual,
      distribuidora: naturgyResult.distribuidora,
      errores: {
        naturgy: naturgyError,
        pepeenergy: pepeError,
      },
    });
  } catch (error) {
    console.error('Error global:', error);
    return res.status(500).json({
      success: false,
      error: 'Error al consultar los datos. Inténtalo de nuevo más tarde.',
      detalle: error.message,
    });
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (_) { /* ignorar */ }
    }
  }
});

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
app.get('/', (_req, res) => {
  res.json({ status: 'ok', service: 'consultar-cups' });
});

// ---------------------------------------------------------------------------
// Inicio
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`Servidor escuchando en puerto ${PORT}`);
});
