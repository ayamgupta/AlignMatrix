/* eslint-disable no-restricted-globals */
/**
 * AlignmentParserWorker
 * ---------------------
 * Option B: Parallel Worker Pool Engine for 4GB+ protein alignments.
 */

export interface IWorkerMetadata {
  name: string; uuid: string; sequenceCount: number; maxSequenceLength: number;
  predictedNT: boolean; numberDuplicateSequencesInAlignment: number;
  numberRemovedDuplicateSequences: number; querySequence: { sequence: string; annotations: Record<string, any> };
  consensus: { sequence: string; annotations: Record<string, any> };
  allRepresentedCharacters: string[]; allUpperAlphaLettersInAlignmentSorted: string[];
  positionalLetterCounts: [number, { [letter: string]: number }][]; globalAlphaLetterCounts: { [letter: string]: number };
  annotationFields: Record<string, { key: string; name: string }>;
}

const AF = {
  ID: "@@id", ACTUAL_ID: "@@actualId", DESCRIPTION: "@@description", BEGIN: "@@begin", END: "@@end", LINK: "@@link",
  REAL_LENGTH: "@@realLength", ALIGNED_LENGTH: "@@alignedLength", LEFT_GAP_COUNT: "@@leftGapCount",
  INTERNAL_GAP_COUNT: "@@internalGapCount", RIGHT_GAP_COUNT: "@@rightGapCount",
} as const;

interface IStoredSequence { sequence: string; annotations: Record<string, any>; }

class SequenceStorage {
  private mode: "ram" | "opfs" = "ram";
  private ramSequences: IStoredSequence[] = [];
  private opfsFile: any | null = null;
  private opfsOffsets: BigUint64Array | null = null;
  private opfsLengths: Int32Array | null = null;
  private opfsAnnotations: Record<string, any>[] = [];
  private opfsPtr = 0;
  private count = 0;
  private capacity = 1000000;
  private writeBuffer = new Uint8Array(8 * 1024 * 1024);
  private writeBufferPtr = 0;

  async initialize(useOpfs: boolean) {
    if (useOpfs && typeof navigator !== "undefined" && navigator.storage && navigator.storage.getDirectory) {
      try {
        const root = await navigator.storage.getDirectory();
        for await (const name of (root as any).keys()) {
          if (name.startsWith("alignment_buffer_")) await root.removeEntry(name).catch(()=>{});
        }
        const fileHandle = await root.getFileHandle("alignment_buffer_" + Math.random(), { create: true });
        // @ts-ignore
        this.opfsFile = await fileHandle.createSyncAccessHandle();
        this.opfsOffsets = new BigUint64Array(this.capacity);
        this.opfsLengths = new Int32Array(this.capacity);
        this.mode = "opfs";
      } catch (e) { this.mode = "ram"; }
    } else { this.mode = "ram"; }
  }

  private ensureCapacity(target: number) {
    if (this.mode === "opfs" && target >= this.capacity) {
      const newCap = this.capacity * 2;
      const nO = new BigUint64Array(newCap); const nL = new Int32Array(newCap);
      if (this.opfsOffsets) nO.set(this.opfsOffsets); if (this.opfsLengths) nL.set(this.opfsLengths);
      this.opfsOffsets = nO; this.opfsLengths = nL; this.capacity = newCap;
    }
  }

  add(sequence: Uint8Array, annotations: Record<string, any>) {
    if (this.mode === "ram") {
      this.ramSequences.push({ sequence: new TextDecoder().decode(sequence), annotations });
    } else {
      this.ensureCapacity(this.count);
      if (this.writeBufferPtr + sequence.length > this.writeBuffer.length) this.flush();
      if (sequence.length > this.writeBuffer.length) {
        this.opfsFile.write(sequence, { at: BigInt(this.opfsPtr) });
        this.opfsOffsets![this.count] = BigInt(this.opfsPtr);
        this.opfsLengths![this.count] = sequence.length;
        this.opfsPtr += sequence.length;
      } else {
        this.writeBuffer.set(sequence, this.writeBufferPtr);
        this.opfsOffsets![this.count] = BigInt(this.opfsPtr) + BigInt(this.writeBufferPtr);
        this.opfsLengths![this.count] = sequence.length;
        this.writeBufferPtr += sequence.length;
      }
      this.opfsAnnotations[this.count] = annotations;
    }
    this.count++;
  }

