// Inline-able binaries: what the Claude API accepts as image blocks, plus PDF as an embedded resource.
// base64 inflates by 4/3 and the API rejects payloads over 5 MB — so cap the raw bytes at 3.5 MB.
export const INLINE_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
export const MAX_INLINE_BYTES = 3.5 * 1024 * 1024;
// Firebase serves plenty of files as application/octet-stream; the magic bytes are the truth.
export function sniffMime(buf, declared) {
    const magic = [
        ["ffd8ff", "image/jpeg"],
        ["89504e47", "image/png"],
        ["47494638", "image/gif"],
        ["25504446", "application/pdf"],
    ];
    const head = buf.subarray(0, 4).toString("hex");
    for (const [sig, mime] of magic)
        if (head.startsWith(sig))
            return mime;
    if (head === "52494646" && buf.subarray(8, 12).toString("ascii") === "WEBP")
        return "image/webp";
    return declared || "application/octet-stream";
}
