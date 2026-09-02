/**
 * Where uploaded files live - one place that answers that question.
 *
 * Two modes, chosen with FILE_STORAGE in .env:
 *
 *   disk      (default)  bytes go to public/uploads/, as they always have.
 *                        Fast, simple, and correct on a machine or a VPS
 *                        where the disk is really yours.
 *
 *   database             bytes go into the database, chunked
 *                        (models/FileBlob.js). Slower and heavier, and the
 *                        only thing that works on a host whose filesystem is
 *                        thrown away between deploys - which is every free
 *                        tier worth using.
 *
 * The rest of the app does not branch on this. Upload, the viewer, the AI text
 * extraction and delete all call the four functions below, so adding a third
 * mode later (S3, Cloudflare R2) means writing it here and nowhere else.
 */
import fs from 'fs';
import path from 'path';
import FileBlob from '../models/FileBlob.js';

export const UPLOAD_DIR = path.join(process.cwd(), 'public', 'uploads');

const MODE = (process.env.FILE_STORAGE || 'disk').trim().toLowerCase();

if (!['disk', 'database'].includes(MODE)) {
    console.warn(`[storage] FILE_STORAGE="${MODE}" is not a valid mode. Using "disk".`);
}

/** 'disk' or 'database'. */
export const storageMode = () => (MODE === 'database' ? 'database' : 'disk');

/** True when uploads are kept in the database. */
export const usesDatabase = () => storageMode() === 'database';

const CONTENT_TYPES = {
    '.pdf': 'application/pdf',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.zip': 'application/zip'
};

/** The type to serve a stored name as - allowlisted, never sniffed. */
export function contentTypeFor(name) {
    return CONTENT_TYPES[path.extname(String(name)).toLowerCase()] || 'application/octet-stream';
}

/**
 * Find a file on disk by its id prefix. Uploads are stored as `<id>-<title>`,
 * so the id is the reliable part - the title in the database can have been
 * edited since, and older uploads used other conventions.
 * @returns {string|null} absolute path
 */
export function findOnDisk(fileId) {
    let entries;
    try {
        entries = fs.readdirSync(UPLOAD_DIR);
    } catch {
        return null;
    }
    const match = entries.find((name) => name.startsWith(`${fileId}-`));
    return match ? path.join(UPLOAD_DIR, match) : null;
}

/**
 * Persist an upload.
 *
 * @param {Object} params
 * @param {number} params.fileId
 * @param {string} params.storedName  - `<id>-<safe title>`, the on-disk name
 * @param {Buffer} [params.buffer]    - the bytes (database mode; multer memory storage)
 * @param {string} [params.tempPath]  - where multer put them (disk mode)
 * @returns {Promise<{mode:string, byteSize:number}>}
 */
export async function save({ fileId, storedName, buffer, tempPath }) {
    if (usesDatabase()) {
        const bytes = buffer || await fs.promises.readFile(tempPath);
        await FileBlob.put(fileId, bytes, {
            filename: storedName,
            mimeType: contentTypeFor(storedName)
        });
        // In database mode multer holds the upload in memory, so there is
        // usually nothing to clean up - but if a temp file was used, it must
        // not be left behind.
        if (tempPath) await fs.promises.unlink(tempPath).catch(() => {});
        return { mode: 'database', byteSize: bytes.length };
    }

    await fs.promises.mkdir(UPLOAD_DIR, { recursive: true });
    const target = path.join(UPLOAD_DIR, storedName);
    if (buffer) await fs.promises.writeFile(target, buffer);
    else await fs.promises.rename(tempPath, target);
    const { size } = await fs.promises.stat(target);
    return { mode: 'disk', byteSize: size };
}

/**
 * Read a stored file back.
 *
 * Returns null when it is not there - which is a real state, not an error:
 * a database row can outlive its bytes if the disk was wiped, and the viewer
 * says so plainly rather than showing a broken frame.
 *
 * @returns {Promise<{buffer:Buffer, filename:string, mimeType:string, byteSize:number}|null>}
 */
export async function open(fileId) {
    if (usesDatabase()) {
        const meta = await FileBlob.findMeta(fileId);
        if (!meta) return null;
        const buffer = await FileBlob.read(fileId);
        if (!buffer) return null;
        return { buffer, filename: meta.filename, mimeType: meta.mimeType, byteSize: meta.byteSize };
    }

    const diskPath = findOnDisk(fileId);
    if (!diskPath) return null;
    const buffer = await fs.promises.readFile(diskPath);
    const filename = path.basename(diskPath);
    return { buffer, filename, mimeType: contentTypeFor(filename), byteSize: buffer.length };
}

/** Whether the bytes for this file are actually stored. */
export async function exists(fileId) {
    if (usesDatabase()) return FileBlob.exists(fileId);
    return Boolean(findOnDisk(fileId));
}

/**
 * Delete a file's bytes. Never throws: the database row is already gone by the
 * time this runs, and failing to tidy up the blob must not turn a successful
 * delete into an error on screen.
 * @returns {Promise<boolean>} whether anything was removed
 */
export async function remove(fileId) {
    try {
        if (usesDatabase()) {
            const had = await FileBlob.exists(fileId);
            await FileBlob.remove(fileId);
            return had;
        }
        const diskPath = findOnDisk(fileId);
        if (!diskPath) return false;
        await fs.promises.unlink(diskPath);
        return true;
    } catch (error) {
        console.error(`[storage] Could not remove the stored bytes for file ${fileId}: ${error.message}`);
        return false;
    }
}

export default { storageMode, usesDatabase, save, open, exists, remove, findOnDisk, contentTypeFor, UPLOAD_DIR };
