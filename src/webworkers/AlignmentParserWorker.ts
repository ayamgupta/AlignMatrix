/* eslint-disable no-restricted-globals */
/**
 * AlignmentParserWorker
 * ---------------------
 * Runs inside a Web Worker. Receives a File object, streams + parses it
 * line-by-line (no full-file string), runs all statistics computation, then
 * postMessages the pre-computed metadata back to the main thread.
 *
 * IMPORTANT: The sequences array is kept INSIDE the worker and never
 * transferred to the main thread in bulk. Instead, the main thread can
 * request slices on demand via getSlice messages. This prevents the
 * OOM crash that occurred when trying to clone/transfer millions of sequences.
 *
 * Message protocol
 * ----------------
 *   IN  { type: "parse",    file: File, removeDuplicateSequences: boolean }
 *   IN  { type: "getSlice", start: number, end: number, requestId: number }
 *       → requests sequences[start..end) (exclusive end)
 *
 *   OUT { type: "progress", message: string }
 *     | { type: "done",     data: IWorkerMetadata }   ← no sequences!
 *     | { type: "slice",    requestId: number, sequences: string[], annotations: any[] }
 *     | { type: "error",    name: string, message: string }
 */

// ---- types -----------------------------------------------------------------

/** Metadata sent to main thread after parsing (no sequences). */
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

// ---- annotation field names -----------------------------------------------

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

// ---- Worker state ----------------------------------------------------------

// Sequences are kept here permanently — never sent to main thread in bulk.
let _sequences: Array<{ sequence: string; annotations: Record<string, any> }> = [];

// Pre-computed sorted index arrays, keyed by sort key string.
// Built lazily on first getSlice for each sort key.
// "as-input" is the identity mapping and is never stored (use _sequences directly).
const _sortedIndices = new Map<string, number[]>();

// Query and consensus sequences stored at worker level for sort computations.
let _querySequence: string = "";
let _consensusSequence: string = "";

// ---- helpers ---------------------------------------------------------------

// Sort helpers (mirrors AlignmentSorter.ts but runs inside the worker
// where all sequences live, without needing an Alignment object).

function hammingDistanceStr(seq1: string, seq2: string): number {
  const minLen = Math.min(seq1.length, seq2.length);
  let dist = Math.abs(seq1.length - seq2.length);
  for (let i = 0; i < minLen; i++) {
    if (seq1[i] !== seq2[i]) dist++;
  }
  return dist;
}

// Minimal BLOSUM62 needed for sort — duplicated here because the worker
// cannot import from the main-thread module tree.
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
  I:{A:-1,R:-3,N:-3,D:-3,C:-1,Q:-3,E:-3,G:-4,H:-3,I:4,L:2,K:-3,M:1,F:0,P:-3,S:-2,T:-1,W:-3,Y:-1,V:3},
  L:{A:-1,R:-2,N:-3,D:-4,C:-1,Q:-2,E:-3,G:-4,H:-3,I:2,L:4,K:-2,M:2,F:0,P:-3,S:-2,T:-1,W:-2,Y:-1,V:1},
  K:{A:-1,R:2,N:0,D:-1,C:-3,Q:1,E:1,G:-2,H:-1,I:-3,L:-2,K:5,M:-1,F:-3,P:-1,S:0,T:-1,W:-3,Y:-2,V:-2},
  M:{A:-1,R:-1,N:-2,D:-3,C:-1,Q:0,E:-2,G:-3,H:-2,I:1,L:2,K:-1,M:5,F:0,P:-2,S:-1,T:-1,W:-1,Y:-1,V:1},
  F:{A:-2,R:-3,N:-3,D:-3,C:-2,Q:-3,E:-3,G:-3,H:-1,I:0,L:0,K:-3,M:0,F:6,P:-4,S:-2,T:-2,W:1,Y:3,V:-1},
  P:{A:-1,R:-2,N:-2,D:-1,C:-3,Q:-1,E:-1,G:-2,H:-2,I:-3,L:-3,K:-1,M:-2,F:-4,P:7,S:-1,T:-1,W:-4,Y:-3,V:-2},
  S:{A:1,R:-1,N:1,D:0,C:-1,Q:0,E:0,G:0,H:-1,I:-2,L:-2,K:0,M:-1,F:-2,P:-1,S:4,T:1,W:-3,Y:-2,V:-2},
  T:{A:0,R:-1,N:0,D:-1,C:-1,Q:-1,E:-1,G:-2,H:-2,I:-1,L:-1,K:-1,M:-1,F:-2,P:-1,S:1,T:5,W:-2,Y:-2,V:0},
  W:{A:-3,R:-3,N:-4,D:-4,C:-2,Q:-2,E:-3,G:-2,H:-2,I:-3,L:-2,K:-3,M:-1,F:1,P:-4,S:-3,T:-2,W:11,Y:2,V:-3},
  Y:{A:-2,R:-2,N:-2,D:-3,C:-2,Q:-1,E:-2,G:-3,H:2,I:-1,L:-1,K:-2,M:-1,F:3,P:-3,S:-2,T:-2,W:2,Y:7,V:-1},
  V:{A:0,R:-3,N:-3,D:-3,C:-1,Q:-2,E:-2,G:-3,H:-3,I:3,L:1,K:-2,M:1,F:-1,P:-2,S:-2,T:0,W:-3,Y:-1,V:4},
};