  flush() {
    if (this.mode === "opfs" && this.writeBufferPtr > 0) {
      this.opfsFile.write(this.writeBuffer.subarray(0, this.writeBufferPtr), { at: BigInt(this.opfsPtr) });
      this.opfsPtr += this.writeBufferPtr;
      this.writeBufferPtr = 0;
      this.opfsFile.flush();
    }
  }

  get(index: number): IStoredSequence {
    if (index === undefined || index === null || index < 0 || index >= this.count) return { sequence: "", annotations: {} };
    if (this.mode === "ram") return this.ramSequences[index] || { sequence: "", annotations: {} };
    const offset = this.opfsOffsets![index]; const length = this.opfsLengths![index];
    if (length <= 0) return { sequence: "", annotations: this.opfsAnnotations[index] || {} };
    if (offset >= BigInt(this.opfsPtr)) {
      const rel = Number(offset - BigInt(this.opfsPtr)); const end = Math.min(rel + length, this.writeBufferPtr);
      return { sequence: new TextDecoder().decode(this.writeBuffer.subarray(rel, end)), annotations: this.opfsAnnotations[index] };
    }
    const buffer = new Uint8Array(length);
    const at = BigInt(offset.toString()); 
    try { this.opfsFile.read(buffer, { at }); } catch (e) { return { sequence: "-".repeat(length), annotations: this.opfsAnnotations[index] || {} }; }
    return { sequence: new TextDecoder().decode(buffer), annotations: this.opfsAnnotations[index] };
  }

  getAnnotations(index: number): Record<string, any> {
    if (this.mode === "ram") return this.ramSequences[index]?.annotations || {};
    return this.opfsAnnotations[index] || {};
  }

  size() { return this.count; }
  getInternalPointers() { return { offsets: this.opfsOffsets, lengths: this.opfsLengths, ptr: this.opfsPtr, file: this.opfsFile }; }
  clear() {
    this.ramSequences = []; this.opfsAnnotations = []; this.opfsPtr = 0; this.count = 0;
    if (this.opfsFile) { try { this.opfsFile.close(); } catch (e) {} this.opfsFile = null; }
  }
}

let _storage = new SequenceStorage();
const _sortedIndicesCache = new Map<string, Int32Array>();
let _currentSort: { key: string, scores: Float32Array, target: Uint8Array, isBlosum: boolean, nextIdx: number, scoredCount: number } | null = null;
let _querySequence: string = "";
let _consensusSequence: string = "";

// ---- Parallel Scoring Pool (Option B) --------------------------------------

