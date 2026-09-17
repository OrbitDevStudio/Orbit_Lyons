// server.js
// ============================================================================
// Servidor Express + ZenRows Browser Sessions
// ============================================================================

const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer-core');

const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares
app.use(cors());
app.use(express.json());

// ---------------------------------------------------------------------------
// ⚠️ CONFIGURACIÓN DE ZENROWS (SOLO REEMPLAZA ESTA LÍNEA) ⚠️
// ---------------------------------------------------------------------------
const ZENROWS_API_KEY = '09400bfe9754e1831ab7fcf6cd5017bb4c5fa044'; 
// ---------------------------------------------------------------------------

const ZENROWS_CONNECTION_URL = `wss://browser.zenrows.com?apikey=${ZENROWS_API_KEY}&proxy_country=es`;

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
// Helpers
// ---------------------------------------------------------------------------

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Pausa aleatoria LARGA (entre 3 y 7 segundos para parecer humano)
function randomLongDelay(min = 3000, max = 7000) {
  return delay(min + Math.random() * (max - min));
}

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
    throw new Error(`El CUPS "${cupsRaw}" no tiene un formato válido.`);
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
  await randomLongDelay(500, 1200);
  await el.type(text, { delay: 120 + Math.random() * 100 });
}

async function clickHuman(context, selector) {
  const el = await context.waitForSelector(selector, { visible: true, timeout: 15000 });
  const box = await el.boundingBox();
  if (box && context.mouse) {
    await context.mouse.move(
      box.x + box.width * (0.3 + Math.random() * 0.4),
      box.y + box.height * (0.3 + Math.random() * 0.4),
      { steps: 15 }
    );
    await randomLongDelay(500, 1500);
  }
  await el.click();
  await randomLongDelay(1000, 2500);
}

async function findInFrames(page, selector, timeout = 20000) {
  const start = Date.now();
  try {
    const element = await page.waitForSelector(selector, { visible: true, timeout: 5000 });
    if (element) return { context: page, element };
  } catch (_) { /* seguir */ }
  const frames = page.frames();
  for (const frame of frames) {
    if (Date.now() - start > timeout) break;
    try {
      const element = await frame.waitForSelector(selector, { visible: true, timeout: 5000 });
      if (element) return { context: frame, element };
    } catch (_) { /* siguiente */ }
  }
  throw new Error(`No se encontró el selector "${selector}".`);
}

// ---------------------------------------------------------------------------
// Scrapers
// ---------------------------------------------------------------------------

async function scrapeNaturgy(page, cupsNormalizado) {
  console.log('[Naturgy] Navegando...');
  await page.goto(NATURGY_URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await randomLongDelay(4000, 8000);

  try {
    const dniSelector = 'input[name="dni"], input[id*="dni" i], input[placeholder*="DNI" i]';
    await waitVisible(page, dniSelector, 10000);
    console.log('[Naturgy] Rellenando formulario...');
    await typeHuman(page, dniSelector, TITULAR.dni);
    await typeHuman(page, 'input[name="nombre"], input[id*="nombre" i]', TITULAR.nombre);
    await typeHuman(page, 'input[type="tel"], input[name*="telefono" i]', TITULAR.telefono);
    await typeHuman(page, 'input[type="email"], input[name*="email" i]', TITULAR.email);
    await clickHuman(page, 'button[type="submit"]');
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
    await randomLongDelay(3000, 6000);
  } catch (_) {
    console.log('[Naturgy] Sin formulario inicial.');
  }

  try {
    const editSelectors = 'button:has-text("Editar"), a:has-text("Editar"), [class*="edit" i]:has-text("Editar")';
    const { element: editBtn } = await findInFrames(page, editSelectors, 15000);
    console.log('[Naturgy] Pulsando "Editar"...');
    await editBtn.click();
    await randomLongDelay(2500, 4500);
  } catch (e) {
    console.log('[Naturgy] Sin botón Editar.');
  }

  const cupsSelector = 'input[name*="cups" i], input[id*="cups" i], input[placeholder*="CUPS" i]';
  const { context: cupsCtx } = await findInFrames(page, cupsSelector, 15000);
  const cupsInput = await cupsCtx.waitForSelector(cupsSelector, { visible: true, timeout: 10000 });
  await cupsInput.click({ clickCount: 3 });
  await cupsCtx.keyboard.press('Backspace');
  await randomLongDelay(500, 1200);
  await cupsInput.type(cupsNormalizado, { delay: 120 + Math.random() * 80 });
  await randomLongDelay(1000, 2000);
  await cupsInput.press('Enter');

  try {
    const confirmSelectors = 'button:has-text("Confirmar"), button:has-text("Aceptar"), button[type="submit"]';
    const { element: confirmBtn } = await findInFrames(page, confirmSelectors, 8000);
    await confirmBtn.click();
  } catch (_) { /* con Enter basta */ }

  console.log('[Naturgy] Esperando dirección...');
  await Promise.race([
    page.waitForFunction(() => {
      const el = document.querySelector('[class*="address" i], [class*="direccion" i], [data-testid*="address" i]');
      return el && el.innerText.trim().length > 15;
    }, { timeout: 30000 }),
    delay(30000),
  ]);
  await randomLongDelay(3000, 5000);

  const direccion = await page.evaluate(() => {
    const contenedor = document.querySelector('[class*="address" i], [class*="direccion" i], [data-testid*="address" i]');
    if (contenedor && contenedor.innerText.trim().length > 10) return contenedor.innerText.trim();
    const posible = Array.from(document.querySelectorAll('div, p, span')).find(
      (el) => /calle|c\/|avenida|avda|plaza|pza|paseo|carretera/i.test(el.innerText || '') && el.innerText.length < 300
    );
    return posible ? posible.innerText.trim() : 'Dirección no encontrada';
  });

  let distribuidora = 'No disponible';
  try {
    distribuidora = await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll('div, span, p')).find((e) =>
        /distribuidora|e-distribución|i-de|UFD|Viesgo|Unión Fenosa|Endesa|Iberdrola/i.test(e.innerText || '')
      );
      return el ? el.innerText.trim() : 'No disponible';
    });
  } catch (_) { /* ignorar */ }

  return { direccion, distribuidora };
}

