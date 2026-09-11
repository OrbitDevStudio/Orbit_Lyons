const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');

const app = express();
app.use(cors());
app.use(express.json());

// Datos predeterminados para Naturgy
const TITULAR_NATURGY = {
  nombre: "Alfa Centauro Centauro",
  dni: "24929048S",
  telefono: "676045344",
  email: "LEGACY333@gmail.com"
};

app.get('/api/consultar-cups', async (req, res) => {
  const { cups } = req.query;

  if (!cups) {
    return res.status(400).json({ error: "Debes proporcionar un CUPS válido." });
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();

    // ----------------------------------------------------
    // 1. OBTENER DIRECCIÓN Y UBICACIÓN DESDE NATURGY
    // ----------------------------------------------------
    const urlNaturgy = "https://checkout.naturgy.es/?src=hogar&origen=web&nnss=false&id=es&vn=907008091&agv=GRWEBCOL&company=nycli&tipo=luz&sel=E0003&idCal%5B%5D=7be556a2-18f2-4d5e-9f89-de0865bfc026&idCampaign%5B%5D=019e20cb-1206-7e90-8b40-a743e214d065";
    
    await page.goto(urlNaturgy, { waitUntil: 'networkidle2' });

    // Aquí el script interactúa con los selectores del formulario de Naturgy
    // Rellena Nombre, DNI, Teléfono, Correo y finalmente el CUPS
    // (Ajustar selectores del DOM según la estructura exacta de Naturgy)
    
    let direccionObtenida = "Dirección detectada según CUPS"; // Reemplazar con selector escrapeado

    // ----------------------------------------------------
    // 2. OBTENER POTENCIA Y CONSUMO DESDE PEPEENERGY
    // ----------------------------------------------------
    const urlPepeenergy = "https://www.pepeenergy.com/calculadora-luz";
    await page.goto(urlPepeenergy, { waitUntil: 'networkidle2' });

    // Rellena el campo del CUPS en Pepeenergy y extrae los valores
    let potenciaObtenida = "4.6 kW"; // Reemplazar con extracción dinámica
    let consumoObtenido = "250 kWh/mes"; // Reemplazar con extracción dinámica

    await browser.close();

    // Retorna la respuesta a tu interfaz Web
    res.json({
      cups: cups,
      direccion: direccionObtenida,
      potencia: potenciaObtenida,
      consumo: consumoObtenido,
      titularUsado: TITULAR_NATURGY.nombre
    });

  } catch (error) {
    if (browser) await browser.close();
    console.error("Error al consultar:", error);
    res.status(500).json({ error: "Error procesando la consulta del CUPS." });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor ejecutándose en el puerto ${PORT}`);
});
