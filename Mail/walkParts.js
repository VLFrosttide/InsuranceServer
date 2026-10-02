function walkParts(part, messageId, bag) {
  if (!part) return;

  const disposition =
    (part.headers || []).find(
      (h) => h.name.toLowerCase() === "content-disposition"
    )?.value || "";
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

module.exports = walkParts;
