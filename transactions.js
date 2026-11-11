import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { parseAmount } from "./amounts.js";

export function walletAddress(value) {
  try {
    const key = new PublicKey(String(value).trim());
    if (!PublicKey.isOnCurve(key.toBytes()) || key.equals(SystemProgram.programId)) throw new Error();
    return key.toBase58();
  } catch { throw new Error("Enter a valid Solana wallet address. Ethereum 0x addresses cannot receive these tips."); }
}

export function createTipTransaction({ sender, recipient, asset, amount, mint, decimals, blockhash }) {
  const from = new PublicKey(walletAddress(sender));
  const to = new PublicKey(walletAddress(recipient));
  if (from.equals(to)) throw new Error("The sender and host receiving wallet must be different.");
  if (!["SOL", "JCQ"].includes(asset)) throw new Error("Choose SOL or JCQ.");
  if (asset === "JCQ" && !mint) throw new Error("JCQ transfers will open when the official mint is configured.");
  const units = parseAmount(amount, asset === "SOL" ? 9 : decimals);
  const transaction = new Transaction({ feePayer: from, recentBlockhash: blockhash });
  if (asset === "SOL") transaction.add(SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports: units }));
  else {
    const token = new PublicKey(mint);
    const source = getAssociatedTokenAddressSync(token, from);
    const destination = getAssociatedTokenAddressSync(token, to);
    transaction.add(
      createAssociatedTokenAccountIdempotentInstruction(from, destination, to, token),
      createTransferCheckedInstruction(source, token, destination, from, units, decimals),
    );
  }
  return transaction;
}
