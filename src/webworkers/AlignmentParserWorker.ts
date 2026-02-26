/* eslint-disable no-restricted-globals */
/**
 * AlignmentParserWorker
 * ---------------------
 * High-performance database-style engine for 4GB+ protein alignments.
 */

// ---- types -----------------------------------------------------------------

export interface IWorkerMetadata {
  name: string;
  uuid: string;
  sequenceCount: number;
  maxSequenceLength: number;
  predictedNT: boolean;
  numberDuplicateSequencesInAlignment: number;
  numberRemovedDuplicateSequences: number;
  querySequence: { sequence: string; annotations: Record<string, any> };
  consensus: { sequence: string; annotations: Record<string, any> };
  allRepresentedCharacters: string[];
  allUpperAlphaLettersInAlignmentSorted: string[];
  positionalLetterCounts: [number, { [letter: string]: number }][];
  globalAlphaLetterCounts: { [letter: string]: number };
  annotationFields: Record<string, { key: string; name: string }>;
}

const AF = {
  ID: "@@id",
  ACTUAL_ID: "@@actualId",
  DESCRIPTION: "@@description",
  BEGIN: "@@begin",
  END: "@@end",
  LINK: "@@link",
  REAL_LENGTH: "@@realLength",
  ALIGNED_LENGTH: "@@alignedLength",
  LEFT_GAP_COUNT: "@@leftGapCount",
  INTERNAL_GAP_COUNT: "@@internalGapCount",
  RIGHT_GAP_COUNT: "@@rightGapCount",
} as const;

// ---- Storage Layer ---------------------------------------------------------

interface IStoredSequence {
  sequence: string;
  annotations: Record<string, any>;
}

class SequenceStorage {
  private mode: "ram" | "opfs" = "ram";
  private ramSequences: IStoredSequence[] = [];
  
  private opfsFile: any | null = null;
  private opfsOffsets: BigUint64Array | null = null;
  private opfsLengths: Int32Array | null = null;
  private opfsAnnotations: Record<string, any>[] = [];
  private opfsPtr = 0; // Use number for 4GB (safe up to 9PB)
  private count = 0;
  private capacity = 1000000;

  private writeBuffer = new Uint8Array(8 * 1024 * 1024);
  private writeBufferPtr = 0;

  async initialize(useOpfs: boolean) {
    if (useOpfs && typeof navigator !== "undefined" && navigator.storage && navigator.storage.getDirectory) {
      try {
        const root = await navigator.storage.getDirectory();
        try {
          const names = await (root as any).keys();
          for await (const name of names) {
            if (name.startsWith("alignment_buffer_")) await root.removeEntry(name).catch(()=>{});
          }
        } catch (e) {}
        
        const fileHandle = await root.getFileHandle("alignment_buffer_" + Math.random(), { create: true });
        // @ts-ignore
        this.opfsFile = await fileHandle.createSyncAccessHandle();
        this.opfsOffsets = new BigUint64Array(this.capacity);
        this.opfsLengths = new Int32Array(this.capacity);
        this.mode = "opfs";
      } catch (e) { this.mode = "ram"; }
    } else { this.mode = "ram"; }
  }

  private ensureCapacity() {
    if (this.mode === "opfs" && this.count >= this.capacity) {
      this.capacity *= 2;
      const newOffsets = new BigUint64Array(this.capacity);
      const newLengths = new Int32Array(this.capacity);
      newOffsets.set(this.opfsOffsets!);
      newLengths.set(this.opfsLengths!);
      this.opfsOffsets = newOffsets;
      this.opfsLengths = newLengths;
    }
  }

  add(sequence: string | Uint8Array, annotations: Record<string, any>) {
    if (this.mode === "ram") {
      this.ramSequences.push({ 
        sequence: typeof sequence === "string" ? sequence : new TextDecoder().decode(sequence), 
        annotations 
      });
    } else {
      this.ensureCapacity();
      const bytes = typeof sequence === "string" ? new TextEncoder().encode(sequence) : sequence;
      
      if (this.writeBufferPtr + bytes.length > this.writeBuffer.length) {
        this.flush();
      }

      if (bytes.length > this.writeBuffer.length) {
        // Write large sequence directly
        const at = this.opfsPtr;
        this.opfsFile.write(bytes, { at });
        this.opfsOffsets![this.count] = BigInt(this.opfsPtr);
        this.opfsLengths![this.count] = bytes.length;
        this.opfsPtr += bytes.length;
      } else {
        // Buffer small sequence
        this.writeBuffer.set(bytes, this.writeBufferPtr);
        this.opfsOffsets![this.count] = BigInt(this.opfsPtr + this.writeBufferPtr);
        this.opfsLengths![this.count] = bytes.length;
        this.writeBufferPtr += bytes.length;
      }
      this.opfsAnnotations[this.count] = annotations;
    }
    this.count++;
  }

