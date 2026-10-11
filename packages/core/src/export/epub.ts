import JSZip from 'jszip';
import { XMLValidator } from 'fast-xml-parser';
import { interpolate } from '../interior/layout';
import type { Chapter, FlowBlock, InteriorDocument, PageElement, PageInstance } from '../interior/schema';
import { InteriorDocument as InteriorDocumentSchema } from '../interior/schema';
import { getTemplate } from '../interior/templates';
import type { EpubInspection } from '../validation/types';
import { fnv1a } from '../similarity';

const FIXED_DATE = new Date('2020-01-01T00:00:00Z');

const LANG: Record<string, string> = { english: 'en', spanish: 'es', french: 'fr', german: 'de', italian: 'it', portuguese: 'pt', dutch: 'nl', japanese: 'ja', arabic: 'ar', hebrew: 'he' };
export const languageCode = (l: string) => (/^[a-z]{2}(-[A-Z]{2})?$/.test(l) ? l : (LANG[l.toLowerCase()] ?? 'en'));

const esc = (s: string) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[c]!);

export interface EpubInput {
  document: InteriorDocument | unknown;
  title: string;
  subtitle?: string;
  author: string;
  language: string;
  description?: string;
  /** Stable identifier (e.g. project id) — produces a deterministic urn:uuid. */
  identifier: string;
  isbn?: string;
  coverPng?: Uint8Array;
  assets?: Record<string, { bytes: Uint8Array; mimeType: string }>;
  rtl?: boolean;
  modified?: Date;
}

