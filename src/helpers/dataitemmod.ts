import { b64UrlToBuffer, bufferTob64Url } from "./encodeUtils";
import { serializeTags, Tag } from "./tags";
import { stringToBuffer, concatBuffers, longTo8ByteArray, byteArrayToLong, bufferToString, bufferToAscii, bufferToHex } from "./buf";
import { Hasher, HashType, makeHasher, sha256, sha384 } from "./hash";
import { deepHash, deepHashChunks, DeepHashPointer } from "./deephashmod";
import { downloadUint8ArrayAsFile } from "./extra";
import { Sliceable, SliceableReader, SliceParts } from "./sliceable";
import { AESEncryptedContainer } from "./aes";
import { Arp, ArpReader } from "./arp";
import { CallbackQueue } from "./callbackQueue";

const HASH_CHUNK_SIZE = 128;
class HashChunk {
  data: Uint8Array;
  bytesSet: Set<number>;
  state: "filling" | "filled" | "hashed";
  hasher: Hasher | null;
  constructor() {
    this.data = new Uint8Array(HASH_CHUNK_SIZE);
    this.bytesSet = new Set<number>();
    this.state = "filling";
    this.hasher = null;
  }
}

export class DataItem extends Sliceable {
    signatureType: Uint8Array;
    signatureTypeBin: Uint8Array;
    signatureLength: number;
    owner: string;
    target: string | null;
    anchor: string | null;
    tags: Tag[];
    dataHash: DeepHashPointer | null;
    dataItemId: string | null;
    private signature: Uint8Array | null;
    signer: Function;

    forceCalcQueue: CallbackQueue;
    
    rollingHashChunkCount: number;
    rollingHashChunks: Map<number, HashChunk>;
    highestHashedChunkIdx: number;

    // prepareToSign(): Promise<any>;
    // extractHash(): Promise<DeepHashPointer>;
    // exportSigned(signature: Uint8Array): Promise<any>;
    // exportBinaryHeader(signature?: Uint8Array): Promise<Uint8Array>;
    rawFile: File | Uint8Array | AESEncryptedContainer | Sliceable | null;
    dataByteLength: number;

    cachedDataItemLength: number | null;

    binaryHeaderCached: Uint8Array | null;
    binaryHeaderCachedDryRun: Uint8Array | null;

    chunkHashes: Record<number, string>;
    arp: Arp | null;

    constructor(
        dataByteLength: number,
        dataHash: DeepHashPointer | null,
        owner: string,
        target: string | null,
        anchor: string | null,
        tags: Tag[],
        rawFile: File | Uint8Array | AESEncryptedContainer | Sliceable | null,
        signer: Function
    ) {
        super();
        this.signatureType = new Uint8Array([1, 0]); // Arweave
        this.signatureTypeBin = new Uint8Array([1]);
        this.signatureLength = 512;
        this.signature = null;
        this.owner = owner;
        this.target = target;
        this.anchor = anchor;
        this.tags = tags;
        this.dataHash = dataHash;
        this.rawFile = rawFile;
        this.dataByteLength = dataByteLength;
        this.cachedDataItemLength = null;
        this.dataItemId = null;
        this.signer = signer;
        this.rollingHashChunkCount = Math.ceil(dataByteLength / HASH_CHUNK_SIZE);
        this.rollingHashChunks = new Map<number, HashChunk>();
        this.highestHashedChunkIdx = -1;
        this.forceCalcQueue = new CallbackQueue();

        this.binaryHeaderCached = null;
        this.binaryHeaderCachedDryRun = null;

        this.chunkHashes = {};
        this.arp = null;
    }

