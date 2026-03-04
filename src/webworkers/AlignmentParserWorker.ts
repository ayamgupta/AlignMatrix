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

/**
 * Safely converts a number to a BigInt, handling NaN and Infinity.
 */
function toBI(val: any): bigint {
if (typeof val === "bigint") return val;
if (val === undefined || val === null || isNaN(val) || !isFinite(val))
  return 0n;
return BigInt(Math.floor(val));
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
private opfsAnnotationFile: any | null = null;
private opfsOffsets: BigUint64Array | null = null;
private opfsLengths: Int32Array | null = null;
private opfsAnnotationOffsets: BigUint64Array | null = null;
private opfsAnnotationLengths: Int32Array | null = null;
private opfsPtr = 0; // Use number for 4GB (safe up to 9PB)
private opfsAnnotationPtr = 0;
private count = 0;
private capacity = 1000000;

private writeBuffer = new Uint8Array(8 * 1024 * 1024);
private writeBufferPtr = 0;
private writeAnnotationBuffer = new Uint8Array(2 * 1024 * 1024);
private writeAnnotationBufferPtr = 0;

async initialize(useOpfs: boolean) {
  if (
    useOpfs &&
    typeof navigator !== "undefined" &&
    navigator.storage &&
    navigator.storage.getDirectory
  ) {
    try {
      const root = await navigator.storage.getDirectory();
      try {
        const names = await (root as any).keys();
        for await (const name of names) {
          if (
            name.startsWith("alignment_buffer_") ||
            name.startsWith("alignment_anno_")
          )
            await root.removeEntry(name).catch(() => {});
        }
      } catch (e) {}

      const suffix = Math.random().toString(36).substring(2);
      const fileHandle = await root.getFileHandle("alignment_buffer_" + suffix, {
        create: true,
      });
      const annoHandle = await root.getFileHandle("alignment_anno_" + suffix, {
        create: true,
      });

      // @ts-ignore
      this.opfsFile = await fileHandle.createSyncAccessHandle();
      // @ts-ignore
      this.opfsAnnotationFile = await annoHandle.createSyncAccessHandle();

      this.opfsOffsets = new BigUint64Array(this.capacity);
      this.opfsLengths = new Int32Array(this.capacity);
      this.opfsAnnotationOffsets = new BigUint64Array(this.capacity);
      this.opfsAnnotationLengths = new Int32Array(this.capacity);
      this.mode = "opfs";
    } catch (e) {
      console.warn("OPFS initialization failed, falling back to RAM", e);
      this.mode = "ram";
    }
  } else {
    this.mode = "ram";
  }
}

private ensureCapacity() {
  if (this.mode === "opfs" && this.count >= this.capacity) {
    const newCapacity = this.capacity * 2;
    const newOffsets = new BigUint64Array(newCapacity);
    const newLengths = new Int32Array(newCapacity);
    const newAnnoOffsets = new BigUint64Array(newCapacity);
    const newAnnoLengths = new Int32Array(newCapacity);

    newOffsets.set(this.opfsOffsets!);
    newLengths.set(this.opfsLengths!);
    newAnnoOffsets.set(this.opfsAnnotationOffsets!);
    newAnnoLengths.set(this.opfsAnnotationLengths!);

    this.opfsOffsets = newOffsets;
    this.opfsLengths = newLengths;
    this.opfsAnnotationOffsets = newAnnoOffsets;
    this.opfsAnnotationLengths = newAnnoLengths;
    this.capacity = newCapacity;
  }
}

add(sequence: string | Uint8Array, annotations: Record<string, any>) {
  if (this.mode === "ram") {
    this.ramSequences.push({
      sequence:
        typeof sequence === "string"
          ? sequence
          : new TextDecoder().decode(sequence),
      annotations,
    });
  } else {
    this.ensureCapacity();

    // Handle sequence
    const bytes =
      typeof sequence === "string"
        ? new TextEncoder().encode(sequence)
        : sequence;

    if (this.writeBufferPtr + bytes.length > this.writeBuffer.length) {
      this.flush();
    }

    if (bytes.length > this.writeBuffer.length) {
      const at = this.opfsPtr;
      this.opfsFile.write(bytes, { at });
      this.opfsOffsets![this.count] = toBI(this.opfsPtr);
      this.opfsLengths![this.count] = bytes.length;
      this.opfsPtr += bytes.length;
    } else {
      this.writeBuffer.set(bytes, this.writeBufferPtr);
      this.opfsOffsets![this.count] = toBI(
        this.opfsPtr + this.writeBufferPtr,
      );
      this.opfsLengths![this.count] = bytes.length;
      this.writeBufferPtr += bytes.length;
    }

    // Handle annotations
    const annoBytes = new TextEncoder().encode(JSON.stringify(annotations));
    if (
      this.writeAnnotationBufferPtr + annoBytes.length >
      this.writeAnnotationBuffer.length
    ) {
      this.flush();
    }

    if (annoBytes.length > this.writeAnnotationBuffer.length) {
      const at = this.opfsAnnotationPtr;
      this.opfsAnnotationFile.write(annoBytes, { at });
      this.opfsAnnotationOffsets![this.count] = toBI(
        this.opfsAnnotationPtr,
      );
      this.opfsAnnotationLengths![this.count] = annoBytes.length;
      this.opfsAnnotationPtr += annoBytes.length;
    } else {
      this.writeAnnotationBuffer.set(annoBytes, this.writeAnnotationBufferPtr);
      this.opfsAnnotationOffsets![this.count] = toBI(
        this.opfsAnnotationPtr + this.writeAnnotationBufferPtr,
      );
      this.opfsAnnotationLengths![this.count] = annoBytes.length;
      this.writeAnnotationBufferPtr += annoBytes.length;
    }
  }
  this.count++;
}

flush() {
  if (this.mode === "opfs") {
    if (this.writeBufferPtr > 0) {
      try {
        const at = this.opfsPtr;
        this.opfsFile.write(
          this.writeBuffer.subarray(0, this.writeBufferPtr),
          {
            at,
          },
        );
        this.opfsPtr += this.writeBufferPtr;
        this.writeBufferPtr = 0;
        this.opfsFile.flush();
      } catch (e) {
        console.error("OPFS sequence flush failed", e);
      }
    }
    if (this.writeAnnotationBufferPtr > 0) {
      try {
        const at = this.opfsAnnotationPtr;
        this.opfsAnnotationFile.write(
          this.writeAnnotationBuffer.subarray(
            0,
            this.writeAnnotationBufferPtr,
          ),
          { at },
        );
        this.opfsAnnotationPtr += this.writeAnnotationBufferPtr;
        this.writeAnnotationBufferPtr = 0;
        this.opfsAnnotationFile.flush();
      } catch (e) {
        console.error("OPFS annotation flush failed", e);
      }
    }
  }
}

get(index: number): IStoredSequence {
  if (
    index === undefined ||
    index === null ||
    isNaN(index) ||
    index < 0 ||
    index >= this.count
  ) {
    return { sequence: "", annotations: {} };
  }
  if (this.mode === "ram") return this.ramSequences[index];

  const annotations = this.getAnnotations(index);
  const offsetBI = this.opfsOffsets![index];
  const length = this.opfsLengths![index];
  if (length <= 0) return { sequence: "", annotations };

  // Check write buffer
  const onDiskSize = this.opfsPtr;
  if (!isNaN(onDiskSize) && offsetBI >= toBI(onDiskSize)) {
    const rel = Number(offsetBI - toBI(onDiskSize));
    if (rel + length <= this.writeBufferPtr) {
      return {
        sequence: new TextDecoder().decode(
          this.writeBuffer.subarray(rel, rel + length),
        ),
        annotations,
      };
    }
  }

  const buffer = new Uint8Array(length);
  try {
    const at = Number(offsetBI);
    this.opfsFile.read(buffer, { at });
  } catch (e) {
    try {
      this.opfsFile.read(buffer, { at: offsetBI });
    } catch (e2) {
      return { sequence: "-".repeat(length), annotations };
    }
  }
  return {
    sequence: new TextDecoder().decode(buffer),
    annotations,
  };
}

getAnnotations(index: number): Record<string, any> {
  if (
    index === undefined ||
    index === null ||
    isNaN(index) ||
    index < 0 ||
    index >= this.count
  ) {
    return {};
  }
  if (this.mode === "ram") return this.ramSequences[index]?.annotations || {};

  const offsetBI = this.opfsAnnotationOffsets![index];
  const length = this.opfsAnnotationLengths![index];
  if (length <= 0) return {};

  // Check write buffer
  const onDiskSize = this.opfsAnnotationPtr;
  if (
    !isNaN(onDiskSize) &&
    offsetBI >= toBI(onDiskSize)
  ) {
    const rel = Number(offsetBI - toBI(onDiskSize));
    if (rel + length <= this.writeAnnotationBufferPtr) {
      try {
        return JSON.parse(
          new TextDecoder().decode(
            this.writeAnnotationBuffer.subarray(rel, rel + length),
          ),
        );
      } catch (e) {
        return {};
      }
    }
  }

  const buffer = new Uint8Array(length);
  try {
    const at = Number(offsetBI);
    this.opfsAnnotationFile.read(buffer, { at });
    return JSON.parse(new TextDecoder().decode(buffer));
  } catch (e) {
    try {
      this.opfsAnnotationFile.read(buffer, { at: offsetBI });
      return JSON.parse(new TextDecoder().decode(buffer));
    } catch (e2) {
      return {};
    }
  }
}

  getAnnotationsBatch(start: number, count: number): Record<string, any>[] {
    if (this.mode === "ram") {
      return this.ramSequences
        .slice(start, start + count)
        .map((s) => s.annotations || {});
    }
    const limit = Math.min(start + count, this.count);
    const actualCount = limit - start;
    if (actualCount <= 0) return [];

    const results = new Array(actualCount);
    const startOffset = this.opfsAnnotationOffsets![start];
    const lastIdx = limit - 1;
    const endOffset =
      this.opfsAnnotationOffsets![lastIdx] +
      BigInt(this.opfsAnnotationLengths![lastIdx]);
    const totalBytes = Number(endOffset - startOffset);

    if (totalBytes <= 0) return results.fill({});

    // If the entire batch is in the write buffer, handle it separately
    const onDiskSize = this.opfsAnnotationPtr;
    if (!isNaN(onDiskSize) && startOffset >= toBI(onDiskSize)) {
      const rel = Number(startOffset - toBI(onDiskSize));
      if (rel + totalBytes <= this.writeAnnotationBufferPtr) {
        const batchBuffer = this.writeAnnotationBuffer.subarray(
          rel,
          rel + totalBytes,
        );
        let ptr = 0;
        const decoder = new TextDecoder();
        for (let i = 0; i < actualCount; i++) {
          const len = this.opfsAnnotationLengths![start + i];
          try {
            results[i] = JSON.parse(
              decoder.decode(batchBuffer.subarray(ptr, ptr + len)),
            );
          } catch (e) {
            results[i] = {};
          }
          ptr += len;
        }
        return results;
      }
    }

    const batchBuffer = new Uint8Array(totalBytes);
    try {
      this.opfsAnnotationFile.read(batchBuffer, { at: Number(startOffset) });
    } catch (e) {
      try {
        this.opfsAnnotationFile.read(batchBuffer, { at: startOffset });
      } catch (e2) {
        return results.fill({});
      }
    }

    let ptr = 0;
    const decoder = new TextDecoder();
    for (let i = 0; i < actualCount; i++) {
      const len = this.opfsAnnotationLengths![start + i];
      try {
        results[i] = JSON.parse(
          decoder.decode(batchBuffer.subarray(ptr, ptr + len)),
        );
      } catch (e) {
        results[i] = {};
      }
      ptr += len;
    }
    return results;
  }

  size() {  return this.count;
}

getInternalPointers() {
  return {
    offsets: this.opfsOffsets,
    lengths: this.opfsLengths,
    onDiskSize: this.opfsPtr,
    file: this.opfsFile,
    writeBuffer: this.writeBuffer,
    writeBufferPtr: this.writeBufferPtr,
  };
}

clear() {
  this.ramSequences = [];
  this.opfsPtr = 0;
  this.opfsAnnotationPtr = 0;
  this.count = 0;
  if (this.opfsFile) {
    try {
      this.opfsFile.close();
    } catch (e) {}
    this.opfsFile = null;
  }
  if (this.opfsAnnotationFile) {
    try {
      this.opfsAnnotationFile.close();
    } catch (e) {}
    this.opfsAnnotationFile = null;
  }
  }
}

  let _storage = new SequenceStorage();
  const _sortedIndicesCache = new Map<string, Int32Array>();
  const _sequenceSliceCache = new Map<string, { sequences: string[]; annotations: any[] }>();
  let _currentSort: {  key: string;
  scores: Float32Array;
  target: Uint8Array;
  isBlosum: boolean;
  startIdx: number;
  tempData?: any[] | null;
  } | null = null;
  let _querySequence: string = "";
  let _consensusSequence: string = "";
