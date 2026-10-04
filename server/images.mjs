import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGES = 4;
const types = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
function imageType(data) {
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return 'jpg';
  if (/^GIF8[79]a$/.test(data.subarray(0, 6).toString())) return 'gif';
  if (data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP') return 'webp';
  throw new Error('Choose a PNG, JPEG, GIF or WebP image.');
}
export function createImageStore(root) {
  const dir = path.join(root, '.tandem', 'uploads');
  function read(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{32}\.(png|jpg|gif|webp)$/.test(id)) throw new Error('Invalid image attachment.');
    const file = path.join(dir, id);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_IMAGE_BYTES) throw new Error('Invalid image attachment.');
    const data = fs.readFileSync(file);
    const ext = imageType(data);
    if (!id.endsWith(`.${ext}`)) throw new Error('Invalid image attachment.');
    return { id, path: file, mime: types[ext], data, url: `/api/images/${id}` };
  }
  return {
    save(data) {
      if (!data.length || data.length > MAX_IMAGE_BYTES) throw new Error('Images must be at most 10 MB each.');
      const ext = imageType(data);
      fs.mkdirSync(dir, { recursive: true });
      const id = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
      fs.writeFileSync(path.join(dir, id), data, { flag: 'wx' });
      return { id, mime: types[ext], url: `/api/images/${id}` };
    },
    read,
    resolve(attachments = []) {
      if (!Array.isArray(attachments) || attachments.length > MAX_IMAGES) throw new Error('Attach up to four images per message.');
      return attachments.map((a) => ({ ...read(a?.id), name: typeof a.name === 'string' ? a.name.slice(0, 200) : 'Image' }));
    },
  };
}
export const imageMetadata = (images) => images.map(({ id, name, mime, url }) => ({ id, name, mime, url }));
export function claudeContent(text, images) {
  return images.length ? [{ type: 'text', text }, ...images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mime, data: i.data.toString('base64') } }))] : text;
}
export function apiContent(text, images) {
  return images.length ? [{ type: 'text', text }, ...images.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.mime};base64,${i.data.toString('base64')}` } }))] : text;
}
