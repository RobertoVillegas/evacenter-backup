import { expect, test } from 'bun:test';
import { checksumLines, dicomInfo, pad, parseArgs, parseLink, seriesFolder, slug, standardName } from './evacenter';

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');
const AC = b64('user=alguien@example.com&password=secreto-123&extra_validation=abc');
const STUDY = '11111111-2222-3333-4444-555555555555';
const link = `https://pacs.evacenter.com/v2/mobile_viewer?studyId=${STUDY}&tab=images&ac=${AC}`;

test('parseLink acepta enlaces del visor con el ac codificado o crudo', () => {
  for (const candidate of [link, link.replace(encodeURIComponent(AC), AC), `${link}&md=1&tab=report`]) {
    const parsed = parseLink(candidate);
    expect(parsed.studyId).toBe(STUDY);
    expect(parsed.user).toBe('alguien@example.com');
    expect(parsed.password).toBe('secreto-123');
  }
});

test('parseLink explica qué falta en enlaces rotos', () => {
  expect(() => parseLink('esto no es una url')).toThrow(/URL válida/);
  expect(() => parseLink('ftp://pacs.evacenter.com/x')).toThrow(/https/);
  expect(() => parseLink(`https://pacs.evacenter.com/v2/mobile_viewer?ac=${AC}`)).toThrow(/studyId/);
  expect(() => parseLink(`https://pacs.evacenter.com/v2/mobile_viewer?studyId=${STUDY}`)).toThrow(/ac/);
  expect(() => parseLink(`https://pacs.evacenter.com/v2/mobile_viewer?studyId=${STUDY}&ac=$$$`)).toThrow(/credenciales/);
});

test('parseArgs entiende comandos, opciones y rechaza lo inválido', () => {
  expect(parseArgs([link]).command).toBe('download');
  expect(parseArgs(['info', link]).command).toBe('info');
  expect(parseArgs(['verify', './carpeta']).command).toBe('verify');
  const options = parseArgs(['download', link, '--out', './salida', '--series', '2,4', '--concurrency', '8', '--mask', '--limit', '5']);
  expect(options.series).toEqual(['2', '4']);
  expect(options.concurrency).toBe(8);
  expect(options.limit).toBe(5);
  expect(options.mask).toBe(true);
  expect(options.out).toBe('./salida');
  expect(parseArgs(['--help']).help).toBe(true);
  for (const args of [['--concurrency', '0', link], ['--limit', 'x', link], ['--out'], ['--nope', link], [link, 'otro']]) {
    expect(() => parseArgs(args as string[])).toThrow();
  }
});

test('slug, pad y seriesFolder generan nombres de carpeta legibles', () => {
  expect(slug('  Músculo  ¡Óseo! ')).toBe('musculo-oseo');
  expect(slug('', 'serie')).toBe('serie');
  expect(pad(17, 4)).toBe('0017');
  expect(pad(undefined, 4)).toBe('');
  expect(seriesFolder({ number: 250, description: 'AXIAL STD' }, 0)).toBe('250-axial-std');
  expect(seriesFolder({ description: 'HUESOS 0.6' }, 2)).toBe('003-huesos-0.6');
  expect(seriesFolder({}, 0)).toBe('001-serie');
});

const LONG_VR = ['OB', 'OW', 'OF', 'SQ', 'UT', 'UN', 'UR', 'OD', 'OL', 'UC'];
const el = (group: number, element: number, vr: string, value: Buffer) => {
  const head = Buffer.alloc(LONG_VR.includes(vr) ? 12 : 8);
  head.writeUInt16LE(group, 0);
  head.writeUInt16LE(element, 2);
  head.write(vr, 4, 'latin1');
  if (head.length === 12) head.writeUInt32LE(value.length, 8);
  else head.writeUInt16LE(value.length, 6);
  return Buffer.concat([head, value]);
};
const text = (value: string) => Buffer.from(value + '\0', 'latin1');
const us = (value: number) => {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(value, 0);
  return buf;
};
const synthetic = Buffer.concat([
  Buffer.alloc(128, 0),
  Buffer.from('DICM', 'latin1'),
  el(0x0002, 0x0010, 'UI', text('1.2.840.10008.1.2.4.70')),
  el(0x0008, 0x0018, 'UI', text('1.2.840.113619.2.55.3.1')),
  el(0x0008, 0x0060, 'CS', text('CT')),
  el(0x0008, 0x103e, 'LO', text('AXIAL STD')),
  el(0x0020, 0x0011, 'IS', text('250')),
  el(0x0020, 0x0013, 'IS', text('17')),
  el(0x0028, 0x0010, 'US', us(512)),
  el(0x0028, 0x0011, 'US', us(512)),
  el(0x7fe0, 0x0010, 'OB', Buffer.from([0xff, 0xd8, 0xff, 0xd9])),
]);