// ---- Sparse Mode -----------------------------------------------------------
let _sparseMode = false;
let _sparseUrl = "";
let _sparseContentLength = 0;
let _sparseAvgBytesPerSeq = 300;
let _sparseEstimatedSequenceCount = 0;

async function fetchSparseChunk(
url: string,
startByte: number,
endByte: number,
): Promise<string> {
const resp = await fetch(url, {
  headers: { Range: `bytes=${startByte}-${endByte}` },
});
return resp.text();
}

async function parseSparseChunkText(
text: string,
isLastChunk: boolean,
): Promise<{ sequences: string[]; annotations: any[] }> {
const firstGt = text.indexOf(">");
if (firstGt === -1) return { sequences: [], annotations: [] };

const validText = text.substring(firstGt);
const lines = validText.split("\n");

const sequences: string[] = [];
const annotations: any[] = [];

let currentHeader: string | null = null;
let currentParts: string[] = [];

const flush = () => {
  if (!currentHeader) return;
  const sequence = currentParts.join("");
  sequences.push(sequence);
  if (!_querySequence) {
    _querySequence = sequence;
    _consensusSequence = sequence;
  }
  annotations.push(
    parseSeqAnnotations(currentHeader.split(/\s+/)[0], sequence),
  );
  currentParts = [];
};
// Process all lines except the last one which might be truncated
for (let i = 0; i < lines.length - 1; i++) {
  const line = lines[i].replace(/\r$/, "");
  if (line.startsWith(">")) {
    flush();
    currentHeader = line.slice(1);
  } else if (currentHeader) {
    currentParts.push(line.trim());
  }
}

if (isLastChunk) {
  const line = lines[lines.length - 1].replace(/\r$/, "");
  if (line.startsWith(">")) {
    flush();
    currentHeader = line.slice(1);
  } else if (currentHeader && line) {
    currentParts.push(line.trim());
  }
  flush();
}

return { sequences, annotations };
}

