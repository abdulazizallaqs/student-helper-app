/**
 * Uploaded file bytes, kept in the database.
 *
 * WHY THIS EXISTS: every free host runs your app in a container with a
 * throwaway filesystem. Render's free tier, Vercel, most free platforms -
 * they all give you a disk that is wiped on the next deploy, restart or
 * crash. Writing a student's PDF to public/uploads/ there means the file is
 * gone by the next morning, and the app shows "listed in the database, but its
 * upload is not on the server" for a file nobody deleted.
 *
 * Putting the bytes in the database fixes that, because the database is the
 * one thing on a free stack that IS durable.
 *
 * CHUNKED, and not for elegance. TiDB - the free MySQL most people reach for -
 * caps a single row at 6 MiB and will not let you raise it on the serverless
 * tier. A 10 MB upload in one LONGBLOB row is simply rejected. Splitting the
 * file across rows of one mebibyte keeps every row an order of magnitude below
 * that ceiling, on TiDB and on MySQL alike, and means the size limit is the
 * app's to choose rather than the database's to impose.
 */
import db from './db.js';

// 1 MiB. Small enough to sit far below TiDB's 6 MiB row cap even with the
// packet overhead, large enough that a 10 MB file is ten rows, not ten
// thousand.
export const CHUNK_BYTES = 1024 * 1024;

const CREATE_BLOBS = `
  CREATE TABLE IF NOT EXISTS FileBlobs (
    fileId INT NOT NULL PRIMARY KEY,
    filename VARCHAR(255) NOT NULL,
    mimeType VARCHAR(120) NOT NULL,
    byteSize INT NOT NULL,
    chunkCount INT NOT NULL,
    createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_fileblob_file FOREIGN KEY (fileId) REFERENCES Files(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`;

const CREATE_CHUNKS = `
  CREATE TABLE IF NOT EXISTS FileBlobChunks (
    fileId INT NOT NULL,
    seq INT NOT NULL,
    bytes LONGBLOB NOT NULL,
    PRIMARY KEY (fileId, seq),
    CONSTRAINT fk_fileblobchunk_file FOREIGN KEY (fileId) REFERENCES Files(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`;

let readyPromise = null;

/**
 * Create the two tables if they are not there. Memoised, so a hundred
 * concurrent uploads do not each issue a CREATE TABLE.
 * @returns {Promise<boolean>}
 */
export function ensureBlobTables() {
    if (!readyPromise) {
        readyPromise = (async () => {
            await db.query(CREATE_BLOBS);
            await db.query(CREATE_CHUNKS);
            return true;
        })().catch((error) => {
            // Unlike the embedding index, this one is NOT optional - if the
            // tables cannot be made, uploads cannot be stored, and the caller
            // has to hear about it rather than silently losing a file.
            readyPromise = null;
            throw new Error(`Could not create the file storage tables: ${error.message}`);
        });
    }
    return readyPromise;
}

const FileBlob = {
    ensureTables: ensureBlobTables,

    /**
     * Store (or replace) the bytes for one file.
     *
     * Written inside a transaction: a half-written file - some chunks present,
     * some missing - would read back as a corrupt PDF, which is a far worse
     * outcome than a failed upload the user can retry.
     *
     * @param {number} fileId
     * @param {Buffer} buffer
     * @param {{filename:string, mimeType:string}} meta
     */
    async put(fileId, buffer, meta) {
        await ensureBlobTables();
        const connection = await db.getConnection();
        try {
            await connection.beginTransaction();
            await connection.query('DELETE FROM FileBlobChunks WHERE fileId = ?', [fileId]);
            await connection.query('DELETE FROM FileBlobs WHERE fileId = ?', [fileId]);

            const chunkCount = Math.max(1, Math.ceil(buffer.length / CHUNK_BYTES));
            await connection.query(
                'INSERT INTO FileBlobs (fileId, filename, mimeType, byteSize, chunkCount) VALUES (?, ?, ?, ?, ?)',
                [fileId, String(meta.filename || '').slice(0, 255), String(meta.mimeType || 'application/octet-stream').slice(0, 120), buffer.length, chunkCount]
            );

            for (let seq = 0; seq < chunkCount; seq += 1) {
                const slice = buffer.subarray(seq * CHUNK_BYTES, (seq + 1) * CHUNK_BYTES);
                await connection.query(
                    'INSERT INTO FileBlobChunks (fileId, seq, bytes) VALUES (?, ?, ?)',
                    [fileId, seq, slice]
                );
            }

            await connection.commit();
            return { fileId, byteSize: buffer.length, chunkCount };
        } catch (error) {
            await connection.rollback().catch(() => {});
            throw error;
        } finally {
            connection.release();
        }
    },

    /**
     * Filename, type and size, without pulling the bytes across.
     * @returns {Promise<{filename:string, mimeType:string, byteSize:number, chunkCount:number}|null>}
     */
    async findMeta(fileId) {
        await ensureBlobTables();
        const [rows] = await db.query(
            'SELECT filename, mimeType, byteSize, chunkCount FROM FileBlobs WHERE fileId = ?',
            [fileId]
        );
        return rows[0] || null;
    },

    /**
     * The whole file, reassembled in chunk order.
     * @returns {Promise<Buffer|null>}
     */
    async read(fileId) {
        const meta = await this.findMeta(fileId);
        if (!meta) return null;

        const [rows] = await db.query(
            'SELECT bytes FROM FileBlobChunks WHERE fileId = ? ORDER BY seq ASC',
            [fileId]
        );
        if (rows.length !== meta.chunkCount) {
            throw new Error(
                `File ${fileId} is stored in ${meta.chunkCount} pieces but only ${rows.length} were found - the upload is incomplete.`
            );
        }
        return Buffer.concat(rows.map((row) => row.bytes));
    },

    /** @returns {Promise<boolean>} */
    async exists(fileId) {
        return Boolean(await this.findMeta(fileId));
    },

    /**
     * Remove a file's bytes. The foreign keys already cascade when the Files
     * row goes, so this is only for replacing a file in place.
     */
    async remove(fileId) {
        await ensureBlobTables();
        await db.query('DELETE FROM FileBlobChunks WHERE fileId = ?', [fileId]);
        await db.query('DELETE FROM FileBlobs WHERE fileId = ?', [fileId]);
    },

    /** {count, bytes} - for diagnostics and the storage report. */
    async stats() {
        await ensureBlobTables();
        const [[row]] = await db.query('SELECT COUNT(*) AS count, COALESCE(SUM(byteSize), 0) AS bytes FROM FileBlobs');
        return { count: Number(row.count), bytes: Number(row.bytes) };
    }
};

export default FileBlob;
