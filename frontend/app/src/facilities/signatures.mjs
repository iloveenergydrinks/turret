import { parseAbi } from "viem";
import { parseSignedQuote, quoteFields, quoteValues } from "./quotes.mjs";

const quoteTuple=`(${quoteFields.map(n=>`${n==="borrower"?"address":"uint256"} ${n}`).join(",")})`;
const abi=parseAbi([`function isValidQuoteSignature(${quoteTuple} quote,bytes signature) view returns (bool)`]);

/** Ask the verified facility: its view shares draw's exact OZ SignatureChecker and STATICCALL
 * context. A direct RPC call to the signer would incorrectly allow state-writing ERC-1271 code.
 * The caller must separately verify facility identity and canonicality of the pinned block.
 */
export async function verifyFacilitySignature(client,value,block) {
  const envelope=parseSignedQuote(value);
  const valid=await client.readContract({address:envelope.facility,abi,functionName:"isValidQuoteSignature",
    args:[quoteValues(envelope.quote),envelope.signature],blockNumber:block.number});
  if(typeof valid!=="boolean")throw new Error("Facility signature verification is unavailable.");
  return valid;
}
