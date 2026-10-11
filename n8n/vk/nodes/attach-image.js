const parsed = $('Parse and Validate Package').first().json;
const pkg = parsed.content_package;
const binary = $input.item.binary && ($input.item.binary.data || $input.item.binary.file);
let bytes = null;
if (binary && binary.data) bytes = Buffer.from(binary.data, 'base64');
if ((!bytes || !bytes.length) && this.helpers && this.helpers.getBinaryDataBuffer) {
  const key = $input.item.binary && $input.item.binary.data ? 'data' : 'file';
  bytes = await this.helpers.getBinaryDataBuffer(0, key);
}
const filename = (binary && (binary.fileName || binary.file_name)) || 'photo.jpg';
const attached = vkPublisher.attachDraftImage(pkg, bytes, filename);
if (!attached.ok) {
  return [{ json: {
    ...parsed,
    content_package: pkg,
    package_valid: false,
    user_message: 'Изображение из сообщения не сохранено в черновик. ' + attached.errors.join(' ')
  }}];
}
return [{ json: {
  ...parsed,
  content_package: pkg,
  package_valid: true,
  user_message: null
}}];
