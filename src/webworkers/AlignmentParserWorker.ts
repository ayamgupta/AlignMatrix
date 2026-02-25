/* eslint-disable no-restricted-globals */
/**
 * AlignmentParserWorker
 * ---------------------
 * High-performance streaming parser for protein alignments.
 * 
 * Scalability Strategy:
 * 1. Streams data from URL or File using ReadableStream.
 * 2. If browser supports OPFS, it stores sequences in a private temporary file.
 * 3. Only byte offsets are kept in RAM, allowing 3GB+ files to load without OOM.
 * 4. Statistics (Consensus, Frequencies) are calculated incrementally during the stream.
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

/** 
 * SequenceStorage manages where sequences are kept. 
 * For large files, it spills to OPFS (disk) to avoid RAM limits.
 */
class SequenceStorage {
  private mode: "ram" | "opfs" = "ram";
  private ramSequences: IStoredSequence[] = [];
  
  private opfsFile: any | null = null; // FileSystemSyncAccessHandle
  private opfsOffsets: BigInt64Array | null = null;
  private opfsLengths: Int32Array | null = null;
  private opfsAnnotations: Record<string, any>[] = [];
  private opfsPtr = 0;
  private count = 0;
  private capacity = 1000000;

  async initialize(useOpfs: boolean) {
    if (useOpfs && typeof navigator !== "undefined" && navigator.storage && navigator.storage.getDirectory) {
      try {
        const root = await navigator.storage.getDirectory();
        const fileHandle = await root.getFileHandle("alignment_buffer_" + Math.random(), { create: true });
        // @ts-ignore
        this.opfsFile = await fileHandle.createSyncAccessHandle();
        this.opfsOffsets = new BigInt64Array(this.capacity);
        this.opfsLengths = new Int32Array(this.capacity);
        this.mode = "opfs";
        console.log("SequenceStorage: Using OPFS (disk-backed) storage.");
      } catch (e) {
        console.warn("SequenceStorage: OPFS initialization failed, falling back to RAM.", e);
        this.mode = "ram";
      }
    } else {
      this.mode = "ram";
    }
  }

  private ensureCapacity() {
    if (this.mode === "opfs" && this.count >= this.capacity) {
      this.capacity *= 2;
      const newOffsets = new BigInt64Array(this.capacity);
      const newLengths = new Int32Array(this.capacity);
      newOffsets.set(this.opfsOffsets!);
      newLengths.set(this.opfsLengths!);
      this.opfsOffsets = newOffsets;
      this.opfsLengths = newLengths;
    }
  }

  add(sequence: string, annotations: Record<string, any>) {
    if (this.mode === "ram") {
      this.ramSequences.push({ sequence, annotations });
    } else {
      this.ensureCapacity();
      const bytes = new TextEncoder().encode(sequence);
      this.opfsFile.write(bytes, { at: this.opfsPtr });
      this.opfsOffsets![this.count] = BigInt(this.opfsPtr);
      this.opfsLengths![this.count] = bytes.length;
      this.opfsAnnotations[this.count] = annotations;
      this.opfsPtr += bytes.length;
    }
    this.count++;
  }

  get(index: number): IStoredSequence {
    if (this.mode === "ram") return this.ramSequences[index];
    
    const offset = Number(this.opfsOffsets![index]);
    const length = this.opfsLengths![index];
    const buffer = new Uint8Array(length);
    this.opfsFile.read(buffer, { at: offset });
    return {
      sequence: new TextDecoder().decode(buffer),
      annotations: this.opfsAnnotations[index]
    };
  }

