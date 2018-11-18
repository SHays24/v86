"use strict";

const INDEXEDDB_STORAGE_VERSION = 1;
const INDEXEDDB_STORAGE_NAME = "v86-filesystem-storage";
const INDEXEDDB_STORAGE_STORE = "store";
const INDEXEDDB_STORAGE_KEY_PATH = "sha256sum";
const INDEXEDDB_STORAGE_DATA_PATH = "data";
const INDEXEDDB_STORAGE_EXTRABLOCKCOUNT_PATH = "extra-block-count";
const INDEXEDDB_STORAGE_TOTALSIZE_PATH = "total-size";
const INDEXEDDB_STORAGE_GET_BLOCK_KEY = (sha256sum, block_number) => `${sha256sum}-${block_number}`;
const INDEXEDDB_STORAGE_CHUNKING_THRESHOLD = 4096;
const INDEXEDDB_STORAGE_BLOCKSIZE = 4096;

/** @interface */
function FileStorageInterface() {}

/**
 * @param {string} sha256sum
 * @param {number} offset
 * @param {number} count
 * @return {!Promise<Uint8Array>} null if file does not exist.
 */
FileStorageInterface.prototype.read = function(sha256sum, offset, count) {};

/**
 * @param {string} sha256sum
 * @param {number} offset
 * @param {!Uint8Array} buffer
 * @return {!Promise<number>} Promise to the new file size as file may have grown.
 */
FileStorageInterface.prototype.write = function(sha256sum, offset, buffer) {};

/**
 * @param {string} sha256sum
 * @param {number} length
 */
FileStorageInterface.prototype.change_size = function(sha256sum, length) {};

/**
 * @constructor
 * @implements {FileStorageInterface}
 */
function MemoryFileStorage()
{
    /**
     * From sha256sum to file data.
     * @type {Map<string,Uint8Array>}
     */
    this.filedata = new Map();
}

/**
 * @param {string} sha256sum
 * @param {number} offset
 * @param {number} count
 * @return {!Uint8Array} null if file does not exist.
 */
MemoryFileStorage.prototype.read = async function(sha256sum, offset, count) // jshint ignore:line
{
    dbg_assert(sha256sum, "MemoryFileStorage get: sha256sum should be a non-empty string");
    const data = this.filedata.get(sha256sum);

    if(!data)
    {
        return null;
    }

    return data.subarray(offset, offset + count);
}; // jshint ignore:line

/**
 * @param {string} sha256sum
 * @param {number} offset
 * @param {!Uint8Array} data
 * @return {number} New file size as file may have grown after writing.
 */
MemoryFileStorage.prototype.write = async function(sha256sum, offset, buffer) // jshint ignore:line
{
    dbg_assert(sha256sum, "MemoryFileStorage set: sha256sum should be a non-empty string");

    const needed_size = offset + buffer.length;
    let data = this.filedata.get(sha256sum);

    if(!data)
    {
        data = new Uint8Array(needed_size);
    }

    if(data.length < needed_size)
    {
        const old_data = data;
        data = new Uint8Array(needed_size);
        data.set(old_data);
    }

    data.set(buffer, offset);
    this.filedata.set(sha256sum, data);

    return data.length;
}; // jshint ignore:line

/**
 * @constructor
 * @implements {FileStorageInterface}
 */
function IndexedDBFileStorage()
{
    dbg_assert(typeof window !== "undefined" && window.indexedDB,
        "IndexedDBFileStorage - indexedDB not available.");
    this.db = null;
    this.initializing = false;
}

IndexedDBFileStorage.try_create = async function() // jshint ignore:line
{
    if(typeof window === "undefined" || !window.indexedDB)
    {
        throw new Error("IndexedDB is not available");
    }
    const file_storage = new IndexedDBFileStorage();
    await file_storage.init(); // jshint ignore:line
    return file_storage;
}; // jshint ignore:line

IndexedDBFileStorage.prototype.init = function()
{
    dbg_assert(!this.db, "IndexedDBFileStorage init: Database already intiialized");
    dbg_assert(!this.initializing, "IndexedDBFileStorage init: Database already intiializing");
    this.initializing = true;

    return new Promise((resolve, reject) =>
    {
        const open_request = indexedDB.open(INDEXEDDB_STORAGE_NAME, INDEXEDDB_STORAGE_VERSION);

        open_request.onblocked = event =>
        {
            dbg_log("IndexedDB blocked by an older database version being opened.", LOG_9P);
        };

        open_request.onerror = event =>
        {
            dbg_log("Error opening IndexedDB! Are you in private browsing mode? Error:", LOG_9P);
            dbg_log(open_request.error, LOG_9P);
            this.initializing = false;
            reject();
        };

        open_request.onupgradeneeded = event =>
        {
            const db = open_request.result;
            db.createObjectStore(INDEXEDDB_STORAGE_STORE, { keyPath: INDEXEDDB_STORAGE_KEY_PATH });
        };

        open_request.onsuccess = event =>
        {
            this.initializing = false;
            this.db = open_request.result;
            this.db.onabort = event =>
            {
                dbg_assert(false, "IndexedDBFileStorage: transaction aborted unexpectedly");
            };
            this.db.onclose = event =>
            {
                dbg_assert(false, "IndexedDBFileStorage: connection closed unexpectedly");
            };
            this.db.onerror = error =>
            {
                dbg_assert(false,  "IndexedDBFileStorage: unexpected error: " + error);
            };
            this.db.onversionchange = event =>
            {
                // TODO: double check this message
                dbg_log("Warning: another v86 instance is trying to open IndexedDB database but " +
                    "is blocked by this current v86 instance.", LOG_9P);
            };
            resolve();
        };
    });
};

