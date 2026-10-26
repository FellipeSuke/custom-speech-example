const readline = require('node:readline');
const {AdminStore} = require('../lib/admin/store');

const username = process.env.ADMIN_USERNAME || 'admin';

const readSecret = (prompt) => new Promise((resolve, reject) => {
  const stdin = process.stdin;
  process.stdout.write(prompt);
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    const rl = readline.createInterface({input: stdin, output: process.stdout});
    rl.question('', (value) => {
      rl.close();
      resolve(value);
    });
    return;
  }
  let value = '';
  const onData = (chunk) => {
    const input = chunk.toString();
    if (input === '\u0003') {
      stdin.setRawMode(false);
      stdin.removeListener('data', onData);
      reject(new Error('Password entry cancelled'));
      return;
    }
    if (input === '\r' || input === '\n') {
      stdin.setRawMode(false);
      stdin.removeListener('data', onData);
      process.stdout.write('\n');
      resolve(value);
      return;
    }
    if (input === '\u007f' || input === '\b') {
      value = value.slice(0, -1);
      return;
    }
    value += input;
  };
  stdin.setRawMode(true);
  stdin.resume();
  stdin.on('data', onData);
});

readSecret(`Nova senha administrativa para ${username}: `).then((password) => {
  try {
    const store = new AdminStore();
    store.setAdminPassword(username, password);
    store.close();
    process.stdout.write('Senha administrativa configurada com sucesso.\n');
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}).catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