    async prepareToSign(): Promise<Uint8Array> {
        if (!this.dataHash) throw new Error("Data hash is not available");

        // console.log(this);
        let signArray = [];
        
        signArray.push(stringToBuffer("dataitem"));
        signArray.push(stringToBuffer("1"));
        signArray.push(this.signatureTypeBin);
        signArray.push(b64UrlToBuffer(this.owner));
        if (this.target) signArray.push(b64UrlToBuffer(this.target));
        if (this.anchor) signArray.push(b64UrlToBuffer(this.anchor));
        signArray.push(this.tags.map(tag => [stringToBuffer(tag.name), stringToBuffer(tag.value)]));
        signArray.push(this.dataHash);

        const tag = concatBuffers([
            stringToBuffer("list"),
            stringToBuffer(signArray.length.toString())
        ]);
    
        return await deepHashChunks(
            signArray,
            await sha384(tag),
            false /* do not hash the last chunk */
        );
    }

    async extractHash(): Promise<DeepHashPointer> {
        const pointer: DeepHashPointer = {
            value: await deepHash(await this.prepareToSign()),
            role: 'file-dataitem',
            dataLength: this.dataByteLength
        };
        return pointer;
    }

    async getDataItemId(): Promise<string> {
      if (this.dataItemId === null) throw new Error("DataItem ID is not yet available");
      return this.dataItemId;
    }

    async setSignature(signature: Uint8Array): Promise<void> {
      const dataItemId = bufferTob64Url(await sha256(signature));

      if (this.signature !== null) {
        // compare signatures
        if (bufferToHex(signature) !== bufferToHex(this.signature)) {
          throw new Error("Signature already set");
          // console.log("signature already set", bufferToHex(signature), bufferToHex(this.signature));
          // throw new Error("Signature already set");
          // Quitely ignore
          return;
        }
      }
      this.signature = signature;
      this.dataItemId = dataItemId;
    }

    async sign(): Promise<void> {
      if (this.signature) return;
      if (!this.signer) throw new Error("Signer is not available");
      const signature = await this.signer(await this.prepareToSign(), {
        hashAlgorithm: 'SHA-384',
      });
      await this.setSignature(signature);
    }

    // async exportSigned(signature: Uint8Array): Promise<Uint8Array> {
    //   //
    // }

    // async getByteLength(): Promise<number> {
    //   if (this.cachedDataItemLength) return this.cachedDataItemLength;

    //   const _target = this.target ? b64UrlToBuffer(this.target) : null;
    //   const target_length = 1 + (_target?.byteLength ?? 0);
    //   const _anchor = this.anchor ? b64UrlToBuffer(this.anchor) : null;
    //   const anchor_length = 1 + (_anchor?.byteLength ?? 0);
    //   const _tags = (this.tags?.length ?? 0) > 0 ? serializeTags(this.tags) : null;
    //   const tags_length = 16 + (_tags ? _tags.byteLength : 0);
    //   const _owner = b64UrlToBuffer(this.owner);
    //   const owner_length = _owner.byteLength;

    //   const length = 2 + this.signatureLength + owner_length + target_length + anchor_length + tags_length;
    //   this.cachedDataItemLength = length;
    //   return length;
    // }