  flush() {
    if (this.mode === "opfs" && this.writeBufferPtr > 0) {
      try {
        const at = this.opfsPtr;
        this.opfsFile.write(this.writeBuffer.subarray(0, this.writeBufferPtr), { at });
        this.opfsPtr += this.writeBufferPtr;
        this.writeBufferPtr = 0;
        this.opfsFile.flush();
      } catch(e) {
        console.error("OPFS flush failed", e);
      }
    }
  }

  get(index: number): IStoredSequence {
    if (index === undefined || index === null || isNaN(index) || index < 0 || index >= this.count) {
      return { sequence: "", annotations: {} };
    }
    if (this.mode === "ram") return this.ramSequences[index];
    
    const offsetBI = this.opfsOffsets![index];
    const length = this.opfsLengths![index];
    if (length <= 0) return { sequence: "", annotations: this.opfsAnnotations[index] || {} };

    // Check buffer
    const onDiskSize = this.opfsPtr;
    if (offsetBI >= BigInt(onDiskSize)) {
      const rel = Number(offsetBI - BigInt(onDiskSize));
      if (rel + length <= this.writeBufferPtr) {
        return { 
          sequence: new TextDecoder().decode(this.writeBuffer.subarray(rel, rel + length)), 
          annotations: this.opfsAnnotations[index] 
        };
      }
    }

    const buffer = new Uint8Array(length);
    try {
      const at = Number(offsetBI);
      this.opfsFile.read(buffer, { at });
    } catch (e) {
      // Emergency fallback to BigInt if Number fails
      try {
        this.opfsFile.read(buffer, { at: offsetBI });
      } catch (e2) {
        return { sequence: "-".repeat(length), annotations: this.opfsAnnotations[index] || {} };
      }
    }
    return {
      sequence: new TextDecoder().decode(buffer),
      annotations: this.opfsAnnotations[index]
    };
  }

  getAnnotations(index: number): Record<string, any> {
    if (this.mode === "ram") return this.ramSequences[index]?.annotations || {};
    return this.opfsAnnotations[index] || {};
  }

  size() { return this.count; }

  getInternalPointers() {
    return {
      offsets: this.opfsOffsets,
      lengths: this.opfsLengths,
      onDiskSize: this.opfsPtr,
      file: this.opfsFile,
      writeBuffer: this.writeBuffer,
      writeBufferPtr: this.writeBufferPtr
    };
  }

  clear() {
    this.ramSequences = [];
    this.opfsAnnotations = [];
    this.opfsPtr = 0;
    this.count = 0;
    if (this.opfsFile) {
      try { this.opfsFile.close(); } catch (e) {}
      this.opfsFile = null;
    }
  }
}

let _storage = new SequenceStorage();
const _sortedIndicesCache = new Map<string, Int32Array>();
let _currentSort: { key: string, scores: Float32Array, target: Uint8Array, isBlosum: boolean, startIdx: number } | null = null;
let _querySequence: string = "";
let _consensusSequence: string = "";

// ---- sorting logic ---------------------------------------------------------

