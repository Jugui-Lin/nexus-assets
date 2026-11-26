export function downloadWorkspaceFile(doc, filename, text, type = 'application/json;charset=utf-8') {
  const file = new Blob([text],{type});
  const url = URL.createObjectURL(file);
  const link = doc.createElement('a');
  link.href = url;
  link.download = filename;
  doc.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url),30000);
}
