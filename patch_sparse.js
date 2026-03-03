const fs = require('fs');
let code = fs.readFileSync('src/webworkers/AlignmentParserWorker.ts', 'utf8');

const declarations = `
let _storage = new SequenceStorage();
const _sortedIndicesCache = new Map<string, Int32Array>();
let _currentSort: { key: string, scores: Float32Array, target: Uint8Array, isBlosum: boolean, startIdx: number } | null = null;
let _querySequence: string = "";
let _consensusSequence: string = "";

// ---- Sparse Mode -----------------------------------------------------------
let _sparseMode = false;
let _sparseUrl = "";
let _sparseContentLength = 0;
let _sparseAvgBytesPerSeq = 300;
let _sparseEstimatedSequenceCount = 0;

async function fetchSparseChunk(url: string, startByte: number, endByte: number): Promise<string> {
    const resp = await fetch(url, { headers: { "Range": \`bytes=\${startByte}-\${endByte}\` } });
    return resp.text();
}

async function parseSparseChunkText(text: string, isLastChunk: boolean): Promise<{ sequences: string[], annotations: any[] }> {
    const firstGt = text.indexOf(">");
    if (firstGt === -1) return { sequences: [], annotations: [] };
    
    const validText = text.substring(firstGt);
    const lines = validText.split("\\n");
    
    const sequences: string[] = [];
    const annotations: any[] = [];
    
    let currentHeader: string | null = null;
    let currentParts: string[] = [];
    
    const flush = () => {
        if (!currentHeader) return;
        const sequence = currentParts.join("");
        sequences.push(sequence);
        annotations.push(parseSeqAnnotations(currentHeader.split(/\\s+/)[0], sequence));
        currentParts = [];
    };
    
    // Process all lines except the last one which might be truncated
    for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i].replace(/\\r$/, "");
        if (line.startsWith(">")) {
            flush();
            currentHeader = line.slice(1);
        } else if (currentHeader) {
            currentParts.push(line.trim());
        }
    }
    
    if (isLastChunk) {
        const line = lines[lines.length - 1].replace(/\\r$/, "");
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
`;
code = code.replace(/let _storage = new SequenceStorage\(\);\nconst _sortedIndicesCache = new Map<string, Int32Array>\(\);\nlet _currentSort.*?= null;\nlet _querySequence: string = "";\nlet _consensusSequence: string = "";/s, declarations.trim());

fs.writeFileSync('src/webworkers/AlignmentParserWorker.ts', code);
