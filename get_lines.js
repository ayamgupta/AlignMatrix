const fs = require('fs');
const lines = fs.readFileSync('src/webworkers/AlignmentParserWorker.ts', 'utf8').split('\n');
console.log(lines.slice(510, 560).join('\n'));
