import { Placement } from "@/contexts/ArFleetContext";
import { bufferToAscii, bufferToHex, bufferToString, byteArrayToLong, hexToBuffer, longTo8ByteArray } from "./buf";
import { DataItem } from "./dataitemmod";
import { b64UrlToBuffer, bufferTob64Url, stringToBuffer } from "./encodeUtils";
import { sha256hex } from "./hash";
import { PLACEMENT_BLOB_CHUNK_SIZE } from "./placementBlob";
import { RSA_ENCRYPTED_CHUNK_SIZE, RSA_UNDERLYING_CHUNK_SIZE } from "./rsa";
import { Sliceable, SliceableReader, SliceParts } from "./sliceable";

const ARP_VERSION = 1;

export enum ArpType {
    ARP_RAW_DATA = 0,
    ARP_DATAITEM = 1,
    ARP_NESTED = 2,
}

const ARP_CHUNK_SIZE = (PLACEMENT_BLOB_CHUNK_SIZE / RSA_ENCRYPTED_CHUNK_SIZE) * RSA_UNDERLYING_CHUNK_SIZE;

const USE_BINARY = true;

export class Arp extends Sliceable {
    type: ArpType;
    owner: string|null;
    signer: Function|null;
    innerByteLength: number;
    hashes: (arg0: number) => Promise<string>;
    dataItemId: string | null;
    chunkHashes: Record<number, string>; // Note: this is the chunk hashes for the arp contents itself, not the underlying data!

    constructor(type: ArpType, innerByteLength: number, hashes: (arg0: number) => Promise<string>, dataItemId: string | null = null, owner: string|null = null, signer: Function|null = null) {
        super();
        this.type = type;
        this.owner = owner;
        this.signer = signer;
        this.innerByteLength = innerByteLength;
        this.hashes = hashes;
        this.dataItemId = dataItemId;
        this.chunkHashes = {};
    }

    async getId(): Promise<string> {
        // by this time, all chunk hashes for this arp should be calculated
        // and it should occupy only one chunk
        const chunkHash0 = this.chunkHashes[0];
        if (!chunkHash0) throw new Error('Chunk hash 0 is not set');
        if (Object.keys(this.chunkHashes).length !== 1) throw new Error('Too many chunk hashes');
        return bufferTob64Url(new Uint8Array(hexToBuffer(chunkHash0)));
    }

    async getHexId(): Promise<string> {
        const chunkHash0 = this.chunkHashes[0];
        if (!chunkHash0) throw new Error('Chunk hash 0 is not set');
        if (Object.keys(this.chunkHashes).length !== 1) throw new Error('Too many chunk hashes');
        return chunkHash0;
    }

    async buildParts(): Promise<SliceParts> {
        let parts: SliceParts = [];

        parts.push([8, stringToBuffer("arf::arp")]);
        parts.push([1, new Uint8Array([ARP_VERSION])]);
        parts.push([1, new Uint8Array([this.type])]);

        parts.push([8, longTo8ByteArray(ARP_CHUNK_SIZE)]);

        const first_chunk_offset = 0;
        parts.push([8, longTo8ByteArray(first_chunk_offset)]);

        parts.push([8, longTo8ByteArray(this.innerByteLength)]);

        // Body

        if (this.type === ArpType.ARP_DATAITEM) {
            const dataItemID = this.dataItemId;
            if (!dataItemID) throw new Error('DataItem ID is not set');
            parts.push([32, b64UrlToBuffer(dataItemID)]);

            const signature = await this.signer!(this.owner!, parts);
            parts.push([512, signature]);
        }

        // Data hashes
        const hashLength = (USE_BINARY) ? 32 : 32 * 2;
        const numHashes = Math.ceil(this.innerByteLength / ARP_CHUNK_SIZE);
        parts.push([hashLength * numHashes, async (start: number, end: number) => {
            if (start > end) throw new Error('Invalid start and end');
            if (start < 0 || end < 0) throw new Error('Invalid start and end');
            const first = start / hashLength;
            const last = (end-1) / hashLength;
            const total = last - first + 1;
            let buf = new Uint8Array(total * hashLength);
            let c = 0;
            for (let i = first; i <= last; i++) {
                const hash: string = await this.hashes(i);
                if (USE_BINARY) {
                    buf.set(new Uint8Array(hexToBuffer(hash)), c * hashLength);
                } else {
                    buf.set(new Uint8Array(stringToBuffer(hash)), c * hashLength);
                }
                c++;
            }
            
            const firstOffset = start % hashLength;
            const sliceLen = end - start;

            return buf.slice(firstOffset, sliceLen);
        }]);

        return parts;
    }
}

export class ArpReader extends SliceableReader {
    private hash: string|null;
    type: ArpType;
    innerByteLength: number;
    chunkSize: number;
    chunkHashes: Record<number, string>;
    placement: Placement;
    initialized: boolean;
    manifest: Uint8Array | ArpReader | null;
    cacheChunks: Map<number, Uint8Array>;