// ---- sorting logic ---------------------------------------------------------

const UPPERCASE_MAP = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  const c = String.fromCharCode(i);
  UPPERCASE_MAP[i] = (c >= "a" && c <= "z" ? c.toUpperCase() : c).charCodeAt(0);
}

const BLOSUM62_BYTES = new Int8Array(128 * 128).fill(-128);
(function initializeBlosum() {
const codes = "ARNDCQEGHILKMFPSTWYVBZX*";
const scores = [
  [
    4, -1, -2, -2, 0, -1, -1, 0, -2, -1, -1, -1, -1, -2, -1, 1, 0, -3, -2, 0,
    -2, -1, 0, -4,
  ], // A
  [
    -1, 5, 0, -2, -3, 1, 0, -2, 0, -3, -2, 2, -1, -3, -2, -1, -1, -3, -2, -3,
    -1, 0, -1, -4,
  ], // R
  [
    -2, 0, 6, 1, -3, 0, 0, 0, 1, -3, -3, 0, -2, -3, -2, 1, 0, -4, -2, -3, 3,
    0, -1, -4,
  ], // N
  [
    -2, -2, 1, 6, -3, 0, 2, -1, -1, -3, -4, -1, -3, -3, -1, 0, -1, -4, -3, -3,
    4, 1, -1, -4,
  ], // D
  [
    0, -3, -3, -3, 9, -3, -4, -3, -3, -1, -1, -3, -1, -2, -3, -1, -1, -2, -2,
    -1, -3, -3, -2, -4,
  ], // C
  [
    -1, 1, 0, 0, -3, 5, 2, -2, 0, -3, -2, 1, 0, -3, -1, 0, -1, -2, -1, -2, 0,
    3, -1, -4,
  ], // Q
  [
    -1, 0, 0, 2, -4, 2, 5, -2, 0, -3, -3, 1, -2, -3, -1, 0, -1, -3, -2, -2, 1,
    4, -1, -4,
  ], // E
  [
    0, -2, 0, -1, -3, -2, -2, 6, -2, -4, -4, -2, -3, -3, -2, 0, -2, -2, -3,
    -3, -1, -2, -1, -4,
  ], // G
  [
    -2, 0, 1, -1, -3, 0, 0, -2, 8, -3, -3, -1, -2, -1, -2, -1, -2, -2, 2, -3,
    0, 0, -1, -4,
  ], // H
  [
    -1, -3, -3, -3, -1, -3, -3, -4, -3, 4, 2, -3, 1, 0, -3, -2, -1, -3, -1, 3,
    -3, -3, -1, -4,
  ], // I
  [
    -1, -2, -3, -4, -1, -2, -3, -4, -3, 2, 4, -2, 2, 0, -3, -2, -1, -2, -1, 1,
    -4, -3, -1, -4,
  ], // L
  [
    -1, 2, 0, -1, -3, 1, 1, -2, -1, -3, -2, 5, -1, -3, -1, 0, -1, -3, -2, -2,
    0, 1, -1, -4,
  ], // K
  [
    -1, -1, -2, -3, -1, 0, -2, -3, -2, 1, 2, -1, 5, 0, -2, -1, -1, -1, -1, 1,
    -3, -1, -1, -4,
  ], // M
  [
    -2, -3, -3, -3, -2, -3, -3, -3, -1, 0, 0, -3, 0, 6, -4, -2, -2, 1, 3, -1,
    -3, -3, -1, -4,
  ], // F
  [
    -1, -2, -2, -1, -3, -1, -1, -2, -2, -3, -3, -1, -2, -4, 7, -1, -1, -4, -3,
    -2, -2, -1, -2, -4,
  ], // P
  [
    1, -1, 1, 0, -1, 0, 0, 0, -1, -2, -2, 0, -1, -2, -1, 4, 1, -3, -2, -2, 0,
    0, 0, -4,
  ], // S
  [
    0, -1, 0, -1, -1, -1, -1, -2, -2, -1, -1, -1, -1, -2, -1, 1, 5, -2, -2, 0,
    -1, -1, 0, -4,
  ], // T
  [
    -3, -3, -4, -4, -2, -2, -3, -2, -2, -3, -2, -3, -1, 1, -4, -3, -2, 11, 2,
    -3, -4, -3, -2, -4,
  ], // W
  [
    -2, -2, -2, -3, -2, -1, -2, -3, 2, -1, -1, -2, -1, 3, -3, -2, -2, 2, 7,
    -1, -3, -2, -1, -4,
  ], // Y
  [
    0, -3, -3, -3, -1, -2, -2, -3, -3, 3, 1, -2, 1, -1, -2, -2, 0, -3, -1, 4,
    -3, -2, -1, -4,
  ], // V
  [
    -2, -1, 3, 4, -3, 0, 1, -1, 0, -3, -4, 0, -3, -3, -2, 0, -1, -4, -3, -3,
    4, 1, -1, -4,
  ], // B
  [
    -1, 0, 0, 1, -3, 3, 4, -2, 0, -3, -3, 1, -1, -3, -1, 0, -1, -3, -2, -2, 1,
    4, -1, -4,
  ], // Z
  [
    0, -1, -1, -1, -2, -1, -1, -1, -1, -1, -1, -1, -1, -1, -2, 0, 0, -2, -1,
    -1, -1, -1, -1, -4,
  ], // X
  [
    -4, -4, -4, -4, -4, -4, -4, -4, -4, -4, -4, -4, -4, -4, -4, -4, -4, -4,
    -4, -4, -4, -4, -4, 1,
  ], // *
];
for (let i = 0; i < codes.length; i++) {
  for (let j = 0; j < codes.length; j++) {
    const cI = codes.charCodeAt(i);
    const cJ = codes.charCodeAt(j);
    BLOSUM62_BYTES[cI * 128 + cJ] = scores[i][j];
  }
}
})();