function blosumScoreStr(seq1: string, ref: string): number {
  const minLen = Math.min(seq1.length, ref.length);
  let score = 0;
  for (let i = 0; i < minLen; i++) {
    const a = seq1[i], b = ref[i];
    if (BLOSUM62_WORKER[a]?.[b] !== undefined) score += BLOSUM62_WORKER[a][b];
  }
  return score;
}

/**
 * Build a sorted index array for the given sort key.
 * Returns indices into _sequences[] in the requested sort order.
 */
function buildSortedIndices(sortKey: string): number[] {
  const indices = _sequences.map((_, i) => i);
  if (sortKey === "as-input") return indices; // identity — caller handles this

  if (sortKey === "hamming-dist-to-query") {
    return indices.sort((a, b) =>
      hammingDistanceStr(_sequences[a].sequence, _querySequence) -
      hammingDistanceStr(_sequences[b].sequence, _querySequence)
    );
  }
  if (sortKey === "hamming-dist-to-consensus") {
    return indices.sort((a, b) =>
      hammingDistanceStr(_sequences[a].sequence, _consensusSequence) -
      hammingDistanceStr(_sequences[b].sequence, _consensusSequence)
    );
  }
  if (sortKey === "blosum-score-to-query") {
    return indices.sort((a, b) =>
      blosumScoreStr(_sequences[b].sequence, _querySequence) -
      blosumScoreStr(_sequences[a].sequence, _querySequence) // descending
    );
  }
  if (sortKey === "blosum-score-to-consensus") {
    return indices.sort((a, b) =>
      blosumScoreStr(_sequences[b].sequence, _consensusSequence) -
      blosumScoreStr(_sequences[a].sequence, _consensusSequence) // descending
    );
  }
  // Unknown sort key — fall back to input order
  return indices;
}

/**
 * Get (or lazily build) the sorted index array for a sort key.
 */
function getSortedIndices(sortKey: string): number[] | null {
  if (sortKey === "as-input" || !sortKey) return null; // null = use _sequences directly
  if (!_sortedIndices.has(sortKey)) {
    _sortedIndices.set(sortKey, buildSortedIndices(sortKey));
  }
  return _sortedIndices.get(sortKey)!;
}

function generateUUID(): string {
  const x = (([1e7] as any) + -1e3 + -4e3 + -8e3 + -1e11) as string;
  return x.replace(/[018]/g, (c: string) =>
    (
      parseInt(c) ^
      (self.crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (parseInt(c) / 4)))
    ).toString(16)
  );
}

function isGapChar(c: string): boolean {
  return c === "-" || c === ".";
}