    async exportBinaryHeader(dryRun: boolean = false): Promise<Uint8Array> {
      if (this.signature === null && !dryRun) {
        await this.sign();
      }

      console.log('target', this.target);
      console.log('anchor', this.anchor);

      const signature = dryRun ? new Uint8Array(this.signatureLength).fill(0) : this.signature!;

      const _target = this.target ? b64UrlToBuffer(this.target) : null;
      const target_length = 1 + (_target?.byteLength ?? 0);

      const _anchor = this.anchor ? b64UrlToBuffer(this.anchor) : null;
      const anchor_length = 1 + (_anchor?.byteLength ?? 0);
      const _tags = (this.tags?.length ?? 0) > 0 ? serializeTags(this.tags) : null;
      const tags_length = 16 + (_tags ? _tags.byteLength : 0);

      if (!this.owner) throw new Error("Owner is not set");
      const _owner = b64UrlToBuffer(this.owner);
      const owner_length = _owner.byteLength;

      const length = 2 + this.signatureLength + owner_length + target_length + anchor_length + tags_length;
      // console.log({length, owner_length, target_length, anchor_length, tags_length})
      // console.log("tags", _tags)
  
      // Create array with set length
      const bytes = new Uint8Array(length).fill(0xff);

      // Signature type
      bytes[0] = this.signatureType[0];
      bytes[1] = this.signatureType[1];

      // Push bytes for signature
      bytes.set(signature, 2);
      if (signature.byteLength !== this.signatureLength) throw new Error(`Signature must be ${this.signatureLength} bytes but was incorrectly ${signature.byteLength}`);

      // Push bytes for `owner`
      bytes.set(_owner, 2 + this.signatureLength);
      if (owner_length !== 512 || _owner.byteLength !== 512) throw new Error(`Owner must be 512 bytes but was incorrectly ${owner_length} or ${_owner.byteLength}`);

      const position = 2 + this.signatureLength + owner_length;
      // Push `presence byte` and push `target` if present
      // 64 + OWNER_LENGTH
      bytes[position] = this.target ? 1 : 0;
      if (_target) {
        if (_target.byteLength !== 32) throw new Error(`Target must be 32 bytes but was incorrectly ${_target.byteLength}`);
        bytes.set(_target, position + 1);
      }
      
      // Push `presence byte` and push `anchor` if present
      // 64 + OWNER_LENGTH
      const anchor_start = position + target_length;
      let tags_start = anchor_start + 1;
      bytes[anchor_start] = this.anchor ? 1 : 0;
      if (this.anchor) {
        if (_anchor === null || _anchor.byteLength !== 32) throw new Error('Anchor must be 32 bytes!!!');
        tags_start += _anchor.byteLength;
        bytes.set(_anchor, anchor_start + 1);
      }

      // Tags
      bytes.set(longTo8ByteArray(this.tags?.length ?? 0), tags_start);
      const bytesCount = longTo8ByteArray(_tags?.byteLength ?? 0);
      bytes.set(bytesCount, tags_start + 8);
      if (_tags) {
        // console.log("tags", _tags)
        // console.log("tags start", tags_start)
        // console.log("tags start + 16", tags_start + 16)
        bytes.set(_tags, tags_start + 16);
      }

      // downloadUint8ArrayAsFile(bytes, "dataitem.bin");

      if (bytes.byteLength !== length) throw new Error(`Bytes must be ${length} bytes but was ${bytes.byteLength}`);

      return bytes;
    }

    async getUnderlyingLength(): Promise<number> {
      if (this.rawFile) {
        if (this.rawFile instanceof Sliceable) {
          return await this.rawFile.getByteLength();
        } else if (this.rawFile instanceof File) {
          return this.rawFile.size;
        } else if (this.rawFile instanceof Uint8Array) {
          return this.rawFile.byteLength;
        } else {
          throw new Error("Invalid type of raw file");
        }
      } else {
        throw new Error("No raw file available");
      }
    }

