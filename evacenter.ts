#!/usr/bin/env bun
/**
 * evacenter — respaldo completo de estudios del visor PACS de Evacenter.
 *
 * Descarga las imágenes DICOM originales, las miniaturas, los documentos y el
 * informe de cualquier estudio al que tengas acceso con un enlace del visor
 * (https://pacs.evacenter.com/...), y deja un manifiesto con checksums para
 * poder verificar el respaldo años después.
 *
 * Los archivos se guardan byte a byte como los sirve el PACS: no se recomprimen,
 * no se renombran sus etiquetas internas ni se modifican.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative as relativePath, resolve } from 'node:path';

const VERSION = '1.0.0';
const DEFAULT_API = 'https://api.evacenter.com';
const DEFAULT_REFERER = 'https://pacs.evacenter.com/';
const QUERIES = join(import.meta.dir, 'queries');
const INCOMING = '.incoming';
const LONG_VR = new Set(['OB', 'OW', 'OF', 'SQ', 'UT', 'UN', 'UR', 'OD', 'OL', 'UC', 'OV', 'SV', 'UV']);
const WANTED: Record<string, string> = {
  '0002,0010': 'TransferSyntaxUID',
  '0008,0018': 'SOPInstanceUID',
  '0008,0020': 'StudyDate',
  '0008,0060': 'Modality',
  '0008,0070': 'Manufacturer',
  '0008,103e': 'SeriesDescription',
  '0018,0050': 'SliceThickness',
  '0020,000d': 'StudyInstanceUID',
  '0020,000e': 'SeriesInstanceUID',
  '0020,0011': 'SeriesNumber',
  '0020,0013': 'InstanceNumber',
  '0028,0010': 'Rows',
  '0028,0011': 'Columns',
};
const FILE_HEADERS = { Referer: DEFAULT_REFERER, Origin: DEFAULT_REFERER.replace(/\/$/, ''), 'User-Agent': `evacenter/${VERSION}` };

export const help = `Respalda estudios del visor PACS de Evacenter (pacs.evacenter.com).

  bun run evacenter <enlace>              Descarga el estudio completo
  bun run evacenter info <enlace>         Muestra el inventario sin descargar
  bun run evacenter verify <carpeta>      Verifica un respaldo ya descargado

Opciones:
  --out, -o <carpeta>     Dónde guardar (por defecto ./evacenter-<fecha>-<estudio>)
  --series, -s 2,4,350    Descarga solo esas series (número de serie)
  --limit N               Máximo de imágenes por serie (para probar)
  --concurrency, -c N     Descargas simultáneas (1–16, por defecto 6)
  --no-thumbnails         No descargar miniaturas ni vistas previas
  --mask                  Muestra el nombre del paciente oculto en la consola
  --json                  Salida JSON en info y verify
  --quiet, -q             Menos mensajes
  --refresh               Ignora el inventario previo y lo consulta de nuevo
  --api-base <url>        Servidor GraphQL (por defecto ${DEFAULT_API})
  --help, -h              Esta ayuda

El enlace contiene tus credenciales de acceso: no lo compartas ni lo pegues en
sitios públicos. Descarga solo estudios tuyos o para los que tengas permiso.
`;

interface Series {
  id: string;
  number?: number;
  description?: string;
  modality?: string;
  instanceCount?: number;
  thumbnail?: string | null;
  segmentation?: string | null;
  files: Array<{ id: string; url: string; mobile: string | null }>;
  instances?: Instance[];
}
interface Instance {
  file: string;
  instanceId: string;
  bytes: number;
  instanceNumber: number | null;
  sopInstanceUid: string | null;
  transferSyntax: string | null;
}
interface Manifest {
  studyId: string;
  generatedAt: string;
  completedAt?: string;
  tool: string;
  study: any;
  series: Series[];
  documents: Array<{ name: string; url: string }>;
  bookmarks: Array<{ url: string }>;
  reports: Array<{ status: string; pdfUrl: string; signedAt: string | null }>;
  checksums?: number;
}

export function parseArgs(argv: string[]) {
  const options = {
    command: 'download',
    link: '',
    out: '',
    series: [] as string[],
    limit: 0,
    concurrency: 6,
    thumbnails: true,
    mask: false,
    json: false,
    quiet: false,
    refresh: false,
    help: false,
    apiBase: DEFAULT_API,
  };
  const args = [...argv];
  if (args[0] && ['download', 'info', 'verify'].includes(args[0])) options.command = args.shift() as string;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const value = () => {
      const given = args[++i];
      if (!given || given.startsWith('--')) throw new Error(`Falta el valor de ${arg}.`);
      return given;
    };
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--quiet' || arg === '-q') options.quiet = true;
    else if (arg === '--mask') options.mask = true;
    else if (arg === '--no-thumbnails') options.thumbnails = false;
    else if (arg === '--refresh') options.refresh = true;
    else if (arg === '--out' || arg === '-o') options.out = value();
    else if (arg === '--api-base') options.apiBase = value().replace(/\/+$/, '');
    else if (arg === '--series' || arg === '-s') options.series.push(...value().split(',').map((s) => s.trim()).filter(Boolean));
    else if (arg === '--limit') {
      options.limit = Number(value());
      if (!Number.isInteger(options.limit) || options.limit < 1) throw new Error('--limit debe ser un entero mayor que cero.');
    } else if (arg === '--concurrency' || arg === '-c') {
      options.concurrency = Number(value());
      if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 16) throw new Error('--concurrency debe ser un entero entre 1 y 16.');
    } else if (arg.startsWith('-')) throw new Error(`Opción desconocida: ${arg}. Usa --help.`);
    else if (!options.link) options.link = arg;
    else throw new Error(`Argumento de más: ${arg}. Usa --help.`);
  }
  if (!options.help && !options.link) throw new Error('Falta el enlace del estudio o la carpeta. Usa --help.');
  return options;
}

/** Extrae el identificador del estudio y las credenciales del enlace del visor. */
export function parseLink(input: string) {
  let url: URL;
  try {
    url = new URL(String(input).trim());
  } catch {
    throw new Error('El enlace no es una URL válida. Cópialo completo desde el correo o mensaje de la clínica.');
  }
  if (!/^https?:$/.test(url.protocol)) throw new Error('El enlace debe empezar con https://');
  const studyId = url.searchParams.get('studyId') || '';
  const raw = url.searchParams.get('ac') || '';
  if (!studyId) throw new Error(`El enlace no trae el parámetro studyId (${url.host}). Copia el enlace completo que abre el visor.`);
  if (!raw) throw new Error('El enlace no trae el parámetro ac, que lleva las credenciales de acceso. Cópialo completo, sin recortarlo.');
  const ac = safeDecode(raw);
  const { user, password } = decodeCredentials(ac);
  if (!user || !password) throw new Error('Las credenciales del enlace (ac) están incompletas o dañadas. Pide un enlace nuevo a la clínica.');
  return { host: url.host, studyId, ac, user, password };
}

