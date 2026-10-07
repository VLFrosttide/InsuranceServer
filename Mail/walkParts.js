function partHeader(part, name) {
  return (
    (part.headers || []).find((h) => h.name.toLowerCase() === name)?.value ||
    ""
  );
}

// Normalize a Content-ID header / cid: reference for comparison:
// "<image001.png@01DA>" -> "image001.png@01da".
function normalizeCid(value) {
  let v = String(value || "").trim();
  if (v.toLowerCase().startsWith("cid:")) v = v.slice(4);
  v = v.replace(/^<|>$/g, "");
  try {
    v = decodeURIComponent(v);
  } catch {
    // Leave malformed percent-encodings as they are.
  }
  return v.trim().toLowerCase();
}

function walkParts(part, messageId, bag) {
  if (!part) return;

  const disposition = partHeader(part, "content-disposition");
  const contentId = normalizeCid(partHeader(part, "content-id"));
  const isAttachment =
    Boolean(part.filename) ||
    Boolean(part.body && part.body.attachmentId) ||
    /attachment/i.test(disposition);

  if (part.mimeType === "text/plain" && part.body?.data && !isAttachment) {
    bag.textParts.push(decodeBase64Url(part.body.data).toString("utf8"));
  } else if (
    part.mimeType === "text/html" &&
    part.body?.data &&
    !isAttachment
  ) {
    bag.htmlParts.push(decodeBase64Url(part.body.data).toString("utf8"));
  }

  if (isAttachment && (part.body?.attachmentId || part.body?.data)) {
    bag.attachmentParts.push({
      messageId,
      filename: part.filename || "unnamed",
      mimeType: part.mimeType || "application/octet-stream",
      attachmentId: part.body.attachmentId || null,
      inlineData: part.body.data || null,
      size: part.body.size || 0,
      contentId,
    });
  }

  if (Array.isArray(part.parts)) {
    for (const child of part.parts) walkParts(child, messageId, bag);
  }
}
function decodeBase64Url(data) {
  const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64");
}

// Embedded images at least this large are treated as a real (photographed)
// attachment when the email carries no regular attachment at all - e.g. iOS
// Mail places photos inside the body as cid: images. Signature logos and icons
// are far smaller than this.
const BODY_IMAGE_FALLBACK_MIN_SIZE = 100 * 1024;

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|bmp|webp|svg|ico|tiff?|heic|heif|emz|wmz)$/i;

// Only images can be body graphics (signature logos, icons, letterheads).
// Gmail sometimes reports images as application/octet-stream, so the file
// extension is checked as well.
function isImagePart(att) {
  return (
    String(att.mimeType || "").toLowerCase().startsWith("image/") ||
    IMAGE_EXT_RE.test(String(att.filename || ""))
  );
}

/**
 * Pick the parts that should be shown to workers as attachments.
 *
 * Gmail reports body graphics (signature logos, social icons, letterheads -
 * anything rendered inside the HTML via <img src="cid:...">) as parts with a
 * filename/attachmentId, exactly like real attachments. Those graphics are
 * part of the email body, not the document the broker sent, so they are
 * removed here. A part counts as a body graphic when it is an image AND its
 * Content-ID is referenced from the HTML body. (Content-Disposition is
 * deliberately not trusted: Outlook adds Content-IDs to real attachments and
 * Apple Mail marks real attachments "inline".) Non-image parts such as PDFs
 * are always kept: Apple/iOS Mail and Outlook reference inline-displayed PDFs
 * from the HTML via cid: too, yet they are the document the broker sent.
 *
 * @param {{ htmlParts: string[], attachmentParts: Object[] }} bag
 * @returns {Object[]} The attachment parts to expose.
 */
function selectAttachments(bag) {
  const html = (bag.htmlParts || []).join("\n");
  const referenced = new Set();
  const cidRe = /cid:([^"'\s>)]+)/gi;
  let m;
  while ((m = cidRe.exec(html))) referenced.add(normalizeCid(m[1]));

  const attachments = [];
  const bodyGraphics = [];
  for (const att of bag.attachmentParts || []) {
    if (att.contentId && referenced.has(att.contentId) && isImagePart(att))
      bodyGraphics.push(att);
    else attachments.push(att);
  }

  if (attachments.length) return attachments;
  return bodyGraphics.filter(
    (att) => (att.size || 0) >= BODY_IMAGE_FALLBACK_MIN_SIZE
  );
}

walkParts.selectAttachments = selectAttachments;
walkParts.BODY_IMAGE_FALLBACK_MIN_SIZE = BODY_IMAGE_FALLBACK_MIN_SIZE;

module.exports = walkParts;