function uuidFrom(id: string): string {
  const h = [0, 1, 2, 3].map((i) => fnv1a(id, 0x811c9dc5 + i * 7919).toString(16).padStart(8, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function inlineText(text: string, chapterIdx: number): string {
  return esc(text).replace(/\[\^(\d+)\]/g, (_, n) => `<sup><a epub:type="noteref" href="#note-${chapterIdx}-${n}" id="ref-${chapterIdx}-${n}">${n}</a></sup>`);
}

function blockHtml(b: FlowBlock, ci: number, assetName: (id: string) => string | undefined): string {
  switch (b.type) {
    case 'paragraph':
      return b.text.split(/\n+/).map((p) => `<p>${inlineText(p, ci)}</p>`).join('\n');
    case 'heading':
      return `<h${b.level}>${esc(b.text)}</h${b.level}>`;
    case 'quote':
      return `<blockquote><p>${inlineText(b.text, ci)}</p></blockquote>`;
    case 'list': {
      const tag = b.ordered ? 'ol' : 'ul';
      return `<${tag}>${b.items.map((i) => `<li>${inlineText(i, ci)}</li>`).join('')}</${tag}>`;
    }
    case 'image': {
      const src = assetName(b.assetId);
      if (!src) return '';
      return `<figure><img src="${src}" alt="${esc(b.caption || 'Illustration')}"/>${b.caption ? `<figcaption>${esc(b.caption)}</figcaption>` : ''}</figure>`;
    }
    case 'sectionBreak':
      return `<hr class="section-break"/>`;
    case 'pageBreak':
      return `<div class="page-break"></div>`;
  }
}

function elementHtml(el: PageElement, vars: Record<string, string | number | boolean>, assetName: (id: string) => string | undefined): string {
  switch (el.type) {
    case 'heading': {
      const t = interpolate(el.text, vars).trim();
      return t ? `<h3>${esc(t)}</h3>` : '';
    }
    case 'text': {
      const t = interpolate(el.text, vars).trim();
      return t ? t.split(/\n+/).map((p) => `<p>${esc(p)}</p>`).join('') : '';
    }
    case 'checklist':
      return el.items.length ? `<ul class="checklist">${el.items.map((i) => `<li>☐ ${esc(interpolate(i, vars))}</li>`).join('')}</ul>` : '';
    case 'table': {
      const head = `<tr>${el.columns.map((c) => `<th>${esc(interpolate(c.header, vars))}</th>`).join('')}</tr>`;
      const rows = el.cells.map((r) => `<tr>${el.columns.map((_, i) => `<td>${esc(interpolate(r[i] ?? '', vars))}</td>`).join('')}</tr>`).join('');
      return `<table>${head}${rows}</table>`;
    }
    case 'fields':
      return `<p>${el.fields.map((f) => `${esc(interpolate(f.label, vars))}: ________`).join(' &#160; ')}</p>`;
    case 'box': {
      const l = interpolate(el.label, vars).trim();
      return l ? `<div class="box"><p><strong>${esc(l)}</strong></p></div>` : '';
    }
    case 'image': {
      const src = assetName(el.assetId);
      return src ? `<figure><img src="${src}" alt="${esc(el.caption || 'Illustration')}"/></figure>` : '';
    }
    case 'columns':
      return el.columns.map((c) => c.elements.map((e) => elementHtml(e, vars, assetName)).join('')).join('');
    default:
      return '';
  }
}

function xhtml(title: string, body: string, lang: string, rtl: boolean): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${lang}" lang="${lang}"${rtl ? ' dir="rtl"' : ''}>
<head><meta charset="UTF-8"/><title>${esc(title)}</title><link rel="stylesheet" type="text/css" href="styles.css"/></head>
<body>
${body}
</body>
</html>`;
}

const CSS = `body{font-family:serif;line-height:1.45;margin:0 0.5em}h1{text-align:center;margin:2em 0 1em;page-break-before:always}h2,h3,h4{margin:1.2em 0 0.4em}p{margin:0;text-indent:1.2em}h1+p,h2+p,h3+p,h4+p,hr+p,blockquote p,li p,figure+p{text-indent:0}blockquote{margin:1em 1.5em;font-style:italic}figure{margin:1em 0;text-align:center}img{max-width:100%}figcaption{font-size:0.85em;font-style:italic}hr.section-break{border:none;text-align:center;margin:1.2em 0}hr.section-break:after{content:"* * *"}.page-break{page-break-after:always}table{border-collapse:collapse;width:100%;margin:0.8em 0}td,th{border:1px solid #888;padding:0.25em}.box{border:1px solid #888;padding:0.5em;margin:0.6em 0}aside.notes{font-size:0.9em;margin-top:2em}`;

/** Builds a reflowable EPUB 3 for Kindle (KDP accepts EPUB uploads). Deterministic output. */
export async function buildEpub(input: EpubInput): Promise<Uint8Array> {
  const doc = InteriorDocumentSchema.parse(input.document);
  const lang = languageCode(input.language);
  const rtl = !!input.rtl;
  const zip = new JSZip();
  const date = FIXED_DATE;
  const add = (path: string, data: string | Uint8Array, store = false) => zip.file(path, data, { date, compression: store ? 'STORE' : 'DEFLATE', createFolders: false });
  add('mimetype', 'application/epub+zip', true);
  add('META-INF/container.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
  add('OEBPS/styles.css', CSS);

  const manifest: string[] = [`<item id="css" href="styles.css" media-type="text/css"/>`, `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`, `<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`];
  const spine: string[] = [];
  const navItems: { href: string; title: string }[] = [];

  const assetNames = new Map<string, string>();
  const assetName = (id: string) => {
    const a = input.assets?.[id];
    if (!a) return undefined;
    if (!assetNames.has(id)) {
      const ext = a.mimeType === 'image/png' ? 'png' : 'jpg';
      const name = `images/asset-${assetNames.size + 1}.${ext}`;
      assetNames.set(id, name);
      add(`OEBPS/${name}`, a.bytes);
      manifest.push(`<item id="img${assetNames.size}" href="${name}" media-type="${a.mimeType}"/>`);
    }
    return assetNames.get(id);
  };

  if (input.coverPng) {
    add('OEBPS/images/cover.png', input.coverPng);
    manifest.push(`<item id="cover-image" href="images/cover.png" media-type="image/png" properties="cover-image"/>`);
    add('OEBPS/cover.xhtml', xhtml('Cover', `<section epub:type="cover"><img src="images/cover.png" alt="${esc(input.title)}"/></section>`, lang, rtl));
    manifest.push(`<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="cover" linear="yes"/>`);
  }

  const titleBody = `<section epub:type="titlepage"><h1>${esc(input.title)}</h1>${input.subtitle ? `<p style="text-align:center;text-indent:0"><em>${esc(input.subtitle)}</em></p>` : ''}<p style="text-align:center;text-indent:0">${esc(input.author)}</p></section>`;
  add('OEBPS/title.xhtml', xhtml(input.title, titleBody, lang, rtl));
  manifest.push(`<item id="title" href="title.xhtml" media-type="application/xhtml+xml"/>`);
  spine.push(`<itemref idref="title"/>`);

  const vars = { title: doc.settings.title || input.title, author: doc.settings.author || input.author };
  const emitPages = (pages: PageInstance[], prefix: string, label: string) => {
    for (let i = 0; i < pages.length; i += 20) {
      const chunk = pages.slice(i, i + 20);
      const body = chunk
        .map((inst) => {
          const tpl = inst.templateId ? getTemplate(inst.templateId, doc.templates) : undefined;
          if (inst.templateId === 'toc' || inst.templateId === 'title-page' || inst.blank) return '';
          const fieldVars = { ...vars, ...Object.fromEntries((tpl?.fields ?? []).map((f) => [f.key, f.default])), ...inst.fields };
          const els = inst.elements ?? tpl?.elements ?? [];
          const html = els.map((e) => elementHtml(e, fieldVars, assetName)).join('\n');
          return html ? `<section>${html}</section>` : '';
        })
        .join('\n');
      if (!body.trim()) continue;
      const file = `${prefix}-${String(i / 20 + 1).padStart(3, '0')}.xhtml`;
      add(`OEBPS/${file}`, xhtml(label, body, lang, rtl));
      manifest.push(`<item id="${file.replace('.xhtml', '')}" href="${file}" media-type="application/xhtml+xml"/>`);
      spine.push(`<itemref idref="${file.replace('.xhtml', '')}"/>`);
      if (i === 0) navItems.push({ href: file, title: label });
    }
  };

  emitPages(doc.frontMatter, 'front', 'Front matter');
  if (doc.body.kind === 'flow') {
    doc.body.chapters.forEach((ch: Chapter, ci) => {
      const notes = ch.notes.length
        ? `<aside class="notes" epub:type="endnotes"><h3>Notes</h3><ol>${ch.notes.map((n, i) => `<li id="note-${ci}-${i + 1}" epub:type="endnote"><p>${esc(n)} <a href="#ref-${ci}-${i + 1}">↩</a></p></li>`).join('')}</ol></aside>`
        : '';
      const body = `<section epub:type="chapter"><h1>${esc(ch.title)}</h1>\n${ch.blocks.map((b) => blockHtml(b, ci, assetName)).join('\n')}${notes}</section>`;
      const file = `chapter-${String(ci + 1).padStart(3, '0')}.xhtml`;
      add(`OEBPS/${file}`, xhtml(ch.title, body, lang, rtl));
      manifest.push(`<item id="ch${ci + 1}" href="${file}" media-type="application/xhtml+xml"/>`);
      spine.push(`<itemref idref="ch${ci + 1}"/>`);
      navItems.push({ href: file, title: ch.title });
    });
  } else {
    emitPages(doc.body.pages, 'pages', 'Contents');
  }
  emitPages(doc.backMatter, 'back', 'Back matter');

  add('OEBPS/nav.xhtml', xhtml('Contents', `<nav epub:type="toc" id="toc"><h1>Contents</h1><ol>${navItems.map((n) => `<li><a href="${n.href}">${esc(n.title)}</a></li>`).join('')}</ol></nav>`, lang, rtl));
  const uid = `urn:uuid:${uuidFrom(input.identifier)}`;
  add(
    'OEBPS/toc.ncx',
    `<?xml version="1.0" encoding="UTF-8"?>\n<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="${uid}"/></head><docTitle><text>${esc(input.title)}</text></docTitle><navMap>${navItems
      .map((n, i) => `<navPoint id="np${i + 1}" playOrder="${i + 1}"><navLabel><text>${esc(n.title)}</text></navLabel><content src="${n.href}"/></navPoint>`)
      .join('')}</navMap></ncx>`,
  );
  const modified = (input.modified ?? date).toISOString().replace(/\.\d{3}Z$/, 'Z');
  add(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="${lang}"${rtl ? ' dir="rtl"' : ''}>
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="bookid">${uid}</dc:identifier>
${input.isbn ? `<dc:identifier id="isbn">urn:isbn:${esc(input.isbn.replace(/[-\s]/g, ''))}</dc:identifier>` : ''}
<dc:title>${esc(input.title)}</dc:title>
<dc:creator>${esc(input.author)}</dc:creator>
<dc:language>${lang}</dc:language>
${input.description ? `<dc:description>${esc(input.description.replace(/<[^>]+>/g, ''))}</dc:description>` : ''}
<meta property="dcterms:modified">${modified}</meta>
${input.coverPng ? '<meta name="cover" content="cover-image"/>' : ''}
</metadata>
<manifest>
${manifest.join('\n')}
</manifest>
<spine toc="ncx"${rtl ? ' page-progression-direction="rtl"' : ''}>
${spine.join('\n')}
</spine>
</package>`,
  );
  return zip.generateAsync({ type: 'uint8array', mimeType: 'application/epub+zip', compression: 'DEFLATE' });
}

/** Structural EPUB check (subset of EPUBCheck): container, package, manifest/spine integrity, XHTML well-formedness. */
export async function inspectEpub(bytes: Uint8Array): Promise<EpubInspection> {
  const errors: string[] = [];
  const res: EpubInspection = { ok: false, errors, chapterCount: 0, hasNav: false, hasCover: false, fileSizeBytes: bytes.byteLength };
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch (e) {
    errors.push(`Not a ZIP archive: ${(e as Error).message}`);
    return res;
  }
  const names = Object.keys(zip.files);
  if (names[0] !== 'mimetype') errors.push('"mimetype" must be the first entry.');
  const mt = await zip.file('mimetype')?.async('string');
  if (mt !== 'application/epub+zip') errors.push('mimetype content must be "application/epub+zip".');
  const container = await zip.file('META-INF/container.xml')?.async('string');
  if (!container) {
    errors.push('META-INF/container.xml missing.');
    return res;
  }
  const opfPath = container.match(/full-path="([^"]+)"/)?.[1];
  const opf = opfPath ? await zip.file(opfPath)?.async('string') : undefined;
  if (!opf) {
    errors.push('Package document (OPF) missing.');
    return res;
  }
  if (XMLValidator.validate(opf) !== true) errors.push('OPF is not well-formed XML.');
  const base = opfPath!.includes('/') ? opfPath!.slice(0, opfPath!.lastIndexOf('/') + 1) : '';
  const items = [...opf.matchAll(/<item\s+([^>]+?)\/>/g)].map((m) => ({
    id: m[1].match(/id="([^"]+)"/)?.[1] ?? '',
    href: m[1].match(/href="([^"]+)"/)?.[1] ?? '',
    type: m[1].match(/media-type="([^"]+)"/)?.[1] ?? '',
    props: m[1].match(/properties="([^"]+)"/)?.[1] ?? '',
  }));
  for (const it of items) if (!zip.file(base + it.href)) errors.push(`Manifest item missing from archive: ${it.href}`);
  const spineRefs = [...opf.matchAll(/<itemref\s+idref="([^"]+)"/g)].map((m) => m[1]);
  if (!spineRefs.length) errors.push('Spine is empty.');
  for (const r of spineRefs) if (!items.find((i) => i.id === r)) errors.push(`Spine references unknown item "${r}".`);
  if (!/<dc:title>[^<]+<\/dc:title>/.test(opf)) errors.push('dc:title missing.');
  if (!/<dc:language>[^<]+<\/dc:language>/.test(opf)) errors.push('dc:language missing.');
  if (!/<dc:identifier[^>]*>[^<]+<\/dc:identifier>/.test(opf)) errors.push('dc:identifier missing.');
  if (!/dcterms:modified/.test(opf)) errors.push('dcterms:modified missing.');
  res.hasNav = items.some((i) => i.props.split(' ').includes('nav'));
  if (!res.hasNav) errors.push('Navigation document missing.');
  res.hasCover = items.some((i) => i.props.split(' ').includes('cover-image'));
  for (const it of items.filter((i) => i.type === 'application/xhtml+xml')) {
    const content = await zip.file(base + it.href)?.async('string');
    if (content && XMLValidator.validate(content) !== true) errors.push(`${it.href} is not well-formed XHTML.`);
  }
  res.chapterCount = items.filter((i) => i.type === 'application/xhtml+xml' && !i.props.includes('nav')).length;
  res.ok = errors.length === 0;
  return res;
}
