import { FileMetadata } from "../contexts/ArFleetContext";
import { AES_IV_BYTE_LENGTH, AESEncryptedContainer } from "./aes";
import { Arp, ArpType } from "./arp";
import { concatBuffers } from "./buf";
import { DataItem, DataItemFactory } from "./dataitemmod";
import { createSalt, encKeyFromMasterKeyAndSalt } from "./encrypt";
import { downloadUint8ArrayAsFile } from "./extra";
import { FolderManifest } from "./folderManifest";
import { sha256hex } from "./hash";
import { PassthroughAES } from "./passthroughAES";
import { PLACEMENT_BLOB_CHUNK_SIZE } from "./placementBlob";
import { RSA_ENCRYPTED_CHUNK_SIZE, RSA_HEADER_SIZE, RSA_PLACEMENT_UNDERLYING_CHUNK_SIZE, RSA_UNDERLYING_CHUNK_SIZE } from "./rsa";
import { Sliceable, SlicePart, SliceParts } from "./sliceable";

const FOLDER_FILE_BOUNDARY = (PLACEMENT_BLOB_CHUNK_SIZE / RSA_ENCRYPTED_CHUNK_SIZE) * RSA_UNDERLYING_CHUNK_SIZE;

export class Folder extends Sliceable {
    files: FileMetadata[] = [];
    private dataItemFactory: DataItemFactory;
    encryptedManifestDataItem: DataItem | null = null;
    signer: any;
    masterKey: Uint8Array;
    chunkIdxToFile: Map<number, [ FileMetadata | Arp | DataItem, number ]> = new Map();
    chunksConsumed = 0;
    partsBeingBuilt: SliceParts = [];
    numChunksCached: number;

    constructor(files: FileMetadata[], dataItemFactory: DataItemFactory, signer: any, masterKey: Uint8Array, numChunksCached: number) {
        super();
        this.files = files;
        this.dataItemFactory = dataItemFactory;
        this.signer = signer;
        this.masterKey = masterKey;
        this.numChunksCached = numChunksCached;
    }

    async remainingZeroes(byteLength: number, boundary: number) {
        const expandedLength = Math.ceil(byteLength / boundary) * boundary;
        const diff = expandedLength - byteLength;
        if (diff > 0) {
            return diff;
        }
        return 0;
    }

    async sliceThroughFileDataItem(fileOrArp: FileMetadata | Arp | DataItem, start: number, end: number) {
        const sliceable = (fileOrArp instanceof FileMetadata) ? fileOrArp.encryptedDataItem! : fileOrArp;

        const byteLength = await sliceable.getByteLength();

        const chunkIdxStart = Math.floor(start / FOLDER_FILE_BOUNDARY);
        const chunkIdxFinal = Math.floor((end-1) / FOLDER_FILE_BOUNDARY);

        const chunkBufs = [];

        for(let curChunkIdx = chunkIdxStart; curChunkIdx <= chunkIdxFinal; curChunkIdx++) {
            // const chunk = await file.encryptedDataItem!.slice(curChunkIdx * FOLDER_FILE_BOUNDARY, Math.min(curChunkIdx * FOLDER_FILE_BOUNDARY + FOLDER_FILE_BOUNDARY, byteLength));
            const chunkStartByte = curChunkIdx * FOLDER_FILE_BOUNDARY;
            const chunkEnd = Math.min(chunkStartByte + FOLDER_FILE_BOUNDARY, byteLength);
            const chunk = await sliceable.slice(chunkStartByte, chunkEnd);

            // console.log('chunk', {curChunkIdx, chunkLength: chunk.byteLength, expected: chunkEnd - chunkStartByte});

            if (chunk.byteLength !== chunkEnd - chunkStartByte) {
                throw new Error('Chunk byte length is not equal to the expected byte length');
            }

            const chunkPadded = new Uint8Array(FOLDER_FILE_BOUNDARY).fill(0x00);
            chunkPadded.set(chunk);

            const hash = await sha256hex(chunkPadded);
            // console.log('effective hash of chunk:', new TextDecoder().decode(chunkPadded), chunkPadded.byteLength, hash, curChunkIdx, fileOrArp);
            fileOrArp.chunkHashes[curChunkIdx] = hash;

            chunkBufs.push(chunkPadded);
        }

        const chunkBufConcat = concatBuffers(chunkBufs);

        const finalStart = start - (chunkIdxStart * FOLDER_FILE_BOUNDARY);
        const len = end - start;

        return chunkBufConcat.slice(finalStart, finalStart + len);
    }