function calcSeqLengths(seq: string) {
  let realLength = 0, gapCount = 0, leftGapCount = 0, internalGapCount = 0;
  let internal = false;
  for (let i = 0; i < seq.length; i++) {
    if (isGapChar(seq[i])) {
      gapCount++;
    } else {
      realLength++;
      if (!internal) {
        internal = true;
        leftGapCount = gapCount;
        gapCount = 0;
      } else if (gapCount > 0) {
        internalGapCount += gapCount;
        gapCount = 0;
      }
    }
  }
  const rightGapCount = gapCount;
  const alignedLength = seq.length - leftGapCount - rightGapCount;
  return { realLength, alignedLength, leftGapCount, internalGapCount, rightGapCount };
}

function parseSeqAnnotations(
  id: string,
  sequence: string,
  desc?: string
): Record<string, any> {
  const {
    realLength, alignedLength, leftGapCount, internalGapCount, rightGapCount,
  } = calcSeqLengths(sequence);

  let actualId = id, begin = 1, end = realLength;
  const m = id.match(/^([^/]*)\/(\d+)-(\d+)$/);
  if (m) { actualId = m[1]; begin = Number(m[2]); end = Number(m[3]); }

  const ann: Record<string, any> = {
    [AF.ID]: id, [AF.ACTUAL_ID]: actualId,
    [AF.BEGIN]: begin, [AF.END]: end, [AF.LINK]: undefined,
    [AF.REAL_LENGTH]: realLength, [AF.ALIGNED_LENGTH]: alignedLength,
    [AF.LEFT_GAP_COUNT]: leftGapCount, [AF.INTERNAL_GAP_COUNT]: internalGapCount,
    [AF.RIGHT_GAP_COUNT]: rightGapCount,
  };
  if (desc) ann[AF.DESCRIPTION] = desc;
  return ann;
}

function formatFieldName(fieldName: string): string {
  let s = fieldName.replace(/@/g, "").trim();
  s = s.charAt(0).toUpperCase() + s.slice(1);
  s = s.replace(/([a-z])([A-Z])/g, "$1 $2");
  s = s.replace(/([A-Z])([A-Z][a-z])/g, "$1 $2");
  return s;
}

function postProgress(message: string) {
  self.postMessage({ type: "progress", message });
}

/** FNV-1a 32-bit hash for duplicate detection. */
function fnv1a32(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (Math.imul(h, 0x01000193)) >>> 0;
  }
  return h;
}

// ---- streaming line reader -------------------------------------------------