test('dicomInfo lee las etiquetas y se detiene antes de los píxeles', () => {
  const { isDicom, tags } = dicomInfo(synthetic);
  expect(isDicom).toBe(true);
  expect(tags.SOPInstanceUID).toBe('1.2.840.113619.2.55.3.1');
  expect(tags.InstanceNumber).toBe('17');
  expect(tags.SeriesNumber).toBe('250');
  expect(tags.Rows).toBe('512');
  expect(tags.Modality).toBe('CT');
  expect(tags.SeriesDescription).toBe('AXIAL STD');
  expect(tags.TransferSyntaxUID).toBe('1.2.840.10008.1.2.4.70');
  const other = dicomInfo(Buffer.from('%PDF-1.5 nada de esto es dicom', 'latin1'));
  expect(other.isDicom).toBe(false);
  expect(other.tags).toEqual({});
});

test('standardName ordena por número de instancia y evita choques', () => {
  expect(standardName({ InstanceNumber: '17' }, new Set<string>(), 'x')).toBe('0017.dcm');
  expect(standardName({ InstanceNumber: '17' }, new Set(['0017.dcm']), 'x')).toBe('0017-1.dcm');
  expect(standardName({ SOPInstanceUID: '1.2.3.4' }, new Set<string>(), 'x')).toBe('1.2.3.4.dcm');
  expect(standardName({}, new Set<string>(), 'fallback')).toBe('fallback.dcm');
});

test('checksumLines usa el formato estándar de sha256sum', () => {
  expect(checksumLines([{ path: 'series/001-axial/0001.dcm', hash: 'abc' }])).toBe('abc  series/001-axial/0001.dcm\n');
  expect(checksumLines([])).toBe('\n');
});

const sq = (group: number, element: number) => {
  const head = Buffer.alloc(12);
  head.writeUInt16LE(group, 0);
  head.writeUInt16LE(element, 2);
  head.write('SQ', 4, 'latin1');
  head.writeUInt32LE(0xffffffff, 8);
  return head;
};
const item = (undefinedLength = true) => {
  const head = Buffer.alloc(8);
  head.writeUInt16LE(0xfffe, 0);
  head.writeUInt16LE(0xe000, 2);
  head.writeUInt32LE(undefinedLength ? 0xffffffff : 0, 4);
  return head;
};
const close = (element: number) => {
  const head = Buffer.alloc(8);
  head.writeUInt16LE(0xfffe, 0);
  head.writeUInt16LE(element, 2);
  head.writeUInt32LE(0, 4);
  return head;
};

test('dicomInfo salta secuencias de longitud indefinida y sigue leyendo', () => {
  const withSequence = Buffer.concat([
    Buffer.alloc(128, 0),
    Buffer.from('DICM', 'latin1'),
    el(0x0002, 0x0010, 'UI', text('1.2.840.10008.1.2.4.70')),
    el(0x0008, 0x0060, 'CS', text('CT')),
    sq(0x0008, 0x1110),
    item(),
    el(0x0008, 0x1150, 'UI', text('1.2.840.10008.5.1.4.1.1.2')),
    sq(0x0040, 0xa730),
    item(true),
    el(0x0040, 0xa040, 'CS', text('CODE')),
    close(0xe00d),
    close(0xe0dd),
    close(0xe00d),
    close(0xe0dd),
    el(0x0020, 0x0013, 'IS', text('42')),
    el(0x0028, 0x0010, 'US', us(512)),
    el(0x7fe0, 0x0010, 'OB', Buffer.from([0xff, 0xd8])),
  ]);
  const { tags } = dicomInfo(withSequence);
  expect(tags.InstanceNumber).toBe('42');
  expect(tags.Rows).toBe('512');
  expect(tags.Modality).toBe('CT');
});
