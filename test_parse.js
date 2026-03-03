const fs = require('fs');
const file = fs.readFileSync('public/7fa1c5691376beab198788a726917d48_b0.4.a2m', 'utf8');
const lines = file.split('\n');
let count = 0;
for(let line of lines) {
    if(line.startsWith('>')) count++;
}
console.log('Total sequences:', count);
console.log('Total bytes:', file.length);
console.log('Avg bytes/seq:', file.length / count);