const BLOSUM62_BYTES = new Int8Array(128 * 128).fill(-128);
(function initializeBlosum() {
  const codes = "ARNDCQEGHILKMFPSTWYVBZX*";
  const scores = [
    [ 4,-1,-2,-2, 0,-1,-1, 0,-2,-1,-1,-1,-1,-2,-1, 1, 0,-3,-2, 0,-2,-1, 0,-4], // A
    [-1, 5, 0,-2,-3, 1, 0,-2, 0,-3,-2, 2,-1,-3,-2,-1,-1,-3,-2,-3,-1, 0,-1,-4], // R
    [-2, 0, 6, 1,-3, 0, 0, 0, 1,-3,-3, 0,-2,-3,-2, 1, 0,-4,-2,-3, 3, 0,-1,-4], // N
    [-2,-2, 1, 6,-3, 0, 2,-1,-1,-3,-4,-1,-3,-3,-1, 0,-1,-4,-3,-3, 4, 1,-1,-4], // D
    [ 0,-3,-3,-3, 9,-3,-4,-3,-3,-1,-1,-3,-1,-2,-3,-1,-1,-2,-2,-1,-3,-3,-2,-4], // C
    [-1, 1, 0, 0,-3, 5, 2,-2, 0,-3,-2, 1, 0,-3,-1, 0,-1,-2,-1,-2, 0, 3,-1,-4], // Q
    [-1, 0, 0, 2,-4, 2, 5,-2, 0,-3,-3, 1,-2,-3,-1, 0,-1,-3,-2,-2, 1, 4,-1,-4], // E
    [ 0,-2, 0,-1,-3,-2,-2, 6,-2,-4,-4,-2,-3,-3,-2, 0,-2,-2,-3,-3,-1,-2,-1,-4], // G
    [-2, 0, 1,-1,-3, 0, 0,-2, 8,-3,-3,-1,-2,-1,-2,-1,-2,-2, 2,-3, 0, 0,-1,-4], // H
    [-1,-3,-3,-3,-1,-3,-3,-4,-3, 4, 2,-3, 1, 0,-3,-2,-1,-3,-1, 3,-3,-3,-1,-4], // I
    [-1,-2,-3,-4,-1,-2,-3,-4,-3, 2, 4,-2, 2, 0,-3,-2,-1,-2,-1, 1,-4,-3,-1,-4], // L
    [-1, 2, 0,-1,-3, 1, 1,-2,-1,-3,-2, 5,-1,-3,-1, 0,-1,-3,-2,-2, 0, 1,-1,-4], // K
    [-1,-1,-2,-3,-1, 0,-2,-3,-2, 1, 2,-1, 5, 0,-2,-1,-1,-1,-1, 1,-3,-1,-1,-4], // M
    [-2,-3,-3,-3,-2,-3,-3,-3,-1, 0, 0,-3, 0, 6,-4,-2,-2, 1, 3,-1,-3,-3,-1,-4], // F
    [-1,-2,-2,-1,-3,-1,-1,-2,-2,-3,-3,-1,-2,-4, 7,-1,-1,-4,-3,-2,-2,-1,-2,-4], // P
    [ 1,-1, 1, 0,-1, 0, 0, 0,-1,-2,-2, 0,-1,-2,-1, 4, 1,-3,-2,-2, 0, 0, 0,-4], // S
    [ 0,-1, 0,-1,-1,-1,-1,-2,-2,-1,-1,-1,-1,-2,-1, 1, 5,-2,-2, 0,-1,-1, 0,-4], // T
    [-3,-3,-4,-4,-2,-2,-3,-2,-2,-3,-2,-3,-1, 1,-4,-3,-2,11, 2,-3,-4,-3,-2,-4], // W
    [-2,-2,-2,-3,-2,-1,-2,-3, 2,-1,-1,-2,-1, 3,-3,-2,-2, 2, 7,-1,-3,-2,-1,-4], // Y
    [ 0,-3,-3,-3,-1,-2,-2,-3,-3, 3, 1,-2, 1,-1,-2,-2, 0,-3,-1, 4,-3,-2,-1,-4], // V
    [-2,-1, 3, 4,-3, 0, 1,-1, 0,-3,-4, 0,-3,-3,-2, 0,-1,-4,-3,-3, 4, 1,-1,-4], // B
    [-1, 0, 0, 1,-3, 3, 4,-2, 0,-3,-3, 1,-1,-3,-1, 0,-1,-3,-2,-2, 1, 4,-1,-4], // Z
    [ 0,-1,-1,-1,-2,-1,-1,-1,-1,-1,-1,-1,-1,-1,-2, 0, 0,-2,-1,-1,-1,-1,-1,-4], // X
    [-4,-4,-4,-4,-4,-4,-4,-4,-4,-4,-4,-4,-4,-4,-4,-4,-4,-4,-4,-4,-4,-4,-4, 1], // *
  ];
  for (let i = 0; i < codes.length; i++) {
    for (let j = 0; j < codes.length; j++) {
      const cI = codes.charCodeAt(i); const cJ = codes.charCodeAt(j);
      BLOSUM62_BYTES[cI * 128 + cJ] = scores[i][j]; 
    }
  }
})();