const COMPUTE_WORKER_CODE = `
  const BLOSUM62_BYTES = new Int8Array(128 * 128);
  const codes = "ARNDCQEGHILKMFPSTWYV";
  const scores = [[4,-1,-2,-2,0,-1,-1,0,-2,-1,-1,-1,-1,-2,-1,1,0,-3,-2,0],[-1,5,0,-2,-3,1,0,-2,0,-3,-2,2,-1,-3,-2,-1,-1,-3,-2,-3],[-2,0,6,1,-3,0,0,0,1,-3,-3,0,-2,-3,-2,1,0,-4,-2,-3],[-2,-2,1,6,-3,0,2,-1,-1,-3,-4,-1,-3,-3,-1,0,-1,-4,-3,-3],[0,-3,-3,-3,9,-3,-4,-3,-3,-1,-1,-3,-1,-2,-3,-1,-1,-2,-2,-1],[-1,1,0,0,-3,5,2,-2,0,-3,-2,1,0,-3,-1,0,-1,-2,-1,-2],[-1,0,0,2,-4,2,5,-2,0,-3,-3,1,-2,-3,-1,0,-1,-3,-2,-2],[0,-2,0,-1,-3,-2,-2,6,-2,-4,-4,-2,-3,-3,-2,0,-2,-2,-3,-3],[-2,0,1,-1,-3,0,0,-2,8,-3,-3,-1,-2,-1,-2,-1,-2,-2,2,-3],[-1,-3,-3,-3,-1,-3,-3,-4,-3,4,2,-3,1,0,-3,-1,1,-3,-1,3],[-1,-2,-3,-4,-1,-2,-3,-4,-3,2,4,-2,2,0,-3,-2,-1,-2,-1,1],[-1,2,0,-1,-3,1,1,-2,-1,-3,-2,5,-1,-3,-1,0,-1,-3,-2,-2],[-1,-1,-2,-3,-1,0,-2,-3,-2,1,2,-1,5,0,-2,-1,-1,-1,-1,1],[-2,-3,-3,-3,-2,-3,-3,-3,-1,0,0,-3,0,6,-3,-2,-2,1,3,-1],[-1,-2,-2,-1,-3,-1,-1,-2,-2,-3,-3,-1,-2,-3,7,-1,-1,-4,-3,-2],[1,-1,1,0,-1,0,0,0,-1,-1,-2,0,-1,-2,-1,4,1,-3,-2,0],[0,-1,0,-1,-1,-1,-1,-2,-2,1,-1,-1,-1,-2,-1,1,5,-2,-2,0],[-3,-3,-4,-4,-2,-2,-3,-2,-2,-3,-2,-3,-1,1,-4,-3,-2,11,2,-3],[-2,-2,-2,-3,-2,-1,-2,-3,2,-1,-1,-2,-1,3,-3,-2,-2,2,7,-1],[0,-3,-3,-3,-1,-2,-2,-3,-3,3,1,-2,1,-1,-2,0,0,-3,-1,4]];
  for (let i = 0; i < codes.length; i++) {
    for (let j = 0; j < codes.length; j++) {
      const cI = codes.charCodeAt(i); const cJ = codes.charCodeAt(j);
      BLOSUM62_BYTES[cI * 128 + cJ] = scores[i][j]; BLOSUM62_BYTES[(cI+32)*128+cJ]=scores[i][j]; BLOSUM62_BYTES[cI*128+(cJ+32)]=scores[i][j]; BLOSUM62_BYTES[(cI+32)*128+(cJ+32)]=scores[i][j];
    }
  }

  self.onmessage = (e) => {
    const { startIdx, chunk, offsets, lengths, target, isBlosum, basePtr } = e.data;
    const resScores = new Float32Array(offsets.length);
    const targetLen = target.length;
    const tShifts = new Int32Array(targetLen);
    for(let k=0; k<targetLen; k++) tShifts[k] = target[k] << 7;

    for (let i = 0; i < offsets.length; i++) {
      const rel = Number(offsets[i] - basePtr); const len = lengths[i];
      if (len <= 0) continue;
      const seq = chunk.subarray(rel, rel + len);
      if (isBlosum) {
        let s = 0; const min = Math.min(len, targetLen);
        for (let k = 0; k < min; k++) { const a = seq[k]; if (a < 128) s += BLOSUM62_BYTES[tShifts[k] | a]; }
        resScores[i] = s;
      } else {
        let d = Math.abs(len - targetLen); const min = Math.min(len, targetLen);
        for (let k = 0; k < min; k++) if (seq[k] !== target[k]) d++;
        resScores[i] = d;
      }
    }
    self.postMessage({ startIdx, scores: resScores }, [resScores.buffer]);
  };
`;

const _workerPool: Worker[] = [];
const _numWorkers = Math.max(1, (navigator.hardwareConcurrency || 4) - 1);