    constructor(hash: string|ArpReader, placement: Placement) {
        super();
        this.hash = typeof hash === 'string' ? hash : null;
        this.type = ArpType.ARP_RAW_DATA;
        this.innerByteLength = 0;
        this.chunkSize = 0;
        this.chunkHashes = {};
        this.placement = placement;
        this.initialized = false;
        this.manifest = typeof hash === 'string' ? null : hash;
        this.cacheChunks = new Map<number, Uint8Array>();
    }

    async slice(start: number, end: number): Promise<Uint8Array> {
        if (!this.initialized) throw new Error('ARP is not initialized');
        if (start < 0 || end < 0) throw new Error('Invalid start and end');
        if (start > end) throw new Error('Invalid start and end');

        if (this.type === ArpType.ARP_NESTED) {
            if (!this.manifest || !(this.manifest instanceof ArpReader)) throw new Error('Nested ARP chunk is not set');
            return this.manifest.slice(start, end);
        }

        if (start >= this.innerByteLength || end > this.innerByteLength) throw new Error('Invalid start and end');
        
        const startChunkIdx = Math.floor(start / this.chunkSize);
        const finalChunkIdx = Math.floor((end-1) / this.chunkSize);
        const totalChunks = finalChunkIdx - startChunkIdx + 1;
        const extendedLen = totalChunks * this.chunkSize;

        // console.log("startChunkIdx", startChunkIdx);
        // console.log("finalChunkIdx", finalChunkIdx);
        // console.log("totalChunks", totalChunks);
        // console.log("extendedLen", extendedLen);
        // console.log("this.chunkSize", this.chunkSize);

        const buf = new Uint8Array(extendedLen);
        for (let i = 0; i < totalChunks; i++) {
            // console.log("startChunkIdx + i", startChunkIdx + i);
            const chunkHash = this.chunkHashes[startChunkIdx + i];
            if (!chunkHash) throw new Error('Chunk hash is not set');

            if (chunkHash === this.hash) {
                throw new Error('Chunk hash is the same as the ARP hash');
            }

            let chunk = this.cacheChunks.get(startChunkIdx + i);
            // console.log("cached chunk", bufferToHex(chunk), startChunkIdx + i);

            if (!chunk) {
                chunk = await this.placement.downloadChunk(chunkHash);
                // console.log("downloaded chunk", bufferToHex(chunk), startChunkIdx + i);
                this.cacheChunks.set(startChunkIdx + i, chunk);
            }
            
            buf.set(chunk, i * this.chunkSize);
        }

        // Keep only 64 chunks in memory
        if (this.cacheChunks.size > 64) {
            const keysToDelete = Array.from(this.cacheChunks.keys())
                .sort((a, b) => a - b)
                .slice(0, this.cacheChunks.size - 64);
            
            for (const key of keysToDelete) {
                this.cacheChunks.delete(key);
            }
        }

        const firstOffset = start % this.chunkSize;
        const sliceLen = end - start;

        // console.log('arp slice', start, end, firstOffset, sliceLen, bufferToAscii(buf));

        const result = buf.slice(firstOffset, firstOffset + sliceLen);
        // console.log('arp slice result', bufferToAscii(result));
        return result;
    }

    async init() {
        if (this.initialized) return;
        this.initialized = true;

        if (this.type === ArpType.ARP_NESTED) {
            if (!this.manifest || !(this.manifest instanceof ArpReader)) throw new Error('Nested ARP chunk is not set');
            await this.manifest!.init();
        } else {
            if (!this.hash) throw new Error('ARP hash is not set');
            // console.log('downloading arp manifest', this.hash);
            this.manifest = await this.placement.downloadChunk(this.hash);
            // console.log('downloaded arp manifest', this.hash, bufferToAscii(this.manifest));
        }

        // verify header
        if (bufferToString(await this.manifest!.slice(0, 8)) !== "arf::arp") throw new Error('Invalid ARP header');
        if ((await this.manifest!.slice(8, 9))[0] !== ARP_VERSION) throw new Error('Invalid ARP version');

        this.type = (await this.manifest!.slice(9, 10))[0];

        this.chunkSize = byteArrayToLong(await this.manifest!.slice(10, 10+8));

        const firstChunkOffset = byteArrayToLong(await this.manifest!.slice(18, 18+8));
        if (firstChunkOffset !== 0) throw new Error('First chunk offset is not 0');

        const innerByteLength = byteArrayToLong(await this.manifest!.slice(26, 26+8));
        this.innerByteLength = innerByteLength;

        const numHashes = Math.ceil(this.innerByteLength / this.chunkSize);
        const hashLength = (USE_BINARY) ? 32 : 32 * 2;
        for (let i = 0; i < numHashes; i++) {
        const chunkHash = await this.manifest!.slice(34 + i * hashLength, 34 + (i+1) * hashLength);
            this.chunkHashes[i] = (USE_BINARY) ? bufferToHex(chunkHash) : bufferToString(chunkHash);
        }

        // console.log('chunk hashes', this.chunkHashes);
    }
}