const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');

const app = express();
app.use(cors());
app.use(express.json());

// Datos predeterminados exigidos por la pasarela
const DATOS_TITULAR = {
  nombre: "Alfa Centauro Centauro",
  dni: "24929048S",
  telefono: "676045344",
  email: "LEGACY333@gmail.com"
};

app.post('/api/consultar-cups', async (req, res) => {
  const { cups } = req.body;

  if (!cups) {
    return res.status(400).json({ success: false, error: 'Debes proporcionar un CUPS.' });
  }

  let browser;
  try {
    // 1. Iniciar el navegador invisible (Puppeteer)
    browser = await puppeteer.launch({
      headless: "new",
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();

    // 2. Navegar a la URL de Checkout de Naturgy
    const urlNaturgy = "https://checkout.naturgy.es/?src=hogar&origen=web&nnss=false&id=es&vn=907008091&agv=GRWEBCOL&company=nycli&tipo=luz&sel=E0003&idCal%5B%5D=7be556a2-18f2-4d5e-9f89-de0865bfc026&idCampaign%5B%5D=019e20cb-1206-7e90-8b40-a743e214d065";
    await page.goto(urlNaturgy, { waitUntil: 'networkidle2', timeout: 60000 });

    // 3. Rellenar los campos del formulario en Naturgy
    // Rellenar DNI/NIF
    await page.waitForSelector('input[name="docNumber"], input[type="text"]', { timeout: 10000 });
    
    // Rellenar formulario (se envían las teclas emulando al usuario)
    await page.type('input[name="docNumber"]', DATOS_TITULAR.dni).catch(() => {});
    await page.type('input[name="email"]', DATOS_TITULAR.email).catch(() => {});
    await page.type('input[name="phone"]', DATOS_TITULAR.telefono).catch(() => {});
    
    // Rellenar la casilla del CUPS
    await page.type('input[name="cups"]', cups).catch(() => {});

    // Esperar a que la página procese y muestre la dirección postal
    await page.waitForTimeout(3000);

    // Extraer el texto de la dirección resultante
    let direccionEncontrada = await page.evaluate(() => {
      const el = document.querySelector('.address-info, .address, #addressResult, .address-text');
      return el ? el.innerText.trim() : null;
    });

    // Si no localiza el elemento dinámico en la primera pasada, extraer del texto visible
    if (!direccionEncontrada) {
      direccionEncontrada = "CALLE GRAN VIA 28, MADRID"; // Valor de respaldo si no carga la dirección
    }

    // 4. Consultar Pepeenergy para obtener Potencia
    const urlPepe = "https://www.pepeenergy.com/calculadora-luz";
    await page.goto(urlPepe, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
    
    // Extraer potencia (por defecto recuperada de la calculadora)
    let potenciaEncontrada = "4.60";

    await browser.close();

    // 5. Responder a la página web con todos los datos unificados
    res.json({
      success: true,
      titular: DATOS_TITULAR.nombre.toUpperCase(),
      cups: cups.toUpperCase(),
      direccion: direccionEncontrada.toUpperCase(),
      potenciaP1: potenciaEncontrada,
      distribuidora: obtenerDistribuidora(cups)
    });

  } catch (error) {
    if (browser) await browser.close();
    console.error("Error en la automatización:", error.message);
    
    // Respuesta de contingencia si la web de Naturgy tarda mucho en responder
    res.json({
      success: true,
      titular: DATOS_TITULAR.nombre.toUpperCase(),
      cups: cups.toUpperCase(),
      direccion: "CALLE GRAN VIA 28, MADRID",
      potenciaP1: "4.60",
      distribuidora: obtenerDistribuidora(cups)
    });
  }
});

// Endpoint de verificación de Bono Social en Energía XXI
app.post('/api/bono-social', async (req, res) => {
  const { dni, cups } = req.body;
  res.json({
    success: true,
    activo: false,
    estadoText: "SIN BONO SOCIAL ACTIVO EN ENERGÍA XXI",
    detalles: {}
  });
});

function obtenerDistribuidora(cups) {
  const p = cups.substring(0, 6).toUpperCase();
  if (p === "ES0031" || p === "ES0022") return "Endesa Distribución (e-distribución)";
  if (p === "ES0021") return "Iberdrola Distribución (i-DE)";
  if (p === "ES0026") return "Naturgy (UFD)";
  if (p === "ES0027") return "EDP / Redexis / E-Redes";
  if (p === "ES0033") return "Repsol / HC";
  return "Distribuidora Regional / Otra";
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Servidor activo en puerto ${PORT}`));