/**
 * @param {IDBTransaction} transaction
 * @param {string} key
 * @return {!Promise<Object>}
 */
IndexedDBFileStorage.prototype.db_get = function(transaction, key)
{
    return new Promise((resolve, reject) =>
    {
        const store = transaction.objectStore(INDEXEDDB_STORAGE_STORE);
        const request = store.get(key);
        request.onsuccess = event => resolve(request.result);
    });
};

/**
 * @param {IDBTransaction} transaction
 * @param {Object} value
 * @return {!Promise}
 */
IndexedDBFileStorage.prototype.db_set = function(transaction, value)
{
    return new Promise((resolve, reject) =>
    {
        const store = transaction.objectStore(INDEXEDDB_STORAGE_STORE);
        const request = store.put(value);
        request.onsuccess = event => resolve();
    });
};

/**
 * @param {string} sha256sum
 * @param {number} offset
 * @param {number} count
 * @return {!Uint8Array} null if file does not exist.
 */
IndexedDBFileStorage.prototype.read = async function(sha256sum, offset, count) // jshint ignore:line
{
    dbg_assert(this.db, "IndexedDBFileStorage get: Database is not initialized");
    dbg_assert(sha256sum, "IndexedDBFileStorage get: sha256sum should be a non-empty string");

    const transaction = this.db.transaction(INDEXEDDB_STORAGE_STORE, "readonly");
    const entry = await this.db_get(transaction, sha256sum); // jshint ignore:line

    if(!entry)
    {
        return null;
    }

    const base_data = entry[INDEXEDDB_STORAGE_DATA_PATH];
    const extra_block_count = entry[INDEXEDDB_STORAGE_EXTRABLOCKCOUNT_PATH];
    const total_size = entry[INDEXEDDB_STORAGE_TOTALSIZE_PATH];

    dbg_assert(base_data instanceof Uint8Array,
        `IndexedDBFileStorage get: Invalid base entry without the data Uint8Array field: ${base_data}`);
    dbg_assert(Number.isInteger(extra_block_count),
        `IndexedDBFileStorage get: Invalid base entry with non-integer block_count: ${extra_block_count}`);
    dbg_assert(Number.isInteger(total_size) && total_size >= base_data.length,
        `IndexedDBFileStorage get: Invalid base entry with invalid total_size: ${total_size}`);

    const read_data = new Uint8Array(count);
    let read_count = 0;

    if(offset < base_data.length)
    {
        const chunk = base_data.subarray(offset, offset + count);
        read_data.set(chunk);
        read_count += chunk.length;
    }

    let block_number = Math.floor(
        (offset + read_count - base_data.length) /
        INDEXEDDB_STORAGE_BLOCKSIZE
    );
    for(; read_count < count && block_number < extra_block_count; block_number++)
    {
        const block_offset = base_data.length + block_number * INDEXEDDB_STORAGE_BLOCKSIZE;
        const block_key = INDEXEDDB_STORAGE_GET_BLOCK_KEY(sha256sum, block_number);
        const block_entry = await this.db_get(transaction, block_key); // jshint ignore:line

        dbg_assert(block_entry, `IndexedDBFileStorage get: Missing entry for block-${block_number}`);

        const block_data = block_entry[INDEXEDDB_STORAGE_DATA_PATH];
        dbg_assert(block_data instanceof Uint8Array,
            `IndexedDBFileStorage get: Entry for block-${block_number} without Uint8Array data field: ${block_data}`);

        const chunk_start = offset + read_count - block_offset;
        const chunk_end = offset + count - block_offset;
        const chunk = block_data.subarray(chunk_start, chunk_end);
        read_data.set(chunk, read_count);
        read_count += chunk.length;
    }

    return read_data.subarray(0, read_count);
}; // jshint ignore:line

/**
 * @param {string} sha256sum
 * @param {number} offset
 * @param {!Uint8Array} write_data
 * @return {number} New file size
 */