    async pushZeroes(parts: SliceParts, byteLength: number) {
        const diff = await this.remainingZeroes(byteLength, FOLDER_FILE_BOUNDARY);
        if (diff > 0) {
            parts.push([diff, this.zeroes.bind(this, 0, diff)] as SlicePart);
        }
    }

    async buildFile(file: FileMetadata) {
        let fileChunkStart = this.chunksConsumed;
        console.log('buildFile', {file, fileChunkStart});
        const byteLength = await file.encryptedDataItem!.getByteLength();
        this.partsBeingBuilt.push([byteLength, this.sliceThroughFileDataItem.bind(this, file)] as SlicePart);

        await this.pushZeroes(this.partsBeingBuilt, byteLength);

        const totalChunks = Math.ceil(byteLength / FOLDER_FILE_BOUNDARY);
        console.log({totalChunks, file, fileChunkStart, byteLength});
        for(let q = 0; q < totalChunks; q++) { this.chunkIdxToFile.set(this.chunksConsumed, [ file, q ]); this.chunksConsumed++; }

        await this.addArp(file, byteLength, fileChunkStart);
    }

    async addArp(file: FileMetadata | DataItem, byteLength: number, fileChunkStart: number) {
        let arp = new Arp(ArpType.ARP_RAW_DATA, byteLength, (async (cs: number, hashIdx: number) => {
            console.log('[DEBUG] RAW_DATA callback', { cs, hashIdx, key: cs + hashIdx, chunks: this.chunkIdxToFile.size });
            const val = this.chunkIdxToFile.get(cs + hashIdx);
            if (!val) {
                console.error('[DEBUG] Key not found in chunkIdxToFile for RAW_DATA');
                console.log('[DEBUG] chunkIdxToFile keys', Array.from(this.chunkIdxToFile.keys()));
            }
            const [file_, chunkIdx] = val!;
            const hash = file_.chunkHashes[chunkIdx];
            // console.log('arp file', {file_, file, chunkIdx, hash, cs, hashIdx, chunkIdxToFile: this.chunkIdxToFile});
            if (!hash) {
                console.log('Chunk hash is not set, asking for arp hash of file:', file_, chunkIdx);
                console.log('chunkIdxToFile:', this.chunkIdxToFile);
                console.log('cs:', cs);
                console.log('hashIdx:', hashIdx);
                console.log('chunksConsumed:', this.chunksConsumed);
                console.log(file_.chunkHashes);
                throw new Error('Chunk hash is not set, asking for arp hash of file');
            }
            return hash;
        }).bind(this, fileChunkStart));
        console.log('bound arp', {arp, file, fileChunkStart});
        let arpByteLength = await arp.getByteLength();

        this.partsBeingBuilt.push([arpByteLength, this.sliceThroughFileDataItem.bind(this, arp)]);
        await this.pushZeroes(this.partsBeingBuilt, arpByteLength);
        fileChunkStart = this.chunksConsumed; // fileChunkStart is now the start of the arp
        console.log('arp byte length', arpByteLength);
        console.log('advancing', Math.ceil(arpByteLength / FOLDER_FILE_BOUNDARY));
        for(let q = 0; q < Math.ceil(arpByteLength / FOLDER_FILE_BOUNDARY); q++) { this.chunkIdxToFile.set(this.chunksConsumed, [ arp, q ]); this.chunksConsumed++; }
        console.log('advanced to', this.chunksConsumed);

        while(arpByteLength > FOLDER_FILE_BOUNDARY) {
            arp = new Arp(ArpType.ARP_NESTED, arpByteLength, (async (cs: number, hashIdx: number) => {
                console.log('[DEBUG] NESTED callback', { cs, hashIdx, key: cs + hashIdx, chunks: this.chunkIdxToFile.size });
                const val = this.chunkIdxToFile.get(cs + hashIdx);
                if (!val) {
                    console.error('[DEBUG] Key not found in chunkIdxToFile for NESTED');
                    console.log('[DEBUG] chunkIdxToFile keys', Array.from(this.chunkIdxToFile.keys()));
                }
                const [a, chunkIdx] = val!;
                // console.log('a', a, a.chunkHashes);
                const chunkHash = a.chunkHashes[chunkIdx];
                if (!chunkHash) throw new Error('Chunk hash is not set, asking for hash of nested arp:' + a + ' ' + chunkIdx);
                return chunkHash;
            }).bind(this, fileChunkStart));
            arpByteLength = await arp.getByteLength();
            
            this.partsBeingBuilt.push([arpByteLength, this.sliceThroughFileDataItem.bind(this, arp)]);
            await this.pushZeroes(this.partsBeingBuilt, arpByteLength);
            fileChunkStart = this.chunksConsumed;
            for(let q = 0; q < Math.ceil(arpByteLength / FOLDER_FILE_BOUNDARY); q++) { this.chunkIdxToFile.set(this.chunksConsumed, [ arp, q ]); this.chunksConsumed++; }
        }

        file.arp = arp;
    }

