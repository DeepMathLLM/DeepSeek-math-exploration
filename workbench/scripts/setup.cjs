'use strict';

const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

for (const [source, target] of [['.env.example', '.env'], ['models.config.example.json', 'models.config.json']]) {
  try {
    fs.writeFileSync(path.join(root, target), fs.readFileSync(path.join(root, source)), { flag: 'wx', mode: 0o600 });
    console.log(`Created ${target}`);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    console.log(`Using existing ${target}`);
  }
}
console.log('填写 .env 中的接口地址和 Key，再填写 models.config.json 中的实际模型名。完成后运行 npm start。');
