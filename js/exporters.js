/**
 * exporters.js — Builds real .docx files fully client-side by hand-rolling
 * the minimal OOXML package (no server, no heavy library). JSZip is loaded
 * on demand purely to zip the parts together.
 */
const Exporters = (() => {
  const JSZIP_URL = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
  let jszipLoading = null;

  function loadScriptOnce(url) {
    return new Promise((resolve, reject) => {
      if ([...document.scripts].some((s) => s.src === url)) return resolve();
      const s = document.createElement("script");
      s.src = url;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("No se pudo cargar " + url));
      document.head.appendChild(s);
    });
  }

  async function ensureJSZip() {
    if (window.JSZip) return;
    if (!jszipLoading) jszipLoading = loadScriptOnce(JSZIP_URL);
    await jszipLoading;
  }

  const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="jpeg" ContentType="image/jpeg"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

  const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

  function escapeXml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  async function canvasToJpegBytes(canvas, quality = 0.88) {
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    return new Uint8Array(await blob.arrayBuffer());
  }

  // EMU: 914400 per inch. We fit each page image to a 6.3in-wide column
  // (standard US-letter margins) while preserving aspect ratio.
  function emuSizeFor(w, h) {
    const maxW = 6.3 * 914400;
    const scale = Math.min(1, maxW / (w * (914400 / 96)));
    const emuW = Math.round(w * (914400 / 96) * scale);
    const emuH = Math.round(h * (914400 / 96) * scale);
    return { emuW, emuH };
  }

  /**
   * buildImagesDocx(canvases, filename) -> Blob
   * One page per canvas, each image full-width, page breaks in between.
   */
  async function buildImagesDocx(canvases) {
    await ensureJSZip();
    const zip = new window.JSZip();
    const media = zip.folder("word/media");
    const relsEntries = [];
    const bodyParts = [];

    for (let i = 0; i < canvases.length; i++) {
      const canvas = canvases[i];
      const bytes = await canvasToJpegBytes(canvas);
      const name = `image${i + 1}.jpeg`;
      media.file(name, bytes);
      const rId = `rIdImg${i + 1}`;
      relsEntries.push(`<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${name}"/>`);
      const { emuW, emuH } = emuSizeFor(canvas.width, canvas.height);
      bodyParts.push(`
<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">
<wp:extent cx="${emuW}" cy="${emuH}"/>
<wp:docPr id="${i + 1}" name="Pagina${i + 1}"/>
<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
<pic:nvPicPr><pic:cNvPr id="${i + 1}" name="Pagina${i + 1}.jpeg"/><pic:cNvPicPr/></pic:nvPicPr>
<pic:blipFill><a:blip r:embed="${rId}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${emuW}" cy="${emuH}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>
</pic:pic>
</a:graphicData></a:graphic>
</wp:inline></w:drawing></w:r></w:p>
${i < canvases.length - 1 ? '<w:p><w:r><w:br w:type="page"/></w:r></w:p>' : ""}`);
    }

    const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
<w:body>${bodyParts.join("\n")}
<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720"/></w:sectPr>
</w:body>
</w:document>`;

    const documentRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${relsEntries.join("\n")}
</Relationships>`;

    zip.file("[Content_Types].xml", CONTENT_TYPES);
    zip.file("_rels/.rels", ROOT_RELS);
    zip.file("word/document.xml", documentXml);
    zip.file("word/_rels/document.xml.rels", documentRels);

    return zip.generateAsync({ type: "blob", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
  }

  /**
   * buildTextDocx(text, title) -> Blob — a plain editable Word document
   * containing the OCR-extracted text, one paragraph per line.
   */
  async function buildTextDocx(text, title) {
    await ensureJSZip();
    const zip = new window.JSZip();
    const lines = String(text || "").split(/\r?\n/);
    const paras = lines.map((line) =>
      `<w:p><w:r><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r></w:p>`
    ).join("\n");
    const titlePara = title
      ? `<w:p><w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="32"/></w:rPr><w:t xml:space="preserve">${escapeXml(title)}</w:t></w:r></w:p><w:p/>`
      : "";

    const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${titlePara}${paras}
<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080"/></w:sectPr>
</w:body>
</w:document>`;

    const rootRelsNoOfficeDoc = ROOT_RELS; // same minimal relationship works for text-only doc too

    zip.file("[Content_Types].xml", CONTENT_TYPES);
    zip.file("_rels/.rels", rootRelsNoOfficeDoc);
    zip.file("word/document.xml", documentXml);
    zip.file("word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`);

    return zip.generateAsync({ type: "blob", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
  }

  return { buildImagesDocx, buildTextDocx };
})();