function safeDecode(text: string) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** El parámetro `ac` es base64 de `user=...&password=...&extra_validation=...`. */
export function decodeCredentials(ac: string) {
  try {
    const params = new URLSearchParams(Buffer.from(safeDecode(ac), 'base64').toString('utf8'));
    return { user: params.get('user') || '', password: params.get('password') || '' };
  } catch {
    return { user: '', password: '' };
  }
}

/** Nombre de carpeta seguro y legible para personas. */
export function slug(text: unknown, fallback = 'sin-nombre') {
  const clean = String(text ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return clean || fallback;
}

export function pad(value: unknown, width: number) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? String(Math.trunc(number)).padStart(width, '0') : '';
}

export function seriesFolder(series: { number?: unknown; description?: unknown; modality?: unknown }, index: number) {
  const number = pad(series.number, 3) || String(index + 1).padStart(3, '0');
  return `${number}-${slug(series.description || series.modality || 'serie')}`;
}

/** Nombres ordenables y estables para los DICOM, derivados del propio archivo. */
export function standardName(tags: Record<string, string>, used: Set<string>, fallback: string) {
  const base = pad(tags.InstanceNumber, 4) || slug(tags.SOPInstanceUID || fallback, 'imagen');
  let name = `${base}.dcm`;
  if (used.has(name)) name = `${base}-${slug(tags.SOPInstanceUID || String(used.size))}.dcm`;
  used.add(name);
  return name;
}

