// Minimal original PDFs for deterministic extraction tests; no external software needed.
export function makePdf(pages) {
  const objects = ['', '', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const add = value => { objects.push(value); return objects.length - 1; };
  const pageIds = [];
  for (const page of pages) {
    const pageId = add(''); pageIds.push(pageId);
    let content, resources = '/Font << /F1 3 0 R >>';
    if (page.imageOnly) {
      const imageId = add('<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length 3 >>\nstream\n\xff\xff\xff\nendstream');
      content = 'q 400 0 0 600 50 100 cm /Im0 Do Q';
      resources += ` /XObject << /Im0 ${imageId} 0 R >>`;
    } else {
      const literal = text => text.replace(/([\\()])/gu, '\\$1');
      content = `BT /F1 11 Tf 16 TL 50 780 Td\n${page.lines.map((line, i) => `${i ? 'T* ' : ''}(${literal(line)}) Tj`).join('\n')}\nET`;
    }
    const contentId = add(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << ${resources} >> /Contents ${contentId} 0 R >>`;
  }
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] >>`;
  let result = '%PDF-1.4\n'; const offsets = [0];
  for (let i = 1; i < objects.length; i++) { offsets.push(Buffer.byteLength(result, 'latin1')); result += `${i} 0 obj\n${objects[i]}\nendobj\n`; }
  const xref = Buffer.byteLength(result, 'latin1');
  result += `xref\n0 ${objects.length}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(result, 'latin1');
}
export const fixturePages = [
  { lines: ['Teaching paper: Sleep and fatigue', 'Original fictional example, not medical evidence.', 'Methods', 'Participants were 80 adults in an observational cohort.', 'A regression model estimated association, not causation.', 'Code and data availability were not reported in this excerpt.'] },
  { lines: ['Results', 'Sleep duration was associated with fatigue in this teaching example.', 'Limitations: this fictional single-site cohort has no intervention.', 'References', '1. Smith. Example reference for testing. 2025. doi:10.1234/example-only'] },
];