/**
 * Simple sorts (ID, Gaps) that don't need heavy sequence comparison.
 */
async function runSimpleSortStep(currentKey: string) {
  if (!_currentSort || _currentSort.key !== currentKey) return;

  const count = _storage.size();
  const chunkSize = 50000;
  const endIdx = Math.min(_currentSort.startIdx + chunkSize, count);
  
  if (!_currentSort.tempData) {
    _currentSort.tempData = currentKey === "id" ? new Array(count) : null;
  }

  if (currentKey === "gaps") {
    const scores = _currentSort.scores;
    const batch = _storage.getAnnotationsBatch(_currentSort.startIdx, chunkSize);
    for (let i = 0; i < batch.length; i++) {
      if (!_currentSort || _currentSort.key !== currentKey) return;
      scores[_currentSort.startIdx + i] = Number(
        batch[i][AF.INTERNAL_GAP_COUNT] || 0,
      );
    }
  } else if (currentKey === "id") {
    const ids = _currentSort.tempData as string[];
    const batch = _storage.getAnnotationsBatch(_currentSort.startIdx, chunkSize);
    for (let i = 0; i < batch.length; i++) {
      if (!_currentSort || _currentSort.key !== currentKey) return;
      ids[_currentSort.startIdx + i] = batch[i][AF.ID] || "";
    }
  }

  _currentSort.startIdx = endIdx;
  const isComplete = endIdx === count;

  if (isComplete) {
    const res = new Int32Array(count);
    if (currentKey === "gaps") {
      const scores = _currentSort.scores;
      const packed = new BigUint64Array(count);
      for (let i = 0; i < count; i++) {
        packed[i] = (toBI(scores[i]) << BigInt(32)) | toBI(i);
      }
      packed.sort();
      for (let i = 0; i < count; i++)
        res[i] = Number(packed[i] & BigInt(0xffffffff));
    } else if (currentKey === "id") {
      const ids = _currentSort.tempData as string[];
      for (let i = 0; i < count; i++) res[i] = i;
      res.sort((a, b) => {
        const valA = ids[a];
        const valB = ids[b];
        return valA < valB ? -1 : valA > valB ? 1 : 0;
      });
    }
    _sortedIndicesCache.set(currentKey, res);
    _sequenceSliceCache.clear();
  }

  const progress = count > 0 ? endIdx / count : 1;
  self.postMessage({
    type: "sortUpdate",
    sortKey: currentKey,
    progress,
    complete: isComplete,
  });

  if (isComplete) {
    if (_currentSort.key === currentKey) _currentSort = null;
  } else {
    setTimeout(() => runSimpleSortStep(currentKey), 0);
  }
}

