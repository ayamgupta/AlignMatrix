const fs = require('fs');
let code = fs.readFileSync('src/webworkers/AlignmentParserWorker.ts', 'utf8');

// The code has been prettified, we need to match it correctly
const target = `      try {
        rangeResp = await fetch(url, {
          headers: { Range: "bytes=0-1048575" },
        });
        if (rangeResp.status === 206) {
          useRange = true;
        } else if (!rangeResp.ok && rangeResp.status !== 416) {
          throw new Error(\`Server returned \${rangeResp.status}\`);
        }
      } catch (e) {}`;

const replacement = `      try {
        rangeResp = await fetch(url, {
          headers: { Range: "bytes=0-1048575" },
        });
        
        // Handle JSON wrapper (e.g. { "presignedURL": "..." })
        if (rangeResp && rangeResp.status === 200) {
          const contentType = rangeResp.headers.get("content-type");
          if (contentType && contentType.includes("application/json")) {
            const json = await rangeResp.json();
            if (json.presignedURL) {
              url = json.presignedURL;
              _sparseUrl = url;
              rangeResp = await fetch(url, {
                headers: { Range: "bytes=0-1048575" },
              });
            }
          }
        }

        if (rangeResp && rangeResp.status === 206) {
          useRange = true;
        } else if (rangeResp && !rangeResp.ok && rangeResp.status !== 416) {
          throw new Error(\`Server returned \${rangeResp.status}\`);
        }
      } catch (e) {}`;

code = code.replace(target, replacement);

fs.writeFileSync('src/webworkers/AlignmentParserWorker.ts', code);