/**
 * OPTION A: Bit-Packed SIMD-style Comparison Loops
 * Uses 32-bit word XORing to compare 4 characters at once.
 */
function runSortStep() {
  if (!_currentSort) return;
  const count = _storage.size();
  const endIdx = Math.min(_currentSort.startIdx + 200000, count);
  const target = _currentSort.target; const targetLen = target.length;
  const scores = _currentSort.scores;
  const { offsets, lengths, onDiskSize, file, writeBuffer, writeBufferPtr } = _storage.getInternalPointers();
  const chunkBuffer = new Uint8Array(32 * 1024 * 1024);
  const targetShifts = new Int32Array(targetLen);
  for(let k=0; k<targetLen; k++) targetShifts[k] = target[k] << 7;
  let cStart = -1, cEnd = -1;

  for (let i = _currentSort.startIdx; i < endIdx; i++) {
    const offBI = offsets![i], len = lengths![i];
    if (len <= 0) continue;
    
    let seq: Uint8Array;
    if (offBI >= BigInt(onDiskSize)) {
      // In RAM buffer
      const rel = Number(offBI - BigInt(onDiskSize));
      seq = writeBuffer.subarray(rel, rel + len);
    } else {
      // In File
      const off = Number(offBI);
      if (off < cStart || off + len > cEnd) {
        cStart = off; 
        const toRead = Math.min(32*1024*1024, onDiskSize - off);
        if (toRead <= 0) {
          seq = new Uint8Array(len);
        } else {
          try {
            file.read(chunkBuffer.subarray(0, toRead), { at: off });
            cEnd = off + toRead;
          } catch (e) {
            scores[i] = 999999;
            continue;
          }
        }
      }
      const rel = off - cStart;
      seq = chunkBuffer.subarray(rel, rel + len);
    }
    
    if (_currentSort.isBlosum) {
      let s = 0; const min = Math.min(len, targetLen);
      for (let k = 0; k < min; k++) { 
        const a = seq[k]; 
        const b = target[k];
        if (a < 128 && b < 128) {
          const score = BLOSUM62_BYTES[b * 128 + a];
          if (score !== -128) s += score;
        }
      }
      scores[i] = s;
    } else {
      // Bit-Packed Hamming optimization
      let d = Math.abs(len - targetLen); const min = Math.min(len, targetLen);
      
      let isUnaligned = (seq.byteOffset % 4 !== 0 || target.byteOffset % 4 !== 0);
      
      if (!isUnaligned) {
        const minAligned = min & ~3;
        const s32 = new Uint32Array(seq.buffer, seq.byteOffset, minAligned >> 2);
        const t32 = new Uint32Array(target.buffer, target.byteOffset, minAligned >> 2);
        for (let k = 0; k < s32.length; k++) {
          const x = s32[k] ^ t32[k];
          if (x !== 0) { 
            // Case-sensitive exact match check
            if (x & 0xFF) d++; 
            if (x & 0xFF00) d++; 
            if (x & 0xFF0000) d++; 
            if (x & 0xFF000000) d++; 
          }
        }
        for (let k = minAligned; k < min; k++) {
          if (seq[k] !== target[k]) d++;
        }
      } else {
        // Fallback for unaligned memory
        for (let k = 0; k < min; k++) {
          if (seq[k] !== target[k]) d++;
        }
      }
      scores[i] = d;
    }
  }

  _currentSort.startIdx = endIdx;
  self.postMessage({ type: "sortUpdate", sortKey: _currentSort.key, progress: endIdx / count, complete: endIdx === count });
  
  if (endIdx === count) {
    const packed = new BigUint64Array(count);
    const offset = _currentSort.isBlosum ? 1000000 : 0;
    for (let i = 0; i < count; i++) {
      packed[i] = (BigInt(_currentSort.isBlosum ? offset - Math.round(scores[i]) : Math.round(scores[i])) << BigInt(32)) | BigInt(i);
    }
    packed.sort();
    const res = new Int32Array(count);
    for (let i = 0; i < count; i++) res[i] = Number(packed[i] & BigInt(0xFFFFFFFF));
    _sortedIndicesCache.set(_currentSort.key, res);
    _currentSort = null;
  } else {
    setTimeout(runSortStep, 0);
  }
}