function getPool(): Worker[] {
  if (_workerPool.length === 0) {
    const blob = new Blob([COMPUTE_WORKER_CODE], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    for (let i = 0; i < _numWorkers; i++) _workerPool.push(new Worker(url));
  }
  return _workerPool;
}

function dispatch(worker: Worker) {
  if (!_currentSort) return;
  const count = _storage.size();
  if (_currentSort.nextIdx >= count) return;

  const { offsets, lengths, file } = _storage.getInternalPointers();
  const startIdx = _currentSort.nextIdx;
  const baseOffset = offsets![startIdx];
  const CHUNK_SIZE_BYTES = 10 * 1024 * 1024;
  
  let endIdx = startIdx;
  while (endIdx < count && (offsets![endIdx] - baseOffset) < BigInt(CHUNK_SIZE_BYTES) && (endIdx - startIdx) < 50000) {
    endIdx++;
  }
  _currentSort.nextIdx = endIdx;

  const totalReadLen = Number(offsets![endIdx - 1] + BigInt(lengths![endIdx - 1]) - baseOffset);
  const chunk = new Uint8Array(totalReadLen);
  file.read(chunk, { at: BigInt(baseOffset.toString()) });

  const batchOffsets = offsets!.slice(startIdx, endIdx);
  const batchLengths = lengths!.slice(startIdx, endIdx);

  worker.postMessage({
    startIdx, chunk, offsets: batchOffsets, lengths: batchLengths,
    target: _currentSort.target, isBlosum: _currentSort.isBlosum, basePtr: baseOffset
  }, [chunk.buffer, batchOffsets.buffer, batchLengths.buffer]);
}

function finalizeSort() {
  if (!_currentSort) return;
  const count = _storage.size();
  const scores = _currentSort.scores;
  const packed = new BigUint64Array(count);
  const offset = _currentSort.isBlosum ? 1000000 : 0;
  for (let i = 0; i < count; i++) {
    packed[i] = (BigInt(_currentSort.isBlosum ? offset - Math.round(scores[i]) : Math.round(scores[i])) << 32n) | BigInt(i);
  }
  packed.sort();
  const res = new Int32Array(count);
  for (let i = 0; i < count; i++) res[i] = Number(packed[i] & 0xFFFFFFFFn);
  _sortedIndicesCache.set(_currentSort.key, res);
  _currentSort = null;
}

// ---- worker entry ----------------------------------------------------------

self.onmessage = async (event) => {
  const msg = event.data;
  if (msg.type === "getSlice") {
    const { start, end, requestId, sortKey = "as-input" } = msg;
    const currentSize = _storage.size();
    if (sortKey !== "as-input" && !_sortedIndicesCache.has(sortKey) && (!_currentSort || _currentSort.key !== sortKey)) {
      if (sortKey === "id" || sortKey === "gaps") {
        const res = new Int32Array(currentSize); for(let i=0; i<currentSize; i++) res[i]=i;
        if (sortKey === "gaps") {
          const packed = new BigUint64Array(currentSize);
          for (let i = 0; i < currentSize; i++) packed[i] = (BigInt(_storage.getAnnotations(i)[AF.INTERNAL_GAP_COUNT] || 0) << 32n) | BigInt(i);
          packed.sort(); for (let i = 0; i < currentSize; i++) res[i] = Number(packed[i] & 0xFFFFFFFFn);
        } else { res.sort((a,b) => _storage.getAnnotations(a)[AF.ID] < _storage.getAnnotations(b)[AF.ID] ? -1 : 1); }
        _sortedIndicesCache.set(sortKey, res); self.postMessage({ type: "sortUpdate", sortKey, progress: 1, complete: true });
      } else {
        _currentSort = { key: sortKey, scores: new Float32Array(currentSize), target: new TextEncoder().encode(sortKey.includes("query") ? _querySequence : _consensusSequence), isBlosum: sortKey.startsWith("blosum"), nextIdx: 0, scoredCount: 0 };
        const pool = getPool();
        pool.forEach(w => {
          w.onmessage = (e) => {
            if (!_currentSort) return;
            const { startIdx, scores } = e.data;
            _currentSort.scores.set(scores, startIdx);
            _currentSort.scoredCount += scores.length;
            self.postMessage({ type: "sortUpdate", sortKey: _currentSort.key, progress: _currentSort.scoredCount / currentSize, complete: _currentSort.scoredCount === currentSize });
            if (_currentSort.scoredCount === currentSize) finalizeSort(); else dispatch(w);
          };
          dispatch(w);
        });
      }
    }
    const indices = _sortedIndicesCache.get(sortKey); const sequences: string[] = [], annotations: any[] = [];
    for (let i = start; i < Math.min(end, currentSize); i++) {
      const idx = (indices && i < indices.length) ? indices[i] : i;
      const s = _storage.get(idx); sequences.push(s.sequence); annotations.push(s.annotations);
    }
    self.postMessage({ type: "slice", requestId, sequences, annotations });
  } else if (msg.type === "parse") {
    _storage.clear(); _sortedIndicesCache.clear(); _currentSort = null; await _storage.initialize(true);
    const stream = msg.file ? msg.file.stream() : (await fetch(msg.url)).body;
    const reader = stream.getReader();
    let header: string | null = null, seqBuf = new Uint8Array(1024 * 1024), seqPtr = 0;
    let headBuf = new Uint8Array(2048), headPtr = 0, inHeader = false, lineStart = true, firstSent = false, maxLen = 0;
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      for (let i = 0; i < value.length; i++) {
        const b = value[i];
        if (b === 10) { if (inHeader) { header = new TextDecoder().decode(headBuf.subarray(0, headPtr)).trim(); headPtr = 0; inHeader = false; } lineStart = true; continue; }
        if (b === 13) continue;
        if (lineStart && b === 62) {
          if (header) { _storage.add(seqBuf.subarray(0, seqPtr), parseSeqAnnotations(header.split(/\s+/)[0], seqBuf.subarray(0, seqPtr))); if (seqPtr > maxLen) maxLen = seqPtr; seqPtr = 0; }
          inHeader = true; lineStart = false; continue;
        }
        if (inHeader) { if (headPtr >= headBuf.length) { const n = new Uint8Array(headBuf.length*2); n.set(headBuf); headBuf=n; } headBuf[headPtr++] = b; }
        else if (b !== 32) { if (seqPtr >= seqBuf.length) { const n = new Uint8Array(seqBuf.length*2); n.set(seqBuf); seqBuf=n; } seqBuf[seqPtr++] = b; }
        lineStart = false;
      }
      if (!firstSent && _storage.size() >= 100) { firstSent = true; self.postMessage({ type: "done", data: buildQuickMetadata(msg.alignmentName || "file", _storage.size(), maxLen) }); }
    }
    if (header) { _storage.add(seqBuf.subarray(0, seqPtr), parseSeqAnnotations(header.split(/\s+/)[0], seqBuf.subarray(0, seqPtr))); if (seqPtr > maxLen) maxLen = seqPtr; }
    _storage.flush(); _querySequence = _storage.get(0).sequence;
    self.postMessage({ type: "done", data: buildQuickMetadata(msg.alignmentName || "file", _storage.size(), maxLen) });
  }
};