async function* streamToLines(
  stream: ReadableStream<Uint8Array>
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

// ---- duplicate detection ---------------------------------------------------

function deduplicateSequences(
  sequences: Array<{ sequence: string; annotations: Record<string, any> }>,
  removeDuplicates: boolean
): {
  finalSequences: Array<{ sequence: string; annotations: Record<string, any> }>;
  numberDuplicates: number;
} {
  postProgress("Deduplicating sequences…");
  const hashToIndices = new Map<number, number[]>();
  const isDuplicate = new Uint8Array(sequences.length);
  let numberDuplicates = 0;

  for (let i = 0; i < sequences.length; i++) {
    const hash = fnv1a32(sequences[i].sequence);
    const existing = hashToIndices.get(hash);
    if (!existing) {
      hashToIndices.set(hash, [i]);
    } else {
      let foundDupe = false;
      for (const j of existing) {
        if (sequences[j].sequence === sequences[i].sequence) {
          foundDupe = true;
          break;
        }
      }
      if (foundDupe) {
        isDuplicate[i] = 1;
        numberDuplicates++;
      } else {
        existing.push(i);
      }
    }
  }

  const finalSequences = removeDuplicates
    ? sequences.filter((_, i) => isDuplicate[i] === 0)
    : sequences;

  return { finalSequences, numberDuplicates };
}

// ---- FASTA parser ----------------------------------------------------------

async function parseFastaIntoWorker(
  lineIter: AsyncIterable<string>
): Promise<void> {
  _sequences = []; // reset — no second copy ever allocated
  let currentHeader: string | null = null;
  let currentParts: string[] = [];
  let sawFirst = false;

  const flush = () => {
    if (currentHeader === null) return;
    const groups = currentHeader
      .match(/^\s*(?<id>\S+)(?:\s+(?<description>.+\S+)\s*)?$/)
      ?.groups;
    if (groups) {
      const sequence = currentParts.join("");
      _sequences.push({
        sequence,
        annotations: parseSeqAnnotations(groups.id, sequence, groups.description),
      });
      if (_sequences.length % 50000 === 0) {
        postProgress(`Parsing… ${_sequences.length.toLocaleString()} sequences read`);
      }
    }
    currentParts = [];
  };

  for await (const rawLine of lineIter) {
    const line = rawLine.replace(/\r$/, "");
    if (line.startsWith(">")) {
      sawFirst = true;
      flush();
      currentHeader = line.slice(1);
    } else if (currentHeader !== null) {
      const t = line.trim();
      if (t) currentParts.push(t);
    } else if (!sawFirst && line.trim()) {
      throw Object.assign(new Error("File needs to begin with '>'"), { name: "Fasta Parse Error" });
    }
  }
  flush();

  if (_sequences.length === 0) {
    throw Object.assign(new Error("No sequences found in file"), { name: "Fasta Parse Error" });
  }
}

// ---- Stockholm parser ------------------------------------------------------

async function parseStockholmIntoWorker(
  lineIter: AsyncIterable<string>
): Promise<void> {
  _sequences = []; // reset — no second copy ever allocated
  const GS: Record<string, Record<string, string[]>> = {};
  let lineIdx = 0;
  let sawFooter = false;

  for await (const rawLine of lineIter) {
    const line = rawLine.replace(/\r$/, "").trim();
    if (lineIdx === 0) {
      if (!line.startsWith("# STOCKHOLM 1.0")) {
        throw Object.assign(new Error("First line must be '# STOCKHOLM 1.0'"), { name: "Stockholm Parse Error" });
      }
      lineIdx++;
      continue;
    }
    if (line === "//") { sawFooter = true; break; }
    if (!line) { lineIdx++; continue; }

    if (!line.startsWith("#")) {
      const m = line.match(/^(\S+)\s(.*)/);
      if (m) {
        const id = m[1].trim();
        _sequences.push({
          annotations: { [AF.ID]: id, [AF.ACTUAL_ID]: id },
          sequence: m[2].trim(),
        });
        if (_sequences.length % 50000 === 0) {
          postProgress(`Parsing… ${_sequences.length.toLocaleString()} sequences read`);
        }
      }
    } else if (line.length >= 8 && line.startsWith("#=GS")) {
      const rest = line.substr(5).trim();
      const kv = rest.match(/^(\S+)\s(.*)/)?.slice(1);
      if (kv) {
        const seqId = kv[0];
        const fv = kv[1].trim().match(/^(\S+)\s(.*)/)?.slice(1);
        if (fv) {
          if (!GS[seqId]) GS[seqId] = {};
          if (!GS[seqId][fv[0]]) GS[seqId][fv[0]] = [];
          GS[seqId][fv[0]].push(fv[1]);
        }
      }
    }
    lineIdx++;
  }

  if (!sawFooter) {
    throw Object.assign(new Error("Last line must be '//'"), { name: "Stockholm Parse Error" });
  }

  // Apply GS annotations in-place — no second array needed
  for (const seq of _sequences) {
    const id = seq.annotations[AF.ID] as string;
    const desc = GS[id]?.["DE"]?.join("") ?? "";
    Object.assign(seq.annotations, parseSeqAnnotations(id, seq.sequence, desc));
    if (GS[id]) {
      for (const key of Object.keys(GS[id])) {
        if (key !== "DE") seq.annotations[key] = GS[id][key].join(" ");
      }
    }
  }

  if (_sequences.length === 0) {
    throw Object.assign(new Error("No sequences found in file"), { name: "Stockholm Parse Error" });
  }
}

// ---- stats builder ---------------------------------------------------------

/**
 * Fast metadata build: deduplication + length check only.
 * Does NOT compute positional letter counts or consensus.
 * Returns immediately so the viewer can render.
 */
function buildQuickMetadata(
  fileName: string,
  removeDuplicateSequences: boolean
): IWorkerMetadata {
  // _sequences already populated by the parser (no second copy ever created).
  const { finalSequences, numberDuplicates } = deduplicateSequences(
    _sequences, removeDuplicateSequences
  );

  // ---- A3M / unequal-length normalization --------------------------------
  // A3M files have sequences of different lengths because insertion columns
  // (lowercase letters) appear only in sequences that have them.
  // We keep ALL characters (including lowercase) and pad shorter sequences
  // with trailing "-" gaps to match the longest sequence length.
  const lengths0: Record<string, boolean> = {};
  for (const seq of finalSequences) lengths0[seq.sequence.length] = true;

  if (Object.keys(lengths0).length > 1) {
    const maxLen = Math.max(...Object.keys(lengths0).map(Number));
    postProgress(
      `A3M format detected — padding ${finalSequences.length.toLocaleString()} sequences to length ${maxLen}…`
    );
    for (let i = 0; i < finalSequences.length; i++) {
      const seq = finalSequences[i].sequence;
      if (seq.length < maxLen) {
        finalSequences[i] = {
          ...finalSequences[i],
          sequence: seq + "-".repeat(maxLen - seq.length),
        };
      }
    }
  }

  // Store sequences in worker-level variable for slice serving.
  // Also clear any cached sort indices from a previous file, and store
  // query/consensus so sort functions can reference them.
  _sequences = finalSequences;
  _sortedIndices.clear();
  _querySequence = finalSequences[0]?.sequence ?? "";
  // Consensus is computed later in buildStats; use query as placeholder for now.
  // It will be updated after stats arrive via the "stats" message path below.
  _consensusSequence = _querySequence;

  const lengths: Record<string, boolean> = {};
  for (const seq of finalSequences) lengths[seq.sequence.length] = true;
  if (Object.keys(lengths).length > 1) {
    throw new Error(
      "Alignment sequences must all be the same length, but multiple lengths observed: " +
        Object.keys(lengths).join(", ")
    );
  }
  const maxSequenceLength = finalSequences.length > 0 ? finalSequences[0].sequence.length : 0;

  // Quick pass: just collect unique chars (no counting)
  const allUniqueCharCodes: Record<number, boolean> = {};
  for (const seq of finalSequences) {
    for (let i = 0; i < seq.sequence.length; i++) {
      allUniqueCharCodes[seq.sequence.charCodeAt(i)] = true;
    }
  }
  const allUniqueChars = Object.keys(allUniqueCharCodes).map(cc => String.fromCharCode(Number(cc)));

  const NT_CODES = new Set("ATGCUNRYSWKMBDHVatgcunryswkmbdhv-.");
  const predictedNT = allUniqueChars.every(c => NT_CODES.has(c));
  const allUpperAlpha = allUniqueChars.filter(c => /[A-Z]/.test(c)).sort();

  const annotationFields: Record<string, { key: string; name: string }> = {};
  for (const seq of finalSequences) {
    for (const field of Object.keys(seq.annotations)) {
      if (!(field in annotationFields)) {
        annotationFields[field] = { key: field, name: formatFieldName(field) };
      }
    }
  }

  // Use first sequence as a stand-in consensus until real stats arrive
  const placeholderConsensus = finalSequences[0]?.sequence ?? "";

  return {
    name: fileName,
    uuid: generateUUID(),
    sequenceCount: finalSequences.length,
    maxSequenceLength,
    predictedNT,
    numberDuplicateSequencesInAlignment: removeDuplicateSequences ? 0 : numberDuplicates,
    numberRemovedDuplicateSequences: removeDuplicateSequences ? numberDuplicates : 0,
    querySequence: finalSequences[0]
      ? { ...finalSequences[0] }
      : { sequence: "", annotations: { [AF.ID]: "query", [AF.ACTUAL_ID]: "query" } },
    consensus: {
      annotations: { [AF.ID]: "consensus", [AF.ACTUAL_ID]: "consensus" },
      sequence: placeholderConsensus,
    },
    allRepresentedCharacters: allUniqueChars,
    allUpperAlphaLettersInAlignmentSorted: allUpperAlpha,
    positionalLetterCounts: [],   // empty until stats arrive
    globalAlphaLetterCounts: {},  // empty until stats arrive
    annotationFields,
  };
}

/**
 * Slow stats build: computes positional letter counts and true consensus.
 * Called after "done" is already sent, so it doesn't delay the viewer.
 */
function buildStats(
  finalSequences: Array<{ sequence: string; annotations: Record<string, any> }>,
  maxSequenceLength: number
): {
  positionalLetterCounts: [number, Record<string, number>][];
  globalAlphaLetterCounts: Record<string, number>;
  consensus: { sequence: string; annotations: Record<string, any> };
} {
  postProgress(
    `Computing statistics for ${finalSequences.length.toLocaleString()} sequences × ${maxSequenceLength.toLocaleString()} positions…`
  );

  const allUniqueCharCodes: Record<number, boolean> = {};
  for (const seq of finalSequences) {
    for (let i = 0; i < seq.sequence.length; i++) {
      allUniqueCharCodes[seq.sequence.charCodeAt(i)] = true;
    }
  }
  const charCodeList = Object.keys(allUniqueCharCodes).map(Number);
  const numChars = charCodeList.length;
  const charCodeToIdx = new Map<number, number>();
  charCodeList.forEach((cc, idx) => charCodeToIdx.set(cc, idx));
  const allUniqueChars = charCodeList.map(cc => String.fromCharCode(cc));

  const flatCounts = new Float64Array(maxSequenceLength * numChars);
  const globalCounts = new Float64Array(numChars);

  for (let si = 0; si < finalSequences.length; si++) {
    const s = finalSequences[si].sequence;
    for (let pi = 0; pi < s.length; pi++) {
      const charIdx = charCodeToIdx.get(s.charCodeAt(pi));
      if (charIdx !== undefined) {
        flatCounts[pi * numChars + charIdx]++;
        globalCounts[charIdx]++;
      }
    }
    if (si > 0 && si % 100000 === 0) {
      postProgress(
        `Computing statistics… ${si.toLocaleString()} / ${finalSequences.length.toLocaleString()} sequences`
      );
    }
  }

  const positionalLetterCounts: [number, Record<string, number>][] = [];
  for (let pi = 0; pi < maxSequenceLength; pi++) {
    const lc: Record<string, number> = {};
    const base = pi * numChars;
    for (let ci = 0; ci < numChars; ci++) {
      const count = flatCounts[base + ci];
      if (count > 0) lc[allUniqueChars[ci]] = count;
    }
    positionalLetterCounts.push([pi, lc]);
  }

  const globalAlphaLetterCounts: Record<string, number> = {};
  for (let ci = 0; ci < numChars; ci++) {
    if (globalCounts[ci] > 0) globalAlphaLetterCounts[allUniqueChars[ci]] = globalCounts[ci];
  }

  postProgress("Computing consensus sequence…");
  const consensusSeq = positionalLetterCounts
    .map(([, lc]) =>
      Object.entries(lc)
        .sort((a, b) => {
          const aU = /[A-Z]/.test(a[0]), bU = /[A-Z]/.test(b[0]);
          const aL = /[a-z]/.test(a[0]), bL = /[a-z]/.test(b[0]);
          if (aU === bU && aL === bL) return b[1] - a[1];
          return aU ? -1 : bU ? 1 : aL ? -1 : bL ? 1 : 0;
        })
        .map(e => e[0])[0] ?? "-"
    )
    .join("");

  postProgress("Statistics ready.");

  return {
    positionalLetterCounts,
    globalAlphaLetterCounts,
    consensus: {
      annotations: { [AF.ID]: "consensus", [AF.ACTUAL_ID]: "consensus" },
      sequence: consensusSeq,
    },
  };
}

// ---- Worker entry point ----------------------------------------------------

self.onmessage = async (
  event: MessageEvent<
    | { type: "parse"; file: File; removeDuplicateSequences: boolean }
    | { type: "getSlice"; start: number; end: number; requestId: number; sortKey?: string }
  >
) => {
  const msg = event.data;

  // ---- slice request (served from in-worker sequences array) ---------------
  if (msg.type === "getSlice") {
    const { start, end, requestId, sortKey = "as-input" } = msg;
    const sortedIndices = getSortedIndices(sortKey);

    let slice: Array<{ sequence: string; annotations: Record<string, any> }>;
    if (sortedIndices) {
      // Serve rows in sorted order
      const clampedEnd = Math.min(end, sortedIndices.length);
      slice = sortedIndices.slice(start, clampedEnd).map(i => _sequences[i]);
    } else {
      // "as-input" order — serve directly
      const clampedEnd = Math.min(end, _sequences.length);
      slice = _sequences.slice(start, clampedEnd);
    }

    self.postMessage({
      type: "slice",
      requestId,
      sequences: slice.map(s => s.sequence),
      annotations: slice.map(s => s.annotations),
    });
    return;
  }

  // ---- parse request -------------------------------------------------------
  if (msg.type !== "parse") return;

  const { file, removeDuplicateSequences } = msg;
  _sequences = []; // reset

  try {
    postProgress("Reading file…");

    const lineIter = streamToLines(file.stream());
    const iter = lineIter[Symbol.asyncIterator]();

    // peek first non-empty line to detect format
    let firstLine = "";
    let firstResult: IteratorResult<string> = { value: "", done: true };
    while (true) {
      firstResult = await iter.next();
      if (firstResult.done) break;
      const t = firstResult.value.replace(/\r$/, "").trim();
      if (t) { firstLine = t; break; }
    }

    if (!firstLine) {
      throw Object.assign(new Error("The file appears to be empty"), { name: "File Error" });
    }

    async function* prepended(): AsyncIterable<string> {
      yield firstResult.value;
      while (true) {
        const r = await iter.next();
        if (r.done) break;
        yield r.value;
      }
    }

    if (firstLine.startsWith("# STOCKHOLM")) {
      postProgress("Detected Stockholm format. Parsing…");
      await parseStockholmIntoWorker(prepended());
    } else if (firstLine.startsWith(">")) {
      postProgress("Detected FASTA format. Parsing…");
      await parseFastaIntoWorker(prepended());
    } else {
      throw Object.assign(
        new Error("Unrecognised format (first line is neither '>' nor '# STOCKHOLM 1.0')"),
        { name: "Parse Error" }
      );
    }

    postProgress("Parsing complete. Preparing viewer…");

    // --- Phase 1: send "done" immediately so the viewer can render ---
    // We build minimal metadata first (no positional counts, no consensus)
    // so the UI appears without waiting for the full stats computation.
    const quickMeta = buildQuickMetadata(file.name, removeDuplicateSequences);
    postProgress("Done.");
    self.postMessage({ type: "done", data: quickMeta });

    // --- Phase 2: compute full stats in the background ---
    // This runs after the viewer is already showing, so it doesn't block loading.
    setTimeout(async () => {
      try {
        const stats = buildStats(_sequences, quickMeta.maxSequenceLength);
        // Update consensus now that we have the real one, and invalidate any
        // consensus-based sort caches that were built with the placeholder.
        _consensusSequence = stats.consensus.sequence;
        _sortedIndices.delete("hamming-dist-to-consensus");
        _sortedIndices.delete("blosum-score-to-consensus");
        self.postMessage({ type: "stats", data: stats });
      } catch(e: any) {
        // Stats failure is non-fatal — viewer already works without them
        console.warn("Stats computation failed:", e);
      }
    }, 0);
  } catch (e: any) {
    _sequences = [];
    self.postMessage({
      type: "error",
      name: e.name ?? "Error",
      message: e.message ?? String(e),
      errors: e.errors,
      possibleResolution: e.possibleResolution,
    });
  }
};
