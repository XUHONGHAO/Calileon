import { inflate } from "pako";

import {
  PdfWriter,
  concatBytes,
  encodePdfImage,
  encodePdfTextString,
  filterRgbRowsPaeth,
  rgbaToRgbOnWhite,
} from "./pdfWriter";

// one char per byte, so string offsets equal byte offsets
const latin1 = (bytes: Uint8Array) => {
  let out = "";
  for (const byte of bytes) {
    out += String.fromCharCode(byte);
  }
  return out;
};

const paeth = (a: number, b: number, c: number) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/** PNG decoder side of filter type 4, independent of the encoder. */
const unfilterPaeth = (data: Uint8Array, width: number, height: number) => {
  const stride = width * 3;
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    expect(data[y * (stride + 1)]).toBe(4);
    for (let x = 0; x < stride; x++) {
      const left = x >= 3 ? out[y * stride + x - 3] : 0;
      const up = y > 0 ? out[(y - 1) * stride + x] : 0;
      const upLeft = y > 0 && x >= 3 ? out[(y - 1) * stride + x - 3] : 0;
      out[y * stride + x] =
        (data[y * (stride + 1) + 1 + x] + paeth(left, up, upLeft)) & 0xff;
    }
  }
  return out;
};

const pseudoRandomRgb = (width: number, height: number) => {
  const rgb = new Uint8Array(width * height * 3);
  let state = 7;
  for (let i = 0; i < rgb.length; i++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    rgb[i] = state & 0xff;
  }
  return rgb;
};

describe("PDF image encoding (ADR 0036 §5)", () => {
  it("Paeth filtering round-trips through a PNG-style decoder", () => {
    const rgb = pseudoRandomRgb(7, 5);
    const filtered = filterRgbRowsPaeth(rgb, 7, 5);
    expect(filtered).toHaveLength(5 * (7 * 3 + 1));
    expect(unfilterPaeth(filtered, 7, 5)).toEqual(rgb);
  });

  it("deflates the filtered rows", () => {
    const rgb = pseudoRandomRgb(4, 3);
    const encoded = encodePdfImage({ kind: "rgb", width: 4, height: 3, rgb });
    expect(encoded.kind).toBe("flate");
    expect(unfilterPaeth(inflate(encoded.data), 4, 3)).toEqual(rgb);
  });

  it("passes JPEG bytes through", () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    expect(
      encodePdfImage({ kind: "jpeg", width: 1, height: 1, jpeg }),
    ).toMatchObject({ kind: "jpeg", data: jpeg });
  });

  it("composites RGBA onto white", () => {
    const rgba = new Uint8ClampedArray([
      10, 20, 30, 255, 0, 0, 0, 0, 0, 0, 0, 128,
    ]);
    expect(Array.from(rgbaToRgbOnWhite(rgba))).toEqual([
      10, 20, 30, 255, 255, 255, 127, 127, 127,
    ]);
  });

  it("encodes any title as UTF-16BE hex", () => {
    expect(encodePdfTextString("A")).toBe("<FEFF0041>");
    expect(encodePdfTextString("演示 (1)")).toBe(
      "<FEFF6F14793A0020002800310029>",
    );
  });
});

describe("PdfWriter", () => {
  const build = () => {
    const writer = new PdfWriter("Deck 演示");
    writer.addImagePage(
      encodePdfImage({
        kind: "rgb",
        width: 2,
        height: 1,
        rgb: new Uint8Array([255, 0, 0, 0, 0, 255]),
      }),
      960,
      540,
    );
    writer.addImagePage(
      encodePdfImage({
        kind: "jpeg",
        width: 1,
        height: 1,
        jpeg: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      }),
      720.5,
      960,
    );
    expect(writer.pageCount).toBe(2);
    return { writer, pdf: latin1(concatBytes(writer.finish())) };
  };

  it("writes a structurally valid PDF 1.4 file", () => {
    const { pdf } = build();
    expect(pdf.startsWith("%PDF-1.4\n")).toBe(true);
    expect(pdf.endsWith("%%EOF\n")).toBe(true);
    expect(pdf).toContain("/Type /Pages /Kids [4 0 R 7 0 R] /Count 2");
    expect(pdf).toContain("/MediaBox [0 0 960 540]");
    expect(pdf).toContain("/MediaBox [0 0 720.5 960]");
    expect(pdf).toContain("/Filter /FlateDecode /DecodeParms << /Predictor 15");
    expect(pdf).toContain("/Filter /DCTDecode");
    expect(pdf).toContain(`/Title ${encodePdfTextString("Deck 演示")}`);
  });

  it("points every xref entry and startxref at the right byte", () => {
    const { pdf } = build();
    const startxref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(pdf)![1]);
    expect(pdf.slice(startxref, startxref + 5)).toBe("xref\n");
    const [, size] = /xref\n0 (\d+)\n/.exec(pdf.slice(startxref))!;
    expect(Number(size)).toBe(10);
    const entries = pdf
      .slice(startxref)
      .split("\n")
      .slice(3, 3 + Number(size) - 1);
    entries.forEach((entry, index) => {
      expect(entry).toMatch(/^\d{10} 00000 n $/);
      const offset = Number(entry.slice(0, 10));
      expect(pdf.slice(offset).startsWith(`${index + 1} 0 obj\n`)).toBe(true);
    });
    expect(pdf).toContain("trailer\n<< /Size 10 /Root 1 0 R /Info 2 0 R >>");
  });

  it("declares each stream's exact length", () => {
    const { pdf } = build();
    const streams = [
      ...pdf.matchAll(/\/Length (\d+)[^\n]*\n(?:[^\n]*\n)?stream\n/g),
    ];
    expect(streams.length).toBe(4);
    for (const match of streams) {
      const start = match.index! + match[0].length;
      const length = Number(match[1]);
      expect(pdf.slice(start + length, start + length + 11)).toBe(
        "\nendstream\n",
      );
    }
  });

  it("refuses to change after finish", () => {
    const { writer } = build();
    expect(() => writer.finish()).toThrow();
    expect(() =>
      writer.addImagePage(
        encodePdfImage({
          kind: "jpeg",
          width: 1,
          height: 1,
          jpeg: new Uint8Array([0]),
        }),
        1,
        1,
      ),
    ).toThrow();
  });
});