/**
 * OPTION A: Bit-Packed SIMD-style Comparison Loops
 * Uses 32-bit word XORing to compare 4 characters at once.
 */
function runSortStep(currentKey: string) {
  if (!_currentSort || _currentSort.key !== currentKey) {
    // This sort task has been superseded or cancelled
    return;
  }
  const count = _storage.size();
  const chunkSize = 25000; // Optimal balance for performance vs progress frequency
  const endIdx = Math.min(_currentSort.startIdx + chunkSize, count);
  const target = _currentSort.target;const targetLen = target.length;
const scores = _currentSort.scores;
const { offsets, lengths, onDiskSize, file, writeBuffer, writeBufferPtr } =
  _storage.getInternalPointers();
const chunkBuffer = new Uint8Array(32 * 1024 * 1024);
const targetShifts = new Int32Array(targetLen);
for (let k = 0; k < targetLen; k++) targetShifts[k] = target[k] << 7;
let cStart = -1,
  cEnd = -1;

for (let i = _currentSort.startIdx; i < endIdx; i++) {
  // Check for cancellation inside the inner loop too for responsiveness
  if (!_currentSort || _currentSort.key !== currentKey) return;
  
  const offBI = offsets![i],
    len = lengths![i];
  if (len <= 0) continue;

  let seq: Uint8Array;
  if (offBI >= toBI(onDiskSize)) {
    // In RAM buffer
    const rel = Number(offBI - toBI(onDiskSize));
    seq = writeBuffer.subarray(rel, rel + len);
  } else {
    // In File
    const off = Number(offBI);
    if (off < cStart || off + len > cEnd) {
      cStart = off;
      const toRead = Math.min(32 * 1024 * 1024, onDiskSize - off);
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
    let s = 0;
    const min = Math.min(len, targetLen);
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
    // Hamming distance (Case-Sensitive)
    let d = Math.abs(len - targetLen);
    const min = Math.min(len, targetLen);
    for (let k = 0; k < min; k++) {
      if (seq[k] !== target[k]) d++;
    }
    scores[i] = d;
  }
  }
// Final check before state update/callback
if (!_currentSort || _currentSort.key !== currentKey) return;

_currentSort.startIdx = endIdx;
const isComplete = endIdx === count;

if (isComplete) {
  const packed = new BigUint64Array(count);
  const offset = _currentSort.isBlosum ? 1000000 : 0;
  for (let i = 0; i < count; i++) {
    packed[i] =
      (toBI(
        _currentSort.isBlosum
          ? offset - Math.round(scores[i])
          : Math.round(scores[i]),
      ) <<
        BigInt(32)) |
      toBI(i);
  }
  packed.sort();
  const res = new Int32Array(count);
  for (let i = 0; i < count; i++)
    res[i] = Number(packed[i] & BigInt(0xffffffff));
    _sortedIndicesCache.set(_currentSort.key, res);
    _sequenceSliceCache.clear();
    }
const progress = count > 0 ? endIdx / count : 1;
self.postMessage({
  type: "sortUpdate",
  sortKey: _currentSort.key,
  progress,
  complete: isComplete,
});
if (isComplete) {
  if (_currentSort.key === currentKey) _currentSort = null;
} else {
  setTimeout(() => runSortStep(currentKey), 0);
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

function parseSeqAnnotations(
id: string,
sequence: string,
description?: string,
): Record<string, any> {
const annotations: Record<string, any> = {
  [AF.ID]: id,
  [AF.ACTUAL_ID]: id,
  [AF.DESCRIPTION]: description ?? "",
  [AF.REAL_LENGTH]: sequence.replace(/[-.]/g, "").length,
  [AF.ALIGNED_LENGTH]: sequence.length,
};
let left = 0,
  right = 0,
  internal = 0;
let i = 0;
while (i < sequence.length && (sequence[i] === "-" || sequence[i] === ".")) {
  left++;
  i++;
}
let j = sequence.length - 1;
while (j >= i && (sequence[j] === "-" || sequence[j] === ".")) {
  right++;
  j--;
}
for (let k = i; k <= j; k++) {
  if (sequence[k] === "-" || sequence[k] === ".") internal++;
}
annotations[AF.LEFT_GAP_COUNT] = left;
annotations[AF.RIGHT_GAP_COUNT] = right;
annotations[AF.INTERNAL_GAP_COUNT] = internal;
return annotations;
}

async function* streamToLines(
stream: ReadableStream<Uint8Array>,
): AsyncIterable<string> {
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
} | null,
): IWorkerMetadata {
const query = _storage.get(0);
const maxLen = query.sequence.length;

const allUniqueCharCodes: Record<number, boolean> = {};
const limit = Math.min(_storage.size(), 1000);
for (let i = 0; i < limit; i++) {
  const s = _storage.get(i).sequence;
  for (let j = 0; j < s.length; j++)
    allUniqueCharCodes[s.charCodeAt(j)] = true;
}
const allUniqueChars = Object.keys(allUniqueCharCodes).map((cc) =>
  String.fromCharCode(Number(cc)),
);
const NT_CODES = new Set("ATGCUNRYSWKMBDHVatgcunryswkmbdhv-.");
const predictedNT = allUniqueChars.every((c) => NT_CODES.has(c));
const allUpperAlpha = allUniqueChars.filter((c) => /[A-Z]/.test(c)).sort();

const annotationFields: Record<string, { key: string; name: string }> = {};
for (const field of Object.keys(query.annotations)) {
  annotationFields[field] = { key: field, name: formatFieldName(field) };
}

return {
  name: fileName,
  uuid: generateUUID(),
  sequenceCount: _sparseMode
    ? _sparseEstimatedSequenceCount
    : _storage.size(),
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

    // Check cache first
    const cacheKey = `${sortKey}:${start}-${end}`;
    if (_sequenceSliceCache.has(cacheKey)) {
      const cached = _sequenceSliceCache.get(cacheKey)!;
      self.postMessage({ type: "slice", requestId, ...cached });
      return;
    }

    if (_sparseMode && sortKey === "as-input") {      const byteStart = Math.max(
        0,
        Math.floor(start * _sparseAvgBytesPerSeq) - 2000,
      );
      const actualStart = start === 0 ? 0 : byteStart;
      const byteEnd = Math.min(
        _sparseContentLength - 1,
        Math.floor(end * _sparseAvgBytesPerSeq) + 10000,
      );

      fetchSparseChunk(_sparseUrl, actualStart, byteEnd)
        .then((text) =>
          parseSparseChunkText(text, byteEnd === _sparseContentLength - 1),
        )
        .then(({ sequences, annotations }) => {
          const numRequested = end - start;
          self.postMessage({
            type: "slice",
            requestId,
            sequences: sequences.slice(0, numRequested),
            annotations: annotations.slice(0, numRequested),
          });
        })
        .catch((e) => {
          self.postMessage({
            type: "slice",
            requestId,
            sequences: [],
            annotations: [],
          });
        });
      return;
    }

    const currentSize = _sparseMode
      ? _sparseEstimatedSequenceCount
      : _storage.size();

    // Trigger sort if needed
    if (
      sortKey !== "as-input" &&
      !_sortedIndicesCache.has(sortKey) &&
      (!_currentSort || _currentSort.key !== sortKey)
    ) {
      if (sortKey === "id" || sortKey === "gaps") {
        _currentSort = {
          key: sortKey,
          scores: new Float32Array(currentSize),
          target: new Uint8Array(0),
          isBlosum: false,
          startIdx: 0,
        };
        setTimeout(() => runSimpleSortStep(sortKey), 0);
      } else {
        _currentSort = {
          key: sortKey,
          scores: new Float32Array(currentSize),
          target: new TextEncoder().encode(
            sortKey.includes("query") ? _querySequence : _consensusSequence,
          ),
          isBlosum: sortKey.startsWith("blosum"),
          startIdx: 0,
        };
        setTimeout(() => runSortStep(sortKey), 0);
      }
    } else if (sortKey !== "as-input" && _sortedIndicesCache.has(sortKey)) {      // Already cached, send completion to clear progress bars
      self.postMessage({
        type: "sortUpdate",
        sortKey,
        progress: 1,
        complete: true,
      });
    }
    const indices = _sortedIndicesCache.get(sortKey);
    const sequences: string[] = [],
      annotations: any[] = [];
    const clampedEnd = Math.min(end, currentSize);
    for (let i = start; i < clampedEnd; i++) {
      const idx = indices && i < indices.length ? indices[i] : i;
      const s = _storage.get(idx);
      sequences.push(s.sequence);
      annotations.push(s.annotations);
    }
    _sequenceSliceCache.set(cacheKey, { sequences, annotations });
    // Keep cache size reasonable
    if (_sequenceSliceCache.size > 50) {
      const firstKey = _sequenceSliceCache.keys().next().value;
      if (firstKey) _sequenceSliceCache.delete(firstKey);
    }
    self.postMessage({ type: "slice", requestId, sequences, annotations });
    return;
    }

    if (msg.type === "parse") {
    _sequenceSliceCache.clear();
    const { file, alignmentName, removeDuplicateSequences } = msg;  let url = msg.url;
  _storage.clear();
  _sortedIndicesCache.clear();
  _currentSort = null;

  await _storage.initialize(true);

  let stream: ReadableStream<Uint8Array> = new ReadableStream();
  let fileName = alignmentName || (file ? file.name : "alignment");

  if (file) {
    postProgress("Reading file…");
    stream = file.stream();
  } else if (url) {
    postProgress("Connecting…");

    let useRange = false;
    let rangeResp: Response | null = null;
    let activeStream: ReadableStream<Uint8Array> | null = null;

    try {
      // --- Step 1: Initial probe (no headers) ---
      // This avoids CORS preflight on API endpoints.
      const probeResp = await fetch(url);
      if (!probeResp.ok) throw new Error(`Server returned ${probeResp.status}`);

      let fileUrl = url;
      let fileProbe = probeResp;

      const contentType = probeResp.headers.get("content-type");
      if (contentType && contentType.includes("application/json")) {
        // --- Step 2: Handle API Wrapper ---
        const json = await probeResp.json();
        if (json.presignedURL) {
          fileUrl = json.presignedURL;
          url = fileUrl; // Update current URL for later
          
          // We MUST probe the S3 URL without headers too.
          // S3 might have its own CORS policy that blocks Range or even the Origin.
          fileProbe = await fetch(fileUrl);
          if (!fileProbe.ok) throw new Error(`S3 returned ${fileProbe.status}`);
        }
      }

      // --- Step 3: Analyze the file for Sparse Mode ---
      const acceptRanges = fileProbe.headers.get("Accept-Ranges");
      const contentLength = fileProbe.headers.get("Content-Length");
      let fileSize = contentLength ? Number(contentLength) : 0;
      if (isNaN(fileSize)) fileSize = 0;

      // ONLY attempt Range requests if:
      // 1. Server claims to support them.
      // 2. File is large enough to justify the overhead (> 10MB).
      // For your 3MB file, this will skip Range and use the stream directly.
      if (acceptRanges === "bytes" && fileSize > 10 * 1024 * 1024) {
        try {
          const r = await fetch(fileUrl, {
            headers: { Range: "bytes=0-1048575" },
          });
          if (r.status === 206) {
            rangeResp = r;
            useRange = true;
            _sparseUrl = fileUrl;
            _sparseContentLength = fileSize;
          }
        } catch (e) {
          // S3 likely doesn't allow the 'Range' header in its CORS policy.
          // Fallback to standard streaming.
        }
      }

      if (!useRange) {
        // Standard streaming mode.
        activeStream = fileProbe.body;
      }
    } catch (e) {
      // Last-resort fallback: try one more time with a clean fetch
      if (!activeStream && !useRange) {
        try {
          const resp = await fetch(url);
          if (resp.ok) activeStream = resp.body;
        } catch (e2) {}
      }
    }

    if (useRange && rangeResp) {
      postProgress("Fetching initial chunk…");
      const text = await rangeResp.text();
      const { sequences } = await parseSparseChunkText(
        text,
        _sparseContentLength <= 1048576,
      );

      if (sequences.length > 0) {
        const textBytes = new TextEncoder().encode(text).length;
        _sparseAvgBytesPerSeq = textBytes / sequences.length;
        if (_sparseAvgBytesPerSeq > 0) {
          _sparseEstimatedSequenceCount = Math.floor(
            _sparseContentLength / _sparseAvgBytesPerSeq,
          );
        } else {
          _sparseMode = false;
        }
      } else {
        _sparseMode = false;
      }

      if (isNaN(_sparseEstimatedSequenceCount) || !isFinite(_sparseEstimatedSequenceCount)) {
        _sparseEstimatedSequenceCount = 0;
        _sparseMode = false;
      }

      if (_sparseMode) {
        stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(text));
            controller.close();
          },
        });
      }
    }

    if (!_sparseMode) {
      if (activeStream) {
        stream = activeStream;
      } else {
        // Final connection attempt if everything failed
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`Server returned ${resp.status}`);
        stream = resp.body!;
      }
    }
  } else {
    throw new Error("No file or URL provided");
  }

  const lineIter = streamToLines(stream);
  const iter = lineIter[Symbol.asyncIterator]();

  let firstLine = "";
  let firstResult: IteratorResult<string> = { value: "", done: true };
  while (true) {
    firstResult = await iter.next();
    if (firstResult.done) break;
    const t = firstResult.value.replace(/\r$/, "").trim();
    if (t) {
      firstLine = t;
      break;
    }
  }
  if (!firstLine)
    throw Object.assign(new Error("Empty file"), { name: "File Error" });

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
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz.-"
    .split("")
    .forEach((c) => {
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
      if (runningGlobalCounts[ci] > 0)
        globalAlphaLetterCounts[idxToChar[ci]] = runningGlobalCounts[ci];
    }
    const consensusSeq = positionalLetterCounts
      .map(([, letterCounts]) => {
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
      })
      .join("");
    return {
      positionalLetterCounts,
      globalAlphaLetterCounts,
      consensus: { annotations: {}, sequence: consensusSeq },
    };
  };

  const checkUpdates = () => {
    if (!firstBatchSent && _storage.size() >= 100) {
      firstBatchSent = true;
      const stats = getPartialStats();
      self.postMessage({
        type: "done",
        data: buildQuickMetadata(fileName, removeDuplicateSequences, stats),
      });
    } else if (firstBatchSent && _storage.size() % 1000 === 0) {
      const stats = getPartialStats();
      self.postMessage({
        type: "stats",
        data: { ...stats, sequenceCount: _storage.size() },
      });
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
        runningFlatCounts = new Float64Array(
          currentMaxLen * idxToChar.length,
        );
        runningGlobalCounts = new Float64Array(idxToChar.length);
      }
      const numChars = idxToChar.length;
      for (let pi = 0; pi < Math.min(sequence.length, currentMaxLen); pi++) {
        const ci = charCodeToIdx.get(sequence.charCodeAt(pi));
        if (ci !== undefined) {
          runningFlatCounts![pi * numChars + ci]++;
          runningGlobalCounts![ci]++;
        }
      }
      _storage.add(
        sequence,
        parseSeqAnnotations(currentHeader.split(/\s+/)[0], sequence),
      );
      if (!_querySequence) {
        _querySequence = sequence;
        _consensusSequence = sequence; // Preliminary fallback
      }
      checkUpdates();
      currentParts = [];
    };
    for await (const rawLine of prepended()) {
      const line = rawLine.replace(/\r$/, "");
      if (line.startsWith(">")) {
        flush();
        currentHeader = line.slice(1);
      } else if (currentHeader) currentParts.push(line.trim());
    }
    flush();
  } else {
    throw new Error(
      "Only FASTA supported for disk-streaming mode currently.",
    );
  }

  _storage.flush();
  const finalStats = getPartialStats();
  _querySequence = _storage.get(0).sequence;
  _consensusSequence = finalStats?.consensus.sequence ?? _querySequence;

  // Clear consensus-dependent sorts so they re-trigger with final consensus if requested
  _sortedIndicesCache.delete("hamming-dist-to-consensus");
  _sortedIndicesCache.delete("blosum-score-to-consensus");

    self.postMessage({
      type: "done",
      data: {
        ...buildQuickMetadata(fileName, removeDuplicateSequences, finalStats),
        isComplete: true,
      },
    });
    }
  } catch (e: any) {
    self.postMessage({
      type: "error",
      name: e.name ?? "Error",
      message: e.message || String(e),
    });
  }
};