    async sliceUnderlying(start: number, end: number): Promise<Uint8Array> {
      let slice: Uint8Array;

      if (this.rawFile) {
        if (this.rawFile instanceof Sliceable) {
          slice = await this.rawFile.slice(start, end);
        } else if (this.rawFile instanceof File) {
          slice = new Uint8Array(await this.rawFile.slice(start, end).arrayBuffer());
        } else if (this.rawFile instanceof Uint8Array) {
          slice = this.rawFile.slice(start, end);
        } else {
          throw new Error("Invalid type of raw file");
        }
      } else {
        throw new Error("No raw file available");
      }

      // if (!this.dataHash) {
      //   for(let i=start; i<end; i++) {
      //     // set byte i
      //     const chunkIdx = Math.floor(i / HASH_CHUNK_SIZE);
      //     let chunk: HashChunk;
      //     if (!this.hashChunks.has(chunkIdx)) {
      //       chunk = {
      //         data: new Uint8Array(HASH_CHUNK_SIZE),
      //         bytesSet: new Set<number>(),
      //         state: "filling",
      //         hasher: null
      //       };
      //       this.hashChunks.set(chunkIdx, chunk);
      //       // console.log("NO CHUNK", chunk);
      //     } else {
      //       chunk = this.hashChunks.get(chunkIdx)!;
      //       // console.log("HAS CHUNK", chunk);
      //     }
      //     // console.log("set byte ", i, chunkIdx, chunk.bytesSet);

      //     if (chunk.state === "filling") {
      //       if (!chunk.bytesSet.has(i)) {
      //         chunk.bytesSet.add(i);
      //       }  

      //       // mem copy
      //       chunk.data.set(slice.slice(i, i+1), i % HASH_CHUNK_SIZE);

      //       const unfilledChunk = this.dataByteLength % HASH_CHUNK_SIZE !== 0 && chunkIdx === this.hashChunkCount - 1;
      //       const bytesNeeded = unfilledChunk ? this.dataByteLength % HASH_CHUNK_SIZE : HASH_CHUNK_SIZE;
      //       if (chunk.bytesSet.size === bytesNeeded) {
      //         chunk.state = "filled";
      //         chunk.bytesSet = new Set<number>();
      //       }
      //     }

      //     if (chunk.state === "filled") { // could be right after previous if clause
      //       // pseudocode

      //       // highestHashedChunkIdx is a pointer telling us where the hasher stopped, including that hash
      //       // best case scenario: highestHashedChunkIdx is previous chunk. we would take the hasher, update with our data, and set highest to us
      //       //     after everything, continue until the end, or until you find a gap
      //       // if you look -1 left and it's not filled, give up for now because later when the gap is filled, it's gonna roll until us and through us anyway

      //       for(let x=chunkIdx; x<this.hashChunkCount; x++) {
      //         const xChunk = this.hashChunks.get(x);
      //         if (xChunk) {
      //           const unfilledChunk = this.dataByteLength % HASH_CHUNK_SIZE !== 0 && x === this.hashChunkCount - 1;
      //           const bytesNeeded = unfilledChunk ? this.dataByteLength % HASH_CHUNK_SIZE : HASH_CHUNK_SIZE;
      //           const dataToHash = xChunk.data.slice(0, bytesNeeded);
    
      //           if (xChunk.state === "filled") {
      //             if (x === 0) {
      //               if (this.highestHashedChunkIdx === -1) {
      //                 xChunk.hasher = await makeHasher(HashType.SHA384);
      //                 xChunk.hasher.update(dataToHash);
      //                 xChunk.state = "hashed";
      //                 this.highestHashedChunkIdx = x;
      //                 // now it will continue to the next one
      //               } else {
      //                 throw new Error("Invalid state");
      //               }
      //             } else {
      //               if (this.highestHashedChunkIdx === x - 1) {
      //                 // take the hasher, update with our data, and set highest to us
      //                 const pChunk = this.hashChunks.get(x - 1)!;
      //                 if (!pChunk.hasher) throw new Error("Previous chunk hasher not found");
      //                 pChunk.hasher.update(dataToHash);
      //                 xChunk.state = "hashed";
      //                 xChunk.hasher = pChunk.hasher;
      //                 pChunk.hasher = null;
      //                 pChunk.data = new Uint8Array(0);
      //                 this.highestHashedChunkIdx = x;
      //                 // now it will continue to the next one
      //               } else {
      //                 // gap, give up
      //                 break;
      //               }
      //             }
      //           }
      //         } else {
      //           // gap, give up
      //           break;
      //         }
      //       }

      //       if (this.highestHashedChunkIdx === this.hashChunkCount - 1) {
      //         // we're done, extract the hash
      //         const lastChunk = this.hashChunks.get(this.hashChunkCount - 1);
      //         if (!lastChunk) throw new Error("Last chunk not found");
      //         const hash = lastChunk.hasher?.finalize();
      //         if (!hash) throw new Error("Hash not found");
      //         this.dataHash = {
      //           value: hash,
      //           role: 'file-dataitem',
      //           dataLength: this.dataByteLength
      //         };
      //         // console.log("HASH DATA ITEM", this.dataHash);
      //         this.hashChunks.clear();
      //       }
      //     }
      //   }

      //   // console.log("slice reading", start, end);
      //   // console.log("slice", slice);
      //   // console.log("highestHashedChunkIdx", this.highestHashedChunkIdx);
      //   // console.log("hashChunkCount", this.hashChunkCount);
      //   // console.log("hashChunks", this.hashChunks);
      // }

      return slice;
    }

