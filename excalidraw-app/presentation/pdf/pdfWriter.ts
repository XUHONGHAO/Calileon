import { deflate } from "pako";

/**
 * Minimal PDF 1.4 writer for image-only pages (ADR 0036 §5): catalog, page
 * tree, one image XObject and one draw command per page. Pages are added one
 * at a time so the caller can drop each bitmap as soon as it is encoded.
 *
 * Images are either lossless RGB (Flate + PNG Paeth predictor) or JPEG
 * (DCTDecode) bytes straight from the canvas encoder.
 */

export type PdfImage =
  | { kind: "rgb"; width: number; height: number; rgb: Uint8Array }
  | { kind: "jpeg"; width: number; height: number; jpeg: Uint8Array };

export type EncodedPdfImage =
  | {
      kind: "flate";
      width: number;
      height: number;
      /** deflated, Paeth-filtered rows */
      data: Uint8Array;
    }
  | { kind: "jpeg"; width: number; height: number; data: Uint8Array };

const encoder = new TextEncoder();

const toLatin1 = (value: string) => encoder.encode(value);

const formatNumber = (value: number) =>
  Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, "");

/** UTF-16BE text string with BOM, hex-encoded: safe for any title. */
export const encodePdfTextString = (value: string) => {
  let hex = "FEFF";
  for (let i = 0; i < value.length; i++) {
    hex += value.charCodeAt(i).toString(16).padStart(4, "0").toUpperCase();
  }
  return `<${hex}>`;
};

const paeth = (left: number, up: number, upLeft: number) => {
  const p = left + up - upLeft;
  const pa = Math.abs(p - left);
  const pb = Math.abs(p - up);
  const pc = Math.abs(p - upLeft);
  return pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
};

/** PNG filter type 4 (Paeth) on every row; one filter byte per row. */
export const filterRgbRowsPaeth = (
  rgb: Uint8Array,
  width: number,
  height: number,
) => {
  const stride = width * 3;
  const out = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    const prev = row - stride;
    const dest = y * (stride + 1);
    out[dest] = 4;
    for (let x = 0; x < stride; x++) {
      const left = x >= 3 ? rgb[row + x - 3] : 0;
      const up = y > 0 ? rgb[prev + x] : 0;
      const upLeft = y > 0 && x >= 3 ? rgb[prev + x - 3] : 0;
      out[dest + 1 + x] = (rgb[row + x] - paeth(left, up, upLeft)) & 0xff;
    }
  }
  return out;
};

export const encodePdfImage = (image: PdfImage): EncodedPdfImage => {
  if (image.kind === "jpeg") {
    return {
      kind: "jpeg",
      width: image.width,
      height: image.height,
      data: image.jpeg,
    };
  }
  return {
    kind: "flate",
    width: image.width,
    height: image.height,
    data: deflate(filterRgbRowsPaeth(image.rgb, image.width, image.height)),
  };
};

/** RGBA (canvas `ImageData`) to RGB, composited onto white. */
export const rgbaToRgbOnWhite = (rgba: Uint8ClampedArray | Uint8Array) => {
  const pixels = rgba.length / 4;
  const rgb = new Uint8Array(pixels * 3);
  for (let i = 0; i < pixels; i++) {
    const alpha = rgba[i * 4 + 3];
    for (let c = 0; c < 3; c++) {
      const value = rgba[i * 4 + c];
      rgb[i * 3 + c] =
        alpha === 255
          ? value
          : Math.round((value * alpha + 255 * (255 - alpha)) / 255);
    }
  }
  return rgb;
};

const imageDictionary = (image: EncodedPdfImage) => {
  const common = `/Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${image.data.length}`;
  return image.kind === "jpeg"
    ? `<< ${common} /Filter /DCTDecode >>`
    : `<< ${common} /Filter /FlateDecode /DecodeParms << /Predictor 15 /Colors 3 /BitsPerComponent 8 /Columns ${image.width} >> >>`;
};

export class PdfWriter {
  private chunks: Uint8Array[] = [];
  private length = 0;
  private offsets: number[] = [];
  private pageIds: number[] = [];
  // 1 catalog, 2 info, 3 page tree; pages and images follow
  private nextId = 4;
  private finished = false;

  constructor(private readonly title: string) {
    // header + a binary comment so tools treat the file as binary
    this.push(toLatin1("%PDF-1.4\n"));
    this.push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
  }

  get pageCount() {
    return this.pageIds.length;
  }

  private push(bytes: Uint8Array) {
    this.chunks.push(bytes);
    this.length += bytes.length;
  }

  private writeObject(id: number, body: string, stream?: Uint8Array) {
    this.offsets[id] = this.length;
    this.push(toLatin1(`${id} 0 obj\n${body}\n`));
    if (stream) {
      this.push(toLatin1("stream\n"));
      this.push(stream);
      this.push(toLatin1("\nendstream\n"));
    }
    this.push(toLatin1("endobj\n"));
  }

  /** Adds one page showing `image` at `widthPt` x `heightPt` points. */
  addImagePage(image: EncodedPdfImage, widthPt: number, heightPt: number) {
    if (this.finished) {
      throw new Error("PdfWriter: already finished");
    }
    const pageId = this.nextId++;
    const contentId = this.nextId++;
    const imageId = this.nextId++;
    const w = formatNumber(widthPt);
    const h = formatNumber(heightPt);
    this.pageIds.push(pageId);
    this.writeObject(
      pageId,
      `<< /Type /Page /Parent 3 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`,
    );
    const content = toLatin1(`q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`);
    this.writeObject(contentId, `<< /Length ${content.length} >>`, content);
    this.writeObject(imageId, imageDictionary(image), image.data);
  }

  /** Writes catalog, info, page tree, xref and trailer; returns the parts. */
  finish(): Uint8Array[] {
    if (this.finished) {
      throw new Error("PdfWriter: already finished");
    }
    this.finished = true;
    this.writeObject(1, "<< /Type /Catalog /Pages 3 0 R >>");
    this.writeObject(
      2,
      `<< /Title ${encodePdfTextString(this.title)} /Producer (Calileon) >>`,
    );
    this.writeObject(
      3,
      `<< /Type /Pages /Kids [${this.pageIds
        .map((id) => `${id} 0 R`)
        .join(" ")}] /Count ${this.pageIds.length} >>`,
    );
    const xrefOffset = this.length;
    const size = this.nextId;
    let xref = `xref\n0 ${size}\n0000000000 65535 f \n`;
    for (let id = 1; id < size; id++) {
      xref += `${String(this.offsets[id]).padStart(10, "0")} 00000 n \n`;
    }
    xref += `trailer\n<< /Size ${size} /Root 1 0 R /Info 2 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
    this.push(toLatin1(xref));
    const chunks = this.chunks;
    this.chunks = [];
    return chunks;
  }
}

export const concatBytes = (chunks: readonly Uint8Array[]) => {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
};
