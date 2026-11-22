// Shrink files on the phone before they are uploaded to Supabase Storage.
//
// The free plan has 1 GB of storage and 5 GB of downloads a month. Phone photos arrived at full camera
// size (measured: 1 MB on average, up to 4.3 MB), so about a thousand payment proofs would have filled
// the plan. A receipt or ID photo stays readable at 1600 px, which as WebP is usually 100-250 KB: about
// 5-8 times more files in the same space, and much faster uploads on mobile data.
// The buckets also refuse anything over the limit server-side (migration 20261122150000).

export const MAX_EDGE_PX = 1600;
export const MB = 1024 * 1024;

export type UploadKind = "document" | "photo";

/** Server limits, kept in step with storage.buckets.file_size_limit. */
export const LIMIT_BYTES: Record<UploadKind, number> = { document: 2 * MB, photo: 3 * MB };

const IMAGE_TYPES = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp", "image/heic", "image/heif"]);

export class UploadRejected extends Error {}

export type PreparedUpload = {
  /** What to upload. */
  body: Blob;
  /** File extension without the dot, matching the content type. */
  ext: string;
  contentType: string;
  /** For the toast: bytes before and after. */
  originalBytes: number;
  finalBytes: number;
};

/** Largest size that fits inside maxEdge on the long side, never upscaled. */
export function fitWithin(width: number, height: number, maxEdge = MAX_EDGE_PX): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: 0, height: 0 };
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export function extForType(type: string): string {
  switch (type) {
    case "image/webp": return "webp";
    case "image/png": return "png";
    case "application/pdf": return "pdf";
    default: return "jpg";
  }
}

/** What the file is, from its type or, when the phone gives none, its name. */
export function classify(file: { type: string; name: string }): "image" | "pdf" | "other" {
  const type = (file.type || "").toLowerCase();
  const name = (file.name || "").toLowerCase();
  if (type === "application/pdf" || (!type && name.endsWith(".pdf"))) return "pdf";
  if (IMAGE_TYPES.has(type) || (!type && /\.(jpe?g|png|webp|heic|heif)$/.test(name))) return "image";
  return "other";
}

export function describeSize(bytes: number): string {
  return bytes >= MB ? `${(bytes / MB).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

type Decoded = { source: CanvasImageSource; width: number; height: number; close: () => void };

async function decode(file: Blob): Promise<Decoded> {
  if (typeof createImageBitmap === "function") {
    try {
      // "from-image" applies the EXIF rotation, so portrait phone photos stay upright.
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    } catch {
      // Fall through to <img>, which some WebViews decode when createImageBitmap cannot.
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("decode failed"));
      el.src = url;
    });
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

async function encode(decoded: Decoded, maxEdge: number, quality: number): Promise<Blob | null> {
  const { width, height } = fitWithin(decoded.width, decoded.height, maxEdge);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  // White under transparent PNGs, since JPEG has no transparency.
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(decoded.source, 0, 0, width, height);
  // Old Android WebViews return PNG when asked for WebP: then use JPEG.
  const webp = await toBlob(canvas, "image/webp", quality);
  if (webp && webp.type === "image/webp") return webp;
  return toBlob(canvas, "image/jpeg", quality);
}

/**
 * Get a picked file ready to upload: photos are resized and re-encoded, PDFs pass through, everything
 * else is refused. Throws UploadRejected with a message that can be shown to the user as it is.
 */
export async function prepareUpload(file: File, kind: UploadKind = "document"): Promise<PreparedUpload> {
  const limit = LIMIT_BYTES[kind];
  const what = classify(file);

  if (what === "pdf") {
    if (kind === "photo") throw new UploadRejected("Please choose a photo (JPG, PNG or WebP).");
    if (file.size > limit) {
      throw new UploadRejected(`This PDF is ${describeSize(file.size)}. The limit is ${describeSize(limit)}: please upload a smaller file or a photo of it.`);
    }
    return { body: file, ext: "pdf", contentType: "application/pdf", originalBytes: file.size, finalBytes: file.size };
  }

  if (what !== "image") {
    throw new UploadRejected(kind === "photo" ? "Please choose a photo (JPG, PNG or WebP)." : "Please choose a photo or a PDF file.");
  }

  let decoded: Decoded;
  try {
    decoded = await decode(file);
  } catch {
    // Could not read it here (for example HEIC in a browser that cannot open it): send it as it is if
    // the server will take it.
    const type = (file.type || "").toLowerCase();
    if (["image/jpeg", "image/png", "image/webp"].includes(type) && file.size <= limit) {
      return { body: file, ext: extForType(type), contentType: type, originalBytes: file.size, finalBytes: file.size };
    }
    throw new UploadRejected("This photo could not be opened. Please choose a JPG or PNG.");
  }

  try {
    // Each step trades a little quality for size; nearly every photo stops at the first.
    for (const [edge, quality] of [[MAX_EDGE_PX, 0.78], [MAX_EDGE_PX, 0.6], [1200, 0.6]] as const) {
      const out = await encode(decoded, edge, quality);
      if (out && out.size <= limit) {
        // A photo that was already small can come out bigger: keep the original then.
        const keepOriginal = file.size <= out.size && file.size <= limit && ["image/jpeg", "image/webp"].includes(file.type);
        const body = keepOriginal ? file : out;
        const type = keepOriginal ? file.type : out.type;
        return { body, ext: extForType(type), contentType: type, originalBytes: file.size, finalBytes: body.size };
      }
    }
  } finally {
    decoded.close();
  }
  throw new UploadRejected(`This photo is too large even after shrinking. The limit is ${describeSize(limit)}.`);
}
