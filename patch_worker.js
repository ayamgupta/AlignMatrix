const fs = require('fs');
let code = fs.readFileSync('src/webworkers/AlignmentParserWorker.ts', 'utf8');

// Update buildQuickMetadata
code = code.replace(/sequenceCount: _storage\.size\(\),/g, 'sequenceCount: _sparseMode ? _sparseEstimatedSequenceCount : _storage.size(),');

// Update getSlice
code = code.replace(
`    if (msg.type === "getSlice") {
      const { start, end, requestId, sortKey = "as-input" } = msg;
      const currentSize = _storage.size();`,
`    if (msg.type === "getSlice") {
      const { start, end, requestId, sortKey = "as-input" } = msg;
      
      if (_sparseMode && sortKey === "as-input") {
        const byteStart = Math.max(0, Math.floor(start * _sparseAvgBytesPerSeq) - 2000);
        const actualStart = start === 0 ? 0 : byteStart;
        const byteEnd = Math.min(_sparseContentLength - 1, Math.floor(end * _sparseAvgBytesPerSeq) + 10000);
        
        fetchSparseChunk(_sparseUrl, actualStart, byteEnd).then(text => parseSparseChunkText(text, byteEnd === _sparseContentLength - 1)).then(({ sequences, annotations }) => {
           const numRequested = end - start;
           self.postMessage({ type: "slice", requestId, sequences: sequences.slice(0, numRequested), annotations: annotations.slice(0, numRequested) });
        }).catch(e => {
           self.postMessage({ type: "slice", requestId, sequences: [], annotations: [] });
        });
        return;
      }

      const currentSize = _sparseMode ? _sparseEstimatedSequenceCount : _storage.size();`
);

// Update parse logic
const parseStart = 
`    if (file) {
      postProgress("Reading file…");
      stream = file.stream();
    } else if (url) {
      postProgress("Connecting…");
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(\`Server returned \${resp.status}\`);
      stream = resp.body!;
    } else throw new Error("No file or URL provided");`;

const parseReplacement = 
`    if (file) {
      postProgress("Reading file…");
      stream = file.stream();
    } else if (url) {
      postProgress("Connecting…");
      
      let useRange = false;
      let rangeResp: Response | null = null;
      try {
        rangeResp = await fetch(url, { headers: { "Range": "bytes=0-1048575" } });
        if (rangeResp.status === 206) {
          useRange = true;
        } else if (!rangeResp.ok && rangeResp.status !== 416) {
           throw new Error(\`Server returned \${rangeResp.status}\`);
        }
      } catch (e) {}

      if (useRange && rangeResp) {
        _sparseUrl = rangeResp.url || url;
        const contentRange = rangeResp.headers.get("Content-Range");
        if (contentRange) {
           const match = contentRange.match(/\\/(\\d+)$/);
           if (match) _sparseContentLength = Number(match[1]);
        }
        if (_sparseContentLength) {
           _sparseMode = true;
        }
      }

      if (_sparseMode && rangeResp) {
         postProgress("Fetching initial chunk…");
         const text = await rangeResp.text();
         const { sequences } = await parseSparseChunkText(text, _sparseContentLength <= 1048576);
         
         if (sequences.length > 0) {
            const textBytes = new TextEncoder().encode(text).length;
            _sparseAvgBytesPerSeq = textBytes / sequences.length;
            _sparseEstimatedSequenceCount = Math.floor(_sparseContentLength / _sparseAvgBytesPerSeq);
         } else {
            _sparseMode = false;
         }
         
         if (_sparseMode) {
             stream = new ReadableStream({
                 start(controller) {
                     controller.enqueue(new TextEncoder().encode(text));
                     controller.close();
                 }
             });
         }
      }

      if (!_sparseMode) {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(\`Server returned \${resp.status}\`);
        stream = resp.body!;
      }
    } else throw new Error("No file or URL provided");`;

code = code.replace(parseStart, parseReplacement);

fs.writeFileSync('src/webworkers/AlignmentParserWorker.ts', code);