    async forceCalcDataHash() {
      if (this.forceCalcQueue.status === "done") {
        return this.forceCalcQueue.result;
      }
      if (this.forceCalcQueue.status === "calculating") {
        return new Promise((resolve, reject) => { this.forceCalcQueue.add([resolve, reject]); });
      }
      this.forceCalcQueue.status = "calculating";

      //

      if (this.dataHash) throw new Error("Data hash already calculated");
      
      this.dataHash = null;
      const totalLength = await this.getUnderlyingLength();
      const chunkSize = 1024 * 1024; // 1MB chunks
      const hasher = await makeHasher(HashType.SHA384);

      for (let start = 0; start < totalLength; start += chunkSize) {
        const end = Math.min(start + chunkSize, totalLength);
        const chunk = await this.sliceUnderlying(start, end);
        await hasher.update(chunk);
      }

      const hash = await hasher.finalize();
      this.dataHash = {
        value: hash,
        role: 'file-dataitem',
        dataLength: totalLength
      };

      // signature
      await this.sign();
      
      //

      this.forceCalcQueue.done(this.dataHash);

      return this.dataHash;
    }

    async buildParts(): Promise<SliceParts> {
      let parts: SliceParts = [];

      // Note: inverted! Data first, then header

      // Magic bytes
      parts.push([8, stringToBuffer("arf::~di")]);

      // Data length
      const dataLength = await this.getUnderlyingLength();
      parts.push([8, longTo8ByteArray(dataLength)]);

      // const dataHash = await this.forceCalcDataHash();
      // if (!dataHash) throw new Error("Data hash not found");
      // parts.push([32, dataHash.value]);

      // Data
      parts.push([dataLength, this.sliceUnderlying.bind(this)]);

      // Now header
      const headerTemplate = await this.exportBinaryHeader(true);

      parts.push([headerTemplate.byteLength, this.sliceHeader.bind(this)]);

      // console.log("parts", parts);

      return parts;
    }

    async getRawBinary(): Promise<Uint8Array> {
      return await this.slice(0, await this.getByteLength());
    }

    async sliceHeader(start: number, end: number): Promise<Uint8Array> {
      await this.forceCalcDataHash();

      if (!this.binaryHeaderCached) this.binaryHeaderCached = await this.exportBinaryHeader(false);
      return this.binaryHeaderCached.slice(start, end);
    }
}

export class DataItemFactory {
  owner: string;
  target: string | null;
  rootAnchor: string | null;
  tags: Tag[];
  lastAnchorIdx: number;

  constructor(owner: string, target: string | null, rootAnchor: string | null, tags: Tag[]) {
    this.owner = owner;
    this.target = target;
    this.rootAnchor = rootAnchor;
    this.tags = tags;
    this.lastAnchorIdx = 0;
  }

  async nextAnchor(): Promise<string> {
    const anchor = bufferTob64Url(await sha256(concatBuffers([b64UrlToBuffer(this.rootAnchor!), new TextEncoder().encode(this.lastAnchorIdx.toString())])));
    this.lastAnchorIdx++;
    return anchor;
  }

  async createDataItemWithDataHash(
      dataHash: DeepHashPointer,
      extraTags: Tag[] = [],
      signer: any
  ): Promise<DataItem> {
      const finalTags = [...this.tags, ...extraTags ];
      if (typeof signer.signer !== 'function') {
        throw new Error("Signer must be a function");
      }
      const dataItem = new DataItem(dataHash.dataLength, dataHash, this.owner, this.target, await this.nextAnchor(), finalTags, null, signer.signer);

      return dataItem;
  }