  size() { return this.count; }

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
const _sortedIndices = new Map<string, number[]>();
let _querySequence: string = "";
let _consensusSequence: string = "";

// ---- helpers ---------------------------------------------------------------

function hammingDistanceStr(seq1: string, seq2: string): number {
  const minLen = Math.min(seq1.length, seq2.length);
  let dist = Math.abs(seq1.length - seq2.length);
  for (let i = 0; i < minLen; i++) {
    if (seq1[i] !== seq2[i]) dist++;
  }
  return dist;
}

const BLOSUM62_WORKER: Record<string, Record<string, number>> = {
  A:{A:4,R:-1,N:-2,D:-2,C:0,Q:-1,E:-1,G:0,H:-2,I:-1,L:-1,K:-1,M:-1,F:-2,P:-1,S:1,T:0,W:-3,Y:-2,V:0},
  R:{A:-1,R:5,N:0,D:-2,C:-3,Q:1,E:0,G:-2,H:0,I:-3,L:-2,K:2,M:-1,F:-3,P:-2,S:-1,T:-1,W:-3,Y:-2,V:-3},
  N:{A:-2,R:0,N:6,D:1,C:-3,Q:0,E:0,G:0,H:1,I:-3,L:-3,K:0,M:-2,F:-3,P:-2,S:1,T:0,W:-4,Y:-2,V:-3},
  D:{A:-2,R:-2,N:1,D:6,C:-3,Q:0,E:2,G:-1,H:-1,I:-3,L:-4,K:-1,M:-3,F:-3,P:-1,S:0,T:-1,W:-4,Y:-3,V:-3},
  C:{A:0,R:-3,N:-3,D:-3,C:9,Q:-3,E:-4,G:-3,H:-3,I:-1,L:-1,K:-3,M:-1,F:-2,P:-3,S:-1,T:-1,W:-2,Y:-2,V:-1},
  Q:{A:-1,R:1,N:0,D:0,C:-3,Q:5,E:2,G:-2,H:0,I:-3,L:-2,K:1,M:0,F:-3,P:-1,S:0,T:-1,W:-2,Y:-1,V:-2},
  E:{A:-1,R:0,N:0,D:2,C:-4,Q:2,E:5,G:-2,H:0,I:-3,L:-3,K:1,M:-2,F:-3,P:-1,S:0,T:-1,W:-3,Y:-2,V:-2},
  G:{A:0,R:-2,N:0,D:-1,C:-3,Q:-2,E:-2,G:6,H:-2,I:-4,L:-4,K:-2,M:-3,F:-3,P:-2,S:0,T:-2,W:-2,Y:-3,V:-3},
  H:{A:-2,R:0,N:1,D:-1,C:-3,Q:0,E:0,G:-2,H:8,I:-3,L:-3,K:-1,M:-2,F:-1,P:-2,S:-1,T:-2,W:-2,Y:2,V:-3},
  I:{A:-1,R:-3,N:-3,D:-3,C:-1,Q:-3,E:-3,G:-4,H:-3,I:4,L:2,K:-3,M:1,F:0,P:-3,S:-1,T:1,W:-3,Y:-1,V:3},
  L:{A:-1,R:-2,N:-3,D:-4,C:-1,Q:-2,E:-3,G:-4,H:-3,I:2,L:4,K:-2,M:2,F:0,P:-3,S:-2,T:-1,W:-2,Y:-1,V:1},
  K:{A:-1,R:2,N:0,D:-1,C:-3,Q:1,E:1,G:-2,H:-1,I:-3,L:-2,K:5,M:-1,F:-3,P:-1,S:0,T:-1,W:-3,Y:-2,V:-2},
  M:{A:-1,R:-1,N:-2,D:-3,C:-1,Q:0,E:-2,G:-3,H:-2,I:1,L:2,K:-1,M:5,F:0,P:-2,S:-1,T:-1,W:-1,Y:-1,V:1},
  F:{A:-2,R:-3,N:-3,D:-3,C:-2,Q:-3,E:-3,G:-3,H:-1,I:0,L:0,K:-3,M:0,F:6,P:-3,S:-2,T:-2,W:1,Y:3,V:-1},
  P:{A:-1,R:-2,N:-2,D:-1,C:-3,Q:-1,E:-1,G:-2,H:-2,I:-3,L:-3,K:-1,M:-2,F:-3,P:7,S:-1,T:-1,W:-4,Y:-3,V:-2},
  S:{A:1,R:-1,N:1,D:0,C:-1,Q:0,E:0,G:0,H:-1,I:-1,L:-2,K:0,M:-1,F:-2,P:-1,S:4,T:1,W:-3,Y:-2,V:0},
  T:{A:0,R:-1,N:0,D:-1,C:-1,Q:-1,E:-1,G:-2,H:-2,I:1,L:-1,K:-1,M:-1,F:-2,P:-1,S:1,T:5,W:-2,Y:-2,V:0},
  W:{A:-3,R:-3,N:-4,D:-4,C:-2,Q:-2,E:-3,G:-2,H:-2,I:-3,L:-2,K:-3,M:-1,F:1,P:-4,S:-3,T:-2,W:11,Y:2,V:-3},
  Y:{A:-2,R:-2,N:-2,D:-3,C:-2,Q:-1,E:-2,G:-3,H:2,I:-1,L:-1,K:-2,M:-1,F:3,P:-3,S:-2,T:-2,W:2,Y:7,V:-1},
  V:{A:0,R:-3,N:-3,D:-3,C:-1,Q:-2,E:-2,G:-3,H:-3,I:3,L:1,K:-2,M:1,F:-1,P:-2,S:0,T:0,W:-3,Y:-1,V:4},
};

function blosum62ScoreStr(seq1: string, seq2: string): number {
  const minLen = Math.min(seq1.length, seq2.length);
  let score = 0;
  for (let i = 0; i < minLen; i++) {
    const a = seq1[i].toUpperCase();
    const b = seq2[i].toUpperCase();
    const row = BLOSUM62_WORKER[a];
    if (row && b in row) score += row[b];
  }
  return score;
}

function getSortedIndices(sortKey: string): number[] | undefined {
  if (sortKey === "as-input") return undefined;
  if (_sortedIndices.has(sortKey)) return _sortedIndices.get(sortKey);

  const indices = [...Array(_storage.size()).keys()];
  if (sortKey === "hamming-dist-to-query") {
    indices.sort((a, b) => hammingDistanceStr(_storage.get(a).sequence, _querySequence) - hammingDistanceStr(_storage.get(b).sequence, _querySequence));
  } else if (sortKey === "hamming-dist-to-consensus") {
    indices.sort((a, b) => hammingDistanceStr(_storage.get(a).sequence, _consensusSequence) - hammingDistanceStr(_storage.get(b).sequence, _consensusSequence));
  } else if (sortKey === "blosum-score-to-query") {
    indices.sort((a, b) => blosum62ScoreStr(_storage.get(b).sequence, _querySequence) - blosum62ScoreStr(_storage.get(a).sequence, _querySequence));
  } else if (sortKey === "blosum-score-to-consensus") {
    indices.sort((a, b) => blosum62ScoreStr(_storage.get(b).sequence, _consensusSequence) - blosum62ScoreStr(_storage.get(a).sequence, _consensusSequence));
  }
  _sortedIndices.set(sortKey, indices);
  return indices;
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

function fnv1a32(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  return h;
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
  
  // Collect unique chars from what we have
  const allUniqueCharCodes: Record<number, boolean> = {};
  // Only check first few for NT prediction speed
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

self.onmessage = async (
  event: MessageEvent<
    | { type: "parse"; file: File | null; url?: string; alignmentName?: string; removeDuplicateSequences: boolean }
    | { type: "getSlice"; start: number; end: number; requestId: number; sortKey?: string }
  >
) => {
  const msg = event.data;

  if (msg.type === "getSlice") {
    const { start, end, requestId, sortKey = "as-input" } = msg;
    const sortedIndices = getSortedIndices(sortKey);
    const clampedEnd = Math.min(end, _storage.size());
    const slice: IStoredSequence[] = [];
    
    for (let i = start; i < clampedEnd; i++) {
      slice.push(_storage.get(sortedIndices ? sortedIndices[i] : i));
    }

    self.postMessage({
      type: "slice",
      requestId,
      sequences: slice.map(s => s.sequence),
      annotations: slice.map(s => s.annotations),
    });
    return;
  }

  if (msg.type !== "parse") return;

  const { file, url, alignmentName, removeDuplicateSequences } = msg;
  _storage.clear();
  _sortedIndices.clear();

  try {
    await _storage.initialize(true); // Attempt to use disk storage

    let stream: ReadableStream<Uint8Array>;
    let fileName = alignmentName || (file ? file.name : "alignment");

    if (file) {
      postProgress("Reading file…");
      stream = file.stream();
    } else if (url) {
      postProgress("Connecting…");
      let resp: Response;
      try {
        resp = await fetch(url);
      } catch (e) {
        const err = e as Error;
        const isLocalhost = url.includes("localhost") || url.includes("127.0.0.1");
        throw Object.assign(
          new Error(err.message === "Failed to fetch" ? "Connection Blocked or Severed" : err.message), 
          { 
            name: "Fetch Error",
            errors: [{ 
              name: "Detail", 
              message: isLocalhost 
                ? "The browser could not complete the request. This is usually a CORS issue or the server closing the connection prematurely (check your 'defer body.Close()' usage)."
                : "Could not connect to the server. Check your connection and CORS settings."
            }] 
          }
        );
      }

      if (!resp.ok) {
        let errorMessage = `Server returned ${resp.status} ${resp.statusText}`;
        try {
          const responseClone = resp.clone();
          const errorJson = await responseClone.json();
          errorMessage = errorJson.msg || errorJson.error || errorJson.message || errorMessage;
        } catch (e) {}
        throw Object.assign(new Error(errorMessage), { name: "Fetch Error" });
      }
      stream = resp.body!;
      postProgress("Reading stream…");
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

    // ---- Parsing Loop ------------------------------------------------------
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
      const consensusSeq = positionalLetterCounts.map(([, lc]) => 
        Object.entries(lc).sort((a,b) => b[1] - a[1])[0]?.[0] ?? "-"
      ).join("");
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

    const finalStats = getPartialStats();
    self.postMessage({ type: "done", data: buildQuickMetadata(fileName, removeDuplicateSequences, finalStats) });
    _querySequence = _storage.get(0).sequence;
    _consensusSequence = finalStats?.consensus.sequence ?? _querySequence;

  } catch (e: any) {
    const isMidway = _storage.size() > 0;
    self.postMessage({
      type: "error",
      name: isMidway ? "Stream Interrupted" : (e.name ?? "Error"),
      message: isMidway ? `Connection lost after ${_storage.size()} sequences.` : e.message || String(e),
      errors: [{ name: "Detail", message: e.message || String(e) }],
    });
  }
};