IndexedDBFileStorage.prototype.write = async function(sha256sum, offset, write_data) // jshint ignore:line
{
    dbg_assert(this.db, "IndexedDBFileStorage set: Database is not initialized");
    dbg_assert(sha256sum, "IndexedDBFileStorage set: sha256sum should be a non-empty string");

    const transaction = this.db.transaction(INDEXEDDB_STORAGE_STORE, "readwrite");
    const entry = await this.db_get(sha256sum); // jshint ignore:line

    let old_extra_block_count = 0;
    let old_total_size = 0;
    let base_data = null;
    if(entry)
    {
        base_data = entry[INDEXEDDB_STORAGE_DATA_PATH];
        old_extra_block_count = entry[INDEXEDDB_STORAGE_EXTRABLOCKCOUNT_PATH];
        old_total_size = entry[INDEXEDDB_STORAGE_TOTALSIZE_PATH];
    }

    const needed_size = offset + write_data.length;
    const new_total_size = Math.max(old_total_size, needed_size);

    let write_count = 0;

    if(offset < INDEXEDDB_STORAGE_CHUNKING_THRESHOLD)
    {
        const chunk = write_data.subarray(0, INDEXEDDB_STORAGE_CHUNKING_THRESHOLD - offset);
        const chunk_end = chunk.length + offset;
        if(!base_data || base_data.length < chunk_end)
        {
            const old_base_data = base_data;
            base_data = new Uint8Array(chunk_end);
            if(old_base_data) base_data.set(old_base_data);
        }
        base_data.set(chunk, offset);
        write_count += chunk.length;
    }

    let block_number = Math.floor(
        (offset + write_count - base_data.length) /
        INDEXEDDB_STORAGE_BLOCKSIZE
    );
    for(; write_count < write_data.length; block_number++)
    {
        const block_offset = base_data.length + block_number * INDEXEDDB_STORAGE_BLOCKSIZE;
        const block_key = INDEXEDDB_STORAGE_GET_BLOCK_KEY(sha256sum, block_number);

        const chunk_start = offset + write_count - block_offset;
        const chunk_writable = INDEXEDDB_STORAGE_BLOCKSIZE - chunk_start;
        const write_remaining = write_data.length - write_count;
        const chunk = write_data.subarray(write_count, Math.min(chunk_writable, write_remaining));

        let block_data = chunk;

        if(chunk.length !== INDEXEDDB_STORAGE_BLOCKSIZE)
        {
            // Chunk to be written does not fully replace the current block.

            const block_entry = await this.db_get(transaction, block_key); // jshint ignore:line

            block_data = block_entry ?
                block_entry[INDEXEDDB_STORAGE_DATA_PATH] :
                new Uint8Array(INDEXEDDB_STORAGE_BLOCKSIZE);

            dbg_assert(block_data instanceof Uint8Array,
                `IndexedDBFileStorage get: Entry for block-${block_number} without Uint8Array data field: ${block_data}`);

            block_data.set(chunk, chunk_start);
        }

        await this.db_set(transaction, { //jshint ignore:line
            [INDEXEDDB_STORAGE_KEY_PATH]: block_key,
            [INDEXEDDB_STORAGE_DATA_PATH]: block_data,
        });
    }

    const new_extra_block_count = Math.max(old_extra_block_count, block_number);

    await this.db_set(transaction, { // jshint ignore:line
        [INDEXEDDB_STORAGE_KEY_PATH]: sha256sum,
        [INDEXEDDB_STORAGE_DATA_PATH]: base_data,
        [INDEXEDDB_STORAGE_TOTALSIZE_PATH]: new_total_size,
        [INDEXEDDB_STORAGE_EXTRABLOCKCOUNT_PATH]: new_extra_block_count,
    });

    return new_total_size;
}; // jshint ignore:line

/**
 * @constructor
 * @implements {FileStorageInterface}
 * @param {FileStorageInterface} file_storage
 * @param {string} baseurl
 */
function ServerFileStorageWrapper(file_storage, baseurl)
{
    dbg_assert(baseurl, "ServerMemoryFileStorage: baseurl should not be empty");

    this.storage = file_storage;
    this.baseurl = baseurl;
}

/**
 * @private
 * @param {string} sha256sum
 * @return {!Promise<Uint8Array>}
 */
ServerFileStorageWrapper.prototype.load_from_server = function(sha256sum)
{
    return new Promise((resolve, reject) =>
    {
        v86util.load_file(this.baseurl + sha256sum, { done: buffer =>
        {
            const data = new Uint8Array(buffer);
            this.write(sha256sum, 0, data).then(() => resolve(data));
        }});
    });
};

/**
 * @param {string} sha256sum
 * @param {number} offset
 * @param {number} count
 * @return {Uint8Array}
 */
ServerFileStorageWrapper.prototype.read = async function(sha256sum, offset, count) // jshint ignore:line
{
    const data = await this.storage.read(sha256sum, offset, count); // jshint ignore:line
    if(!data)
    {
        const full_file = await this.load_from_server(sha256sum); // jshint ignore:line
        return full_file.subarray(offset, offset + count);
    }
    return data;
}; // jshint ignore:line

/**
 * @param {string} sha256sum
 * @param {number} offset
 * @param {!Uint8Array} data
 * @return {number} New file size
 */
ServerFileStorageWrapper.prototype.write = async function(sha256sum, offset, data) // jshint ignore:line
{
    return await this.storage.write(sha256sum, offset, data); // jshint ignore:line
}; // jshint ignore:line
