const readline = require('node:readline');
const {hashPassword} = require('../lib/admin/store');

const rl = readline.createInterface({input: process.stdin, output: process.stdout, terminal: true});
rl.question('Nova senha administrativa: ', (password) => {
  rl.close();
  process.stdout.write(`\nADMIN_PASSWORD_HASH=${hashPassword(password)}\n`);
});