/** Salta secuencias de longitud indefinida (habituales en equipos GE y Siemens). */
function skipUndefinedLength(buf: Buffer, start: number) {
  let offset = start;
  let depth = 1;
  while (offset + 8 <= buf.length) {
    const group = buf.readUInt16LE(offset);
    const element = buf.readUInt16LE(offset + 2);
    if (group === 0xfffe) {
      const length = buf.readUInt32LE(offset + 4);
      const item = element === 0xe000 && length !== 0xffffffff;
      if (element === 0xe000 && length === 0xffffffff) depth++;
      else if (element === 0xe00d || element === 0xe0dd) {
        depth--;
        if (depth === 0) return offset + 8;
      }
      offset += 8 + (item ? length : 0);
      continue;
    }
    const vr = buf.toString('latin1', offset + 4, offset + 6);
    let length: number;
    let next: number;
    if (/^[A-Z]{2}$/.test(vr)) {
      if (LONG_VR.has(vr)) {
        length = buf.readUInt32LE(offset + 8);
        next = offset + 12 + (length === 0xffffffff ? 0 : length);
      } else {
        length = buf.readUInt16LE(offset + 6);
        next = offset + 8 + length;
      }
    } else {
      length = buf.readUInt32LE(offset + 4);
      next = offset + 8 + (length === 0xffffffff ? 0 : length);
    }
    if (length === 0xffffffff) depth++;
    if (next <= offset) return start;
    offset = next;
  }
  return offset;
}

/** Lee etiquetas DICOM básicas sin depender de librerías externas. */
export function dicomInfo(buf: Buffer) {
  const tags: Record<string, string> = {};
  const isDicom = buf.length > 132 && buf.subarray(128, 132).toString('latin1') === 'DICM';
  if (!isDicom) return { isDicom, tags };
  let offset = 132;
  while (offset + 8 <= buf.length) {
    const group = buf.readUInt16LE(offset);
    const element = buf.readUInt16LE(offset + 2);
    let vr = buf.toString('latin1', offset + 4, offset + 6);
    let length: number;
    let start: number;
    if (/^[A-Z]{2}$/.test(vr)) {
      if (LONG_VR.has(vr)) {
        length = buf.readUInt32LE(offset + 8);
        start = offset + 12;
      } else {
        length = buf.readUInt16LE(offset + 6);
        start = offset + 8;
      }
    } else {
      vr = '';
      length = buf.readUInt32LE(offset + 4);
      start = offset + 8;
    }
    if (length === 0xffffffff) {
      const end = skipUndefinedLength(buf, start);
      if (end <= offset) break;
      offset = end;
      continue;
    }
    if (group === 0x7fe0 && element === 0x0010) break;
    const name = WANTED[`${group.toString(16).padStart(4, '0')},${element.toString(16).padStart(4, '0')}`];
    if (name && start + length <= buf.length) {
      const slice = buf.subarray(start, start + length);
      if (vr === 'US') tags[name] = String(length >= 2 ? slice.readUInt16LE(0) : 0);
      else if (vr === 'UL') tags[name] = String(length >= 4 ? slice.readUInt32LE(0) : 0);
      else tags[name] = slice.toString('latin1').replace(/\0+$/, '').trim();
    }
    const next = start + length;
    if (next <= offset) break;
    offset = next;
  }
  return { isDicom: true, tags };
}