async function scrapePepeenergy(page, cupsNormalizado) {
  console.log('[Pepeenergy] Navegando...');
  await page.goto(PEPEENERGY_URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await randomLongDelay(4000, 8000);

  try {
    const cookieSelectors = 'button:has-text("Aceptar"), button:has-text("Aceptar todas")';
    const btn = await page.$(cookieSelectors);
    if (btn) {
      await btn.click();
      await randomLongDelay(2000, 4000);
    }
  } catch (_) { /* sin banner */ }

  const cupsSelector = 'input[name*="cups" i], input[id*="cups" i], input[placeholder*="CUPS" i]';
  const { context: cupsCtx } = await findInFrames(page, cupsSelector, 20000);

  console.log('[Pepeenergy] Escribiendo CUPS...');
  const cupsInput = await cupsCtx.waitForSelector(cupsSelector, { visible: true, timeout: 10000 });
  await cupsInput.click({ clickCount: 3 });
  await cupsCtx.keyboard.press('Backspace');
  await randomLongDelay(500, 1200);
  await cupsInput.type(cupsNormalizado, { delay: 120 + Math.random() * 80 });
  await randomLongDelay(1000, 2000);

  const calcSelector = 'button:has-text("Calcular"), button:has-text("Comprobar"), button[type="submit"]';
  try {
    const { element: calcBtn } = await findInFrames(page, calcSelector, 10000);
    await calcBtn.click();
  } catch (_) {
    await cupsInput.press('Enter');
  }

  console.log('[Pepeenergy] Esperando resultados...');
  await Promise.race([
    page.waitForFunction(() => /kW/i.test(document.body.innerText) && /kWh/i.test(document.body.innerText), { timeout: 30000 }),
    delay(30000),
  ]);
  await randomLongDelay(3000, 5000);

  const potencia = await page.evaluate(() => {
    const m = document.body.innerText.match(/([\d.,]+)\s*kW/i);
    return m ? m[1].replace(',', '.') : 'No disponible';
  });
  const consumo = await page.evaluate(() => {
    const m = document.body.innerText.match(/([\d.,]+)\s*kWh/i);
    return m ? m[1].replace(',', '.') : 'No disponible';
  });

  return { potenciaP1: potencia, consumoAnual: consumo };
}

async function scrapeBonoSocial(page, dni, cupsNormalizado) {
  console.log('[BonoSocial] Navegando al formulario...');
  await page.goto(BONO_SOCIAL_URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await randomLongDelay(4000, 8000);

  try {
    const cookieSelectors = 'button:has-text("Aceptar"), button:has-text("Aceptar todas")';
    const btn = await page.$(cookieSelectors);
    if (btn) {
      await btn.click();
      await randomLongDelay(2000, 4000);
    }
  } catch (_) { /* sin banner */ }

  console.log('[BonoSocial] Rellenando DNI...');
  const dniSelector = 'input[name*="dni" i], input[id*="dni" i], input[placeholder*="DNI" i]';
  const { context: dniCtx } = await findInFrames(page, dniSelector, 15000);
  const dniInput = await dniCtx.waitForSelector(dniSelector, { visible: true, timeout: 10000 });
  await dniInput.click({ clickCount: 3 });
  await dniCtx.keyboard.press('Backspace');
  await randomLongDelay(500, 1200);
  await dniInput.type(dni, { delay: 120 + Math.random() * 80 });
  await randomLongDelay(1000, 2000);

  console.log('[BonoSocial] Rellenando CUPS...');
  const cupsSelector = 'input[name*="cups" i], input[id*="cups" i], input[placeholder*="CUPS" i]';
  const { context: cupsCtx } = await findInFrames(page, cupsSelector, 15000);
  const cupsInput = await cupsCtx.waitForSelector(cupsSelector, { visible: true, timeout: 10000 });
  await cupsInput.click({ clickCount: 3 });
  await cupsCtx.keyboard.press('Backspace');
  await randomLongDelay(500, 1200);
  await cupsInput.type(cupsNormalizado, { delay: 120 + Math.random() * 80 });
  await randomLongDelay(1000, 2000);

  console.log('[BonoSocial] Pulsando consulta...');
  const submitSelector = 'button:has-text("Consultar"), button:has-text("Buscar"), button[type="submit"]';
  try {
    const { element: submitBtn } = await findInFrames(page, submitSelector, 10000);
    await submitBtn.click();
  } catch (_) {
    await cupsInput.press('Enter');
  }

  console.log('[BonoSocial] Esperando resultado...');
  await Promise.race([
    page.waitForFunction(() => {
      const txt = document.body.innerText.toLowerCase();
      return txt.includes('asignado') || txt.includes('vulnerable') || txt.includes('bono social');
    }, { timeout: 30000 }),
    delay(30000),
  ]);
  await randomLongDelay(3000, 5000);

  return await page.evaluate(() => {
    const texto = document.body.innerText;
    const activo = /bono social asignado/i.test(texto) || /concedido/i.test(texto) || (/vulnerable/i.test(texto) && !/no cumple/i.test(texto));
    let estadoText = 'Estado desconocido.';
    const lineas = texto.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    const idx = lineas.findIndex((l) => /asignado|no asignado|vulnerable|bono social/i.test(l));
    if (idx !== -1) estadoText = lineas.slice(idx, idx + 3).join(' ');
    let grado = null;
    const matchGrado = texto.match(/(vulnerable\s+severo|vulnerable)/i);
    if (matchGrado) grado = matchGrado[1];
    let fechaExpiracion = null;
    const matchFecha = texto.match(/(\d{1,2}\/\d{1,2}\/\d{4})/);
    if (matchFecha) fechaExpiracion = matchFecha[1];
    return { activo, estadoText, grado, fechaExpiracion };
  });
}

// ---------------------------------------------------------------------------
// ENDPOINTS
// ---------------------------------------------------------------------------

app.post('/api/consultar-cups', async (req, res) => {
  const { cups } = req.body;
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
    browser = await puppeteer.connect({ browserWSEndpoint: ZENROWS_CONNECTION_URL });
    console.log('[ZenRows] Conectado al navegador remoto.');

    const pageNaturgy = await browser.newPage();
    const pagePepe = await browser.newPage();

    let naturgyResult = { direccion: 'No disponible', distribuidora: 'No disponible' };
    let naturgyError = null;
    try {
      naturgyResult = await scrapeNaturgy(pageNaturgy, cupsNormalizado);
    } catch (err) {
      naturgyError = err.message;
      console.error('[Naturgy] Error:', err.message);
    }

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
      errores: { naturgy: naturgyError, pepeenergy: pepeError },
    });
  } catch (error) {
    console.error('Error global en consultar-cups:', error);
    return res.status(500).json({ success: false, error: 'Error al consultar los datos.' });
  } finally {
    if (browser) {
      try { await browser.close(); } catch (_) { /* ignorar */ }
    }
  }
});

app.post('/api/bono-social', async (req, res) => {
  const { dni, cups } = req.body;
  if (!dni || !cups) {
    return res.status(400).json({ success: false, error: 'DNI y CUPS son obligatorios.' });
  }
  let cupsNormalizado;
  try {
    cupsNormalizado = normalizarCUPS(cups);
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }

  let browser;
  try {
    browser = await puppeteer.connect({ browserWSEndpoint: ZENROWS_CONNECTION_URL });
    console.log('[ZenRows] Conectado al navegador remoto para Bono Social.');

    const page = await browser.newPage();
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
    return res.status(500).json({ success: false, error: 'Error al consultar el Bono Social.' });
  } finally {
    if (browser) {
      try { await browser.close(); } catch (_) { /* ignorar */ }
    }
  }
});

app.get('/', (_req, res) => {
  res.json({ status: 'ok', service: 'consultar-cups' });
});

app.listen(PORT, () => {
  console.log(`Servidor escuchando en puerto ${PORT}`);
});
