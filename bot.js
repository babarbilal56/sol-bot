require('dotenv').config();
const bs58 = require('bs58');
const {
  Connection,
  Keypair,
  PublicKey,
  clusterApiUrl,
  Transaction,
  SystemProgram,
  sendAndConfirmTransaction,
} = require('@solana/web3.js');
const {
  Market,
} = require('@openbook-dex/openbook-v2');
const {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
} = require('@solana/spl-token');

// === Wallet setup ===
const secretKey = bs58.decode(process.env.PRIVATE_KEY_BASE58);
const wallet = Keypair.fromSecretKey(secretKey);

// === Solana connection ===
const connection = new Connection(clusterApiUrl('mainnet-beta'), 'confirmed');

// === OpenBook v2 constants ===
// Program ID is correct from official repo
const PROGRAM_ID = new PublicKey('opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb');

// Initialize as null - will be found dynamically
let MARKET_ADDRESS = null;

const BASE_MINT = new PublicKey('So11111111111111111111111111111111111111112'); // SOL
const QUOTE_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'); // USDC

// === Find and list available markets ===
async function findMarkets() {
  try {
    console.log('🔍 Searching for OpenBook v2 markets...');
    
    // Try different data sizes for market accounts
    const possibleSizes = [760, 776, 808, 824, 856]; // Common OpenBook v2 market sizes
    let allMarkets = [];
    
    for (const size of possibleSizes) {
      try {
        const programAccounts = await connection.getProgramAccounts(PROGRAM_ID, {
          commitment: 'confirmed',
          filters: [{ dataSize: size }]
        });
        
        console.log(`Found ${programAccounts.length} accounts with size ${size}`);
        allMarkets = allMarkets.concat(programAccounts);
      } catch (err) {
        console.log(`No accounts found with size ${size}`);
      }
    }
    
    if (allMarkets.length === 0) {
      // If no specific sizes work, get all program accounts (slower but comprehensive)
      console.log('Trying comprehensive search...');
      allMarkets = await connection.getProgramAccounts(PROGRAM_ID, {
        commitment: 'confirmed'
      });
    }
    
    console.log(`Total potential markets found: ${allMarkets.length}`);
    
    for (let i = 0; i < Math.min(allMarkets.length, 20); i++) {
      const account = allMarkets[i];
      console.log(`\nChecking account ${i + 1}/${Math.min(allMarkets.length, 20)}: ${account.pubkey.toBase58()}`);
      console.log(`Data length: ${account.account.data.length}`);
      
      try {
        // Try to decode as market
        const market = await Market.load(connection, account.pubkey, { commitment: 'confirmed' }, PROGRAM_ID);
        
        console.log(`  ✅ Valid market found!`);
        console.log(`  - Base mint: ${market.baseMint.toBase58()}`);
        console.log(`  - Quote mint: ${market.quoteMint.toBase58()}`);
        
        // Check if this is SOL/USDC
        if (market.baseMint.equals(BASE_MINT) && market.quoteMint.equals(QUOTE_MINT)) {
          console.log(`  🎯 FOUND SOL/USDC MARKET: ${account.pubkey.toBase58()}`);
          return account.pubkey;
        }
        
        // Also check for USDC/SOL (reversed)
        if (market.baseMint.equals(QUOTE_MINT) && market.quoteMint.equals(BASE_MINT)) {
          console.log(`  🎯 FOUND USDC/SOL MARKET: ${account.pubkey.toBase58()}`);
          return account.pubkey;
        }
        
      } catch (err) {
        console.log(`  ❌ Not a valid market: ${err.message}`);
        continue;
      }
    }
    
    throw new Error('SOL/USDC market not found in first 20 accounts. You may need to manually specify the market address.');
  } catch (error) {
    console.error('Error finding markets:', error.message);
    throw error;
  }
}

// === Load the market ===
async function loadMarket() {
  try {
    // If MARKET_ADDRESS is not set, find it
    if (!MARKET_ADDRESS) {
      console.log('Market address not set, searching for SOL/USDC market...');
      MARKET_ADDRESS = await findMarkets();
    }

    const accountInfo = await connection.getAccountInfo(MARKET_ADDRESS);

    if (!accountInfo) {
      throw new Error('Market account not found on chain!');
    }

    console.log('Market account data length:', accountInfo.data.length);

    const market = await Market.load(connection, MARKET_ADDRESS, { commitment: 'confirmed' }, PROGRAM_ID);
    console.log('✅ Market loaded successfully');
    console.log(`Base mint: ${market.baseMint.toBase58()}`);
    console.log(`Quote mint: ${market.quoteMint.toBase58()}`);
    return market;
  } catch (error) {
    console.error('Error loading market:', error.message);
    throw error;
  }
}