export function sha256(buf: Buffer) {
  return createHash('sha256').update(buf).digest('hex');
}

export function checksumLines(files: Array<{ path: string; hash: string }>) {
  return files.map((file) => `${file.hash}  ${file.path.split(/[\\/]/).join('/')}`).join('\n') + '\n';
}

export function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const query = (name: string) => readFileSync(join(QUERIES, `${name}.graphql`), 'utf8');
const operation = (document: string) => (document.match(/(?:query|mutation)\s+(\w+)/) || [])[1];

/**
 * Cliente GraphQL. Dos detalles que no son opcionales:
 *   - las cabeceras `credentials` (el ac) y `resource` (el estudio) van en todas
 *     las peticiones, incluido el login;
 *   - los documentos se envían tal cual están en queries/, con sus __typename,
 *     porque el servidor solo autoriza al rol visitante las consultas exactas
 *     que usa su propio visor.
 */
export function createClient(link: { ac: string; studyId: string; user: string; password: string }, apiBase = DEFAULT_API) {
  let token = '';
  const endpoint = `${apiBase}/graphql/`;
  const send = async (document: string, variables: Record<string, unknown>) => {
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', credentials: link.ac, resource: link.studyId, ...(token ? { authorization: `JWT ${token}` } : {}) },
        body: JSON.stringify({ operationName: operation(document), variables, query: document }),
        signal: AbortSignal.timeout(60000),
      });
    } catch {
      throw new Error('No pude conectar con el servidor. Revisa tu conexión e intenta de nuevo.');
    }
    if (response.status === 429) throw new Error('El servidor limitó las consultas. Espera un momento e intenta de nuevo.');
    let payload: any;
    try {
      payload = await response.json();
    } catch {
      throw new Error('El servidor devolvió una respuesta inesperada.');
    }
    if (payload.errors?.length) {
      const denied = payload.errors.some((e: any) => e.code === 'visitant_permission_denied') || payload.errors.some((e: any) => /permiso/i.test(e.message || ''));
      if (denied) throw new Error('El enlace no da acceso a este estudio: puede haber caducado o la clínica lo revocó. Pide un enlace nuevo.');
      throw new Error(payload.errors[0].message || 'El servidor rechazó la consulta.');
    }
    return payload.data;
  };
  return {
    async login() {
      const data = await send(query('login'), { input: { email: link.user, password: link.password } });
      token = data.tokenAuth?.token || '';
      if (!token) throw new Error('El enlace ya no sirve para entrar: sus credenciales expiraron o fueron revocadas. Pide un enlace nuevo.');
    },
    /** Metadatos del estudio. Es opcional: si el servidor los niega, el respaldo continúa. */
    async studyInfo(studyId: string) {
      try {
        return (await send(query('studyinfo'), { id: studyId })).study;
      } catch {
        return null;
      }
    },
    async series(studyId: string) {
      return send(query('series'), { studyId });
    },
    async seriesFiles(serieId: string) {
      return (await send(query('serie'), { serieId })).serie;
    },
  };
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Descarga con reintentos. El servidor de archivos exige la cabecera Referer. */
export async function fetchFile(url: string, tries = 4) {
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const response = await fetch(url, { headers: FILE_HEADERS, signal: AbortSignal.timeout(120000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buf = Buffer.from(await response.arrayBuffer());
      if (!buf.length) throw new Error('archivo vacío');
      return buf;
    } catch (error) {
      if (attempt === tries) throw error;
      await sleep(500 * attempt * attempt);
    }
  }
  throw new Error('descarga fallida');
}

async function pool<T>(items: T[], size: number, worker: (item: T) => Promise<void>) {
  let index = 0;
  let running = 0;
  await new Promise<void>((done) => {
    const next = () => {
      if (index >= items.length) {
        if (!running) done();
        return;
      }
      const item = items[index++];
      running++;
      worker(item)
        .catch(() => {})
        .finally(() => {
          running--;
          next();
        });
    };
    for (let k = 0; k < Math.min(size, items.length); k++) next();
  });
}

type Job = { url: string; temp: string; kind: 'dicom' | 'jpg' | 'pdf'; seriesIndex?: number; instanceId?: string };

const maskName = (text: string) => String(text || '').replace(/\p{L}[\p{L}'´.-]{2,}/gu, (word) => word[0] + '·'.repeat(word.length - 1));

async function runBackup(options: ReturnType<typeof parseArgs>) {
  // Con --json la salida estándar queda limpia para las tuberías y todo lo humano va a stderr.
  const log = (message = '') => {
    if (options.quiet) return;
    if (options.json) console.error(message);
    else console.log(message);
  };
  const link = parseLink(options.link);
  const client = createClient(link, options.apiBase);
  await client.login();
  log('Acceso autorizado por el servidor.');

  const info = await client.studyInfo(link.studyId);
  const inventory = await client.series(link.studyId);
  const seriesList: any[] = (inventory.seriesThumbnails || []).filter(Boolean);
  if (!seriesList.length) throw new Error('El estudio no tiene series visibles con este enlace.');

  const date = String(info?.dicomDateTime || '').slice(0, 10);
  const outDir = resolve(options.out || `evacenter-${date ? `${date}-` : ''}${link.studyId.slice(0, 8)}`);
  const selected = options.series.length ? seriesList.filter((s) => options.series.includes(String(s.dicomNumber))) : seriesList;
  if (!selected.length) throw new Error(`Ninguna serie coincide con --series ${options.series.join(',')}.`);

  const shown = (value: string) => (options.mask ? maskName(value) : value);
  log('');
  log(`Paciente: ${shown(info?.patient?.fullName || 'no informado por el servidor')}`);
  if (info) log(`Estudio: ${info.dicomDescription || 'sin descripción'} · ${info.dicomDateTime || 'sin fecha'} · ${info.modalitiesList || info.modalities || ''}`);
  if (info?.facility?.name) log(`Centro: ${info.facility.name}`);
  log(`Series: ${seriesList.length} · imágenes: ${seriesList.reduce((total, s) => total + (s.instanceCount || 0), 0)} · informes: ${(inventory.study?.reports || []).filter((r: any) => r?.pdfUrl).length}`);

  if (options.command === 'info') {
    if (options.json) {
      console.log(JSON.stringify({ studyId: link.studyId, patient: info?.patient ?? null, study: info ?? null, series: selected.map((s) => ({ number: s.dicomNumber, description: s.dicomDescription, modality: s.modality, images: s.instanceCount })) }, null, 2));
      return;
    }
    console.table(selected.map((s) => ({ Serie: s.dicomNumber, Modalidad: s.modality, Imágenes: s.instanceCount, Descripción: s.dicomDescription || '' })));
    log(`Carpeta sugerida: ${outDir}`);
    log('No se descargó nada. Usa el mismo comando sin `info` para respaldar el estudio.');
    return;
  }

  mkdirSync(outDir, { recursive: true });
  const manifestPath = join(outDir, 'manifest.json');
  let manifest: Manifest;
  const previous: Manifest | null = !options.refresh && existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null;
  if (previous) {
    manifest = previous;
    log('Reutilizo el inventario previo (usa --refresh para consultarlo de nuevo).');
  } else {
    manifest = { studyId: link.studyId, generatedAt: new Date().toISOString(), tool: `evacenter ${VERSION}`, study: info ?? null, series: [], documents: [], bookmarks: [], reports: [] };
    const carried = new Map((previous?.series ?? []).map((s) => [s.seriesId, s.instances ?? []]));
    for (const s of selected) {
      let files: any[] = [];
      try {
        const detail = await client.seriesFiles(s.id);
        files = (detail?.instanceFiles || []).filter((f: any) => f?.fileUrl);
      } catch (error) {
        log(`  aviso: la serie ${s.dicomNumber} no se pudo listar (${(error as Error).message})`);
      }
      if (options.limit) files = files.slice(0, options.limit);
      manifest.series.push({
        seriesId: s.id,
        number: s.dicomNumber,
        description: s.dicomDescription,
        modality: s.modality,
        instanceCount: s.instanceCount,
        thumbnail: s.thumbnail || null,
        segmentation: s.series?.segmentationFileUrl || null,
        files: files.map((f: any) => ({ id: f.id, url: f.fileUrl, mobile: f.mobileFileUrl || null })),
        instances: carried.get(s.id) ?? [],
      });
      log(`  serie ${pad(s.dicomNumber, 3) || '?'} ${s.modality} · ${files.length} archivos · ${s.dicomDescription || ''}`);
    }
    manifest.documents = (inventory.orderStudyFiles || []).filter((f: any) => f?.fileUrl).map((f: any) => ({ name: f.name || 'documento', url: f.fileUrl }));
    manifest.bookmarks = (inventory.imageBookmarks || []).filter((b: any) => b?.fileUrl).map((b: any) => ({ url: b.fileUrl }));
    manifest.reports = (inventory.study?.reports || []).filter((r: any) => r?.pdfUrl).map((r: any) => ({ status: r.status || '', pdfUrl: r.pdfUrl, signedAt: r.signedAt || null }));
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  }

  const folders = manifest.series.map((s, index) => seriesFolder(s, index));
  const jobs: Job[] = [];
  manifest.series.forEach((s, index) => {
    const dir = join(outDir, 'series', folders[index]);
    s.files.forEach((file, i) => {
      jobs.push({ url: file.url, temp: join(dir, INCOMING, `${String(i + 1).padStart(5, '0')}_${file.id}.dcm`), kind: 'dicom', seriesIndex: index, instanceId: file.id });
      if (file.mobile && options.thumbnails) jobs.push({ url: file.mobile, temp: join(dir, 'vista-previa', `${String(i + 1).padStart(4, '0')}.jpg`), kind: 'jpg' });
    });
    if (s.thumbnail && options.thumbnails) jobs.push({ url: s.thumbnail, temp: join(dir, 'miniatura.jpg'), kind: 'jpg' });
    if (s.segmentation) jobs.push({ url: s.segmentation, temp: join(dir, 'segmentacion.dcm'), kind: 'dicom', seriesIndex: index });
  });
  manifest.documents.forEach((doc, i) => jobs.push({ url: doc.url, temp: join(outDir, 'documentos', `${String(i + 1).padStart(2, '0')}-${slug(doc.name)}.pdf`), kind: 'pdf' }));
  manifest.bookmarks.forEach((bookmark, i) => jobs.push({ url: bookmark.url, temp: join(outDir, 'marcadores', `marcador-${i + 1}.jpg`), kind: 'jpg' }));
  manifest.reports.forEach((rep, i) => jobs.push({ url: rep.pdfUrl, temp: join(outDir, 'informes', `informe-${i + 1}-${slug(rep.status || 'informe')}.pdf`), kind: 'pdf' }));

  const already = new Set(manifest.series.flatMap((s) => (s.instances ?? []).map((i) => i.instanceId)));
  log('');
  log(`Descargando ${jobs.length} archivos (${options.concurrency} en paralelo).`);
  log('Puedes interrumpir con Ctrl+C y volver a ejecutar: se reanuda sin repetir lo bajado.');
  const failed: string[] = [];
  let done = 0;
  let bytes = 0;
  await pool(jobs, options.concurrency, async (job) => {
    try {
      if (job.instanceId && already.has(job.instanceId)) return;
      if (existsSync(job.temp) && statSync(job.temp).size > 0) return;
      const buf = await fetchFile(job.url);
      if (job.kind === 'dicom' && buf.subarray(128, 132).toString('latin1') !== 'DICM') throw new Error('el servidor devolvió algo que no es DICOM');
      if (job.kind === 'jpg' && !(buf[0] === 0xff && buf[1] === 0xd8)) throw new Error('el servidor devolvió algo que no es JPEG');
      if (job.kind === 'pdf' && buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('el informe todavía no está publicado en el servidor');
      mkdirSync(dirname(job.temp), { recursive: true });
      writeFileSync(job.temp, buf);
      bytes += buf.length;
    } catch (error) {
      failed.push(`${(error as Error).message} (${job.kind})`);
      rmSync(job.temp, { force: true });
    }
    if (++done % 250 === 0) log(`  ${done}/${jobs.length} · ${(bytes / 1e6).toFixed(0)} MB nuevos · fallos ${failed.length}`);
  });

  // Ordena los nombres de los DICOM con los metadatos reales y arma el manifiesto.
  const checksums: Array<{ path: string; hash: string }> = [];
  manifest.series.forEach((series, index) => {
    const dir = join(outDir, 'series', folders[index]);
    const used = new Set<string>((series.instances ?? []).map((i) => i.file));
    const incoming = walk(join(dir, INCOMING)).filter((file) => file.toLowerCase().endsWith('.dcm'));
    series.instances = series.instances ?? [];
    for (const file of incoming.sort()) {
      const buf = readFileSync(file);
      const { tags } = dicomInfo(buf);
      const name = standardName(tags, used, basename(file).replace(/\.dcm$/i, ''));
      renameSync(file, join(dir, name));
      series.instances.push({ file: name, instanceId: basename(file).replace(/\.dcm$/i, '').split('_')[1] ?? name, bytes: buf.length, instanceNumber: tags.InstanceNumber ? Number(tags.InstanceNumber) : null, sopInstanceUid: tags.SOPInstanceUID ?? null, transferSyntax: tags.TransferSyntaxUID ?? null });
    }
    series.instances.sort((a, b) => (a.instanceNumber ?? 0) - (b.instanceNumber ?? 0) || a.file.localeCompare(b.file));
    for (const instance of series.instances) {
      const file = join(dir, instance.file);
      if (existsSync(file)) checksums.push({ path: relativePath(outDir, file), hash: sha256(readFileSync(file)) });
    }
    for (const file of walk(dir)) {
      if (file.includes(INCOMING) || file.toLowerCase().endsWith('.dcm')) continue;
      checksums.push({ path: relativePath(outDir, file), hash: sha256(readFileSync(file)) });
    }
    rmSync(join(dir, INCOMING), { recursive: true, force: true });
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  });
  for (const extra of ['informes', 'documentos', 'marcadores']) {
    for (const file of walk(join(outDir, extra))) checksums.push({ path: relativePath(outDir, file), hash: sha256(readFileSync(file)) });
  }
  writeFileSync(join(outDir, 'checksums.sha256'), checksumLines(checksums.sort((a, b) => a.path.localeCompare(b.path))));
  if (info) writeFileSync(join(outDir, 'info.json'), JSON.stringify(info, null, 2));
  manifest.checksums = checksums.length;
  manifest.completedAt = new Date().toISOString();
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  writeFileSync(join(outDir, 'LEEME.txt'), readmeForExport(manifest, outDir));

  const images = manifest.series.reduce((total, s) => total + (s.instances?.length ?? 0), 0);
  log('');
  log(`Listo: ${images} imágenes DICOM y ${checksums.length - images} archivos adicionales en`);
  log(`  ${outDir}`);
  log('Incluye manifest.json, info.json, checksums.sha256 y LEEME.txt con cómo verlo.');
  if (failed.length) {
    log(`Atención: ${failed.length} archivo(s) no se pudieron bajar. Vuelve a ejecutar el mismo comando para reintentar.`);
    for (const message of [...new Set(failed)].slice(0, 6)) log(`  ${message}`);
    process.exitCode = 1;
  }
}

async function verifyBackup(options: ReturnType<typeof parseArgs>) {
  const dir = resolve(options.link || options.out || '.');
  const checksumFile = join(dir, 'checksums.sha256');
  if (!existsSync(checksumFile)) throw new Error(`No encontré ${checksumFile}. Apunta a una carpeta creada por evacenter.`);
  const lines = readFileSync(checksumFile, 'utf8').split('\n').filter((line) => line.trim());
  let ok = 0;
  const damaged: string[] = [];
  const missing: string[] = [];
  for (const line of lines) {
    const [hash, ...rest] = line.trim().split(/\s+/);
    const name = rest.join(' ');
    const file = join(dir, name);
    if (!existsSync(file)) {
      missing.push(name);
      continue;
    }
    const buf = readFileSync(file);
    if (sha256(buf) !== hash) damaged.push(name);
    else if (file.toLowerCase().endsWith('.dcm') && buf.subarray(128, 132).toString('latin1') !== 'DICM') damaged.push(name);
    else ok++;
  }
  if (options.json) {
    console.log(JSON.stringify({ folder: dir, ok, damaged, missing }, null, 2));
    if (damaged.length || missing.length) process.exitCode = 1;
    return;
  }
  console.log(`Verificados ${ok} de ${lines.length} archivos en ${dir}`);
  if (missing.length) console.log(`  faltan ${missing.length}: ${missing.slice(0, 5).join(', ')}`);
  if (damaged.length) console.log(`  dañados ${damaged.length}: ${damaged.slice(0, 5).join(', ')}`);
  if (damaged.length || missing.length) process.exitCode = 1;
  else console.log('Todo íntegro: cada archivo coincide con su checksum y los DICOM son válidos.');
}

function readmeForExport(manifest: Manifest, outDir: string) {
  const images = manifest.series.reduce((total, s) => total + (s.instances?.length ?? 0), 0);
  return `Respaldo de estudio — evacenter ${VERSION}
Generado: ${manifest.completedAt || new Date().toISOString()}
Estudio: ${manifest.study?.dicomDescription || ''} ${manifest.study?.dicomDateTime || ''}
Series: ${manifest.series.length} · Imágenes DICOM: ${images} · Informes: ${manifest.reports?.length || 0}

ESTRUCTURA
  series/<numero>-<descripcion>/0001.dcm   Imágenes DICOM originales, sin modificar
  series/.../miniatura.jpg                 Miniatura de la serie
  informes/                                Informes en PDF
  documentos/                              Otros documentos del estudio
  marcadores/                              Imágenes marcadas en el visor
  info.json                                Datos del estudio y del paciente
  manifest.json                            Inventario técnico, metadatos y checksums
  checksums.sha256                         Huellas SHA-256 para verificar el respaldo

VERIFICARLO
  bun run evacenter verify "${outDir}"
  O con herramientas estándar: entra a esta carpeta y ejecuta  shasum -a 256 -c checksums.sha256

CÓMO VER LAS IMÁGENES (programas libres)
  Weasis        https://github.com/nroduit/Weasis       Escritorio; abre la carpeta series
  Horos (macOS) https://github.com/horosproject/horos   Arrastra esta carpeta completa
  3D Slicer     https://github.com/Slicer/Slicer        Reconstrucción 3D, medidas, segmentación
  OHIF Viewer   https://github.com/OHIF/Viewers         Visor web (requiere servidor DICOMweb)
  Orthanc       https://github.com/jodogne/Orthanc      Publica el estudio en tu propia red
  dcm2niix      https://github.com/rordenlab/dcm2niix  Convierte DICOM a NIfTI para visores 3D
  dicom2jpg     https://github.com/ykuo2/dicom2jpg     Convierte a JPG/PNG para compartir
  pydicom       https://github.com/pydicom/pydicom     Automatizar, anonimizar o convertir a otro formato

PRIVACIDAD
  Esta carpeta contiene datos médicos personales. No la subas a repositorios, nubes
  públicas ni servicios de terceros sin anonimizarla antes.
`;
}

if (import.meta.main) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) console.log(help);
    else if (options.command === 'verify') await verifyBackup(options);
    else await runBackup(options);
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