function parseSeqAnnotations(id: string, bytes: Uint8Array): any {
  let g = 0; for(let i=0; i<bytes.length; i++) if (bytes[i] === 45 || bytes[i] === 46) g++;
  return { [AF.ID]: id, [AF.INTERNAL_GAP_COUNT]: g, [AF.REAL_LENGTH]: bytes.length - g, [AF.ALIGNED_LENGTH]: bytes.length };
}

function buildQuickMetadata(name: string, count: number, maxLen: number): IWorkerMetadata {
  const q = _storage.get(0);
  return {
    name, uuid: "123", sequenceCount: count, maxSequenceLength: maxLen || 1,
    predictedNT: false, numberDuplicateSequencesInAlignment: 0, numberRemovedDuplicateSequences: 0,
    querySequence: q, consensus: q, allRepresentedCharacters: ["A","C","G","T","N","R","Y","S","W","K","M","B","D","H","V","-","."],
    allUpperAlphaLettersInAlignmentSorted: ["A","C","G","T","N"], positionalLetterCounts: [], globalAlphaLetterCounts: {},
    annotationFields: { [AF.ID]: { key: AF.ID, name: "ID" }, [AF.INTERNAL_GAP_COUNT]: { key: AF.INTERNAL_GAP_COUNT, name: "Gaps" } }
  };
}
