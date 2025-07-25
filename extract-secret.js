const fs = require('fs');
const bs58 = require('bs58');

const path = `${require('os').homedir()}/.config/solana/my-test-wallet.json`;
const secret = JSON.parse(fs.readFileSync(path));
const secretKey = bs58.encode(Uint8Array.from(secret));
console.log(secretKey);