  async createDataItemWithRawFile(
    rawFile: File,
    extraTags: Tag[] = [],
    signer: any
  ): Promise<DataItem> {
    const finalTags = [...this.tags, ...extraTags ];
    if (typeof signer.signer !== 'function') {
      throw new Error("Signer must be a function");
    }
    const dataItem = new DataItem(rawFile.size, null, this.owner, this.target, await this.nextAnchor(), finalTags, rawFile, signer.signer);

    return dataItem;
  }

  async createDataItemWithBuffer(
    buffer: Uint8Array,
    extraTags: Tag[] = [],
    signer: any
  ): Promise<DataItem> {
    const finalTags = [...this.tags, ...extraTags ];
    if (typeof signer.signer !== 'function') {
      throw new Error("Signer must be a function");
    }
    const hash: DeepHashPointer = {
      value: await sha384(buffer),
      role: 'file-dataitem',
      dataLength: buffer.byteLength
    };
    const dataItem = new DataItem(buffer.byteLength, hash, this.owner, this.target, await this.nextAnchor(), finalTags, buffer, signer.signer);

    return dataItem;
  }

  async createDataItemWithSliceable(
    container: Sliceable,
    extraTags: Tag[] = [],
    signer: any
  ): Promise<DataItem> {
    const finalTags = [...this.tags, ...extraTags ];
    if (typeof signer.signer !== 'function') {
      throw new Error("Signer must be a function");
    }
    const dataItem = new DataItem(await container.getByteLength(), null, this.owner, this.target, await this.nextAnchor(), finalTags, container, signer.signer);

    return dataItem;
  }
}

export class DataItemReader extends SliceableReader {
  private inner: SliceableReader;
  isInitialized: boolean;
  dataLength: number;
  dataOffset: number; 
  headerOffset: number;

  constructor(inner: SliceableReader) {
    super();
    this.inner = inner;
    this.isInitialized = false;
    this.dataLength = 0;
    this.headerOffset = 0;
    this.dataOffset = 0;
  }

  async init() {
    if (this.isInitialized) return;
    this.isInitialized = true;

    await this.inner.init();

    const preHeader = await this.inner.slice(0, 16);

    const magicBytes = await preHeader.slice(0, 8);
    // console.log("preHeader", preHeader);
    // console.log("magicBytes", bufferToString(magicBytes));
    if (bufferToString(magicBytes) !== "arf::~di") throw new Error("Invalid magic bytes: " + bufferToAscii(magicBytes));

    const dataLength = byteArrayToLong(await preHeader.slice(8, 16));
    this.dataLength = dataLength;
    this.dataOffset = 16;

    const headerOffset = this.dataOffset + dataLength;
    this.headerOffset = headerOffset;
    // const header = await this.arpReader.slice(headerOffset, headerOffset + 16);
    // console.log("READER header", header);
  }

  async slice(start: number, end: number): Promise<Uint8Array> {
    if (!this.isInitialized) throw new Error("DataItemReader is not initialized");
    if (start < 0 || end < 0) throw new Error("Invalid start and end");
    if (start > end) throw new Error("Invalid start and end");
    if (start >= this.dataLength || end > this.dataLength) throw new Error("Invalid start and end");
    // console.log('data offset', this.dataOffset);
    // console.log('start', start);
    // console.log('end', end);
    return await this.inner.slice(this.dataOffset + start, this.dataOffset + end);
  }
}

export function reassembleDataItemForArweave(data: Uint8Array): Uint8Array {
  // make sure first 8 bytes are "arf::~di"
  if (bufferToAscii(data.slice(0, 8)) !== "arf::~di") throw new Error("Invalid magic bytes: " + bufferToAscii(data.slice(0, 8)));

  // read next 8 bytes as data length
  const dataLength = byteArrayToLong(data.slice(8, 16));

  // read next dataLength bytes as data
  const dataBytes = data.slice(16, 16 + dataLength);
  
  // and now the header, the rest
  const header = data.slice(16 + dataLength, data.byteLength);

  const result = concatBuffers([
    header,
    dataBytes,
  ]);

  return result;
}