    async buildManifest() {
        let fileChunkStart = this.chunksConsumed;

        const manifest = new FolderManifest(this.files);
        const manifestDataItem = await this.dataItemFactory.createDataItemWithSliceable(manifest, [
            {name: "Content-type", value: "application/x.arweave-manifest+json" },
            {name: "ArFleet-DataItem-Type", value: "AESPathManifest" }
        ], this.signer);

        const salt = createSalt();
        const iv = createSalt(AES_IV_BYTE_LENGTH);
        const secretKey = await encKeyFromMasterKeyAndSalt(this.masterKey, salt);
        const encContainer = new AESEncryptedContainer(manifestDataItem, salt, secretKey, iv, this.numChunksCached);

        this.encryptedManifestDataItem = await this.dataItemFactory.createDataItemWithSliceable(encContainer, [
            {name: "ArFleet-DataItem-Type", value: "EncryptedAESPathManifest" }
        ], this.signer);

        const encManifestByteLength = await this.encryptedManifestDataItem.getByteLength();
        // this.partsBeingBuilt.push([ encManifestByteLength, this.encryptedManifestDataItem ]);

        this.partsBeingBuilt.push([encManifestByteLength, this.sliceThroughFileDataItem.bind(this, this.encryptedManifestDataItem)]);
        await this.pushZeroes(this.partsBeingBuilt, encManifestByteLength);
        fileChunkStart = this.chunksConsumed;
        for(let q = 0; q < Math.ceil(encManifestByteLength / FOLDER_FILE_BOUNDARY); q++) { this.chunkIdxToFile.set(this.chunksConsumed, [ this.encryptedManifestDataItem, q ]); this.chunksConsumed++; }

        //

        await this.addArp(this.encryptedManifestDataItem, encManifestByteLength, fileChunkStart);

        // console.log(this.partsBeingBuilt);
        // console.log('FOLDER PARTS:', await this.dumpParts(this.partsBeingBuilt));
        // console.log('ENCRYPTED MANIFEST DATA ITEM:', this.encryptedManifestDataItem);
    }

    async buildParts(): Promise<SliceParts> {
        // console.log('FILES:', this.files);
        for (const file of this.files) {
            await this.buildFile(file);
        }

        await this.buildManifest();

        return this.partsBeingBuilt;
    }
}

export async function createFolder(files: FileMetadata[], dataItemFactory: DataItemFactory, signer: any, masterKey: Uint8Array, numChunksCached: number) {
    return new Folder(files, dataItemFactory, signer, masterKey, numChunksCached);
}