function generateUUID(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function formatFieldName(field: string): string {
  if (field.startsWith("@@")) return field.slice(2);
  return field;
}

function parseSeqAnnotations(id: string, sequence: string, description?: string): Record<string, any> {
  const annotations: Record<string, any> = {
    [AF.ID]: id,
    [AF.ACTUAL_ID]: id,
    [AF.DESCRIPTION]: description ?? "",
    [AF.REAL_LENGTH]: sequence.replace(/[-.]/g, "").length,
    [AF.ALIGNED_LENGTH]: sequence.length,
  };
  let left = 0, right = 0, internal = 0;
  let i = 0;
  while (i < sequence.length && (sequence[i] === "-" || sequence[i] === ".")) { left++; i++; }
  let j = sequence.length - 1;
  while (j >= i && (sequence[j] === "-" || sequence[j] === ".")) { right++; j--; }
  for (let k = i; k <= j; k++) {
    if (sequence[k] === "-" || sequence[k] === ".") internal++;
  }
  annotations[AF.LEFT_GAP_COUNT] = left;
  annotations[AF.RIGHT_GAP_COUNT] = right;
  annotations[AF.INTERNAL_GAP_COUNT] = internal;
  return annotations;
}

async function* streamToLines(stream: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let leftover = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      if (leftover.length > 0) yield leftover;
      break;
    }
    leftover += value;
    const lines = leftover.split("\n");
    leftover = lines.pop()!;
    for (const line of lines) yield line;
  }
}

function postProgress(message: string) {
  self.postMessage({ type: "progress", message });
}

// ---- incremental analysis --------------------------------------------------

function buildQuickMetadata(
  fileName: string,
  removeDuplicateSequences: boolean,
  partialStats?: {
    positionalLetterCounts: [number, Record<string, number>][];
    globalAlphaLetterCounts: Record<string, number>;
    consensus: { sequence: string; annotations: Record<string, any> };
  } | null
): IWorkerMetadata {
  const query = _storage.get(0);
  const maxLen = query.sequence.length;
  
  const allUniqueCharCodes: Record<number, boolean> = {};
  const limit = Math.min(_storage.size(), 1000);
  for (let i = 0; i < limit; i++) {
    const s = _storage.get(i).sequence;
    for (let j = 0; j < s.length; j++) allUniqueCharCodes[s.charCodeAt(j)] = true;
  }
  const allUniqueChars = Object.keys(allUniqueCharCodes).map(cc => String.fromCharCode(Number(cc)));
  const NT_CODES = new Set("ATGCUNRYSWKMBDHVatgcunryswkmbdhv-.");
  const predictedNT = allUniqueChars.every(c => NT_CODES.has(c));
  const allUpperAlpha = allUniqueChars.filter(c => /[A-Z]/.test(c)).sort();

  const annotationFields: Record<string, { key: string; name: string }> = {};
  for (const field of Object.keys(query.annotations)) {
    annotationFields[field] = { key: field, name: formatFieldName(field) };
  }

  return {
    name: fileName,
    uuid: generateUUID(),
    sequenceCount: _storage.size(),
    maxSequenceLength: maxLen,
    predictedNT,
    numberDuplicateSequencesInAlignment: 0,
    numberRemovedDuplicateSequences: 0,
    querySequence: query,
    consensus: partialStats?.consensus ?? {
      annotations: { [AF.ID]: "consensus", [AF.ACTUAL_ID]: "consensus" },
      sequence: query.sequence,
    },
    allRepresentedCharacters: allUniqueChars,
    allUpperAlphaLettersInAlignmentSorted: allUpperAlpha,
    positionalLetterCounts: partialStats?.positionalLetterCounts ?? [],
    globalAlphaLetterCounts: partialStats?.globalAlphaLetterCounts ?? {},
    annotationFields,
  };
}

// ---- Worker entry point ----------------------------------------------------

