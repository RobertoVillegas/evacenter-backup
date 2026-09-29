# evacenter-backup

[![Tests](https://github.com/RobertoVillegas/evacenter-backup/actions/workflows/test.yml/badge.svg)](https://github.com/RobertoVillegas/evacenter-backup/actions/workflows/test.yml)
[![Licencia: MIT](https://img.shields.io/badge/licencia-MIT-blue.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/bun-%E2%89%A5%201.4.2-black?logo=bun)](https://bun.sh)
[![Sin dependencias](https://img.shields.io/badge/dependencias-0-brightgreen.svg)](#)

> **Descarga y respalda tus estudios del visor PACS de Evacenter desde la terminal:** imágenes DICOM
> originales, miniaturas, documentos e informes en PDF, dentro de una carpeta ordenada y verificable
> que puedes guardar durante años.

La clínica te manda un enlace para *ver* el estudio… pero no te da forma de descargarlo, ni te dice
cuánto tiempo lo va a conservar. Cuando ese enlace caduca, el estudio se queda con ellos.
Este proyecto convierte el enlace en una copia que es tuya.

```bash
bun run evacenter "https://pacs.evacenter.com/v2/mobile_viewer?studyId=…&ac=…"
```

---

## ✨ Qué hace

- 📥 Descarga las **imágenes DICOM originales**, byte a byte, sin recomprimir ni tocar una sola etiqueta.
- 🗂️ Ordena todo por serie y nombra cada archivo con su número real de instancia (`0001.dcm`, `0002.dcm`…).
- 📄 Se trae también miniaturas, documentos, imágenes marcadas en el visor e **informes en PDF**.
- 🔐 Deja `manifest.json`, `info.json`, `checksums.sha256` y un `LEEME.txt` con instrucciones.
- ↩️ Es **reanudable**: si se corta la conexión, lo vuelves a ejecutar y continúa donde iba.
- 🔍 Valida cada archivo antes de guardarlo (cabecera DICOM, JPEG real, PDF real), así nunca acabas
  con un HTML de error disfrazado de informe.
- 🕵️ No guarda tus credenciales en disco y **nunca escribe en el PACS**: solo lee.

## ⚡ Empezar en 2 minutos

**1. Instala [Bun](https://bun.sh) si no lo tienes**

```bash
curl -fsSL https://bun.sh/install | bash
```

**2. Clona y comprueba qué trae el estudio (sin descargar nada)**

```bash
git clone https://github.com/RobertoVillegas/evacenter-backup.git
cd evacenter-backup
bun run evacenter info "<tu enlace del visor>"
```

```
Paciente: Nombre Apellido Apellido
Estudio: TOMOGRAFIA SIMPLE DE NARIZ, SPN Y OIDOS · 2026-04-15T19:20:41+00:00 · CT
Centro: Ciudad Victoria
Series: 19 · imágenes: 4417 · informes: 1
┌────┬───────┬───────────┬──────────┬─────────────────────┐
│    │ Serie │ Modalidad │ Imágenes │ Descripción         │
├────┼───────┼───────────┼──────────┼─────────────────────┤
│  0 │ 2     │ CT        │ 102      │ SIMPLE              │
│  1 │ 3     │ CT        │ 102      │ FINOS 3D            │
└────┴───────┴───────────┴──────────┴─────────────────────┘
```

**3. Descarga el estudio completo**

```bash
bun run evacenter "<tu enlace del visor>"
```

```
Descargando 4437 archivos (6 en paralelo).
Puedes interrumpir con Ctrl+C y volver a ejecutar: se reanuda sin repetir lo bajado.
  250/4437 · 31 MB nuevos · fallos 0
  500/4437 · 68 MB nuevos · fallos 0

Listo: 4417 imágenes DICOM y 20 archivos adicionales en
  /Users/tu-usuario/evacenter-2026-04-15-1a2b3c4d
Incluye manifest.json, info.json, checksums.sha256 y LEEME.txt con cómo verlo.
```

> 💡 Pasa siempre el enlace **entre comillas**: contiene `&` y el shell se lo comería.

También puedes usarlo sin clonar nada:

```bash
bunx github:RobertoVillegas/evacenter-backup info "<enlace>"
bunx github:RobertoVillegas/evacenter-backup "<enlace>"
```

## 🎛 Uso

```bash
bun run evacenter <enlace>              # descarga el estudio completo
bun run evacenter info <enlace>         # inventario: series, imágenes e informes
bun run evacenter verify <carpeta>      # revisa un respaldo ya hecho
```

| Opción | Atajo | Qué hace |
| --- | --- | --- |
| `--out <carpeta>` | `-o` | Dónde guardar (por defecto `./evacenter-<fecha>-<estudio>`) |
| `--series 2,4,350` | `-s` | Descarga solo esas series |
| `--limit N` | | Máximo de imágenes por serie, para probar |
| `--concurrency N` | `-c` | Descargas simultáneas, 1–16 (por defecto 6) |
| `--no-thumbnails` | | No bajar miniaturas ni vistas previas |
| `--mask` | | Oculta el nombre del paciente en la consola (ideal para capturas) |
| `--json` | | Salida JSON limpia en `info` y `verify` |
| `--quiet` | `-q` | Menos mensajes |
| `--refresh` | | Ignora el inventario previo y vuelve a consultar el estudio |
| `--api-base <url>` | | Servidor GraphQL alternativo (por defecto `https://api.evacenter.com`) |
| `--help` | `-h` | La ayuda completa |

**Ejemplos útiles**

```bash
# Solo las series axiales, a una carpeta propia
bun run evacenter "<enlace>" --series 250,251 --out ~/Estudios/2026-04-15

# Probar primero con 5 imágenes de una serie
bun run evacenter "<enlace>" --series 2 --limit 5 --out /tmp/prueba

# Guardar el inventario en JSON para tus notas
bun run evacenter info "<enlace>" --json > inventario.json
```

## 📦 Qué queda en la carpeta

```
evacenter-2026-04-15-1a2b3c4d/
├── series/
│   ├── 002-simple/
│   │   ├── 0001.dcm            Imágenes DICOM originales (JPEG Lossless, tal cual las sirve el PACS)
│   │   ├── 0002.dcm
│   │   └── miniatura.jpg
│   ├── 250-axial-std/
│   └── 351-stenvers-der/
├── informes/
│   └── informe-1-signed.pdf
├── documentos/                 Otros documentos del estudio (si existen)
├── marcadores/                 Imágenes marcadas en el visor (si existen)
├── info.json                   Datos del estudio, paciente, centro y médicos
├── manifest.json               Inventario técnico: series, UIDs, tamaños y checksums
├── checksums.sha256            Huellas SHA-256 en formato estándar
└── LEEME.txt                   Resumen e instrucciones para ver las imágenes
```

Los archivos DICOM se guardan **tal cual llegan**: no se recomprimen, no se re-anonimizan y no se
les cambia ni una etiqueta. Los nombres se derivan del propio contenido DICOM (número de instancia y,
si falta, el UID del objeto), así que el resultado es ordenable y reproducible.

## 🔐 Verificar que el respaldo está completo

```bash
bun run evacenter verify ~/Estudios/evacenter-2026-04-15-1a2b3c4d
```

```
Verificados 4437 de 4437 archivos en /Users/tu-usuario/Estudios/evacenter-2026-04-15-1a2b3c4d
Todo íntegro: cada archivo coincide con su checksum y los DICOM son válidos.
```

Compara cada archivo con su hash, revisa que los `.dcm` tengan cabecera DICOM válida y reporta
faltantes. Como el formato es el estándar, también funciona con herramientas del sistema:

```bash
cd ~/Estudios/evacenter-2026-04-15-1a2b3c4d
shasum -a 256 -c checksums.sha256     # macOS
sha256sum -c checksums.sha256         # Linux
```

¿Quieres guardarlo todo en un solo archivo para llevarlo a otro disco?

```bash
tar -czf respaldo-2026-04-15.tar.gz evacenter-2026-04-15-1a2b3c4d
```

## 👀 Cómo ver las imágenes

Todos estos proyectos son libres y abren directamente la carpeta `series/`:

| Proyecto | Plataforma | Para qué sirve |
| --- | --- | --- |
| [**Weasis**](https://github.com/nroduit/Weasis) | Windows, macOS, Linux | El más directo: abres la carpeta y exploras series, MPR y medidas |
| [**Horos**](https://github.com/horosproject/horos) | macOS | Visor clásico estilo OsiriX; arrastra la carpeta completa |
| [**3D Slicer**](https://github.com/Slicer/Slicer) | Multiplataforma | Reconstrucción 3D, segmentación y medidas avanzadas |
| [**OHIF Viewer**](https://github.com/OHIF/Viewers) | Web | Visor web; necesita un servidor DICOMweb |
| [**Orthanc**](https://github.com/jodogne/Orthanc) | Multiplataforma, Docker | Convierte tu carpeta en un mini-PACS y la publica en tu red |
| [**dicomweb-pacs**](https://github.com/knopkem/dicomweb-pacs) | Docker | PACS con DICOMweb y DIMSE, listo para OHIF |
| [**AlizaMS**](https://github.com/AlizaMedicalImaging/AlizaMS) | Windows, macOS, Linux | Visor ligero con MPR |
| [**dcm2niix**](https://github.com/rordenlab/dcm2niix) | Multiplataforma | Convierte a NIfTI para visores 3D o investigación |
| [**dicom2jpg**](https://github.com/ykuo2/dicom2jpg) | Python | Convierte a JPG/PNG para compartir o adjuntar |
| [**pydicom**](https://github.com/pydicom/pydicom) | Python | Automatizar, extraer metadatos y anonimizar |
| [**DCMTK**](https://github.com/DCMTK/dcmtk) | Multiplataforma | Utilidades de línea de comandos (`dcmdump`, `dcmconv`) |
| [**dcmjs**](https://github.com/dcmjs-org/dcmjs) | JavaScript | Leer y escribir DICOM en el navegador o en Node |

Si vas a compartir el estudio con alguien, **anonimízalo antes**:
[pydicom/deid](https://github.com/pydicom/deid) y las utilidades de DCMTK pueden quitar los datos del
paciente de los archivos.

## 🧠 Cómo funciona por dentro

1. El enlace del visor trae dos parámetros: `studyId` y `ac`. El segundo es base64 de
   `user=…&password=…&extra_validation=…`, es decir, las credenciales de una cuenta de visitante.
2. Con esas credenciales se pide un token en `POST https://api.evacenter.com/graphql/`
   (mutación `getVisitantTokenAuth`).
3. **Todas** las peticiones deben llevar las cabeceras `credentials: <ac>` y `resource: <studyId>`.
   Sin `resource` el servidor responde `visitant_permission_denied`.
4. Los documentos GraphQL viven en [`queries/`](queries) y **se envían tal cual**, incluidos los
   `__typename` que añade Apollo. El servidor solo autoriza al rol visitante las consultas exactas
   que usa su propio visor: si se recortan campos, la operación se deniega. Por eso no se generan
   consultas dinámicas; si el visor cambia, hay que actualizar esos archivos.
5. `GetSeriesThumbnailsAndFilesByStudyId` devuelve las series, miniaturas, documentos e informes;
   `CustomFiles(serieId)` da una URL por imagen; `getStudyInfoById` aporta los datos del estudio.
6. Los archivos se sirven desde `files.evacenter.com`. El PDF del informe exige la cabecera
   `Referer: https://pacs.evacenter.com/`. Cada archivo se valida antes de escribirse en disco.

Los archivos de `queries/` no contienen credenciales: el `ac` solo se usa en memoria y nunca se
escribe en disco.

### Estructura del proyecto

```
evacenter.ts              CLI completo (parser de argumentos, cliente GraphQL, lector DICOM, descargador)
evacenter.test.ts         8 pruebas con bun:test, sin red
queries/                  Documentos GraphQL que usa el visor (no tocar a la ligera)
.github/workflows/        CI: bun test + --help
```

```bash
bun test          # pruebas
bun run evacenter --help
```

## ⚠️ Límites conocidos

- El enlace **caduca** (normalmente en unas 24 horas) o la clínica puede revocarlo. Si falla por
  permisos, pide un enlace nuevo y vuelve a ejecutar el mismo comando: lo ya descargado no se pierde.
- El rol visitante no tiene acceso al ZIP del estudio que sí ofrece el visor clínico, así que las
  imágenes se descargan una por una (ventaja: el proceso es reanudable).
- Solo se descarga lo que el enlace permita ver. Si el visor no muestra una serie, aquí tampoco estará.
- No genera un `DICOMDIR`, porque hacerlo bien exige reescribir los archivos; las carpetas son
  autoexplicativas y todos los visores modernos leen las etiquetas internas del DICOM.
- Los informes en PDF solo aparecen si la clínica ya los publicó.

## ❓ Preguntas frecuentes

**¿Sirve para el estudio de otra persona?**
Técnicamente sí; legalmente, solo con su autorización. Descargar datos médicos de terceros sin
permiso puede ser un delito.

**¿Modifica o recomprime las imágenes?**
No. Los `.dcm` se guardan byte a byte igual que los entrega el servidor.

**Caducó el enlace y ya no puedo volver a bajarlo, ¿qué hago?**
Pide un enlace nuevo a la clínica y vuelve a ejecutar el comando: el respaldo continúa donde iba.
Lo ya descargado sirve para siempre.

**¿Puedo recuperar un estudio de hace años?**
Solo si la clínica todavía lo conserva y te genera un enlace. Motivo de más para respaldarlo hoy.

**¿Funciona en Windows?**
Sí, con [Bun](https://bun.sh) instalado.

**¿Y si la clínica cambia su visor?**
Actualiza los documentos de `queries/` con los del visor nuevo. Todo lo demás sigue igual.

## 🤝 Privacidad y uso responsable

- **Es para tus propios estudios**, o para aquellos donde tengas autorización del paciente.
- El enlace **es una credencial**: quien lo tenga puede ver el estudio. No lo compartas, no lo
  publiques en foros y no lo pegues en servicios de terceros.
- La carpeta descargada contiene datos médicos personales: guárdala cifrada y no la subas a
  repositorios, nubes públicas ni chats.
- El proyecto no envía telemetría ni datos a ningún servidor distinto del propio PACS.

## 📄 Licencia

[MIT](LICENSE). Este proyecto **no está afiliado** a Evacenter ni a Eden: usa la misma API que
consume su visor público, sin automatizar nada que un paciente no pueda hacer a mano.

---

<sub>Si te sirvió, deja una ⭐ — ayuda a que otras personas encuentren una forma de quedarse con sus estudios.</sub>