// === Ensure associated token account exists or create it ===
async function getOrCreateAssociatedTokenAccount(owner, mint) {
  const associatedTokenAddress = getAssociatedTokenAddressSync(mint, owner, false);

  const accountInfo = await connection.getAccountInfo(associatedTokenAddress);
  if (accountInfo) {
    // Already exists
    console.log(`Associated token account exists: ${associatedTokenAddress.toBase58()}`);
    return associatedTokenAddress;
  }

  // Create associated token account
  console.log(`Creating associated token account for mint ${mint.toBase58()}...`);

  const transaction = new Transaction().add(
    createAssociatedTokenAccountInstruction(
      owner,
      associatedTokenAddress,
      owner,
      mint,
      TOKEN_PROGRAM_ID
    )
  );

  const signature = await sendAndConfirmTransaction(connection, transaction, [wallet]);
  console.log(`Created associated token account ${associatedTokenAddress.toBase58()}, tx: ${signature}`);

  return associatedTokenAddress;
}

// === Place Limit Order ===
async function placeLimitOrder(market, side, price, size) {
  try {
    const payerMint = side === 'buy' ? QUOTE_MINT : BASE_MINT;

    // Get or create payer associated token account
    const payer = await getOrCreateAssociatedTokenAccount(wallet.publicKey, payerMint);

    console.log(`Placing ${side} order with payer: ${payer.toBase58()}`);
    console.log(`Price: ${price}, Size: ${size}`);

    const txSig = await market.placeOrder(connection, {
      owner: wallet,
      payer,
      side,
      price,
      size,
      orderType: 'limit',
      clientOrderId: BigInt(Date.now()),
      selfTradeBehavior: 'decrementTake',
      expiryTimestamp: Math.floor(Date.now() / 1000) + 60, // valid for 60 sec
    });

    return txSig;
  } catch (error) {
    console.error('Error placing order:', error.message);
    throw error;
  }
}

// === Buy/Sell with Retry ===
async function buySol(price = 0.01, size = 0.01, retries = 3) {
  console.log('🔹 Attempting BUY');
  for (let i = 0; i < retries; i++) {
    try {
      const market = await loadMarket();
      const tx = await placeLimitOrder(market, 'buy', price, size);
      console.log('✅ Buy order sent:', tx);
      return;
    } catch (err) {
      console.error(`[Retry ${i + 1}/${retries}] Buy Error:`, err.message);
      if (i === retries - 1) {
        console.error('❌ All buy retries failed');
      }
    }
  }
}

async function sellSol(price = 100, size = 0.01, retries = 3) {
  console.log('🔸 Attempting SELL');
  for (let i = 0; i < retries; i++) {
    try {
      const market = await loadMarket();
      const tx = await placeLimitOrder(market, 'sell', price, size);
      console.log('✅ Sell order sent:', tx);
      return;
    } catch (err) {
      console.error(`[Retry ${i + 1}/${retries}] Sell Error:`, err.message);
      if (i === retries - 1) {
        console.error('❌ All sell retries failed');
      }
    }
  }
}

// === Bot runner ===
async function startBot() {
  let cycle = 1;

  // Validate wallet and connection first
  console.log('Wallet address:', wallet.publicKey.toBase58());
  
  try {
    const balance = await connection.getBalance(wallet.publicKey);
    console.log('Wallet SOL balance:', balance / 1e9);
  } catch (error) {
    console.error('Error checking wallet balance:', error.message);
    return;
  }

  while (true) {
    console.log(`\n🔁 Cycle ${cycle++}`);
    await buySol(0.01, 0.01);
    await new Promise(r => setTimeout(r, 6000));
    await sellSol(100, 0.01);
    await new Promise(r => setTimeout(r, 6000));
  }
}

process.on('SIGINT', () => {
  console.log('\n👋 Shutting down bot...');
  process.exit(0);
});

startBot().catch(console.error);