self.onmessage = async (event) => {
  try {
    const msg = event.data;

    if (msg.type === "getSlice") {
      const { start, end, requestId, sortKey = "as-input" } = msg;
      const currentSize = _storage.size();

      // Trigger sort if needed
      if (sortKey !== "as-input" && !_sortedIndicesCache.has(sortKey) && (!_currentSort || _currentSort.key !== sortKey)) {
        if (sortKey === "id" || sortKey === "gaps") {
          const res = new Int32Array(currentSize); for(let i=0; i<currentSize; i++) res[i]=i;
          if (sortKey === "gaps") {
            const packed = new BigUint64Array(currentSize);
            for (let i = 0; i < currentSize; i++) packed[i] = (BigInt(_storage.getAnnotations(i)[AF.INTERNAL_GAP_COUNT] || 0) << BigInt(32)) | BigInt(i);
            packed.sort(); for (let i = 0; i < currentSize; i++) res[i] = Number(packed[i] & BigInt(0xFFFFFFFF));
          } else { 
            res.sort((a,b) => {
              const valA = _storage.getAnnotations(a)[AF.ID] || "";
              const valB = _storage.getAnnotations(b)[AF.ID] || "";
              return valA < valB ? -1 : (valA > valB ? 1 : 0);
            }); 
          }
          _sortedIndicesCache.set(sortKey, res);
          self.postMessage({ type: "sortUpdate", sortKey, progress: 1, complete: true });
        } else {
          _currentSort = { 
            key: sortKey, 
            scores: new Float32Array(currentSize), 
            target: new TextEncoder().encode(sortKey.includes("query") ? _querySequence : _consensusSequence), 
            isBlosum: sortKey.startsWith("blosum"), 
            startIdx: 0 
          };
          setTimeout(runSortStep, 0);
        }
      }

      const indices = _sortedIndicesCache.get(sortKey);
      const sequences: string[] = [], annotations: any[] = [];
      const clampedEnd = Math.min(end, currentSize);
      for (let i = start; i < clampedEnd; i++) {
        const idx = (indices && i < indices.length) ? indices[i] : i;
        const s = _storage.get(idx);
        sequences.push(s.sequence); annotations.push(s.annotations);
      }
      self.postMessage({ type: "slice", requestId, sequences, annotations });
      return;
    }

    if (msg.type !== "parse") return;

    const { file, url, alignmentName, removeDuplicateSequences } = msg;
    _storage.clear();
    _sortedIndicesCache.clear();
    _currentSort = null;

    await _storage.initialize(true);

    let stream: ReadableStream<Uint8Array>;
    let fileName = alignmentName || (file ? file.name : "alignment");

    if (file) {
      postProgress("Reading file…");
      stream = file.stream();
    } else if (url) {
      postProgress("Connecting…");
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`Server returned ${resp.status}`);
      stream = resp.body!;
    } else throw new Error("No file or URL provided");

    const lineIter = streamToLines(stream);
    const iter = lineIter[Symbol.asyncIterator]();

    let firstLine = "";
    let firstResult: IteratorResult<string> = { value: "", done: true };
    while (true) {
      firstResult = await iter.next();
      if (firstResult.done) break;
      const t = firstResult.value.replace(/\r$/, "").trim();
      if (t) { firstLine = t; break; }
    }
    if (!firstLine) throw Object.assign(new Error("Empty file"), { name: "File Error" });

    async function* prepended(): AsyncIterable<string> {
      yield firstResult.value;
      while (true) {
        const r = await iter.next();
        if (r.done) break;
        yield r.value;
      }
    }

    let firstBatchSent = false;
    let currentMaxLen = 0;
    let runningFlatCounts: Float64Array | null = null;
    let runningGlobalCounts: Float64Array | null = null;
    const charCodeToIdx = new Map<number, number>();
    const idxToChar: string[] = [];
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz.-".split("").forEach(c => {
      charCodeToIdx.set(c.charCodeAt(0), idxToChar.length);
      idxToChar.push(c);
    });

    const getPartialStats = () => {
      if (!runningFlatCounts || !runningGlobalCounts) return null;
      const numChars = idxToChar.length;
      const positionalLetterCounts: [number, Record<string, number>][] = [];
      for (let pi = 0; pi < currentMaxLen; pi++) {
        const lc: Record<string, number> = {};
        for (let ci = 0; ci < numChars; ci++) {
          const count = runningFlatCounts[pi * numChars + ci];
          if (count > 0) lc[idxToChar[ci]] = count;
        }
        positionalLetterCounts.push([pi, lc]);
      }
      const globalAlphaLetterCounts: Record<string, number> = {};
      for (let ci = 0; ci < numChars; ci++) {
        if (runningGlobalCounts[ci] > 0) globalAlphaLetterCounts[idxToChar[ci]] = runningGlobalCounts[ci];
      }
      const consensusSeq = positionalLetterCounts.map(([, letterCounts]) => {
        return Object.entries(letterCounts)
          .sort((letterA, letterB) => {
            const aIsLowerAlpha = letterA[0].match(/[a-z]/) ? true : false;
            const aIsUpperAlpha = letterA[0].match(/[A-Z]/) ? true : false;
            const bIsLowerAlpha = letterB[0].match(/[a-z]/) ? true : false;
            const bIsUpperAlpha = letterB[0].match(/[A-Z]/) ? true : false;

            if (
              aIsLowerAlpha === bIsLowerAlpha &&
              aIsUpperAlpha === bIsUpperAlpha
            ) {
              return letterB[1] - letterA[1];
            }

            return aIsUpperAlpha
              ? -1
              : bIsUpperAlpha
              ? 1
              : aIsLowerAlpha
              ? -1
              : bIsLowerAlpha
              ? 1
              : 0;
          })
          .map((letter) => letter[0])[0];
      }).join("");
      return { positionalLetterCounts, globalAlphaLetterCounts, consensus: { annotations: {}, sequence: consensusSeq } };
    };

    const checkUpdates = () => {
      if (!firstBatchSent && _storage.size() >= 100) {
        firstBatchSent = true;
        const stats = getPartialStats();
        self.postMessage({ type: "done", data: buildQuickMetadata(fileName, removeDuplicateSequences, stats) });
      } else if (firstBatchSent && _storage.size() % 1000 === 0) {
        const stats = getPartialStats();
        self.postMessage({ type: "stats", data: { ...stats, sequenceCount: _storage.size() } });
      }
    };

    if (firstLine.startsWith(">")) {
      let currentHeader: string | null = null;
      let currentParts: string[] = [];
      const flush = () => {
        if (!currentHeader) return;
        const sequence = currentParts.join("");
        if (currentMaxLen === 0) {
          currentMaxLen = sequence.length;
          runningFlatCounts = new Float64Array(currentMaxLen * idxToChar.length);
          runningGlobalCounts = new Float64Array(idxToChar.length);
        }
        const numChars = idxToChar.length;
        for (let pi = 0; pi < Math.min(sequence.length, currentMaxLen); pi++) {
          const ci = charCodeToIdx.get(sequence.charCodeAt(pi));
          if (ci !== undefined) { runningFlatCounts![pi * numChars + ci]++; runningGlobalCounts![ci]++; }
        }
        _storage.add(sequence, parseSeqAnnotations(currentHeader.split(/\s+/)[0], sequence));
        checkUpdates();
        currentParts = [];
      };
      for await (const rawLine of prepended()) {
        const line = rawLine.replace(/\r$/, "");
        if (line.startsWith(">")) { flush(); currentHeader = line.slice(1); }
        else if (currentHeader) currentParts.push(line.trim());
      }
      flush();
    } else {
      throw new Error("Only FASTA supported for disk-streaming mode currently.");
    }

    _storage.flush();
    const finalStats = getPartialStats();
    _querySequence = _storage.get(0).sequence;
    _consensusSequence = finalStats?.consensus.sequence ?? _querySequence;

    // Clear consensus-dependent sorts so they re-trigger with final consensus if requested
    _sortedIndicesCache.delete("hamming-dist-to-consensus");
    _sortedIndicesCache.delete("blosum-score-to-consensus");

    self.postMessage({ type: "done", data: { ...buildQuickMetadata(fileName, removeDuplicateSequences, finalStats), isComplete: true } });

  } catch (e: any) {
    self.postMessage({
      type: "error",
      name: (e.name ?? "Error"),
      message: e.message || String(e),
    });
  }
};
